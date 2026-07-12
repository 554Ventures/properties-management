// Minimal dependency-free PDF renderer. Produces real, spec-conformant PDFs
// (header, objects, xref, trailer) with Helvetica text on US-Letter pages —
// no library, because the API bundles to a single dist/server.js with esbuild
// and PDF libs (pdfkit et al.) load font asset files from disk at runtime,
// which that bundling breaks.
//
// Two entry points:
//   renderTextPdf(title, lines)    — plain paragraphs (seed documents)
//   renderReportPdf(title, blocks) — report export: key/value totals,
//                                    headings, lists, paginated tables
//
// Text is encoded as WinAnsi (CP1252); characters outside it are mapped to
// close ASCII equivalents or '?'. Column widths use an average-character
// approximation of Helvetica metrics — fine for truncation and right
// alignment at report scale.

export type PdfBlock =
  | { kind: 'meta'; lines: string[] }
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string; muted?: boolean }
  | { kind: 'keyValues'; entries: Array<[label: string, value: string]> }
  | { kind: 'list'; items: string[] }
  | {
      kind: 'table';
      columns: Array<{ label: string; align?: 'left' | 'right' }>;
      rows: string[][];
    };

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 72;
const USABLE_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const TITLE_SIZE = 16;
const TITLE_LEADING = 20;
const HEADING_SIZE = 12;
const BODY_SIZE = 10;
const BODY_LEADING = 14;
const TABLE_SIZE = 9;
const TABLE_LEADING = 13;
const BLOCK_GAP = 12;

// Unicode → CP1252 byte for the printable 0x80–0x9F range.
const CP1252: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84,
  '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88,
  '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c,
  'Ž': 0x8e, '‘': 0x91, '’': 0x92, '“': 0x93,
  '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b,
  'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};

// Multi-char ASCII fallbacks for symbols WinAnsi lacks.
const ASCII_FALLBACK: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->',
};

function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (code < 0x20) out += ' ';
    else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (CP1252[ch] !== undefined) out += String.fromCharCode(CP1252[ch]);
    else if (ASCII_FALLBACK[ch] !== undefined) out += ASCII_FALLBACK[ch];
    else out += '?';
  }
  return out;
}

function escapePdfString(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Average-character width estimate for Helvetica (bold runs slightly wider).
function estWidth(text: string, size: number, bold = false): number {
  return text.length * size * (bold ? 0.58 : 0.55);
}

function truncateToWidth(text: string, size: number, maxWidth: number, bold = false): string {
  if (estWidth(text, size, bold) <= maxWidth) return text;
  let keep = text.length;
  while (keep > 0 && estWidth(`${text.slice(0, keep)}…`, size, bold) > maxWidth) keep -= 1;
  return `${text.slice(0, keep)}…`;
}

function wrapToWidth(text: string, size: number, maxWidth: number, bold = false): string[] {
  if (estWidth(text, size, bold) <= maxWidth) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    let piece = word;
    while (estWidth(piece, size, bold) > maxWidth) {
      if (line) {
        out.push(line);
        line = '';
      }
      let keep = piece.length;
      while (keep > 1 && estWidth(piece.slice(0, keep), size, bold) > maxWidth) keep -= 1;
      out.push(piece.slice(0, keep));
      piece = piece.slice(keep);
    }
    if (!line) line = piece;
    else if (estWidth(`${line} ${piece}`, size, bold) <= maxWidth) line += ` ${piece}`;
    else {
      out.push(line);
      line = piece;
    }
  }
  if (line) out.push(line);
  return out;
}

// ── page layout ──────────────────────────────────────────────────────────────

interface TextRun {
  x: number;
  y: number; // baseline
  text: string;
  bold: boolean;
  size: number;
  muted: boolean;
}

interface RuleRun {
  x1: number;
  x2: number;
  y: number;
}

interface Page {
  texts: TextRun[];
  rules: RuleRun[];
}

class Layout {
  pages: Page[] = [];
  private y = 0; // top of the next line to be written

  constructor() {
    this.newPage();
  }

  newPage(): void {
    this.pages.push({ texts: [], rules: [] });
    this.y = PAGE_HEIGHT - MARGIN;
  }

  /** Start a new page unless `height` more points fit on this one. */
  ensure(height: number): void {
    if (this.y - height < MARGIN) this.newPage();
  }

  private page(): Page {
    return this.pages[this.pages.length - 1] as Page;
  }

