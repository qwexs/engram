import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { awaitHandoffFile } from "../src/oll/handoff-watcher";
import { NightlyBatchStateV1, NightlyStateError, NightlyStateStore, nightlyBatchDirectory } from "../src/oll/nightly-state-store";
import { sha256Digest } from "../src/oll/handoff-v2";

const roots: string[] = [];

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function batch(lease: any): Omit<NightlyBatchStateV1, "revision"> {
  return {
    schemaVersion: 1,
    batchId: "nightly-2026-08-11T00:40:00Z",
    mode: "daily",
    status: "pending",
    registryDigest: sha256Digest("registry"),
    configDigest: sha256Digest("config"),
    lease: {
      ownerToken: lease.ownerToken,
      fencingGeneration: lease.fencingGeneration,
      acquiredAt: lease.acquiredAt,
      expiresAt: lease.expiresAt,
    },
    workspaceQueue: ["alpha", "beta"],
    activeWorkspace: null,
    activeRunId: null,
    activeEvaluationId: null,
    activeAttempt: null,
    activeContextDigest: null,
    activeHandoffPath: null,
    completed: [],
    failed: [],
    startedAt: "2026-08-11T00:40:00.000Z",
    updatedAt: "2026-08-11T00:40:00.000Z",
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("PR 5 fenced lease and CAS state", () => {
  test("stale takeover fences the old holder from batch writes and release", () => {
    const store = new NightlyStateStore(temp("engram-nightly-state-"));
    const first = store.acquireLease({ ownerToken: "11111111-1111-4111-8111-111111111111", now: "2026-08-11T00:40:00.000Z", ttlSeconds: 600 });
    const created = store.createBatch(batch(first), first);
    expect(() => store.acquireLease({ ownerToken: "22222222-2222-4222-8222-222222222222", now: "2026-08-11T00:45:00.000Z", ttlSeconds: 600 })).toThrow("held by another owner");
    const second = store.acquireLease({ ownerToken: "22222222-2222-4222-8222-222222222222", now: "2026-08-11T00:51:00.000Z", ttlSeconds: 600 });
    expect(second.fencingGeneration).toBe(first.fencingGeneration + 1);
    expect(() => store.writeBatch({ ...created, updatedAt: "2026-08-11T00:51:01.000Z" }, created.revision, first)).toThrow(NightlyStateError);
    expect(() => store.releaseLease(first)).toThrow("fenced");
    const updated = store.writeBatch({
      ...created,
      lease: { ownerToken: second.ownerToken, fencingGeneration: second.fencingGeneration, acquiredAt: second.acquiredAt, expiresAt: second.expiresAt },
      status: "reconciling",
      activeWorkspace: "alpha",
      updatedAt: "2026-08-11T00:51:01.000Z",
    }, created.revision, second);
    expect(updated).toMatchObject({ revision: 2, status: "reconciling", activeWorkspace: "alpha" });
    expect(() => store.writeBatch({ ...updated, status: "preflight" }, created.revision, second)).toThrow("revision mismatch");
    store.releaseLease(second);
  });

  test("batch events are immutable, ordered, and current-batch points to durable state", () => {
    const root = temp("engram-nightly-events-");
    const store = new NightlyStateStore(root);
    const lease = store.acquireLease({ now: "2026-08-11T00:40:00.000Z", ttlSeconds: 600 });
    const created = store.createBatch(batch(lease), lease);
    const first = store.appendEvent(created.batchId, { workspaceId: null, runId: null, transition: "batch_started", errorClass: null, details: {}, createdAt: created.startedAt });
    const second = store.appendEvent(created.batchId, { workspaceId: "alpha", runId: null, transition: "reconciling", errorClass: null, details: {}, createdAt: created.startedAt });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.readCurrentBatchId()).toBe(created.batchId);
    expect(readFileSync(join(nightlyBatchDirectory(root, created.batchId), "events", `00000001-${first.eventId}.json`), "utf8")).toContain('"batch_started"');
  });
});

describe("PR 5 bounded filesystem handoff watcher", () => {
  test("returns an already-existing handoff before watch registration", async () => {
    const root = temp("engram-watcher-existing-");
    const path = join(root, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.json");
    writeFileSync(path, "{}\n");
    await expect(awaitHandoffFile(path, 1000)).resolves.toMatchObject({
      status: "file",
      observedPath: path,
      errorClass: null,
    });
  });

  test("observes a later atomic rename without interval polling", async () => {
    const root = temp("engram-watcher-rename-");
    const path = join(root, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.json");
    const staged = join(root, ".staged.json");
    const pending = awaitHandoffFile(path, 2000);
    setTimeout(() => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(staged, "{}\n");
      renameSync(staged, path);
    }, 20);
    await expect(pending).resolves.toMatchObject({ status: "file", observedPath: path });
    const source = readFileSync(join(import.meta.dir, "..", "src", "oll", "handoff-watcher.ts"), "utf8");
    expect(source).not.toContain("setInterval");
  });

  test("returns a typed timeout", async () => {
    const root = temp("engram-watcher-timeout-");
    const path = join(root, "cccccccc-cccc-4ccc-8ccc-cccccccccccc.json");
    await expect(awaitHandoffFile(path, 10)).resolves.toMatchObject({ status: "timeout", errorClass: "handoff_timeout", observedPath: null });
  });
});
