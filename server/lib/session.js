const crypto = require('crypto');
const { PassThrough } = require('stream');

const HEARTBEAT_TIMEOUT = 45000;
const OFFLINE_TIMEOUT = 120000;
const PUSH_PULL_TIMEOUT = 20000;
const PUSH_ACK_TIMEOUT = 600000;

class Device {
  constructor(info) {
    this.id = info.deviceId;
    this.model = info.model || '未知设备';
    this.brand = info.brand || '';
    this.android = info.android || '';
    this.appVersion = info.appVersion || '';
    this.token = crypto.randomBytes(16).toString('hex');
    this.lastSeen = Date.now();
    this.queue = [];
    this.waiters = [];
    this.results = new Map();
  }

  get online() {
    return Date.now() - this.lastSeen < HEARTBEAT_TIMEOUT;
  }

  touch() {
    this.lastSeen = Date.now();
  }
}

class Session {
  constructor() {
    this.devices = new Map();
    this.activeId = null;
    this.blobs = new Map();
    this.pushes = new Map();
    this.stateListeners = new Set();
    setInterval(() => this.reap(), 10000).unref();
  }

  onState(fn) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }

  emit() {
    const snap = this.snapshot();
    for (const fn of this.stateListeners) {
      try { fn(snap); } catch {}
    }
  }

  snapshot() {
    return {
      activeId: this.activeId,
      devices: [...this.devices.values()].map((d) => ({
        id: d.id,
        model: d.model,
        brand: d.brand,
        android: d.android,
        online: d.online,
        lastSeen: d.lastSeen,
      })),
    };
  }

  register(info) {
    let dev = this.devices.get(info.deviceId);
    if (!dev) {
      dev = new Device(info);
      this.devices.set(dev.id, dev);
    } else {
      dev.model = info.model || dev.model;
      dev.android = info.android || dev.android;
      dev.appVersion = info.appVersion || dev.appVersion;
      dev.touch();
    }
    if (!this.activeId || !this.devices.get(this.activeId)?.online) this.activeId = dev.id;
    this.emit();
    return dev;
  }

  byToken(token) {
    for (const d of this.devices.values()) if (d.token === token) return d;
    return null;
  }

  active() {
    return this.devices.get(this.activeId) || null;
  }

  reap() {
    let changed = false;
    for (const d of this.devices.values()) {
      if (!d.online && Date.now() - d.lastSeen > OFFLINE_TIMEOUT) {
        for (const w of d.waiters) { clearTimeout(w.timer); w.res({ cmd: 'noop' }); }
        d.waiters = [];
        for (const c of d.queue) this.failCommand(d, c.id, 'device offline');
        d.queue = [];
        for (const p of [...this.pushes.values()]) if (p.dev === d) this._dropPush(p, 'device offline');
        changed = true;
      }
    }
    if (changed) this.emit();
  }

  goodbye(dev) {
    dev.lastSeen = 0;
    for (const w of dev.waiters) { clearTimeout(w.timer); w.res({ cmd: 'noop' }); }
    dev.waiters = [];
    for (const c of dev.queue) this.failCommand(dev, c.id, 'device disconnected');
    dev.queue = [];
    for (const p of [...this.pushes.values()]) if (p.dev === dev) this._dropPush(p, 'device disconnected');
    for (const [id, p] of [...dev.results]) {
      dev.results.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error('device disconnected'));
    }
    this.emit();
  }

  // ---- command channel (server -> app via long poll) ----

  enqueue(dev, cmd, args) {
    const id = crypto.randomBytes(8).toString('hex');
    dev.queue.push({ id, cmd, args: args || {} });
    this.flush(dev);
    return id;
  }

  flush(dev) {
    while (dev.queue.length && dev.waiters.length) {
      const w = dev.waiters.shift();
      clearTimeout(w.timer);
      const c = dev.queue.shift();
      w.res(c);
    }
  }

  poll(dev, timeoutMs) {
    return new Promise((resolve) => {
      if (dev.queue.length) {
        resolve(dev.queue.shift());
        return;
      }
      const waiter = { res: resolve, timer: null };
      waiter.timer = setTimeout(() => {
        dev.waiters = dev.waiters.filter((w) => w !== waiter);
        resolve({ cmd: 'noop' });
      }, timeoutMs);
      dev.waiters.push(waiter);
    });
  }

  failCommand(dev, id, error) {
    const p = dev.results.get(id);
    if (p) {
      dev.results.delete(id);
      clearTimeout(p.timer);
      p.reject(new Error(error));
    }
    const b = this.blobs.get(id);
    if (b) {
      this.blobs.delete(id);
      clearTimeout(b.timer);
      b.reject(new Error(error));
    }
  }

  // JSON command: resolves with app-provided data
  requestJson(dev, cmd, args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.enqueue(dev, cmd, args);
      const timer = setTimeout(() => {
        dev.results.delete(id);
        reject(new Error('timeout waiting for ' + cmd));
      }, timeoutMs);
      dev.results.set(id, { resolve, reject, timer });
    });
  }

  resolveResult(dev, id, ok, data, error) {
    const p = dev.results.get(id);
    if (!p) return false;
    dev.results.delete(id);
    clearTimeout(p.timer);
    if (ok) p.resolve(data);
    else p.reject(new Error(error || 'command failed'));
    return true;
  }

  // Blob command: resolves with {meta, stream} once the app starts POSTing bytes
  requestBlob(dev, cmd, args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const id = this.enqueue(dev, cmd, args);
      const timer = setTimeout(() => {
        this.blobs.delete(id);
        reject(new Error('timeout waiting for blob ' + cmd));
      }, timeoutMs);
      this.blobs.set(id, { dev, resolve, reject, timer, stream: null });
    });
  }

  // called by the blob upload handler when the app starts streaming
  beginBlob(dev, id, meta) {
    const b = this.blobs.get(id);
    if (!b || b.dev !== dev) return null;
    clearTimeout(b.timer);
    this.blobs.delete(id);
    const stream = new PassThrough();
    b.resolve({ meta, stream });
    return stream;
  }

  cancelBlob(dev, id, error) {
    const b = this.blobs.get(id);
    if (!b) return false;
    this.blobs.delete(id);
    clearTimeout(b.timer);
    b.reject(new Error(error || 'transfer cancelled'));
    return true;
  }

  // ---- push channel (PC -> phone) ----
  // The browser POSTs bytes into /api/send; the phone GETs /api/getfile/:id.
  // A PassThrough meets them in the middle so nothing ever lands on the PC's disk.
  startPush(dev, meta) {
    const id = this.enqueue(dev, 'recv', { name: meta.name, mime: meta.mime, size: meta.size });
    const p = {
      dev, id, meta,
      stream: new PassThrough({ highWaterMark: 256 * 1024 }),
      pullResolve: null, pullReject: null, pullTimer: null,
    };
    // 中止时要 destroy(err) 让中转两端都收到错误，这里必须挂一个空监听，否则 Node 抛未处理 error 会把进程干掉
    p.stream.on('error', () => {});
    p.pulled = new Promise((resolve, reject) => {
      p.pullResolve = resolve;
      p.pullReject = reject;
      p.pullTimer = setTimeout(() => this._dropPush(p, '手机没有来取文件'), PUSH_PULL_TIMEOUT);
    });
    p.acked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        dev.results.delete(id);
        this._dropPush(p, '手机保存超时');
        reject(new Error('手机保存超时'));
      }, PUSH_ACK_TIMEOUT);
      dev.results.set(id, {
        resolve: (data) => { clearTimeout(timer); this.finishPush(p); resolve(data); },
        reject: (err) => { clearTimeout(timer); this._dropPush(p, err.message); reject(err); },
        timer,
      });
    });
    p.acked.catch(() => {});
    this.pushes.set(id, p);
    return p;
  }

  // called by the getfile handler when the phone comes to collect the bytes
  takePush(dev, id) {
    const p = this.pushes.get(id);
    if (!p || p.dev !== dev) return null;
    if (p.pullTimer) { clearTimeout(p.pullTimer); p.pullTimer = null; }
    const resolve = p.pullResolve;
    p.pullResolve = p.pullReject = null;
    if (resolve) resolve(p);
    return p;
  }

  finishPush(p) {
    if (!this.pushes.delete(p.id)) return;
    if (p.pullTimer) clearTimeout(p.pullTimer);
    p.pullResolve = p.pullReject = null;
  }

  _dropPush(p, error) {
    if (!this.pushes.delete(p.id)) return;
    if (p.pullTimer) { clearTimeout(p.pullTimer); p.pullTimer = null; }
    const reject = p.pullReject;
    p.pullResolve = p.pullReject = null;
    if (reject) reject(new Error(error));
    // 队列里还没被领走的 recv 一并作废，否则手机下次领命令会拿到一个已经不存在的推送
    this.failCommand(p.dev, p.id, error);
    p.stream.destroy(new Error(error));
  }
}

module.exports = { Session, HEARTBEAT_TIMEOUT };
