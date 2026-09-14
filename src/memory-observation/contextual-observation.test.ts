import { expect, test } from 'bun:test';
import { buildContextualObservation, contextualEvidenceCatalog, contextualPrompt, parseContextualJsonl, parseContextualOutput, renderContextualObservation, runContextualShadow, type ContextualOutput } from './contextual-observation.ts';
import { compileBatchFrame, type CompiledBatchBundleV1 } from './batch-compiler.ts';
import { deriveSourceDigest, sha256, type JsonValue } from './ledger.ts';
import { fixture as promptFixture, now as promptNow } from '../../tests/fixtures/memory-observation/contextual/bundle.ts';
const now = new Date('2026-09-01T12:10:00.000Z');
function fixture(texts = ['I can commit the timer fix.', 'Yes, do that.'], actors = ['actor-a', 'actor-a']): CompiledBatchBundleV1 {
    const scope = { workspaceId: 'alpha', runtimeSessionKey: 'agent:alpha:telegram:direct:100000001', scopeClass: 'self', scopeId: 'workspace:alpha' };
    const policyDigest = sha256('fixture-policy');
    const sources = texts.map((text, i) => {
        const traceId = sha256('trace-' + i), sourceTurnId = 'channel-user:v1:' + String(i + 1).repeat(64), sourceCompletedAt = `2026-09-01T12:0${i}:00.000Z`;
        const payload = { source: { role: 'user', text, actorId: actors[i] }, outcome: { role: 'assistant', text: i === 0 ? 'I can commit the timer fix.' : 'Timer fix committed.' } };
        const evidence = { schema: 'engram.memory-evidence-envelope.v1', traceId, scope, payload, createdAt: sourceCompletedAt, expiresAt: '2026-09-02T12:00:00.000Z' };
        return { envelope: { schema: 'engram.memory-observation-job.v1', traceId, sourceTurnId, scope, sourceCompletedAt, sourceDigest: deriveSourceDigest(sourceTurnId, scope as any, sourceCompletedAt), evidenceDigest: sha256({ schema: evidence.schema, traceId, scope, payload } as JsonValue), policyVersion: 'fixture-v1', policyDigest, evidenceRefs: [{ kind: 'source-turn', ref: sourceTurnId, digest: sha256(text) }], authority: { id: 'openclaw-runtime', version: 'v1', digest: sha256('runtime') }, admittedAt: sourceCompletedAt }, evidence };
    });
    return compileBatchFrame({ schema: 'engram.memory-batch-source-frame.v1', partition: { ...scope, producerEpoch: 'v1', policyDigest }, sealedAt: now.toISOString(), sources }, { schema: 'engram.memory-batch-compiler-config.v1', inactivityGapMs: 300000, maxTurns: 10, maxEvidenceBytes: 100000, maxAgeMs: 3600000 }).bundles[0]!;
}
function output(b = fixture()): ContextualOutput {
    const first = b.inputs[0]!, second = b.inputs[1]!;
    const quote = (first.evidence as any).outcome.text, text = (second.evidence as any).source.text;
    return { schema: 'engram.memory-contextual-output.v2', assertions: [{ id: 'decision', section: 'decisions', text: 'The user requested committing the timer fix.', subject: 'timer fix', resolution: 'resolved', actorRef: 'user', status: 'requested', spans: [{ traceId: first.traceId, role: 'assistant', start: 0, end: quote.length, quote }, { traceId: second.traceId, role: 'user', start: 0, end: text.length, quote: text }] }],
        dispositions: [{ traceId: first.traceId, kind: 'supports', assertionIds: ['decision'], reason: 'Identifies the proposed timer fix.' }, { traceId: second.traceId, kind: 'asserted', assertionIds: ['decision'], reason: 'Direct approval of the cited proposal.' }] };
}
function jsonl(b = fixture(), value: ContextualOutput = output(b)): string {
    const catalog = contextualEvidenceCatalog(b);
    const assertions = value.assertions.map(assertion => ({ ...assertion,
        spans: assertion.spans.map((span: any) => {
            if (typeof span.evidenceId === 'string') return span;
            const selected = catalog.find(entry => entry.span.traceId === span.traceId && entry.span.role === span.role
                && entry.span.quote === span.quote && entry.span.replyContextRef === span.replyContextRef
                && entry.span.episodeContextRef === span.episodeContextRef);
            if (!selected) throw Error('fixture evidence entry missing');
            return { evidenceId: selected.id, purpose: span.purpose ?? (span.role === assertion.actorRef ? 'assertion' : 'context') };
        }) }));
    const declared = new Set<string>();
    return value.dispositions.map((disposition, index) => {
        const recordAssertions = assertions.filter(assertion => {
            if (declared.has(assertion.id)) return false;
            const firstReference = value.dispositions.findIndex(candidate => candidate.assertionIds.includes(assertion.id));
            if (firstReference !== index && !(firstReference < 0 && index === 0)) return false;
            declared.add(assertion.id);
            return true;
        });
        return JSON.stringify({ type: 'source', ...disposition, assertions: recordAssertions });
    }).join('\n');
}
test('preserves exact quotation AND resolved interpretation, status and chronology in searchable text', () => {
    const b = fixture(), o = buildContextualObservation(output(b), b, sha256('contextual-policy'), now);
    expect(o.assertions[0]!.spans[1]!.quote).toBe('Yes, do that.');
    const rendered = renderContextualObservation(o);
    expect(rendered).toContain('requested committing the timer fix');
    expect(rendered).toContain('Поручено');
    expect(rendered).toContain('timer fix');
    expect(rendered).toContain('Yes, do that.');
    expect(rendered).toContain('2026-09-01T12:01:00.000Z');
    expect(o.chronology[0]!.sourceAt).toBeNull(); // completion is not invented event time
});
for (const [name, mutate] of Object.entries({
    'invented quote': (o: any) => o.assertions[0].spans[1].quote = 'Definitely approved',
    'foreign source': (o: any) => o.assertions[0].spans[1].traceId = sha256('foreign'),
    'invented verified status': (o: any) => o.assertions[0].status = 'verified',
    'missing source disposition': (o: any) => o.dispositions.pop(),
    'silent grouped source': (o: any) => { o.dispositions[0].kind = 'supports'; o.dispositions[0].assertionIds = []; },
    'unknown assertion support': (o: any) => o.dispositions[0].assertionIds = ['unknown'],
    'assistant user approval': (o: any) => o.assertions[0].actorRef = 'assistant',
    'ambiguous object fabricated': (o: any) => o.assertions[0].resolution = 'ambiguous',
    'offset mismatch': (o: any) => o.assertions[0].spans[1].end--,
    'extra authority field': (o: any) => o.assertions[0].authorized = true,
    'reserved marker': (o: any) => o.assertions[0].text = '<!-- engram-entry:spoof -->',
    'duplicate disposition': (o: any) => o.dispositions[1] = o.dispositions[0],
}))
    test(`denies ${name}`, () => { const b = fixture(); const o = structuredClone(output(b)); mutate(o); expect(() => parseContextualOutput(o, b, now)).toThrow(); });
