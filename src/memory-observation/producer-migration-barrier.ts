/** The migration journal is a narrow deterministic barrier, not a scheduler.
 * A crash after any partial queue reset must block ordinary discovery/claim. */
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { sha256, type Digest, type ObservationScope } from "./ledger.ts";
export const PRODUCER_MIGRATION_SCHEMA = "engram.memory-quote-producer-migration.v1" as const;
export const PRODUCER_MIGRATION_READY_SCHEMA = "engram.memory-quote-producer-migration-ready.v1" as const;
export function producerMigrationRoot(storeRoot: string, scope: ObservationScope) {
  return join(resolve(storeRoot), "memory-batch-live/v1/producer-migrations", sha256(scope).slice(7));
}
export function producerMigrationIdentity(value: any) {
  return sha256({ schema: PRODUCER_MIGRATION_SCHEMA, oldJobId: value.oldJobId, targetEvaluationPolicyDigest: value.targetEvaluationPolicyDigest,
    scope: value.scope, authorizedBy: value.authorizedBy, authorizedAt: value.authorizedAt, reason: value.reason });
}
export function producerMigrationBarrier(storeRoot: string, scope: ObservationScope, allowedMigrationId?: Digest): null | { reason: "producer_migration_incomplete" | "producer_migration_invalid" } {
  const root = producerMigrationRoot(storeRoot, scope);
  if (!existsSync(root)) return null;
  try {
    if (lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) throw Error();
    for (const name of readdirSync(root).sort()) {
      if (!/^[a-f0-9]{64}$/.test(name) || !lstatSync(join(root, name)).isDirectory() || lstatSync(join(root, name)).isSymbolicLink()) throw Error();
      if (allowedMigrationId?.slice(7) === name) continue; // Operator owns this exact immutable journal; ordinary Worker never passes this.
      const dir = join(root, name), authFile = join(dir, "authorization.json"), completedFile = join(dir, "completed.json");
      if (!existsSync(authFile)) return { reason: "producer_migration_incomplete" };
      if (!lstatSync(authFile).isFile() || lstatSync(authFile).isSymbolicLink()) throw Error();
      const auth = JSON.parse(readFileSync(authFile, "utf8")), { authorizationId, ...body } = auth;
      if (auth.schema !== PRODUCER_MIGRATION_SCHEMA || authorizationId !== sha256(body) || sha256(auth.scope) !== sha256(scope)
        || auth.migrationId !== producerMigrationIdentity(auth) || name !== auth.migrationId.slice(7)) throw Error();
      if (!existsSync(completedFile)) return { reason: "producer_migration_incomplete" };
      if (!lstatSync(completedFile).isFile() || lstatSync(completedFile).isSymbolicLink()) throw Error();
      const completed = JSON.parse(readFileSync(completedFile, "utf8")), { readyId, ...readyBody } = completed;
      if (completed.schema !== PRODUCER_MIGRATION_READY_SCHEMA || readyId !== sha256(readyBody)
        || completed.migrationId !== auth.migrationId || completed.authorizationId !== authorizationId
        || completed.oldJobId !== auth.oldJobId || completed.newJobId !== auth.newJobId || completed.newJobDigest !== auth.newJobDigest
        || sha256(completed.traceIds) !== sha256(auth.queues.map((q: any) => q.traceId)) || completed.status !== "ready_for_evaluation"
        || completed.canonicalWrites !== 0 || completed.inferenceRun !== false) throw Error();
      if (!/^sha256:[a-f0-9]{64}$/.test(auth.newJobId)) throw Error();
      for (const [file, digest] of [[join(resolve(storeRoot), "memory-batch-live/v1/jobs", auth.newJobId.slice(7) + ".json"), auth.newJobDigest],
        [join(dir, "original-failure.json"), auth.failureDigest], [join(dir, "original-done.json"), auth.doneDigest]]) {
        if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || sha256(JSON.parse(readFileSync(file, "utf8"))) !== digest) throw Error();
      }
    }
    return null;
  } catch { return { reason: "producer_migration_invalid" }; }
}
