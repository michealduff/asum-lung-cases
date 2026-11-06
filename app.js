'use strict';
// UI: case list, case editor, read-only views, login. Template logic is in template.js,
// storage (local or Supabase) in store.js.

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  Object.entries(attrs).forEach(([k, v]) => {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  });
  children.flat().forEach((ch) => n.append(ch));
  return n;
}
let toastTimer;
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const objectUrls = [];
function revokeUrls() { while (objectUrls.length) { const u = objectUrls.pop(); if (u.startsWith('blob:')) URL.revokeObjectURL(u); } }
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}

function setSaveStatus(s) {
  const map = { saving: 'Saving…', saved: 'Saved', error: 'Not saved — check connection' };
  const n = $('saveStatus');
  n.textContent = map[s] || '';
  n.className = `save-status ${s}`;
}

const store = createStore(setSaveStatus, onConflict);
let cases = [];
let current = null;

async function videoEl(meta) {
  const v = el('video', { controls: '', playsinline: '', preload: 'metadata' });
  try {
    const src = meta.sharedUrl || await store.videoSrc(meta);
    if (src) { objectUrls.push(src); v.src = src; }
  } catch (e) { console.error(e); }
  return v;
}

// ---------- Keeping copies in step across devices ----------
function putCase(c) {
  [cases, store.cases].forEach((arr) => {
    if (!arr) return;
    const i = arr.findIndex((x) => x.id === c.id);
    if (i !== -1) arr[i] = c;
  });
}
function dropCase(id) {
  cases = cases.filter((x) => x.id !== id);
  if (store.cases) store.cases = store.cases.filter((x) => x.id !== id);
}
function reopenKeepingPlace(id) {
  const y = window.scrollY;
  openCase(id);
  window.scrollTo(0, y);
}
// Called by the store when a save was refused because the case changed elsewhere.
function onConflict(latest, stale) {
  if (!latest) {
    dropCase(stale.id);
    if (current && current.id === stale.id) { toast('This case was deleted on another device', 5000); location.hash = ''; }
    return;
  }
  putCase(latest);
  if (current && current.id === stale.id) reopenKeepingPlace(latest.id);
  toast('This case was changed on another device — now showing the latest version. Please re-check your last change.', 6000);
}
// When the app comes back to the screen (switching tabs/apps, unlocking the phone),
// pick up any changes and new feedback from other devices before editing continues.
async function refreshFromServer() {
  if (store.mode !== 'cloud' || !store.user || !started || location.hash.startsWith('#s/') || store.hasPendingSaves()) return;
  try {
    if (current) {
      const latest = await store.fetchCase(current.id);
      if (!latest) { dropCase(current.id); toast('This case was deleted on another device', 5000); location.hash = ''; return; }
      if (latest._version !== current._version) {
        putCase(latest);
        reopenKeepingPlace(latest.id);
        toast('Updated with changes made on another device', 4000);
      } else {
        current.feedback = latest.feedback;
        putCase(current);
        renderOwnerFeedback();
      }
    } else {
      cases = await store.list();
      if (!$('listView').hidden) showList();
    }
  } catch (e) { console.error(e); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshFromServer(); });

// ---------- Routing ----------
//  #            case list           #new         create a case
//  #case/<id>   edit a case         #view/<id>   preview what the supervisor sees
//  #s/<token>   supervisor link (no login)
const VIEWS = ['loginView', 'listView', 'editView', 'viewView'];
function showOnly(viewId, { back = true } = {}) {
  resetDock();
  VIEWS.forEach((v) => { $(v).hidden = v !== viewId; });
  $('backBtn').hidden = !back;
  revokeUrls();
  window.scrollTo(0, 0);
}

