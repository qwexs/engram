#!/usr/bin/env bun
// engram/scripts/render-agents-section.js
// Render generic agents-section template with workspace-specific values.
// Используется main-агентом (или cron-agent) при подготовке spawn-prompt:
// подставляет результат в `{{agents}}` placeholder.
//
// Читает:
//   - templates/spawn-prompts/_shared/agents-section.template.md
//   - {workspace}/engram.json (если есть) — agentId, qmd.index
// Env vars (override):
//   - ENGRAM_AGENT_ID        (default: "agent-apriori-tech" если в engram.json, иначе "agent-main")
//   - ENGRAM_WORKSPACE_NAME  (default: basename cwd)
//   - ENGRAM_OPERATOR        (default: "Operator (см. AGENTS.md workspace)")
//   - ENGRAM_QMD_INDEX       (default: "apriori")
//   - ENGRAM_WORKSPACE_KG_COLLECTION (default: "life")
//
// Usage:
//   bun skills/engram/scripts/render-agents-section.js --domain engram --kg-entity projects/engram --spawn-type dev-project
//   bun skills/engram/scripts/render-agents-section.js --domain engram --kg-entity projects/engram --spawn-type cron-task
//
// Output: rendered template на stdout. Если ошибка — exit 1, message в stderr.

import { readFileSync, existsSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const opts = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain') opts.domain = argv[++i];
    else if (a === '--kg-entity') opts.kgEntity = argv[++i];
    else if (a === '--spawn-type') opts.spawnType = argv[++i];
    else if (a === '--workspace') opts.workspace = argv[++i];
    else if (a === '-h' || a === '--help') {
      console.error('Usage: render-agents-section.js --domain <slug> [--kg-entity <path>] [--spawn-type dev-project|cron-task] [--workspace <path>]');
      process.exit(0);
    } else {
      console.error(`❌ Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return opts;
}

function readEngramConfig(workspaceDir) {
  const p = join(workspaceDir, 'engram.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return {}; }
}

const args = parseArgs(process.argv);
if (!args.domain) {
  console.error('❌ --domain <slug> обязателен');
  process.exit(1);
}
if (!args.spawnType) {
  console.error('❌ --spawn-type dev-project|cron-task обязателен');
  process.exit(1);
}
if (!['dev-project', 'cron-task'].includes(args.spawnType)) {
  console.error(`❌ --spawn-type должен быть dev-project или cron-task, получил: ${args.spawnType}`);
  process.exit(1);
}

const workspace = args.workspace ? resolve(args.workspace) : process.cwd();
const cfg = readEngramConfig(workspace);
const agentIdRaw = cfg.agent || cfg.agentId || process.env.ENGRAM_AGENT_ID || 'agent-main';
const agentId = agentIdRaw.replace(/^agent-/, '');
const workspaceName = cfg.workspace?.name || process.env.ENGRAM_WORKSPACE_NAME || basename(workspace);
const operator = cfg.operator || process.env.ENGRAM_OPERATOR || 'Operator (см. AGENTS.md workspace)';
const qmdIndex = cfg.qmd?.index || process.env.ENGRAM_QMD_INDEX || 'apriori';
const workspaceKgCollection = cfg.qmd?.workspaceKgCollection || process.env.ENGRAM_WORKSPACE_KG_COLLECTION || 'life';

const kgEntity = args.kgEntity || '';
const kgEntityPath = kgEntity;
const kgEntityDisplay = kgEntity
  ? `\`${kgEntity}\` (QMD collection: \`life-projects-${args.domain}\`, FS: \`life/${kgEntity}/\`)`
  : 'не задан (домен без KG entity)';

// Skill dir = parent of scripts/render-agents-section.js = engram/.
// resolve(__dirname/../..) эквивалентно, но используем fileURLToPath для ESM-надёжности.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const templatePath = join(__dirname, '..', 'templates', 'spawn-prompts', '_shared', 'agents-section.template.md');
if (!existsSync(templatePath)) {
  console.error(`❌ Template not found: ${templatePath}`);
  process.exit(1);
}
const template = readFileSync(templatePath, 'utf-8');

const rendered = template
  .replaceAll('{{DOMAIN}}', args.domain)
  .replaceAll('{{SPAWNTYPE}}', args.spawnType)
  .replaceAll('{{SPAWN_TYPE}}', args.spawnType)
  .replaceAll('{{WORKSPACE}}', workspaceName)
  .replaceAll('{{OPERATOR}}', operator)
  .replaceAll('{{QMD_INDEX}}', qmdIndex)
  .replaceAll('{{AGENT_ID}}', agentId)
  .replaceAll('{{WORKSPACE_KG_COLLECTION}}', workspaceKgCollection)
  .replaceAll('{{KG_ENTITY_PATH}}', kgEntityPath)
  .replaceAll('{{KGENTITYPATH}}', kgEntityPath)
  .replaceAll('{{KG_ENTITY_DISPLAY}}', kgEntityDisplay)
  .replaceAll('{{KGENTITYDISPLAY}}', kgEntityDisplay);

process.stdout.write(rendered);
