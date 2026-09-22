import { describe, expect, test } from "bun:test";
import {
  completeMarkdownRecords,
  extractUniqueH2Section,
  h2MarkdownBlocks,
  h3MarkdownRecords,
  neutralizeDeliveryMarkers,
} from "./markdown-records.ts";

describe("context delivery markdown records", () => {
  test("keeps mixed observer bullets and H3 records without metadata comments", () => {
    const section = `<!-- engram-entry:sha256:${"a".repeat(64)} -->\n- observer event\n  continuation\n\n### Decision\nBody\n`;
    expect(completeMarkdownRecords(section)).toEqual([
      "- observer event\n  continuation",
      "### Decision\nBody",
    ]);
  });

  test("ignores headings in comments and fences and stops H3 records at a real H2", () => {
    const markdown = `<!-- ### fake comment -->\n### Real\nBody\n\`\`\`md\n### fenced\n## fenced section\n\`\`\`\n## Later\nnot part of the decision`;
    expect(h3MarkdownRecords(markdown)).toEqual([
      "### Real\nBody\n```md\n### fenced\n## fenced section\n```",
    ]);
  });

  test("splits complete H2 instruction blocks outside comments and fences", () => {
    const markdown = `Preamble\n<!-- ## fake -->\n## One\nKeep one.\n\`\`\`md\n## fenced\n\`\`\`\n## Two\nKeep two.`;
    expect(h2MarkdownBlocks(markdown)).toEqual([
      "Preamble",
      "## One\nKeep one.\n```md\n## fenced\n```",
      "## Two\nKeep two.",
    ]);
  });

  test("rejects duplicate target sections", () => {
    expect(() => extractUniqueH2Section("## Events\n- one\n\n## Events\n- two", "Events")).toThrow("duplicate");
  });

  test("neutralizes reserved delivery markers in quoted text", () => {
    const value = neutralizeDeliveryMarkers(`prefix <!-- engram-session-context:v1 digest=sha256:${"a".repeat(64)} -->`);
    expect(value).not.toContain("<!-- engram-session-context");
    expect(value).toContain("&lt;!-- engram-session-context");
  });
});