let routing = Promise.resolve();
function route() { routing = routing.then(doRoute).catch((e) => { console.error(e); toast(e.message || 'Something went wrong'); }); }
async function doRoute() {
  const [kind, id] = location.hash.replace(/^#/, '').split('/');
  if (kind === 's') return showShared(id);
  await ensureStarted();

  $('accountBtn').hidden = store.mode !== 'cloud' || !store.user;
  if (store.mode === 'cloud' && !store.user) return showOnly('loginView', { back: false });

  if (kind === 'new') {
    const c = await store.create();
    cases = store.cases;
    history.replaceState(null, '', `#case/${c.id}`);
    return openCase(c.id);
  }
  const found = id && cases.find((c) => c.id === id);
  if (kind === 'case' && found) return openCase(id);
  if (kind === 'view' && found) return showView(found, false);
  return showList();
}
window.addEventListener('hashchange', route);

// ---------- Login ----------
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('loginBtn');
  btn.disabled = true; $('loginError').textContent = '';
  try {
    await store.signIn($('loginEmail').value.trim(), $('loginPassword').value);
    $('loginPassword').value = '';
    cases = await store.list();
    route();
  } catch (err) {
    $('loginError').textContent = err.message || 'Could not sign in';
  } finally { btn.disabled = false; }
});
$('accountBtn').addEventListener('click', async () => {
  if (!confirm(`Signed in as ${store.user && store.user.email}. Sign out?`)) return;
  await store.signOut();
  cases = []; location.hash = ''; route();
});

// ---------- List ----------
function showList() {
  current = null;
  showOnly('listView', { back: false });
  $('localNote').hidden = store.mode !== 'local';
  renderStorageMeter();
  const list = $('caseList');
  list.innerHTML = '';
  const sorted = [...cases].sort((a, b) => b.number - a.number);
  if (!sorted.length) {
    list.append(el('li', { class: 'empty-state' }, 'No cases yet. Tap “New case” to start.'));
    return;
  }
  sorted.forEach((c) => {
    const pats = [...(c.patterns || []), c.patternOther].filter(Boolean).join(', ') || 'No interpretation yet';
    const first = (c.indication || '').split('\n').find((l) => l.trim());
    list.append(el('li', { onclick: () => { location.hash = `case/${c.id}`; } },
      el('span', { class: 'case-num' }, `#${c.number}`),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, c.title || first || 'Untitled case'),
        el('div', { class: 'meta' }, pats)),
      el('div', { class: 'meta right' },
        c.date ? formatDate(c.date) : '',
        c.shareToken ? el('div', { class: 'shared-tag' }, 'Shared') : '',
        (c.feedback || []).length ? el('div', { class: `fb-tag${unseenFeedback(c) ? ' new' : ''}` },
          unseenFeedback(c) ? `💬 ${unseenFeedback(c)} new` : `💬 ${c.feedback.length}`) : '')));
  });
}

const STORAGE_LIMIT = 1024 * 1048576; // Supabase free plan
function renderStorageMeter() {
  const box = $('storageMeter');
  if (store.mode !== 'cloud') { box.hidden = true; return; }
  const used = cases.reduce((sum, c) => sum + (c.videos || []).reduce((a, v) => a + (v.size || 0), 0), 0);
  const frac = Math.min(1, used / STORAGE_LIMIT);
  box.hidden = false;
  box.className = `storage${frac > 0.8 ? ' warn' : ''}`;
  box.replaceChildren(
    el('div', { class: 'storage-text' }, `Video storage: ${used < 1048576 * 1024 ? `${Math.round(used / 1048576)} MB` : `${(used / 1073741824).toFixed(2)} GB`} of 1 GB used`,
      frac > 0.8 ? ' — getting full; delete old clips or upgrade Supabase' : ''),
    el('div', { class: 'storage-bar' }, el('div', { style: `width:${Math.max(1, Math.round(frac * 100))}%` })));
}

// ---------- Editor ----------
function touch() {
  current.updatedAt = Date.now();
  store.save(current);
  refreshDerived();
}

