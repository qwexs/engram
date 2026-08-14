import { dirname, resolve } from "node:path";

type PathResolver = Pick<typeof import("node:path"), "dirname" | "resolve">;

export function repositoryFromScriptPath(
  scriptPath: string,
  pathResolver: PathResolver = { dirname, resolve },
): string {
  return pathResolver.resolve(pathResolver.dirname(pathResolver.dirname(scriptPath)));
}
