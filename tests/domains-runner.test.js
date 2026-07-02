import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyDomainWriteHandoff, hashDomainFile, scanDomains, formatDomainScanSummary } from "../scripts/domains-runner.js";

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "engram-domains-"));
  mkdirSync(join(root, "memory", "domains"), { recursive: true });
  return root;
}

function writeDomain(root, name, files = {}) {
  const dir = join(root, "memory", "domains", name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(join(dir, file), content);
  }
}

describe("domains-runner scan", () => {
  test("reports missing and stale continuity files without writing", () => {
    const root = makeWorkspace();
    try {
      writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
        domains: {
          engram: { type: "dev-project", subagentLabel: "engram", cadenceDays: 7, lastRun: "2026-05-01" },
          disabled: { enabled: false },
        },
      }));
      writeDomain(root, "engram", {
        "decisions.md": "# decisions\n",
        "workflow.md": "# workflow\n",
      });

      const scan = scanDomains({ workspace: root, now: new Date("2026-05-21T12:00:00Z"), staleDays: 1 });
      expect(scan.registered).toBe(2);
      expect(scan.enabled).toBe(1);
      expect(scan.checked).toBe(2);
      expect(scan.changed).toBe(0);
      expect(scan.missing).toBe(2);
      expect(scan.due).toBe(1);
      expect(scan.overdue).toBe(1);
      expect(scan.domains.find((domain) => domain.name === "engram").missingFiles).toEqual(["status.md", "changelog.md"]);
      expect(formatDomainScanSummary(scan)).toContain("2 checked");
      expect(formatDomainScanSummary(scan)).toContain("1 enabled");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses heartbeat runtime state for domain cadence without mutating registry", () => {
    const root = makeWorkspace();
    try {
      const registryPath = join(root, "memory", "domains", "registry.json");
      writeFileSync(registryPath, JSON.stringify({
        domains: {
          engram: { type: "dev-project", subagentLabel: "engram", cadenceDays: 7, lastRun: "2026-05-01" },
        },
      }));
      writeFileSync(join(root, "memory", "heartbeat-state.json"), JSON.stringify({
        domainRuns: {
          engram: { lastRun: "2026-05-20T12:00:00.000Z", lastRunId: "run-recent" },
        },
      }));
      writeDomain(root, "engram", {
        "decisions.md": "# decisions\n",
        "workflow.md": "# workflow\n",
        "status.md": "# status\n",
        "changelog.md": "## 2026-05-20\n",
      });

      const scan = scanDomains({ workspace: root, now: new Date("2026-05-21T12:00:00Z") });
      expect(scan.domains.find((domain) => domain.name === "engram").due).toBe(false);
      expect(scan.due).toBe(0);
      expect(readFileSync(registryPath, "utf8")).toContain("\"lastRun\":\"2026-05-01\"");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("domains-runner write handoff", () => {
  test("applies status and changelog with base hash guard and run idempotency", async () => {
    const root = makeWorkspace();
    try {
      writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
        domains: {
          engram: { type: "dev-project", subagentLabel: "engram", cadenceDays: 7, lastRun: "2026-05-01" },
        },
      }));
      writeDomain(root, "engram", {
        "decisions.md": "# decisions\n",
        "workflow.md": "# workflow\n",
        "status.md": "# old status\n",
        "changelog.md": "# changelog\n",
      });
      const hashes = {
        "status.md": hashDomainFile({ workspace: root, domain: "engram", file: "status.md" }),
        "changelog.md": hashDomainFile({ workspace: root, domain: "engram", file: "changelog.md" }),
      };
      const handoff = {
        body: [
          "Domain: engram",
          "Run-Id: run-1",
          "Subagent-Label: engram",
          "Base-Hashes: " + JSON.stringify(hashes),
          "Status-Content: |",
          "  # new status",
          "Changelog-Entries: [{\"id\":\"entry-1\",\"runId\":\"run-1\",\"content\":\"## 2026-05-21 18:30 - Updated\\n\\nApplied domain status.\"}]",
          "Promotions: []",
          "Proposed-Decisions: []",
          "Proposed-Workflow: []",
        ].join("\n"),
      };

      const first = await applyDomainWriteHandoff(handoff, {
        workspace: root,
        now: "2026-05-21T15:30:00.000Z",
      });
      expect(first.status).toBe("ok");
      expect(first.changed).toBe(true);
      expect(first.wroteStatus).toBe(true);
      expect(first.appendedEntries).toBe(1);
      expect(readFileSync(join(root, "memory", "domains", "engram", "status.md"), "utf8")).toContain("# new status");
      expect(readFileSync(join(root, "memory", "domains", "engram", "changelog.md"), "utf8")).toContain("Run-Id: run-1");

      const replay = await applyDomainWriteHandoff(handoff, {
        workspace: root,
        now: "2026-05-21T15:31:00.000Z",
      });
      expect(replay.status).toBe("noop");
      expect(replay.idempotent).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ISS-9 A2: base-hash mismatch returns status:"stale" (NOT throw) and advances
  // lastCheckedAt — closes the re-fire-every-tick storm. Full unit coverage of the
  // new contract lives in scripts/domains-runner.test.ts (A2 race recovery block).
  // This integration test pins the runner-level behavior end-to-end.
  test("on stale base hashes returns status:stale and does not write", async () => {
    const root = makeWorkspace();
    try {
      writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
        domains: { engram: { type: "dev-project" } },
      }));
      writeDomain(root, "engram", {
        "status.md": "# status\n",
        "changelog.md": "# changelog\n",
      });
      const handoff = {
        body: [
          "Domain: engram",
          "Run-Id: run-2",
          "Base-Hashes: {\"status.md\":\"bad\",\"changelog.md\":\"bad\"}",
          "Status-Content: # impossible",
          "Changelog-Entries: []",
          "Promotions: []",
        ].join("\n"),
      };
      const result = await applyDomainWriteHandoff(handoff, { workspace: root });
      expect(result.status).toBe("stale");
      expect(result.idempotent).toBe(false);
      expect(result.staleFiles).toEqual(["status.md", "changelog.md"]);
      expect(readFileSync(join(root, "memory", "domains", "engram", "status.md"), "utf8")).toBe("# status\n");
      // lastCheckedAt MUST advance so the domain does not re-fire every tick.
      expect(result.advancedLastCheckedAt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects read-only decisions/workflow mutations", async () => {
    const root = makeWorkspace();
    try {
      writeFileSync(join(root, "memory", "domains", "registry.json"), JSON.stringify({
        domains: { engram: { type: "dev-project" } },
      }));
      writeDomain(root, "engram", {
        "status.md": "# status\n",
        "changelog.md": "# changelog\n",
      });
      const hashes = {
        "status.md": hashDomainFile({ workspace: root, domain: "engram", file: "status.md" }),
        "changelog.md": hashDomainFile({ workspace: root, domain: "engram", file: "changelog.md" }),
      };
      const handoff = {
        body: [
          "Domain: engram",
          "Run-Id: run-3",
          "Base-Hashes: " + JSON.stringify(hashes),
          "Decisions-Content: no",
          "Changelog-Entries: []",
          "Promotions: []",
        ].join("\n"),
      };
      await expect(applyDomainWriteHandoff(handoff, { workspace: root })).rejects.toThrow("read-only");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
