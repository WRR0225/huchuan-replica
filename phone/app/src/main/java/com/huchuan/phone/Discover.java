package com.huchuan.phone;

import org.json.JSONArray;
import org.json.JSONObject;

import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class Discover {

    public static final int UDP_PORT = 8788;

    public static class Server {
        public String name = "电脑";
        public String user = "";
        public String os = "";
        public String host;
        public int port;

        /** 第一行：登录用户名 · 系统 */
        public String title() {
            return peerTitle(user, os, name);
        }

        /** 第二行：计算机名 · 地址 */
        public String sub() {
            return name + " · " + host + ":" + port;
        }
    }

    public static String peerTitle(String user, String os, String name) {
        StringBuilder sb = new StringBuilder();
        if (user != null && !user.isEmpty()) sb.append(user);
        if (os != null && !os.isEmpty()) sb.append(sb.length() > 0 ? " · " : "").append(os);
        return sb.length() > 0 ? sb.toString() : name;
    }

    /** UDP 应答与二维码内容同构，两条连接路径共用这个解析器 */
    public static Server parse(JSONObject m) {
        if (!"here".equals(m.optString("type"))) return null;
        Server s = new Server();
        s.name = m.optString("name", "电脑");
        s.user = m.optString("user", "");
        s.os = m.optString("os", "");
        s.port = m.optInt("port", 8787);
        s.host = pickHost(m.optJSONArray("ips"), myAddresses());
        return s.host == null ? null : s;
    }

    public static List<Server> scan(int timeoutMs) {
        List<Server> out = new ArrayList<>();
        DatagramSocket sock = null;
        try {
            sock = new DatagramSocket();
            sock.setBroadcast(true);
            sock.setSoTimeout(timeoutMs);
            byte[] msg = new JSONObject().put("proto", "huchuan").put("type", "discover").put("v", 1)
                    .toString().getBytes("UTF-8");
            for (String target : broadcastTargets()) {
                try {
                    sock.send(new DatagramPacket(msg, msg.length, InetAddress.getByName(target), UDP_PORT));
                } catch (Exception ignore) {
                }
            }
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (System.currentTimeMillis() < deadline) {
                byte[] buf = new byte[4096];
                DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                try {
                    sock.receive(pkt);
                } catch (SocketTimeoutException e) {
                    break;
                }
                Server s;
                try {
                    s = parse(new JSONObject(new String(pkt.getData(), 0, pkt.getLength(), "UTF-8")));
                } catch (Exception ignore) {
                    continue;
                }
                if (s == null) continue;
                boolean dup = false;
                for (Server o : out) if (o.host.equals(s.host) && o.port == s.port) dup = true;
                if (!dup) out.add(s);
            }
        } catch (Exception ignore) {
        } finally {
            if (sock != null) sock.close();
        }
        return out;
    }

    private static String pickHost(JSONArray ips, Set<String> mine) {
        if (ips == null || ips.length() == 0) return null;
        String chosen = null;
        for (int i = 0; i < ips.length(); i++) {
            JSONObject e = ips.optJSONObject(i);
            if (e == null) continue;
            String addr = e.optString("address");
            if (addr.isEmpty()) continue;
            if (chosen == null) chosen = addr;
            if (inSubnet(addr, e.optString("netmask"), mine)) return addr;
        }
        return chosen;
    }

    private static boolean inSubnet(String addr, String netmask, Set<String> mine) {
        try {
            if (netmask.isEmpty()) return mine.contains(addr);
            int a = ipToInt(addr);
            int m = ipToInt(netmask);
            for (String my : mine) {
                if ((ipToInt(my) & m) == (a & m)) return true;
            }
        } catch (Exception ignore) {
        }
        return false;
    }

    private static int ipToInt(String ip) {
        String[] p = ip.split("\\.");
        return (Integer.parseInt(p[0]) << 24) | (Integer.parseInt(p[1]) << 16)
                | (Integer.parseInt(p[2]) << 8) | Integer.parseInt(p[3]);
    }

    private static Set<String> myAddresses() {
        Set<String> out = new HashSet<>();
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                Enumeration<InetAddress> addrs = ni.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress a = addrs.nextElement();
                    if (a instanceof java.net.Inet4Address) out.add(a.getHostAddress());
                }
            }
        } catch (Exception ignore) {
        }
        return out;
    }

    private static List<String> broadcastTargets() {
        List<String> out = new ArrayList<>();
        out.add("255.255.255.255");
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            while (ifs.hasMoreElements()) {
                NetworkInterface ni = ifs.nextElement();
                if (ni.isLoopback() || !ni.isUp()) continue;
                for (InterfaceAddress ia : ni.getInterfaceAddresses()) {
                    if (ia.getBroadcast() != null) out.add(ia.getBroadcast().getHostAddress());
                }
            }
        } catch (Exception ignore) {
        }
        return out;
    }
}
