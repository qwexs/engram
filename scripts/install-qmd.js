#!/usr/bin/env bun
// engram/scripts/install-qmd.js
// Install QMD (local or Jina fork) with interactive variant selection
// Usage: bun skills/engram/scripts/install-qmd.js [--variant local|jina] [--jina-key <key>] [--help]

import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';

const { values: args } = parseArgs({
  options: {
    'variant': { type: 'string', short: 'v' },
    'jina-key': { type: 'string' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
install-qmd вЂ” Install QMD search engine

Usage:
  bun skills/engram/scripts/install-qmd.js [options]

Options:
  -v, --variant <v>     QMD variant: local|jina (interactive if omitted)
  --jina-key <key>      Jina AI API key (for jina variant)
  -h, --help            Show this help

Variants:
  local   Original QMD with local GPU/CPU embeddings (Vulkan/llama.cpp)
          Requires: GPU recommended (AMD/NVIDIA), works on CPU too
          Install: npm i -g @nicepkg/qmd

  jina    QMD fork with Jina AI cloud embeddings
          Requires: Jina API key (free tier: 1M tokens/month)
          Install: npm i -g @qwexs/qmd
          Source:  github.com/qwexs/qmd

Examples:
  bun skills/engram/scripts/install-qmd.js
  bun skills/engram/scripts/install-qmd.js --variant jina --jina-key jina_xxx
  bun skills/engram/scripts/install-qmd.js -v local
`);
  process.exit(0);
}

// --- Helpers ---
function qmdInstalled() {
  try {
    execSync('qmd --help', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runCmd(cmd, label) {
  console.log(`\nвЏі ${label}...`);
  console.log(`   $ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`\nвќЊ Failed: ${label}`);
    console.error(`   ${e.message}`);
    return false;
  }
}

// --- Check if already installed ---
if (qmdInstalled()) {
  console.log('вњ… QMD is already installed.');
  try {
    const version = execSync('qmd --version', { encoding: 'utf-8' }).trim();
    console.log(`   Version: ${version}`);
  } catch {}

  if (process.env.QMD_LLM_PROVIDER) {
    console.log(`   Provider: ${process.env.QMD_LLM_PROVIDER}`);
  } else {
    console.log('   Provider: local (default)');
  }

  const answer = await ask('\nReinstall/switch variant? (y/N): ');
  if (answer.toLowerCase() !== 'y') {
    console.log('No changes made.');
    process.exit(0);
  }
}

// --- Select variant ---
let variant = args.variant;

if (!variant) {
  console.log(`
в”Њв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”ђ
в”‚         QMD Installation                     в”‚
в”њв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”¤
в”‚                                              в”‚
в”‚  1. Local (GPU/CPU)                          в”‚
в”‚     вЂў Vulkan/llama.cpp embeddings            в”‚
в”‚     вЂў Best performance with GPU              в”‚
в”‚     вЂў Works offline, fully private           в”‚
в”‚     вЂў Recommended for: desktop, workstation  в”‚
в”‚                                              в”‚
в”‚  2. Jina Fork (Cloud API)                    в”‚
в”‚     вЂў Jina AI embeddings + native reranker   в”‚
в”‚     вЂў No GPU required                        в”‚
в”‚     вЂў Free tier: 1M tokens/month             в”‚
в”‚     вЂў Recommended for: Docker, VPS, CI       в”‚
в”‚                                              в”‚
в””в”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”Ђв”`);

  const choice = await ask('\nSelect variant (1 or 2): ');

  if (choice === '1' || choice.toLowerCase() === 'local') {
    variant = 'local';
  } else if (choice === '2' || choice.toLowerCase() === 'jina') {
    variant = 'jina';
  } else {
    console.error('вќЊ Invalid choice. Use 1/local or 2/jina.');
    process.exit(1);
  }
}

console.log(`\nрџ“¦ Selected variant: ${variant}`);

// --- Install ---
if (variant === 'local') {
  // Install original QMD
  const ok = runCmd('npm i -g @nicepkg/qmd', 'Installing QMD (local)');
  if (!ok) {
    console.log('\nTroubleshooting:');
    console.log('  вЂў Ensure Node.js 18+ is installed');
    console.log('  вЂў On Windows: run as Administrator if permission denied');
    console.log('  вЂў GPU: install Vulkan SDK for best performance');
    process.exit(1);
  }

  console.log('\nвњ… QMD (local) installed successfully!');
  console.log('\nGPU setup (optional but recommended):');
  console.log('  вЂў AMD: Vulkan drivers should be included with GPU drivers');
  console.log('  вЂў NVIDIA: Install Vulkan SDK from https://vulkan.lunarg.com');
  console.log('  вЂў CPU fallback: works without GPU, just slower');

} else if (variant === 'jina') {
  // Install Jina fork
  const ok = runCmd('npm i -g @qwexs/qmd', 'Installing QMD (Jina fork)');
  if (!ok) {
    console.log('\nAlternative: install from source');
    console.log('  git clone https://github.com/qwexs/qmd.git');
    console.log('  cd qmd && npm install && npm link');
    process.exit(1);
  }

  // Configure Jina API key
  let jinaKey = args['jina-key'] || process.env.JINA_API_KEY;

  if (!jinaKey) {
    console.log('\nрџ”‘ Jina AI API key required (free at https://jina.ai/api-key)');
    jinaKey = await ask('Enter Jina API key: ');
  }

  if (!jinaKey) {
    console.error('вќЊ No API key provided. QMD installed but embeddings won\'t work.');
    console.log('Set later: export JINA_API_KEY=your_key');
    console.log('           export QMD_LLM_PROVIDER=jina');
  } else {
    console.log('\nвњ… QMD (Jina fork) installed successfully!');
    console.log('\nвљ пёЏ  Add these environment variables to your shell profile:');
    console.log(`   export QMD_LLM_PROVIDER=jina`);
    console.log(`   export JINA_API_KEY=${jinaKey}`);

    // Try to detect and suggest shell profile
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      console.log('\nPowerShell (add to $PROFILE):');
      console.log(`   $env:QMD_LLM_PROVIDER = "jina"`);
      console.log(`   $env:JINA_API_KEY = "${jinaKey}"`);
    } else {
      const shell = process.env.SHELL || '/bin/bash';
      const profile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
      console.log(`\nAdd to ${profile}:`);
      console.log(`   export QMD_LLM_PROVIDER=jina`);
      console.log(`   export JINA_API_KEY=${jinaKey}`);
    }

    // Optionally write .env file
    const writeEnv = await ask('\nWrite .env file to workspace? (y/N): ');
    if (writeEnv.toLowerCase() === 'y') {
      const envPath = join(process.cwd(), '.env');
      let envContent = '';
      if (existsSync(envPath)) {
        envContent = readFileSync(envPath, 'utf-8');
      }
      if (!envContent.includes('QMD_LLM_PROVIDER')) {
        envContent += `\n# QMD Jina AI Provider\nQMD_LLM_PROVIDER=jina\nJINA_API_KEY=${jinaKey}\n`;
        writeFileSync(envPath, envContent);
        console.log(`  вњ… Written to ${envPath}`);
      } else {
        console.log('  вљ пёЏ  QMD_LLM_PROVIDER already in .env, skipping');
      }
    }
  }
} else {
  console.error(`вќЊ Unknown variant: ${variant}. Use 'local' or 'jina'.`);
  process.exit(1);
}

// --- Verify installation ---
console.log('\nрџ”Ќ Verifying installation...');
if (qmdInstalled()) {
  try {
    const version = execSync('qmd --version', { encoding: 'utf-8' }).trim();
    console.log(`  вњ… QMD available: ${version}`);
  } catch {
    console.log('  вњ… QMD available');
  }
  console.log(`\nNext: bun skills/engram/scripts/init.js`);
} else {
  console.log('  вљ пёЏ  QMD not found in PATH. You may need to restart your terminal.');
  console.log('  Then run: bun skills/engram/scripts/init.js');
}
