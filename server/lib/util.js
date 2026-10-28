const http = require('http');
const os = require('os');

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const a of ifaces[name] || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        out.push({ name, address: a.address, netmask: a.netmask });
      }
    }
  }
  return out;
}

// 给手机显示用的"这台电脑是谁"：登录用户名 + 人话版系统名
function osLabel() {
  const p = os.platform();
  const [maj, min, build] = os.release().split('.').map(Number);
  let name;
  if (p === 'win32') {
    name = maj >= 10 ? (build >= 22000 ? 'Windows 11' : 'Windows 10')
      : maj === 6 && min === 3 ? 'Windows 8.1'
      : maj === 6 && min === 2 ? 'Windows 8'
      : maj === 6 && min === 1 ? 'Windows 7' : 'Windows';
  } else if (p === 'darwin') name = 'macOS';
  else if (p === 'linux') name = 'Linux';
  else name = p;
  return name;
}

function userName() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-HC-Token, X-HC-Meta');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

module.exports = { lanAddresses, osLabel, userName, readBody, readJson, sendJson, cors };
