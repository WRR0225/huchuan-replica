package com.huchuan.phone;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.ListView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {

    private static final int REQ_PERM = 100;
    private final Handler handler = new Handler();
    private final List<Discover.Server> found = new ArrayList<>();
    private final ServerAdapter adapter = new ServerAdapter();
    private TextView status;
    private Button scanBtn;
    private Button permBtn;
    private boolean enteredSession = false;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_main);
        status = findViewById(R.id.status);
        scanBtn = findViewById(R.id.btn_scan);
        permBtn = findViewById(R.id.btn_perm);
        Button qr = findViewById(R.id.btn_qr);
        ListView list = findViewById(R.id.servers);
        list.setAdapter(adapter);

        list.setOnItemClickListener((parent, view, position, id) -> {
            if (position < found.size()) {
                Discover.Server s = found.get(position);
                TransferService.start(this, s.host + ":" + s.port);
            }
        });

        scanBtn.setOnClickListener(v -> scan());
        qr.setOnClickListener(v -> startActivity(new Intent(this, ScanActivity.class)));
        permBtn.setOnClickListener(v -> openAllFiles());

        requestPerms();
    }

    private void scan() {
        scanBtn.setEnabled(false);
        scanBtn.setText("扫描中…");
        status.setText("正在搜索局域网中的电脑…");
        new Thread(() -> {
            final List<Discover.Server> servers = Discover.scan(2500);
            runOnUiThread(() -> {
                scanBtn.setEnabled(true);
                scanBtn.setText("扫描局域网电脑");
                found.clear();
                found.addAll(servers);
                adapter.notifyDataSetChanged();
                status.setText(servers.isEmpty() ? "未发现电脑，请检查同一 WiFi" : "发现 " + servers.size() + " 台电脑，点击连接");
            });
        }, "hc-scan").start();
    }

    private void requestPerms() {
        List<String> need = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 33) {
            need.add(Manifest.permission.READ_MEDIA_IMAGES);
            need.add(Manifest.permission.READ_MEDIA_VIDEO);
            need.add(Manifest.permission.READ_MEDIA_AUDIO);
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        } else {
            need.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        List<String> missing = new ArrayList<>();
        for (String p : need) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) missing.add(p);
        }
        if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_PERM);
    }

    /** 鸿蒙未必有这个设置页，跳不动就退回应用详情页让用户自己找 */
    private void openAllFiles() {
        String pkg = "package:" + getPackageName();
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse(pkg)));
        } catch (Exception e) {
            try {
                startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse(pkg)));
            } catch (Exception e2) {
                status.setText("请到 设置-应用-互传自用版-权限 里手动开启「所有文件访问」");
            }
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        permBtn.setVisibility(MediaLib.allFiles() ? View.GONE : View.VISIBLE);
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
            boolean connected = TransferService.connectedAddr != null;
            if (connected) {
                if (!enteredSession) {
                    enteredSession = true;
                    startActivity(new Intent(MainActivity.this, SessionActivity.class));
                }
            } else if (enteredSession) {
                enteredSession = false;
                status.setText("选择一种方式连接电脑");
            }
            handler.postDelayed(this, 1000);
        }
    };

    private class ServerAdapter extends BaseAdapter {
        @Override
        public int getCount() {
            return found.size();
        }

        @Override
        public Object getItem(int i) {
            return found.get(i);
        }

        @Override
        public long getItemId(int i) {
            return i;
        }

        @Override
        public View getView(int i, View cv, ViewGroup parent) {
            View v = cv != null ? cv
                    : LayoutInflater.from(parent.getContext()).inflate(R.layout.item_server, parent, false);
            Discover.Server s = found.get(i);
            ((TextView) v.findViewById(R.id.srv_title)).setText(s.title());
            ((TextView) v.findViewById(R.id.srv_sub)).setText(s.sub());
            return v;
        }
    }
}
