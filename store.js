'use strict';
// Storage layer. Two interchangeable backends with the same methods:
//   LocalStore - browser only (localStorage + IndexedDB), used when config.js is blank
//   CloudStore - Supabase (database + private video bucket + secret share links)

const CASE_FIELDS = ['title', 'date', 'indication', 'patterns', 'patternOther', 'integration', 'zones', 'videos', 'createdAt', 'updatedAt'];
const SHARE_DAYS = 90; // how long supervisor video links last before Share needs tapping again

function blankCase(number) {
  return {
    number, title: '', date: new Date().toISOString().slice(0, 10), indication: '',
    patterns: [], patternOther: '', integration: '', zones: {}, videos: [],
    createdAt: Date.now(), updatedAt: Date.now(), shareToken: null, sharedUntil: null,
  };
}
const nextNumber = (cases) => cases.reduce((m, c) => Math.max(m, c.number || 0), 0) + 1;
const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
function randomToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

// Debounce saves per case so typing doesn't hammer storage.
function makeDebouncedSaver(saveNow, onStatus) {
  const timers = new Map();
  return (c) => {
    onStatus('saving');
    clearTimeout(timers.get(c.id));
    timers.set(c.id, setTimeout(async () => {
      timers.delete(c.id);
      try { await saveNow(c); onStatus(timers.size ? 'saving' : 'saved'); }
      catch (e) { console.error(e); onStatus('error'); }
    }, 600));
  };
}

