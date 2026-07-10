/**
 * OpenClaw system-event delivery helper for engram hooks.
 *
 * Wraps `child_process.spawnSync("openclaw", ["system","event",...])` to
 * deliver a one-shot prompt fragment into a named session. Used by all v2+
 * engram domain-load hooks (`engram-topic-domain-load`, `apriori-peer-domain-load`,
 * and any future `*-domain-load` hook that follows the system-event pattern).
 *
 * Why system events instead of writing to the daily note on `message:received`:
 *   - The previous write-then-hope pattern relied on the agent reading the
 *     daily note to find the injected context blocks. Production showed this
 *     is unreliable — agents finish working on filesystem state and forget
 *     to call `message`. Side-effect-delivered payloads fix this by handing
 *     the system event directly to the gateway (see docs/cli/system.md).
 *   - The CLI is a thin RPC wrapper around the local gateway daemon
 *     (`docs/gateway/bridge-protocol.md`). For hooks, `spawnSync` is the
 *     simplest transport — no async races, no WebSocket lifecycle.
 *   - System events are **ephemeral**: lost on gateway restart
 *     (`docs/cli/system.md` "Notes"). Idempotency on the receiver side is
 *     achieved via the `<!-- engram-system-event-hash:<hash> -->` marker.
 *
 * @module _lib/system-event
 */

import { spawnSync } from "node:child_process";

/** Minimal shape of `child_process.SpawnSyncReturns<Buffer|string>` that we
 *  depend on. Defined explicitly so tests can pass a mock without importing
 *  the full child_process types. */
export type SpawnSyncLike = {
  pid?: number;
  output?: ReadonlyArray<unknown>;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status?: number | null;
  signal?: string | null;
  error?: Error;
};

export type EnqueueOpts = {
  sessionKey: string;
  text: string;
  /** Override the spawn function (used by tests). Defaults to `spawnSync`.
   *  Matches `child_process.spawnSync(bin, args, options)` — the third arg
   *  is forwarded as-is. */
  spawnFn?: (bin: string, args: string[], options?: any) => SpawnSyncLike;
  /** Override the CLI binary path (rare; defaults to `openclaw`). */
  openclawBin?: string;
  /** Max time to wait for the CLI to return. Default 10 000 ms. */
  timeoutMs?: number;
};

export type EnqueueResult =
  | { ok: true; mode: "now"; sessionKey: string; bytesSent: number; stdout: string }
  | { ok: false; error: string; sessionKey: string };

/**
 * Enqueue a one-shot system event into a session. Resolution model:
 *
 *   - `sessionKey` non-empty + `text` non-empty → spawn
 *     `openclaw system event --mode now --session-key <key> --text <text>`
 *     with timeout `--timeout max(1000, timeoutMs)` and `spawnSync.timeout =
 *     timeoutMs + 2000` (so spawn aborts just after the CLI's own deadline).
 *   - exit 0 → ok with bytesSent = UTF-8 byte length of `text` and stdout from CLI.
 *   - exit ≠ 0 → ok:false with stderr || stdout || "(no output)" appended.
 *   - spawn error / thrown → ok:false with error.message.
 *
 * No retry, no buffer — caller decides. For engram hooks, failure means
 * "skip this message; next inbound message retries" via hash mismatch.
 *
 * @example
 *   const r = enqueueSystemEventToSession({
 *     sessionKey: "agent:<id>:telegram-group:--100xxxxxxxxxx-topic:<n>",
 *     text: payload,
 *   });
 *   if (!r.ok) console.warn("system event failed:", r.error);
 */
export function enqueueSystemEventToSession(params: EnqueueOpts): EnqueueResult {
  const sessionKey = (params.sessionKey || "").trim();
  const text = params.text || "";

  if (!sessionKey) return { ok: false, error: "empty sessionKey", sessionKey: "" };
  if (!text.trim()) return { ok: false, error: "empty text", sessionKey };

  const bin = params.openclawBin || "openclaw";
  const timeoutMs = params.timeoutMs ?? 10_000;
  const spawn = params.spawnFn || spawnSync;

  let result: SpawnSyncLike;
  try {
    result = spawn(bin, [
      "system",
      "event",
      "--mode",
      "now",
      "--session-key",
      sessionKey,
      "--text",
      text,
      "--timeout",
      String(Math.max(1000, timeoutMs)),
    ], {
      encoding: "utf-8",
      timeout: timeoutMs + 2000,
      windowsHide: true,
    } as any) as SpawnSyncLike;
  } catch (e: any) {
    return { ok: false, error: `spawn failed: ${e?.message || String(e)}`, sessionKey };
  }

  if (result.error) {
    return {
      ok: false,
      error: `spawn error: ${result.error.message || String(result.error)}`,
      sessionKey,
    };
  }

  if (typeof result.status === "number" && result.status !== 0) {
    const stderr = String(result.stderr || "").trim();
    const stdout = String(result.stdout || "").trim();
    return {
      ok: false,
      error: `exit ${result.status}: ${stderr || stdout || "(no output)"}`,
      sessionKey,
    };
  }

  return {
    ok: true,
    mode: "now",
    sessionKey,
    bytesSent: Buffer.byteLength(text, "utf-8"),
    stdout: String(result.stdout || "").trim(),
  };
}

/** Regex marker for system-event idempotency. Captures 8 hex chars.
 *  Format reference: this file's `enqueueSystemEventToSession` payload is
 *  built by `domain-inject.buildDomainPayload`, which inserts the marker as
 *  one of the first lines of the injected text. */
const SYSTEM_EVENT_HASH_MARKER = /<!-- engram-system-event-hash:([a-f0-9]{8}) -->/g;

/**
 * Extract the last `<!-- engram-system-event-hash:<hash> -->` marker found
 * in `text`. Returns the 8-hex hash (without the marker) or null.
 *
 * Used by `domain-inject.readLatestHashFromNote` to drive idempotency on
 * the daily-note receiver side: if the agent already got the same hash
 * this turn, no need to re-inject.
 */
export function readLatestSystemEventHash(text: string | null | undefined): string | null {
  if (!text) return null;
  const re = new RegExp(SYSTEM_EVENT_HASH_MARKER.source, "g");
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m[1];
  }
  return last;
}
