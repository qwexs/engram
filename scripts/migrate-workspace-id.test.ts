import { describe, expect, test } from "bun:test";
import { migrateWorkspaceIdentity } from "./migrate-workspace-id.js";

describe("workspace.id config migration", () => {
  test("adds schemaVersion and derives canonical id from agent", () => {
    const result = migrateWorkspaceIdentity({ agent: "agent-managers", qmd: { collection: "managers-memory" } });
    expect(result).toMatchObject({ changed: true, workspaceId: "managers" });
    expect(result.config).toMatchObject({
      schemaVersion: 1,
      workspace: { id: "managers" },
      agent: "agent-managers",
      qmd: { collection: "managers-memory" },
    });
  });

  test("is idempotent for an already migrated config", () => {
    const config = { schemaVersion: 1, workspace: { id: "main" }, agent: "agent-main" };
    const first = migrateWorkspaceIdentity(config, "main");
    const second = migrateWorkspaceIdentity(first.config, "main");
    expect(first).toMatchObject({ changed: false, workspaceId: "main" });
    expect(second).toMatchObject({ changed: false, workspaceId: "main" });
    expect(second.config).toBe(config);
  });

  test("rejects conflicts, traversal, and unsupported schema versions", () => {
    expect(() => migrateWorkspaceIdentity({ workspace: { id: "main" } }, "other")).toThrow("workspace.id conflict");
    expect(() => migrateWorkspaceIdentity({ agent: "agent-main" }, "../escape")).toThrow("invalid workspace id");
    expect(() => migrateWorkspaceIdentity({ schemaVersion: 2, agent: "agent-main" })).toThrow("unsupported schemaVersion");
  });
});