// ---------------- Local ----------------
class LocalStore {
  constructor(onStatus) {
    this.mode = 'local';
    this.KEY = 'asumLungCases.v1';
    this.save = makeDebouncedSaver(async () => this._persist(), onStatus);
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open('asumLungCasesVideos', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('videos');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async _idb(mode, fn) {
    const db = await this.db;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('videos', mode);
      const r = fn(tx.objectStore('videos'));
      tx.oncomplete = () => resolve(r && r.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  _persist() { localStorage.setItem(this.KEY, JSON.stringify(this.cases)); }
  async init() { return { needsLogin: false }; }
  async list() {
    try { this.cases = JSON.parse(localStorage.getItem(this.KEY)) || []; } catch { this.cases = []; }
    return this.cases;
  }
  async create() {
    const c = { ...blankCase(nextNumber(this.cases)), id: randomId() };
    this.cases.unshift(c);
    this._persist();
    return c;
  }
  async remove(c) {
    this.cases = this.cases.filter((x) => x.id !== c.id);
    this._persist();
    await Promise.all((c.videos || []).map((v) => this._idb('readwrite', (s) => s.delete(v.id)).catch(() => {})));
  }
  async addVideo(c, file) {
    const id = `${c.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    await this._idb('readwrite', (s) => s.put(file, id));
    return { id, name: file.name, size: file.size, type: file.type, label: '' };
  }
  async removeVideo(c, meta) { await this._idb('readwrite', (s) => s.delete(meta.id)); }
  async videoSrc(meta) {
    const blob = await this._idb('readonly', (s) => s.get(meta.id));
    return blob ? URL.createObjectURL(blob) : '';
  }
  async share() { throw new Error('Sharing needs Supabase to be set up (see README).'); }
  async refreshShare() {}
  async getShared() { return null; }
}

// ---------------- Supabase ----------------
class CloudStore {
  constructor(cfg, onStatus) {
    this.mode = 'cloud';
    this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    this.save = makeDebouncedSaver((c) => this._saveNow(c), onStatus);
    this.cases = [];
  }
  async init() {
    const { data } = await this.sb.auth.getSession();
    this.user = data.session && data.session.user;
    return { needsLogin: !this.user, email: this.user && this.user.email };
  }
  async signIn(email, password) {
    const { data, error } = await this.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    this.user = data.user;
  }
  async signOut() { await this.sb.auth.signOut(); this.user = null; }

  _fromRow(r) {
    return { ...blankCase(r.number), ...r.data, id: r.id, number: r.number, shareToken: r.share_token, sharedUntil: (r.data && r.data.sharedUntil) || null };
  }
  _toData(c) {
    const d = {};
    CASE_FIELDS.forEach((k) => { d[k] = c[k]; });
    d.sharedUntil = c.sharedUntil;
    return d;
  }
  async list() {
    const { data, error } = await this.sb.from('cases').select('id, number, data, share_token').order('number', { ascending: false });
    if (error) throw error;
    this.cases = data.map((r) => this._fromRow(r));
    return this.cases;
  }
  async create() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.list();
      const c = blankCase(nextNumber(this.cases));
      const { data, error } = await this.sb.from('cases')
        .insert({ number: c.number, data: this._toData(c) }).select('id, number, data, share_token').single();
      if (!error) { const nc = this._fromRow(data); this.cases.unshift(nc); return nc; }
      if (error.code !== '23505') throw error; // 23505 = case number already taken (another device); retry
    }
    throw new Error('Could not create a new case number');
  }
  async _saveNow(c) {
    const { error } = await this.sb.from('cases')
      .update({ data: this._toData(c), updated_at: new Date().toISOString() }).eq('id', c.id);
    if (error) throw error;
  }
  async remove(c) {
    const paths = (c.videos || []).map((v) => v.id);
    if (paths.length) await this.sb.storage.from('videos').remove(paths);
    const { error } = await this.sb.from('cases').delete().eq('id', c.id);
    if (error) throw error;
  }
  async addVideo(c, file) {
    const ext = (file.name.split('.').pop() || 'mov').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${this.user.id}/${c.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await this.sb.storage.from('videos').upload(path, file, { contentType: file.type || 'video/quicktime' });
    if (error) throw error;
    const meta = { id: path, name: file.name, size: file.size, type: file.type, label: '' };
    return meta;
  }
  async removeVideo(c, meta) {
    const { error } = await this.sb.storage.from('videos').remove([meta.id]);
    if (error) throw error;
  }
  async videoSrc(meta) {
    const { data, error } = await this.sb.storage.from('videos').createSignedUrl(meta.id, 3600);
    if (error) throw error;
    return data.signedUrl;
  }
  // Signed links let the supervisor play private videos without logging in.
  async _signAll(c) {
    const paths = (c.videos || []).map((v) => v.id);
    if (!paths.length) return [];
    const { data, error } = await this.sb.storage.from('videos').createSignedUrls(paths, SHARE_DAYS * 86400);
    if (error) throw error;
    return data.map((d) => ({ id: d.path, url: d.signedUrl }));
  }
  async refreshShare(c) {
    if (!c.shareToken) return;
    c.sharedUntil = Date.now() + SHARE_DAYS * 86400 * 1000;
    const shared = await this._signAll(c);
    const { error } = await this.sb.from('cases')
      .update({ share_token: c.shareToken, shared_videos: shared, data: this._toData(c) }).eq('id', c.id);
    if (error) throw error;
  }
  async share(c) {
    c.shareToken = c.shareToken || randomToken();
    await this.refreshShare(c);
    return `${location.origin}${location.pathname}#s/${c.shareToken}`;
  }
  async unshare(c) {
    c.shareToken = null; c.sharedUntil = null;
    const { error } = await this.sb.from('cases').update({ share_token: null, shared_videos: [], data: this._toData(c) }).eq('id', c.id);
    if (error) throw error;
  }
  async getShared(token) {
    const { data, error } = await this.sb.rpc('get_shared_case', { token });
    if (error) throw error;
    const r = data && data[0];
    if (!r) return null;
    const urls = Object.fromEntries((r.shared_videos || []).map((v) => [v.id, v.url]));
    const c = { ...blankCase(r.number), ...r.data, number: r.number };
    c.videos = (c.videos || []).map((v) => ({ ...v, sharedUrl: urls[v.id] || '' }));
    return c;
  }
}

function createStore(onStatus) {
  const cfg = window.ASUM_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) return new CloudStore(cfg, onStatus);
  return new LocalStore(onStatus);
}
