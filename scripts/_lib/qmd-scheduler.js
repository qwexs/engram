/** Canonical deterministic QMD scheduler. No credentials, model or background tool. */
import { isAbsolute, join } from "node:path";

export const QMD_SCHEDULER_KEY = "engram:qmd-global-maintenance:v1";
export function qmdMaintenanceScript(execArgs, report) {
  return `// Managed Gateway exec supplies the existing secret environment. No model involved.
const r = await exec(${JSON.stringify(execArgs)});
if (r.status !== "completed" || r.exitCode !== 0) throw new Error("QMD_MAINTENANCE_FAILED: " + JSON.stringify({status:r.status,exitCode:r.exitCode,exitReason:r.exitReason,detail:r.aggregated,report:${JSON.stringify(report)}}));
json({state:{status:"completed",exitCode:0,completedAt:new Date().toISOString(),report:${JSON.stringify(report)}}});`;
}

export function buildQmdMaintenancePayload({ workspace, manifest, report, timeoutMs = 600000 }) {
  if (![workspace, manifest, report].every(p => typeof p === "string" && isAbsolute(p))) throw new Error("QMD scheduler paths must be absolute");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("QMD timeout must be a positive integer");
  const argv = ["bun", join(workspace, "skills/engram/scripts/qmd-maintenance-coordinator.ts"),
    "--manifest", manifest, "--workspace", workspace, "--timeout-ms", String(timeoutMs), "--report", report];
  const execArgs = { command: argv,
    workdir: workspace, timeoutSeconds: Math.ceil(timeoutMs / 1000) + 50, title: "Engram global QMD maintenance" };
  return { kind: "script", script: qmdMaintenanceScript(execArgs, report),
    timeoutSeconds: Math.ceil(timeoutMs / 1000) + 60, toolBudget: 1, toolsAllow: ["exec"] };
}

/** Recognize the exact fail-closed wrapper, including the reviewed September repair.
 * Never execute/eval scheduler code while auditing it. Command identity is pinned by
 * the deployment declaration; this checks the wrapper, not arbitrary shell semantics.
 */
export function inspectQmdMaintenancePayload(payload) {
  if (payload?.kind !== "script" || payload.toolBudget !== 1 || JSON.stringify(payload.toolsAllow) !== '["exec"]') return null;
  try {
    const execArgs = JSON.parse(payload.script.match(/^const r = await exec\((.+)\);$/m)?.[1] ?? "null");
    const report = JSON.parse(payload.script.match(/^json\(\{state:.*report:(.+)\}\}\);$/m)?.[1] ?? "null");
    if (!execArgs || !Array.isArray(execArgs.command) || !execArgs.command.every(v => typeof v === "string") || !isAbsolute(execArgs.workdir ?? "") || !isAbsolute(report ?? "")) return null;
    if (!Number.isFinite(payload.timeoutSeconds) || !Number.isFinite(execArgs.timeoutSeconds) || execArgs.timeoutSeconds <= 0 || payload.timeoutSeconds <= execArgs.timeoutSeconds) return null;
    if (payload.script !== qmdMaintenanceScript(execArgs, report)) return null;
    return { execArgs, report };
  } catch { return null; }
}
