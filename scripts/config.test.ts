import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSubagentModel,
  resolveAutomaticIngress,
  resolveWorkspaceId,
  SubagentModelResolutionError,
  WorkspaceIdentityError,
} from "./config.js";

const roots: string[] = [];
const envSnapshot = {
  ENGRAM_MODEL_HB_RETHINK: process.env.ENGRAM_MODEL_HB_RETHINK,
  ENGRAM_DEPLOYMENT_PROFILE: process.env.ENGRAM_DEPLOYMENT_PROFILE,
  ENGRAM_DEPLOYMENT_PROFILES_DIR: process.env.ENGRAM_DEPLOYMENT_PROFILES_DIR,
};

function workspace(config: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "engram-config-phase-"));
  roots.push(root);
  writeFileSync(join(root, "engram.json"), JSON.stringify(config, null, 2));
  return root;
}

function deploymentProfile(name: string, model = "example/full-reasoning"): string {
  const root = mkdtempSync(join(tmpdir(), "engram-deployment-profile-"));
  roots.push(root);
  const profileRoot = join(root, name);
  mkdirSync(profileRoot, { recursive: true });
  writeFileSync(join(profileRoot, "engram.overlay.json"), JSON.stringify({
    schema: "engram.deployment-overlay.v1",
    profile: name,
    models: { heartbeat: { subagents: { "hb-rethink": model } } },
  }));
  return root;
}

afterEach(() => {
  for (const [key, value] of Object.entries(envSnapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("phase-based subagent model resolution", () => {
  test("resolves a prefixed logical label by canonical hb-rethink phase", () => {
    const root = workspace({
      workspace: { id: "managers" },
      models: {
        default: "provider/cheap",
        heartbeat: { subagents: { "hb-rethink": "provider/full" } },
      },
    });
    const logicalLabel = "managers-hb-rethink";
    expect(logicalLabel).not.toBe("hb-rethink");
    expect(resolveSubagentModel(root, "hb-rethink")).toBe("provider/full");
    expect(() => resolveSubagentModel(root, logicalLabel)).toThrow(SubagentModelResolutionError);
  });

  test("explicit environment phase override has highest precedence", () => {
    const root = workspace({
      workspace: { id: "main" },
      deployment: { profile: "example" },
      models: { heartbeat: { subagents: { "hb-rethink": "provider/workspace" } } },
    });
    process.env.ENGRAM_DEPLOYMENT_PROFILES_DIR = deploymentProfile("example");
    process.env.ENGRAM_MODEL_HB_RETHINK = "provider/environment";
    expect(resolveSubagentModel(root, "hb-rethink")).toBe("provider/environment");
  });

  test("workspace phase mapping overrides the deployment profile", () => {
    const root = workspace({
      workspace: { id: "main" },
      deployment: { profile: "example" },
      models: { heartbeat: { subagents: { "hb-rethink": "provider/workspace" } } },
    });
    process.env.ENGRAM_DEPLOYMENT_PROFILES_DIR = deploymentProfile("example");
    expect(resolveSubagentModel(root, "hb-rethink")).toBe("provider/workspace");
  });

  test("external deployment overlay supplies the full-reasoning mapping", () => {
    const root = workspace({
      workspace: { id: "main" },
      deployment: { profile: "example" },
      models: { default: "provider/cheap", heartbeat: { subagents: {} } },
    });
    process.env.ENGRAM_DEPLOYMENT_PROFILES_DIR = deploymentProfile("example", "example/full-reasoning");
    expect(resolveSubagentModel(root, "hb-rethink")).toBe("example/full-reasoning");
  });

  test("configured deployment profiles must be supplied outside the core checkout", () => {
    const root = workspace({
      workspace: { id: "main" },
      deployment: { profile: "example" },
      models: { heartbeat: { subagents: {} } },
    });
    expect(() => resolveSubagentModel(root, "hb-rethink")).toThrow("ENGRAM_DEPLOYMENT_PROFILES_DIR is required");
  });

  test("full-reasoning phase fails closed instead of using a cheap default", () => {
    const root = workspace({
      workspace: { id: "main" },
      models: { default: "provider/cheap", heartbeat: { subagents: {} } },
    });
    expect(() => resolveSubagentModel(root, "hb-rethink")).toThrow(
      "exact full-reasoning phase mapping is required",
    );
  });

  test("invalid exact mapping and unknown phase fail closed", () => {
    const root = workspace({
      workspace: { id: "main" },
      models: { heartbeat: { subagents: { "hb-rethink": "bad model id" } } },
    });
    expect(() => resolveSubagentModel(root, "hb-rethink")).toThrow("invalid model id");
    expect(() => resolveSubagentModel(root, "hb-typo")).toThrow("unknown canonical phase");
  });

  test("grinding phases retain the model-agnostic OSS fallback", () => {
    const root = workspace({ workspace: { id: "main" } });
    expect(resolveSubagentModel(root, "hb-extract")).toBe("sonnet-4-6");
  });
});

describe("canonical workspace identity", () => {
  test("uses explicit workspace.id", () => {
    const root = workspace({ workspace: { id: "managers" }, agent: "agent-legacy" });
    expect(resolveWorkspaceId(root)).toBe("managers");
  });

  test("legacy agent fallback is opt-in", () => {
    const root = workspace({ agent: "agent-main" });
    expect(() => resolveWorkspaceId(root)).toThrow(WorkspaceIdentityError);
    expect(resolveWorkspaceId(root, { allowAgentFallback: true })).toBe("main");
  });

  test("invalid explicit identity never falls back", () => {
    const root = workspace({ workspace: { id: "../escape" }, agent: "agent-main" });
    expect(() => resolveWorkspaceId(root, { allowAgentFallback: true })).toThrow("invalid workspace.id");
  });
});

describe("automatic KG ingress policy", () => {
  test.each([
    [{}, "disabled"],
    [{ kg: {} }, "disabled"],
    [{ kg: { automaticIngress: "disabled" } }, "disabled"],
    [{ kg: { automaticIngress: "LEGACY" } }, "disabled"],
    [{ kg: { automaticIngress: true } }, "disabled"],
    [{ kg: { automaticIngress: "unknown" } }, "disabled"],
    [{ kg: { automaticIngress: "legacy" } }, "legacy"],
  ] as const)("resolves %# fail closed", (config, expected) => {
    expect(resolveAutomaticIngress(config)).toBe(expected);
  });

  test("accepts a workspace path", () => {
    const root = workspace({ kg: { automaticIngress: "legacy" } });
    expect(resolveAutomaticIngress(root)).toBe("legacy");
  });
});