function openCase(id) {
  current = cases.find((c) => c.id === id);
  ZONE_ORDER.forEach((z) => { current.zones[z] = current.zones[z] || { notes: '' }; });
  current.videos = current.videos || [];
  current.patterns = current.patterns || [];
  showOnly('editView');
  $('caseHeading').textContent = `Case #${current.number}`;
  $('f-title').value = current.title || '';
  $('f-date').value = current.date || '';
  $('f-indication').value = current.indication || '';
  $('f-patternOther').value = current.patternOther || '';
  $('f-integration').value = current.integration || '';
  renderShare();
  renderOwnerFeedback();
  renderVideos();
  renderZoneCards();
  renderPatternChips();
  refreshDerived();
}

function renderShare() {
  const box = $('shareBox');
  box.innerHTML = '';
  if (store.mode === 'local') {
    box.append(el('p', { class: 'hint' }, 'Sharing links will work once the app is connected to Supabase.'));
    return;
  }
  if (!current.shareToken) {
    box.append(el('p', { class: 'hint' }, 'Creates a private link your supervisor can open in any browser. No app or login needed.'),
      el('button', { type: 'button', class: 'primary', onclick: doShare }, 'Create share link'));
    return;
  }
  const link = `${location.origin}${location.pathname}#s/${current.shareToken}`;
  const until = current.sharedUntil ? new Date(current.sharedUntil).toLocaleDateString() : '';
  box.append(
    el('input', { value: link, readonly: '', onclick: (e) => e.target.select() }),
    el('div', { class: 'share-actions' },
      el('button', { type: 'button', class: 'primary', onclick: async () => { toast(await copyText(link) ? 'Link copied — paste it into a message' : 'Copy failed'); } }, 'Copy link'),
      navigator.share ? el('button', { type: 'button', onclick: () => navigator.share({ title: `Lung US case #${current.number}`, url: link }).catch(() => {}) }, 'Send…') : '',
      el('button', { type: 'button', class: 'ghost danger', onclick: async () => {
        if (!confirm('Stop sharing? The current link will stop working.')) return;
        await store.unshare(current); renderShare(); toast('Link turned off');
      } }, 'Stop sharing')),
    el('p', { class: 'hint' }, `Videos in the link play until ${until}. Tap “Create share link” again after that to renew.`));
}

async function doShare() {
  try {
    const link = await store.share(current);
    renderShare();
    toast(await copyText(link) ? 'Link created and copied' : 'Link created');
  } catch (e) { toast(e.message || 'Could not create link'); }
}

async function renderVideos() {
  const host = $('videoList');
  host.innerHTML = '';
  for (const meta of current.videos) {
    const label = el('input', { placeholder: 'Label, e.g. R4 or R-PLAPS' });
    label.value = meta.label || '';
    label.addEventListener('input', () => { meta.label = label.value; touch(); });
    host.append(el('div', { class: 'video-item' },
      await videoEl(meta),
      el('div', { class: 'row' }, label,
        el('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm('Remove this video?')) return;
          try {
            await store.removeVideo(current, meta);
            current.videos = current.videos.filter((v) => v.id !== meta.id);
            touch();
            await store.refreshShare(current);
            renderVideos();
          } catch (e) { toast(e.message || 'Could not remove video'); }
        } }, 'Remove')),
      el('div', { class: 'meta' }, `${meta.name} · ${mb(meta.size)}`)));
  }
}

function setProgress(label, frac) {
  const box = $('uploadProgress');
  box.hidden = frac == null;
  if (frac == null) return;
  box.querySelector('.bar').style.width = `${Math.round(frac * 100)}%`;
  box.querySelector('span').textContent = `${label} ${Math.round(frac * 100)}%`;
}

