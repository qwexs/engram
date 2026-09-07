import { expect, test } from "bun:test";
import { configuredMemoryAgentIds } from "./configured-agents.ts";

test("startup recovery enumerates non-main object-map entries and array entries identically", () => {
  expect(configuredMemoryAgentIds({ agents: { entries: { main: {}, "personal-a": {}, "personal-b": {} } } }))
    .toEqual(["main", "personal-a", "personal-b"]);
  expect(configuredMemoryAgentIds({ agents: { entries: [{ id: "main" }, { id: "personal-a" }, null, { id: "personal-b" }] } }))
    .toEqual(["main", "personal-a", "personal-b"]);
  expect(configuredMemoryAgentIds({})).toEqual(["main"]);
});
