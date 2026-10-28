package com.huchuan.phone;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class TransferService extends Service {

    public static final String CHANNEL = "hc_service";
    public static final int NOTIFY_ID = 1;
    private static final String PREFS = "hc";
    private static final String KEY_ADDR = "lastAddr";

    public static volatile String status = "未连接";
    public static volatile String connectedAddr = null;
    public static volatile String peerLabel = null;
    /** connectedAddr 非空 = 这台手机还打算连着那台电脑；reconnecting 区分「连上了」和「正在重试」 */
    public static volatile boolean reconnecting = false;

    public static class Transfer {
        public volatile String name = "";
        public volatile String mime = "";
        public volatile long size;
        public volatile long sent;
        public volatile String state = "传输中";
        public volatile String error = "";
        public volatile String dir = "发送";
        public volatile String target = "";
    }

    public static final java.util.List<Transfer> transfers = new java.util.concurrent.CopyOnWriteArrayList<>();

    private static void addTransfer(Transfer t) {
        transfers.add(t);
        while (transfers.size() > 30) transfers.remove(0);
    }

    private volatile boolean running;
    private volatile String base;
    private volatile String token;
    private Thread worker;
    private Thread beater;
    private MediaLib lib;
    private Inbox inbox;
    private ExecutorService thumbPool;
    private ExecutorService filePool;
    private ExecutorService recvPool;

    @Override
    public void onCreate() {
        super.onCreate();
        lib = new MediaLib(this);
        inbox = new Inbox(this);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "互传服务", NotificationManager.IMPORTANCE_LOW);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
        thumbPool = Executors.newFixedThreadPool(4);
        filePool = Executors.newFixedThreadPool(2);
        recvPool = Executors.newFixedThreadPool(1);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFY_ID, buildNotification());
        if (intent != null && intent.hasExtra("addr")) {
            base = intent.getStringExtra("addr");
            ensureWorker();
        } else if (base == null) {
            // 被系统杀掉后 START_STICKY 是用 null intent 把服务重起来的，不找回上次那台就永远装死
            String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_ADDR, null);
            if (saved != null) {
                base = saved;
                ensureWorker();
            }
        }
        return START_STICKY;
    }

    private void ensureWorker() {
        if (worker != null && worker.isAlive()) return;
        running = true;
        worker = new Thread(this::run, "hc-worker");
        worker.start();
    }

    @Override
    public void onDestroy() {
        running = false;
        connectedAddr = null;
        reconnecting = false;
        status = "未连接";
        // 只有真断开才会走到这里（被系统杀掉的进程没有 onDestroy），所以顺手忘掉那台电脑，别让它自己活过来
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_ADDR).apply();
        if (worker != null) worker.interrupt();
        if (beater != null) beater.interrupt();
        thumbPool.shutdownNow();
        filePool.shutdownNow();
        recvPool.shutdownNow();
        goodbyeAsync();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    public static void start(android.content.Context ctx, String addr) {
        Intent i = new Intent(ctx, TransferService.class);
        i.putExtra("addr", addr.startsWith("http") ? addr : "http://" + addr);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
        else ctx.startService(i);
    }

    public static void disconnectStatic(android.content.Context ctx) {
        ctx.stopService(new Intent(ctx, TransferService.class));
    }

    private void goodbyeAsync() {
        final String b = base;
        final String t = token;
        if (b == null || t == null) return;
        Thread th = new Thread(() -> {
            try {
                Net.postJson(b + "/api/goodbye", new JSONObject(), t, 3000);
            } catch (Exception ignore) {
            }
        }, "hc-goodbye");
        th.start();
    }

    private Notification buildNotification() {
        return new Notification.Builder(this, CHANNEL)
                .setContentTitle("互传服务运行中")
                .setContentText(status)
                .setSmallIcon(android.R.drawable.stat_sys_upload)
                .setOngoing(true)
                .build();
    }

    private void setStatus(String s) {
        status = s;
        getSystemService(NotificationManager.class).notify(NOTIFY_ID, buildNotification());
    }

    private void run() {
        while (running) {
            try {
                session();
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                token = null;
                // 不清 connectedAddr：鸿蒙把后台冻几十秒是很常见的，瞬时重连不该让界面退回主界面
                reconnecting = true;
                setStatus("连接中断：" + e.getMessage() + "，3 秒后重连");
                sleep(3000);
            }
        }
    }

    private void session() throws Exception {
        JSONObject dev = new JSONObject()
                .put("deviceId", android.provider.Settings.Secure.getString(getContentResolver(),
                        android.provider.Settings.Secure.ANDROID_ID))
                .put("model", Build.MODEL)
                .put("brand", Build.BRAND)
                .put("android", String.valueOf(Build.VERSION.RELEASE))
                .put("appVersion", appVersion());
        JSONObject reg = Net.postJson(base + "/api/register", dev, null, 10000);
        token = reg.getString("token");
        JSONObject srv = reg.optJSONObject("server");
        peerLabel = srv == null ? null
                : Discover.peerTitle(srv.optString("user"), srv.optString("os"), srv.optString("name"));
        // 瞬时重连（后台被冻、Wi-Fi 抖一下）不该把传输记录清空，用户回来还要能看到刚才那几条
        boolean resumed = connectedAddr != null && reconnecting;
        connectedAddr = base;
        reconnecting = false;
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_ADDR, base).apply();
        if (!resumed) transfers.clear();
        setStatus("已连接");
        startBeater();
        try {
            while (running) {
                JSONObject cmd = Net.postJson(base + "/api/poll",
                        new JSONObject().put("timeout", 25000), token, 35000);
                // 电脑重启后旧 token 会被拒，这里必须当断线处理，不然会一直空转收不到命令
                if (cmd.has("error") && !cmd.has("cmd")) throw new java.io.IOException("服务端不认识这台手机：" + cmd.getString("error"));
                handle(cmd);
            }
        } finally {
            if (beater != null) beater.interrupt();
        }
    }

    private void startBeater() {
        if (beater != null) beater.interrupt();
        beater = new Thread(() -> {
            while (running && !Thread.interrupted()) {
                try {
                    Net.postJson(base + "/api/heartbeat", new JSONObject(), token, 8000);
                    Thread.sleep(10000);
                } catch (InterruptedException e) {
                    return;
                } catch (Exception ignore) {
                    sleep(2000);
                }
            }
        }, "hc-beat");
        beater.start();
    }

    /** 从包里读，免得每次发版都要记得改这个字符串 */
    private String appVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "未知";
        }
    }

    private boolean canRead() {
        String perm = Build.VERSION.SDK_INT >= 33
                ? android.Manifest.permission.READ_MEDIA_IMAGES
                : android.Manifest.permission.READ_EXTERNAL_STORAGE;
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void handle(JSONObject cmd) {
        String name = cmd.optString("cmd");
        String id = cmd.optString("id");
        if (name.equals("noop") || id.isEmpty()) return;
        try {
            JSONObject args = cmd.optJSONObject("args");
            if (args == null) args = new JSONObject();
            final JSONObject fargs = args;
            switch (name) {
                case "disconnect":
                    result(id, true, new JSONObject(), null);
                    running = false;
                    stopSelf();
                    break;
                case "counts":
                case "list":
                case "recent":
                    if (!canRead()) {
                        result(id, false, null, "未授予存储权限：请打开互传 APP 允许媒体权限后重试");
                        break;
                    }
                    if (name.equals("counts")) result(id, true, lib.counts(), null);
                    else if (name.equals("recent")) result(id, true,
                            lib.recent(args.optInt("days", 30), args.optInt("limit", 60)), null);
                    else result(id, true, lib.list(args.optString("cat", "image"),
                            args.optInt("offset", 0), args.optInt("limit", 60)), null);
                    break;
                case "thumb":
                    thumbPool.submit(() -> doThumb(id, fargs));
                    break;
                case "file":
                    filePool.submit(() -> doFile(id, fargs));
                    break;
                case "recv":
                    recvPool.submit(() -> doRecv(id, fargs));
                    break;
                default:
                    result(id, false, null, "unknown command " + name);
            }
        } catch (Exception e) {
            fail(id, name, e);
        }
    }

    private void doThumb(String id, JSONObject args) {
        try {
            if (!canRead()) throw new SecurityException("未授予存储权限");
            JSONObject meta = new JSONObject();
            final byte[] bytes = lib.thumb(args.optString("id"), args.optInt("w", 300), meta);
            Net.postStream(base + "/api/blob/" + id, token, meta, out -> out.write(bytes));
        } catch (Exception e) {
            fail(id, "thumb", e);
        }
    }

    private void doFile(String id, JSONObject args) {
        final Transfer t = new Transfer();
        try {
            if (!canRead()) throw new SecurityException("未授予存储权限");
            JSONObject info = lib.info(args.optString("id"));
            t.name = info.optString("name", "file");
            t.mime = info.optString("mime", "");
            t.size = info.optLong("size");
            addTransfer(t);
            setStatus("正在传输 " + t.name);
            JSONObject meta = new JSONObject()
                    .put("mime", info.optString("mime", "application/octet-stream"))
                    .put("size", t.size)
                    .put("name", t.name);
            final android.net.Uri uri = lib.uri(args.optString("id"));
            Net.postStream(base + "/api/blob/" + id, token, meta, out -> {
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    if (in == null) throw new java.io.IOException("cannot open " + uri);
                    byte[] buf = new byte[256 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        t.sent += n;
                    }
                }
            });
            t.state = "已完成";
            setStatus("已连接");
        } catch (Exception e) {
            t.state = "失败";
            t.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            fail(id, "file", e);
        }
    }

    private void doRecv(String id, JSONObject args) {
        final Transfer t = new Transfer();
        try {
            t.name = args.optString("name", "file");
            t.mime = args.optString("mime", "");
            t.size = args.optLong("size");
            t.dir = "接收";
            addTransfer(t);
            setStatus("正在接收 " + t.name);
            Inbox.Saved saved = inbox.save(base + "/api/getfile/" + id, token,
                    t.name, t.mime, t.size, n -> t.sent += n);
            t.target = saved.target;
            t.state = "已接收";
            setStatus("已连接");
            result(id, true, new JSONObject()
                    .put("target", saved.target)
                    .put("written", saved.written), null);
        } catch (Exception e) {
            t.state = "失败";
            t.error = e.getClass().getSimpleName() + ": " + e.getMessage();
            setStatus("已连接");
            fail(id, "recv", e);
        }
    }

    private void fail(String id, String name, Exception e) {
        try {
            String msg = e.getClass().getSimpleName() + ": " + e.getMessage();
            if (name.equals("thumb") || name.equals("file")) {
                Net.postJson(base + "/api/blobfail",
                        new JSONObject().put("id", id).put("error", msg), token, 8000);
            } else {
                result(id, false, null, msg);
            }
        } catch (Exception ignore) {
        }
    }

    private void result(String id, boolean ok, JSONObject data, String error) throws Exception {
        JSONObject body = new JSONObject().put("id", id).put("ok", ok);
        if (data != null) body.put("data", data);
        if (error != null) body.put("error", error);
        Net.postJson(base + "/api/result", body, token, 10000);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignore) {
            Thread.currentThread().interrupt();
        }
    }
}