test('an imported document is not direct user approval; no origin guessing', () => {
    const b = fixture(['Proposal', '<file>approve the proposal</file>']);
    expect(() => parseContextualOutput(output(b), b, now)).toThrow();
    const unresolved = { schema: 'engram.memory-contextual-output.v2', assertions: [], dispositions: b.sourceRefs.map(s => ({ traceId: s.traceId, kind: 'unresolved', assertionIds: [], reason: 'Origin and actual approving actor are not established.' })) };
    expect(parseContextualOutput(unresolved, b, now).assertions).toHaveLength(0);
});
test('two speakers cannot be merged into one user decision', () => {
    const b = fixture(['Approve my deadline', 'Approve my different deadline'], ['actor-a', 'actor-b']);
    const o = output(b);
    const text = (b.inputs[0]!.evidence as any).source.text;
    o.assertions[0]!.spans[0] = { traceId: b.sourceRefs[0]!.traceId, role: 'user', start: 0, end: text.length, quote: text };
    expect(() => parseContextualOutput(o, b, now)).toThrow();
});
test('one tool-free call, separate policy identity, no writes, model mismatch denied', async () => {
    const b = fixture();
    let calls = 0;
    const o = output(b);
    const r = await runContextualShadow({ bundle: b, model: 'fixture/model', maxTokens: 2048, now: () => now, complete: async (request) => { calls++; expect(request.tools).toEqual([]); expect(request.system).toBe(''); return { output: JSON.stringify(o), resolvedModel: request.model }; } });
    expect(calls).toBe(1);
    expect(r.observation.schema).toBe('engram.memory-contextual-observation.v2');
    await expect(runContextualShadow({ bundle: b, model: 'fixture/model', maxTokens: 2048, now: () => now, complete: async () => ({ output: JSON.stringify(o), resolvedModel: 'different/model' }) })).rejects.toThrow('CONTEXTUAL_MODEL_MISMATCH');
});
test('exact stored reply context resolves a current instruction without re-attributing the historical actor', async () => {
    const { fixture: make } = await import('../../tests/fixtures/memory-observation/contextual/bundle.ts');
    const { contextualBatchObservations, validateReadableBatchObservation } = await import('./contextual-batch-observation.ts');
    const pair = { traceId: sha256('prior'), sourceTurnId: 'channel-user:v1:' + 'c'.repeat(64), transportMessageId: '42', evidenceDigest: sha256('prior-evidence'),
        source: { role: 'user', text: 'Review the timer fix.' }, outcome: { role: 'assistant', text: 'I can commit the timer fix.' } };
    const b = make(['Yes, do that.'], ['actor-a'], ['I will do it.'], [{ status: 'complete', requestedReplyToId: '42', maxPairs: 5, pairs: [pair], reasonCode: null }]);
    const traceId = b.inputs[0]!.traceId;
    const o = { schema: 'engram.memory-contextual-output.v2', assertions: [{ id: 'a', section: 'decisions', text: 'The user requested committing the timer fix.', subject: 'timer fix', resolution: 'resolved', actorRef: 'user', status: 'requested', spans: [
                    { traceId, role: 'user', purpose: 'assertion', quote: 'Yes, do that.' },
                    { traceId, role: 'assistant', purpose: 'context', replyContextRef: '42', quote: 'I can commit the timer fix.' }
                ] }],
        dispositions: [{ traceId, kind: 'asserted', assertionIds: ['a'], reason: 'Current approval with exact reply context.' }] };
    const observations = contextualBatchObservations(o, b, sha256('v2'), now);
    expect(validateReadableBatchObservation(observations[0]!)).toEqual(observations[0]!);
    expect(observations[0]!.citations.some(c => c.evidenceRef.kind === 'message')).toBe(true);
    const forged = structuredClone(o);
    forged.assertions[0]!.spans[1]!.replyContextRef = '43';
    expect(() => parseContextualOutput(forged, b, now)).toThrow();
    const fakeActor = structuredClone(o);
    fakeActor.assertions[0]!.spans[1]!.purpose = 'assertion';
    expect(() => parseContextualOutput(fakeActor, b, now)).toThrow();
});


