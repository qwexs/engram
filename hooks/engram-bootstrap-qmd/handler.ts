import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const TTL_MS = 15 * 60 * 1000; // 15 minutes

const handler = async (event: any) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

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
    execSync("qmd update", {
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
