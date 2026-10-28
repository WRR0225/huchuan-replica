package com.huchuan.phone;

import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class Net {

    public interface BodySource {
        void writeTo(OutputStream out) throws IOException;
    }

    public static JSONObject postJson(String url, JSONObject body, String token, int timeoutMs) throws IOException {
        HttpURLConnection c = open(url, timeoutMs);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        if (token != null) c.setRequestProperty("X-HC-Token", token);
        byte[] data = (body == null ? "{}" : body.toString()).getBytes("UTF-8");
        c.setFixedLengthStreamingMode(data.length);
        try (OutputStream os = c.getOutputStream()) {
            os.write(data);
        }
        return readJson(c);
    }

    public static void postStream(String url, String token, JSONObject meta, BodySource src) throws IOException {
        HttpURLConnection c = open(url, 120000);
        c.setDoOutput(true);
        c.setRequestProperty("X-HC-Token", token);
        c.setRequestProperty("X-HC-Meta", Base64.encodeToString(meta.toString().getBytes("UTF-8"), Base64.NO_WRAP));
        c.setChunkedStreamingMode(64 * 1024);
        try (OutputStream os = c.getOutputStream()) {
            src.writeTo(os);
            os.flush();
        }
        readJson(c);
    }

    private static HttpURLConnection open(String url, int readTimeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(8000);
        c.setReadTimeout(readTimeout);
        c.setRequestMethod("POST");
        return c;
    }

    // 接收电脑推过来的文件：GET 一条长连接，正文边到边写盘，所以读超时给得很宽
    public static InputStream getStream(String url, String token) throws IOException {
        HttpURLConnection c = open(url, 300000);
        if (token != null) c.setRequestProperty("X-HC-Token", token);
        int code = c.getResponseCode();
        if (code >= 400) {
            JSONObject err = readJson(c);
            throw new IOException(err.optString("error", "HTTP " + code));
        }
        return c.getInputStream();
    }

    public static JSONObject readJson(HttpURLConnection c) throws IOException {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (in != null) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bo.write(buf, 0, n);
            in.close();
        }
        c.disconnect();
        try {
            return new JSONObject(bo.toString("UTF-8"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }
}
