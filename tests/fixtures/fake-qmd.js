#!/usr/bin/env bun

// Hermetic QMD stub for tests. It deliberately has no persistent index, so
// test runs can never read or mutate an operator's production QMD state.
const args = process.argv.slice(2);
const commandArgs = args[0] === "--index" ? args.slice(2) : args;

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

if (commandArgs[0] === "capabilities") {
  const mode = process.env.FAKE_QMD_CAPABILITIES_MODE || "success";
  if (mode === "malformed") {
    console.log("{");
    process.exit(0);
  }
  const payload = {
    schema: mode === "schema-mismatch" ? "qmd.capabilities.v0" : "qmd.capabilities.v1",
    version: mode === "version-missing" ? undefined : "2.6.3-fork.2",
    embed: {
      multipleCollections: mode !== "missing-capability",
      indexScopedLock: true,
      structuredOutput: true,
    },
  };
  console.log(JSON.stringify(payload));
  process.exit(0);
}

if (commandArgs[0] === "status") {
  if (process.env.FAKE_QMD_STATUS_MODE === "malformed") {
    console.log("QMD Status without an index");
    process.exit(0);
  }
  const index = process.env.FAKE_QMD_STATUS_INDEX || `${process.cwd()}/.qmd/index.sqlite`;
  console.log(`QMD Status\n\nIndex: ${index}\nSize: 0 B`);
  process.exit(0);
}

if (commandArgs[0] === "--help") {
  console.log("fake-qmd");
  process.exit(0);
}

if (commandArgs[0] === "collection" && commandArgs[1] === "list") {
  const collections = String(process.env.FAKE_QMD_COLLECTIONS || "").split(",").filter(Boolean);
  console.log(`Collections (${collections.length}):`);
  for (const collection of collections) console.log(`${collection} (qmd://${collection}/)`);
  process.exit(0);
}

if (commandArgs[0] === "collection" && commandArgs[1] === "show") {
  process.exit(1);
}

if (commandArgs[0] === "collection" && ["add", "remove"].includes(commandArgs[1])) {
  process.exit(0);
}

if (commandArgs[0] === "update") {
  process.exit(0);
}

if (commandArgs[0] === "embed") {
  console.log(JSON.stringify({
    schema: "qmd.embed.v1",
    status: "ok",
    pendingBefore: 1,
    pendingAfter: 0,
    documentsEmbedded: 1,
    chunksEmbedded: 1,
    errors: 0,
    skippedReason: null,
  }));
  process.exit(0);
}

if (["search", "query", "vsearch"].includes(commandArgs[0])) {
  const delayMs = Number(process.env.FAKE_QMD_QUERY_DELAY_MS || 0);
  if (delayMs > 0) await Bun.sleep(delayMs);
  if (process.env.FAKE_QMD_READ_MODE === "malformed") console.log("{");
  else if (process.env.FAKE_QMD_READ_MODE === "object") console.log("{}");
  else console.log(JSON.stringify([{ file: "qmd://life/example.md", score: 0.9 }]));
  process.exit(0);
}

console.error(`fake-qmd: unsupported arguments: ${JSON.stringify(args)}`);
process.exit(1);
