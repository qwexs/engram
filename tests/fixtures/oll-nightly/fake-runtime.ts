import type {
  DispatchAcknowledgementV1,
  HandoffWaitResultV1,
  NightlyRuntimeAdapter,
  NightlySpawnRequestV1,
  ResumeResultV1,
} from "../../../src/oll/contracts";

export type FakeRuntimeEvent = {
  type: "spawn" | "handoff" | "terminal_apply" | "resume";
  workspaceId?: string;
  runId?: string;
  batchId?: string;
};

/** Deterministic test double for the fixed runtime adapter boundary. */
export class FakeNightlyRuntime implements NightlyRuntimeAdapter {
  readonly events: FakeRuntimeEvent[] = [];
  readonly handoffs = new Set<string>();
  activeRequest: NightlySpawnRequestV1 | null = null;
  activeRethinkRuns = 0;
  maxConcurrentRethinkRuns = 0;

  constructor(readonly onSpawn?: (request: NightlySpawnRequestV1, runtime: FakeNightlyRuntime) => void | Promise<void>) {}

  queueHandoff(path: string): void {
    this.handoffs.add(path);
  }

  async spawn(request: NightlySpawnRequestV1): Promise<DispatchAcknowledgementV1> {
    if (this.activeRequest?.runId === request.runId) {
      return {
        schema: "oll.dispatch-ack.v1",
        runId: request.runId,
        accepted: true,
        acknowledgedAt: "2026-08-11T00:41:00.000Z",
        runtimeLabel: request.runtimeLabel,
        resolvedModel: request.model,
        dispatchRef: `fake:${request.runId}`,
      };
    }
    if (this.activeRequest) {
      throw new Error(`spawn-before-terminal-apply:${this.activeRequest.runId}`);
    }
    this.activeRequest = request;
    this.activeRethinkRuns += 1;
    this.maxConcurrentRethinkRuns = Math.max(
      this.maxConcurrentRethinkRuns,
      this.activeRethinkRuns,
    );
    this.events.push({ type: "spawn", workspaceId: request.workspaceId, runId: request.runId });
    await this.onSpawn?.(request, this);
    return {
      schema: "oll.dispatch-ack.v1",
      runId: request.runId,
      accepted: true,
      acknowledgedAt: "2026-08-11T00:41:00.000Z",
      runtimeLabel: request.runtimeLabel,
      resolvedModel: request.model,
      dispatchRef: `fake:${request.runId}`,
    };
  }

  async awaitHandoff(expectedPath: string, _timeoutMs = 900_000): Promise<HandoffWaitResultV1> {
    if (!this.activeRequest) throw new Error("await-without-active-run");
    if (this.activeRequest.expectedHandoffPath !== expectedPath) {
      throw new Error("unexpected-handoff-path");
    }
    const found = this.handoffs.has(expectedPath);
    if (found) {
      this.events.push({
        type: "handoff",
        workspaceId: this.activeRequest.workspaceId,
        runId: this.activeRequest.runId,
      });
    }
    return {
      schema: "oll.handoff-wait-result.v1",
      runId: this.activeRequest.runId,
      expectedPath,
      status: found ? "file" : "timeout",
      observedPath: found ? expectedPath : null,
      observedAt: "2026-08-11T00:42:00.000Z",
      errorClass: found ? null : "handoff_timeout",
    };
  }

  markTerminalApplied(runId: string): void {
    if (!this.activeRequest || this.activeRequest.runId !== runId) {
      throw new Error("terminal-apply-run-mismatch");
    }
    this.events.push({
      type: "terminal_apply",
      workspaceId: this.activeRequest.workspaceId,
      runId,
    });
    this.activeRequest = null;
    this.activeRethinkRuns -= 1;
  }

  markTerminalFailed(runId: string): void {
    if (!this.activeRequest || this.activeRequest.runId !== runId) throw new Error("terminal-failure-run-mismatch");
    this.activeRequest = null;
    this.activeRethinkRuns -= 1;
  }

  async resume(batchId: string): Promise<ResumeResultV1> {
    this.events.push({ type: "resume", batchId });
    return {
      schema: "oll.resume-result.v1",
      batchId,
      resumed: true,
      resumedAt: "2026-08-11T00:43:00.000Z",
    };
  }
}
