'use strict';
// Front-on chest diagram with the lung zones drawn where they are scanned, coloured by finding.
// Patient's right is on the viewer's left (as when facing the patient).
// Zones 1–2 = anterior (upper/lower), 3–4 = lateral (upper/lower), PLAPS = posterolateral base.

const SVG_NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}, ...kids) => {
  const n = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
  kids.forEach((k) => n.append(k));
  return n;
};

// x, y, width, height in a 360 × 330 drawing.
const ZONE_BOXES = {
  R1: [100, 78, 68, 70], R2: [100, 152, 68, 64], R3: [44, 92, 52, 62], R4: [48, 158, 52, 58], 'R-PLAPS': [52, 226, 92, 36],
  L1: [192, 78, 68, 70], L2: [192, 152, 68, 64], L3: [264, 92, 52, 62], L4: [260, 158, 52, 58], 'L-PLAPS': [216, 226, 92, 36],
};

function chestDiagram(statusOf, hasMedia, onPick) {
  const svg = svgEl('svg', { viewBox: '0 0 360 330', class: 'chest', role: 'img', 'aria-label': 'Lung zones on a chest diagram' });
  // Body outline (neck, shoulders, upper arms, torso), clavicles, sternum, faint ribs, costal margin
  svg.append(
    svgEl('path', { class: 'chest-body', d: 'M158,4 L158,30 C130,38 96,40 66,50 C40,58 22,72 16,96 L10,190 L30,192 L36,118 L40,150 L48,292 Q180,318 312,292 L320,150 L324,118 L330,192 L350,190 L344,96 C338,72 320,58 294,50 C264,40 230,38 202,30 L202,4' }),
    svgEl('path', { class: 'chest-line', d: 'M176,50 C150,47 110,52 78,62 M184,50 C210,47 250,52 282,62' }),
    svgEl('path', { class: 'chest-line faint', d: 'M180,52 L180,206 M108,214 Q180,264 252,214' }),
    svgEl('path', { class: 'chest-rib', d: 'M172,76 C140,70 96,78 60,98 M172,112 C140,106 96,114 58,134 M172,148 C140,142 98,150 60,170 M172,184 C142,178 102,186 66,204 M188,76 C220,70 264,78 300,98 M188,112 C220,106 264,114 302,134 M188,148 C220,142 262,150 300,170 M188,184 C218,178 258,186 294,204' }),
    svgEl('text', { x: 14, y: 22, class: 'chest-side' }, 'R'),
    svgEl('text', { x: 346, y: 22, class: 'chest-side', 'text-anchor': 'end' }, 'L'),
  );
  Object.entries(ZONE_BOXES).forEach(([z, [x, y, w, h]]) => {
    const st = statusOf(z);
    const g = svgEl('g', { class: `chest-zone s-${st}`, tabindex: '0', role: 'button', 'aria-label': `${z}: ${st}` });
    g.append(
      svgEl('rect', { x, y, width: w, height: h, rx: 10, class: z.includes('PLAPS') ? 'plaps' : '' }),
      svgEl('text', { x: x + w / 2, y: y + h / 2 + 5, 'text-anchor': 'middle', class: 'chest-label' }, z),
    );
    g.addEventListener('click', () => onPick(z));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(z); } });
    svg.append(g);
  });
  return svg;
}
