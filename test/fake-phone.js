// 模拟手机客户端：用于在真机到位前验证协议全链路
const dgram = require('dgram');
const http = require('http');
const fs = require('fs');
const path = require('path');

const UDP_PORT = Number(process.env.UDP_PORT || 8788);
const DEVICE = {
  deviceId: 'fake-phone-001',
  model: 'HUAWEI P60 Art',
  brand: 'HUAWEI',
  android: '12',
  appVersion: '0.1.0',
};

const LIB = {
  image: Array.from({ length: 5 }, (_, i) => ({ id: 'img' + i, name: `IMG_2026101${i}.jpg`, size: 2_000_000 + i, mime: 'image/jpeg', mtime: Date.now() - i * 3600_000 })),
  video: [{ id: 'vid0', name: '大视频.mp4', size: 5_000_000, mime: 'video/mp4', mtime: Date.now() - 86400_000 }],
  audio: [],
  doc: [
    { id: 'doc0', name: '说明书.pdf', size: 123456, mime: 'application/pdf', mtime: Date.now() - 86400_000 },
    { id: 'doc1', name: '装修记录.txt', size: 2048, mime: 'text/plain', mtime: Date.now() - 2 * 86400_000 },
    { id: 'doc2', name: '照片备份.7z', size: 812_345_678, mime: 'application/x-7z-compressed', mtime: Date.now() - 3 * 86400_000 },
    { id: 'doc3', name: '驱动包.zip', size: 15_600_000, mime: 'application/zip', mtime: Date.now() - 4 * 86400_000 },
    { id: 'doc4', name: '季度报表.docx', size: 45_210, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mtime: Date.now() - 5 * 86400_000 },
    { id: 'doc5', name: '三体.epub', size: 1_240_000, mime: 'application/epub+zip', mtime: Date.now() - 6 * 86400_000 },
    { id: 'doc6', name: '合同扫描.pdf', size: 3_450_000, mime: 'application/pdf', mtime: Date.now() - 12 * 86400_000 },
    { id: 'doc7', name: '会议纪要.docx', size: 88_000, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', mtime: Date.now() - 20 * 86400_000 },
  ],
};

// 长列表：专门用来验滚动和分页
const FAKE_KINDS = [['pdf', 'application/pdf'], ['txt', 'text/plain'], ['zip', 'application/zip'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['epub', 'application/epub+zip'], ['pptx', 'application/vnd.ms-powerpoint']];
for (let i = 0; i < 42; i++) {
  const k = FAKE_KINDS[i % FAKE_KINDS.length];
  LIB.doc.push({ id: 'gen' + i, name: `扫描件-${String(i + 1).padStart(2, '0')}.${k[0]}`, size: 900_000 + i * 7000, mime: k[1], mtime: Date.now() - (30 + i) * 86400_000 });
}

// 图片造一大批：用来验「加载全部」的分页和排序
for (let i = 0; i < 620; i++) {
  const long = i % 40 === 0 ? `微信图片_202610${String(i).padStart(3, '0')}_原图_拼接-全景-带一长串后缀.jpg` : `IMG_${1000 + i}.jpg`;
  LIB.image.push({ id: 'genimg' + i, name: long, size: 1_000_000 + i * 3000, mime: 'image/jpeg', mtime: Date.now() - i * 3600_000 });
}

let base = null;
let token = null;

function post(path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body == null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const req = http.request(base + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...(token ? { 'X-HC-Token': token } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function postStream(path, meta, makeBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, {
      method: 'POST',
      headers: {
        'X-HC-Token': token,
        'X-HC-Meta': Buffer.from(JSON.stringify(meta)).toString('base64'),
        'Transfer-Encoding': 'chunked',
      },
    }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    makeBody(req);
  });
}

function discover() {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    let timer = null;
    const finish = (m) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch {}
      resolve(m);
    };
    sock.on('message', (buf, rinfo) => {
      let m;
      try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
      if (m.type !== 'here') return;
      finish(m);
    });
    sock.bind(0, () => {
      sock.setBroadcast(true);
      const msg = Buffer.from(JSON.stringify({ proto: 'huchuan', type: 'discover', v: 1 }));
      sock.send(msg, UDP_PORT, '255.255.255.255');
      sock.send(msg, UDP_PORT, '192.168.0.255');
      sock.send(msg, UDP_PORT, '127.0.0.1');
    });
    timer = setTimeout(() => finish(null), 3000);
  });
}

