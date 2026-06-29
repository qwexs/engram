/**
 * Slugify a Telegram topic name into a domain-name-safe slug.
 *
 * Domain names in engram must:
 *   - start with a lowercase letter
 *   - contain only [a-z0-9-]
 *   - be unique across the workspace
 *
 * The chatId+topicId suffix is ALWAYS appended for uniqueness, so the same
 * topic name in different groups won't collide. The user-facing part (the
 * "q3-planning" part) is best-effort: if the topic name is empty, pure
 * Cyrillic, or otherwise unsluggable, we fall back to a generic
 * `topic-{chatId}-{topicId}` name. Etalon-grade hooks should not bring
 * transliteration libraries (edge cases like Tatar/Belarusian/Kazakh are
 * not coverable cleanly) and a stable ID-based name is always debuggable.
 *
 * @param topicName - the human-readable topic name (e.g. "Q3 Planning")
 * @param chatId - Telegram chat id, with or without leading minus
 * @param topicId - Telegram message_thread_id (string, may be large)
 * @returns a domain-name-safe slug, e.g. "q3-planning-0000000000000-1"
 */
export function slugifyTopicName(
  topicName: string | undefined | null,
  chatId: string | number,
  topicId: string | number
): string {
  const absChatId = String(chatId).replace(/^-/, "");
  const topicIdStr = String(topicId);
  // Suffix uses the raw chat/topic ids (with or without leading minus on chatId)
  // for cross-workspace uniqueness. The "00" prefix in template examples is
  // a clearly synthetic placeholder; real ids are -100xxxxxxxxxx.
  const suffix = `-${absChatId}-${topicIdStr}`;

  const baseRaw = String(topicName || "").trim();
  if (!baseRaw) return `topic${suffix}`;

  // Slugify: lowercase, non-[a-z0-9] → "-", strip leading/trailing dashes.
  const base = baseRaw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40); // readability cap; suffix keeps it unique anyway

  // If nothing survived (pure Cyrillic, punctuation, etc.) or the result
  // doesn't start with a letter (e.g. starts with digit after a leading
  // digit in original), fall back to the generic name.
  if (!base || !/^[a-z]/.test(base)) return `topic${suffix}`;

  return `${base}${suffix}`;
}
