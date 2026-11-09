import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { loadActorRegistry } from "./authorization";

export class OllRuntimePreflightError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "OllRuntimePreflightError";
  }
}

function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function physicalPath(path: string): string {
  // The company store may be created later. Resolve existing ancestors without
  // creating it, so a symlink cannot conceal an out-of-root destination.
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : resolve(physicalPath(parent), basename(path));
}

function managedPath(config: Record<string, any>, root: string, key: string, fallback: string): string {
  const setting = config?.oll?.adaptation?.[key] ?? fallback;
  if (typeof setting !== "string" || !setting.trim()) throw new OllRuntimePreflightError("invalid_config", `${key} must be a nonempty path`);
  const expanded = setting.replaceAll("${ENGRAM_STATE_ROOT}", root);
  if (!isAbsolute(expanded) || expanded.includes("${")) throw new OllRuntimePreflightError("invalid_config", `${key} must resolve to an absolute path`);
  const path = resolve(expanded);
  if (!inside(root, path) || !inside(physicalPath(root), physicalPath(path))) {
    throw new OllRuntimePreflightError("path_escape", `${key} escapes its managed root`);
  }
  return path;
}

/** Read-only consumer-compatible admission check. Never creates stores or grants. */
export function preflightOllRuntime(config: Record<string, any>, stateRoot: string) {
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot)) throw new OllRuntimePreflightError("invalid_state_root", "an absolute OLL stateRoot is required");
  const root = resolve(stateRoot);
  const workspaceId = String(config?.workspace?.id || "");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(workspaceId)) throw new OllRuntimePreflightError("invalid_config", "workspace.id is required");
  if (!["disabled", "observe-only", "active"].includes(config?.oll?.adaptation?.mode)) throw new OllRuntimePreflightError("invalid_config", "oll.adaptation.mode is invalid");
  const companyRuleStorePath = managedPath(config, root, "companyRuleStore", "${ENGRAM_STATE_ROOT}/oll/company-rules");
  if (existsSync(companyRuleStorePath) && !statSync(companyRuleStorePath).isDirectory()) throw new OllRuntimePreflightError("invalid_config", "companyRuleStore must be a directory");
  const actorRegistryPath = managedPath(config, root, "actorRegistry", "${ENGRAM_STATE_ROOT}/oll/actors.v1.json");
  if (!existsSync(actorRegistryPath) || !statSync(actorRegistryPath).isFile()) throw new OllRuntimePreflightError("registry_unavailable", "actorRegistry must be a readable regular file");
  let registry;
  try { registry = loadActorRegistry(actorRegistryPath); }
  catch { throw new OllRuntimePreflightError("registry_invalid", "actorRegistry is unreadable or invalid"); }
  return { workspaceId, stateRoot: root, actorRegistryPath, companyRuleStorePath, actorRegistryDigest: registry.digest };
}

export function preflightOllWorkspace(workspace: string, stateRoot: string) {
  return preflightOllRuntime(JSON.parse(readFileSync(join(resolve(workspace), "engram.json"), "utf8")), stateRoot);
}
