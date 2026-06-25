#!/usr/bin/env bun
// engram/scripts/install-qmd.js
// Install QMD (local, Jina fork, or Ollama fork) with interactive variant selection
// Usage: bun skills/engram/scripts/install-qmd.js [--variant local|jina|ollama] [--jina-key <key>] [--ollama-key <key>] [--ollama-url <url>] [--help]

import { parseArgs } from 'node:util';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as readline from 'node:readline';

const { values: args } = parseArgs({
  options: {
    'variant': { type: 'string', short: 'v' },
    'jina-key': { type: 'string' },
    'ollama-key': { type: 'string' },
    'ollama-url': { type: 'string' },
    'help': { type: 'boolean', short: 'h', default: false },
  },
  strict: false,
});

if (args.help) {
  console.log(`
install-qmd — Install QMD search engine

Usage:
  bun skills/engram/scripts/install-qmd.js [options]

Options:
  -v, --variant <v>     QMD variant: local|jina|ollama (interactive if omitted)
  --jina-key <key>      Jina AI API key (for jina variant)
  --ollama-key <key>    Ollama Cloud API key (for ollama variant, Cloud mode)
  --ollama-url <url>    Ollama base URL (for ollama variant, self-hosted mode)
                        e.g. http://localhost:11434
  -h, --help            Show this help

Variants:
  local   Original QMD with local GPU/CPU embeddings (Vulkan/llama.cpp)
          Requires: GPU recommended (AMD/NVIDIA), works on CPU too
          Install: npm i -g @nicepkg/qmd

  jina    QMD fork with Jina AI cloud embeddings
          Requires: Jina API key (free tier: 1M tokens/month)
          Install: npm i -g @qwexs/qmd
          Source:  github.com/qwexs/qmd

  ollama  QMD fork with Ollama Cloud or self-hosted Ollama embeddings
          Requires: Ollama API key (Cloud) OR reachable Ollama instance
          Install: npm i -g @qwexs/qmd  (fork ships ollama provider too)
          Models:  nomic-embed-text (default), mxbai-embed-large, embeddinggemma, etc.
          Note:    Rerank via cosine over embeddings (search-only, no native /api/rerank)

Examples:
  bun skills/engram/scripts/install-qmd.js
  bun skills/engram/scripts/install-qmd.js --variant jina --jina-key jina_xxx
  bun skills/engram/scripts/install-qmd.js --variant ollama --ollama-key ollama_xxx
  bun skills/engram/scripts/install-qmd.js --variant ollama --ollama-url http://localhost:11434
  bun skills/engram/scripts/install-qmd.js -v local
`);
  process.exit(0);
}

// --- Helpers ---
// On Windows, npm shebang-wrappers install as `qmd.cmd`; `bun`/`Bun.spawn` cannot
// exec the wrapper without the extension, so default to `qmd.cmd` there.
const QMD_CMD = process.env.ENGRAM_QMD || (process.platform === "win32" ? "qmd.cmd" : "qmd");