let uploading = false;
$('videoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length || uploading) return;
  uploading = true;
  const caseRef = current;
  const lock = await keepAwake();
  const status = $('uploadStatus');
  status.textContent = 'Keep this screen open until the upload finishes.';
  for (const [i, f] of files.entries()) {
    const of = files.length > 1 ? ` (${i + 1} of ${files.length})` : '';
    let toUpload = f;
    try {
      setProgress(`Shrinking clip${of}…`, 0);
      toUpload = await shrinkVideo(f, (p) => setProgress(`Shrinking clip${of}…`, p));
    } catch (err) {
      console.error(err);
      if (f.size > MAX_UPLOAD_BYTES) {
        setProgress(null);
        toast(`Couldn't shrink ${f.name} on this device, and it's ${mb(f.size)} (limit 50 MB). Try trimming it in Photos.`, 7000);
        continue;
      }
      toast('Couldn’t shrink this clip — uploading the original instead', 4000);
    }
    if (toUpload.size > MAX_UPLOAD_BYTES) {
      setProgress(null);
      toast(`${f.name} is still ${mb(toUpload.size)} after shrinking (limit 50 MB). Try trimming it in Photos.`, 7000);
      continue;
    }
    try {
      setProgress(`Uploading${of}…`, 0);
      const meta = await store.addVideo(caseRef, toUpload, (p) => setProgress(`Uploading${of}…`, p));
      meta.name = f.name;
      meta.originalSize = f.size;
      caseRef.videos.push(meta);
      if (current === caseRef) touch(); else store.save(caseRef);
    } catch (err) { toast(`Could not upload ${f.name}: ${err.message || err}`, 6000); }
  }
  setProgress(null);
  status.textContent = '';
  try { await store.refreshShare(caseRef); } catch (err) { console.error(err); }
  if (lock) lock.release().catch(() => {});
  uploading = false;
  if (current === caseRef) renderVideos();
});

function chipGroup(field, getVal, setVal) {
  const wrap = el('div', { class: 'chips' });
  const draw = () => {
    wrap.innerHTML = '';
    const val = getVal();
    field.options.forEach((opt) => {
      const on = field.type === 'multi' ? (val || []).includes(opt) : val === opt;
      wrap.append(el('button', {
        type: 'button', class: `chip${on ? ' on' : ''}`,
        onclick: () => {
          if (field.type === 'multi') {
            const s = new Set(getVal() || []);
            s.has(opt) ? s.delete(opt) : s.add(opt);
            setVal([...s]);
          } else setVal(getVal() === opt ? '' : opt);
          draw();
        },
      }, opt));
    });
  };
  draw();
  wrap.redraw = draw;
  return wrap;
}

const NORMAL_LUNG = { pleura: 'Thin, smooth', sliding: 'Present', subpleural: 'None', subExtra: [], artefact: 'A-lines' };
const NORMAL_PLAPS = { effusion: 'None', curtain: 'Present', appearance: '', plapsExtra: [] };

function renderZoneCards() {
  const host = $('zoneCards');
  host.innerHTML = '';
  ZONE_ORDER.forEach((zone) => {
    const groups = [];
    const body = fieldsFor(zone).map((f) => {
      const g = chipGroup(f, () => current.zones[zone][f.key], (v) => { current.zones[zone][f.key] = v; touch(); });
      groups.push(g);
      return el('div', { class: 'field' }, el('div', { class: 'field-label' }, f.label), g);
    });
    const notes = el('input', { placeholder: 'Other findings / notes' });
    notes.value = current.zones[zone].notes || '';
    notes.addEventListener('input', () => { current.zones[zone].notes = notes.value; touch(); });
    const setAll = (vals) => { Object.assign(current.zones[zone], structuredClone(vals)); groups.forEach((g) => g.redraw()); touch(); };
    const normal = PLAPS_ZONES.includes(zone) ? NORMAL_PLAPS : NORMAL_LUNG;
    const clear = { ...Object.fromEntries(fieldsFor(zone).map((f) => [f.key, f.type === 'multi' ? [] : ''])), notes: '' };

    host.append(el('div', { class: 'card zone-card', id: `zone-${zone}` },
      el('div', { class: 'zone-head' },
        el('h2', {}, zone),
        el('button', { type: 'button', onclick: () => setAll(normal) }, 'Normal'),
        el('button', { type: 'button', class: 'ghost', onclick: () => { notes.value = ''; setAll(clear); } }, 'Clear')),
      ...body, notes));
  });
}

