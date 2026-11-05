'use strict';

// ---------- Template definition ----------
const LUNG_ZONES = ['R1', 'R2', 'R3', 'R4', 'L1', 'L2', 'L3', 'L4'];
const PLAPS_ZONES = ['R-PLAPS', 'L-PLAPS'];
const ZONE_ORDER = ['R1', 'R2', 'R3', 'R4', 'R-PLAPS', 'L1', 'L2', 'L3', 'L4', 'L-PLAPS'];

const LUNG_FIELDS = [
  { key: 'pleura', label: 'Pleural line', type: 'single',
    options: ['Thin, smooth', 'Thickened', 'Fragmented', 'Thick, fragmented'] },
  { key: 'sliding', label: 'Sliding', type: 'single',
    options: ['Present', 'Reduced', 'Absent'] },
  { key: 'subpleural', label: 'Subpleural', type: 'single',
    options: ['None', 'Small consolidation', 'Medium consolidation', 'Large consolidation'] },
  { key: 'subExtra', label: 'Subpleural features', type: 'multi',
    options: ['Shred sign', 'Air bronchograms', 'Lung pulse', 'Lung point'] },
  { key: 'artefact', label: 'Artefacts', type: 'single',
    options: ['A-lines', 'B-lines (<3)', 'B-lines (≥3)', 'Confluent B-lines'] },
];

const PLAPS_FIELDS = [
  { key: 'effusion', label: 'Effusion', type: 'single',
    options: ['None', 'Small', 'Moderate', 'Large'] },
  { key: 'appearance', label: 'Effusion appearance', type: 'single',
    options: ['Anechoic (simple)', 'Complex non-septated', 'Complex septated', 'Homogeneously echogenic'] },
  { key: 'curtain', label: 'Curtain sign', type: 'single',
    options: ['Present', 'Absent'] },
  { key: 'plapsExtra', label: 'Other', type: 'multi',
    options: ['Spine sign', 'Compressive atelectasis', 'Consolidation', 'Shred sign'] },
];

const PATTERNS = [
  'Normal',
  'Unilateral interstitial syndrome',
  'Bilateral interstitial syndrome',
  'Isolated effusion',
  'Bilateral effusions',
  'Consolidation',
  'Pneumothorax pattern',
];

const fieldsFor = (zone) => (PLAPS_ZONES.includes(zone) ? PLAPS_FIELDS : LUNG_FIELDS);

// ---------- Storage ----------
const STORE_KEY = 'asumLungCases.v1';
function loadCases() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch { return []; }
}
function saveCases() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(cases)); }
  catch { toast('Could not save on this device'); }
}

let cases = loadCases();
let current = null; // case being edited

