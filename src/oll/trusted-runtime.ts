import type {
  DispatchAcknowledgementV1,
  NightlyRuntimeAdapter,
  NightlySpawnRequestV1,
  ResumeResultV1,
} from "./contracts";
import { awaitHandoffFile } from "./handoff-watcher";

export interface TrustedSpawnRecordV1 {
  dispatchRef: string;
  runtimeLabel: string;
  resolvedModel: string;
}

export interface TrustedSpawnTransport {
  /** Exact-label lookup used to reconcile an interrupted dispatch. */
  findByRuntimeLabel(runtimeLabel: string): Promise<TrustedSpawnRecordV1 | null>;
  /** Deployment implementation maps this one-for-one to sessions_spawn. */
  spawn(input: {
    task: string;
    label: string;
    runtimeLabel: string;
    model: string;
    workspacePath: string;
    runTimeoutSeconds: number;
  }): Promise<TrustedSpawnRecordV1>;
}

/**
 * Trusted orchestration boundary for deployment-owned session spawning.
 * Universal Engram never imports an OpenClaw transport; the deployment injects
 * a transport which performs the actual sessions_spawn capability call.
 */
export class TrustedNightlyRuntime implements NightlyRuntimeAdapter {
  constructor(
    readonly transport: TrustedSpawnTransport,
    readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async spawn(request: NightlySpawnRequestV1): Promise<DispatchAcknowledgementV1> {
    const existing = await this.transport.findByRuntimeLabel(request.runtimeLabel);
    const record = existing || await this.transport.spawn({
      task: request.prompt,
      label: request.label,
      runtimeLabel: request.runtimeLabel,
      model: request.model,
      workspacePath: request.workspacePath,
      runTimeoutSeconds: 900,
    });
    if (record.runtimeLabel !== request.runtimeLabel) {
      throw new Error("trusted spawn returned a different runtime label");
    }
    if (record.resolvedModel !== request.model) {
      throw new Error("trusted spawn resolved a different model");
    }
    return {
      schema: "oll.dispatch-ack.v1",
      runId: request.runId,
      accepted: true,
      acknowledgedAt: this.now(),
      runtimeLabel: record.runtimeLabel,
      resolvedModel: record.resolvedModel,
      dispatchRef: record.dispatchRef,
    };
  }

  async awaitHandoff(expectedPath: string, timeoutMs = 900_000) {
    return await awaitHandoffFile(expectedPath, timeoutMs);
  }

  async resume(batchId: string): Promise<ResumeResultV1> {
    return {
      schema: "oll.resume-result.v1",
      batchId,
      resumed: true,
      resumedAt: this.now(),
    };
  }
}
