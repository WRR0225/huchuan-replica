package com.huchuan.phone;

import android.content.ContentUris;
import android.content.ContentResolver;
import android.content.Context;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Size;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class MediaLib {

    private static final String[] DOC_MIMES = {
            "application/pdf", "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/vnd.ms-excel",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "application/vnd.ms-powerpoint",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            "text/plain", "application/zip", "application/x-rar-compressed", "application/epub+zip",
    };

    private static final String[] PROJ = {
            MediaStore.MediaColumns._ID,
            MediaStore.MediaColumns.DISPLAY_NAME,
            MediaStore.MediaColumns.SIZE,
            MediaStore.MediaColumns.DATE_MODIFIED,
            MediaStore.MediaColumns.MIME_TYPE,
    };

    private final Context ctx;

    public MediaLib(Context ctx) {
        this.ctx = ctx.getApplicationContext();
    }

    public static class Ref {
        public final String cat;
        public final long rowId;

        Ref(String cat, long rowId) {
            this.cat = cat;
            this.rowId = rowId;
        }
    }

    public static Ref parse(String id) throws Exception {
        int i = id.indexOf(':');
        if (i <= 0) throw new Exception("bad id: " + id);
        return new Ref(id.substring(0, i), Long.parseLong(id.substring(i + 1)));
    }

    /** Android 11+ 没有「所有文件访问」权限时，非媒体文件在 MediaStore 里直接被过滤掉，查了也是空 */
    public static boolean allFiles() {
        return Build.VERSION.SDK_INT < 30 || Environment.isExternalStorageManager();
    }

    private static void needAllFiles(String cat) throws Exception {
        if ((cat.equals("doc") || cat.equals("file")) && !allFiles())
            throw new Exception("未授予「所有文件访问」权限：请在手机上打开互传 APP，点「授予所有文件访问」后重试");
    }

    public static Uri uriFor(String cat) {
        switch (cat) {
            case "image":
                return MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
            case "video":
                return MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
            case "audio":
                return MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
            default:
                return MediaStore.Files.getContentUri("external");
        }
    }

    public Uri uri(String id) throws Exception {
        Ref r = parse(id);
        return ContentUris.withAppendedId(uriFor(r.cat), r.rowId);
    }

    private static String selectionFor(String cat) {
        if (cat.equals("audio")) return MediaStore.Audio.Media.IS_MUSIC + "!=0";
        if (cat.equals("doc")) {
            StringBuilder sb = new StringBuilder(MediaStore.Files.FileColumns.MIME_TYPE + " IN (");
            for (int i = 0; i < DOC_MIMES.length; i++) sb.append(i > 0 ? ",?" : "?");
            return sb.append(")").toString();
        }
        if (cat.equals("file")) return MediaStore.Files.FileColumns.SIZE + ">0";
        return null;
    }

    private static String[] argsFor(String cat) {
        return cat.equals("doc") ? DOC_MIMES.clone() : null;
    }

    public JSONObject list(String cat, int offset, int limit) throws Exception {
        needAllFiles(cat);
        Bundle q = new Bundle();
        String sel = selectionFor(cat);
        if (sel != null) q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel);
        String[] selArgs = argsFor(cat);
        if (selArgs != null) q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, selArgs);
        q.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
        q.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
        q.putInt(ContentResolver.QUERY_ARG_OFFSET, offset);
        JSONArray items = new JSONArray();
        Cursor c = ctx.getContentResolver().query(uriFor(cat), PROJ, q, null);
        if (c != null) {
            try {
                while (c.moveToNext()) items.put(rowJson(c, cat));
            } finally {
                c.close();
            }
        }
        JSONObject out = new JSONObject();
        out.put("items", items);
        out.put("total", countFor(cat));
        return out;
    }

    public JSONObject recent(int days, int limit) throws Exception {
        long cutoff = System.currentTimeMillis() / 1000 - (long) days * 24 * 3600;
        List<JSONObject> all = new ArrayList<>();
        for (String cat : new String[]{"image", "video", "audio"}) {
            String sel = MediaStore.MediaColumns.DATE_MODIFIED + ">=?";
            String base = selectionFor(cat);
            if (base != null) sel = "(" + base + ") AND " + sel;
            List<String> args = new ArrayList<>();
            String[] baseArgs = argsFor(cat);
            if (baseArgs != null) Collections.addAll(args, baseArgs);
            args.add(String.valueOf(cutoff));
            Bundle q = new Bundle();
            q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, sel);
            q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args.toArray(new String[0]));
            q.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.MediaColumns.DATE_MODIFIED + " DESC");
            q.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
            Cursor c = ctx.getContentResolver().query(uriFor(cat), PROJ, q, null);
            if (c != null) {
                try {
                    while (c.moveToNext()) all.add(rowJson(c, cat));
                } finally {
                    c.close();
                }
            }
        }
        Collections.sort(all, (x, y) -> Long.compare(y.optLong("mtime"), x.optLong("mtime")));
        JSONArray items = new JSONArray();
        for (int i = 0; i < Math.min(all.size(), limit); i++) items.put(all.get(i));
        JSONObject out = new JSONObject();
        out.put("items", items);
        out.put("total", items.length());
        out.put("days", days);
        return out;
    }

    private int countFor(String cat) {
        Cursor c = ctx.getContentResolver().query(uriFor(cat), new String[]{MediaStore.MediaColumns._ID},
                selectionFor(cat), argsFor(cat), null);
        if (c == null) return 0;
        try {
            return c.getCount();
        } finally {
            c.close();
        }
    }

    public JSONObject counts() throws Exception {
        JSONObject o = new JSONObject();
        for (String cat : new String[]{"image", "video", "audio"}) o.put(cat, countFor(cat));
        if (allFiles()) o.put("doc", countFor("doc"));
        return o;
    }

    public JSONObject info(String id) throws Exception {
        Ref r = parse(id);
        Cursor c = ctx.getContentResolver().query(uriFor(r.cat), PROJ,
                MediaStore.MediaColumns._ID + "=?", new String[]{String.valueOf(r.rowId)}, null);
        if (c == null) throw new Exception("not found: " + id);
        try {
            if (!c.moveToFirst()) throw new Exception("not found: " + id);
            return rowJson(c, r.cat);
        } finally {
            c.close();
        }
    }

    public byte[] thumb(String id, int w, JSONObject metaOut) throws Exception {
        JSONObject info = info(id);
        Uri uri = uri(id);
        CancellationSignal sig = new CancellationSignal();
        Bitmap bmp = ctx.getContentResolver().loadThumbnail(uri, new Size(w, w), sig);
        String mime = "image/png".equalsIgnoreCase(info.optString("mime")) ? "image/png" : "image/jpeg";
        Bitmap.CompressFormat fmt = mime.equals("image/png") ? Bitmap.CompressFormat.PNG : Bitmap.CompressFormat.JPEG;
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        bmp.compress(fmt, w >= 1000 ? 90 : 82, bo);
        bmp.recycle();
        metaOut.put("mime", mime);
        metaOut.put("size", bo.size());
        return bo.toByteArray();
    }

    private static JSONObject rowJson(Cursor c, String cat) throws Exception {
        JSONObject o = new JSONObject();
        o.put("id", cat + ":" + c.getLong(0));
        o.put("name", c.getString(1));
        o.put("size", c.getLong(2));
        o.put("mtime", c.getLong(3) * 1000);
        o.put("mime", c.isNull(4) ? "" : c.getString(4));
        return o;
    }
}
