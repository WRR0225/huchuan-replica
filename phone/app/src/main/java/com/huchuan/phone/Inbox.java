package com.huchuan.phone;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

// 电脑发过来的文件落到手机公共目录：相册/音乐走 MediaStore，其它走 Download
public class Inbox {

    public static class Saved {
        public String target = "";
        public long written;
    }

    public interface Progress {
        void onBytes(int n);
    }

    private final Context ctx;

    public Inbox(Context ctx) {
        this.ctx = ctx;
    }

    public Saved save(String url, String token, String name, String mime, long size, Progress prog) throws Exception {
        if (name.isEmpty()) name = "file";
        if (mime.isEmpty()) mime = "application/octet-stream";
        return Build.VERSION.SDK_INT >= 29
                ? viaMediaStore(url, token, name, mime, size, prog)
                : viaFile(url, token, name, mime, size, prog);
    }

    private Saved viaMediaStore(String url, String token, String name, String mime, long size, Progress prog) throws Exception {
        ContentResolver cr = ctx.getContentResolver();
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, dir(mime));
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri uri = cr.insert(collection(mime), v);
        if (uri == null) throw new IOException("系统拒绝创建 " + name);
        long n;
        try (InputStream in = Net.getStream(url, token); OutputStream out = cr.openOutputStream(uri)) {
            if (out == null) throw new IOException("无法写入 " + uri);
            n = copy(in, out, size, prog);
        } catch (Exception e) {
            cr.delete(uri, null, null);
            throw e;
        }
        v.clear();
        v.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(uri, v, null, null);
        return saved(dir(mime) + "/" + name, n);
    }

    private Saved viaFile(String url, String token, String name, String mime, long size, Progress prog) throws Exception {
        File folder = new File(Environment.getExternalStoragePublicDirectory(root(mime)), "互传");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("无法创建目录 " + folder);
        File f = new File(folder, name);
        long n;
        try (InputStream in = Net.getStream(url, token); OutputStream out = new FileOutputStream(f)) {
            n = copy(in, out, size, prog);
        } catch (Exception e) {
            if (f.exists() && !f.delete()) e.addSuppressed(new IOException("残留文件没删掉：" + f));
            throw e;
        }
        MediaScannerConnection.scanFile(ctx, new String[]{f.getAbsolutePath()}, new String[]{mime}, null);
        return saved("互传/" + name, n);
    }

    private static long copy(InputStream in, OutputStream out, long expected, Progress prog) throws IOException {
        byte[] buf = new byte[256 * 1024];
        long n = 0;
        int r;
        while ((r = in.read(buf)) > 0) {
            out.write(buf, 0, r);
            n += r;
            prog.onBytes(r);
        }
        out.flush();
        if (expected > 0 && n != expected) throw new IOException("接收不完整：" + n + "/" + expected + " 字节");
        return n;
    }

    private static Saved saved(String target, long written) {
        Saved s = new Saved();
        s.target = target;
        s.written = written;
        return s;
    }

    private static String dir(String mime) {
        if (mime.startsWith("image/")) return "Pictures/互传";
        if (mime.startsWith("video/")) return "Movies/互传";
        if (mime.startsWith("audio/")) return "Music/互传";
        return "Download/互传";
    }

    private static Uri collection(String mime) {
        if (mime.startsWith("image/")) return MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
        if (mime.startsWith("video/")) return MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
        if (mime.startsWith("audio/")) return MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        return MediaStore.Downloads.EXTERNAL_CONTENT_URI;
    }

    private static String root(String mime) {
        if (mime.startsWith("image/")) return Environment.DIRECTORY_PICTURES;
        if (mime.startsWith("video/")) return Environment.DIRECTORY_MOVIES;
        if (mime.startsWith("audio/")) return Environment.DIRECTORY_MUSIC;
        return Environment.DIRECTORY_DOWNLOADS;
    }
}
