'use strict';
// Fills the ASUM CCPU logbook template (.xlsx) with one row per case.
// The template is chosen once and kept privately with your account (and on the device).
// Only the first sheet's cells (and one added cell style) are changed; everything else in
// the file is kept exactly as ASUM supplied it.

const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js';
const SUPERVISOR_INITIALS = 'DC';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

let jszipLoading;
function loadJSZip() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  jszipLoading = jszipLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JSZIP_URL;
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => { jszipLoading = null; reject(new Error('Could not load the Excel exporter — check your connection')); };
    document.head.append(s);
  });
  return jszipLoading;
}

// ---- remember the template on this device ----
const settingsDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('asumSettings', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('kv');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function kv(mode, fn) {
  const db = await settingsDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const r = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
  });
}
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TEMPLATE_FILE = 'logbook-template.xlsx';
const getLocalTemplate = () => kv('readonly', (s) => s.get('logbookTemplate')).catch(() => null);
// Signed in: the template is kept privately in your Supabase storage, so every device has it.
// A copy is also kept on the device as a fallback.
async function getLogbookTemplate() {
  if (store.mode === 'cloud' && store.user) {
    try {
      const blob = await store.downloadOwnFile(TEMPLATE_FILE);
      if (blob) return { name: 'ASUM logbook template (saved in your account)', blob, cloud: true };
    } catch (e) { console.error(e); }
  }
  return getLocalTemplate();
}
async function saveLogbookTemplate(file) {
  if (store.mode === 'cloud' && store.user) {
    await store.uploadOwnFile(TEMPLATE_FILE, new File([file], TEMPLATE_FILE, { type: XLSX_TYPE }));
  }
  try { await kv('readwrite', (s) => s.put({ name: file.name, blob: file, savedAt: Date.now() }, 'logbookTemplate')); } catch { /* optional */ }
}

