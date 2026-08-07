import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { contextError } from "../cli/errors.ts";
import type { QmdContext } from "./types.ts";

function executable(value: string | undefined): string {
  const fallback = process.platform === "win32" ? "qmd.cmd" : "qmd";
  const result = value ?? fallback;
  if (typeof result !== "string" || result.trim() === "") {
    throw contextError("Bootstrap QMD command must be a non-empty executable string.");
  }
  const containsWhitespace = /\s/.test(result);
  const looksLikePath = /[\\/]/.test(result);
  const containsOptionToken = /\s--?\S/.test(result);
  if (result !== result.trim() || (containsWhitespace && (!looksLikePath || containsOptionToken))) {
    throw contextError("Bootstrap QMD command must contain only the executable; pass arguments separately.");
  }
  return result;
}

/**
 * Creates the deliberately minimal context used before an engram.json exists.
 * It supports only typed diagnostic probes; collection ownership is unavailable
 * until normal workspace context resolution succeeds.
 */
export function createBootstrapQmdContext(input: {
  workspace: string;
  executable?: string;
  prefixArgs?: string[];
}): QmdContext {
  const requested = resolve(input.workspace);
  if (!existsSync(requested) || !statSync(requested).isDirectory()) {
    throw contextError("Bootstrap QMD workspace must be an existing directory.", { workspace: requested });
  }
  if (input.prefixArgs !== undefined && input.prefixArgs.some((arg) => typeof arg !== "string")) {
    throw contextError("Bootstrap QMD command arguments must be strings.");
  }
  const workspace = realpathSync(requested);
  const indexPath = join(homedir(), ".cache", "qmd", "index.sqlite");
  return {
    workspace,
    workspaceSource: "explicit",
    topology: "shared",
    selector: { kind: "global" },
    physicalIndex: {
      path: indexPath,
      key: createHash("sha256").update(indexPath).digest("hex"),
      exists: existsSync(indexPath),
    },
    command: {
      executable: executable(input.executable),
      prefixArgs: [...(input.prefixArgs ?? [])],
    },
    policy: { ownedCollections: [], readableCollections: [] },
    warnings: [],
  };
}