function qmdInstalled() {
  try {
    execSync(`${QMD_CMD} --help`, { stdio: 'pipe' });
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
  console.log(`\n⏳ ${label}...`);
  console.log(`   $ ${cmd}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
    return true;
  } catch (e) {
    console.error(`\n❌ Failed: ${label}`);
    console.error(`   ${e.message}`);
    return false;
  }
}

// --- Check if already installed ---
if (qmdInstalled()) {
  console.log('✅ QMD is already installed.');
  try {
    const version = execSync(`${QMD_CMD} --version`, { encoding: 'utf-8' }).trim();
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
┌─────────────────────────────────────────────┐
│         QMD Installation                     │
├─────────────────────────────────────────────┤
│                                              │
│  1. Local (GPU/CPU)                          │
│     • Vulkan/llama.cpp embeddings            │
│     • Best performance with GPU              │
│     • Works offline, fully private           │
│     • Recommended for: desktop, workstation  │
│                                              │
│  2. Jina Fork (Cloud API)                    │
│     • Jina AI embeddings + native reranker   │
│     • No GPU required                        │
│     • Free tier: 1M tokens/month             │
│     • Recommended for: Docker, VPS, CI       │
│                                              │
│  3. Ollama (Cloud or self-hosted)            │
│     • Ollama Cloud (API key) or local Ollama │
│       (BASE_URL, e.g. http://localhost:11434)│
│     • No GPU required                        │
│     • Search-only: rerank = cosine similarity│
│     • Recommended for: zero-cost self-hosted │
│                                              │
└─────────────────────────────────────────────┘`);

  const choice = await ask('\nSelect variant (1, 2, or 3): ');

  if (choice === '1' || choice.toLowerCase() === 'local') {
    variant = 'local';
  } else if (choice === '2' || choice.toLowerCase() === 'jina') {
    variant = 'jina';
  } else if (choice === '3' || choice.toLowerCase() === 'ollama') {
    variant = 'ollama';
  } else {
    console.error('❌ Invalid choice. Use 1/local, 2/jina, or 3/ollama.');
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
    console.log('  • Ensure Node.js 18+ is installed');
    console.log('  • On Windows: run as Administrator if permission denied');
    console.log('  • GPU: install Vulkan SDK for best performance');
    process.exit(1);
  }

  console.log('\n✅ QMD (local) installed successfully!');
  console.log('\nGPU setup (optional but recommended):');
  console.log('  • AMD: Vulkan drivers should be included with GPU drivers');
  console.log('  • NVIDIA: Install Vulkan SDK from https://vulkan.lunarg.com');
  console.log('  • CPU fallback: works without GPU, just slower');

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
    console.error('❌ No API key provided. QMD installed but embeddings won\'t work.');
    console.log('Set later: export JINA_API_KEY=your_key');
    console.log('           export QMD_LLM_PROVIDER=jina');
  } else {
    console.log('\n✅ QMD (Jina fork) installed successfully!');
    console.log('\n⚠️  Add these environment variables to your shell profile:');
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
        console.log(`  ✅ Written to ${envPath}`);
      } else {
        console.log('  ⚠️  QMD_LLM_PROVIDER already in .env, skipping');
      }
    }
  }
} else if (variant === 'ollama') {
  // Install QMD fork (same package as jina variant; ships ollama provider)
  const ok = runCmd('npm i -g @qwexs/qmd', 'Installing QMD (fork with Ollama provider)');
  if (!ok) {
    console.log('\nAlternative: install from source');
    console.log('  git clone https://github.com/qwexs/qmd.git');
    console.log('  cd qmd && npm install && npm link');
    process.exit(1);
  }

  // Choose Cloud or self-hosted
  let mode;
  if (args['ollama-key']) mode = 'cloud';
  else if (args['ollama-url']) mode = 'selfhosted';
  else {
    console.log('\n┌────────────────────────────────────────┐');
    console.log('│ Ollama mode:                           │');
    console.log('│  1. Cloud  (API key from ollama.com)  │');
    console.log('│  2. Self-hosted  (Ollama running on    │');
    console.log('│     this machine or LAN, BASE_URL)     │');
    console.log('└────────────────────────────────────────┘');
    const m = await ask('\nSelect Ollama mode (1=cloud, 2=self-hosted): ');
    if (m === '1' || m.toLowerCase().startsWith('cloud')) mode = 'cloud';
    else if (m === '2' || m.toLowerCase().startsWith('self')) mode = 'selfhosted';
    else { console.error('❌ Invalid mode. Use 1/cloud or 2/self-hosted.'); process.exit(1); }
  }

  let envLines = '# QMD Ollama Provider\nQMD_LLM_PROVIDER=ollama\n';
  let profileLines = '';

  if (mode === 'cloud') {
    let ollamaKey = args['ollama-key'] || process.env.OLLAMA_API_KEY;
    if (!ollamaKey) {
      console.log('\nрџ”‘ Ollama Cloud API key required (free tier at https://ollama.com/settings/keys)');
      ollamaKey = await ask('Enter Ollama API key: ');
    }
    if (!ollamaKey) {
      console.error('❌ No API key provided. QMD installed but Ollama Cloud won\'t authenticate.');
      console.log('Set later: export OLLAMA_API_KEY=***');
      process.exit(1);
    }
    envLines += `OLLAMA_API_KEY=${ollamaKey}\n`;
    profileLines = `export QMD_LLM_PROVIDER=ollama\nexport OLLAMA_API_KEY=***`;
  } else {
    let ollamaUrl = args['ollama-url'] || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    if (!args['ollama-url'] && !process.env.OLLAMA_BASE_URL) {
      ollamaUrl = (await ask(`Ollama base URL [${ollamaUrl}]: `)).trim() || ollamaUrl;
    }
    envLines += `OLLAMA_BASE_URL=${ollamaUrl}\n`;
    profileLines = `export QMD_LLM_PROVIDER=ollama\nexport OLLAMA_BASE_URL=${ollamaUrl}`;
  }

  console.log('\n✅ QMD (Ollama provider) installed successfully!');
  console.log('\nрџЌ‡ Note: Ollama provider is search-only — rerank uses cosine similarity');
  console.log('   over embeddings (Ollama API has no native /api/rerank).');
  console.log('\n⚠️  Add these environment variables to your shell profile:');
  console.log(`   ${profileLines.split('\n').join('\n   ')}`);

  // Shell profile hints
  const isWindows = process.platform === 'win32';
  if (isWindows) {
    console.log('\nPowerShell (add to $PROFILE):');
    for (const line of profileLines.split('\n')) {
      const m = line.match(/^export ([^=]+)=(.+)$/);
      if (m) console.log(`   $env:${m[1]} = "${m[2]}"`);
    }
  } else {
    const shell = process.env.SHELL || '/bin/bash';
    const profile = shell.includes('zsh') ? '~/.zshrc' : '~/.bashrc';
    console.log(`\nAdd to ${profile}:`);
    console.log(`   ${profileLines.split('\n').join('\n   ')}`);
  }

  // Optionally write .env file
  const writeEnv = await ask('\nWrite .env file to workspace? (y/N): ');
  if (writeEnv.toLowerCase() === 'y') {
    const envPath = join(process.cwd(), '.env');
    let envContent = '';
    if (existsSync(envPath)) envContent = readFileSync(envPath, 'utf-8');
    if (!envContent.includes('QMD_LLM_PROVIDER')) {
      envContent += `\n${envLines}`;
      writeFileSync(envPath, envContent);
      console.log(`  ✅ Written to ${envPath}`);
    } else {
      console.log('  ⚠️  QMD_LLM_PROVIDER already in .env, skipping');
    }
  }
} else {
  console.error(`❌ Unknown variant: ${variant}. Use 'local', 'jina', or 'ollama'.`);
  process.exit(1);
}

// --- Verify installation ---
console.log('\nрџ”Ќ Verifying installation...');
if (qmdInstalled()) {
  try {
    const version = execSync(`${QMD_CMD} --version`, { encoding: 'utf-8' }).trim();
    console.log(`  ✅ QMD available: ${version}`);
  } catch {
    console.log('  ✅ QMD available');
  }
  console.log(`\nNext: bun skills/engram/scripts/init.js`);
} else {
  console.log('  ⚠️  QMD not found in PATH. You may need to restart your terminal.');
  console.log('  Then run: bun skills/engram/scripts/init.js');
}