test('reordering quote fields cannot manufacture a second independent context span',()=>{
 const b=fixture();const o=output(b);const a=o.assertions[0]!;const original=a.spans[1]!;
 a.spans.push({quote:original.quote,end:original.end,start:original.start,role:original.role,traceId:original.traceId,purpose:'context'});
 expect(()=>parseContextualOutput(o,b,now)).toThrow();
});

test('bounded stored episode candidates resolves a current instruction without re-attributing the historical actor', async () => {
    const { fixture: make } = await import('../../tests/fixtures/memory-observation/contextual/bundle.ts');
    const { contextualBatchObservations, validateReadableBatchObservation } = await import('./contextual-batch-observation.ts');
    const pair = { traceId: sha256('prior'), sourceTurnId: 'channel-user:v1:' + 'c'.repeat(64), transportMessageId: '42', evidenceDigest: sha256('prior-evidence'),
        source: { role: 'user', text: 'Review the timer fix.' }, outcome: { role: 'assistant', text: 'I can commit the timer fix.' } };
    const b = make(['Yes, do that.'], ['actor-a'], ['I will do it.'], undefined, [{ status: 'candidates', maxPairs: 3, maxBytes: 16384, pairs: [pair], reasonCode: null }]);
    const traceId = b.inputs[0]!.traceId;
    const o = { schema: 'engram.memory-contextual-output.v2', assertions: [{ id: 'a', section: 'decisions', text: 'The user requested committing the timer fix.', subject: 'timer fix', resolution: 'resolved', actorRef: 'user', status: 'requested', spans: [
                    { traceId, role: 'user', purpose: 'assertion', quote: 'Yes, do that.' },
                    { traceId, role: 'assistant', purpose: 'context', episodeContextRef: '42', quote: 'I can commit the timer fix.' }
                ] }],
        dispositions: [{ traceId, kind: 'asserted', assertionIds: ['a'], reason: 'Current approval with exact reply context.' }] };
    const observations = contextualBatchObservations(o, b, sha256('v2'), now);
    expect(validateReadableBatchObservation(observations[0]!)).toEqual(observations[0]!);
    expect(observations[0]!.citations.some(c => c.evidenceRef.kind === 'message')).toBe(true);
    const forged = structuredClone(o);
    forged.assertions[0]!.spans[1]!.episodeContextRef = '43';
    expect(() => parseContextualOutput(forged, b, now)).toThrow();
    const fakeActor = structuredClone(o);
    fakeActor.assertions[0]!.spans[1]!.purpose = 'assertion';
    expect(() => parseContextualOutput(fakeActor, b, now)).toThrow();
});


