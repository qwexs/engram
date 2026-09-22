import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Markers emitted by current Engram bootstrap context hooks. */
export const CONTEXT_DELIVERY_MARKERS = {
  kg: /<!--\s*engram-kg-v3-current\s*-->/g,
  oll: /<!--\s*engram-bootstrap-context-hash:sha256:[a-f0-9]{64}\s*-->/g,
  domain: /<!--\s*engram-system-event-hash:[a-f0-9]{8}\s*-->/g,
  session: /<!--\s*engram-session-context:v1 digest=sha256:[a-f0-9]{64}\s*-->/g,
} as const;

const SHA256_CAPTURE = "(sha256:[a-f0-9]{64})";
const ENVELOPE_MARKER = new RegExp(
  `<!--\\s*engram-context-delivery:v1\\s+envelope=${SHA256_CAPTURE}\\s+policy=${SHA256_CAPTURE}\\s*-->`,
  "g",
);

export const CONTEXT_DELIVERY_SOURCE_MARKERS = {
  oll: new RegExp(`<!--\\s*engram-context-source:oll:v1\\s+digest=${SHA256_CAPTURE}\\s*-->`, "g"),
  domain: new RegExp(`<!--\\s*engram-context-source:domain:v1\\s+digest=${SHA256_CAPTURE}\\s*-->`, "g"),
  session: new RegExp(`<!--\\s*engram-context-source:session:v1\\s+digest=${SHA256_CAPTURE}\\s*-->`, "g"),
  kg: new RegExp(`<!--\\s*engram-context-source:kg:v3-current\\s+digest=${SHA256_CAPTURE}\\s*-->`, "g"),
} as const;

export type ContextDeliveryMarker = keyof typeof CONTEXT_DELIVERY_MARKERS;
export type RolloutInputFormat = "codex-response-item-v1" | "unsupported";

export type ContextDeliveryAudit = {
  schema: "engram.context-delivery-audit.v1";
  rolloutPath: string;
  /** `unsupported` means this file cannot be used as model-input evidence. */
  inputFormat: RolloutInputFormat;
  linesRead: number;
  inputMessages: number;
  inputBytes: number;
  firstAssistantLine: number | null;
  envelopes: Array<{ envelopeDigest: `sha256:${string}`; policyDigest: `sha256:${string}` }>;
  sourceMarkers: Record<ContextDeliveryMarker, { occurrences: number; artifactDigests: Array<`sha256:${string}`> }>;
  markers: Record<ContextDeliveryMarker, { present: boolean; occurrences: number }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!isRecord(part)) return "";
      return typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function occurrenceCount(text: string, marker: RegExp): number {
  // Clone it because global regular expressions retain lastIndex between calls.
  return [...text.matchAll(new RegExp(marker.source, marker.flags))].length;
}

function endsModelInput(payload: Record<string, unknown>): boolean {
  // In a valid Codex response_item stream, any non-message item is model
  // output (for example a function/custom tool call). Stop conservatively so
  // its later tool result cannot become false pre-assistant evidence.
  return payload.role === "assistant" || payload.type !== "message";
}

/**
 * Inspect Codex `response_item` JSONL only. The function deliberately does
 * not reinterpret other session-log formats: they are not model-input proof.
 */
export async function inspectRolloutModelInput(rolloutPath: string): Promise<ContextDeliveryAudit> {
  const counts = Object.fromEntries(
    Object.keys(CONTEXT_DELIVERY_MARKERS).map((name) => [name, 0]),
  ) as Record<ContextDeliveryMarker, number>;
  const sourceDigests: Record<ContextDeliveryMarker, Array<`sha256:${string}`>> = {
    oll: [],
    domain: [],
    session: [],
    kg: [],
  };
  const envelopes: ContextDeliveryAudit["envelopes"] = [];
  let linesRead = 0;
  let inputMessages = 0;
  let inputBytes = 0;
  let firstAssistantLine: number | null = null;
  let sawResponseItem = false;

  const lines = createInterface({
    input: createReadStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  for await (const line of lines) {
    linesRead += 1;
    if (!line.trim()) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      lines.close();
      throw new Error(`invalid rollout JSONL at line ${linesRead}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isRecord(record) || record.type !== "response_item") continue;
    sawResponseItem = true;
    const payload = isRecord(record.payload) ? record.payload : null;
    if (!payload) continue;
    if (endsModelInput(payload)) {
      firstAssistantLine = linesRead;
      break;
    }
    if (payload.role !== "system" && payload.role !== "developer" && payload.role !== "user") continue;
    const text = messageText(payload.content);
    inputMessages += 1;
    inputBytes += Buffer.byteLength(text, "utf8");
    for (const [name, marker] of Object.entries(CONTEXT_DELIVERY_MARKERS) as Array<[ContextDeliveryMarker, RegExp]>) {
      counts[name] += occurrenceCount(text, marker);
    }
    for (const match of text.matchAll(new RegExp(ENVELOPE_MARKER.source, ENVELOPE_MARKER.flags))) {
      envelopes.push({
        envelopeDigest: match[1] as `sha256:${string}`,
        policyDigest: match[2] as `sha256:${string}`,
      });
    }
    for (const [name, marker] of Object.entries(CONTEXT_DELIVERY_SOURCE_MARKERS) as Array<[ContextDeliveryMarker, RegExp]>) {
      for (const match of text.matchAll(new RegExp(marker.source, marker.flags))) {
        sourceDigests[name].push(match[1] as `sha256:${string}`);
      }
    }
  }

  return {
    schema: "engram.context-delivery-audit.v1",
    rolloutPath,
    inputFormat: sawResponseItem ? "codex-response-item-v1" : "unsupported",
    linesRead,
    inputMessages,
    inputBytes,
    firstAssistantLine,
    envelopes,
    sourceMarkers: Object.fromEntries(
      Object.entries(sourceDigests).map(([name, artifactDigests]) => [name, {
        occurrences: artifactDigests.length,
        artifactDigests,
      }]),
    ) as ContextDeliveryAudit["sourceMarkers"],
    markers: Object.fromEntries(
      Object.entries(counts).map(([name, occurrences]) => [name, { present: occurrences > 0, occurrences }]),
    ) as ContextDeliveryAudit["markers"],
  };
}
