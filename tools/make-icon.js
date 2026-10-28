// 生成 Windows 桌面图标 huchuan.ico：把 APP 的双圆 logo（drawable/ic_launcher_foreground.xml）
// 光栅化成多尺寸 PNG-in-ICO。零依赖：PNG 编码和 CRC32 都手写。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [256, 48, 32, 16];
const OUT = path.join(__dirname, '..', 'huchuan.ico');

const G0 = [0x35, 0xd6, 0xe0];
const G1 = [0x0a, 0xa8, 0xc0];
// 108 画布坐标系（和自适应图标一致：group scale 1.6 + translate 22）
const LOGO = {
  c1: { cx: 1.6 * 15 + 22, cy: 1.6 * 20 + 22, r: 1.6 * 12, g: [[1.6 * 3 + 22, 1.6 * 8 + 22], [1.6 * 27 + 22, 1.6 * 32 + 22]], a: 1 },
  c2: { cx: 1.6 * 26 + 22, cy: 1.6 * 20 + 22, r: 1.6 * 12, g: [[1.6 * 14 + 22, 1.6 * 8 + 22], [1.6 * 38 + 22, 1.6 * 32 + 22]], a: 0.75 },
};
const SHRINK = 0.86; // 桌面图标不做圆形裁切，logo 收一点才不会顶到边

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const t = Buffer.from(type, 'latin1');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([head, t, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function gradColor(g, x, y) {
  const [p0, p1] = g;
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const len2 = dx * dx + dy * dy;
  let t = ((x - p0[0]) * dx + (y - p0[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return [
    Math.round(G0[0] + (G1[0] - G0[0]) * t),
    Math.round(G0[1] + (G1[1] - G0[1]) * t),
    Math.round(G0[2] + (G1[2] - G0[2]) * t),
  ];
}

function insideCircle(cx, cy, r, x, y) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 圆角方底：四角用半径 rr 的圆弧切掉
function inRoundedSquare(size, x, y) {
  const rr = size * 0.22;
  if (x < rr && y < rr) return (x - rr) ** 2 + (y - rr) ** 2 <= rr * rr;
  if (x > size - rr && y < rr) return (x - (size - rr)) ** 2 + (y - rr) ** 2 <= rr * rr;
  if (x < rr && y > size - rr) return (x - rr) ** 2 + (y - (size - rr)) ** 2 <= rr * rr;
  if (x > size - rr && y > size - rr) return (x - (size - rr)) ** 2 + (y - (size - rr)) ** 2 <= rr * rr;
  return x >= 0 && x < size && y >= 0 && y < size;
}

function render(size) {
  const ss = size >= 128 ? 2 : 4;
  const k = size / 108;
  const shrink = (v) => (v - 54) * SHRINK + 54;
  const circles = [LOGO.c1, LOGO.c2].map((c) => ({
    cx: shrink(c.cx) * k, cy: shrink(c.cy) * k, r: c.r * SHRINK * k,
    g: c.g.map((p) => [shrink(p[0]) * k, shrink(p[1]) * k]), a: c.a,
  }));
  const buf = Buffer.alloc(size * size * 4);
  const step = 1 / ss;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (let oy = 0; oy < ss; oy++) {
        for (let ox = 0; ox < ss; ox++) {
          const x = px + ox * step + step / 2;
          const y = py + oy * step + step / 2;
          let r = 0, g = 0, b = 0, a = 0;
          if (inRoundedSquare(size, x, y)) { r = 255; g = 255; b = 255; a = 1; }
          for (const c of circles) {
            if (!insideCircle(c.cx, c.cy, c.r, x, y)) continue;
            const [cr, cg, cb] = gradColor(c.g, x, y);
            const na = a + c.a * (1 - a);
            if (na > 0) {
              r = (cr * c.a + r * a * (1 - c.a)) / na;
              g = (cg * c.a + g * a * (1 - c.a)) / na;
              b = (cb * c.a + b * a * (1 - c.a)) / na;
            }
            a = na;
          }
          sr += r; sg += g; sb += b; sa += a;
        }
      }
      const n = ss * ss;
      const alpha = sa / n;
      const i = (py * size + px) * 4;
      // PNG 存直通 alpha，透明角要让颜色归零，否则缩放后 corners 发灰
      buf[i] = alpha > 0 ? Math.round(sr / n) : 0;
      buf[i + 1] = alpha > 0 ? Math.round(sg / n) : 0;
      buf[i + 2] = alpha > 0 ? Math.round(sb / n) : 0;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return encodePng(size, buf);
}

const images = SIZES.map(render);
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2); // type: icon
dir.writeUInt16LE(SIZES.length, 4);
const entries = Buffer.alloc(16 * SIZES.length);
let offset = dir.length + entries.length;
SIZES.forEach((size, i) => {
  const at = i * 16;
  entries[at] = size >= 256 ? 0 : size;
  entries[at + 1] = size >= 256 ? 0 : size;
  entries.writeUInt16LE(1, at + 4);      // planes
  entries.writeUInt16LE(32, at + 6);     // bpp
  entries.writeUInt32LE(images[i].length, at + 8);
  entries.writeUInt32LE(offset, at + 12);
  offset += images[i].length;
});
fs.writeFileSync(OUT, Buffer.concat([dir, entries, ...images]));
console.log(`huchuan.ico 已生成：${OUT}（${SIZES.join('/')} px，${fs.statSync(OUT).size} 字节）`);
