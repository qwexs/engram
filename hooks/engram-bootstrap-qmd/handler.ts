import { execSync } from "node:child_process";

const handler = async (event: any) => {
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  try {
    execSync("qmd update", {
      timeout: 15_000,
      stdio: "pipe",
      cwd: event.context?.workspaceDir || undefined,
    });
    console.log("[engram-bootstrap-qmd] qmd update completed");
  } catch (err: any) {
    // Silent skip — qmd may not be installed or may timeout
    const msg = err?.message || String(err);
    if (msg.includes("ETIMEDOUT") || msg.includes("TIMEOUT")) {
      console.log("[engram-bootstrap-qmd] qmd update timed out (15s), skipping");
    } else {
      console.log("[engram-bootstrap-qmd] qmd update skipped:", msg.slice(0, 100));
    }
  }
};

export default handler;
