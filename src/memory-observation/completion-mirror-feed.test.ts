import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionMirrorFeed, type CompletionPage, type CompletionRequest } from './completion-mirror-feed.ts';
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0))
    rmSync(r, { recursive: true, force: true }); });
const target = { agentId: 'alpha', sessionKey: 'agent:alpha:telegram:direct:100000001', sessionId: 'session-a' };
const request: CompletionRequest = { ...target, candidateId: 'candidate-a', runId: 'run-a', sourceTurnId: 'channel-user:v1:' + 'a'.repeat(64) };
const mirror = (text = 'Done', final = true, sourceTurnId = request.sourceTurnId) => ({ entryId: 'entry-a', message: { role: 'assistant', provider: 'openclaw', model: 'delivery-mirror', content: text, openclawDeliveryMirror: { kind: 'message-tool-source-reply', final, sourceTurnId, toolCallId: 'call-a' } } });
const page = (entries: any[], cursor = 'c1', hasMore = false): CompletionPage => ({ kind: 'page', entries, cursor, hasMore });
function setup() { const root = mkdtempSync(join(tmpdir(), 'completion-feed-')); roots.push(root); return root; }
test('final before end and duplicate mirror yield one exact delivery; cursor survives restart', async () => {
    const root = setup();
    let calls = 0;
    let reads = 0;
    const cursors: (string | undefined)[] = [];
    const options = { root, target, read: async (p: any) => { cursors.push(p.cursor); return ++reads === 1 ? page([mirror(), mirror()]) : page([]); }, deliver: async (r: CompletionRequest, m: any) => { expect(r).toEqual(request); expect(m.text).toBe('Done'); calls++; return 'done' as const; } };
    const first = new CompletionMirrorFeed(options);
    first.register(request);
    expect((await first.tick()).delivered).toBe(1);
    const second = new CompletionMirrorFeed(options);
    expect(second.status().pending).toBe(0);
    await second.tick();
    expect(cursors.at(-1)).toBe('c1');
    expect(calls).toBe(1);
});
test('late final is matched after restart, never by same-chat proximity', async () => {
    const root = setup();
    let delivered = 0;
    let entries: any[] = [mirror('foreign', true, 'channel-user:v1:' + 'b'.repeat(64)), mirror('progress', false)];
    const options = { root, target, read: async () => { const e = entries; entries = []; return page(e); }, deliver: async () => { delivered++; return 'done' as const; } };
    const first = new CompletionMirrorFeed(options);
    first.register(request);
    await first.tick();
    expect(first.status().pending).toBe(1);
    expect(delivered).toBe(0);
    entries = [mirror()];
    const second = new CompletionMirrorFeed(options);
    await second.tick();
    expect(delivered).toBe(1);
});
test('persist-before-admit resumes a matched final after crash with idempotent downstream delivery', async () => {
    const root = setup();
    let entries: any[] = [mirror()];
    const admitted = new Set();
    let fault: string | null = 'after_page';
    const options = { root, target, read: async () => { const e = entries; entries = []; return page(e); }, deliver: async (r: CompletionRequest) => { admitted.add(r.sourceTurnId); return 'done' as const; }, fault: (p: any) => { if (p === fault)
            throw Error('crash'); } };
    const first = new CompletionMirrorFeed(options);
    first.register(request);
    await expect(first.tick()).rejects.toThrow('crash');
    expect(admitted.size).toBe(0);
    fault = 'after_delivery';
    await expect(new CompletionMirrorFeed(options).tick()).rejects.toThrow('crash');
    expect(admitted.size).toBe(1);
    fault = null;
    await new CompletionMirrorFeed(options).tick();
    expect(admitted.size).toBe(1);
    expect(new CompletionMirrorFeed(options).status().pending).toBe(0);
});
for (const mode of ['reset', 'attachment', 'ambiguous', 'forged', 'oversize'] as const)
    test(`handles ${mode} without inventing delivery`, async () => {
        const root = setup();
        let reads = 0;
        let delivered = 0;
        const options = { root, target, read: async (): Promise<CompletionPage> => {
                reads++;
                if (mode === 'reset' && reads === 2)
                    return { kind: 'reset', cursor: 'new', reason: 'generation_mismatch' };
                if (reads > 1)
                    return page([]);
                if (mode === 'oversize')
                    return { ...page([], 'c1', true) as any, requiredBytes: 8000000 };
                if (mode === 'attachment')
                    return page([{ ...mirror(), message: { ...mirror().message, content: [{ type: 'image', url: 'not-text' }] } }]);
                if (mode === 'ambiguous')
                    return page([mirror(), { ...mirror('different'), entryId: 'entry-b' }]);
                if (mode === 'forged')
                    return page([{ ...mirror(), message: { ...mirror().message, provider: 'user' } }]);
                return page([mirror()]);
            }, deliver: async (_r: CompletionRequest, m: any) => { if (mode === 'attachment')
                expect(m.text).toBe(''); delivered++; return 'done' as const; } };
        const feed = new CompletionMirrorFeed(options);
        feed.register(request);
        const result = await feed.tick();
        expect(delivered).toBe(mode === 'attachment' ? 1 : 0);
        if (['ambiguous', 'oversize'].includes(mode))
            expect(result.status).toBe('blocked');
    });
test('rejects a request for another session incarnation and keeps bounded reads', async () => {
    const root = setup();
    let reads = 0;
    const feed = new CompletionMirrorFeed({ root, target, read: async (p) => { expect(p.maxBytes).toBe(4000000); return page([], `c${++reads}`, true); }, deliver: async () => 'done' });
    expect(() => feed.register({ ...request, sessionId: 'other' })).toThrow();
    feed.register(request);
    expect((await feed.tick()).status).toBe('pending');
    expect(reads).toBe(2);
    expect(feed.status().pending).toBe(1);
});
test('reset discards old branch match, scans fresh cursor and admits only the new exact final', async () => {
    const root = setup();
    let reads = 0;
    const received: string[] = [];
    const feed = new CompletionMirrorFeed({ root, target, read: async (p) => {
            reads++;
            if (reads === 1)
                return page([mirror('obsolete')]);
            if (reads === 2)
                return { kind: 'reset', cursor: 'new-root', reason: 'generation_mismatch' };
            if (reads === 3) {
                expect(p.cursor).toBe('new-root');
                return page([mirror('current')], 'new-tail');
            }
            return page([], 'new-tail');
        }, deliver: async (_r, m) => { received.push(m.text); return 'done'; } });
    feed.register(request);
    expect((await feed.tick()).status).toBe('pending');
    expect(received).toEqual([]);
    await feed.tick();
    expect(received).toEqual(['current']);
    expect(feed.status().pending).toBe(0);
});
test('deadline preserves source as unknown with explicit debt; retries do not duplicate expiration', async () => {
    const root = setup();
    let time = new Date('2026-09-01T12:00:00.000Z'), expired = 0;
    const options = { root, target, now: () => time, maxWaitMs: 60000, read: async () => page([]), deliver: async () => 'done' as const,
        expire: async (r: CompletionRequest, reason: string) => { expect(r).toEqual(request); expect(reason).toBe('final_wait_deadline'); expired++; return 'done' as const; } };
    const feed = new CompletionMirrorFeed(options);
    feed.register(request);
    await feed.tick();
    expect(expired).toBe(0);
    time = new Date(time.getTime() + 60000);
    await new CompletionMirrorFeed(options).tick();
    expect(expired).toBe(1);
    await new CompletionMirrorFeed(options).tick();
    expect(expired).toBe(1);
    expect(new CompletionMirrorFeed(options).status().pending).toBe(0);
});