  /** Write one line of text and advance the cursor by `leading`. */
  line(
    text: string,
    opts: { x?: number; size?: number; bold?: boolean; muted?: boolean; leading?: number; align?: 'left' | 'right'; alignRightEdge?: number } = {},
  ): void {
    const size = opts.size ?? BODY_SIZE;
    const leading = opts.leading ?? BODY_LEADING;
    this.ensure(leading);
    if (text !== '') {
      const bold = opts.bold ?? false;
      let x = opts.x ?? MARGIN;
      if (opts.align === 'right') {
        x = (opts.alignRightEdge ?? PAGE_WIDTH - MARGIN) - estWidth(text, size, bold);
      }
      this.page().texts.push({
        x,
        y: this.y - size,
        text,
        bold,
        size,
        muted: opts.muted ?? false,
      });
    }
    this.y -= leading;
  }

  /** Place text on the current line without advancing (for multi-column rows). */
  put(text: string, x: number, opts: { size?: number; bold?: boolean; muted?: boolean; align?: 'left' | 'right'; alignRightEdge?: number } = {}): void {
    const size = opts.size ?? BODY_SIZE;
    const bold = opts.bold ?? false;
    let atX = x;
    if (opts.align === 'right') {
      atX = (opts.alignRightEdge ?? x) - estWidth(text, size, bold);
    }
    this.page().texts.push({
      x: atX,
      y: this.y - size,
      text,
      bold,
      size,
      muted: opts.muted ?? false,
    });
  }

  advance(leading: number): void {
    this.y -= leading;
  }

  rule(): void {
    this.page().rules.push({ x1: MARGIN, x2: PAGE_WIDTH - MARGIN, y: this.y });
  }

  gap(points: number): void {
    if (this.y < PAGE_HEIGHT - MARGIN) this.y -= points;
  }
}

// ── block renderers ──────────────────────────────────────────────────────────

function layoutParagraph(l: Layout, text: string, opts: { size?: number; bold?: boolean; muted?: boolean; leading?: number } = {}): void {
  const size = opts.size ?? BODY_SIZE;
  const leading = opts.leading ?? BODY_LEADING;
  for (const line of wrapToWidth(text, size, USABLE_WIDTH, opts.bold)) {
    l.line(line, { ...opts, size, leading });
  }
}

function layoutKeyValues(l: Layout, entries: Array<[string, string]>): void {
  const valueX = MARGIN + 200;
  for (const [label, value] of entries) {
    l.ensure(BODY_LEADING + 1);
    l.put(truncateToWidth(label, BODY_SIZE, 190), MARGIN, { muted: true });
    l.put(truncateToWidth(value, BODY_SIZE, USABLE_WIDTH - 200, true), valueX, { bold: true });
    l.advance(BODY_LEADING + 1);
  }
}

function layoutList(l: Layout, items: string[]): void {
  for (const item of items) {
    const lines = wrapToWidth(item, BODY_SIZE, USABLE_WIDTH - 14);
    lines.forEach((line, i) => {
      l.ensure(BODY_LEADING);
      if (i === 0) l.put('•', MARGIN, {});
      l.put(line, MARGIN + 14, {});
      l.advance(BODY_LEADING);
    });
  }
}

function layoutTable(l: Layout, block: Extract<PdfBlock, { kind: 'table' }>): void {
  const cols = block.columns;
  if (cols.length === 0) return;
  const gap = 10;
  const totalGap = gap * (cols.length - 1);

  // Natural width per column (capped so one verbose column can't starve the
  // rest), then scale down proportionally if the set overflows the page.
  const natural = cols.map((col, i) => {
    let w = estWidth(col.label, TABLE_SIZE, true);
    for (const row of block.rows) w = Math.max(w, estWidth(row[i] ?? '', TABLE_SIZE));
    return Math.min(220, Math.max(28, w));
  });
  const naturalSum = natural.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, (USABLE_WIDTH - totalGap) / naturalSum);
  const widths = natural.map((w) => w * scale);
  const xs: number[] = [];
  let x = MARGIN;
  for (const w of widths) {
    xs.push(x);
    x += w + gap;
  }

  const putRow = (cells: string[], bold: boolean): void => {
    cols.forEach((col, i) => {
      const width = widths[i] as number;
      const text = truncateToWidth(cells[i] ?? '', TABLE_SIZE, width, bold);
      l.put(text, xs[i] as number, {
        size: TABLE_SIZE,
        bold,
        align: col.align,
        alignRightEdge: (xs[i] as number) + width,
      });
    });
    l.advance(TABLE_LEADING);
  };

  const header = (): void => {
    l.ensure(TABLE_LEADING * 3); // header + rule + at least one row
    putRow(cols.map((c) => c.label), true);
    l.rule();
    l.advance(4);
  };

  header();
  for (const row of block.rows) {
    l.ensure(TABLE_LEADING);
    // ensure() may have started a fresh page — repeat the header there.
    const page = l.pages[l.pages.length - 1] as Page;
    if (page.texts.length === 0 && page.rules.length === 0) header();
    putRow(row, false);
  }
}

