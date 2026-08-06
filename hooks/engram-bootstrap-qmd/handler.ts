import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { splitAgentAndSession } from "../_lib/parse-agent-id.js";

const TTL_MS = 15 * 60 * 1000; // 15 minutes

export function bootstrapQmdSkipReason(event: any): "cron" | "heartbeat" | "ephemeral" | null {
  const rawKey = String(event?.context?.sessionKey || event?.sessionKey || "").trim();
  const parsed = splitAgentAndSession(rawKey);
  const sessionSegment = String(parsed?.sessionKey || rawKey.replace(/^agent:[^:]+:/, "").replace(/:/g, "-")).toLowerCase();

  if (/^cron(?:-|$)/.test(sessionSegment)) return "cron";
  if (/^heartbeat(?:-|$)/.test(sessionSegment)) return "heartbeat";
  if (/^(?:subagent|ephemeral)(?:-|$)/.test(sessionSegment)) return "ephemeral";

  const runtimeHint = String(
    event?.context?.runKind ||
    event?.context?.sessionType ||
    event?.context?.triggerKind ||
    "",
  ).toLowerCase();
  if (runtimeHint === "cron") return "cron";
  if (runtimeHint === "heartbeat") return "heartbeat";
  if (runtimeHint === "subagent" || runtimeHint === "ephemeral") return "ephemeral";
  return null;
}

type BootstrapQmdDeps = {
  execSync: typeof execSync;
};

const handler = async (event: any, deps: BootstrapQmdDeps = { execSync }) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const skipReason = bootstrapQmdSkipReason(event);
  if (skipReason) {
    console.log(`[engram-bootstrap-qmd] skipped (${skipReason} session; heartbeat Phase 4 owns maintenance)`);
    return;
  }

  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir) return;

  const ttlFile = join(workspaceDir, ".qmd-update-ts");
  const lockFile = join(workspaceDir, ".qmd-update.lock");

  // TTL check — skip if qmd update ran recently
  if (existsSync(ttlFile)) {
    const lastRun = parseInt(readFileSync(ttlFile, "utf-8").trim(), 10) || 0;
    if (Date.now() - lastRun < TTL_MS) {
      console.log("[engram-bootstrap-qmd] skipped (ran < 15min ago)");
      return;
    }
  }

  // Lock file — prevent concurrent runs (race condition guard)
  if (existsSync(lockFile)) {
    const lockAge = Date.now() - parseInt(readFileSync(lockFile, "utf-8").trim(), 10) || 0;
    if (lockAge < 30_000) {
      // Another instance is running, skip
      console.log("[engram-bootstrap-qmd] skipped (lock held by concurrent bootstrap)");
      return;
    }
    // Stale lock (> 30s) — remove and proceed
    unlinkSync(lockFile);
  }
  writeFileSync(lockFile, String(Date.now()));

  try {
    deps.execSync("qmd update", {
      timeout: 15_000,
      stdio: "pipe",
      cwd: workspaceDir,
    });
    writeFileSync(ttlFile, String(Date.now()));
    console.log("[engram-bootstrap-qmd] qmd update completed");
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (msg.includes("ETIMEDOUT") || msg.includes("TIMEOUT")) {
      console.log("[engram-bootstrap-qmd] qmd update timed out (15s), skipping");
    } else {
      console.log("[engram-bootstrap-qmd] qmd update skipped:", msg.slice(0, 100));
    }
  } finally {
    // Always release lock
    try { unlinkSync(lockFile); } catch {}
  }
};

export default handler;
