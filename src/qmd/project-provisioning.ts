import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, realpathSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { auditQmdGlobalRegistry } from './global-registry.ts';
import { configuredTopicBindings } from '../memory-observation/topic-bindings.ts';
import { configuredGroupDirectBindings } from '../memory-observation/group-bindings.ts';

// Deployment adapter after workspace-only init. Host routes must already exist.
// This adapter never changes host config, projections, approval timestamps or receipts.
export type ProjectRequest = {
  workspace: string; id: string; parentId: string; domains: string[];
  globalManifest: string; workerManifest: string; fleetManifest: string;
  upperDomains: Array<{ workspaceId: string; domain: string }>;
};
export type Change = { path: string; before: string | null; after: string };
export type ProjectPlan = { schema: 'engram.project-provision-plan.v1'; request: ProjectRequest; changes: Change[]; bindings: any[]; collections: string[]; pending: string[] };
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const body = (v: unknown) => JSON.stringify(v, null, 2) + '\n';
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])].sort();
function canonical(p: string) {
  if (!isAbsolute(p) || resolve(p) !== p) throw new Error('absolute canonical path required');
  if (existsSync(p)) { if (realpathSync(p) !== p) throw new Error('symlink path rejected'); }
  else if (dirname(p) !== p) canonical(dirname(p));
  return p;
}
export function planProjectProvisioning(request: ProjectRequest, hostConfig: unknown): ProjectPlan {
  const r = structuredClone(request), w = canonical(r.workspace);
  if (!/^[a-z][a-z0-9_-]*$/.test(r.id) || r.id === 'main' || r.parentId === r.id) throw new Error('invalid project identity');
  for (const p of [r.globalManifest, r.workerManifest, r.fleetManifest]) canonical(p);
  if (!r.workerManifest.startsWith(w + '/ops/')) throw new Error('worker manifest must be project-local ops');
  if (!r.domains.length || new Set(r.domains).size !== r.domains.length) throw new Error('unique explicit domains required');
  const config = read(join(w, 'engram.json')), domains = read(join(w, 'memory/domains/registry.json'));
  if (config.workspace?.id !== r.id || config.agent !== 'agent-' + r.id) throw new Error('workspace identity mismatch');
  const groups = r.domains.every(d => domains.domains?.[d]?.type === 'group-direct');
  if (!groups && r.domains.some(d => domains.domains?.[d]?.type === 'group-direct')) throw new Error('mixed group/topic rollout unsupported');
  const bindings = groups ? configuredGroupDirectBindings(hostConfig, w, r.id, r.domains) : configuredTopicBindings(hostConfig, w, r.id, r.domains);
  const manifest = read(r.globalManifest), registry = manifest.registry;
  if (registry?.schema !== 'engram.qmd.global-registry.v1') throw new Error('invalid global registry');
  if (config.qmd?.index !== registry.index.name || config.qmd?.localIndex !== false || config.qmd?.maintenance?.mode !== 'coordinated') throw new Error('shared coordinated QMD foundation required before provisioning');
  const parent = registry.workspaces.find((v: any) => v.id === r.parentId);
  if (!parent || parent.kind !== 'business') throw new Error('business parent required');
  const ancestors = new Set<string>();
  function visit(id: string) { if (ancestors.has(id)) return; ancestors.add(id); const entry = registry.workspaces.find((v: any) => v.id === id); if (!entry) throw new Error('missing ancestor'); entry.parents.forEach(visit); }
  visit(r.parentId);
  const old = registry.workspaces.find((v: any) => v.id === r.id);
  if (old && (old.path !== w || old.kind !== 'business' || JSON.stringify(old.parents) !== JSON.stringify([r.parentId]))) throw new Error('existing workspace identity/parent drift');
  const collections = [
    { name: r.id + '-memory', path: join(w, 'memory', 'agent-' + r.id), mask: '**/*.md' },
    { name: r.id + '-domains', path: join(w, 'memory/domains'), mask: '**/*.md' },
    { name: r.id + '-life', path: join(w, 'life'), mask: '**/*.md' },
    { name: r.id + '-ops', path: join(w, 'ops'), mask: '**/*.md' },
    ...bindings.flatMap(b => { const d = b.topicDomain ?? b.groupDomain; if (!d) throw new Error("missing group binding");
      const session = 'telegram-group-' + d.chatId + (b.topicDomain ? '-topic-' + b.topicDomain.topicId : '');
      return [{ name: 'domain-' + d.domain, path: join(w, 'memory/domains', d.domain), mask: '**/*.md' },
        { name: (b.topicDomain ? 'topic-memory-' : 'group-memory-') + d.domain, path: join(w, 'memory', 'agent-' + r.id, session), mask: '*.md' }]; }),
  ].map(v => ({ ...v, owner: r.id }));
  // Preserve bootstrap collections produced by init; never claim somebody else's root.
  const bootstrap = join(w, 'memory', 'agent-' + r.id, 'main');
  if (existsSync(bootstrap) && config.qmd.collections?.includes('openclaw-memory-agent-' + r.id + '-main')) collections.push({ name: 'openclaw-memory-agent-' + r.id + '-main', path: bootstrap, owner: r.id, mask: '**/*.md' });
  for (const c of collections) {
    canonical(c.path);
    const existing = registry.collections.find((v: any) => v.name === c.name);
    if (existing && ['path', 'owner', 'mask'].some(k => existing[k] !== (c as any)[k])) throw new Error('collection drift: ' + c.name);
    if (!existing) registry.collections.push(c);
  }
  const owned = registry.collections.filter((v: any) => v.owner === r.id).map((v: any) => v.name).sort();
  if (!old) registry.workspaces.push({ id: r.id, path: w, kind: 'business', parents: [r.parentId], readableCollections: owned });
  else old.readableCollections = union(old.readableCollections, owned);
  for (const upper of registry.workspaces) if (ancestors.has(upper.id)) upper.readableCollections = union(upper.readableCollections, owned);
  const audit = auditQmdGlobalRegistry(registry);
  if (!audit.ok) throw new Error('global registry validation failed: ' + JSON.stringify(audit.findings.filter((v: any) => v.severity === 'error')));
  const pendingChanges = new Map<string, unknown>();
  const stage = (p: string, v: unknown) => { canonical(p); pendingChanges.set(p, v); };
  const get = (p: string): any => pendingChanges.get(p) ?? read(p);
  config.qmd.collections = union(config.qmd.collections ?? [], owned);
  if (config.qmd.collections.some((name: string) => !owned.includes(name))) throw new Error('project owns unregistered or foreign collections');
  config.qmd.collection = r.id + '-memory'; config.qmd.workspaceKgCollection = r.id + '-life'; config.qmd.opsCollection = r.id + '-ops';
  stage(join(w, 'engram.json'), config);
  const covered = new Set<string>();
  for (const entry of r.upperDomains) {
    if (!ancestors.has(entry.workspaceId)) throw new Error('upper domain is not an ancestor');
    const upper = registry.workspaces.find((v: any) => v.id === entry.workspaceId);
    const rp = join(upper.path, 'memory/domains/registry.json'), cp = join(upper.path, 'engram.json');
    const dr = get(rp), ec = get(cp), d = dr.domains?.[entry.domain];
    if (d?.type !== 'meta-domain' || d.archived || d.enabled === false) throw new Error('active upper meta-domain required');
    d.qmdCollections = union(d.qmdCollections ?? [], owned);
    if (ec.domains?.[entry.domain]) ec.domains[entry.domain].qmdCollections = d.qmdCollections;
    stage(rp, dr); stage(cp, ec); covered.add(entry.workspaceId);
  }
  if ([...ancestors].some(id => !covered.has(id))) throw new Error('all business ancestors require explicit General meta-domain mapping');
  stage(r.globalManifest, manifest);
  // Active worker snapshots are immutable pins: changing them revokes a valid binding.
  const projectionPath = join(w, 'memory-state/memory-observation/projection.json');
  const active = existsSync(projectionPath) && read(projectionPath).enabled === true;
  if (active) {
    const pinned = read(r.workerManifest);
    for (const c of collections) if (!pinned.registry.collections.some((v: any) => v.name === c.name && v.path === c.path && v.mask === c.mask && v.owner === c.owner)) throw new Error('active worker snapshot differs; separate reviewed rollout required');
  } else stage(r.workerManifest, { ...manifest, workspaces: [] });
  const fleet = read(r.fleetManifest);
  if (fleet.schema !== 'engram.memory-topic-fleet.v1' || !fleet.schedulerId || !Array.isArray(fleet.workspaces)) throw new Error('invalid fleet');
  if (fleet.workspaces.some((v: any) => (v.id === r.id || v.path === w) && (v.id !== r.id || v.path !== w))) throw new Error('fleet identity conflict');
  return { schema: 'engram.project-provision-plan.v1', request: r, bindings, collections: owned,
    changes: [...pendingChanges].flatMap(([path, value]) => { const before = existsSync(path) ? readFileSync(path, 'utf8') : null; const after = body(value); return before === after ? [] : [{ path, before, after }]; }),
    pending: ['QMD registration and initial sync through the existing physical-index coordinator', 'Host/plugin/runtime and exact QMD preflight before official batch rollout', 'Fleet enrollment after active projection read-back; no ownership mutation by this adapter', 'Heartbeat and nightly registry/scheduler enrollment through authorized host operations', 'Natural source → daily → domain → index → positive search plus negative ACL acceptance'] };
}
export function applyProjectPlan(plan: ProjectPlan, journalPath: string) {
  if (plan.schema !== 'engram.project-provision-plan.v1') throw new Error('invalid plan');
  canonical(journalPath);
  const lock = plan.request.globalManifest + '.project-provision.lock';
  const fd = openSync(lock, 'wx', 0o600);
  try {
    // CAS all inputs before any write; a rerun accepts already-applied bytes.
    for (const c of plan.changes) {
      canonical(c.path); const current = existsSync(c.path) ? readFileSync(c.path, 'utf8') : null;
      if (current !== c.before && current !== c.after) throw new Error('concurrent drift: ' + c.path);
    }
    if (existsSync(journalPath)) throw new Error('use a new journal path');
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(journalPath, body({ status: 'prepared', plan }), { flag: 'wx', mode: 0o600 });
    // Materialize only this project's declared collection roots, before QMD registration.
    const nextManifest = plan.changes.find(c => c.path === plan.request.globalManifest);
    const registry = (nextManifest ? JSON.parse(nextManifest.after) : read(plan.request.globalManifest)).registry;
    for (const collection of registry.collections.filter((c: any) => c.owner === plan.request.id)) {
      canonical(collection.path);
      if (!collection.path.startsWith(plan.request.workspace + '/')) throw new Error('collection root escape');
      mkdirSync(collection.path, { recursive: true });
    }
    for (const c of plan.changes) {
      if (existsSync(c.path) && readFileSync(c.path, 'utf8') === c.after) continue;
      mkdirSync(dirname(c.path), { recursive: true });
      const temp = c.path + '.' + randomUUID() + '.tmp'; writeFileSync(temp, c.after, { mode: 0o600 }); renameSync(temp, c.path);
      if (readFileSync(c.path, 'utf8') !== c.after) throw new Error('read-back failed');
    }
    writeFileSync(journalPath, body({ status: 'applied', plan }));
    return { status: 'applied', changedFiles: plan.changes.length, ownershipChanged: false };
  } finally { closeSync(fd); unlinkSync(lock); }
}

