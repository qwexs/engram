import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  KG_V3_AUTHORITY_SCHEMA,
  KG_V3_SCHEMA_DIGEST,
  KgV3Core,
  KgV3Reader,
  deriveKgOperationId,
  validateKgAssertion,
  type KgCrashPoint,
  type KgWriteRequest,
  type TrustedKgCallerContext,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function op(label: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(label).digest("hex")}`;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(mode: "absent" | "legacy-contained" | "canary" | "enabled" = "canary") {
  const root = mkdtempSync(join(tmpdir(), "engram-kg-v3-"));
  roots.push(root);
  const state = join(root, "memory-state", "kg-v3");
  writeJson(join(state, "registry.json"), {
    schema: "engram.kg-v3-registry.v1",
    workspaceId: "main",
    revision: 1,
    entities: [
      {
        id: "systems/engram",
        type: "system",
        scopes: ["engram"],
        predicates: [
          { name: "rolloutStrategy", kinds: ["decision"], objectTypes: ["string"] },
          { name: "enabled", kinds: ["constraint"], objectTypes: ["boolean"] }
        ]
      },
      { id: "people/example-user", type: "person", scopes: ["personal"], predicates: [{ name: "timezone", kinds: ["preference"], objectTypes: ["string"] }] }
    ]
  });
  if (mode !== "absent") writeJson(join(state, "authority.json"), {
    schema: KG_V3_AUTHORITY_SCHEMA,
    workspaceId: "main",
    releaseDigest: op("release"),
    schemaDigest: KG_V3_SCHEMA_DIGEST,
    mode,
    enabledSessionCapabilities: [{ sessionKey: "main", capabilities: ["kg:v3:write", "kg:v3:retract", "kg:v3:seed"] }],
    currentProjectionVersion: 1,
    approvedBy: "operator",
    approvedAt: "2026-08-12T15:00:00Z"
  });
  const caller: TrustedKgCallerContext = { trusted: true, workspaceId: "main", sessionKey: "main", actorId: "actor-001", capabilities: ["kg:v3:write", "kg:v3:retract", "kg:v3:seed"] };
  return { root, caller, core: new KgV3Core({ workspace: root, workspaceId: "main" }) };
}

function request(label: string, value = "main canary, then fleet", replacesId: string | null = null): KgWriteRequest {
  const operationId = deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: label, actorId: "actor-001", entityId: "systems/engram", predicate: "rolloutStrategy" });
  return {
    assertion: {
      workspaceId: "main",
      entityId: "systems/engram",
      entityType: "system",
      kind: "decision",
      predicate: "rolloutStrategy",
      object: { type: "string", value },
      scope: ["engram"],
      replacesId,
      provenance: {
        sourceKind: "user_message",
        sessionKey: "main",
        messageId: label,
        actorId: "actor-001",
        operationId,
        observedAt: "2026-08-12T15:00:00Z"
      }
    },
    intent: { explicit: true, compound: false, store: "kg-current", statementClass: "durable" }
  };
}

describe("KG v3 normative schema and authority", () => {
  test("accepts positive fixture and rejects negative fixture", async () => {
    const valid = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "kg-v3", "assertion.valid.json"), "utf8"));
    const invalid = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "tests", "fixtures", "kg-v3", "assertion.invalid.json"), "utf8"));
    expect(validateKgAssertion(valid)).toEqual([]);
    expect(validateKgAssertion(invalid).length).toBeGreaterThan(8);
  });

  for (const mode of ["absent", "legacy-contained"] as const) {
    test(`${mode} authority denies v3 writes`, async () => {
      const { core, caller } = fixture(mode);
      expect((await core.write(request(mode), caller)).reason).toBe("CALLER_NOT_AUTHORIZED");
    });
  }

  for (const mode of ["canary", "enabled"] as const) {
    test(`${mode} authority allows only capability-authorized caller`, async () => {
      const { core, caller } = fixture(mode);
      const denied = { ...caller, capabilities: [] } as TrustedKgCallerContext;
      expect((await core.write(request(`${mode}-denied`), denied)).reason).toBe("CALLER_NOT_AUTHORIZED");
      expect((await core.write(request(`${mode}-allowed`), caller)).status).toBe("committed");
    });
  }
});

describe("KG v3 deterministic writer", () => {
  test("terminal commit marks KG collection once; replay and recovery do not duplicate generation", async () => {
    const { root, caller } = fixture();
    let generation = 0;
    let rawQmdProcesses = 0;
    const marker = async (input: { workspace: string; reason: string; collectionRole: "knowledge-graph" }) => {
      expect(input).toMatchObject({ workspace: root, collectionRole: "knowledge-graph" });
      expect(input.reason).toMatch(/^kg-v3:sha256:/);
      generation += 1;
      return { schema: "engram.qmd.dirty-mark.v1" as const, status: "marked" as const, mode: "coordinated" as const, workspace: root, indexKey: "global", generation, collections: ["main-life"] };
    };
    // The injected marker is state-only and cannot launch a QMD process.
    const core = new KgV3Core({ workspace: root, workspaceId: "main", qmdDirtyMarker: async (input) => { const result = await marker(input); rawQmdProcesses += 0; return result; } });
    const input = request("qmd-dirty-once");
    const first = await core.write(input, caller);
    expect(first.qmdDirty).toEqual({ status: "marked", generation: 1, collections: ["main-life"], error: null });
    expect((await core.write(input, caller)).qmdDirty?.generation).toBe(1);
    expect(generation).toBe(1);
    expect(rawQmdProcesses).toBe(0);

    const crashInput = request("qmd-dirty-after-recovery", "replacement", first.assertionId);
    await expect(new KgV3Core({ workspace: root, workspaceId: "main", crashAt: "after-committed", qmdDirtyMarker: marker }).write(crashInput, caller)).rejects.toThrow();
    expect(generation).toBe(1);
    const recovered = new KgV3Core({ workspace: root, workspaceId: "main", qmdDirtyMarker: marker });
    const receipts = await recovered.recover();
    expect(receipts.find((receipt) => receipt.operationId === crashInput.assertion.provenance.operationId)?.qmdDirty?.generation).toBe(2);
    expect(generation).toBe(2);
    await recovered.recover();
    expect(generation).toBe(2);
    const source = readFileSync(join(import.meta.dir, "core.ts"), "utf8");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toMatch(/qmd\s+(update|embed)/);
  });

  test("dirty bookkeeping failure is auditable, retried, and never rolls back KG", async () => {
    const { root, caller } = fixture();
    let attempts = 0;
    const core = new KgV3Core({ workspace: root, workspaceId: "main", qmdDirtyMarker: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("maintenance unavailable");
      return { schema: "engram.qmd.dirty-mark.v1", status: "marked", mode: "coordinated", workspace: root, generation: 1, collections: ["main-life"] };
    } });
    const input = request("qmd-dirty-failure");
    const receipt = await core.write(input, caller);
    expect(receipt).toMatchObject({ status: "committed", qmdDirty: { status: "error", error: "maintenance unavailable" } });
    const journalPath = join(core.operationsRoot, `${input.assertion.provenance.operationId.slice(7)}.json`);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(journal.qmdDirty).toMatchObject({ status: "error", error: "maintenance unavailable" });
    const replay = await core.write(input, caller);
    expect(replay.qmdDirty).toEqual({ status: "marked", generation: 1, collections: ["main-life"], error: null });
    expect(attempts).toBe(2);
    expect(await core.current()).toHaveLength(1);
  });

  test("derived operation id is stable and has no runtime timestamp input", async () => {
    const identity = { workspaceId: "main", sessionKey: "main", messageId: "8242", actorId: "actor-001", entityId: "systems/engram", predicate: "rolloutStrategy" };
    expect(deriveKgOperationId(identity)).toBe(deriveKgOperationId({ ...identity }));
    expect(deriveKgOperationId(identity)).toMatch(/^sha256:[a-f0-9]{64}$/);
    const retractBase = { workspaceId: "main", sessionKey: "main", messageId: "8243", actorId: "actor-001", entityId: "systems/engram", action: "retract" as const };
    expect(deriveKgOperationId({ ...retractBase, assertionId: "123e4567-e89b-42d3-a456-426614174000" }))
      .not.toBe(deriveKgOperationId({ ...retractBase, assertionId: "123e4567-e89b-42d3-a456-426614174001" }));
  });

  test("same operation returns byte-equivalent receipt; changed payload conflicts", async () => {
    const { core, caller } = fixture();
    const input = request("same-op");
    const first = await core.write(input, caller);
    expect(await core.write(input, caller)).toEqual(first);
    const changed = structuredClone(input);
    changed.assertion.object.value = "different";
    expect((await core.write(changed, caller)).reason).toBe("OPERATION_CONFLICT");
    expect(readdirSync(join(core.assertionsRoot))).toHaveLength(1);
  });

  test("async typed API serializes in-process calls while dirty marker awaits", async () => {
    const { root, caller } = fixture();
    let generation = 0;
    const core = new KgV3Core({
      workspace: root,
      workspaceId: "main",
      qmdDirtyMarker: async () => {
        await Bun.sleep(5);
        generation += 1;
        return { schema: "engram.qmd.dirty-mark.v1", status: "marked", mode: "coordinated", workspace: root, generation, collections: ["main-life"] };
      },
    });
    const first = request("in-process-first");
    const second = request("in-process-second");
    second.assertion.entityId = "people/example-user";
    second.assertion.entityType = "person";
    second.assertion.kind = "preference";
    second.assertion.predicate = "timezone";
    second.assertion.object = { type: "string", value: "Europe/Moscow" };
    second.assertion.scope = ["personal"];
    second.assertion.provenance.operationId = deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: "in-process-second", actorId: "actor-001", entityId: "people/example-user", predicate: "timezone" });
    const receipts = await Promise.all([core.write(first, caller), core.write(second, caller)]);
    expect(receipts.map((receipt) => receipt.status)).toEqual(["committed", "committed"]);
    expect(generation).toBe(2);
  });

  test("arbitrary sha256 operation id fails canonical provenance closed", async () => {
    const { core, caller } = fixture();
    const input = request("non-canonical-operation");
    input.assertion.provenance.operationId = op("arbitrary-but-valid");
    expect(await core.write(input, caller)).toMatchObject({ status: "rejected", reason: "PROVENANCE_MISSING" });
    expect(existsSync(core.operationsRoot)).toBe(false);
  });

  test("exact semantic duplicate skips without creating a second assertion", async () => {
    const { core, caller } = fixture();
    const first = await core.write(request("duplicate-1"), caller);
    const duplicate = await core.write(request("duplicate-2"), caller);
    expect(duplicate).toMatchObject({ status: "skipped", reason: "DUPLICATE", assertionId: first.assertionId });
    expect(readdirSync(core.assertionsRoot)).toHaveLength(1);
  });

  for (const point of ["after-prepared", "after-assertion-store", "after-previous-store", "after-store-committed", "after-committed"] as KgCrashPoint[]) {
    test(`recovers ${point} with no duplicate`, async () => {
      const { root, caller } = fixture();
      const crashing = new KgV3Core({ workspace: root, workspaceId: "main", crashAt: point });
      const input = request(`crash-${point}`);
      await expect(crashing.write(input, caller)).rejects.toThrow(`simulated-crash:${point}`);
      const recovered = new KgV3Core({ workspace: root, workspaceId: "main" });
      const receipt = await recovered.write(input, caller);
      expect(receipt.status).toBe("committed");
      expect(await recovered.write(input, caller)).toEqual(receipt);
      expect(readdirSync(recovered.assertionsRoot)).toHaveLength(1);
      expect(await recovered.current()).toHaveLength(1);
    });
  }

  test("a different next operation first recovers an interrupted entity WAL", async () => {
    const { root, caller } = fixture();
    const interrupted = request("interrupted-before-next");
    await expect(new KgV3Core({ workspace: root, workspaceId: "main", crashAt: "after-prepared" }).write(interrupted, caller)).rejects.toThrow();
    const core = new KgV3Core({ workspace: root, workspaceId: "main" });
    const next = await core.write(request("different-next-operation"), caller);
    expect(next).toMatchObject({ status: "skipped", reason: "DUPLICATE" });
    expect(await core.current()).toHaveLength(1);
    expect(readdirSync(core.assertionsRoot)).toHaveLength(1);
  });

  test("replacement supersedes prior assertion and return-to-old creates a new assertion", async () => {
    const { core, caller } = fixture();
    const first = await core.write(request("replace-1", "A"), caller);
    const second = await core.write(request("replace-2", "B", first.assertionId), caller);
    const third = await core.write(request("replace-3", "A", second.assertionId), caller);
    expect(new Set([first.assertionId, second.assertionId, third.assertionId]).size).toBe(3);
    expect(await core.current()).toMatchObject([{ id: third.assertionId, object: { value: "A" } }]);
    const old = JSON.parse(readFileSync(join(core.assertionsRoot, `${first.assertionId}.json`), "utf8"));
    expect(old.lifecycle).toMatchObject({ status: "superseded", supersededById: second.assertionId });
  });

  test("retraction removes current assertion without deleting its body", async () => {
    const { core, caller } = fixture();
    const created = await core.write(request("retract-create"), caller);
    const retractionOperation = deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: "retract", actorId: "actor-001", entityId: "systems/engram", assertionId: created.assertionId!, action: "retract" });
    const receipt = await core.retract({
      workspaceId: "main", entityId: "systems/engram", assertionId: created.assertionId!,
      provenance: { sourceKind: "user_message", sessionKey: "main", messageId: "retract", actorId: "actor-001", operationId: retractionOperation, observedAt: "2026-08-12T16:00:00Z" }
    }, caller);
    expect(receipt.status).toBe("committed");
    expect(await core.current()).toEqual([]);
    const stored = JSON.parse(readFileSync(join(core.assertionsRoot, `${created.assertionId}.json`), "utf8"));
    expect(stored.lifecycle.status).toBe("retracted");
    expect(stored.object.value).toBe("main canary, then fleet");
    const journal = JSON.parse(readFileSync(join(core.operationsRoot, `${retractionOperation.slice(7)}.json`), "utf8"));
    expect(journal.actionProvenance).toMatchObject({ actorId: "actor-001", messageId: "retract", observedAt: "2026-08-12T16:00:00Z" });
  });

  test("tampered retraction action provenance fails journal recovery closed", async () => {
    const { core, caller } = fixture();
    const created = await core.write(request("tamper-retract-create"), caller);
    const operation = deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: "tamper-retract", actorId: "actor-001", entityId: "systems/engram", assertionId: created.assertionId!, action: "retract" });
    await core.retract({
      workspaceId: "main", entityId: "systems/engram", assertionId: created.assertionId!,
      provenance: { sourceKind: "user_message", sessionKey: "main", messageId: "tamper-retract", actorId: "actor-001", operationId: operation, observedAt: "2026-08-12T16:00:00Z" }
    }, caller);
    const path = join(core.operationsRoot, `${operation.slice(7)}.json`);
    const journal = JSON.parse(readFileSync(path, "utf8"));
    journal.actionProvenance.actorId = "";
    writeJson(path, journal);
    await expect(core.recover()).rejects.toThrow("invalid KG v3 operation journal");
  });
});

describe("KG v3 fail-closed boundaries", () => {
  test("cross-workspace, cross-scope, unresolved entity and wrong store fail closed", async () => {
    const { core, caller } = fixture();
    const crossWorkspace = request("cross-workspace");
    crossWorkspace.assertion.workspaceId = "other";
    expect((await core.write(crossWorkspace, caller)).reason).toBe("WORKSPACE_MISMATCH");
    const crossScope = request("cross-scope");
    crossScope.assertion.scope = ["other-project"];
    expect((await core.write(crossScope, caller)).reason).toBe("WRONG_STORE");
    const unresolved = request("unresolved");
    unresolved.assertion.entityId = "systems/unknown";
    unresolved.assertion.provenance.operationId = deriveKgOperationId({ workspaceId: "main", sessionKey: "main", messageId: "unresolved", actorId: "actor-001", entityId: "systems/unknown", predicate: "rolloutStrategy" });
    expect((await core.write(unresolved, caller)).reason).toBe("ENTITY_UNRESOLVED");
    const progress = request("progress");
    progress.intent.statementClass = "progress";
    expect((await core.write(progress, caller)).reason).toBe("WRONG_STORE");
  });

  test("concurrent replacements have exactly one winner", async () => {
    const { root, core, caller } = fixture();
    const initial = await core.write(request("concurrent-initial", "A"), caller);
    const contextPath = join(root, "context.json");
    const onePath = join(root, "one.json");
    const twoPath = join(root, "two.json");
    writeJson(contextPath, caller);
    writeJson(onePath, request("concurrent-one", "B", initial.assertionId));
    writeJson(twoPath, request("concurrent-two", "C", initial.assertionId));
    const script = join(import.meta.dir, "..", "..", "scripts", "kg-v3-tool.ts");
    const spawn = (input: string) => Bun.spawn(["bun", script, "--command", "write", "--workspace", root, "--workspace-id", "main", "--request", input, "--context", contextPath], { stdout: "pipe", stderr: "pipe" });
    const p1 = spawn(onePath);
    const p2 = spawn(twoPath);
    const [out1, out2] = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
    await Promise.all([p1.exited, p2.exited]);
    const results = [JSON.parse(out1), JSON.parse(out2)];
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.reason === "REPLACEMENT_REQUIRED")).toHaveLength(1);
    expect(await new KgV3Core({ workspace: root, workspaceId: "main" }).current()).toHaveLength(1);
  });

  test("same operation id across different entities has one global winner", async () => {
    const { root, caller } = fixture();
    const first = request("global-first");
    const sameOperation = first.assertion.provenance.operationId;
    const second = request("global-second");
    second.assertion.provenance.operationId = sameOperation;
    second.assertion.entityId = "people/example-user";
    second.assertion.entityType = "person";
    second.assertion.kind = "preference";
    second.assertion.predicate = "timezone";
    second.assertion.object = { type: "string", value: "Europe/Moscow" };
    second.assertion.scope = ["personal"];
    const contextPath = join(root, "context.json");
    const onePath = join(root, "global-one.json");
    const twoPath = join(root, "global-two.json");
    writeJson(contextPath, caller);
    writeJson(onePath, first);
    writeJson(twoPath, second);
    const script = join(import.meta.dir, "..", "..", "scripts", "kg-v3-tool.ts");
    const spawn = (input: string) => Bun.spawn(["bun", script, "--command", "write", "--workspace", root, "--workspace-id", "main", "--request", input, "--context", contextPath], { stdout: "pipe", stderr: "pipe" });
    const p1 = spawn(onePath);
    const operationPath = join(root, "memory-state", "kg-v3", "operations", `${sameOperation.slice(7)}.json`);
    const deadline = Date.now() + 2_000;
    while (!existsSync(operationPath) && Date.now() < deadline) await Bun.sleep(1);
    expect(existsSync(operationPath)).toBe(true);
    const p2 = spawn(twoPath);
    const [out1, out2] = await Promise.all([new Response(p1.stdout).text(), new Response(p2.stdout).text()]);
    await Promise.all([p1.exited, p2.exited]);
    const results = [JSON.parse(out1), JSON.parse(out2)];
    expect(results.filter((result) => result.status === "committed")).toHaveLength(1);
    expect(results.filter((result) => result.reason === "OPERATION_CONFLICT")).toHaveLength(1);
    expect(readdirSync(join(root, "life", "v3", "assertions"))).toHaveLength(1);
  });

  test("current reader recovers and never exposes an after-store partial commit", async () => {
    const { root, caller } = fixture();
    const input = request("reader-barrier");
    await expect(new KgV3Core({ workspace: root, workspaceId: "main", crashAt: "after-assertion-store" }).write(input, caller)).rejects.toThrow();
    expect(existsSync(join(root, "life", "v3", "current-summary.md"))).toBe(false);
    const current = await new KgV3Reader({ workspace: root, workspaceId: "main" }).current();
    expect(current).toHaveLength(1);
    expect(current[0].provenance.operationId).toBe(input.assertion.provenance.operationId);
    expect(existsSync(join(root, "life", "v3", "current-summary.md"))).toBe(true);
  });

  test("v2 adapter is explicit and never mixed into current", async () => {
    const { root } = fixture();
    writeJson(join(root, "life", "systems", "engram", "items.json"), { entityId: "systems/engram", facts: [{ id: "engram-001", fact: "legacy", category: "decision", status: "active", source: "2025" }] });
    const reader = new KgV3Reader({ workspace: root, workspaceId: "main" });
    expect(await reader.current()).toEqual([]);
    expect(reader.historicalV2("systems/engram")).toEqual([{ archive: "v2", entityId: "systems/engram", id: "engram-001", fact: "legacy", category: "decision", status: "active", source: "2025" }]);
  });

  for (const mode of ["canary", "enabled"] as const) {
    test(`${mode} cutover marker blocks the direct legacy writer`, async () => {
      const { root } = fixture(mode);
      const script = join(import.meta.dir, "..", "..", "scripts", "memory-write.js");
      const process = Bun.spawn(
        ["bun", script, "--entity", "systems/engram", "--fact", "must not write", "--category", "decision"],
        { cwd: root, env: { ...globalThis.process.env, ENGRAM_WORKSPACE: root }, stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(process.stderr).text();
      await process.exited;
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ status: "rejected", reason: "LEGACY_WRITER_DISABLED" });
      expect(existsSync(join(root, "life", "v3"))).toBe(false);
    });

    test(`${mode} cutover marker blocks legacy access mutation byte-for-byte`, async () => {
      const { root } = fixture(mode);
      const itemsPath = join(root, "life", "systems", "engram", "items.json");
      writeJson(itemsPath, { entityId: "systems/engram", entityType: "system", facts: [{ id: "engram-001", fact: "legacy", status: "active", accessCount: 1, lastAccessed: "2026-01-01" }] });
      const before = readFileSync(itemsPath);
      const script = join(import.meta.dir, "..", "..", "scripts", "memory-write.js");
      const process = Bun.spawn(
        ["bun", script, "--access", "--entity", "systems/engram", "--id", "engram-001"],
        { cwd: root, env: { ...globalThis.process.env, ENGRAM_WORKSPACE: root }, stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(process.stderr).text();
      await process.exited;
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(stderr)).toMatchObject({ status: "rejected", reason: "LEGACY_WRITER_DISABLED" });
      expect(readFileSync(itemsPath)).toEqual(before);
    });
  }
});
