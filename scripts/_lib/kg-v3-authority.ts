import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LegacyKgMutationState {
  authorityPresent: boolean;
  allowed: boolean;
  mode: string | null;
}

/** Legacy v2 mutation is allowed only before authority exists or while the
 * explicit containment marker still says legacy-contained. Any malformed or
 * later authority state fails closed. */
export function legacyKgMutationState(workspace: string): LegacyKgMutationState {
  const path = join(workspace, "memory-state", "kg-v3", "authority.json");
  if (!existsSync(path)) return { authorityPresent: false, allowed: true, mode: null };
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    const valid = marker?.schema === "engram.kg-v3-authority.v1";
    return {
      authorityPresent: true,
      allowed: valid && marker.mode === "legacy-contained",
      mode: valid ? marker.mode : "invalid",
    };
  } catch {
    return { authorityPresent: true, allowed: false, mode: "invalid" };
  }
}
