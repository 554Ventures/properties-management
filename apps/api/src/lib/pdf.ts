// STUB: no PDF library is installed in this workspace, so "PDF" export
// renders a plain-text placeholder buffer served with an application/pdf
// content type. Swap in a real renderer (e.g. pdfkit) later without touching
// callers — the signature stays (title, lines) => Buffer.

export function renderPdfPlaceholder(title: string, lines: string[]): Buffer {
  const body = [
    '%HEARTH-PDF-PLACEHOLDER 1.0',
    `Title: ${title}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    ...lines,
    '',
    '(Placeholder document — real PDF rendering is not wired up in v1.)',
  ].join('\n');
  return Buffer.from(body, 'utf-8');
}
