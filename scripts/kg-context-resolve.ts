#!/usr/bin/env bun
import { resolveKgDefaultContext } from "../src/kg-v3/context.ts";

const args = process.argv.slice(2);
const value = (flag: string) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const workspace = value("--workspace") || process.env.ENGRAM_WORKSPACE || process.cwd();
const workspaceId = value("--workspace-id");
if (!workspaceId) throw new Error("--workspace-id is required");
console.log(JSON.stringify(resolveKgDefaultContext({ workspace, workspaceId })));