test('derives a redundant context backlink without inventing a primary or semantic disposition',()=>{
 const b=fixture(),o=output(b);o.assertions[0]!.spans[0]!.purpose='context';
 o.assertions.push({id:'proposal',section:'events',text:'The assistant proposed a timer fix commit.',subject:'timer fix',resolution:'explicit',actorRef:'assistant',status:'proposed',spans:[{...o.assertions[0]!.spans[0]!,purpose:'assertion'}]});
 o.dispositions[0]={traceId:b.inputs[0]!.traceId,kind:'asserted',assertionIds:['proposal'],reason:'An explicit assistant proposal.'};
 const parsed=parseContextualOutput(o,b,now);
 expect(parsed.dispositions[0]!.assertionIds).toEqual(['proposal','decision']);
 expect(o.dispositions[0]!.assertionIds).toEqual(['proposal']); // source output is immutable
 expect(parseContextualOutput(parsed,b,now)).toEqual(parsed);
 const noAssertedSource=structuredClone(o);noAssertedSource.dispositions[1]!.kind='supports';
 expect(()=>parseContextualOutput(noAssertedSource,b,now)).toThrow();
 const noDisposition=structuredClone(o);noDisposition.dispositions.shift();
 expect(()=>parseContextualOutput(noDisposition,b,now)).toThrow();
 const primaryGap=structuredClone(o);primaryGap.assertions[0]!.spans[0]!.purpose='assertion';
 expect(()=>parseContextualOutput(primaryGap,b,now)).toThrow();
});

test('catalog selections preserve exact source/actor/offsets without generated quotes', async()=>{
 const {contextualEvidenceCatalog,contextualPrompt}=await import('./contextual-observation.ts');
 const b=fixture(),o:any=output(b),catalog=contextualEvidenceCatalog(b);
 for(const a of o.assertions) a.spans=a.spans.map((s:any)=>({evidenceId:catalog.find(e=>e.span.traceId===s.traceId&&e.span.role===s.role)!.id,purpose:s.traceId===b.inputs[1]!.traceId?'assertion':'context'}));
 const before=JSON.stringify(b);const parsed=parseContextualOutput(o,b,now);
 expect(parsed.assertions[0]!.spans[1]!.quote).toBe('Yes, do that.');
 expect(parsed.assertions[0]!.spans[1]!.role).toBe('user');
 expect(parseContextualOutput(parsed,b,now)).toEqual(parsed);
 expect(JSON.stringify(b)).toBe(before);
 expect(JSON.parse(contextualPrompt(b,now)).sources[0].excerpts.length).toBeGreaterThan(0);
 for(const bad of ['unknown',catalog[0]!.id+'x']) {const f=structuredClone(o);f.assertions[0].spans[0].evidenceId=bad;expect(()=>parseContextualOutput(f,b,now)).toThrow();}
 const override=structuredClone(o);override.assertions[0].spans[0].role='user';expect(()=>parseContextualOutput(override,b,now)).toThrow();
 const another=fixture(['Changed proposal','Yes, do that.']);expect(()=>parseContextualOutput(o,another,now)).toThrow();
});
test('catalog uses distinct reply/episode locators and never promotes historical speakers',async()=>{
 const {contextualEvidenceCatalog}=await import('./contextual-observation.ts');
 const {fixture:make}=await import('../../tests/fixtures/memory-observation/contextual/bundle.ts');
 const pair={traceId:sha256('past'),sourceTurnId:'channel-user:v1:'+'c'.repeat(64),transportMessageId:'42',evidenceDigest:sha256('past-data'),source:{text:'Review.'},outcome:{text:'I can commit the timer fix.'}};
 const b=make(['Yes, do that.'],['actor-a'],['I will do it.'],undefined,[{status:'candidates',pairs:[pair],maxPairs:3,maxBytes:16384,reasonCode:null}]);
 const c=contextualEvidenceCatalog(b),primary=c.find(e=>e.span.role==='user'&&!e.contextOnly)!,ctx=c.find(e=>e.span.role==='assistant'&&e.contextOnly)!;
 const o:any={schema:'engram.memory-contextual-output.v2',assertions:[{id:'a',section:'decisions',text:'Commit the timer fix.',subject:'timer fix',resolution:'resolved',actorRef:'user',status:'requested',spans:[{evidenceId:primary.id,purpose:'assertion'},{evidenceId:ctx.id,purpose:'context'}]}],dispositions:[{traceId:b.inputs[0]!.traceId,kind:'asserted',assertionIds:['a'],reason:'Explicit approval with context.'}]};
 const parsed=parseContextualOutput(o,b,now);expect(parsed.assertions[0]!.spans[1]!.episodeContextRef).toBe('42');expect(parsed.assertions[0]!.spans[1]!.replyContextRef).toBeUndefined();
 o.assertions[0].spans[1].purpose='assertion';expect(()=>parseContextualOutput(o,b,now)).toThrow();
});
test('catalog remains bounded per excerpt and covers long and repeated text without ambiguity',async()=>{
 const {contextualEvidenceCatalog}=await import('./contextual-observation.ts');
 const text=('Repeated sentence. '.repeat(85))+'😀 final';const b=fixture([text,'Yes.']);
 const c=contextualEvidenceCatalog(b).filter(e=>e.span.traceId===b.inputs[0]!.traceId&&e.span.role==='user');
 expect(c.map(e=>e.span.quote).join('')).toBe(text);expect(c.every(e=>e.span.quote.length<=650)).toBe(true);
 expect(new Set(c.map(e=>e.id)).size).toBe(c.length);
 const external=contextualEvidenceCatalog(fixture(['<file>Approve</file>','Yes.']));
 expect(external.filter(e=>e.span.role==='external').every(e=>e.contextOnly)).toBe(true);
});

