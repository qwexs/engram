import type { DailyNoteApplicatorResult } from "./daily-note-applicator.ts";

type TimerHandle = ReturnType<typeof setTimeout>;

export class AutonomousDailyNoteCanaryRunner {
  private timer: TimerHandle | null = null;
  private running = false;
  private stopped = true;
  private wakeRequested = false;

  constructor(private readonly options: {
    isActive: () => boolean;
    processOne: () => Promise<DailyNoteApplicatorResult>;
    nextDueAt?: () => Date | null;
    onResult?: (result: DailyNoteApplicatorResult) => void;
    onError?: (error: unknown) => void;
    batchLimit?: number;
    busyDelayMs?: number;
    retryDelayMs?: number;
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
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
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
      for (let processed = 0; processed < (this.options.batchLimit ?? 1); processed++) {
        const result = await this.options.processOne();
        this.options.onResult?.(result);
        if (result.status === "idle") {
          this.scheduleNextDue();
          break;
        }
        if (result.status === "disabled") break;
        if (result.status === "busy") {
          this.schedule(this.options.busyDelayMs ?? 1_000);
          return;
        }
        if (result.status === "retry") {
          this.schedule(this.options.retryDelayMs ?? 5_000);
          return;
        }
        if (result.status === "qmd_pending") {
          this.schedule(Math.max(0, Date.parse(result.nextAttemptAt) - Date.now()));
          return;
        }
      }
    } catch (error) {
      this.options.onError?.(error);
      this.schedule(this.options.retryDelayMs ?? 5_000);
    } finally {
      this.running = false;
      if (this.wakeRequested && !this.stopped) {
        this.wakeRequested = false;
        this.schedule(0);
      }
    }
  }

  private scheduleNextDue(): void {
    const dueAt = this.options.nextDueAt?.();
    if (dueAt) this.schedule(Math.max(0, dueAt.getTime() - Date.now()));
  }
}
