import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Workspace } from "../cli/args.ts";
import { contextError } from "../cli/errors.ts";
import type { QmdContext, QmdContextWarning, QmdSelector } from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export type QmdContextRuntime = {
  env: Record<string, string | undefined>;
  homedir: () => string;
  platform: NodeJS.Platform;
};

const defaultRuntime: QmdContextRuntime = {
  env: process.env,
  homedir,
  platform: process.platform,
};

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function canonicalizePath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);

  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonicalizePath(parent), absolute.slice(parent.length + (parent.endsWith("/") ? 0 : 1)));
}

function parseConfig(workspace: string): UnknownRecord {
  const configPath = join(workspace, "engram.json");
  if (!existsSync(configPath)) {
    throw contextError("Workspace does not contain engram.json.", { workspace, configPath });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw contextError("Workspace engram.json is not valid JSON.", {
      workspace,
      configPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isRecord(parsed)) {
    throw contextError("Workspace engram.json must contain a JSON object.", { workspace, configPath });
  }
  if (parsed.qmd !== undefined && !isRecord(parsed.qmd)) {
    throw contextError("engram.json qmd must be an object.", { configPath });
  }
  return parsed;
}

function stringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw contextError(`${field} must be an array of non-empty strings.`, { field });
  }
  return value.map((item) => (item as string).trim());
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveOwnedCollections(qmd: UnknownRecord, warnings: QmdContextWarning[]): string[] {
  const configured = stringArray(qmd.collections, "qmd.collections");
  const primary = qmd.collection;
  if (primary !== undefined && (typeof primary !== "string" || primary.trim() === "")) {
    throw contextError("qmd.collection must be a non-empty string.", { field: "qmd.collection" });
  }
  const normalizedPrimary = typeof primary === "string" ? primary.trim() : undefined;

  if (configured !== undefined && normalizedPrimary && !configured.includes(normalizedPrimary)) {
    throw contextError("Primary qmd.collection is outside qmd.collections ownership policy.", {
      primaryCollection: normalizedPrimary,
      ownedCollections: configured,
    });
  }

  const owned = configured ?? (normalizedPrimary ? [normalizedPrimary] : []);
  if (configured === undefined && normalizedPrimary) {
    warnings.push({
      code: "LEGACY_COLLECTION_NORMALIZED",
      message: "Legacy qmd.collection was normalized into the ownership policy.",
      details: { collection: normalizedPrimary },
    });
  }
  if (owned.length === 0) {
    throw contextError("QMD ownership policy must contain at least one collection.", {
      fields: ["qmd.collections", "qmd.collection"],
    });
  }
  return unique(owned);
}

function addMetaDomainCollections(target: string[], domains: unknown): void {
  if (!isRecord(domains)) return;
  for (const entry of Object.values(domains)) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "meta-domain" && entry.metaDomain !== true) continue;
    const collections = stringArray(entry.qmdCollections, "meta-domain.qmdCollections") ?? [];
    target.push(...collections);
  }
}