// ---- what goes in each column ----
const joinLines = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);
function isPositive(c) {
  const pats = [...(c.patterns || []), (c.patternOther || '').trim()].filter(Boolean);
  const abnormalZone = ZONE_ORDER.some((z) => zoneStatus(z, (c.zones || {})[z] || {}) === 'abnormal');
  if (!pats.length && !abnormalZone) return '';
  return pats.some((p) => p !== 'Normal') || abnormalZone ? 'Yes' : 'No';
}
function interpretation(c) {
  const pats = [...(c.patterns || []), (c.patternOther || '').trim()].filter(Boolean);
  return [pats.join(', '), ...joinLines(c.integration)].filter(Boolean).join('\n');
}
function adequacy(c) {
  const f = [...(c.feedback || [])].reverse().find((x) => x.adequate_images != null || x.correct_interpretation != null);
  if (!f) return '';
  const yn = (v) => (v == null ? '—' : v ? 'Yes' : 'No');
  if (f.adequate_images && f.correct_interpretation) return 'Yes';
  return `Adequate images: ${yn(f.adequate_images)}. Correct interpretation: ${yn(f.correct_interpretation)}.`;
}
function logbookValues(c) {
  return {
    scan: c.number,
    date: c.date ? formatDate(c.date) : '',
    indication: joinLines(c.indication).join('; '),
    positive: isPositive(c),
    interpretation: interpretation(c),
    comments: (c.feedback || []).map((f) => f.body).join('\n\n'),
    adequate: adequacy(c),
    comparison: joinLines(c.imaging && c.imaging.notes).join('\n'),
    initials: SUPERVISOR_INITIALS,
  };
}
// Match template headings to the values above (by wording, so column order doesn't matter).
const HEADING_KEYS = [
  [/^scan\s*#/i, 'scan'], [/^date/i, 'date'], [/clinical indication/i, 'indication'], [/positive/i, 'positive'],
  [/interpretation and/i, 'interpretation'], [/supervisors?'?s? comments/i, 'comments'], [/adequate images/i, 'adequate'],
  [/comparison with further imaging/i, 'comparison'], [/initials/i, 'initials'],
];

const colLetters = (ref) => ref.replace(/\d+/g, '');
const rowNum = (ref) => Number(ref.replace(/\D+/g, ''));
const colIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

async function buildLogbook(templateBlob, caseList) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(templateBlob);
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const ser = (doc) => new XMLSerializer().serializeToString(doc);

  // First sheet in the workbook (the tab that opens first).
  const wb = parse(await zip.file('xl/workbook.xml').async('string'));
  const firstSheet = wb.getElementsByTagNameNS(NS, 'sheet')[0];
  const rid = firstSheet.getAttributeNS(REL_NS, 'id');
  const rels = parse(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const rel = [...rels.getElementsByTagName('Relationship')].find((r) => r.getAttribute('Id') === rid);
  const sheetPath = `xl/${rel.getAttribute('Target').replace(/^\/?xl\//, '')}`;

  // Shared strings, to read the headings.
  const ssFile = zip.file('xl/sharedStrings.xml');
  const shared = ssFile ? [...parse(await ssFile.async('string')).getElementsByTagNameNS(NS, 'si')].map((si) => si.textContent) : [];

  // Add one cell style: the template's data-cell border, plus top alignment and text wrap.
  const stylesDoc = parse(await zip.file('xl/styles.xml').async('string'));
  const cellXfs = stylesDoc.getElementsByTagNameNS(NS, 'cellXfs')[0];
  const sheet = parse(await zip.file(sheetPath).async('string'));
  const sheetData = sheet.getElementsByTagNameNS(NS, 'sheetData')[0];
  const rows = [...sheetData.getElementsByTagNameNS(NS, 'row')];

  const cellText = (c) => {
    const t = c.getAttribute('t');
    const v = c.getElementsByTagNameNS(NS, 'v')[0];
    if (t === 's' && v) return shared[Number(v.textContent)] || '';
    return c.textContent || '';
  };
  const headerRow = rows.find((r) => [...r.getElementsByTagNameNS(NS, 'c')].some((c) => /^scan\s*#/i.test(cellText(c).trim())));
  if (!headerRow) throw new Error('This doesn’t look like the ASUM logbook template (no “Scan #” heading found on the first tab)');
  const headerRowNum = Number(headerRow.getAttribute('r'));
  const columns = {}; // key -> column letters
  [...headerRow.getElementsByTagNameNS(NS, 'c')].forEach((c) => {
    const text = cellText(c).trim();
    const hit = HEADING_KEYS.find(([re]) => re.test(text));
    if (hit && !columns[hit[1]]) columns[hit[1]] = colLetters(c.getAttribute('r'));
  });

  // Base the new style on the column's default data style (from <cols>), falling back to 0.
  const colStyle = {};
  [...sheet.getElementsByTagNameNS(NS, 'col')].forEach((col) => {
    for (let i = Number(col.getAttribute('min')); i <= Number(col.getAttribute('max')); i++) colStyle[i] = col.getAttribute('style') || '0';
  });
  const xfs = [...cellXfs.getElementsByTagNameNS(NS, 'xf')];
  const styleCache = {};
  const wrapStyleFor = (baseIdx) => {
    if (styleCache[baseIdx] != null) return styleCache[baseIdx];
    const xf = (xfs[Number(baseIdx)] || xfs[0]).cloneNode(true);
    [...xf.getElementsByTagNameNS(NS, 'alignment')].forEach((a) => a.remove());
    const al = stylesDoc.createElementNS(NS, 'alignment');
    al.setAttribute('vertical', 'top');
    al.setAttribute('wrapText', '1');
    xf.appendChild(al);
    xf.setAttribute('applyAlignment', '1');
    cellXfs.appendChild(xf);
    const idx = cellXfs.getElementsByTagNameNS(NS, 'xf').length - 1;
    cellXfs.setAttribute('count', String(idx + 1));
    styleCache[baseIdx] = idx;
    return idx;
  };

  const rowByNum = new Map(rows.map((r) => [Number(r.getAttribute('r')), r]));
  const getRow = (n) => {
    if (rowByNum.has(n)) return rowByNum.get(n);
    const r = sheet.createElementNS(NS, 'row');
    r.setAttribute('r', String(n));
    const after = [...rowByNum.keys()].filter((k) => k > n).sort((a, b) => a - b)[0];
    sheetData.insertBefore(r, after != null ? rowByNum.get(after) : null);
    rowByNum.set(n, r);
    return r;
  };
  const setCell = (rowEl, letters, value) => {
    const ref = `${letters}${rowEl.getAttribute('r')}`;
    let cell = [...rowEl.getElementsByTagNameNS(NS, 'c')].find((c) => c.getAttribute('r') === ref);
    if (!cell) {
      cell = sheet.createElementNS(NS, 'c');
      cell.setAttribute('r', ref);
      const later = [...rowEl.getElementsByTagNameNS(NS, 'c')].find((c) => colIndex(colLetters(c.getAttribute('r'))) > colIndex(letters));
      rowEl.insertBefore(cell, later || null);
    }
    while (cell.firstChild) cell.removeChild(cell.firstChild);
    cell.setAttribute('s', String(wrapStyleFor(colStyle[colIndex(letters)] || '0')));
    if (typeof value === 'number') {
      cell.removeAttribute('t');
      const v = sheet.createElementNS(NS, 'v'); v.textContent = String(value); cell.appendChild(v);
    } else {
      cell.setAttribute('t', 'inlineStr');
      const is = sheet.createElementNS(NS, 'is'); const t = sheet.createElementNS(NS, 't');
      t.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve'); t.textContent = value; is.appendChild(t); cell.appendChild(is);
    }
  };

  const sorted = [...caseList].sort((a, b) => a.number - b.number);
  sorted.forEach((c, i) => {
    const rowEl = getRow(headerRowNum + 1 + i);
    rowEl.removeAttribute('spans');
    const vals = logbookValues(c);
    Object.entries(columns).forEach(([key, letters]) => {
      const v = vals[key];
      if (v !== '' && v != null) setCell(rowEl, letters, v);
    });
  });

  // Keep the sheet's stated used range in step.
  const dim = sheet.getElementsByTagNameNS(NS, 'dimension')[0];
  if (dim) {
    const [start, end = start] = dim.getAttribute('ref').split(':');
    const lastRow = Math.max(rowNum(end), headerRowNum + sorted.length);
    dim.setAttribute('ref', `${start}:${colLetters(end)}${lastRow}`);
  }

  zip.file(sheetPath, ser(sheet), { createFolders: false });
  zip.file('xl/styles.xml', ser(stylesDoc), { createFolders: false });
  return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', compression: 'DEFLATE' });
}
