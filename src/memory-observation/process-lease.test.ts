import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireProcessLease } from "./process-lease.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, {recursive:true,force:true})));
function path() { const root = mkdtempSync(join(tmpdir(),"engram-lease-")); roots.push(root); return join(root,"lock"); }
test("live owner excludes concurrent inference and releases", () => {
 const p = path(), release = acquireProcessLease(p)!;
 expect(release).toBeFunction(); expect(acquireProcessLease(p)).toBeNull();
 release(); const next = acquireProcessLease(p); expect(next).toBeFunction(); next!();
});
test("pid reuse or dead owner is recoverable", () => {
 const p = path(); mkdirSync(p); writeFileSync(join(p,"owner.json"),JSON.stringify({pid:process.pid,identity:"old-start-time",token:"old"}));
 const release = acquireProcessLease(p); expect(release).toBeFunction(); release!();
});
test("partially published live lease is not stolen", () => {
 const p=path(); mkdirSync(p); expect(acquireProcessLease(p)).toBeNull();
});
