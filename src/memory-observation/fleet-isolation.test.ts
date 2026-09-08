import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFleetIsolation, reportFleetResults, runFleetCommand, runFleetEntries, type FleetIsolation } from "./fleet-isolation";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const stateDir = mkdtempSync(join(tmpdir(), "fleet-isolation-test-")); dirs.push(stateDir);
  const config: FleetIsolation = { stateDir, operator: { channel: "telegram", target: "12345", accountId: "default" }, cooldownMs: 60_000 };
  const messages: string[] = [];
  const args = { schedulerId: "test-fleet", config, now: 100_000, results: [{ workspaceId: "a", exitCode: 1, output: "PRIVATE SOURCE" }, { workspaceId: "b", exitCode: 0 }],
    notify: async (message: string) => { messages.push(message); } };
  return { config, messages, args };
}

test("partial failure is durable, operator-only and does not fail healthy fleet", async () => {
  const { args, config, messages } = fixture();
  const result = await reportFleetResults({ ...args, notify: async (message, route) => {
    expect(route).toEqual(config.operator);
    expect(readFileSync(join(config.stateDir, "latest.json"), "utf8")).toContain("partial_failure");
    messages.push(message);
  } });
  expect(result.exitCode).toBe(0); expect(result.status).toBe("partial_failure");
  expect(messages).toHaveLength(1); expect(messages[0]).not.toContain("PRIVATE SOURCE");
  expect(readFileSync(join(config.stateDir, "passes.jsonl"), "utf8")).not.toContain("PRIVATE SOURCE");
});

test("repeated failures survive restart without notification flood; cooldown expires", async () => {
  const { args, messages, config } = fixture();
  for (let i = 0; i < 12; i++) expect((await reportFleetResults({ ...args, now: args.now + i * 1000 })).exitCode).toBe(0);
  expect(messages).toHaveLength(1);
  expect(readFileSync(join(config.stateDir, "passes.jsonl"), "utf8").trim().split("\n")).toHaveLength(12);
  await reportFleetResults({ ...args, now: 160_000 }); expect(messages).toHaveLength(2);
});

test("new failed project notifies immediately; healthy pass resets suppression", async () => {
  const { args, messages } = fixture();
  await reportFleetResults(args);
  await reportFleetResults({ ...args, results: [{ workspaceId: "a", exitCode: 0 }, { workspaceId: "b", exitCode: 1 }] });
  expect(messages).toHaveLength(2);
  await reportFleetResults({ ...args, results: args.results.map(r => ({ ...r, exitCode: 0 })) });
  await reportFleetResults(args); expect(messages).toHaveLength(3);
});

test("global failure remains nonzero even under notification cooldown", async () => {
  const { args } = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await reportFleetResults({ ...args, results: [{ workspaceId: "a", exitCode: 1 }, { workspaceId: "b", error: "preflight" }] });
    expect(result.exitCode).toBe(1); expect(result.status).toBe("failed");
  }
});

test("failed delivery is not acknowledged; next pass retries", async () => {
  const { args, messages, config } = fixture();
  await expect(reportFleetResults({ ...args, notify: async () => { throw new Error("delivery down"); } })).rejects.toThrow("delivery down");
  expect(() => readFileSync(join(config.stateDir, "alert.json"))).toThrow();
  await reportFleetResults(args); expect(messages).toHaveLength(1);
});

test("unwritable journal or corrupt acknowledgement cannot yield successful pass", async () => {
  const { args, messages, config } = fixture();
  writeFileSync(join(config.stateDir, "alert.json"), "broken");
  await expect(reportFleetResults(args)).rejects.toThrow(); expect(messages).toHaveLength(0);
  const file = join(config.stateDir, "not-a-directory"); writeFileSync(file, "x");
  await expect(reportFleetResults({ ...args, config: { ...config, stateDir: file } })).rejects.toThrow();
});

test("explicit operator route required; group routes rejected", () => {
  const { config } = fixture();
  expect(() => parseFleetIsolation({ ...config, operator: { ...config.operator, target: "-100123" } })).toThrow();
  expect(() => parseFleetIsolation({ ...config, operator: undefined })).toThrow();
  expect(() => parseFleetIsolation({ ...config, cooldownMs: 0 })).toThrow();
});

test("failure, exception, timeout are isolated; later real child succeeds in sequence", async () => {
  let active = 0, maximum = 0;
  const order: string[] = [];
  const results = await runFleetEntries([{ id: "failed" }, { id: "exception" }, { id: "timeout" }, { id: "healthy" }], async entry => {
    active++; maximum = Math.max(maximum, active); order.push(entry.id);
    try {
      if (entry.id === "exception") throw Error("bad projection");
      return await runFleetCommand([process.execPath, "-e", entry.id === "timeout"
        ? "setInterval(() => {}, 1000)" : entry.id === "failed" ? "process.exit(1)" : "console.log('isolated healthy')"], tmpdir(), entry.id === "timeout" ? 100 : 2000);
    } finally { active--; }
  });
  expect(maximum).toBe(1); expect(order).toEqual(["failed", "exception", "timeout", "healthy"]);
  expect(results[0]!.exitCode).toBe(1); expect(results[1]!.error).toBeDefined();
  expect(results[2]!.timedOut).toBe(true); expect(results[3]!.exitCode).toBe(0);
  expect(results[3]!.output).toContain("isolated healthy");
});

test("real child drains stdout and stderr concurrently with bounded tails", async () => {
  const result = await runFleetCommand([process.execPath, "-e", "console.log('x'.repeat(50000)); console.error('y'.repeat(50000))"], tmpdir(), 2000);
  expect(result.exitCode).toBe(0); expect(result.output.length).toBeLessThanOrEqual(12000);
  expect(result.error.length).toBeLessThanOrEqual(2000);
});
