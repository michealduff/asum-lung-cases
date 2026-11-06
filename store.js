'use strict';
// Storage layer. Two interchangeable backends with the same methods:
//   LocalStore - browser only (localStorage + IndexedDB), used when config.js is blank
//   CloudStore - Supabase (database + private video bucket + secret share links)

const CASE_FIELDS = ['title', 'date', 'indication', 'patterns', 'patternOther', 'integration', 'zones', 'videos', 'removedVideos', 'imaging', 'createdAt', 'updatedAt', 'feedbackSeenAt'];
const SHARE_DAYS = 90; // how long supervisor video links last before Share needs tapping again

function blankCase(number) {
  return {
    number, title: '', date: new Date().toISOString().slice(0, 10), indication: '',
    patterns: [], patternOther: '', integration: '', zones: {}, videos: [], imaging: { notes: '', images: [] },
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
  const save = (c) => {
    onStatus('saving');
    clearTimeout(timers.get(c.id));
    timers.set(c.id, setTimeout(async () => {
      timers.delete(c.id);
      try { await saveNow(c); onStatus(timers.size ? 'saving' : 'saved'); }
      catch (e) {
        if (e.conflict) { onStatus(''); return; } // newer version loaded instead; app has told the user
        console.error(e); onStatus('error');
      }
    }, 600));
  };
  save.pending = () => timers.size > 0;
  save.cancel = (id) => { clearTimeout(timers.get(id)); timers.delete(id); };
  return save;
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
    const media = [...(c.videos || []), ...((c.imaging && c.imaging.images) || [])];
    await Promise.all(media.map((v) => this._idb('readwrite', (s) => s.delete(v.id)).catch(() => {})));
  }
  async addVideo(c, file, onProgress) {
    const id = `${c.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    await this._idb('readwrite', (s) => s.put(file, id));
    if (onProgress) onProgress(1);
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
  async addFeedback() { throw new Error('Feedback needs Supabase to be set up.'); }
}

// ---------------- Supabase ----------------
class CloudStore {
  constructor(cfg, onStatus, onConflict) {
    this.mode = 'cloud';
    this.cfg = cfg;
    this.sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    this.save = makeDebouncedSaver((c) => this._saveNow(c), onStatus);
    this.onConflict = onConflict || (() => {});
    this.cases = [];
    this._queue = Promise.resolve();
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
    return { ...blankCase(r.number), ...r.data, id: r.id, number: r.number, shareToken: r.share_token,
      sharedUntil: (r.data && r.data.sharedUntil) || null, _version: r.updated_at };
  }
  _toData(c) {
    const d = {};
    CASE_FIELDS.forEach((k) => { d[k] = c[k]; });
    d.sharedUntil = c.sharedUntil;
    return d;
  }
  async list() {
    const { data, error } = await this.sb.from('cases').select('id, number, data, share_token, updated_at').order('number', { ascending: false });
    if (error) throw error;
    this.cases = data.map((r) => this._fromRow(r));
    // Supervisor feedback (table may not exist yet if 002_feedback.sql hasn't been run).
    const fb = await this._feedbackQuery(this.sb, (q) => q);
    const byCase = {};
    (fb.data || []).forEach((f) => { (byCase[f.case_id] = byCase[f.case_id] || []).push(f); });
    this.cases.forEach((c) => { c.feedback = byCase[c.id] || []; });
    return this.cases;
  }
  async create() {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this.list();
      const c = blankCase(nextNumber(this.cases));
      const { data, error } = await this.sb.from('cases')
        .insert({ number: c.number, data: this._toData(c) }).select('id, number, data, share_token, updated_at').single();
      if (!error) { const nc = this._fromRow(data); this.cases.unshift(nc); return nc; }
      if (error.code !== '23505') throw error; // 23505 = case number already taken (another device); retry
    }
    throw new Error('Could not create a new case number');
  }
  // Every write checks the case hasn't been changed elsewhere since this copy was loaded
  // (its updated_at must still match). If it has, nothing is overwritten: the newer version
  // is fetched and handed to the app instead. Writes from this device run one at a time.
  _update(c, fields) {
    const run = async () => {
      let q = this.sb.from('cases').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', c.id);
      if (c._version) q = q.eq('updated_at', c._version);
      const { data, error } = await q.select('updated_at');
      if (error) throw error;
      if (!data.length) {
        this.save.cancel(c.id);
        const latest = await this.fetchCase(c.id);
        this.onConflict(latest, c);
        const err = new Error('This case was changed on another device — showing the latest version');
        err.conflict = true;
        throw err;
      }
      c._version = data[0].updated_at;
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }
  async fetchCase(id) {
    const { data, error } = await this.sb.from('cases').select('id, number, data, share_token, updated_at').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const c = this._fromRow(data);
    const fb = await this._feedbackQuery(this.sb, (q) => q.eq('case_id', id));
    c.feedback = fb.data || [];
    const i = this.cases.findIndex((x) => x.id === id);
    if (i !== -1) this.cases[i] = c;
    return c;
  }
  hasPendingSaves() { return this.save.pending(); }
  // Feedback rows, including the supervisor's Yes/No answers if 004_feedback_ticks.sql has been run.
  async _feedbackQuery(client, filter) {
    const cols = 'id, case_id, author, body, created_at';
    let res = await filter(client.from('feedback').select(`${cols}, adequate_images, correct_interpretation`)).order('created_at');
    if (res.error && /adequate_images|correct_interpretation|column/i.test(res.error.message || '')) {
      res = await filter(client.from('feedback').select(cols)).order('created_at');
    }
    return res;
  }
  async _saveNow(c) { await this._update(c, { data: this._toData(c) }); }
  async remove(c) {
    const paths = [...(c.videos || []), ...((c.imaging && c.imaging.images) || [])].map((v) => v.id);
    if (paths.length) await this.sb.storage.from('videos').remove(paths);
    const { error } = await this.sb.from('cases').delete().eq('id', c.id);
    if (error) throw error;
  }
  async addVideo(c, file, onProgress) {
    const ext = (file.name.split('.').pop() || 'mov').toLowerCase().replace(/[^a-z0-9]/g, '');
    const path = `${this.user.id}/${c.id}/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    await this._uploadWithProgress(path, file, onProgress);
    const meta = { id: path, name: file.name, size: file.size, type: file.type, label: '' };
    return meta;
  }
  // Same as storage.upload(), but via XMLHttpRequest so upload progress can be shown.
  async _uploadWithProgress(path, file, onProgress) {
    const { data } = await this.sb.auth.getSession();
    const token = data.session && data.session.access_token;
    if (!token) throw new Error('Please sign in again');
    const url = `${this.cfg.supabaseUrl}/storage/v1/object/videos/${path.split('/').map(encodeURIComponent).join('/')}`;
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('apikey', this.cfg.supabaseAnonKey);
      xhr.setRequestHeader('Content-Type', file.type || 'video/mp4');
      xhr.setRequestHeader('x-upsert', 'false');
      xhr.setRequestHeader('cache-control', '3600');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) return resolve();
        let msg = `upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText).message || msg; } catch { /* keep default */ }
        reject(new Error(msg));
      };
      xhr.onerror = () => reject(new Error('network error — check your connection'));
      xhr.send(file);
    });
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
    const paths = [...(c.videos || []), ...((c.imaging && c.imaging.images) || [])].map((v) => v.id);
    if (!paths.length) return [];
    const { data, error } = await this.sb.storage.from('videos').createSignedUrls(paths, SHARE_DAYS * 86400);
    if (error) throw error;
    return data.map((d) => ({ id: d.path, url: d.signedUrl }));
  }

  async refreshShare(c) {
    if (!c.shareToken) return;
    c.sharedUntil = Date.now() + SHARE_DAYS * 86400 * 1000;
    const shared = await this._signAll(c);
    await this._update(c, { share_token: c.shareToken, shared_videos: shared, data: this._toData(c) });
  }
  async share(c) {
    c.shareToken = c.shareToken || randomToken();
    await this.refreshShare(c);
    return `${location.origin}${location.pathname}#s/${c.shareToken}`;
  }
  async unshare(c) {
    c.shareToken = null; c.sharedUntil = null;
    await this._update(c, { share_token: null, shared_videos: [], data: this._toData(c) });
  }
  async getShared(token) {
    const { data, error } = await this.sb.rpc('get_shared_case', { token });
    if (error) throw error;
    const r = data && data[0];
    if (!r) return null;
    const urls = Object.fromEntries((r.shared_videos || []).map((v) => [v.id, v.url]));
    const c = { ...blankCase(r.number), ...r.data, number: r.number };
    c.videos = (c.videos || []).map((v) => ({ ...v, sharedUrl: urls[v.id] || '' }));
    c.imaging = c.imaging || { notes: '', images: [] };
    c.imaging.images = (c.imaging.images || []).map((v) => ({ ...v, sharedUrl: urls[v.id] || '' }));
    // A separate, never-signed-in client that sends the share code with each request;
    // the database rules then allow access to this one case's feedback only.
    const sc = this._shareClient(token);
    const idRes = await sc.from('cases').select('id').eq('share_token', token).maybeSingle();
    const fb = await this._feedbackQuery(sc, (q) => q);
    c._caseId = idRes.data && idRes.data.id;
    c.feedback = fb.data || [];
    c.feedbackEnabled = !!c._caseId && !fb.error;
    return c;
  }
  _shareClient(token) {
    if (!this._sc || this._scToken !== token) {
      this._sc = window.supabase.createClient(this.cfg.supabaseUrl, this.cfg.supabaseAnonKey, {
        global: { headers: { 'x-share-token': token } },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'asum-share' },
      });
      this._scToken = token;
    }
    return this._sc;
  }
  async addFeedback(token, caseId, author, body, ticks = {}) {
    const row = { case_id: caseId, author: author || null, body };
    if (ticks.adequate_images != null) row.adequate_images = ticks.adequate_images;
    if (ticks.correct_interpretation != null) row.correct_interpretation = ticks.correct_interpretation;
    let { data, error } = await this._shareClient(token).from('feedback').insert(row).select('*').single();
    if (error && /adequate_images|correct_interpretation/.test(error.message || '')) {
      // Yes/No columns not added yet (004_feedback_ticks.sql) — still send the comment.
      delete row.adequate_images; delete row.correct_interpretation;
      ({ data, error } = await this._shareClient(token).from('feedback').insert(row).select('*').single());
    }
    if (error) throw new Error(error.code === '42501' ? 'Could not send — this link may have been turned off' : error.message);
    return data;
  }
}

function createStore(onStatus, onConflict) {
  const cfg = window.ASUM_CONFIG || {};
  if (cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase) return new CloudStore(cfg, onStatus, onConflict);
  return new LocalStore(onStatus);
}