function layoutBlocks(l: Layout, title: string, blocks: PdfBlock[]): void {
  for (const line of wrapToWidth(title, TITLE_SIZE, USABLE_WIDTH, true)) {
    l.line(line, { size: TITLE_SIZE, bold: true, leading: TITLE_LEADING });
  }
  l.gap(6);

  for (const block of blocks) {
    switch (block.kind) {
      case 'meta':
        for (const line of block.lines) layoutParagraph(l, line, { muted: true });
        l.gap(BLOCK_GAP);
        break;
      case 'heading':
        l.ensure(HEADING_SIZE + BODY_LEADING * 2); // keep headings with some content
        layoutParagraph(l, block.text, { size: HEADING_SIZE, bold: true, leading: HEADING_SIZE + 4 });
        l.gap(2);
        break;
      case 'paragraph':
        layoutParagraph(l, block.text, { muted: block.muted });
        l.gap(BLOCK_GAP);
        break;
      case 'keyValues':
        layoutKeyValues(l, block.entries);
        l.gap(BLOCK_GAP);
        break;
      case 'list':
        layoutList(l, block.items);
        l.gap(BLOCK_GAP);
        break;
      case 'table':
        layoutTable(l, block);
        l.gap(BLOCK_GAP);
        break;
    }
  }
}

// ── document assembly ────────────────────────────────────────────────────────

function pageContentStream(page: Page): string {
  const ops: string[] = [];
  for (const rule of page.rules) {
    ops.push(`0.6 G 0.5 w ${rule.x1} ${rule.y} m ${rule.x2} ${rule.y} l S`);
  }
  for (const run of page.texts) {
    const font = run.bold ? 'F1' : 'F2';
    const gray = run.muted ? '0.45' : '0';
    const text = escapePdfString(toWinAnsi(run.text));
    ops.push(
      `BT ${gray} g /${font} ${run.size} Tf ${round(run.x)} ${round(run.y)} Td (${text}) Tj ET`,
    );
  }
  return ops.join('\n');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function assemble(pages: Page[]): Buffer {
  const pageObjNum = (i: number) => 5 + i * 2;
  const contentObjNum = (i: number) => 6 + i * 2;
  const objectCount = 4 + pages.length * 2;

  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;
  const push = (text: string) => {
    const buf = Buffer.from(text, 'latin1');
    chunks.push(buf);
    position += buf.length;
  };
  const pushObj = (num: number, body: string) => {
    offsets[num] = position;
    push(`${num} 0 obj\n${body}\nendobj\n`);
  };

  // Binary comment line after the header marks the file as 8-bit data.
  push('%PDF-1.4\n%âãÏÓ\n');
  pushObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const kids = pages.map((_, i) => `${pageObjNum(i)} 0 R`).join(' ');
  pushObj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pushObj(
    3,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  );
  pushObj(
    4,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  );
  pages.forEach((page, i) => {
    pushObj(
      pageObjNum(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObjNum(i)} 0 R >>`,
    );
    const content = pageContentStream(page);
    pushObj(
      contentObjNum(i),
      `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    );
  });

  const xrefStart = position;
  const xrefEntries = [`0000000000 65535 f \n`];
  for (let num = 1; num <= objectCount; num += 1) {
    xrefEntries.push(`${String(offsets[num]).padStart(10, '0')} 00000 n \n`);
  }
  push(
    `xref\n0 ${objectCount + 1}\n${xrefEntries.join('')}` +
      `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

// ── public API ───────────────────────────────────────────────────────────────

export function renderReportPdf(title: string, blocks: PdfBlock[]): Buffer {
  const layout = new Layout();
  layoutBlocks(layout, title, blocks);
  return assemble(layout.pages);
}

export function renderTextPdf(title: string, lines: string[]): Buffer {
  return renderReportPdf(title, [
    { kind: 'meta', lines: [`Generated ${new Date().toISOString()}`] },
    ...lines.map<PdfBlock>((text) => ({ kind: 'paragraph', text })),
  ]);
}
