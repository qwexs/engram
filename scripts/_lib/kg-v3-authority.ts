import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface LegacyKgMutationState {
  authorityPresent: boolean;
  allowed: boolean;
  mode: string | null;
}

/** Historical authority metadata only. Fleet retirement permanently disables
 * v2 mutation, including absent, malformed and old containment markers. */
export function legacyKgMutationState(workspace: string): LegacyKgMutationState {
  const path = join(workspace, "memory-state", "kg-v3", "authority.json");
  if (!existsSync(path)) return { authorityPresent: false, allowed: false, mode: null };
  try {
    const marker = JSON.parse(readFileSync(path, "utf8"));
    const valid = marker?.schema === "engram.kg-v3-authority.v1";
    return {
      authorityPresent: true,
      allowed: false,
      mode: valid ? marker.mode : "invalid",
    };
  } catch {
    return { authorityPresent: true, allowed: false, mode: "invalid" };
  }
}
