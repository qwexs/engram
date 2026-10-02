import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { sanitizeEvidence, sha256, type JsonValue } from "./ledger.ts";
/** Host-owned visible transcript pages only. No tool arguments, raw database
 * reads, last-message lookup, or timestamp matching are accepted here. */
export type CompletionTarget = {
    agentId: string;
    sessionKey: string;
    sessionId: string;
};
export type CompletionRequest = CompletionTarget & {
    candidateId: string;
    runId: string;
    sourceTurnId: string;
};
export type NativeCompletion = {
    kind: "native_run_terminal";
    entryId: string;
    sourceEntryId: string;
    sourceMirrorIdentity: string;
    finalMirrorIdentity: string;
    sourceTextDigest: string;
    sourceTurnId: string;
    runId: string;
    text: string;
};
export type CompletionMirror = NativeCompletion | {
    kind?: "message_tool_delivery"; // absent on persisted v1 message-tool matches
    entryId: string;
    toolCallId: string;
    text: string;
};
type NativeSourceAnchor = {
    entryId: string;
    mirrorIdentity: string;
    sourceTextDigest: string;
};
export type CompletionPage = {
    kind: "page";
    cursor: string;
    hasMore: boolean;
    requiredBytes?: number;
    entries: Array<{
        entryId: string;
        message: Record<string, any>;
    }>;
} | {
    kind: "reset";
    cursor: string;
    reason: string;
} | {
    kind: "missing" | "unavailable";
    reason?: string;
};
type Pending = {
    request: CompletionRequest;
    registeredAt: string;
    mirror: CompletionMirror | null;
    sourceAnchor?: NativeSourceAnchor | null;
};
type State = {
    schema: "engram.completion-mirror-feed.v1";
    target: CompletionTarget;
    cursor?: string;
    pending: Pending[];
    blocked: string | null;
    lastReset?: {
        reason: string;
        observedAt: string;
    };
};
/** Same bounded, sanitized source representation as the runtime adapter. */
export function completionSourceDigest(content: unknown): string {
    const text = typeof content === "string" ? content.trim() : Array.isArray(content)
        ? content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text.trim()).filter(Boolean).join("\n") : "";
    return sha256(String(sanitizeEvidence(text.slice(0, 50000).trim())));
}
function equal(a: unknown, b: unknown): boolean { return sha256(a as JsonValue) === sha256(b as JsonValue); }
function textOnly(content: unknown): string {
    if (typeof content === "string")
        return content;
    return Array.isArray(content) ? content.filter(c => c?.type === "text" && typeof c.text === "string").map(c => c.text).join("\n") : "";
}
/** One durable cursor per exact host transcript. Register before agent_end;
 * tick is single-flight. Persist both the cursor and matched finals BEFORE
 * invoking admission, so retries/restarts cannot drop a delivered result. */