// Videos are stored as Blobs in IndexedDB (too big for localStorage).
const idb = new Promise((resolve, reject) => {
  const req = indexedDB.open('asumLungCasesVideos', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('videos');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function idbDo(mode, fn) {
  const db = await idb;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('videos', mode);
    const r = fn(tx.objectStore('videos'));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}
const putVideo = (id, blob) => idbDo('readwrite', (s) => s.put(blob, id));
const getVideo = (id) => idbDo('readonly', (s) => s.get(id));
const deleteVideo = (id) => idbDo('readwrite', (s) => s.delete(id));
const objectUrls = [];
function revokeUrls() { while (objectUrls.length) URL.revokeObjectURL(objectUrls.pop()); }
async function videoEl(id) {
  const v = el('video', { controls: '', playsinline: '', preload: 'metadata', muted: '' });
  try {
    const blob = await getVideo(id);
    if (blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); v.src = u; }
  } catch { /* shown as empty player */ }
  return v;
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function newCase() {
  const zones = {};
  ZONE_ORDER.forEach((z) => { zones[z] = { notes: '' }; });
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()),
    number: cases.reduce((m, c) => Math.max(m, c.number || 0), 0) + 1,
    videos: [],
    title: '',
    date: new Date().toISOString().slice(0, 10),
    indication: '',
    patterns: [],
    patternOther: '',
    integration: '',
    zones,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// ---------- Zone assessment ----------
function zoneStatus(zone, d) {
  const fields = fieldsFor(zone);
  const filled = fields.filter((f) => (f.type === 'multi' ? (d[f.key] || []).length : d[f.key])).length;
  if (!filled && !d.notes) return 'empty';
  if (isAbnormal(zone, d)) return 'abnormal';
  if (PLAPS_ZONES.includes(zone)) return d.effusion ? 'normal' : 'partial';
  return d.pleura && d.sliding && d.subpleural && d.artefact ? 'normal' : 'partial';
}

function isAbnormal(zone, d) {
  if (PLAPS_ZONES.includes(zone)) {
    return hasEffusion(d) || d.curtain === 'Absent' || (d.plapsExtra || []).length > 0;
  }
  return (d.pleura && d.pleura !== 'Thin, smooth') ||
    (d.sliding && d.sliding !== 'Present') ||
    (d.subpleural && d.subpleural !== 'None') ||
    (d.subExtra || []).some((x) => x !== 'Lung pulse') ||
    d.artefact === 'B-lines (≥3)' || d.artefact === 'Confluent B-lines';
}

const bPositive = (d) => d.artefact === 'B-lines (≥3)' || d.artefact === 'Confluent B-lines';
const hasEffusion = (d) => d.effusion && d.effusion !== 'None';

// Pattern suggestion: interstitial syndrome = ≥2 B-line-positive zones per side.
function suggestPatterns(c) {
  const z = c.zones;
  const rPos = ['R1', 'R2', 'R3', 'R4'].filter((k) => bPositive(z[k])).length;
  const lPos = ['L1', 'L2', 'L3', 'L4'].filter((k) => bPositive(z[k])).length;
  const rEff = hasEffusion(z['R-PLAPS']);
  const lEff = hasEffusion(z['L-PLAPS']);
  const consol = LUNG_ZONES.some((k) => z[k].subpleural && z[k].subpleural !== 'None' && z[k].subpleural !== 'Small consolidation');
  const ptx = LUNG_ZONES.some((k) => z[k].sliding === 'Absent' && (z[k].subExtra || []).includes('Lung point'));

  const out = [];
  if (rPos >= 2 && lPos >= 2) out.push('Bilateral interstitial syndrome');
  else if (rPos >= 2 || lPos >= 2) out.push('Unilateral interstitial syndrome');
  if (rEff && lEff) out.push('Bilateral effusions');
  else if ((rEff || lEff) && !rPos && !lPos) out.push('Isolated effusion');
  if (consol) out.push('Consolidation');
  if (ptx) out.push('Pneumothorax pattern');

  const statuses = ZONE_ORDER.map((k) => zoneStatus(k, z[k]));
  if (!out.length && statuses.every((s) => s === 'normal')) out.push('Normal');
  return out;
}

// ---------- Report text ----------
function zoneLines(zone, d) {
  const lines = [];
  if (PLAPS_ZONES.includes(zone)) {
    if (d.effusion) {
      let s = d.effusion === 'None' ? 'No effusion' : `${d.effusion} effusion`;
      if (d.effusion !== 'None' && d.appearance) s += `, ${d.appearance.toLowerCase()}`;
      lines.push(s);
    }
    if (d.curtain) lines.push(`Curtain sign ${d.curtain.toLowerCase()}`);
    (d.plapsExtra || []).forEach((x) => lines.push(x));
  } else {
    const pl = [d.pleura, d.sliding && `sliding ${d.sliding.toLowerCase()}`].filter(Boolean);
    if (pl.length) lines.push(`Pleural line: ${pl.join(', ').replace(/^./, (m) => m.toLowerCase())}`);
    const sp = [d.subpleural && (d.subpleural === 'None' ? 'no consolidation' : d.subpleural.toLowerCase()),
      ...(d.subExtra || []).map((x) => x.toLowerCase())].filter(Boolean);
    if (sp.length) lines.push(`Subpleural: ${sp.join(', ')}`);
    if (d.artefact) lines.push(d.artefact);
  }
  if (d.notes && d.notes.trim()) lines.push(d.notes.trim());
  return lines.length ? lines : ['Not documented'];
}

function bullets(text, mark = '•') {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `\t${mark}\t${l}`);
}

function buildReport(c) {
  const out = [`PoCUS Lung Ultrasound — Case #${c.number}`];
  if (c.date) out.push(`Date: ${formatDate(c.date)}`);
  if (c.videos && c.videos.length) out.push(`Videos: ${c.videos.map((v) => v.label || v.name).join(', ')}`);
  out.push('', 'Indication:');
  out.push(...(bullets(c.indication).length ? bullets(c.indication) : ['\t•\t']));
  out.push('', 'SUMMARY', '', 'Interpretation/Pattern:');
  const pats = [...c.patterns, c.patternOther && c.patternOther.trim()].filter(Boolean);
  out.push(...(pats.length ? pats.map((p) => `\t•\t${p}`) : ['\t•\t']));
  out.push('', 'Integration:');
  out.push(...(bullets(c.integration, '⁃').length ? bullets(c.integration, '⁃') : ['\t⁃\t']));
  out.push('', '', 'DETAILED FINDINGS');
  ZONE_ORDER.forEach((z) => {
    out.push('', z, ...zoneLines(z, c.zones[z]).map((l) => `\t•\t${l}`));
  });
  return out.join('\n') + '\n';
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

// ---------- UI helpers ----------
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
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 1800);
}

function touch() {
  current.updatedAt = Date.now();
  const i = cases.findIndex((c) => c.id === current.id);
  if (i === -1) cases.unshift(current); else cases[i] = current;
  saveCases();
  refreshDerived();
}

// ---------- Routing: #  |  #case/<id>  |  #new  |  #view/<id> ----------
function showOnly(viewId) {
  ['listView', 'editView', 'viewView'].forEach((v) => { $(v).hidden = v !== viewId; });
  $('backBtn').hidden = viewId === 'listView';
  revokeUrls();
  window.scrollTo(0, 0);
}
function route() {
  const [kind, id] = location.hash.replace(/^#/, '').split('/');
  const found = id && cases.find((c) => c.id === id);
  if (kind === 'new') {
    const c = newCase();
    cases.unshift(c); saveCases();
    history.replaceState(null, '', `#case/${c.id}`);
    openCase(c.id);
  } else if (kind === 'case' && found) openCase(id);
  else if (kind === 'view' && found) showView(found);
  else showList();
}
window.addEventListener('hashchange', route);

// ---------- List view ----------
function showList() {
  current = null;
  showOnly('listView');
  const list = $('caseList');
  list.innerHTML = '';
  const sorted = [...cases].sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    list.append(el('li', { class: 'empty-state' }, 'No cases yet. Tap “New case” to start.'));
    return;
  }
  sorted.forEach((c) => {
    const pats = [...c.patterns, c.patternOther].filter(Boolean).join(', ') || 'No interpretation yet';
    list.append(el('li', { onclick: () => { location.hash = `case/${c.id}`; } },
      el('span', { class: 'case-num' }, `#${c.number}`),
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, c.title || bullets(c.indication)[0]?.replace(/\t•\t/, '') || 'Untitled case'),
        el('div', { class: 'meta' }, pats)),
      el('div', { class: 'meta' }, c.date ? formatDate(c.date) : '')));
  });
}