export function planProjectFleetEnrollment(request: ProjectRequest, projection: any, runtime: any): ProjectPlan {
  const r = request, w = canonical(r.workspace), fleet = read(r.fleetManifest);
  // Validate the prepared foundation and current host routes again.
  const foundation = planProjectProvisioning(r, runtime.config);
  if (foundation.changes.length) throw new Error('foundation drift: prepare/apply before fleet enrollment');
  if (!['engram.memory-observation-rollout.v4', 'engram.memory-observation-rollout.v5'].includes(projection?.schema)
    || projection.workspaceId !== r.id || projection.enabled !== true || projection.mode !== 'canary'
    || projection.captureOwnership?.owner !== 'observer'
    || projection.evaluation?.batch?.schedulerId !== fleet.schedulerId
    || JSON.stringify(projection.bindings) !== JSON.stringify(foundation.bindings)) throw new Error('official exact batch rollout/read-back required');
  if (runtime.plugin?.enabled !== true || runtime.plugin.status !== 'loaded' || runtime.plugin.diagnosticCount !== 0
    || !runtime.plugin.installedDigest || runtime.plugin.installedDigest !== projection.pluginDigest
    || (runtime.plugin.loadedDigest && runtime.plugin.loadedDigest !== projection.pluginDigest)) throw new Error('plugin readiness not verified');
  if (!runtime.cron?.available || !runtime.cron.complete) throw new Error('complete scheduler observation required');
  const jobs = runtime.cron.jobs.filter((j: any) => j.id === fleet.schedulerId || j.declarationKey === fleet.schedulerId);
  if (jobs.length !== 1) throw new Error('unique existing fleet scheduler required');
  const job = jobs[0], args = job.payload?.argv, pos = Array.isArray(args) ? args.indexOf('--manifest') : -1;
  if (!job.enabled || job.payload?.kind !== 'command' || pos < 0 || args[pos + 1] !== r.fleetManifest
    || !args.some((v: string) => v.endsWith('/memory-observation-group-fleet.ts'))
    || job.schedule?.kind !== 'cron' || job.schedule.tz !== 'UTC' || job.schedule.staggerMs !== 0) throw new Error('fleet scheduler profile mismatch');
  const current = fleet.workspaces.filter((e: any) => e.id === r.id || e.path === w);
  if (current.length > 1 || (current.length === 1 && (current[0].id !== r.id || current[0].path !== w))) throw new Error('fleet identity conflict');
  if (!current.length) fleet.workspaces.push({ id: r.id, path: w });
  if (fleet.workspaces.length > 20 || job.payload.timeoutSeconds < fleet.workspaces.length * 300 + 60) throw new Error('scheduler timeout insufficient for expanded fleet');
  const before = readFileSync(r.fleetManifest, 'utf8'), after = body(fleet);
  return { ...foundation, changes: before === after ? [] : [{ path: r.fleetManifest, before, after }],
    pending: ['Observe real source → daily → domain → index → retrieval; idle enrollment is not E2E',
      ...(!runtime.plugin.loadedDigest ? ['Host does not expose resident plugin byte digest; installed bytes verified only'] : [])] };
}
