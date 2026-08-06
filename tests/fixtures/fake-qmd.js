#!/usr/bin/env bun

// Hermetic QMD stub for tests. It deliberately has no persistent index, so
// test runs can never read or mutate an operator's production QMD state.
const args = process.argv.slice(2);

if (process.env.FAKE_QMD_LOG) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.FAKE_QMD_LOG, JSON.stringify(args) + "\n");
}

if (process.env.FAKE_QMD_MODE === "inspect") {
  console.log(JSON.stringify({ args, cwd: process.cwd(), pwd: process.env.PWD }));
  process.exit(0);
}

if (process.env.FAKE_QMD_MODE === "large-output") {
  const { writeFileSync } = await import("node:fs");
  const bytes = Number(process.env.FAKE_QMD_OUTPUT_BYTES || 1048576);
  writeFileSync(1, "o".repeat(bytes));
  writeFileSync(2, "e".repeat(bytes));
  process.exit(0);
}

if (process.env.FAKE_QMD_MODE === "non-zero") {
  console.log("fake stdout");
  console.error("fake stderr");
  process.exit(Number(process.env.FAKE_QMD_EXIT_CODE || 9));
}

if (process.env.FAKE_QMD_MODE === "timeout") {
  await Bun.sleep(Number(process.env.FAKE_QMD_DELAY_MS || 60000));
  process.exit(0);
}

if (process.env.FAKE_QMD_MODE === "timeout-child") {
  const marker = process.env.FAKE_QMD_CHILD_MARKER;
  if (!marker) throw new Error("FAKE_QMD_CHILD_MARKER is required");
  Bun.spawn([
    process.execPath,
    "-e",
    `await Bun.sleep(400); await Bun.write(${JSON.stringify(marker)}, "orphan")`,
  ], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(60000);
  process.exit(0);
}

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

if (args[0] === "query") {
  const delayMs = Number(process.env.FAKE_QMD_QUERY_DELAY_MS || 0);
  if (delayMs > 0) await Bun.sleep(delayMs);
  console.log("[]");
  process.exit(0);
}

console.error(`fake-qmd: unsupported arguments: ${JSON.stringify(args)}`);
process.exit(1);
