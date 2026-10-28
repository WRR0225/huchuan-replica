const $ = (s) => document.querySelector(s);
const state = {
  devices: [],
  activeId: null,
  view: 'home',
  list: { cat: null, offset: 0, items: [], total: 0, loading: false, loadingAll: false, all: false, sort: '', query: '' },
  recent: null,
  selected: new Set(),
  sending: false,
};

const CATS = { image: '图片', video: '视频', audio: '音乐', doc: '文档', file: '文件', app: '应用' };
const RECENT_DAYS = 30;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  return res.json();
}

function onlineDevice() {
  const d = state.devices.find((x) => x.id === state.activeId) || state.devices.find((x) => x.online);
  return d && d.online ? d : null;
}

async function pollState() {
  try {
    const s = await api('/api/state');
    const was = onlineDevice()?.id;
    state.devices = s.devices;
    state.activeId = s.activeId;
    const now = onlineDevice();
    if (now && now.id !== was) {
      toast(`已连接 ${now.model}`);
      state.selected.clear();
      if (state.view !== 'home') loadList(state.view);
      else {
        refreshCounts();
        loadRecent(true);
      }
    }
    if (!now && was) {
      toast('手机已断开');
      resetHome();
    }
    render();
  } catch {}
}

async function refreshCounts() {
  const dev = onlineDevice();
  if (!dev) return;
  try {
    const r = await api('/api/cmd', { cmd: 'counts', args: {}, timeout: 20000 });
    if (r.ok && r.data) {
      for (const k of ['image', 'video', 'audio']) {
        const el = $('#count-' + k);
        if (el && r.data[k] != null) el.textContent = r.data[k];
      }
    }
  } catch {}
}

function setRecentEmpty(text) {
  const box = $('#recent-empty');
  box.classList.remove('hidden');
  box.querySelector('p').textContent = text;
}

function renderRecent(items) {
  const grid = $('#recent-grid');
  grid.innerHTML = '';
  resetThumbs();
  for (const item of items) grid.appendChild(tileEl(item));
  $('#recent-empty').classList.toggle('hidden', items.length > 0);
  if (!items.length) setRecentEmpty(`最近 ${RECENT_DAYS} 天没有新文件`);
}

async function loadRecent(force) {
  if (!onlineDevice()) return;
  if (!force && state.recent && Date.now() - state.recent.at < 30000) return renderRecent(state.recent.items);
  setRecentEmpty('读取中…');
  try {
    const r = await api('/api/cmd', { cmd: 'recent', args: { days: RECENT_DAYS, limit: 60 }, timeout: 30000 });
    if (!r.ok) throw new Error(r.error);
    state.recent = { at: Date.now(), items: r.data.items };
    renderRecent(r.data.items);
  } catch (e) {
    state.recent = null;
    $('#recent-grid').innerHTML = '';
    setRecentEmpty('最近文件读取失败：' + e.message);
  }
}

function resetHome() {
  state.selected.clear();
  state.recent = null;
  resetThumbs();
  $('#recent-grid').innerHTML = '';
  setRecentEmpty('无最近文件');
  for (const k of ['image', 'video', 'audio']) $('#count-' + k).textContent = '—';
}

function render() {
  const dev = onlineDevice();
  $('#device-name').textContent = dev ? dev.model : '未连接';
  $('#btn-save').disabled = !dev || state.selected.size === 0;
  $('#btn-send').disabled = !dev;
  $('#btn-disconnect').disabled = !dev;
  syncSearch();
  renderSelSize();

  const connected = !!dev;
  document.body.classList.toggle('offline', !connected);
  $('#view-connect').classList.toggle('hidden', connected);
  $('#view-home').classList.toggle('hidden', !connected || state.view !== 'home');
  $('#view-list').classList.toggle('hidden', !connected || state.view === 'home');

  document.querySelectorAll('.nav-item').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.view);
  });
}

/** 手机上报列表时已经带了 size，总大小直接算就行，不用再问一遍 */
function renderSelSize() {
  const el = $('#sel-chip');
  const n = state.selected.size;
  if (!n) {
    el.classList.add('hidden');
    return;
  }
  const sizes = new Map();
  for (const it of state.list.items) sizes.set(it.id, it.size || 0);
  if (state.recent) for (const it of state.recent.items) sizes.set(it.id, it.size || 0);
  let bytes = 0;
  for (const id of state.selected) bytes += sizes.get(id) || 0;
  el.classList.remove('hidden');
  el.textContent = bytes ? `已选 ${n} 项 · ${human(bytes)}` : `已选 ${n} 项`;
}

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5C7 4.5 2.7 7.6 1 12c1.7 4.4 6 7.5 11 7.5s9.3-3.1 11-7.5C21.3 7.6 17 4.5 12 4.5zm0 12.5c-2.8 0-5-2.2-5-5s2.2-5 5-5 5 2.2 5 5-2.2 5-5 5zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>';

