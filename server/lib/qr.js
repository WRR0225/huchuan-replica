// 极简 QR Code 编码器（ISO/IEC 18004）：字节模式、纠错等级 L、版本 1~10（最多 271 字节）。
// 只用于本机局域网里给手机扫码，无外部依赖。

const ECC_L = 1; // 格式信息里 L 的取值

// [每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数]
const BLOCKS = {
  1: [7, 1, 19, 0, 0],
  2: [10, 1, 34, 0, 0],
  3: [15, 1, 55, 0, 0],
  4: [20, 1, 80, 0, 0],
  5: [26, 1, 108, 0, 0],
  6: [18, 2, 68, 0, 0],
  7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0],
  9: [30, 2, 116, 0, 0],
  10: [18, 2, 68, 2, 69],
};

const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function rsGenPoly(n) {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gmul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, ecLen) {
  const gen = rsGenPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const b of data) {
    const factor = b ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= gmul(gen[i + 1], factor);
  }
  return res;
}

function dataCodewords(version) {
  const [ec, n1, d1, n2, d2] = BLOCKS[version];
  return n1 * d1 + n2 * d2;
}

function splitBlocks(version, codewords) {
  const [ec, n1, d1, n2, d2] = BLOCKS[version];
  const blocks = [];
  let p = 0;
  for (let i = 0; i < n1 + n2; i++) {
    const len = i < n1 ? d1 : d2;
    const data = codewords.slice(p, p + len);
    p += len;
    blocks.push({ data, ec: rsRemainder(data, ec) });
  }
  return blocks;
}

function interleave(blocks) {
  const out = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < blocks[0].ec.length; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

function toBits(bytes, version) {
  const bits = [];
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4); // 字节模式
  put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const cap = dataCodewords(version) * 8;
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0); // 结束符
  while (bits.length % 8) bits.push(0);
  const cw = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    cw.push(v);
  }
  for (let i = 0; cw.length < cap / 8; i++) cw.push(i % 2 ? 0x11 : 0xec);
  return cw;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x * y) % 3) + ((x + y) % 2)) % 2 === 0,
];

function penalty(mod, size) {
  const at = (r, c) => mod[r][c];
  let score = 0;

  const linePenalty = (arr) => {
    let run = 1;
    for (let i = 1; i <= arr.length; i++) {
      if (i < arr.length && arr[i] === arr[i - 1]) run++;
      else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    const s = arr.join('');
    for (const pat of ['10111010000', '00001011101']) {
      let from = 0;
      while (s.indexOf(pat, from) >= 0) {
        score += 40;
        from = s.indexOf(pat, from) + 1;
      }
    }
  };
  for (let r = 0; r < size; r++) linePenalty(mod[r]);
  for (let c = 0; c < size; c++) linePenalty(Array.from({ length: size }, (_, r) => at(r, c)));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = at(r, c);
      if (v === at(r, c + 1) && v === at(r + 1, c) && v === at(r + 1, c + 1)) score += 3;
    }
  }

  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += at(r, c);
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

function newGrid(size) {
  return Array.from({ length: size }, () => new Array(size).fill(0));
}

/** 生成二维码模块矩阵：返回 { size, modules(0/1 二维数组) } */
function qrMatrix(text) {
  const bytes = Buffer.from(text, 'utf8');
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const cci = v <= 9 ? 8 : 16;
    if (4 + cci + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('QR 内容过长（版本 1~10 最多 271 字节）');

  const size = version * 4 + 17;
  const mod = newGrid(size);
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    mod[r][c] = v ? 1 : 0;
    fn[r][c] = true;
  };

  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const ring = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(row + r, col + c, ring || core ? 1 : 0);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0 ? 1 : 0);
    set(i, 6, i % 2 === 0 ? 1 : 0);
  }

  const pos = ALIGN[version];
  for (const r of pos) {
    for (const c of pos) {
      const nearFinder = (r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8);
      if (nearFinder) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
        }
      }
    }
  }

  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) set(8, i, 0);
    if (!fn[i][8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, 0);
    set(size - 1 - i, 8, 0);
  }
  set(size - 8, 8, 1); // 固定黑点

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const c = Math.floor(i / 3);
      set(c, a, b);
      set(a, c, b);
    }
  }

  const codewords = interleave(splitBlocks(version, toBits(bytes, version)));
  let idx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const upward = ((right + 1) & 2) === 0;
        const row = upward ? size - 1 - vert : vert;
        if (fn[row][col]) continue;
        const bit = idx < codewords.length * 8 ? (codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1 : 0;
        mod[row][col] = bit;
        idx++;
      }
    }
  }

  const formatBits = (mask) => {
    const data = (ECC_L << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask) => {
    const bits = formatBits(mask);
    for (let i = 0; i < 15; i++) {
      const b = (bits >>> i) & 1;
      if (i < 6) set(i, 8, b);
      else if (i === 6) set(7, 8, b);
      else if (i === 7) set(8, 8, b);
      else if (i === 8) set(8, 7, b);
      else set(8, 14 - i, b);
      const col2 = i < 8 ? size - 1 - i : 8;
      const row2 = i < 8 ? 8 : size - 15 + i;
      set(row2, col2, b);
    }
  };

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const cand = mod.map((row) => row.slice());
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) if (!fn[r][c] && MASKS[mask](c, r)) cand[r][c] ^= 1;
    }
    const before = mod.map((row) => row.slice());
    for (let r = 0; r < size; r++) mod[r] = cand[r];
    drawFormat(mask);
    const p = penalty(mod, size);
    if (!best || p < best.p) best = { p, snapshot: mod.map((row) => row.slice()) };
    for (let r = 0; r < size; r++) mod[r] = before[r];
  }
  return { size, modules: best.snapshot };
}

function toSvg(matrix, scale = 6, margin = 4) {
  const n = matrix.length;
  const dim = (n + margin * 2) * scale;
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) d += `M${(c + margin) * scale} ${(r + margin) *scale}h${scale}v${scale}h-${scale}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

module.exports = { qrMatrix, toSvg };
