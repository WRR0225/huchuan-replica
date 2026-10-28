package com.huchuan.phone;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.view.TextureView;
import android.view.View;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import org.json.JSONObject;

import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 扫码连接。相机、解码全在 hc-cam 这一条线程上跑：主线程只做界面，
 * 否则高分辨率预览一开就卡成 ANR。
 */
public class ScanActivity extends Activity implements TextureView.SurfaceTextureListener, Camera.PreviewCallback {

    private static final int REQ_CAM = 200;
    private static final int POOL = 3;

    private TextureView preview;
    private View reticle;
    private View card;
    private TextView hint;

    private HandlerThread camThread;
    private Handler cam;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private Camera camera;
    private volatile int frameW;
    private volatile int frameH;
    private volatile boolean scanned;

    private final MultiFormatReader reader = new MultiFormatReader();
    private final Map<DecodeHintType, Object> hints = new HashMap<>();

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_scan);
        preview = findViewById(R.id.preview);
        reticle = findViewById(R.id.reticle);
        card = findViewById(R.id.card);
        hint = findViewById(R.id.hint);
        preview.setSurfaceTextureListener(this);

        camThread = new HandlerThread("hc-cam");
        camThread.start();
        cam = new Handler(camThread.getLooper());

        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, EnumSet.of(BarcodeFormat.QR_CODE));

        findViewById(R.id.btn_back).setOnClickListener(v -> finish());
        findViewById(R.id.btn_connect).setOnClickListener(v -> {
            String addr = (String) card.getTag();
            if (addr != null) {
                Toast.makeText(this, "正在连接 " + addr, Toast.LENGTH_SHORT).show();
                TransferService.start(this, addr);
                finish();
            }
        });
        findViewById(R.id.btn_rescan).setOnClickListener(v -> {
            scanned = false;
            card.setVisibility(View.GONE);
            reticle.setVisibility(View.VISIBLE);
            hint.setVisibility(View.VISIBLE);
            hint.setText("把电脑网页上的二维码放进框内");
            open();
        });

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] granted) {
        if (req != REQ_CAM) return;
        if (granted.length == 0 || granted[0] != PackageManager.PERMISSION_GRANTED) {
            hint.setText("没有相机权限，无法扫码。可在系统设置里授予后重试。");
            Toast.makeText(this, "需要相机权限才能扫码", Toast.LENGTH_LONG).show();
            return;
        }
        open();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (preview.isAvailable()) open();
    }

    @Override
    protected void onPause() {
        super.onPause();
        close();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        camThread.quitSafely();
    }

    @Override
    public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) {
        open();
    }

    @Override
    public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) {
        fitPreview();
    }

    @Override
    public boolean onSurfaceTextureDestroyed(SurfaceTexture st) {
        return true;
    }

    @Override
    public void onSurfaceTextureUpdated(SurfaceTexture st) {
    }

    /** SurfaceTexture 只能在主线程取，取完交给相机线程用 */
    private void open() {
        if (scanned || isFinishing()) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        if (!preview.isAvailable()) return;
        final SurfaceTexture st = preview.getSurfaceTexture();
        if (st == null) return;
        cam.post(() -> openOnCamThread(st));
    }

    private void close() {
        cam.post(this::closeOnCamThread);
    }

    private void openOnCamThread(SurfaceTexture st) {
        if (camera != null || scanned || isFinishing()) return;
        try {
            Camera c = Camera.open();
            Camera.Parameters p = c.getParameters();
            Camera.Size size = pickPreviewSize(p, viewAR());
            p.setPreviewFormat(ImageFormat.NV21);
            p.setPreviewSize(size.width, size.height);
            setFocus(p);
            c.setParameters(p);
            c.setPreviewTexture(st);
            c.setDisplayOrientation(90);
            frameW = size.width;
            frameH = size.height;
            camera = c;
            c.setPreviewCallbackWithBuffer(this);
            for (int i = 0; i < POOL; i++) c.addCallbackBuffer(new byte[frameW * frameH * 3 / 2]);
            c.startPreview();
            ui.post(this::fitPreview);
        } catch (Exception e) {
            closeOnCamThread();
            ui.post(() -> hint.setText("相机打开失败：" + e.getMessage()));
        }
    }

    private void closeOnCamThread() {
        Camera c = camera;
        camera = null;
        if (c == null) return;
        try {
            c.setPreviewCallbackWithBuffer(null);
            c.stopPreview();
        } catch (Exception ignore) {
        }
        c.release();
    }

    /**
     * TextureView 会把画面硬拉满整个视图，不补这个矩阵就是又窄又长的糊画面。
     * setDisplayOrientation(90) 之后内容已经转正，所以有效尺寸是 frameH x frameW。
     */
    private void fitPreview() {
        int w = frameW;
        int vW = preview.getWidth();
        int vH = preview.getHeight();
        if (w == 0 || vW == 0 || vH == 0) return;
        float cW = frameH, cH = w;
        float scale = Math.max(vW / cW, vH / cH);
        Matrix m = new Matrix();
        m.postScale(cW * scale / vW, cH * scale / vH, vW / 2f, vH / 2f);
        preview.setTransform(m);
    }

    private float viewAR() {
        int vW = preview.getWidth();
        int vH = preview.getHeight();
        return vW == 0 || vH == 0 ? 9f / 16f : (float) vW / vH;
    }

    /** 竖屏显示时比例尽量贴屏幕（少裁切、不变形），同比例里再挑分辨率最高的（不糊） */
    private static Camera.Size pickPreviewSize(Camera.Parameters p, float viewAR) {
        List<Camera.Size> sizes = p.getSupportedPreviewSizes();
        if (sizes == null || sizes.isEmpty()) return p.getPreviewSize();
        Camera.Size best = null;
        float bestDiff = Float.MAX_VALUE;
        for (Camera.Size s : sizes) {
            if (!usable(s)) continue;
            float diff = Math.abs((float) s.height / s.width - viewAR);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = s;
            }
        }
        for (Camera.Size s : sizes) {
            if (best == null || !usable(s)) continue;
            long area = (long) s.width * s.height;
            if (area > (long) best.width * best.height
                    && Math.abs((float) s.height / s.width - viewAR) - bestDiff < 0.03f) best = s;
        }
        return best != null ? best : sizes.get(0);
    }

    /** 太小糊，太大解码跟不上：限制在 0.3MP ~ 2MP */
    private static boolean usable(Camera.Size s) {
        long area = (long) s.width * s.height;
        return area >= 640L * 480 && area <= 1920L * 1088;
    }

    /** 近距离拍屏幕需要持续对焦，否则会一直糊着解不出码 */
    private static void setFocus(Camera.Parameters p) {
        List<String> modes = p.getSupportedFocusModes();
        if (modes == null) return;
        if (modes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
            p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
        } else if (modes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
            p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
        }
    }

    /** 回调就在相机线程上：直接就地解码，解完把缓冲还回去，一次拷贝都不做 */
    @Override
    public void onPreviewFrame(byte[] data, Camera c) {
        if (data == null) return;
        if (camera == null || scanned) {
            recycle(c, data);
            return;
        }
        try {
            decode(data, frameW, frameH);
        } finally {
            recycle(c, data);
        }
    }

    private void recycle(Camera c, byte[] data) {
        if (camera == c) {
            try {
                c.addCallbackBuffer(data);
            } catch (Exception ignore) {
            }
        }
    }

    private void decode(byte[] nv21, int w, int h) {
        Result r;
        try {
            r = reader.decode(new BinaryBitmap(new HybridBinarizer(new YuvLuminance(nv21, w, h, w))), hints);
        } catch (Exception ignore) {
            return;
        }
        final Discover.Server s;
        try {
            s = Discover.parse(new JSONObject(r.getText()));
        } catch (Exception e) {
            return;
        }
        if (s == null) return;
        scanned = true;
        closeOnCamThread();
        runOnUiThread(() -> {
            reticle.setVisibility(View.GONE);
            hint.setVisibility(View.GONE);
            card.setTag(s.host + ":" + s.port);
            ((TextView) findViewById(R.id.card_title)).setText(s.title());
            ((TextView) findViewById(R.id.card_sub)).setText(s.sub());
            card.setVisibility(View.VISIBLE);
        });
    }

    /** NV21 的前 w*h 字节就是亮度平面，zxing 只要亮度即可 */
    private static class YuvLuminance extends LuminanceSource {
        private final byte[] y;
        private final int stride;

        YuvLuminance(byte[] y, int w, int h, int stride) {
            super(w, h);
            this.y = y;
            this.stride = stride;
        }

        @Override
        public byte[] getRow(int row, byte[] buffer) {
            int w = getWidth();
            byte[] dst = buffer != null && buffer.length >= w ? buffer : new byte[w];
            System.arraycopy(y, row * stride, dst, 0, w);
            return dst;
        }

        @Override
        public byte[] getMatrix() {
            int w = getWidth();
            int h = getHeight();
            byte[] out = new byte[w * h];
            for (int r = 0; r < h; r++) System.arraycopy(y, r * stride, out, r * w, w);
            return out;
        }
    }
}
