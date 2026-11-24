import React from "react";
import { RetrievedChunk } from "../types";

interface MarkdownRendererProps {
  content: string;
  sources?: RetrievedChunk[];
  onSelectCitation?: (chunk: RetrievedChunk) => void;
}

function renderInlineSegments(
  text: string,
  sources: RetrievedChunk[],
  onSelectCitation?: (chunk: RetrievedChunk) => void
): React.ReactNode[] {
  // Match inline code, bold, italic, and bracketed citations like [File.pdf, p. 2]
  const tokenRegex =
    /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^[\]]+?,\s*p\.\s*\d+\])/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let keyIdx = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];

    if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(
        <code
          key={`code-${keyIdx++}`}
          className="px-1.5 py-0.5 rounded-md bg-blue-500/15 border border-blue-400/20 font-mono text-[12px] text-cyan-700 dark:text-cyan-300"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(
        <strong key={`b-${keyIdx++}`} className="font-semibold text-[var(--dm-text)]">
          {renderInlineSegments(token.slice(2, -2), sources, onSelectCitation)}
        </strong>
      );
    } else if (token.startsWith("*") && token.endsWith("*")) {
      parts.push(
        <em key={`i-${keyIdx++}`} className="italic text-[var(--dm-text-secondary)]">
          {token.slice(1, -1)}
        </em>
      );
    } else if (token.startsWith("[") && token.endsWith("]")) {
      const inner = token.slice(1, -1);
      const citeMatch = /^(.+?),\s*p\.\s*(\d+)$/i.exec(inner);
      if (citeMatch) {
        const citeFile = citeMatch[1].trim();
        const citePage = Number(citeMatch[2]);
        const matchedChunk = sources.find(
          (s) =>
            s.filename.toLowerCase() === citeFile.toLowerCase() &&
            s.page_number === citePage
        ) || sources.find((s) => s.filename.toLowerCase() === citeFile.toLowerCase());

        if (matchedChunk && onSelectCitation) {
          parts.push(
            <button
              key={`cite-${keyIdx++}`}
              type="button"
              onClick={() => onSelectCitation(matchedChunk)}
              title={`Inspect ${matchedChunk.filename}, page ${matchedChunk.page_number}`}
              className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 rounded-md bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/30 font-mono text-[11px] text-cyan-700 dark:text-cyan-300 transition-colors cursor-pointer align-baseline"
            >
              <span>{citeFile}</span>
              <span aria-hidden="true">·</span>
              <span>p.{citePage}</span>
            </button>
          );
        } else {
          parts.push(
            <span
              key={`cite-static-${keyIdx++}`}
              className="inline-flex items-center gap-1 mx-0.5 px-1.5 py-0.5 rounded-md bg-blue-500/15 border border-blue-400/25 font-mono text-[11px] text-blue-700 dark:text-blue-300 align-baseline"
            >
              {citeFile} · p.{citePage}
            </span>
          );
        }
      } else {
        parts.push(token);
      }
    }

    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({
  content,
  sources = [],
  onSelectCitation,
}) => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code blocks
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(
        <div
          key={`pre-${blocks.length}`}
          className="my-2 rounded-xl overflow-hidden border border-[var(--dm-border)] bg-[var(--dm-bg)]"
        >
          {lang && (
            <div className="px-3 py-1.5 border-b border-[var(--dm-border)] text-[11px] font-mono text-[var(--dm-text-muted)]">
              {lang}
            </div>
          )}
          <pre className="p-3 overflow-x-auto font-mono text-xs text-[var(--dm-text-secondary)] leading-relaxed">
            <code>{codeLines.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    // Blank lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // Headings
    const headingMatch = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      const cls =
        level === 1
          ? "font-display text-base font-bold text-[var(--dm-text)] mt-2"
          : level === 2
          ? "font-display text-sm font-semibold text-[var(--dm-text)] mt-2"
          : "font-display text-sm font-medium text-[var(--dm-text)] mt-1";
      blocks.push(
        <p key={`h-${blocks.length}`} className={cls}>
          {renderInlineSegments(text, sources, onSelectCitation)}
        </p>
      );
      i++;
      continue;
    }

    // Blockquotes
    if (line.trim().startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("> ")) {
        quoteLines.push(lines[i].trim().slice(2));
        i++;
      }
      blocks.push(
        <blockquote
          key={`bq-${blocks.length}`}
          className="my-1.5 px-3.5 py-2 rounded-xl bg-[var(--dm-bg-secondary)] border border-[var(--dm-border)] text-sm text-[var(--dm-text-muted)] italic"
        >
          {renderInlineSegments(quoteLines.join(" "), sources, onSelectCitation)}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-1.5 space-y-1.5 pl-4 list-disc marker:text-blue-400">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm text-[var(--dm-text-secondary)] leading-relaxed">
              {renderInlineSegments(item, sources, onSelectCitation)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push(
        <ol key={`ol-${blocks.length}`} className="my-1.5 space-y-1.5 pl-5 list-decimal marker:text-cyan-400">
          {items.map((item, idx) => (
            <li key={idx} className="text-sm text-[var(--dm-text-secondary)] leading-relaxed">
              {renderInlineSegments(item, sources, onSelectCitation)}
            </li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraph
    const paraLines: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,3}\s|```|>\s|\s*[-*]\s|\s*\d+\.\s)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push(
      <p key={`p-${blocks.length}`} className="text-sm text-[var(--dm-text-secondary)] leading-relaxed">
        {renderInlineSegments(paraLines.join(" "), sources, onSelectCitation)}
      </p>
    );
  }

  return <div className="space-y-2">{blocks}</div>;
};
