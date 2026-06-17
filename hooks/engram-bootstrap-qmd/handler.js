// hooks/engram-bootstrap-qmd/handler.ts
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
var TTL_MS = 15 * 60 * 1000;
var handler = async (event) => {
  if (event.type !== "agent" || event.action !== "bootstrap")
    return;
  const workspaceDir = event.context?.workspaceDir;
  if (!workspaceDir)
    return;
  const ttlFile = join(workspaceDir, ".qmd-update-ts");
  const lockFile = join(workspaceDir, ".qmd-update.lock");
  if (existsSync(ttlFile)) {
    const lastRun = parseInt(readFileSync(ttlFile, "utf-8").trim(), 10) || 0;
    if (Date.now() - lastRun < TTL_MS) {
      console.log("[engram-bootstrap-qmd] skipped (ran < 15min ago)");
      return;
    }
  }
  if (existsSync(lockFile)) {
    const lockAge = Date.now() - parseInt(readFileSync(lockFile, "utf-8").trim(), 10) || 0;
    if (lockAge < 30000) {
      console.log("[engram-bootstrap-qmd] skipped (lock held by concurrent bootstrap)");
      return;
    }
    unlinkSync(lockFile);
  }
  writeFileSync(lockFile, String(Date.now()));
  try {
    execSync("qmd update", {
      timeout: 15000,
      stdio: "pipe",
      cwd: workspaceDir
    });
    writeFileSync(ttlFile, String(Date.now()));
    console.log("[engram-bootstrap-qmd] qmd update completed");
  } catch (err) {
    const msg = err?.message || String(err);
    if (msg.includes("ETIMEDOUT") || msg.includes("TIMEOUT")) {
      console.log("[engram-bootstrap-qmd] qmd update timed out (15s), skipping");
    } else {
      console.log("[engram-bootstrap-qmd] qmd update skipped:", msg.slice(0, 100));
    }
  } finally {
    try {
      unlinkSync(lockFile);
    } catch {}
  }
};
var handler_default = handler;
export {
  handler_default as default
};