function renderZoneMap() {
  const map = $('zoneMap');
  map.innerHTML = '';
  [['Right', ['R1', 'R2', 'R3', 'R4', 'R-PLAPS']], ['Left', ['L1', 'L2', 'L3', 'L4', 'L-PLAPS']]].forEach(([side, zones]) => {
    map.append(el('div', { class: 'zone-side' },
      el('h4', {}, side),
      el('div', { class: 'zone-grid' }, zones.map((z) => el('button', {
        type: 'button',
        class: `zone-btn s-${zoneStatus(z, current.zones[z])}${z.includes('PLAPS') ? ' plaps' : ''}`,
        onclick: () => $(`zone-${z}`).scrollIntoView({ behavior: 'smooth', block: 'start' }),
      }, z)))));
  });
}

function renderPatternChips() {
  const g = chipGroup({ options: PATTERNS, type: 'multi' }, () => current.patterns, (v) => { current.patterns = v; touch(); });
  g.id = 'patternChips';
  $('patternChips').replaceWith(g);
}

function refreshDerived() {
  if (!current) return;
  renderZoneMap();
  $('reportText').textContent = buildReport(current);
  const sugg = suggestPatterns(current).filter((p) => !current.patterns.includes(p));
  const box = $('suggestion');
  box.innerHTML = '';
  box.hidden = !sugg.length;
  if (sugg.length) {
    box.append(el('span', {}, 'Suggested from findings:'));
    sugg.forEach((p) => box.append(el('button', { type: 'button', onclick: () => {
      current.patterns = [...current.patterns, p];
      touch();
      renderPatternChips();
    } }, `+ ${p}`)));
  }
}

[['f-title', 'title'], ['f-date', 'date'], ['f-indication', 'indication'],
  ['f-patternOther', 'patternOther'], ['f-integration', 'integration']].forEach(([id, key]) => {
  $(id).addEventListener('input', (e) => { current[key] = e.target.value; touch(); });
});

// ---------- Read-only views ----------
// ---------- Mini player ----------
// While a clip is playing and its place on the page has scrolled out of view, the clip is
// pinned to the top of the screen so the zone descriptions can be read while it plays.
// (CSS position:fixed on the same <video>, so playback never restarts.)
let docked = null;
let clipObservers = [];
const topbarH = () => document.querySelector('.topbar').offsetHeight;

function dock(fig) {
  if (docked === fig) return;
  undock();
  fig.style.minHeight = `${fig.offsetHeight}px`; // keep its space in the page
  fig.style.setProperty('--dock-top', `${topbarH() + 6}px`);
  fig.classList.add('docked');
  docked = fig;
  requestAnimationFrame(() => {
    document.documentElement.style.setProperty('--dock-h', `${fig.querySelector('.vwrap').offsetHeight + 12}px`);
  });
}
function undock() {
  if (!docked) return;
  docked.classList.remove('docked');
  docked.style.minHeight = '';
  docked = null;
  document.documentElement.style.removeProperty('--dock-h');
}
function resetDock() {
  undock();
  clipObservers.forEach((o) => o.disconnect());
  clipObservers = [];
}
// Pin only once the clip has scrolled up past the top of the screen (reading below it).
// Scrolling back up above it returns it to its normal place.
const scrolledPast = (fig) => {
  const r = fig.getBoundingClientRect();
  return r.top + r.height * 0.5 < topbarH();
};
function watchClip(fig, video) {
  video.addEventListener('play', () => {
    document.querySelectorAll('.rp-video video').forEach((v) => { if (v !== video) v.pause(); });
    if (scrolledPast(fig)) dock(fig);
  });
  const io = new IntersectionObserver(() => {
    if (docked === fig && !scrolledPast(fig)) undock();
    else if (docked !== fig && !video.paused && scrolledPast(fig)) dock(fig);
  }, { threshold: [0, 0.25, 0.5, 0.75, 1] });
  io.observe(fig);
  clipObservers.push(io);
}
// "▶ clip" on a zone: play that clip in the mini player without leaving the zone.
function playClipHere(zone) {
  const fig = $(`clip-${zone}`);
  const video = fig && fig.querySelector('video');
  if (!video) return;
  if (scrolledPast(fig)) dock(fig);
  video.play().catch(() => {});
}

