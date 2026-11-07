'use strict';
// The lung ultrasound template: zones, options, pattern suggestions and report text.

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

// ---------- Zone assessment ----------
function zoneStatus(zone, d) {
  if (d.notDone) return 'notdone';
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
  if (!out.length && statuses.some((s) => s === 'normal') && statuses.every((s) => s === 'normal' || s === 'notdone')) out.push('Normal');
  return out;
}

// ---------- Report text ----------
function zoneLines(zone, d) {
  if (d.notDone) return ['Not done'];
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
  const im = c.imaging || {};
  const imNotes = bullets(im.notes || '');
  const imgs = im.images || [];
  if (imNotes.length || imgs.length) {
    out.push('', '', 'COMPARISON WITH FURTHER IMAGING');
    out.push(...imNotes);
    if (imgs.length) out.push(`\t•\tImages: ${imgs.map((i) => i.caption || i.name).join(', ')}`);
  }
  const tc = bullets(c.traineeComments || '');
  if (tc.length) out.push('', '', 'COMMENTS FOR SUPERVISOR', ...tc);
  return out.join('\n') + '\n';
}

function formatDate(iso) {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