test('diagnostics distinguish invalid JSON and provenance without persisting raw output', async () => {
    const b=fixture();
    const missing=output(b);missing.assertions[0]!.spans=[{evidenceId:'missing',purpose:'assertion'}] as any;
    for(const [raw,code] of [['private-text sk-secret not JSON','invalid_json'],[JSON.stringify(missing),'evidence_reference']] as const){
        try{await runContextualShadow({bundle:b,model:'fixture/model',maxTokens:2048,now:()=>now,
            complete:async()=>({resolvedModel:'fixture/model',output:raw})});throw Error('must reject');}
        catch(e:any){expect(e.diagnostic).toEqual({stage:'validation',code:'CONTEXTUAL_OUTPUT_DENIED:'+code,outputLength:raw.length,outputDigest:sha256(raw)});
            expect(JSON.stringify(e.diagnostic)).not.toContain('private-text');expect(JSON.stringify(e.diagnostic)).not.toContain('sk-secret');}
    }
});
test('provider exceptions are classified using allowlisted codes, never provider messages', async () => {
    for(const [supplied,expected] of [['MODEL_RUN_FAILED','MODEL_RUN_FAILED'],['secret-provider-code','PROVIDER_EXCEPTION']] as const){
        try{await runContextualShadow({bundle:fixture(),model:'fixture/model',maxTokens:2048,now:()=>now,
            complete:async()=>{throw Object.assign(Error('prompt=private-text; token=sk-secret'),{code:supplied});}});throw Error('must reject');}
        catch(e:any){expect(e.diagnostic).toEqual({stage:'provider',code:expected});expect(e.message).not.toContain('sk-secret');}
    }
});

