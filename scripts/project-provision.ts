#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { readQmdGlobalMigrationManifest } from '../src/qmd/global-migration.ts';
import { applyQmdGlobalProvisioning, planQmdGlobalProvisioning } from '../src/qmd/global-provisioning.ts';
import { collectWatchdogRuntime } from './_lib/watchdog-runtime.js';
import { resolveMemoryObservationProjection } from '../src/memory-observation/projection.ts';
import { resolveCanaryQmdRuntimeBinding } from '../src/memory-observation/qmd-binding-preflight.ts';
import { resolveQmdContext } from '../src/qmd/context.ts';
import { parseArgs } from 'node:util';
import { planProjectProvisioning, applyProjectPlan, planProjectFleetEnrollment } from '../src/qmd/project-provisioning.ts';
const { values } = parseArgs({ options: { request: { type: 'string' }, 'host-config': { type: 'string' }, apply: { type: 'boolean' }, journal: { type: 'string' }, enroll: { type: 'boolean' }, 'register-index': { type: 'boolean' }, 'qmd-backup': { type: 'string' } }, strict: true });
try {
  if (!values.request) throw new Error('usage: --request <project-request.json> [--host-config <read-only-routes.json>] [--apply --journal <new-path>] | [--register-index --qmd-backup <outside-workspace-path>] | [--enroll [--apply --journal <new-path>]]');
  const request = JSON.parse(readFileSync(values.request, 'utf8'));
  const live = !values['host-config'] || values.apply || values.enroll || values['register-index'];
  const runtime = live ? collectWatchdogRuntime(request.workspace, {plugin:values.enroll === true}) : null;
  const hostConfig = live ? runtime?.config : JSON.parse(readFileSync(values['host-config']!, 'utf8'));
  if (!hostConfig) throw new Error('effective host routes unavailable; no mutation allowed');
  let plan = planProjectProvisioning(request, hostConfig);
  if (values.enroll) {
    if (values['register-index']) throw new Error('enrollment and registration are separate stages');
    const projection = resolveMemoryObservationProjection({workspace:plan.request.workspace,workspaceId:plan.request.id,expectedPluginDigest:runtime.plugin?.installedDigest});
    const sink = projection.consumers?.dailyNote;
    if (!sink?.qmdBinding || sink.qmdBinding.resolver !== 'exact-session-registry') throw new Error('exact QMD binding required');
    const context = resolveQmdContext({value:plan.request.workspace,source:'explicit'});
    for (const binding of projection.bindings) resolveCanaryQmdRuntimeBinding({workspace:plan.request.workspace,runtimeSessionKey:binding.runtimeSessionKey,timezone:sink.timezone,destinationAt:sink.applyAfter,resolver:sink.qmdBinding,context});
    plan = planProjectFleetEnrollment(plan.request,projection,runtime);
  }
  if (values['register-index']) {
    if (values.apply || !values['qmd-backup']) throw new Error('--register-index requires --qmd-backup and a separately applied foundation');
    if (plan.changes.length) throw new Error('apply/review the foundation changes before QMD registration');
    const manifest = readQmdGlobalMigrationManifest(plan.request.globalManifest);
    const registration = planQmdGlobalProvisioning(manifest);
    if (registration.summary.add === 0) console.log(JSON.stringify({status:'already-registered', collections:registration.summary.present}));
    else console.log(JSON.stringify({status:'registered', backup:await applyQmdGlobalProvisioning(manifest, values['qmd-backup'], manifest.registry.index.name), pending:plan.pending.slice(1)},null,2));
  } else if (values.apply) {
    if (!values.journal) throw new Error('--apply requires --journal');
    console.log(JSON.stringify({ ...applyProjectPlan(plan, values.journal), pending: plan.pending }, null, 2));
  } else console.log(JSON.stringify(plan, null, 2));
} catch (error) { console.error(String(error)); process.exitCode = 1; }
