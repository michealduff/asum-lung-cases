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

function caseParagraphs(D, c, { pageBreak }) {
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
  sorted.forEach((c, i) => children.push(...caseParagraphs(D, c, { pageBreak: sorted.length > 1 || i > 0 })));
  const doc = new Document({
    creator: 'ASUM Lung Cases',
    title: 'PoCUS Lung Ultrasound Cases',
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [{ children }],
  });
  return Packer.toBlob(doc);
}
