/** Shared projection for ordinary writes and explicit source-quote corrections. */
export const DOMAIN_RECENT_START = "<!-- engram-domain-recent:start -->";
export const DOMAIN_RECENT_END = "<!-- engram-domain-recent:end -->";
export function renderRecentDomainStatus(status: string, changelog: string): string {
  const superseded = new Set([...changelog.matchAll(/<!-- engram-domain-superseded:(sha256:[a-f0-9]{64}) by:sha256:[a-f0-9]{64} -->/g)].map(m => m[1]));
  const recent = [...changelog.matchAll(/<!-- engram-domain-entry:(sha256:[a-f0-9]{64}) -->\n(- [^\n]*(?:\n  [^\n]*)*)/g)]
    .filter(m => !superseded.has(m[1])).map(m => m[2]!).sort().slice(-20).join("\n");
  const managed = DOMAIN_RECENT_START + "\n## Последние сохранённые записи\n\n" + recent + "\n" + DOMAIN_RECENT_END;
  const starts = status.split(DOMAIN_RECENT_START).length - 1, ends = status.split(DOMAIN_RECENT_END).length - 1;
  if (starts !== ends || starts > 1) throw new Error("domain status managed block is ambiguous");
  return starts ? status.replace(/<!-- engram-domain-recent:start -->[\s\S]*?<!-- engram-domain-recent:end -->/, () => managed)
    : status.trimEnd() + "\n\n" + managed + "\n";
}
