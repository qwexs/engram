import type { EpisodicEvaluatorRunResult } from "./episodic-evaluator.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

export class AutonomousEpisodicRunner {
  private timer: TimerHandle | null = null;
  private scheduledAt = Number.POSITIVE_INFINITY;
  private running = false;
  private stopped = true;
  private wakeRequested = false;

  constructor(private readonly options: {
    isActive: () => boolean;
    processOne: () => Promise<EpisodicEvaluatorRunResult>;
    nextDueAt: () => Date | null;
    onResult?: (result: EpisodicEvaluatorRunResult) => void;
    onError?: (error: unknown) => void;
    now?: () => Date;
    batchLimit?: number;
    busyDelayMs?: number;
    errorDelayMs?: number;
  }) {}

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  wake(): void {
    if (this.stopped) {
      this.start();
      return;
    }
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    this.wakeRequested = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.scheduledAt = Number.POSITIVE_INFINITY;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const target = Date.now() + Math.max(0, delayMs);
    if (this.timer && this.scheduledAt <= target) return;
    if (this.timer) clearTimeout(this.timer);
    this.scheduledAt = target;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledAt = Number.POSITIVE_INFINITY;
      void this.drain();
    }, Math.max(0, delayMs));
    this.timer.unref?.();
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      if (!this.options.isActive()) {
        this.stop();
        return;
      }
      const batchLimit = this.options.batchLimit ?? 25;
      for (let processed = 0; processed < batchLimit && !this.stopped; processed++) {
        if (!this.options.isActive()) {
          this.stop();
          return;
        }
        const result = await this.options.processOne();
        this.options.onResult?.(result);
        if (result.status === "idle") break;
        if (result.status === "busy") {
          this.schedule(this.options.busyDelayMs ?? 1_000);
          return;
        }
      }
      if (this.stopped || !this.options.isActive()) return;
      const nextDue = this.options.nextDueAt();
      if (nextDue) {
        const now = this.options.now?.() ?? new Date();
        this.schedule(Math.max(0, nextDue.getTime() - now.getTime()));
      }
    } catch (error) {
      this.options.onError?.(error);
      this.schedule(this.options.errorDelayMs ?? 5_000);
    } finally {
      this.running = false;
      if (this.wakeRequested && !this.stopped) {
        this.wakeRequested = false;
        this.schedule(0);
      }
    }
  }
}
