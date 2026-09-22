import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("production adapter compiles and registers one prompt contribution hook", async () => {
  const root = mkdtempSync(join(tmpdir(), "engram-context-plugin-"));
  try {
    const entry = join(import.meta.dir, "../../integrations/openclaw-context-delivery/index.ts");
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      write: false,
      plugins: [{
        name: "host-sdk-fixture",
        setup(build) {
          build.onResolve({ filter: /^openclaw\/plugin-sdk\// }, (args) => ({ path: args.path, namespace: "host-fixture" }));
          build.onLoad({ filter: /.*/, namespace: "host-fixture" }, () => ({
            loader: "js",
            contents: "export const definePluginEntry = value => value;",
          }));
        },
      }],
    });
    expect(result.success).toBe(true);
    const bundle = join(root, "plugin.mjs");
    writeFileSync(bundle, await result.outputs[0]!.text());
    const plugin = await import(bundle);
    const hooks = new Map<string, Function[]>();
    const api = {
      runtime: {
        config: { current: () => ({}) },
        agent: { resolveAgentWorkspaceDir: () => root },
      },
      logger: { info() {}, warn() {} },
      on(name: string, handler: Function) {
        hooks.set(name, [...(hooks.get(name) ?? []), handler]);
      },
    };
    plugin.default.register(api);
    expect([...hooks.keys()].sort()).toEqual(["agent_end", "before_prompt_build"]);
    expect(hooks.get("before_prompt_build")).toHaveLength(1);
    expect(hooks.has("agent_turn_prepare")).toBe(false);
    const output = hooks.get("before_prompt_build")![0]!({}, { trigger: "cron" });
    expect(output).toBeUndefined();

    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "../../integrations/openclaw-context-delivery/openclaw.plugin.json"), "utf8"));
    expect(manifest.activation.onCapabilities).toEqual(["hook"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
