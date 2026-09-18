const RESERVED_DELIVERY_MARKER = /<!--\s*engram-(?:context-delivery|context-source|kg-v3-current|bootstrap-context-hash|system-event-hash|session-context)\b/gi;

function withoutHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, "");
}

/** Prevent quoted memory from manufacturing rollout-audit markers. */
export function neutralizeDeliveryMarkers(markdown: string): string {
  return markdown.replace(RESERVED_DELIVERY_MARKER, (value) => value.replace("<!--", "&lt;!--"));
}

function structuralLines(markdown: string): Array<{ line: string; structural: boolean }> {
  const lines = withoutHtmlComments(markdown.replace(/\r/g, "")).split("\n");
  let fence: { marker: string; length: number } | null = null;
  return lines.map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    const structural = fence === null;
    if (match) {
      const marker = match[1]![0]!;
      const length = match[1]!.length;
      if (!fence) fence = { marker, length };
      else if (marker === fence.marker && length >= fence.length) fence = null;
    }
    return { line: neutralizeDeliveryMarkers(line), structural };
  });
}

/** Split a document into its preamble and complete H2 blocks. */
export function h2MarkdownBlocks(markdown: string): string[] {
  const lines = structuralLines(markdown);
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) blocks.push(value);
    current = [];
  };
  for (const entry of lines) {
    if (entry.structural && /^##\s+/.test(entry.line)) flush();
    current.push(entry.line);
  }
  flush();
  return blocks;
}

export function extractUniqueH2Section(markdown: string, heading: string): string {
  const lines = structuralLines(markdown);
  const starts = lines.flatMap((entry, index) => entry.structural && entry.line.trim() === `## ${heading}` ? [index] : []);
  if (starts.length > 1) throw new Error(`duplicate ## ${heading} section`);
  if (!starts.length) return "";
  const start = starts[0]!;
  const end = lines.findIndex((entry, index) => index > start && entry.structural && /^##\s+/.test(entry.line));
  return lines.slice(start + 1, end < 0 ? undefined : end).map((entry) => entry.line).join("\n").trim();
}

/** Parse mixed H3, bullet, and paragraph records without slicing record bodies. */
export function completeMarkdownRecords(markdown: string): string[] {
  const lines = structuralLines(markdown);
  const records: string[] = [];
  let current: string[] = [];
  let kind: "h3" | "bullet" | "paragraph" | null = null;
  const flush = () => {
    const value = current.join("\n").trim();
    if (value) records.push(value);
    current = [];
    kind = null;
  };
  for (const entry of lines) {
    const line = entry.line;
    if (entry.structural && /^##\s+/.test(line)) {
      flush();
      continue;
    }
    if (entry.structural && /^###\s+/.test(line)) {
      flush();
      current = [line];
      kind = "h3";
      continue;
    }
    if (entry.structural && /^[-*+]\s+/.test(line) && kind !== "h3") {
      flush();
      current = [line];
      kind = "bullet";
      continue;
    }
    if (!line.trim()) {
      if (kind === "h3") current.push("");
      else flush();
      continue;
    }
    if (!kind) kind = "paragraph";
    current.push(line);
  }
  flush();
  return records;
}

/** Every real H3 record in a document; comments/fences cannot create entries. */
export function h3MarkdownRecords(markdown: string): string[] {
  return completeMarkdownRecords(markdown).filter((record) => /^###\s+/.test(record));
}
