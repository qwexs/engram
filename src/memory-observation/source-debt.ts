/** Bun worker/operator closure scanner. Host plugins import only the separate
 * Node-safe source-debt-capture module, never this effect-verification wrapper. */
import { captureSourceDebt, sourceDebtSnapshot as rawSourceDebtSnapshot, captureLegacyRecoveryOrigins, assertSourceDebtPurgeSafe as assertHostSourceDebtPurgeSafe, type SourceDebtCaptureOptions } from "./source-debt-capture.ts";
import { applySourceDebtWriteOffs } from './source-debt-writeoff.ts';
export type { SourceDebtSnapshot } from './source-debt-writeoff.ts';
import { verifySourceEffectClosure } from "./source-effect-proof.ts";
export * from "./source-debt-capture.ts";
export function scanSourceDebt(workspace: string, now = new Date(), options: Omit<SourceDebtCaptureOptions,"verifyClosure"> = {}) {
  return applySourceDebtWriteOffs(workspace, captureSourceDebt(workspace, now, { ...options, verifyClosure: verifySourceEffectClosure }), now);
}
export function sourceDebtSnapshot(workspace: string, now = new Date(), options: { workspaceId?: string } = {}) {
  return applySourceDebtWriteOffs(workspace, rawSourceDebtSnapshot(workspace, now, options), now);
}

/** Worker-only legacy-origin upgrade; the host plugin keeps the same guard. */
export function assertSourceDebtPurgeSafe(workspace:string,now=new Date(),options:{workspaceId?:string}={}){
  captureLegacyRecoveryOrigins(workspace);
  return assertHostSourceDebtPurgeSafe(workspace,now,options);
}
