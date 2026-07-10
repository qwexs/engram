import { test, expect, describe, beforeEach } from "bun:test";
import {
  enqueueSystemEventToSession,
  readLatestSystemEventHash,
  type SpawnSyncLike,
} from "./system-event.js";

let calls: { bin: string; args: string[]; options: any }[] = [];

beforeEach(() => {
  calls = [];
});

function fakeSpawnOk(): SpawnSyncLike {
  return {
    pid: 12345,
    output: [null, Buffer.from('{"ok":true}\n'), Buffer.from("")],
    stdout: '{"ok":true}\n',
    stderr: "",
    status: 0,
    signal: null,
  };
}

function fakeSpawnFail(status: number, stderr: string): SpawnSyncLike {
  return {
    pid: 0,
    output: [null, Buffer.from(""), Buffer.from(stderr)],
    stdout: "",
    stderr,
    status,
    signal: null,
  };
}

function recordingSpawnFactory(result: SpawnSyncLike) {
  return (bin: string, args: string[], options?: any): SpawnSyncLike => {
    calls.push({ bin, args, options });
    return result;
  };
}

// =========================================================================
// enqueueSystemEventToSession
// =========================================================================

describe("enqueueSystemEventToSession — input validation", () => {
  test("empty sessionKey → ok:false error:empty sessionKey", () => {
    const r = enqueueSystemEventToSession({ sessionKey: "", text: "hi", spawnFn: recordingSpawnFactory(fakeSpawnOk()) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty sessionKey");
    expect(calls).toHaveLength(0);
  });

  test("whitespace-only sessionKey → ok:false", () => {
    const r = enqueueSystemEventToSession({ sessionKey: "   ", text: "hi", spawnFn: recordingSpawnFactory(fakeSpawnOk()) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("empty text → ok:false error:empty text", () => {
    const r = enqueueSystemEventToSession({ sessionKey: "agent:x:telegram", text: "", spawnFn: recordingSpawnFactory(fakeSpawnOk()) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("empty text");
    expect(calls).toHaveLength(0);
  });

  test("whitespace-only text → ok:false", () => {
    const r = enqueueSystemEventToSession({ sessionKey: "agent:x:telegram", text: "   \n  ", spawnFn: recordingSpawnFactory(fakeSpawnOk()) });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("enqueueSystemEventToSession — happy path", () => {
  test("ok exit → ok:true with stdout + bytesSent", () => {
    const r = enqueueSystemEventToSession({
      sessionKey: "agent:x:telegram:group:--100xxx-topic:60",
      text: "hello",
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bytesSent).toBe(Buffer.byteLength("hello", "utf-8"));
      expect(r.sessionKey).toBe("agent:x:telegram:group:--100xxx-topic:60");
      expect(r.mode).toBe("now");
    }
  });

  test("spawn called with correct argv shape", () => {
    enqueueSystemEventToSession({
      sessionKey: "SK",
      text: "T",
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c.bin).toBe("openclaw");
    expect(c.args).toEqual([
      "system", "event",
      "--mode", "now",
      "--session-key", "SK",
      "--text", "T",
      "--timeout", "10000",
    ]);
  });

  test("custom openclawBin is used", () => {
    enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      openclawBin: "/custom/path/openclaw",
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    expect(calls[0].bin).toBe("/custom/path/openclaw");
  });

  test("timeoutMs=100 clamps CLI timeout to 1000ms minimum (spawnSync.timeout is raw+2000)", () => {
    enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      timeoutMs: 100,
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    // argv index layout:
    //   0:system 1:event 2:--mode 3:now 4:--session-key 5:SK 6:--text 7:T 8:--timeout 9:<clamp>
    expect(calls[0].args[8]).toBe("--timeout");
    expect(calls[0].args[9]).toBe("1000"); // CLI gets clamped minimum 1000
    // spawnSync.timeout is `timeoutMs + 2000` (NOT clamped), giving the
    // surrounding process a small extra margin to die after the CLI itself.
    expect(calls[0].options.timeout).toBe(2100);
  });

  test("timeoutMs=0 clamps to 1000ms minimum", () => {
    enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      timeoutMs: 0,
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    expect(calls[0].args[8]).toBe("--timeout");
    expect(calls[0].args[9]).toBe("1000");
  });

  test("UTF-8 multi-byte text → bytesSent reflects UTF-8 length", () => {
    const text = "привет мир"; // 10 chars, 19 bytes in UTF-8
    const r = enqueueSystemEventToSession({
      sessionKey: "SK", text,
      spawnFn: recordingSpawnFactory(fakeSpawnOk()),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytesSent).toBe(19);
  });
});

describe("enqueueSystemEventToSession — failure modes", () => {
  test("exit code 1 → ok:false with stderr", () => {
    const r = enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      spawnFn: recordingSpawnFactory(fakeSpawnFail(1, "no session found")),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("exit 1");
    if (!r.ok) expect(r.error).toContain("no session found");
  });

  test("exit code 2 with empty stderr/stdout → '(no output)'", () => {
    const r = enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      spawnFn: recordingSpawnFactory(fakeSpawnFail(2, "")),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("(no output)");
  });

  test("spawn throws → ok:false with error:spawn failed", () => {
    const throws: SpawnSyncLike = Object.assign(new Error("boom"), { status: null });
    (throws as any).error = throws;
    const r = enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      spawnFn: () => { throw new Error("spawn exploded"); },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("spawn failed");
  });

  test("result.error set without throw → ok:false error:spawn error", () => {
    const result: SpawnSyncLike = {
      error: new Error("econnrefused"),
      status: null,
    };
    const r = enqueueSystemEventToSession({
      sessionKey: "SK", text: "T",
      spawnFn: recordingSpawnFactory(result),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("spawn error");
  });
});

// =========================================================================
// readLatestSystemEventHash
// =========================================================================

describe("readLatestSystemEventHash", () => {
  test("null input → null", () => {
    expect(readLatestSystemEventHash(null)).toBeNull();
  });

  test("undefined input → null", () => {
    expect(readLatestSystemEventHash(undefined)).toBeNull();
  });

  test("empty string → null", () => {
    expect(readLatestSystemEventHash("")).toBeNull();
  });

  test("text without marker → null", () => {
    expect(readLatestSystemEventHash("hello world")).toBeNull();
  });

  test("single marker → that hash", () => {
    expect(readLatestSystemEventHash("<!-- engram-system-event-hash:abcd1234 -->")).toBe("abcd1234");
  });

  test("multiple markers → LAST wins", () => {
    const text = `
<!-- engram-system-event-hash:11111111 -->
blah blah
<!-- engram-system-event-hash:22222222 -->
`;
    expect(readLatestSystemEventHash(text)).toBe("22222222");
  });

  test("`domain-context:` marker is ignored (different regex)", () => {
    const text = `<!-- domain-context:engram:abcdef012345 -->`;
    expect(readLatestSystemEventHash(text)).toBeNull();
  });

  test("hash shorter than 8 hex → no match", () => {
    expect(readLatestSystemEventHash("<!-- engram-system-event-hash:abc123 -->")).toBeNull();
  });

  test("non-hex hash → no match", () => {
    expect(readLatestSystemEventHash("<!-- engram-system-event-hash:zzzzzzzz -->")).toBeNull();
  });
});
