/** Both supported host config shapes must participate in restart recovery. */
export function configuredMemoryAgentIds(config: any): string[] {
  const ids = new Set<string>(["main"]);
  const entries = config?.agents?.entries;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry?.id === "string" && entry.id) ids.add(entry.id);
    }
  } else if (entries && typeof entries === "object") {
    for (const id of Object.keys(entries)) ids.add(id);
  }
  return [...ids];
}
