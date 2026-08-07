import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addQmdCollection, listQmdCollections, probeQmdExecutable } from "../scripts/_lib/qmd-provision.js";

const fixtures = join(import.meta.dir, "fixtures", "fake-qmd.js");
const temporaryDirectories = [];

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory && existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }
  delete process.env.FAKE_QMD_LOG;
});

describe("script QMD provisioning bridge", () => {
  test("uses the core's argv-safe collection-add and never runs maintenance", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-qmd-provision-"));
    temporaryDirectories.push(workspace);
    const collectionPath = join(workspace, "memory", "domains", "demo");
    const logPath = join(workspace, "fake-qmd.log");
    mkdirSync(collectionPath, { recursive: true });
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-test",
      qmd: {
        command: process.execPath,
        commandArgs: [fixtures],
        index: "test-index",
        collection: "test-memory",
        collections: ["test-memory"],
      },
    }));
    process.env.FAKE_QMD_LOG = logPath;

    const result = await addQmdCollection({
      workspace,
      collection: "domain-demo",
      path: collectionPath,
      mask: "**/*.md",
    });

    expect(result.ok).toBe(true);
    expect(result.operationRecord.operation).toBe("collection-add");
    expect(result.operationRecord.policyDecision.code).toBe("ALLOW_COLLECTION_PROVISION");
    const [argv] = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(argv).toEqual([
      "--index", "test-index", "collection", "add", collectionPath,
      "--name", "domain-demo", "--mask", "**/*.md",
    ]);
    expect(argv).not.toContain("update");
    expect(argv).not.toContain("embed");
  });

  test("uses typed collection-list and bootstrap probes for diagnostics", () => {
    const workspace = mkdtempSync(join(tmpdir(), "engram-qmd-provision-"));
    temporaryDirectories.push(workspace);
    const logPath = join(workspace, "fake-qmd.log");
    writeFileSync(join(workspace, "engram.json"), JSON.stringify({
      agent: "agent-test",
      qmd: {
        command: process.execPath,
        commandArgs: [fixtures],
        index: "test-index",
        collection: "test-memory",
        collections: ["test-memory"],
      },
    }));
    process.env.FAKE_QMD_LOG = logPath;

    const listed = listQmdCollections({ workspace });
    const probed = probeQmdExecutable({ workspace, executable: process.execPath, prefixArgs: [fixtures], probe: "help" });

    expect(listed).toMatchObject({ ok: true, operationRecord: { operation: "collection-list" } });
    expect(probed).toMatchObject({ ok: true, operationRecord: { operation: "probe" } });
    const commands = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands).toEqual([
      ["--index", "test-index", "collection", "list"],
      ["--help"],
    ]);
  });
});