function blobSrc(cmd, args) {
  return `/api/blobcmd?cmd=${cmd}&args=${encodeURIComponent(JSON.stringify(args))}`;
}

function isImage(item) {
  return item.id.startsWith('image:') || /^image\//i.test(item.mime || '');
}

function toggleSel(item, tile) {
  if (state.selected.has(item.id)) state.selected.delete(item.id);
  else state.selected.add(item.id);
  tile.classList.toggle('selected', state.selected.has(item.id));
  render();
}

function tileEl(item) {
  const div = document.createElement('div');
  div.className = 'tile' + (state.selected.has(item.id) ? ' selected' : '');
  div.dataset.id = item.id;
  div.dataset.name = item.name || '';
  const img = document.createElement('img');
  // 不用 loading=lazy：它被 Chrome 推迟时 onload/onerror 一次都不来，会把并发计数永久卡住。
  // 要不要发请求已经由 IntersectionObserver 决定了。
  attachThumb(img, blobSrc('thumb', { id: item.id, w: 300 }));
  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = item.name;
  const size = document.createElement('span');
  size.className = 'tile-size';
  size.textContent = human(item.size || 0);
  name.append(size);
  const check = document.createElement('div');
  check.className = 'tile-check';
  check.textContent = '✓';
  div.append(img, name, check);
  div.onclick = () => toggleSel(item, div);
  if (isImage(item)) {
    const eye = document.createElement('button');
    eye.className = 'tile-eye';
    eye.title = '查看大图';
    eye.innerHTML = EYE;
    eye.onclick = (e) => { e.stopPropagation(); openView(item); };
    div.append(eye);
  }
  return div;
}

const PAGE = '<path d="M6 2h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z" fill="#fff" stroke="#c9ced2" stroke-width="1.2"/><path d="M14.5 2.5V8H20" fill="none" stroke="#c9ced2" stroke-width="1.2"/>';

const DOC_ICONS = {
  pdf: `<svg viewBox="0 0 24 24">${PAGE}<rect x="2.6" y="12" width="12.4" height="7.2" rx="1.6" fill="#e2493f"/>`
    + `<text x="8.8" y="17.3" font-size="5.4" font-family="Arial, sans-serif" font-weight="bold" fill="#fff" text-anchor="middle">PDF</text></svg>`,
  txt: `<svg viewBox="0 0 24 24">${PAGE}<g stroke="#4a90d9" stroke-width="1.6" stroke-linecap="round"><path d="M8.4 11h7.2M8.4 14.4h7.2M8.4 17.8h4.4"/></g></svg>`,
  zip: `<svg viewBox="0 0 24 24">${PAGE}<g fill="#e0a32e"><rect x="11" y="3.6" width="2" height="2"/><rect x="11" y="6.6" width="2" height="2"/>`
    + `<rect x="11" y="9.6" width="2" height="2"/><rect x="10" y="12.6" width="4" height="5.6" rx="1.2"/></g><rect x="11.4" y="14.4" width="1.2" height="2.2" fill="#fff"/></svg>`,
  other: `<svg viewBox="0 0 24 24">${PAGE}<g stroke="#9aa0a5" stroke-width="1.6" stroke-linecap="round"><path d="M8.4 13h7.2M8.4 16.6h4.6"/></g></svg>`,
};