// ---------- Feedback ----------
const fbTime = (t) => new Date(t).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const unseenFeedback = (c) => (c.feedback || []).filter((f) => !c.feedbackSeenAt || new Date(f.created_at).getTime() > c.feedbackSeenAt).length;
function feedbackList(items) {
  if (!items.length) return el('p', { class: 'rp-empty' }, 'No feedback yet.');
  return el('div', { class: 'fb-list' }, [...items].reverse().map((f) => el('div', { class: 'fb-item' },
    el('div', { class: 'fb-meta' }, el('strong', {}, f.author || 'Supervisor'), ` · ${fbTime(f.created_at)}`),
    el('div', { class: 'fb-body' }, f.body))));
}
function renderOwnerFeedback() {
  const items = current.feedback || [];
  const box = $('feedbackBox');
  box.replaceChildren(store.mode === 'local'
    ? el('p', { class: 'hint' }, 'Feedback works once the app is connected to Supabase.')
    : items.length ? feedbackList(items)
      : el('p', { class: 'hint' }, current.shareToken ? 'No feedback yet. Your supervisor can write feedback at the bottom of the shared page.' : 'Share this case and your supervisor can write feedback on it.'));
  if (unseenFeedback(current)) { current.feedbackSeenAt = Date.now(); store.save(current); }
}
function supervisorFeedbackSection(c) {
  const listHost = el('div', {}, feedbackList(c.feedback || []));
  const sec = el('section', { class: 'rp-card', id: 'rp-feedback' }, el('h2', { class: 'rp-h' }, 'Feedback'), listHost);
  if (!c._token) {
    sec.append(el('p', { class: 'hint' }, 'Your supervisor sees a box here to type feedback.'));
    return sec;
  }
  if (c.feedbackEnabled === false) return sec;
  let saved = '';
  try { saved = localStorage.getItem('asumFeedbackName') || ''; } catch { /* ignore */ }
  const name = el('input', { placeholder: 'Your name (optional)', autocomplete: 'name' });
  name.value = saved;
  const text = el('textarea', { rows: '5', placeholder: 'Write feedback on this scan…' });
  const btn = el('button', { type: 'button', class: 'primary fb-send', onclick: async () => {
    const body = text.value.trim();
    if (!body) { text.focus(); return; }
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const f = await store.addFeedback(c._token, c._caseId, name.value.trim().slice(0, 100), body.slice(0, 5000));
      try { localStorage.setItem('asumFeedbackName', name.value.trim()); } catch { /* ignore */ }
      c.feedback = [...(c.feedback || []), f];
      listHost.replaceChildren(feedbackList(c.feedback));
      text.value = '';
      toast('Feedback sent — thank you');
    } catch (e) { toast(e.message || 'Could not send feedback', 4000); }
    finally { btn.disabled = false; btn.textContent = 'Send feedback'; }
  } }, 'Send feedback');
  sec.append(el('div', { class: 'fb-form' }, el('div', { class: 'rp-label' }, 'Add feedback'), name, text, btn));
  return sec;
}

// Findings that are the normal default; anything else is highlighted on the supervisor page.
const NORMAL_LINES = new Set(['Pleural line: thin, smooth, sliding present', 'Subpleural: no consolidation',
  'A-lines', 'No effusion', 'Curtain sign present', 'Spine sign']);
const textLines = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);
const zoneKey = (s) => (s || '').toUpperCase().replace(/\s+/g, '').replace(/PLAPS$/, '-PLAPS').replace('--', '-');