// ---------- Edit view ----------
function openCase(id) {
  current = cases.find((c) => c.id === id);
  ZONE_ORDER.forEach((z) => { current.zones[z] = current.zones[z] || { notes: '' }; });
  current.videos = current.videos || [];
  showOnly('editView');
  $('caseHeading').textContent = `Case #${current.number}`;
  renderVideos();

  $('f-title').value = current.title;
  $('f-date').value = current.date;
  $('f-indication').value = current.indication;
  $('f-patternOther').value = current.patternOther;
  $('f-integration').value = current.integration;

  renderZoneCards();
  renderPatternChips();
  refreshDerived();
}

async function renderVideos() {
  const host = $('videoList');
  host.innerHTML = '';
  for (const meta of current.videos) {
    const label = el('input', { placeholder: 'Label, e.g. R4 or R-PLAPS' });
    label.value = meta.label || '';
    label.addEventListener('input', () => { meta.label = label.value; touch(); });
    const item = el('div', { class: 'video-item' },
      await videoEl(meta.id),
      el('div', { class: 'row' }, label,
        el('button', { type: 'button', class: 'danger', onclick: async () => {
          if (!confirm('Remove this video?')) return;
          current.videos = current.videos.filter((v) => v.id !== meta.id);
          touch();
          await deleteVideo(meta.id);
          renderVideos();
        } }, 'Remove')),
      el('div', { class: 'meta' }, `${meta.name} · ${mb(meta.size)}`));
    host.append(item);
  }
}