function docKind(item) {
  const n = (item.name || '').toLowerCase();
  const m = (item.mime || '').toLowerCase();
  if (m === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (m === 'text/plain' || /\.(txt|md|log)$/.test(n)) return 'txt';
  if (n.endsWith('.epub')) return 'other';
  if (/zip|rar|7z|tar|gz|bz2|xz|compress/.test(m) || /\.(zip|rar|7z|tar|tgz|gz|bz2|xz)$/.test(n)) return 'zip';
  return 'other';
}

function human(n) {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + 'GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + 'MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + 'KB';
  return n + 'B';
}

const KIND_RANK = { pdf: 0, txt: 1, zip: 2, other: 3 };

function docExt(item) {
  const m = /\.([^.]+)$/.exec(item.name || '');
  return m ? m[1].toUpperCase() : '';
}

/** 同类型的挨在一起：先按图标种类，再按扩展名，同类里新的在前 */
function sortDocs(items) {
  return items.slice().sort((a, b) => KIND_RANK[docKind(a)] - KIND_RANK[docKind(b)]
    || docExt(a).localeCompare(docExt(b))
    || (b.mtime || 0) - (a.mtime || 0));
}

function renderRows(items, grid) {
  grid.innerHTML = '';
  const groups = [];
  for (const it of items) {
    const ext = docExt(it);
    const g = groups[groups.length - 1];
    if (g && g.ext === ext) g.items.push(it);
    else groups.push({ ext, items: [it] });
  }
  for (const g of groups) {
    const head = document.createElement('div');
    head.className = 'row-group';
    head.textContent = `${g.ext || '其它'} · ${g.items.length}`;
    grid.appendChild(head);
    for (const it of g.items) grid.appendChild(rowEl(it));
  }
}

function rowEl(item) {
  const div = document.createElement('div');
  div.className = 'row' + (state.selected.has(item.id) ? ' selected' : '');
  div.dataset.id = item.id;
  div.dataset.name = item.name || '';
  const ico = document.createElement('div');
  ico.className = 'row-ico';
  ico.innerHTML = DOC_ICONS[docKind(item)];
  const name = document.createElement('div');
  name.className = 'row-name';
  name.textContent = item.name;
  const size = document.createElement('div');
  size.className = 'row-size';
  size.textContent = human(item.size || 0);
  const time = document.createElement('div');
  time.className = 'row-time';
  time.textContent = item.mtime ? new Date(item.mtime).toLocaleDateString('zh-CN') : '';
  const check = document.createElement('div');
  check.className = 'row-check';
  check.textContent = '✓';
  div.append(ico, name, size, time, check);
  div.onclick = () => toggleSel(item, div);
  return div;
}

const lb = { item: null, full: false, seq: 0 };
const previewSrc = () => blobSrc('thumb', { id: lb.item.id, w: 2400 });

function openView(item) {
  lb.item = item;
  lb.full = false;
  $('#lb-full').textContent = '查看原图';
  $('#lb-name').textContent = item.name;
  $('#lightbox').classList.remove('hidden');
  setLbSrc(previewSrc(), '高清预览加载中…');
}

function closeView() {
  lb.item = null;
  lb.seq++;
  $('#lb-img').removeAttribute('src');
  $('#lightbox').classList.add('hidden');
}

function setLbSrc(src, loadingText) {
  const img = $('#lb-img');
  const tip = $('#lb-tip');
  const seq = ++lb.seq;
  img.style.visibility = 'hidden';
  tip.classList.remove('hidden');
  tip.textContent = loadingText;
  img.onload = () => { if (seq === lb.seq) { img.style.visibility = ''; tip.classList.add('hidden'); } };
  img.onerror = () => {
    if (seq !== lb.seq) return;
    if (!lb.full) return void (tip.textContent = '大图加载失败');
    lb.full = false;
    $('#lb-full').textContent = '查看原图';
    setLbSrc(previewSrc(), '高清预览加载中…');
    toast('原图格式浏览器无法显示，已返回高清预览');
  };
  img.src = src;
}

const thumbQueue = [];
const thumbInflight = new Set();
let thumbActive = 0;
const THUMB_CONCURRENCY = 6;

function queueThumb(img, src) {
  thumbPending.delete(img);
  thumbQueue.push({ img, src });
  pumpThumbs();
}

function pumpThumbs() {
  while (thumbActive < THUMB_CONCURRENCY && thumbQueue.length) {
    const job = thumbQueue.shift();
    thumbActive++;
    thumbInflight.add(job);
    const done = () => { thumbActive--; thumbInflight.delete(job); pumpThumbs(); };
    job.img.onload = done;
    job.img.onerror = () => { job.img.style.display = 'none'; done(); };
    job.img.src = job.src;
  }
}

// 加载全部可能有几千条，只有滚到附近的才去手机要缩略图，否则队列能把手机端堵死
const thumbPending = new Set();
let thumbFired = 0;
const thumbIO = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (!en.isIntersecting) continue;
    thumbFired++;
    if (thumbPending.has(en.target)) queueThumb(en.target, en.target.dataset.src);
    thumbIO.unobserve(en.target);
  }
}, { rootMargin: '240px 0px' });