function showView(c, isSupervisor) {
  showOnly('viewView', { back: !isSupervisor });
  $('viewNote').hidden = isSupervisor;
  const body = $('viewBody');
  body.innerHTML = '';
  const zones = c.zones || {};
  const videos = c.videos || [];
  const videoZones = new Set(videos.map((v) => zoneKey(v.label)).filter((k) => ZONE_ORDER.includes(k)));
  const section = (title, ...kids) => el('section', { class: 'rp-card' }, el('h2', { class: 'rp-h' }, title), ...kids);

  // Header
  const statuses = ZONE_ORDER.map((z) => zoneStatus(z, zones[z] || {}));
  const nAbn = statuses.filter((s) => s === 'abnormal').length;
  body.append(el('header', { class: 'rp-hero' },
    el('div', { class: 'rp-kicker' }, 'PoCUS lung ultrasound'),
    el('h1', {}, `Case #${c.number}`),
    c.title ? el('div', { class: 'rp-sub' }, c.title) : '',
    el('div', { class: 'rp-meta' },
      c.date ? el('span', { class: 'pill' }, `📅 ${formatDate(c.date)}`) : '',
      videos.length ? el('span', { class: 'pill' }, `🎥 ${videos.length} clip${videos.length > 1 ? 's' : ''}`) : '',
      el('span', { class: `pill ${nAbn ? 'pill-abn' : 'pill-ok'}` }, nAbn ? `${nAbn} abnormal zone${nAbn > 1 ? 's' : ''}` : 'All zones normal'),
      store.mode === 'cloud' ? el('button', { type: 'button', class: 'pill pill-btn', onclick: () => $('rp-feedback').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        (c.feedback || []).length ? `💬 Feedback (${c.feedback.length})` : '💬 Give feedback') : '')));

  // Indication
  const ind = textLines(c.indication);
  if (ind.length) body.append(section('Indication', el('ul', { class: 'rp-list' }, ind.map((l) => el('li', {}, l)))));

  // Summary
  const pats = [...(c.patterns || []), (c.patternOther || '').trim()].filter(Boolean);
  const integ = textLines(c.integration);
  body.append(section('Summary',
    el('div', { class: 'rp-label' }, 'Interpretation / pattern'),
    pats.length ? el('div', { class: 'rp-tags' }, pats.map((p) => el('span', { class: `tag ${p === 'Normal' ? 'tag-ok' : ''}` }, p)))
      : el('p', { class: 'rp-empty' }, 'Not yet recorded'),
    el('div', { class: 'rp-label' }, 'Integration'),
    integ.length ? el('blockquote', { class: 'rp-quote' }, integ.map((l) => el('p', {}, l)))
      : el('p', { class: 'rp-empty' }, 'Not yet recorded')));

  // Videos
  if (videos.length) {
    const vs = section('Scan clips');
    videos.forEach(async (meta) => {
      const label = meta.label || meta.name;
      const wrap = el('div', { class: 'vwrap' },
        el('span', { class: 'dock-label' }, label),
        el('button', { type: 'button', class: 'dock-close', 'aria-label': 'Close mini player', onclick: () => { wrap.querySelector('video').pause(); undock(); } }, '×'));
      const fig = el('figure', { class: 'rp-video', id: `clip-${zoneKey(meta.label)}` }, wrap, el('figcaption', {}, label));
      vs.append(fig);
      const video = await videoEl(meta);
      video.loop = true;
      wrap.prepend(video);
      watchClip(fig, video);
    });
    body.append(vs);
  }

  // Zone map + findings
  const mapSide = (side, list) => el('div', { class: 'zone-side' }, el('h4', {}, side),
    el('div', { class: 'zone-grid' }, list.map((z) => el('button', {
      type: 'button', class: `zone-btn s-${zoneStatus(z, zones[z] || {})}${z.includes('PLAPS') ? ' plaps' : ''}`,
      onclick: () => $(`vz-${z}`).scrollIntoView({ behavior: 'smooth', block: 'start' }),
    }, z))));
  const findings = section('Findings by zone',
    el('div', { class: 'zone-map' }, mapSide('Right', ['R1', 'R2', 'R3', 'R4', 'R-PLAPS']), mapSide('Left', ['L1', 'L2', 'L3', 'L4', 'L-PLAPS'])),
    el('p', { class: 'legend' }, el('span', { class: 'dot normal' }), 'Normal ', el('span', { class: 'dot abnormal' }), 'Abnormal ', el('span', { class: 'dot empty' }), 'Not documented'));
  ZONE_ORDER.forEach((z) => {
    const d = zones[z] || {};
    const st = zoneStatus(z, d);
    const lines = st === 'empty' ? [] : zoneLines(z, d);
    const clip = videoZones.has(z) ? el('button', { type: 'button', class: 'clip-link',
      onclick: () => playClipHere(z) }, '▶ clip') : '';
    findings.append(el('div', { class: `rp-zone z-${st}`, id: `vz-${z}` },
      el('div', { class: 'rp-zone-head' },
        el('span', { class: 'rp-zone-name' }, z),
        el('span', { class: 'rp-zone-status' }, { normal: 'Normal', abnormal: 'Abnormal', partial: 'Partly documented', empty: 'Not documented' }[st]),
        clip),
      lines.length ? el('ul', { class: 'rp-zone-list' }, lines.map((l) => el('li', { class: NORMAL_LINES.has(l) ? '' : 'hl' }, l))) : ''));
  });
  body.append(findings);
  if (store.mode === 'cloud') body.append(supervisorFeedbackSection(c));
}

async function showShared(token) {
  $('accountBtn').hidden = true;
  setSaveStatus('');
  let c = null;
  try { c = await store.getShared(token); } catch (e) { console.error(e); }
  if (!c) {
    showOnly('viewView', { back: false });
    $('viewNote').hidden = true;
    $('viewBody').replaceChildren(el('section', { class: 'rp-card' },
      el('h2', { class: 'rp-h' }, 'Case not found'),
      el('p', {}, 'This link may have been turned off. Ask for a new link.')));
    return;
  }
  document.title = `Lung US case #${c.number}`;
  c._token = token;
  showView(c, true);
}

// ---------- Buttons ----------
$('newCaseBtn').addEventListener('click', () => { location.hash = 'new'; });
$('backBtn').addEventListener('click', () => { location.hash = ''; });
$('viewBtn').addEventListener('click', () => { location.hash = `view/${current.id}`; });
$('deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Delete case #${current.number} and its videos? This cannot be undone.`)) return;
  try {
    await store.remove(current);
    dropCase(current.id);
    location.hash = '';
  } catch (e) { toast(e.message || 'Could not delete'); }
});
$('copyBtn').addEventListener('click', async () => { toast(await copyText(buildReport(current)) ? 'Report copied' : 'Copy failed'); });
function download(name, data, type) {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function exportWord(btn, list, name) {
  if (!list.length) return toast('No cases to export');
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Preparing…';
  try { download(name, await buildWordBlob(list)); }
  catch (e) { console.error(e); toast(e.message || 'Could not create Word file'); }
  finally { btn.disabled = false; btn.textContent = old; }
}
$('downloadBtn').addEventListener('click', () => download(`lung-us-case-${current.number}.txt`, buildReport(current), 'text/plain'));
$('wordBtn').addEventListener('click', (e) => exportWord(e.currentTarget, [current], `Lung US case ${current.number}.docx`));
$('wordAllBtn').addEventListener('click', (e) => exportWord(e.currentTarget, cases, `Lung US cases ${new Date().toISOString().slice(0, 10)}.docx`));
$('exportAllBtn').addEventListener('click', () => {
  download(`asum-lung-cases-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cases, null, 2), 'application/json');
});

// ---------- Start ----------
// Load the signed-in user's cases once, the first time the app (not a share link) is shown.
let started = false;
async function ensureStarted() {
  if (started) return;
  started = true;
  try {
    const { needsLogin } = await store.init();
    if (!needsLogin) cases = await store.list();
  } catch (e) { console.error(e); started = false; toast('Could not load cases — check connection'); }
}
route();
