#!/usr/bin/env bun

// Hermetic QMD stub for tests. It deliberately has no persistent index, so
// test runs can never read or mutate an operator's production QMD state.
const args = process.argv.slice(2);

if (args[0] === "--help") {
  console.log("fake-qmd");
  process.exit(0);
}

if (args[0] === "collection" && args[1] === "list") {
  console.log("Collections (0):");
  process.exit(0);
}

if (args[0] === "collection" && args[1] === "show") {
  process.exit(1);
}

if (args[0] === "collection" && ["add", "remove"].includes(args[1])) {
  process.exit(0);
}

if (["update", "embed"].includes(args[0])) {
  process.exit(0);
}

console.error(`fake-qmd: unsupported arguments: ${JSON.stringify(args)}`);
process.exit(1);