function attachThumb(img, src) {
  if (!thumbIO) return queueThumb(img, src);
  img.dataset.src = src;
  thumbPending.add(img);
  thumbIO.observe(img);
  // 页面在后台时 IO 可以一次都不回调，那样就一直是白格子：两秒内没动静就按文档顺序放行
  if (!thumbFired) {
    setTimeout(() => { if (!thumbFired) [...thumbPending].forEach((i) => queueThumb(i, i.dataset.src)); }, 2000);
  }
}

function resetThumbs() {
  thumbQueue.length = 0;
  // 在途的那些会被连元素一起丢掉，onload/onerror 可能永远不来，不清掉回调计数就卡死在这
  for (const job of thumbInflight) { job.img.onload = null; job.img.onerror = null; }
  thumbInflight.clear();
  thumbActive = 0;
  for (const img of thumbPending) if (thumbIO) thumbIO.unobserve(img);
  thumbPending.clear();
  thumbFired = 0;
}

async function loadList(cat, append) {
  const dev = onlineDevice();
  if (!dev || state.list.loading) return;
  state.list.loading = true;
  const rows = cat === 'doc';
  const grid = $('#list-grid');
  grid.className = rows ? 'rows' : 'grid';
  if (!append) {
    state.list = { cat, offset: 0, items: [], total: 0, loading: true, loadingAll: false, all: false, sort: '', query: '' };
    $('#sort-by').value = '';
    $('#search').value = '';
    state.selected.clear();
    resetThumbs();
    grid.innerHTML = '';
  }
  $('#list-title').textContent = CATS[cat] || cat;
  $('#list-total').textContent = '读取中…';
  updateTools();
  try {
    const r = await api('/api/cmd', { cmd: 'list', args: { cat, offset: state.list.offset, limit: rows ? 300 : 100 }, timeout: 30000 });
    if (!r.ok) throw new Error(r.error);
    state.list.items = append ? state.list.items.concat(r.data.items) : r.data.items;
    state.list.total = r.data.total;
    state.list.offset = state.list.items.length;
    // 一页页点「加载更多」点见底，和按「加载全部」是同一件事，排序/搜索的门槛要一起放开
    if (state.list.items.length >= state.list.total) state.list.all = true;
    if (rows) renderRows(sortDocs(state.list.items), grid);
    else {
      if (!append) grid.innerHTML = '';
      for (const item of r.data.items) grid.appendChild(tileEl(item));
    }
    $('#list-total').textContent = `共 ${state.list.total} 项`;
    if (append) applyFilter();
  } catch (e) {
    $('#list-total').textContent = '';
    toast('读取失败：' + e.message);
  }
  state.list.loading = false;
  updateTools();
  render();
}