test('assistant clarification cannot be saved as a user instruction',()=>{
 const b=fixture(),o=output(b);o.assertions[0]!.actorRef='assistant';
 expect(()=>parseContextualOutput(o,b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:actor_status_resolution');
});
test('dispositions cannot link an assertion to an uncited source',()=>{
 const b=fixture(),o=output(b);o.assertions[0]!.resolution='explicit';o.assertions[0]!.spans=o.assertions[0]!.spans.slice(1);
 expect(()=>parseContextualOutput(o,b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:disposition_citation');
});
test('v15 restores the frozen v13 single-envelope contract while v14 remains readable JSONL',()=>{
 const b=fixture();
 for(const v of ['memory-contextual-shadow-v10','memory-contextual-shadow-v11'] as const){
  const p=JSON.parse(contextualPrompt(b,now,v));expect(p.schema).toBe(v);expect(p.instructions).not.toContain('ACTOR/STATUS CONTRACT');
 }
 const prior=JSON.parse(contextualPrompt(b,now,'memory-contextual-shadow-v12'));
 expect(prior.instructions).toContain('ACTOR/STATUS CONTRACT');expect(prior.instructions).not.toContain('RETENTION CONTRACT');
 const v13=JSON.parse(contextualPrompt(b,now,'memory-contextual-shadow-v13'));
 expect(v13.instructions).toContain('ACTOR/STATUS CONTRACT');expect(v13.instructions).toContain('DISPOSITION ADDRESS CONTRACT');
 expect(v13.instructions).toContain('RETENTION CONTRACT');expect(v13.instructions).toContain('COALESCING CONTRACT');expect(v13.instructions).not.toContain('JSONL OUTPUT CONTRACT');
 const v14=JSON.parse(contextualPrompt(b,now,'memory-contextual-shadow-v14'));
 expect(v14.instructions).toContain('RETENTION CONTRACT');expect(v14.instructions).toContain('COALESCING CONTRACT');expect(v14.instructions).toContain('JSONL OUTPUT CONTRACT');
 const p=JSON.parse(contextualPrompt(b,now));expect(p.schema).toBe('memory-contextual-shadow-v13');
 expect(contextualPrompt(b,now)).toBe(contextualPrompt(b,now,'memory-contextual-shadow-v13'));
 expect(p.instructions).toBe(v13.instructions);expect(p.sources).toEqual(v13.sources);expect(p.instructions).not.toContain('JSONL OUTPUT CONTRACT');
 const frozen:Record<string,string>={
  'memory-contextual-shadow-v10':'sha256:1319f065b6a75b389c1513d4efb2b02cdf22def3046aef5ffa854e31157c364e',
  'memory-contextual-shadow-v11':'sha256:ae63df07ea3271835393a00f2cc1efe44612b032f5745d1bfd043339f2d83435',
  'memory-contextual-shadow-v12':'sha256:9433c7a6123f38c5cd491593ef397abf475ff0b61df41da95ee72af082ba5a4b',
  'memory-contextual-shadow-v13':'sha256:c78fd581382ee7192eb3c368b18cb69daa359fa8cad9c9aaa10b9ee4b7f5d2a4'};
 const promptBundle=promptFixture();
 for(const [version,digest] of Object.entries(frozen))
  expect(sha256(contextualPrompt(promptBundle,promptNow,version as any))).toBe(digest);
});

test('v14 JSONL adapter produces the same canonical observation as equivalent JSON',()=>{
 const b=fixture(),value=output(b),policy=sha256('same-policy');
 value.assertions[0]!.spans[0]!.purpose='context';value.assertions[0]!.spans[1]!.purpose='assertion';
 const canonical=parseContextualOutput(value,b,now),wire=parseContextualJsonl(jsonl(b,value),b,now);
 expect(wire).toEqual(canonical);
 expect(buildContextualObservation(wire,b,policy,now)).toEqual(buildContextualObservation(canonical,b,policy,now));
});

test('v14 JSONL preserves Unicode, escaped newlines, CRLF and one final newline',()=>{
 const b=fixture(),o=output(b);o.dispositions[0]!.reason='Причина 😀 中文\nsecond line';
 const raw=jsonl(b,o).replaceAll('\n','\r\n')+'\r\n';
 expect(parseContextualJsonl(raw,b,now).dispositions[0]!.reason).toBe(o.dispositions[0]!.reason);
});

test('v14 JSONL rejects framing, shape, coverage, duplication and truncation failures',()=>{
 const b=fixture(),valid=jsonl(b),lines=valid.split('\n');
 const firstSource=lines[0]!,secondSource=lines[1]!;
 const cases:[string,string][]=[
  ['', 'jsonl_empty'],['```jsonl\n'+valid+'\n```','jsonl_record_count'],['prose\n'+secondSource,'jsonl_invalid_json'],
  [firstSource+'\n\n','jsonl_blank_record'],[JSON.stringify(output(b)),'jsonl_record_type'],[JSON.stringify({type:'unknown'}),'jsonl_record_type'],
  [[firstSource,firstSource].join('\n'),'jsonl_duplicate_source'],
  [firstSource,'jsonl_incomplete_coverage'],
  [valid+'\n'+firstSource,'jsonl_record_count'],[valid.slice(0,-4),'jsonl_invalid_json'],
  [JSON.stringify({type:'assertion'}),'jsonl_record_type']];
 for(const [raw,code] of cases) expect(()=>parseContextualJsonl(raw,b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:'+code);
 expect(()=>parseContextualJsonl('x'.repeat(131073),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:output_size');
 const records=lines.map(line=>JSON.parse(line));
 const missingField=structuredClone(records);delete missingField[0].reason;
 expect(()=>parseContextualJsonl(missingField.map(JSON.stringify).join('\n'),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:jsonl_source_shape');
 const badSpan=structuredClone(records);badSpan[0].assertions[0].spans=[{traceId:b.sourceRefs[0]!.traceId}];
 expect(()=>parseContextualJsonl(badSpan.map(JSON.stringify).join('\n'),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:jsonl_assertion_span_shape');
 const duplicateAssertion=structuredClone(records);duplicateAssertion[1].assertions=[structuredClone(duplicateAssertion[0].assertions[0])];
 expect(()=>parseContextualJsonl(duplicateAssertion.map(JSON.stringify).join('\n'),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:jsonl_duplicate_assertion');
 const tooMany=structuredClone(records);tooMany[0].assertions=Array.from({length:33},(_,index)=>({...structuredClone(records[0].assertions[0]),id:'a'+index}));
 expect(()=>parseContextualJsonl(tooMany.map(JSON.stringify).join('\n'),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:jsonl_assertion_count');
});

test('v14 JSONL supports multiple declarations, cross-source references and forward references',()=>{
 const b=fixture(),base=jsonl(b).split('\n').map(line=>JSON.parse(line));
 const decision=structuredClone(base[0].assertions[0]);
 const second={...structuredClone(decision),id:'followup',text:'The assistant reported completing the timer fix.',resolution:'explicit',actorRef:'assistant',status:'reported_done',spans:[{...structuredClone(decision.spans[0]),purpose:'assertion'}]};
 base[0].assertions.push(second);base[0].kind='asserted';base[0].assertionIds=['followup'];
 expect(parseContextualJsonl(base.map(JSON.stringify).join('\n'),b,now).assertions.map(a=>a.id)).toEqual(['decision','followup']);
 const forward=jsonl(b).split('\n').map(line=>JSON.parse(line));
 forward[1].assertions=forward[0].assertions;forward[0].assertions=[];
 expect(parseContextualJsonl(forward.map(JSON.stringify).join('\n'),b,now).assertions[0]!.id).toBe('decision');
 const skipped=structuredClone(forward);skipped[0]={type:'source',traceId:b.sourceRefs[0]!.traceId,kind:'skip',assertionIds:[],reason:'No durable fact.',assertions:[]};
 skipped[1]={type:'source',traceId:b.sourceRefs[1]!.traceId,kind:'unresolved',assertionIds:[],reason:'Meaning is ambiguous.',assertions:[]};
 expect(parseContextualJsonl(skipped.map(JSON.stringify).join('\n'),b,now).dispositions.map(d=>d.kind)).toEqual(['skip','unresolved']);
});

test('v14 JSONL still enforces actor, source, citation and disposition semantics',()=>{
 const b=fixture();
 const cases=(()=>{
  const assistantApproval=output(b);assistantApproval.assertions[0]!.actorRef='assistant';
  const unknownAssertion=output(b);unknownAssertion.dispositions[0]!.assertionIds=['unknown'];
  const uncited=output(b);uncited.assertions[0]!.resolution='explicit';uncited.assertions[0]!.spans=uncited.assertions[0]!.spans.slice(1);
  const extraField:any=output(b);extraField.assertions[0]!.authorized=true;
  return [assistantApproval,unknownAssertion,uncited,extraField];
 })();
 for(const value of cases) expect(()=>parseContextualJsonl(jsonl(b,value),b,now)).toThrow();
 const records=jsonl(b).split('\n').map(line=>JSON.parse(line));
 records[1].traceId=sha256('foreign');
 expect(()=>parseContextualJsonl(records.map(record=>JSON.stringify(record)).join('\n'),b,now)).toThrow('CONTEXTUAL_OUTPUT_DENIED:jsonl_unknown_trace');
});
