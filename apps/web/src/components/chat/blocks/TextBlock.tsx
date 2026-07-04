// Markdown-lite prose block (§5: bold, unordered lists, line breaks). A tiny
// hand-rolled parser building React nodes — no dependency, and no
// dangerouslySetInnerHTML anywhere, so model output can never inject markup.
import { Fragment, useMemo, type ReactNode } from 'react';
import type { TextBlock as TextBlockData } from '@hearth/shared';

/** `**bold**` spans → <strong>; everything else is plain text. */
function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const bold = /\*\*(.+?)\*\*/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = bold.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(<strong key={`b${key++}`}>{match[1]}</strong>);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const LIST_MARKER = /^\s*[-*•]\s+/;

function parseMarkdownLite(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const lines = paragraph;
    paragraph = [];
    nodes.push(
      <p key={`p${nodes.length}`}>
        {lines.map((line, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>,
    );
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems;
    listItems = [];
    nodes.push(
      <ul key={`ul${nodes.length}`} className="list-disc space-y-1 pl-5">
        {items.map((item, i) => (
          <li key={i}>{renderInline(item)}</li>
        ))}
      </ul>,
    );
  };

  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      flushParagraph();
      flushList();
    } else if (LIST_MARKER.test(line)) {
      flushParagraph();
      listItems.push(line.replace(LIST_MARKER, ''));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return nodes;
}

export function TextBlock({ block }: { block: TextBlockData }) {
  const nodes = useMemo(() => parseMarkdownLite(block.text), [block.text]);
  if (block.text.trim() === '') return null; // in-progress placeholder
  return <div className="flex flex-col gap-2 text-sm leading-relaxed text-ink">{nodes}</div>;
}