const cmpName = (a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN', { numeric: true });
const SORTS = {
  'name-asc': cmpName,
  'name-desc': (a, b) => -cmpName(a, b),
  'time-desc': (a, b) => (b.mtime || 0) - (a.mtime || 0),
  'time-asc': (a, b) => (a.mtime || 0) - (b.mtime || 0),
  'size-desc': (a, b) => (b.size || 0) - (a.size || 0),
  'size-asc': (a, b) => (a.size || 0) - (b.size || 0),
};

function sortedItems() {
  const fn = SORTS[state.list.sort];
  return fn ? state.list.items.slice().sort(fn) : state.list.items;
}

function paintList() {
  const grid = $('#list-grid');
  grid.className = state.list.cat === 'doc' ? 'rows' : 'grid';
  resetThumbs();
  grid.innerHTML = '';
  if (state.list.cat === 'doc') {
    return renderRows(state.list.sort ? sortedItems() : sortDocs(state.list.items), grid);
  }
  for (const it of sortedItems()) grid.appendChild(tileEl(it));
}

/** 重排只移动已有节点：重建 DOM 会让每张缩略图重新去手机要一遍 */
function applySort() {
  if (state.list.cat === 'doc') return paintList();
  const grid = $('#list-grid');
  const nodes = new Map();
  for (const el of [...grid.children]) nodes.set(el.dataset.id, el);
  for (const it of sortedItems()) {
    const el = nodes.get(it.id);
    if (el) grid.appendChild(el);
  }
}

/** 过滤同样只切 display：一次重排/重建都把缩略图全数作废，几千条时手机端直接堵死 */
function applyFilter() {
  const l = state.list;
  const q = l.query;
  let shown = 0;
  for (const el of $('#list-grid').children) {
    const hit = !q || (el.dataset.name || '').toLowerCase().includes(q);
    el.style.display = hit ? '' : 'none';
    if (hit && el.dataset.name) shown++;
  }
  $('#list-total').textContent = q ? `搜到 ${shown} 项 / 共 ${l.total} 项` : `共 ${l.total} 项`;
}

function setQuery(raw) {
  state.list.query = raw.trim().toLowerCase();
  applyFilter();
}

function updateTools() {
  const l = state.list;
  const btn = $('#btn-loadall');
  $('#list-tools').classList.toggle('hidden', !l.cat);
  btn.disabled = !onlineDevice() || l.loading || l.loadingAll || l.all;
  btn.textContent = l.loadingAll ? `正在加载 ${l.items.length}/${l.total}…`
    : l.all ? `已加载全部 ${l.total} 项`
    : `点击加载全部${CATS[l.cat] || ''}以解锁排序和搜索`;
  $('#sort-by').disabled = !l.all || l.loadingAll;
  // 加载完了，括号里那句提醒就没意义了，留个光秃秃的「排序」
  $('#sort-by').options[0].textContent = l.all ? '排序' : '排序（需先加载全部）';
  $('#btn-more').style.display = !l.all && !l.loadingAll && l.offset < l.total ? '' : 'none';
  syncSearch();
}

/** 搜索和排序同一个门槛：没加载全就锁住，只筛已显示的那部分等于给假结果 */
function syncSearch() {
  const l = state.list;
  const inCat = !!onlineDevice() && state.view !== 'home';
  const el = $('#search');
  el.disabled = !(inCat && l.all);
  el.placeholder = l.all ? `在${CATS[l.cat] || ''}里搜文件名` : '加载全部后才能搜索';
  el.title = l.all ? '' : inCat
    ? '先把整类加载完（点「加载全部」，或一次点「加载更多」点到见底也行），否则搜出来的只是已显示的那部分'
    : '先进入一个分类再搜索';
}

const ALL_PAGE = 200;

async function loadAll() {
  const l = state.list;
  if (!onlineDevice() || l.loading || l.loadingAll || l.all) return;
  l.loadingAll = true;
  updateTools();
  let err = '';
  while (l.items.length < l.total) {
    let r;
    try {
      r = await api('/api/cmd', { cmd: 'list', args: { cat: l.cat, offset: l.items.length, limit: ALL_PAGE }, timeout: 30000 });
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      err = e.message;
      break;
    }
    // 等的时候人可能已经切去别的分类了，这一页结果直接作废
    if (state.list !== l) return;
    const got = r.data.items || [];
    if (!got.length) { err = '手机没有返回更多内容'; break; }
    l.items = l.items.concat(got);
    l.total = r.data.total;
    l.offset = l.items.length;
    if (l.cat === 'doc') renderRows(sortDocs(l.items), $('#list-grid'));
    else for (const it of got) $('#list-grid').appendChild(tileEl(it));
    if (l.sort && l.cat !== 'doc') applySort();
    applyFilter();
    updateTools();
    // 查列表是在手机唯一的 worker 线程里同步跑的，页与页之间让一下，缩略图才挤得进去
    await new Promise((res) => setTimeout(res, 150));
    if (state.list !== l) return;
  }
  l.loadingAll = false;
  l.all = !err;
  updateTools();
  if (err) toast('加载全部中断：' + err);
  else toast(l.query ? `已加载全部 ${l.total} 项，搜索覆盖整类` : `已加载全部 ${l.total} 项，可以排序了`);
}

function downloadSelected() {
  const ids = [...state.selected];
  if (!ids.length) return;
  toast(`开始下载 ${ids.length} 个文件，请留意浏览器下载栏`);
  ids.forEach((id, i) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = `/api/file?args=${encodeURIComponent(JSON.stringify({ id }))}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, i * 700);
  });
  state.selected.clear();
  render();
}

// fetch 报不出上传进度，这里只能用 XHR
function xhrSend(file, onProgress) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/send');
    x.setRequestHeader('X-HC-Name', encodeURIComponent(file.name));
    x.setRequestHeader('X-HC-Mime', file.type || 'application/octet-stream');
    x.setRequestHeader('X-HC-Size', String(file.size));
    x.upload.onprogress = (e) => onProgress(e.loaded, e.total || file.size);
    const done = (ok, error) => resolve({ ok, error });
    x.onload = () => {
      let r = {};
      try { r = JSON.parse(x.responseText); } catch {}
      done(!!r.ok, r.error || `HTTP ${x.status}`);
    };
    x.onerror = () => done(false, '网络中断');
    x.onabort = () => done(false, '已取消');
    x.send(file);
  });
}

async function sendFiles(files) {
  const dev = onlineDevice();
  if (!dev) return toast('手机未连接');
  if (state.sending) return toast('上一条还没发完');
  state.sending = true;
  $('#send-bar').classList.remove('hidden');
  let okCount = 0;
  const errs = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const label = `${i + 1}/${files.length} ${f.name}`;
    $('#send-text').textContent = `正在发送 ${label}`;
    $('#send-fill').style.width = '0%';
    const r = await xhrSend(f, (loaded, total) => {
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 100;
      $('#send-fill').style.width = pct + '%';
      $('#send-text').textContent = `正在发送 ${label} · ${pct}%`;
    });
    if (r.ok) okCount++;
    else errs.push(`${f.name}：${r.error}`);
  }
  $('#send-fill').style.width = '100%';
  $('#send-text').textContent = errs.length
    ? `发送完成 ${okCount}/${files.length}，失败 ${errs.length} 个`
    : `已发送 ${okCount} 个文件到 ${dev.model}`;
  if (errs.length) toast(errs[0]);
  setTimeout(() => {
    $('#send-bar').classList.add('hidden');
    $('#send-fill').style.width = '0%';
  }, errs.length ? 9000 : 3500);
  state.sending = false;
}

async function loadNet() {
  try {
    const n = await api('/api/net');
    $('#addr-list').innerHTML = n.ips.map((ip) => `<code>http://${ip}:${n.port}</code>`).join('');
  } catch {}
}

async function loadDiag() {
  try {
    const r = await api('/api/events');
    $('#diag-log').textContent = r.events
      .map((e) => `${new Date(e.t).toLocaleTimeString()}  ${e.type}  ${e.detail}`)
      .join('\n') || '（暂无事件）';
  } catch {}
}

document.querySelectorAll('.nav-item, .cat').forEach((b) => {
  b.addEventListener('click', () => {
    const v = b.dataset.view;
    if (!v || b.disabled) return;
    state.view = v;
    if (v === 'home') {
      render();
      loadRecent();
    } else loadList(v);
  });
});
$('#btn-refresh').onclick = () => {
  if (state.view === 'home') {
    refreshCounts();
    loadRecent(true);
  } else loadList(state.view);
  pollState();
  toast('已刷新');
};
$('#btn-save').onclick = downloadSelected;
$('#btn-send').onclick = () => { if (onlineDevice()) $('#pick').click(); };
$('#pick').onchange = (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) sendFiles(files);
};
$('#lb-close').onclick = closeView;
$('#lightbox').onclick = (e) => { if (e.target.id === 'lb-stage') closeView(); };
$('#lb-full').onclick = () => {
  if (!lb.item) return;
  lb.full = !lb.full;
  $('#lb-full').textContent = lb.full ? '返回高清预览' : '查看原图';
  setLbSrc(lb.full ? blobSrc('file', { id: lb.item.id }) : previewSrc(),
    lb.full ? '原图加载中…' : '高清预览加载中…');
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#lightbox').classList.contains('hidden')) closeView();
});
$('#btn-more').onclick = () => loadList(state.list.cat, true);
$('#btn-loadall').onclick = loadAll;
$('#sort-by').onchange = (e) => {
  state.list.sort = e.target.value;
  applySort();
  applyFilter();
  $('#view-list').scrollTop = 0;
};
let searchTimer = null;
$('#search').oninput = (e) => {
  const v = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { if ($('#search').value === v) setQuery(v); }, 180);
};
$('.search-clear').onclick = () => {
  $('#search').value = '';
  setQuery('');
  $('#search').focus();
};
$('#btn-disconnect').onclick = async () => {
  await api('/api/cmd', { cmd: 'disconnect', args: {}, timeout: 8000 }).catch(() => {});
  state.selected.clear();
  pollState();
};

loadNet();
pollState();
setInterval(pollState, 1500);

$('#btn-diag').onclick = () => {
  const panel = $('#diag');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) loadDiag();
};
$('#diag-close').onclick = () => $('#diag').classList.add('hidden');
