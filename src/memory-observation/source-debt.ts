/** Bun worker/operator closure scanner. Host plugins import only the separate
 * Node-safe source-debt-capture module, never this effect-verification wrapper. */
import { captureSourceDebt, captureLegacyRecoveryOrigins, assertSourceDebtPurgeSafe as assertHostSourceDebtPurgeSafe, type SourceDebtCaptureOptions } from "./source-debt-capture.ts";
import { verifySourceEffectClosure } from "./source-effect-proof.ts";
export * from "./source-debt-capture.ts";
export function scanSourceDebt(workspace: string, now = new Date(), options: Omit<SourceDebtCaptureOptions,"verifyClosure"> = {}) {
  return captureSourceDebt(workspace, now, { ...options, verifyClosure: verifySourceEffectClosure });
}

/** Worker-only legacy-origin upgrade; the host plugin keeps the same guard. */
export function assertSourceDebtPurgeSafe(workspace:string,now=new Date(),options:{workspaceId?:string}={}){
  captureLegacyRecoveryOrigins(workspace);
  return assertHostSourceDebtPurgeSafe(workspace,now,options);
}