function resolveReadableCollections(
  workspace: string,
  config: UnknownRecord,
  qmd: UnknownRecord,
  owned: string[],
  warnings: QmdContextWarning[],
): string[] {
  const readable = [...owned];
  const vertical = qmd.verticalAccess;
  if (vertical !== undefined && !isRecord(vertical)) {
    throw contextError("qmd.verticalAccess must be an object.", { field: "qmd.verticalAccess" });
  }
  if (isRecord(vertical) && vertical.enabled === true) {
    if (!isRecord(vertical.collections)) {
      throw contextError("Enabled qmd.verticalAccess.collections must be an object map.", {
        field: "qmd.verticalAccess.collections",
      });
    }
    for (const [name, spec] of Object.entries(vertical.collections)) {
      if (name.trim() === "" || (spec !== null && !isRecord(spec))) {
        throw contextError("qmd.verticalAccess.collections must map non-empty names to objects.", {
          field: "qmd.verticalAccess.collections",
          collection: name,
        });
      }
      readable.push(name);
    }
  }

  addMetaDomainCollections(readable, config.domains);
  const registryPath = join(workspace, "memory", "domains", "registry.json");
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
      if (isRecord(registry)) addMetaDomainCollections(readable, registry.domains);
      else throw new Error("registry root is not an object");
    } catch (error) {
      warnings.push({
        code: "REGISTRY_UNREADABLE",
        message: "Domain registry could not be read; workspace config policy remains available.",
        details: { path: registryPath, cause: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return unique(readable);
}

function resolveCommand(qmd: UnknownRecord, runtime: QmdContextRuntime): QmdContext["command"] {
  const configured = runtime.env.ENGRAM_QMD ?? qmd.command;
  const fallback = runtime.platform === "win32" ? "qmd.cmd" : "qmd";
  const executable = configured === undefined ? fallback : configured;
  if (typeof executable !== "string" || executable.trim() === "") {
    throw contextError("qmd.command must be a non-empty executable string.", { field: "qmd.command" });
  }
  const containsWhitespace = /\s/.test(executable);
  const looksLikePath = /[\\/]/.test(executable);
  const containsOptionToken = /\s--?\S/.test(executable);
  if (executable !== executable.trim() || (containsWhitespace && (!looksLikePath || containsOptionToken))) {
    throw contextError("qmd.command must contain only the executable; put arguments in qmd.commandArgs.", {
      field: "qmd.command",
    });
  }
  return {
    executable,
    prefixArgs: stringArray(qmd.commandArgs, "qmd.commandArgs") ?? [],
  };
}

function localConfig(workspace: string): string | undefined {
  const yaml = join(workspace, ".qmd", "index.yaml");
  if (existsSync(yaml)) return yaml;
  const yml = join(workspace, ".qmd", "index.yml");
  return existsSync(yml) ? yml : undefined;
}

function resolveSelector(qmd: UnknownRecord, workspace: string, warnings: QmdContextWarning[]): QmdSelector {
  if (qmd.localIndex !== undefined && typeof qmd.localIndex !== "boolean") {
    throw contextError("qmd.localIndex must be a boolean.", { field: "qmd.localIndex" });
  }
  const named = qmd.index;
  if (named !== undefined && (typeof named !== "string" || named.trim() === "")) {
    throw contextError("qmd.index must be a non-empty named index.", { field: "qmd.index" });
  }
  if (typeof named === "string") {
    if (/[\\/]/.test(named)) {
      throw contextError("qmd.index must be a name, not a filesystem path.", { field: "qmd.index" });
    }
    if (qmd.localIndex === true) {
      throw contextError("qmd.localIndex:true conflicts with a named qmd.index.", {
        fields: ["qmd.localIndex", "qmd.index"],
      });
    }
    return { kind: "named", name: named.trim() };
  }
  if (localConfig(workspace)) return { kind: "local" };
  if (qmd.localIndex === true) {
    warnings.push({
      code: "LOCAL_INDEX_CONFIG_MISSING",
      message: "qmd.localIndex is enabled, but no workspace .qmd/index.yml or index.yaml exists; QMD resolves globally.",
    });
  }
  return { kind: "global" };
}

function physicalPath(
  selector: QmdSelector,
  workspace: string,
  runtime: QmdContextRuntime,
): string {
  if (selector.kind === "local") return join(workspace, ".qmd", "index.sqlite");
  const cacheHome = runtime.env.XDG_CACHE_HOME
    ? resolve(runtime.env.XDG_CACHE_HOME)
    : join(runtime.homedir(), ".cache");
  const name = selector.kind === "named" ? selector.name : "index";
  return join(cacheHome, "qmd", `${name}.sqlite`);
}

export function resolveQmdContext(
  workspaceResolution: Workspace,
  runtime: QmdContextRuntime = defaultRuntime,
): QmdContext {
  const requested = isAbsolute(workspaceResolution.value)
    ? workspaceResolution.value
    : resolve(workspaceResolution.value);
  if (!existsSync(requested)) {
    throw contextError("Workspace path does not exist.", { workspace: requested });
  }
  if (!statSync(requested).isDirectory()) {
    throw contextError("Workspace path is not a directory.", { workspace: requested });
  }
  const workspace = realpathSync(requested);
  const config = parseConfig(workspace);
  const qmd = isRecord(config.qmd) ? config.qmd : {};
  const warnings: QmdContextWarning[] = [];
  const ownedCollections = resolveOwnedCollections(qmd, warnings);
  const selector = resolveSelector(qmd, workspace, warnings);
  const path = canonicalizePath(physicalPath(selector, workspace, runtime));
  const readableCollections = resolveReadableCollections(workspace, config, qmd, ownedCollections, warnings);

  return {
    workspace,
    workspaceSource: workspaceResolution.source,
    topology: qmd.localIndex === true || selector.kind === "local" ? "isolated" : "shared",
    selector,
    physicalIndex: {
      path,
      key: createHash("sha256").update(path).digest("hex"),
      exists: existsSync(path),
    },
    command: resolveCommand(qmd, runtime),
    policy: { ownedCollections, readableCollections },
    warnings,
  };
}