export class CompletionMirrorFeed {
    private busy = false;
    constructor(private readonly options: {
        root: string;
        target: CompletionTarget;
        read: (request: CompletionTarget & {
            cursor?: string;
            maxMessages: number;
            maxBytes: number;
        }) => Promise<CompletionPage>;
        deliver: (request: CompletionRequest, mirror: CompletionMirror) => Promise<"done" | "retry">;
        expire?: (request: CompletionRequest, reason: string) => Promise<"done" | "retry">;
        maxWaitMs?: number;
        now?: () => Date;
        fault?: (point: "after_page" | "after_delivery") => void;
    }) { }
    register(request: CompletionRequest): void {
        if (!equal(this.targetOf(request), this.options.target)
            || !/^channel-user:v1:[a-f0-9]{64}$/.test(request.sourceTurnId)
            || !request.runId || !request.candidateId)
            throw Error("COMPLETION_IDENTITY_CONFLICT");
        const state = this.load();
        const prior = state.pending.find(p => p.request.candidateId === request.candidateId);
        if (prior) {
            if (!equal(prior.request, request))
                throw Error("COMPLETION_IDENTITY_CONFLICT");
            return;
        }
        if (state.pending.length >= 100)
            throw Error("COMPLETION_BACKPRESSURE");
        // A newly registered source may already be behind a previous request's
        // cursor. Rescan this exact host branch, never look up a last message.
        delete state.cursor;
        for (const item of state.pending) { item.sourceAnchor = null; item.mirror = null; }
        state.pending.push({ request, registeredAt: this.now().toISOString(), mirror: null, sourceAnchor: null });
        this.save(state);
    }
    static hasDurablePending(root: string, request: CompletionRequest): boolean {
        const feed = new CompletionMirrorFeed({ root, target: {agentId: request.agentId, sessionKey: request.sessionKey, sessionId: request.sessionId},
            read: async () => ({kind: "unavailable"}), deliver: async () => "retry" });
        const pending = feed.load().pending.find(p => p.request.candidateId === request.candidateId);
        if (pending && !equal(pending.request, request)) throw Error("COMPLETION_IDENTITY_CONFLICT");
        return !!pending;
    }
    hasPending(candidateId: string): boolean { return this.load().pending.some(p => p.request.candidateId === candidateId); }
    status(): {
        pending: number;
        matched: number;
        blocked: string | null;
    } {
        const s = this.load();
        return { pending: s.pending.length, matched: s.pending.filter(p => p.mirror).length, blocked: s.blocked };
    }
    async tick(): Promise<{
        status: "busy" | "pending" | "caught_up" | "blocked";
        delivered: number;
    }> {
        if (this.busy)
            return { status: "busy", delivered: 0 };
        this.busy = true;
        try {
            let delivered = 0;
            // A missing final never means an unimportant source. The runtime may
            // preserve its verified user utterance as outcome-unknown; this separate
            // receipt retains the unresolved-final debt for exact later recovery.
            const waitMs = this.options.maxWaitMs ?? 25 * 60000;
            if (!Number.isSafeInteger(waitMs) || waitMs < 1 || waitMs > 24 * 3600000)
                throw Error("COMPLETION_WAIT_INVALID");
            const initial = this.load();
            if (initial.pending.some(p => p.sourceAnchor === undefined)) {
                // Upgrade old mirror-only waits once; their source may already
                // be behind the persisted cursor. Keep identities/deadlines.
                delete initial.cursor;
                for (const pending of initial.pending) pending.sourceAnchor = null;
                this.save(initial);
            }
            // Catch up within the existing wake: two pages every 15 seconds can
            // take minutes and restart from zero on a legitimate host rewrite.
            // Bound both work and wall time, yielding between SDK pages so the
            // Gateway remains responsive. Normal caught-up reads still return early.
            const scanStarted = performance.now();
            for (let pageNumber = 0; pageNumber < 32; pageNumber++) {
                if (pageNumber > 0) {
                    await new Promise<void>(resolve => setImmediate(resolve));
                    if (performance.now() - scanStarted >= 1000)
                        break;
                }
                const before = this.load();
                if (before.blocked)
                    return { status: "blocked", delivered };
                const page = await this.options.read({ ...this.options.target, cursor: before.cursor, maxMessages: 1000, maxBytes: 4000000 });
                // A request may have registered while awaiting the host read.
                const state = this.load();
                if (state.cursor !== before.cursor)
                    throw Error("COMPLETION_CURSOR_CONFLICT");
                if (page.kind !== "page") {
                    if (page.kind === "reset") {
                        this.reset(state, page);
                        this.save(state);
                    }
                    return { status: state.blocked ? "blocked" : "pending", delivered };
                }
                if (page.requiredBytes) {
                    state.blocked = "transcript_event_over_budget";
                    this.save(state);
                    return { status: "blocked", delivered };
                }
                if (!page.cursor || (page.hasMore && page.cursor === state.cursor))
                    throw Error("COMPLETION_CURSOR_STALLED");
                for (const entry of page.entries) {
                    const m = entry.message;
                    const metadata = m?.__openclaw;
                    if (m?.role === "user" && metadata?.mirrorOrigin === "codex-app-server"
                        && typeof metadata.mirrorIdentity === "string" && metadata.mirrorIdentity.endsWith(":prompt") && entry.entryId) {
                        for (const pending of state.pending.filter(p => p.request.sourceTurnId === m.idempotencyKey && p.request.runId === metadata.runId)) {
                            const anchor = {entryId: entry.entryId, mirrorIdentity: metadata.mirrorIdentity, sourceTextDigest: completionSourceDigest(m.content)};
                            if (pending.sourceAnchor && !equal(pending.sourceAnchor, anchor)) state.blocked = "ambiguous_source_anchor";
                            else pending.sourceAnchor = anchor;
                        }
                        continue;
                    }
                    const mirror = m?.openclawDeliveryMirror;
                    if (m?.role !== "assistant" || !entry.entryId) continue;
                    const phase = m.phase ?? m.channel;
                    const isNative = m.provider === "openai" && metadata?.mirrorOrigin === "codex-app-server" && metadata.runTerminal === true
                        && m.stopReason === "stop" && (phase === undefined || phase === "final")
                        && typeof metadata.mirrorIdentity === "string" && metadata.mirrorIdentity.endsWith(":assistant");
                    const isMessageTool = m.provider === "openclaw" && m.model === "delivery-mirror"
                        && mirror?.kind === "message-tool-source-reply" && mirror.final === true
                        && typeof mirror.toolCallId === "string" && !!mirror.toolCallId;
                    if (!isNative && !isMessageTool) continue;
                    for (const pending of state.pending) {
                        let candidate: CompletionMirror;
                        if (isNative) {
                            const source = pending.sourceAnchor;
                            if (!source || pending.request.runId !== metadata.runId
                                || source.mirrorIdentity.slice(0, -7) !== metadata.mirrorIdentity.slice(0, -10)) continue;
                            candidate = {kind: "native_run_terminal", entryId: entry.entryId,
                                sourceEntryId: source.entryId, sourceMirrorIdentity: source.mirrorIdentity,
                                finalMirrorIdentity: metadata.mirrorIdentity, sourceTextDigest: source.sourceTextDigest,
                                sourceTurnId: pending.request.sourceTurnId, runId: metadata.runId, text: ""};
                        } else {
                            if (pending.request.sourceTurnId !== mirror.sourceTurnId) continue;
                            candidate = {kind: "message_tool_delivery", entryId: entry.entryId, toolCallId: mirror.toolCallId, text: ""};
                        }
                        const text = textOnly(m.content);
                        if (text.length > 50000) {state.blocked = "final_text_over_budget";continue;}
                        candidate.text = String(sanitizeEvidence(text)).trim();
                        // Identical native/message-tool reports may describe the
                        // same final; prefer native provenance. Conflicts fail closed.
                        if (pending.mirror && pending.mirror.text !== candidate.text) state.blocked = "ambiguous_final_delivery";
                        else if (!pending.mirror || candidate.kind === "native_run_terminal") pending.mirror = candidate;
                    }
                }
                state.cursor = page.cursor;
                this.save(state);
                this.options.fault?.("after_page");
                if (state.blocked)
                    return { status: "blocked", delivered };
                if (!page.hasMore) {
                    // Revalidate the anchor after any restart and before admitting a
                    // stored match. A reset is surfaced, never silently rewound.
                    const check = await this.options.read({ ...this.options.target, cursor: state.cursor, maxMessages: 1, maxBytes: 4000000 });
                    if (check.kind === "reset") {
                        const latest = this.load();
                        this.reset(latest, check);
                        this.save(latest);
                        return { status: latest.blocked ? "blocked" : "pending", delivered };
                    }
                    if (check.kind !== "page" || check.entries.length || check.hasMore)
                        return { status: "pending", delivered };
                    for (const pending of this.load().pending) {
                        if (!pending.mirror)
                            continue;
                        if (await this.options.deliver(pending.request, pending.mirror) !== "done")
                            continue;
                        this.options.fault?.("after_delivery");
                        const latest = this.load();
                        latest.pending = latest.pending.filter(p => p.request.candidateId !== pending.request.candidateId);
                        this.save(latest);
                        delivered++;
                    }
                    await this.expireCaughtUp(waitMs);
                    return { status: "caught_up", delivered };
                }
            }
            return { status: "pending", delivered };
        }
        finally {
            this.busy = false;
        }
    }
    private async expireCaughtUp(waitMs: number): Promise<void> {
        // Only a validated, caught-up SDK branch can prove no final is visible.
        for (const pending of this.load().pending) {
                // A known final is admission debt, not missing-final debt. Its
                // checkpoint TTL/lifecycle owns eventual expiry, not this timer.
                if (pending.mirror || this.now().getTime() - Date.parse(pending.registeredAt) < waitMs || !this.options.expire)
                    continue;
                const reason = this.load().blocked ?? "final_wait_deadline";
                if (await this.options.expire(pending.request, reason) !== "done")
                    continue;
                const state = this.load();
                const receipt = { schema: "engram.completion-unresolved.v1", request: pending.request, reason, closedAt: this.now().toISOString() };
                const receiptPath = join(this.options.root, `unresolved-${sha256(pending.request as unknown as JsonValue).slice(7)}.json`);
                if (!existsSync(receiptPath)) {
                    mkdirSync(this.options.root, { recursive: true });
                    const temporary = `${receiptPath}.${randomUUID()}.tmp`;
                    writeFileSync(temporary, JSON.stringify(receipt) + "\n", { mode: 0o600, flag: "wx" });
                    const fd = openSync(temporary, "r");
                    try {
                        fsyncSync(fd);
                    }
                    finally {
                        closeSync(fd);
                    }
                    renameSync(temporary, receiptPath);
                }
                else {
                    const existing = JSON.parse(readFileSync(receiptPath, "utf8"));
                    if (existing.schema !== receipt.schema || !equal(existing.request, pending.request))
                        throw Error("COMPLETION_RECEIPT_CONFLICT");
                }
                state.pending = state.pending.filter(p => p.request.candidateId !== pending.request.candidateId);
                this.save(state);
            }
    }
    private reset(state: State, reset: Extract<CompletionPage, {
        kind: "reset";
    }>): void {
        // The supported API returns an initial cursor for the NEW active branch.
        // Retain source identities but discard every old-branch match. Re-scan the
        // new branch incrementally; only a newly observed exact mirror can admit.
        for (const pending of state.pending) { pending.mirror = null; pending.sourceAnchor = null; }
        state.lastReset = { reason: reset.reason, observedAt: this.now().toISOString() };
        if (["generation_mismatch", "anchor_missing", "anchor_moved"].includes(reset.reason) && reset.cursor) {
            state.cursor = reset.cursor;
            state.blocked = null;
        }
        else
            state.blocked = `transcript_reset:${reset.reason}`;
    }
    private now(): Date { return this.options.now?.() ?? new Date(); }
    private targetOf(r: CompletionTarget): CompletionTarget { return { agentId: r.agentId, sessionKey: r.sessionKey, sessionId: r.sessionId }; }
    private path(): string { return join(this.options.root, sha256(this.options.target as unknown as JsonValue).slice(7) + ".json"); }
    private load(): State {
        if (!existsSync(this.path()))
            return { schema: "engram.completion-mirror-feed.v1", target: this.options.target, pending: [], blocked: null };
        const saved = JSON.parse(readFileSync(this.path(), "utf8"));
        const { digest, ...state } = saved;
        if (digest !== sha256(state as JsonValue) || state.schema !== "engram.completion-mirror-feed.v1"
            || !equal(state.target, this.options.target) || !Array.isArray(state.pending))
            throw Error("COMPLETION_STATE_CORRUPT");
        for (const item of state.pending) {
            if (!item?.request || !equal(this.targetOf(item.request), this.options.target)
                || !/^channel-user:v1:[a-f0-9]{64}$/.test(item.request.sourceTurnId)
                || !item.request.runId || !item.request.candidateId || !Number.isFinite(Date.parse(item.registeredAt)))
                throw Error("COMPLETION_STATE_CORRUPT");
        }
        return state as State;
    }
    private save(state: State): void {
        const path = this.path();
        mkdirSync(dirname(path), { recursive: true });
        const temporary = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporary, JSON.stringify({ ...state, digest: sha256(state as unknown as JsonValue) }) + "\n", { mode: 0o600 });
        const fd = openSync(temporary, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
        const directory = openSync(dirname(path), "r");
        try {
            fsyncSync(directory);
        }
        finally {
            closeSync(directory);
        }
    }
}