function svg(w, h, label, color) {
  const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<rect width="100%" height="100%" fill="${color}"/>`
    + `<text x="50%" y="50%" font-size="${Math.round(h / 8)}" fill="#fff" text-anchor="middle">${label}</text></svg>`;
  return Buffer.from(s, 'utf8');
}

// 模拟手机收文件：GET 服务器中转的字节流，落进 test/inbox
async function receive(cmd) {
  const a = cmd.args || {};
  const file = path.join(__dirname, 'inbox', String(a.name || 'file').replace(/[\\/]/g, ''));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let written = 0;
  try {
    await new Promise((resolve, reject) => {
      const req = http.get(`${base}/api/getfile/${cmd.id}`,
        { headers: { 'X-HC-Token': token } }, (res) => {
          if (res.statusCode >= 400) {
            let b = '';
            res.on('data', (c) => { b += c; });
            res.on('end', () => reject(new Error(b || `HTTP ${res.statusCode}`)));
            return;
          }
          const out = fs.createWriteStream(file);
          res.on('data', (c) => { written += c.length; });
          res.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          res.on('error', reject);
        });
      req.on('error', reject);
    });
    if (a.size && written !== a.size) throw new Error(`接收不完整 ${written}/${a.size} 字节`);
    console.log('[phone] 已接收', a.name, written + 'B ->', file);
    await post('/api/result', { id: cmd.id, ok: true, data: { target: '互传/' + a.name, written } });
  } catch (e) {
    console.log('[phone] 接收失败', a.name, e.message);
    await post('/api/result', { id: cmd.id, ok: false, error: e.message }).catch(() => {});
  }
}

async function handle(cmd) {
  if (cmd.cmd === 'noop') return;
  console.log('[phone] 收到命令', cmd.cmd, JSON.stringify(cmd.args || {}));
  if (cmd.cmd === 'counts') {
    await post('/api/result', { id: cmd.id, ok: true, data: { image: LIB.image.length, video: LIB.video.length, audio: 0, doc: LIB.doc.length } });
  } else if (cmd.cmd === 'list') {
    const items = LIB[cmd.args.cat] || [];
    const slice = items.slice(cmd.args.offset, cmd.args.offset + cmd.args.limit);
    await post('/api/result', { id: cmd.id, ok: true, data: { items: slice, total: items.length } });
  } else if (cmd.cmd === 'recent') {
    const days = cmd.args.days || 30;
    const cutoff = Date.now() - days * 86400_000;
    const items = [...LIB.image, ...LIB.video, ...LIB.audio]
      .filter((x) => x.mtime >= cutoff)
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, cmd.args.limit || 60);
    await post('/api/result', { id: cmd.id, ok: true, data: { items, total: items.length, days } });
  } else if (cmd.cmd === 'thumb') {
    const w = cmd.args.w || 300;
    const png = w >= 1000 ? svg(w, w * 3 / 4, `thumb ${w}`, '#0aa8c0') : svg(w, w, String(cmd.args.id), '#7a8288');
    await postStream(`/api/blob/${cmd.id}`, { mime: 'image/svg+xml', size: png.length }, (req) => req.end(png));
  } else if (cmd.cmd === 'file') {
    const all = Object.values(LIB).flat();
    const item = all.find((x) => x.id === cmd.args.id);
    if (!item) return post('/api/blobfail', { id: cmd.id, error: 'not found' });
    if (item.mime.startsWith('image/')) {
      const b = svg(2400, 1800, `原图 ${item.name}`, '#e0567a');
      return postStream(`/api/blob/${cmd.id}`, { mime: 'image/svg+xml', size: b.length, name: item.name }, (req) => req.end(b));
    }
    await postStream(`/api/blob/${cmd.id}`, { mime: item.mime, size: item.size, name: item.name }, (req) => {
      let left = item.size;
      const chunk = Buffer.alloc(64 * 1024, 7);
      const tick = () => {
        while (left > 0) {
          const piece = chunk.subarray(0, Math.min(chunk.length, left));
          left -= piece.length;
          if (!req.write(piece)) return req.once('drain', tick);
        }
        req.end();
      };
      tick();
    });
    console.log('[phone] 文件流发送完毕', item.name);
  } else if (cmd.cmd === 'recv') {
    // HC_NO_RECV=1 模拟装着旧版 APP（还不认识 recv 命令）的手机
    if (process.env.HC_NO_RECV) return post('/api/result', { id: cmd.id, ok: false, error: 'unknown command recv' });
    receive(cmd);
  } else if (cmd.cmd === 'disconnect') {
    await post('/api/result', { id: cmd.id, ok: true, data: {} });
    console.log('[phone] 收到断开指令，退出');
    process.exit(0);
  } else {
    await post('/api/result', { id: cmd.id, ok: false, error: 'unknown command ' + cmd.cmd });
  }
}

(async () => {
  const here = await discover();
  if (!here) { console.error('未发现电脑'); process.exit(1); }
  const ip = here.ips.map((i) => i.address).find((a) => a.startsWith('192.168.')) || here.ips[0].address;
  base = `http://${ip}:${here.port}`;
  console.log('[phone] 发现电脑', base, here.name);

  setInterval(() => post('/api/heartbeat', {}).catch(() => {}), 15000);

  // 和 APP 一样：服务端重启后旧 token 会被拒，必须重新注册而不是空转
  while (true) {
    try {
      const reg = await post('/api/register', DEVICE);
      if (!reg.token) throw new Error(reg.error || '注册没返回 token');
      token = reg.token;
      console.log('[phone] 注册成功');
      while (true) {
        const cmd = await post('/api/poll', { timeout: 25000 });
        if (cmd.error && !cmd.cmd) throw new Error(cmd.error);
        await handle(cmd);
      }
    } catch (e) {
      console.error('[phone] 连接出错：' + e.message + '，3 秒后重连');
      token = null;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
})();
