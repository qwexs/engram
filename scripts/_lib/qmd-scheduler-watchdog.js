/** Read-only scheduler + receipt checks. No scheduler script is evaluated. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { inspectQmdMaintenancePayload, QMD_SCHEDULER_KEY } from "./qmd-scheduler.js";
import { schedulerCadenceSeconds } from "./watchdog-runtime.js";

export function auditQmdScheduler(workspace, config, inventory, { declarationPath, now = new Date() } = {}) {
  const path = declarationPath ?? config?.qmd?.maintenance?.schedulerDeclaration ?? join(workspace, "ops/qmd-global-migration/maintenance-scheduler.json");
  if (config?.qmd?.maintenance?.mode !== "coordinated" && !existsSync(path)) return [];
  const out = [];
  const add = (suffix, level, message, details = {}) => out.push({ code: "WD-QMD-SCHEDULER-" + suffix, level, message, path, details, fixable: false });
  let declaration;
  try {
    declaration = JSON.parse(readFileSync(path, "utf8"));
    if (declaration.schema !== "engram.qmd.global-maintenance-scheduler.v1" || !declaration.jobId || !declaration.payload || !declaration.schedule) throw new Error("invalid declaration");
  } catch {
    add("DECLARATION", "warn", "Coordinated QMD scheduler declaration is missing/invalid; freshness is not verified. Set qmd.maintenance.schedulerDeclaration or --qmd-scheduler.");
    return out;
  }
  if (config?.qmd?.maintenance?.mode !== "coordinated") add("MODE", "error", "Workspace with a shared QMD scheduler is not in coordinated mode");
  const wrapper = inspectQmdMaintenancePayload(declaration.payload);
  if (!wrapper) add("CONTRACT", "error", "Declared QMD payload must use the canonical fail-closed script, one synchronous managed exec and no model/process fallback");
  if (!inventory?.available) { add("UNVERIFIED", "warn", "Live QMD cron inventory unavailable; local declaration is not live proof"); return out; }
  if (!inventory.complete) add("UNVERIFIED", "warn", "Cron inventory is partial; unseen coordinators cannot be classified as absent");
  const jobs = inventory.jobs.filter(j => j.id === declaration.jobId);
  const duplicates = inventory.jobs.filter(j => j.enabled === true && j.id !== declaration.jobId && (j.declarationKey === QMD_SCHEDULER_KEY || j.name === declaration.name));
  if (duplicates.length) add("DUPLICATE", "error", "Additional enabled QMD coordinators share the declared identity", { jobIds: duplicates.map(j => j.id) });
  if (jobs.length !== 1) { add("UNVERIFIED", "warn", "Pinned QMD coordinator is not uniquely visible", { jobId: declaration.jobId }); return out; }
  const job = jobs[0];
  for (const key of ["payload", "schedule", "sessionTarget", "delivery", "enabled"])
    if (!isDeepStrictEqual(job[key], declaration[key])) add("DRIFT", "error", `Live QMD ${key} differs from its reviewed declaration`, { jobId: job.id, field: key });
  if (!inspectQmdMaintenancePayload(job.payload)) add("CONTRACT", "error", "Live QMD scheduler is not the canonical synchronous managed-exec script", { jobId: job.id });
  if (!job.enabled) { add("DISABLED", "warn", "QMD coordinator is disabled; clean-install activation/backfill gates remain pending"); return out; }
  const status = job.state?.lastRunStatus ?? job.state?.lastStatus ?? job.lastRunStatus;
  if (!status) add("NEVER-RUN", "warn", "QMD coordinator has no completed run; enabled is not verified healthy");
  else if (!["ok", "success"].includes(status)) add("EXECUTION", "error", "Last QMD cron execution failed", { status, consecutiveErrors: job.state?.consecutiveErrors });
  const cadence = schedulerCadenceSeconds(job.schedule);
  const last = job.state?.lastRunAtMs ?? job.lastRunAtMs;
  if (cadence && Number.isFinite(last) && now.getTime() - last > (cadence * 2 + job.payload.timeoutSeconds) * 1000)
    add("STALE", "warn", "QMD schedule has no recent execution within cadence and timeout allowance");
  if (!wrapper || !isDeepStrictEqual(job.payload, declaration.payload)) return out;
  try {
    const report = JSON.parse(readFileSync(wrapper.report, "utf8"));
    const mtime = statSync(wrapper.report).mtimeMs;
    if (report.schema !== "engram.qmd.maintenance-run.v1" || !["ok", "clean", "deferred"].includes(report.status))
      add("REPORT", "error", "QMD coordinator report is invalid, failed or partial", { status: report.status });
    if (report.status === "deferred") add("DEFERRED", "warn", "Last coordinator pass deferred to an existing lease; this is not fresh embedding proof");
    if (cadence && now.getTime() - mtime > (cadence * 2 + job.payload.timeoutSeconds) * 1000)
      add("REPORT-STALE", "warn", "QMD report is older than schedule allowance");
    if (!Array.isArray(report.provenance) || !report.provenance.length) add("PROVENANCE", "warn", "Coordinator report has no workspace provenance reconciliation evidence");
    else if (report.provenance.some(p => p.failed > 0)) add("PROVENANCE", "error", "QMD provenance reconciliation contains failures");
    for (const phase of ["update", "embed"])
      if (report[phase] && report[phase].ok !== true) add("REPORT", "error", `QMD ${phase} was not successful despite scheduler status`);
  } catch { add("REPORT-UNVERIFIED", "warn", "QMD report could not be read; cron ok alone does not prove embeddings/provenance"); }
  return out;
}

export function auditWorkshopReviews(agentId, inventory) {
  if (!inventory?.available) return [];
  return inventory.jobs.filter(j => j.enabled === true && (j.declarationKey === `skill-collection-review:${agentId}` || j.name === `skill-collection-review-${agentId}` || j.name === `skill-collection-review:${agentId}` ||
    (j.name?.startsWith("skill-collection-review:") && j.agentId === agentId))).flatMap(j => {
    const error = String(j.state?.lastError ?? "");
    const blocked = /workshop/i.test(error) && /root|contain|runtime/i.test(error);
    const status = j.state?.lastRunStatus ?? j.state?.lastStatus;
    const code = blocked ? "RUNTIME" : !status ? "UNVERIFIED" : !["ok", "success"].includes(status) ? "EXECUTION" : null;
    return code ? [{ code: "WD-WORKSHOP-" + code, level: blocked ? "error" : "warn", fixable: false,
      message: blocked ? "System-owned Workshop review rejected its runtime containment contract; Engram cannot repair the host job or change shared models" :
        !status ? "Workshop review has never completed; runtime compatibility is unverified" : "Workshop review last execution was not successful",
      details: { jobId: j.id, agentId, status: status ?? null } }] : [];
  });
}
