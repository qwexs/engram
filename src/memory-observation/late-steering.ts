import { OpenClawObservationRuntimeAdapter, RuntimeAdapterError } from './runtime-adapter.ts';
import type { CompletionPage, CompletionTarget } from './completion-mirror-feed.ts';

type HostRead = (request: CompletionTarget & {cursor?: string; maxMessages: number; maxBytes: number}) => Promise<CompletionPage>;
const fail = () => new RuntimeAdapterError('STEERING_SOURCE_UNVERIFIED', 'bounded exact host source read is unavailable or incomplete');

/** Only read the exact current host branch when more than one unbound source
 * competes. Never guess by recency or treat an incomplete page as an ordinary
 * source. Timeout/stop consumes late SDK results without adapter mutations. */
export async function reconcileLateSteering(
  adapter: OpenClawObservationRuntimeAdapter,
  context: {agentId: string; sessionKey: string; sessionId?: string; runId: string; trigger?: string},
  read: HostRead,
  signal?: AbortSignal,
  limits = {maxPages: 32, maxTotalBytes: 16 * 1024 * 1024, timeoutMs: 4_000},
): Promise<void> {
  const snapshot = adapter.steeringSourceSnapshot(context);
  if (!snapshot) return;
  if (!context.sessionId || !context.agentId || context.sessionKey.split(':')[1] !== context.agentId) throw fail();
  const deadline = Date.now() + limits.timeoutMs;
  const selected: unknown[] = [];
  const ids = new Set(snapshot.sourceTurnIds);
  let cursor: string | undefined, bytes = 0;
  for (let pageCount = 0; pageCount < limits.maxPages; pageCount++) {
    if (signal?.aborted || Date.now() >= deadline) throw fail();
    const page = await new Promise<CompletionPage>((resolve, reject) => {
      const stopped = () => { cleanup(); reject(fail()); };
      const timer = setTimeout(stopped, Math.max(1, deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', stopped); };
      signal?.addEventListener('abort', stopped, {once: true});
      Promise.resolve().then(() => read({agentId: context.agentId, sessionKey: context.sessionKey,
        sessionId: context.sessionId!, ...(cursor ? {cursor} : {}), maxMessages: 256, maxBytes: 1024 * 1024}))
        .then(value => { cleanup(); resolve(value); }, () => { cleanup(); reject(fail()); });
    });
    if (signal?.aborted || Date.now() >= deadline || page?.kind !== 'page'
      || !Array.isArray(page.entries) || page.entries.length > 256 || typeof page.hasMore !== 'boolean'
      || typeof page.cursor !== 'string' || !page.cursor || page.requiredBytes) throw fail();
    bytes += Buffer.byteLength(JSON.stringify(page));
    if (bytes > limits.maxTotalBytes) throw fail();
    for (const entry of page.entries) {
      if (entry?.message?.role === 'user' && ids.has(entry.message.idempotencyKey)) selected.push(entry.message);
    }
    if (!page.hasMore) {
      adapter.confirmLateSteering(snapshot, selected);
      return;
    }
    if (page.cursor === cursor) throw fail();
    cursor = page.cursor;
  }
  throw fail();
}
