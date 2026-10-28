const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Session } = require('./lib/session');
const { qrMatrix, toSvg } = require('./lib/qr');
const { lanAddresses, osLabel, userName, readBody, readJson, sendJson, cors } = require('./lib/util');

const PORT = Number(process.env.PORT || 8787);
const UDP_PORT = Number(process.env.UDP_PORT || 8788);
const WEB_DIR = path.join(__dirname, 'web');
const APK_PATH = path.join(__dirname, '..', 'phone', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const GRADLE_PATH = path.join(__dirname, '..', 'phone', 'app', 'build.gradle');

function apkInfo() {
  let version = '0.0.0';
  try {
    const m = fs.readFileSync(GRADLE_PATH, 'utf8').match(/versionName\s+"([^"]+)"/);
    if (m) version = m[1];
  } catch {}
  const name = `互传自用版-${version}.apk`;
  return { name, ascii: `huchuan-${version}.apk`, version, size: fs.existsSync(APK_PATH) ? fs.statSync(APK_PATH).size : 0 };
}

const session = new Session();

const events = [];
function logEvent(type, detail) {
  events.push({ t: Date.now(), type, detail: String(detail).slice(0, 300) });
  if (events.length > 300) events.shift();
}

// 手机靠这份载荷认识这台电脑：UDP 应答和二维码内容完全一致，APP 用同一个解析器
function herePayload() {
  return {
    proto: 'huchuan',
    type: 'here',
    v: 1,
    name: os.hostname(),
    user: userName(),
    os: osLabel(),
    port: PORT,
    ips: lanAddresses().map((a) => ({ address: a.address, netmask: a.netmask })),
  };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

function serveApk(req, res) {
  if (!fs.existsSync(APK_PATH)) {
    sendJson(res, 404, { error: 'APK 尚未编译' });
    return;
  }
  const st = fs.statSync(APK_PATH);
  const a = apkInfo();
  res.writeHead(200, {
    'Content-Type': 'application/vnd.android.package-archive',
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename="${a.ascii}"; filename*=UTF-8''${encodeURIComponent(a.name)}`,
  });
  fs.createReadStream(APK_PATH).pipe(res);
}

function requireDevice(req, res) {
  const token = req.headers['x-hc-token'];
  const dev = token && session.byToken(token);
  if (!dev) {
    sendJson(res, 401, { error: 'unauthorized' });
    return null;
  }
  dev.touch();
  return dev;
}

// HTTP headers are ASCII, so the browser percent-encodes the file name; also keep
// the phone from ever seeing a path separator in a name it is about to create
function pushName(raw) {
  let n = String(raw || 'file');
  try { n = decodeURIComponent(n); } catch {}
  n = n.replace(/[\\/]/g, '').replace(/[\u0000-\u001f]/g, '').trim();
  return n.slice(0, 180) || 'file';
}

function relay(req, stream) {
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      req.unpipe(stream);
      req.resume();
      reject(err);
    };
    req.on('error', fail);
    req.on('close', () => { if (!stream.writableEnded) fail(new Error('浏览器取消了发送')); });
    stream.on('error', fail);
    stream.on('finish', resolve);
    req.pipe(stream);
  });
}

async function handleApp(req, res, parts, query) {
  const route = parts.join('/');

  if (route === 'api/register') {
    const info = await readJson(req);
    if (!info.deviceId) return sendJson(res, 400, { error: 'deviceId required' });
    const dev = session.register(info);
    logEvent('register', `${dev.model} (${dev.id})`);
    return sendJson(res, 200, {
      token: dev.token,
      serverTime: Date.now(),
      server: { name: os.hostname(), user: userName(), os: osLabel() },
    });
  }

  if (route === 'api/goodbye') {
    const dev = requireDevice(req, res);
    if (!dev) return;
    await readJson(req);
    logEvent('goodbye', dev.model);
    session.goodbye(dev);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'api/heartbeat') {
    const dev = requireDevice(req, res);
    if (!dev) return;
    await readJson(req);
    return sendJson(res, 200, { ok: true });
  }

  if (route === 'api/poll') {
    const dev = requireDevice(req, res);
    if (!dev) return;
    const body = await readJson(req);
    const timeout = Math.min(Number(body.timeout) || 25000, 30000);
    const cmd = await session.poll(dev, timeout);
    return sendJson(res, 200, cmd);
  }

  if (route === 'api/result') {
    const dev = requireDevice(req, res);
    if (!dev) return;
    const body = await readJson(req, 8 * 1024 * 1024);
    const handled = session.resolveResult(dev, body.id, body.ok !== false, body.data, body.error);
    if (body.ok === false) logEvent('cmd-err', `${dev.model}: ${body.error}`);
    return sendJson(res, 200, { ok: handled });
  }

  if (route === 'api/blobfail') {
    const dev = requireDevice(req, res);
    if (!dev) return;
    const body = await readJson(req);
    session.cancelBlob(dev, body.id, body.error);
    session.failCommand(dev, body.id, body.error || 'transfer failed');
    return sendJson(res, 200, { ok: true });
  }

  if (parts[0] === 'api' && parts[1] === 'blob' && parts[2]) {
    const dev = requireDevice(req, res);
    if (!dev) return;
    const id = parts[2];
    let meta = {};
    try {
      meta = JSON.parse(Buffer.from(req.headers['x-hc-meta'] || 'e30', 'base64').toString('utf8'));
    } catch {}
    const stream = session.beginBlob(dev, id, meta);
    if (!stream) {
      req.destroy();
      return sendJson(res, 409, { error: 'no pending request for this blob' });
    }
    logEvent('blob-start', `${meta.name || id} (${meta.size || '?'}B)`);
    let bytes = 0;
    req.on('data', (c) => { bytes += c.length; });
    req.pipe(stream);
    req.on('end', () => {
      logEvent('blob-end', `${meta.name || id} ${bytes}B`);
      sendJson(res, 200, { ok: true });
    });
    req.on('error', () => stream.destroy());
    return;
  }

  // the phone comes to collect bytes that the browser is pushing up right now
  if (parts[0] === 'api' && parts[1] === 'getfile' && parts[2]) {
    const dev = requireDevice(req, res);
    if (!dev) return;
    const p = session.takePush(dev, parts[2]);
    if (!p) return sendJson(res, 404, { error: 'no pending push' });
    const headers = { 'Content-Type': p.meta.mime || 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (p.meta.size) headers['Content-Length'] = String(p.meta.size);
    res.writeHead(200, headers);
    p.stream.pipe(res);
    p.stream.on('error', () => res.destroy());
    res.on('close', () => { if (!p.stream.readableEnded) session._dropPush(p, '手机断开接收'); });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleWeb(req, res, parts, query) {
  const route = parts.join('/');

  if (route === 'api/state') return sendJson(res, 200, session.snapshot());

  if (route === 'api/events') return sendJson(res, 200, { events: events.slice().reverse() });

  if (route === 'api/net') {
    return sendJson(res, 200, {
      port: PORT,
      udpPort: UDP_PORT,
      ips: lanAddresses().map((a) => a.address),
      hostname: os.hostname(),
    });
  }

  if (route === 'api/active') {
    const body = await readJson(req);
    if (session.devices.has(body.id)) session.activeId = body.id;
    return sendJson(res, 200, session.snapshot());
  }

  if (route === 'api/cmd') {
    const body = await readJson(req, 8 * 1024 * 1024);
    const dev = session.active();
    if (!dev || !dev.online) return sendJson(res, 503, { error: '手机未连接' });
    try {
      const data = await session.requestJson(dev, body.cmd, body.args, Number(body.timeout) || 30000);
      return sendJson(res, 200, { ok: true, data });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // PC -> phone: the browser uploads, we relay the bytes straight to the phone's GET
  if (route === 'api/send') {
    const dev = session.active();
    if (!dev || !dev.online) return sendJson(res, 503, { error: '手机未连接' });
    const meta = {
      name: pushName(req.headers['x-hc-name']),
      mime: String(req.headers['x-hc-mime'] || '').slice(0, 100) || 'application/octet-stream',
      size: Number(req.headers['x-hc-size']) || 0,
    };
    const p = session.startPush(dev, meta);
    // 浏览器走了而手机还没来取：立刻作废，不用干等 20 秒
    const gone = () => { if (!req.complete && p.pullResolve) session._dropPush(p, '浏览器取消了发送'); };
    req.on('close', gone);
    logEvent('push-start', `${meta.name} (${meta.size}B) -> ${dev.model}`);
    try {
      await p.pulled;
      await relay(req, p.stream);
      const data = await p.acked;
      logEvent('push-end', `${meta.name} -> ${data && data.target ? data.target : dev.model}`);
      return sendJson(res, 200, { ok: true, data });
    } catch (e) {
      session._dropPush(p, e.message);
      logEvent('push-err', `${meta.name}: ${e.message}`);
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  // streams a blob (thumbnail / file) from the phone straight into the browser response
  if (parts[0] === 'api' && (parts[1] === 'blobcmd' || parts[1] === 'file')) {
    const dev = session.active();
    if (!dev || !dev.online) return sendJson(res, 503, { error: '手机未连接' });
    const cmd = parts[1] === 'file' ? 'file' : query.get('cmd') || 'thumb';
    let args = {};
    try { args = JSON.parse(query.get('args') || '{}'); } catch {}
    try {
      const { meta, stream } = await session.requestBlob(dev, cmd, args, Number(query.get('timeout')) || 60000);
      const headers = {
        'Content-Type': meta.mime || 'application/octet-stream',
        'Cache-Control': 'no-store',
      };
      if (meta.size) headers['Content-Length'] = String(meta.size);
      if (parts[1] === 'file' && meta.name) {
        headers['Content-Disposition'] =
          `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`;
      }
      res.writeHead(200, headers);
      stream.pipe(res);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
      else res.destroy();
    }
    return;
  }

  if (route === 'api/qr.svg') {
    const text = JSON.stringify(herePayload());
    const svg = toSvg(qrMatrix(text).modules, Number(query.get('s')) || 6, 4);
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end(svg);
    return;
  }

  if (route === 'api/apk') return serveApk(req, res);

  serveStatic(req, res, req.url.split('?')[0]);
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api' && ['register', 'heartbeat', 'poll', 'result', 'blob', 'blobfail', 'getfile', 'goodbye'].includes(parts[1])) {
      await handleApp(req, res, parts, u.searchParams);
    } else {
      await handleWeb(req, res, parts, u.searchParams);
    }
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.destroy();
  }
});

// ---- UDP discovery ----
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
udp.on('message', (buf, rinfo) => {
  let msg;
  try { msg = JSON.parse(buf.toString('utf8')); } catch { return; }
  if (msg.proto !== 'huchuan' || msg.type !== 'discover') return;
  const reply = Buffer.from(JSON.stringify(herePayload()));
  udp.send(reply, rinfo.port, rinfo.address);
});
udp.on('error', () => {});

server.listen(PORT, '0.0.0.0', () => {
  udp.bind(UDP_PORT, '0.0.0.0');
  const ips = lanAddresses().map((a) => a.address);
  console.log('互传服务已启动');
  console.log(`  网页:  http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  局域网: http://${ip}:${PORT}`);
  console.log(`  发现端口: UDP ${UDP_PORT}`);
});
