package com.huchuan.phone;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.AlphaAnimation;
import android.view.animation.Animation;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.ListView;
import android.widget.ProgressBar;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class SessionActivity extends Activity {

    private final Handler handler = new Handler();
    private final TransferAdapter adapter = new TransferAdapter();
    private boolean breathing = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_session);
        ListView list = findViewById(R.id.transfers);
        list.setAdapter(adapter);
        list.setEmptyView(findViewById(R.id.empty));

        Button disconnect = findViewById(R.id.btn_disconnect);
        disconnect.setOnClickListener(v -> new AlertDialog.Builder(this)
                .setTitle("断开连接")
                .setMessage("断开后电脑将无法继续浏览和下载手机文件，确定吗？")
                .setPositiveButton("断开", (d, w) -> {
                    disconnect();
                    finish();
                })
                .setNegativeButton("取消", null)
                .show());
    }

    private void disconnect() {
        stopService(new Intent(this, TransferService.class));
    }

    @Override
    public void onBackPressed() {
        disconnect();
        super.onBackPressed();
    }

    @Override
    protected void onResume() {
        super.onResume();
        handler.post(tick);
    }

    @Override
    protected void onPause() {
        super.onPause();
        handler.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            String addr = TransferService.connectedAddr;
            if (addr == null) {
                // 只有真断了（服务被停或手动断开）才退回主界面，重连中要留在这一页给他看见
                finish();
                return;
            }
            boolean rec = TransferService.reconnecting;
            String peer = TransferService.peerLabel;
            TextView title = findViewById(R.id.peer);
            title.setText((rec ? "重连中  " : "已连接  ") + (peer != null ? peer : addr.replace("http://", "")));
            title.setTextColor(rec ? 0xFFE08A00 : 0xFF12C3CF);
            TextView st = findViewById(R.id.status);
            st.setText("状态：" + TransferService.status);
            st.setTextColor(rec ? 0xFFE08A00 : 0xFF888888);
            if (rec && !breathing) {
                breathing = true;
                AlphaAnimation a = new AlphaAnimation(1f, 0.35f);
                a.setDuration(750);
                a.setRepeatMode(Animation.REVERSE);
                a.setRepeatCount(Animation.INFINITE);
                st.startAnimation(a);
            } else if (!rec && breathing) {
                breathing = false;
                st.clearAnimation();
            }
            List<TransferService.Transfer> snap = new ArrayList<>(TransferService.transfers);
            Collections.reverse(snap);
            adapter.setItems(snap);
            handler.postDelayed(this, 700);
        }
    };

    private static String human(long bytes) {
        if (bytes >= 1024L * 1024 * 1024) return String.format("%.1fGB", bytes / 1024d / 1024 / 1024);
        if (bytes >= 1024L * 1024) return String.format("%.1fMB", bytes / 1024d / 1024);
        if (bytes >= 1024L) return String.format("%.1fKB", bytes / 1024d);
        return bytes + "B";
    }

    private static int iconFor(String mime) {
        String m = mime == null ? "" : mime;
        if (m.startsWith("image/")) return R.drawable.ic_img;
        if (m.startsWith("video/")) return R.drawable.ic_video;
        if (m.startsWith("audio/")) return R.drawable.ic_audio;
        if (m.startsWith("text/") || m.contains("pdf") || m.contains("word") || m.contains("excel")
                || m.contains("presentation") || m.contains("zip") || m.contains("epub")) return R.drawable.ic_doc;
        return R.drawable.ic_file;
    }

    private class TransferAdapter extends BaseAdapter {
        private final List<TransferService.Transfer> items = new ArrayList<>();

        void setItems(List<TransferService.Transfer> src) {
            items.clear();
            items.addAll(src);
            notifyDataSetChanged();
        }

        @Override
        public int getCount() {
            return items.size();
        }

        @Override
        public Object getItem(int i) {
            return items.get(i);
        }

        @Override
        public long getItemId(int i) {
            return i;
        }

        @Override
        public View getView(int i, View convertView, ViewGroup parent) {
            View v = convertView;
            if (v == null) v = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_transfer, parent, false);
            TransferService.Transfer t = items.get(i);
            ((ImageView) v.findViewById(R.id.icon)).setImageResource(iconFor(t.mime));
            ((TextView) v.findViewById(R.id.name)).setText(t.name);
            ProgressBar bar = v.findViewById(R.id.bar);
            TextView sub = v.findViewById(R.id.sub);
            if ("传输中".equals(t.state)) {
                int pct = t.size > 0 ? (int) (t.sent * 100 / t.size) : 0;
                bar.setVisibility(View.VISIBLE);
                bar.setProgress(pct);
                sub.setText(("接收".equals(t.dir) ? "接收中  " : "传输中  ") + pct + "%  " + human(t.sent) + " / " + human(t.size));
            } else {
                bar.setVisibility(View.GONE);
                if ("失败".equals(t.state)) sub.setText("失败  " + t.error);
                else if ("接收".equals(t.dir)) sub.setText("已收到  " + human(t.size) + "  " + t.target);
                else sub.setText("已完成  " + human(t.size));
            }
            return v;
        }
    }
}
