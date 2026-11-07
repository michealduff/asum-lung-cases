'use strict';
// Word (.docx) export. The docx library is large, so it is only loaded when needed.

const DOCX_URL = 'https://cdn.jsdelivr.net/npm/docx@9.12.0/dist/index.iife.js';
let docxLoading;
function loadDocx() {
  if (window.docx) return Promise.resolve(window.docx);
  docxLoading = docxLoading || new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = DOCX_URL;
    s.onload = () => resolve(window.docx);
    s.onerror = () => { docxLoading = null; reject(new Error('Could not load the Word exporter — check your connection')); };
    document.head.append(s);
  });
  return docxLoading;
}

const lines = (text) => (text || '').split('\n').map((l) => l.trim()).filter(Boolean);

function caseParagraphs(D, c, { pageBreak }, images) {
  const { Paragraph, TextRun, HeadingLevel, ExternalHyperlink } = D;
  const bullet = (text) => new Paragraph({ text, bullet: { level: 0 } });
  const label = (text) => new Paragraph({ children: [new TextRun({ text, bold: true })], spacing: { before: 120 } });
  const out = [];

  out.push(new Paragraph({
    heading: HeadingLevel.HEADING_1, pageBreakBefore: pageBreak,
    text: `Case #${c.number}${c.title ? ` — ${c.title}` : ''}`,
  }));
  if (c.date) out.push(new Paragraph({ children: [new TextRun({ text: 'Date: ', bold: true }), new TextRun(formatDate(c.date))] }));
  if ((c.videos || []).length) {
    out.push(new Paragraph({ children: [new TextRun({ text: 'Videos: ', bold: true }), new TextRun(c.videos.map((v) => v.label || v.name).join(', '))] }));
  }
  if (c.shareToken) {
    const url = `${location.origin}${location.pathname}#s/${c.shareToken}`;
    out.push(new Paragraph({ children: [new TextRun({ text: 'Supervisor link: ', bold: true }),
      new ExternalHyperlink({ link: url, children: [new TextRun({ text: 'open case', style: 'Hyperlink' })] })] }));
  }

  out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: 'Indication' }));
  (lines(c.indication).length ? lines(c.indication) : ['—']).forEach((l) => out.push(bullet(l)));

  out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: 'Summary' }));
  out.push(label('Interpretation/Pattern:'));
  const pats = [...(c.patterns || []), (c.patternOther || '').trim()].filter(Boolean);
  (pats.length ? pats : ['—']).forEach((p) => out.push(bullet(p)));
  out.push(label('Integration:'));
  (lines(c.integration).length ? lines(c.integration) : ['—']).forEach((l) => out.push(bullet(l)));

  out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: 'Detailed findings' }));
  ZONE_ORDER.forEach((z) => {
    out.push(label(z));
    zoneLines(z, (c.zones || {})[z] || {}).forEach((l) => out.push(bullet(l)));
  });

  const im = c.imaging || {};
  const imgs = (images && images[c.id]) || [];
  if (lines(im.notes).length || imgs.length) {
    out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: 'Comparison with further imaging' }));
    lines(im.notes).forEach((l) => out.push(bullet(l)));
    imgs.forEach(({ meta, data }) => {
      const w = meta.width || 600; const h = meta.height || 450;
      const scale = Math.min(1, 560 / w, 560 / h);
      out.push(new Paragraph({ spacing: { before: 160 }, children: [new D.ImageRun({ type: 'jpg', data, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } })] }));
      if (meta.caption) out.push(new Paragraph({ children: [new TextRun({ text: meta.caption, italics: true })] }));
    });
  }
  const tc = lines(c.traineeComments);
  if (tc.length) {
    out.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: 'Comments for supervisor' }));
    tc.forEach((l) => out.push(new Paragraph({ text: l })));
  }
  return out;
}

async function buildWordBlob(caseList) {
  const D = await loadDocx();
  const { Document, Packer, Paragraph, HeadingLevel } = D;
  const sorted = [...caseList].sort((a, b) => a.number - b.number);
  const children = [];
  if (sorted.length > 1) {
    children.push(
      new Paragraph({ heading: HeadingLevel.TITLE, text: 'PoCUS Lung Ultrasound Cases' }),
      new Paragraph({ text: `${sorted.length} cases · exported ${new Date().toLocaleDateString('en-AU')}` }),
    );
  }
  // Fetch each case's comparison images so they can be embedded in the document.
  const images = {};
  for (const c of sorted) {
    images[c.id] = [];
    for (const meta of ((c.imaging && c.imaging.images) || [])) {
      try {
        const src = meta.sharedUrl || await store.videoSrc(meta);
        const data = new Uint8Array(await (await fetch(src)).arrayBuffer());
        images[c.id].push({ meta, data });
      } catch (e) { console.error('image skipped', e); }
    }
  }
  sorted.forEach((c, i) => children.push(...caseParagraphs(D, c, { pageBreak: sorted.length > 1 || i > 0 }, images)));
  const doc = new Document({
    creator: 'ASUM Lung Cases',
    title: 'PoCUS Lung Ultrasound Cases',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}