function showView(c) {
  showOnly('viewView');
  $('viewHeading').textContent = `Case #${c.number}${c.title ? ` — ${c.title}` : ''}`;
  $('viewMeta').textContent = [c.date && formatDate(c.date), `${(c.videos || []).length} video(s)`].filter(Boolean).join(' · ');
  $('viewReport').textContent = buildReport(c);
  const host = $('viewVideos');
  host.innerHTML = '';
  (c.videos || []).forEach(async (meta) => {
    const card = el('div', { class: 'card view-video' }, el('h3', {}, meta.label || meta.name));
    host.append(card);
    card.append(await videoEl(meta.id));
  });
}

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
            const arr = new Set(getVal() || []);
            arr.has(opt) ? arr.delete(opt) : arr.add(opt);
            setVal([...arr]);
          } else {
            setVal(getVal() === opt ? '' : opt);
          }
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
    const d = current.zones[zone];
    const groups = [];
    const body = fieldsFor(zone).map((f) => {
      const g = chipGroup(f, () => current.zones[zone][f.key], (v) => { current.zones[zone][f.key] = v; touch(); });
      groups.push(g);
      return el('div', { class: 'field' }, el('div', { class: 'field-label' }, f.label), g);
    });
    const notes = el('input', { placeholder: 'Other findings / notes' });
    notes.value = d.notes || '';
    notes.addEventListener('input', () => { current.zones[zone].notes = notes.value; touch(); });

    const setAll = (vals) => {
      Object.assign(current.zones[zone], structuredClone(vals));
      groups.forEach((g) => g.redraw());
      touch();
    };
    const normal = PLAPS_ZONES.includes(zone) ? NORMAL_PLAPS : NORMAL_LUNG;
    const clear = Object.fromEntries(fieldsFor(zone).map((f) => [f.key, f.type === 'multi' ? [] : '']));

    host.append(el('div', { class: 'card zone-card', id: `zone-${zone}` },
      el('div', { class: 'zone-head' },
        el('h2', {}, zone),
        el('button', { type: 'button', onclick: () => setAll(normal) }, 'Normal'),
        el('button', { type: 'button', class: 'ghost', onclick: () => { setAll(clear); notes.value = ''; current.zones[zone].notes = ''; touch(); } }, 'Clear')),
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
  const field = { options: PATTERNS, type: 'multi' };
  const g = chipGroup(field, () => current.patterns, (v) => { current.patterns = v; touch(); });
  const host = $('patternChips');
  host.replaceWith(g);
  g.id = 'patternChips';
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

// ---------- Wire up ----------
[['f-title', 'title'], ['f-date', 'date'], ['f-indication', 'indication'],
  ['f-patternOther', 'patternOther'], ['f-integration', 'integration']].forEach(([id, key]) => {
  $(id).addEventListener('input', (e) => { current[key] = e.target.value; touch(); });
});

$('newCaseBtn').addEventListener('click', () => { location.hash = 'new'; });
$('backBtn').addEventListener('click', () => { location.hash = ''; });
$('viewBtn').addEventListener('click', () => { location.hash = `view/${current.id}`; });

$('videoInput').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) {
    const id = `${current.id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    try {
      await putVideo(id, f);
      current.videos.push({ id, name: f.name, size: f.size, type: f.type, label: '' });
      touch();
    } catch { toast(`Could not save ${f.name}`); }
  }
  renderVideos();
});

$('deleteBtn').addEventListener('click', async () => {
  if (!confirm(`Delete case #${current.number} and its videos? This cannot be undone.`)) return;
  const vids = current.videos || [];
  cases = cases.filter((c) => c.id !== current.id);
  saveCases();
  await Promise.all(vids.map((v) => deleteVideo(v.id).catch(() => {})));
  location.hash = '';
});

$('copyBtn').addEventListener('click', async () => {
  const text = buildReport(current);
  try { await navigator.clipboard.writeText(text); toast('Report copied'); }
  catch {
    const ta = el('textarea'); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand('copy'); toast('Report copied'); } catch { toast('Copy failed'); }
    ta.remove();
  }
});

function download(name, text, type) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
}
$('downloadBtn').addEventListener('click', () => {
  download(`lung-us-${current.date || 'case'}.txt`, buildReport(current), 'text/plain');
});
$('exportAllBtn').addEventListener('click', () => {
  download(`asum-lung-cases-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(cases, null, 2), 'application/json');
});

route();
