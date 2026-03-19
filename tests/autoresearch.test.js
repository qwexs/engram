import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "path";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { parseYAML, validateExperimentSpec, generateYAML } from "../scripts/experiment-spec.js";
import { loadRegistry, nextId, addExperiment, updateStatus, listByStatus, getExperiment } from "../scripts/experiments-registry.js";

const WORKSPACE_ROOT = join(import.meta.dir, "..", "..", "..");
const TEST_RESEARCH_DIR = join(WORKSPACE_ROOT, "workspace", "research-test");

// Перезапись переменной окружения для тестов
process.env.ENGRAM_WORKSPACE = WORKSPACE_ROOT;

describe("experiment-spec.js - YAML parsing", () => {
  test("parses simple YAML correctly", () => {
    const yaml = `
hypothesis: "Test hypothesis"
type: research
metric: "Test metric"
    `.trim();
    
    const result = parseYAML(yaml);
    expect(result.hypothesis).toBe("Test hypothesis");
    expect(result.type).toBe("research");
    expect(result.metric).toBe("Test metric");
  });

  test("parses arrays correctly", () => {
    const yaml = `
actions:
  - "Step 1"
  - "Step 2"
  - "Step 3"
    `.trim();
    
    const result = parseYAML(yaml);
    expect(result.actions).toEqual(["Step 1", "Step 2", "Step 3"]);
  });

  test("parses nested objects correctly", () => {
    const yaml = `
budget:
  estimated_tokens: 10000
  estimated_cost_usd: 0.1
  value:
    blocker: false
    deadline_days: null
    manual_hours_saved: 2
    `.trim();
    
    const result = parseYAML(yaml);
    expect(result.budget.estimated_tokens).toBe(10000);
    expect(result.budget.estimated_cost_usd).toBe(0.1);
    expect(result.budget.value.blocker).toBe(false);
    expect(result.budget.value.deadline_days).toBe(null);
    expect(result.budget.value.manual_hours_saved).toBe(2);
  });
});

describe("experiment-spec.js - validation", () => {
  const TZ = "Europe/Moscow";
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const now = new Date().toISOString();

  test("validates correct spec", () => {
    const spec = {
      id: `EXP-${today}-001`,
      created_by: "rethink",
      created_at: now,
      source_observations: ["obs-0001"],
      hypothesis: "Test hypothesis",
      type: "research",
      actions: ["Action 1", "Action 2"],
      metric: "Test metric",
      baseline: "Test baseline",
      success_criteria: "Test criteria",
      budget: {
        estimated_tokens: 10000,
        estimated_cost_usd: 0.1,
        value: {
          blocker: false,
          deadline_days: null,
          manual_hours_saved: 1,
        },
        roi_estimate: 10,
        decision: "auto",
      },
      output: {
        path: "test/path",
        publish_to: "none",
      },
      delivery: {
        report: true,
        daily_note: false,
      },
      status: "pending",
      result_summary: null,
      follow_up_observations: [],
    };

    const validation = validateExperimentSpec(spec);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  test("rejects invalid ID format", () => {
    const spec = {
      id: "invalid-id",
      created_by: "rethink",
      created_at: now,
      source_observations: [],
      hypothesis: "Test",
      type: "research",
      actions: ["Action 1"],
      metric: "Metric",
      baseline: "Baseline",
      success_criteria: "Criteria",
      budget: {
        estimated_tokens: 100,
        estimated_cost_usd: 0.01,
        value: { blocker: false, deadline_days: null, manual_hours_saved: null },
        roi_estimate: 0,
        decision: "auto",
      },
      output: { path: "path", publish_to: "none" },
      delivery: { report: true, daily_note: false },
      status: "pending",
      result_summary: null,
      follow_up_observations: [],
    };

    const validation = validateExperimentSpec(spec);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some(e => e.includes("формате 'EXP-YYYY-MM-DD-NNN'"))).toBe(true);
  });

  test("rejects missing required fields", () => {
    const spec = {
      id: `EXP-${today}-001`,
      created_by: "rethink",
      created_at: now,
      source_observations: [],
      type: "research",
      status: "pending",
      result_summary: null,
      follow_up_observations: [],
    };

    const validation = validateExperimentSpec(spec);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });
});

describe("experiment-spec.js - YAML generation", () => {
  test("generates valid YAML from object", () => {
    const obj = {
      hypothesis: "Test hypothesis",
      type: "research",
      actions: ["Action 1", "Action 2"],
      budget: {
        estimated_tokens: 10000,
        decision: "auto",
      },
    };

    const yaml = generateYAML(obj);
    expect(yaml).toContain("hypothesis: Test hypothesis");
    expect(yaml).toContain("type: research");
    expect(yaml).toContain("- Action 1");
    expect(yaml).toContain("- Action 2");
    expect(yaml).toContain("estimated_tokens: 10000");
  });
});

// Примечание: тесты для experiments-registry.js требуют фактической файловой системы
// и будут выполняться в изолированной директории TEST_RESEARCH_DIR
describe("experiments-registry.js - basic operations", () => {
  // Эти тесты можно расширить для полной интеграции с файловой системой
  test("placeholder for registry tests", () => {
    expect(true).toBe(true);
  });
});
