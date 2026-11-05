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

const store = createStore(setSaveStatus);
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

// ---------- Routing ----------
//  #            case list           #new         create a case
//  #case/<id>   edit a case         #view/<id>   preview what the supervisor sees
//  #s/<token>   supervisor link (no login)
const VIEWS = ['loginView', 'listView', 'editView', 'viewView'];
function showOnly(viewId, { back = true } = {}) {
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
        c.shareToken ? el('div', { class: 'shared-tag' }, 'Shared') : '')));
  });
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

$('videoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  const status = $('uploadStatus');
  for (const [i, f] of files.entries()) {
    if (store.mode === 'cloud' && f.size > 50 * 1048576) {
      toast(`${f.name} is ${mb(f.size)} — the limit is 50 MB. Trim the clip or record at 1080p.`, 5000);
      continue;
    }
    status.textContent = `Uploading ${files.length > 1 ? `${i + 1} of ${files.length} ` : ''}(${mb(f.size)})…`;
    try {
      const meta = await store.addVideo(current, f);
      current.videos.push(meta);
      touch();
    } catch (err) { toast(`Could not upload ${f.name}: ${err.message || err}`, 5000); }
  }
  status.textContent = '';
  try { await store.refreshShare(current); } catch (err) { console.error(err); }
  renderVideos();
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
function showView(c, isSupervisor) {
  showOnly('viewView', { back: !isSupervisor });
  $('viewHeading').textContent = `Lung ultrasound — Case #${c.number}${c.title ? ` · ${c.title}` : ''}`;
  $('viewMeta').textContent = [c.date && formatDate(c.date), `${(c.videos || []).length} video(s)`].filter(Boolean).join(' · ');
  $('viewReport').textContent = buildReport(c);
  $('viewNote').hidden = isSupervisor;
  const host = $('viewVideos');
  host.innerHTML = '';
  (c.videos || []).forEach(async (meta) => {
    const card = el('div', { class: 'card view-video' }, el('h3', {}, meta.label || meta.name));
    host.append(card);
    card.append(await videoEl(meta));
  });
}

async function showShared(token) {
  $('accountBtn').hidden = true;
  setSaveStatus('');
  let c = null;
  try { c = await store.getShared(token); } catch (e) { console.error(e); }
  if (!c) {
    showOnly('viewView', { back: false });
    $('viewHeading').textContent = 'Case not found';
    $('viewMeta').textContent = 'This link may have been turned off. Ask for a new link.';
    $('viewReport').textContent = '';
    $('viewVideos').innerHTML = '';
    $('viewNote').hidden = true;
    return;
  }
  document.title = `Lung US case #${c.number}`;
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
    cases = cases.filter((c) => c.id !== current.id);
    location.hash = '';
  } catch (e) { toast(e.message || 'Could not delete'); }
});
$('copyBtn').addEventListener('click', async () => { toast(await copyText(buildReport(current)) ? 'Report copied' : 'Copy failed'); });
function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
$('downloadBtn').addEventListener('click', () => download(`lung-us-case-${current.number}.txt`, buildReport(current), 'text/plain'));
$('exportAllBtn').addEventListener('click', () => {
  download(`asum-lung-cases-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cases, null, 2), 'application/json');
});

// ---------- Start ----------
(async () => {
  if (!location.hash.startsWith('#s/')) {
    try {
      const { needsLogin } = await store.init();
      if (!needsLogin) cases = await store.list();
    } catch (e) { console.error(e); toast('Could not load cases — check connection'); }
  }
  route();
})();
