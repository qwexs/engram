import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RegistrySnapshotV1, WorkspaceRegistryAdapter } from "./contracts";
import { atomicWriteJson } from "./legacy-migration";
import { TrustedNightlyRuntime, type TrustedSpawnRecordV1, type TrustedSpawnTransport } from "./trusted-runtime";

type JsonObject = Record<string, any>;

function readObject(path: string): JsonObject {
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must contain an object`);
  return value;
}

function key(label: string): string {
  if (!label || label.length > 300 || /[\u0000-\u001f]/.test(label)) throw new Error("runtimeLabel is invalid");
  return createHash("sha256").update(label).digest("hex");
}

export class NightlyDispatchPendingError extends Error {
  readonly request: JsonObject;
  constructor(request: JsonObject) {
    super("nightly dispatch requires the trusted OpenClaw transport");
    this.name = "NightlyDispatchPendingError";
    this.request = request;
  }
}

export class FileWorkspaceRegistryAdapter implements WorkspaceRegistryAdapter {
  constructor(readonly snapshotPath: string) {}
  async snapshot(): Promise<RegistrySnapshotV1> {
    return readObject(resolve(this.snapshotPath)) as RegistrySnapshotV1;
  }
}

/**
 * Durable bridge between the Bun coordinator and OpenClaw Code Mode. The Bun
 * step writes exactly one immutable spawn request and exits. Code Mode owns
 * sessions_spawn, records an acknowledgement, then resumes the same fenced
 * batch. No interval polling or second scheduler is involved.
 */
export class FileDispatchTransport implements TrustedSpawnTransport {
  readonly root: string;
  constructor(stateRoot: string, readonly now: () => string = () => new Date().toISOString()) {
    this.root = join(resolve(stateRoot), "oll-nightly", "dispatch");
  }

  private paths(runtimeLabel: string) {
    const id = key(runtimeLabel);
    return {
      request: join(this.root, "requests", `${id}.json`),
      acknowledgement: join(this.root, "acknowledgements", `${id}.json`),
      terminal: join(this.root, "terminal", `${id}.json`),
    };
  }

  async findByRuntimeLabel(runtimeLabel: string): Promise<TrustedSpawnRecordV1 | null> {
    const path = this.paths(runtimeLabel).acknowledgement;
    if (!existsSync(path)) return null;
    const value = readObject(path);
    if (value.schema !== "oll.dispatch-acknowledgement.v1" || value.runtimeLabel !== runtimeLabel) {
      throw new Error("durable dispatch acknowledgement is invalid");
    }
    if (value.accepted !== true) throw new Error(`trusted dispatch was rejected: ${value.error || "unknown error"}`);
    return { dispatchRef: String(value.dispatchRef), runtimeLabel, resolvedModel: String(value.resolvedModel) };
  }

  async spawn(input: {
    task: string;
    label: string;
    runtimeLabel: string;
    model: string;
    workspacePath: string;
    runTimeoutSeconds: number;
  }): Promise<TrustedSpawnRecordV1> {
    const paths = this.paths(input.runtimeLabel);
    const request = {
      schema: "oll.openclaw-spawn-request.v1",
      ...input,
      createdAt: this.now(),
    };
    mkdirSync(join(this.root, "requests"), { recursive: true });
    if (existsSync(paths.request)) {
      const existing = readObject(paths.request);
      const stable = { ...existing, createdAt: request.createdAt };
      if (JSON.stringify(stable) !== JSON.stringify(request)) throw new Error("immutable dispatch request drift");
    } else atomicWriteJson(paths.request, request);
    throw new NightlyDispatchPendingError(readObject(paths.request));
  }

  acknowledge(input: {
    runtimeLabel: string;
    accepted: boolean;
    dispatchRef: string;
    resolvedModel: string;
    error?: string | null;
  }): JsonObject {
    const paths = this.paths(input.runtimeLabel);
    if (!existsSync(paths.request)) throw new Error("dispatch request is unavailable");
    const request = readObject(paths.request);
    if (request.runtimeLabel !== input.runtimeLabel) throw new Error("dispatch request label mismatch");
    const value = {
      schema: "oll.dispatch-acknowledgement.v1",
      runtimeLabel: input.runtimeLabel,
      accepted: input.accepted === true,
      dispatchRef: String(input.dispatchRef || ""),
      resolvedModel: String(input.resolvedModel || ""),
      error: input.error ? String(input.error).slice(0, 1000) : null,
      acknowledgedAt: this.now(),
    };
    if (value.accepted && value.resolvedModel !== request.model) throw new Error("acknowledged model differs from requested model");
    mkdirSync(join(this.root, "acknowledgements"), { recursive: true });
    if (existsSync(paths.acknowledgement)) {
      const existing = readObject(paths.acknowledgement);
      if (
        existing.runtimeLabel !== value.runtimeLabel
        || existing.accepted !== value.accepted
        || existing.dispatchRef !== value.dispatchRef
        || existing.resolvedModel !== value.resolvedModel
      ) throw new Error("immutable dispatch acknowledgement drift");
      return existing;
    }
    atomicWriteJson(paths.acknowledgement, value);
    return value;
  }

  markTerminal(runtimeLabel: string, status: "applied" | "failed"): void {
    const paths = this.paths(runtimeLabel);
    mkdirSync(join(this.root, "terminal"), { recursive: true });
    if (!existsSync(paths.terminal)) atomicWriteJson(paths.terminal, {
      schema: "oll.dispatch-terminal.v1", runtimeLabel, status, createdAt: this.now(),
    });
  }
}

export class DurableTrustedNightlyRuntime extends TrustedNightlyRuntime {
  readonly maxConcurrentRethinkRuns = 1;
  constructor(readonly durableTransport: FileDispatchTransport, now?: () => string) {
    super(durableTransport, now);
  }
}
