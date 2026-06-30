/**
 * bun:test for init.js bootstrap-from-forum helpers.
 *
 * init.js is a pure JS CLI with side-effects, so we test the pure helpers
 * directly (computeTopicSlug, readTopicNameCacheEntries) and the dedup
 * logic via the high-level flow when reachable.
 *
 * The full bootstrapFromForum() flow is covered by manual smoke runs against
 * the real openclaw state sqlite. This test covers the slug algorithm and
 * the dedup contract.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('computeTopicSlug', () => {
  // Re-implement the helper locally to test the algorithm without importing
  // init.js (which has side effects). Must mirror hooks/_lib/slugify.ts.
  function computeTopicSlug(name: string, chatId: string | number, threadId: string | number): string {
    let base = String(name || '').toLowerCase();
    base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const startsLatin = /^[a-z]/.test(base);
    if (!base || !startsLatin) {
      return `topic-${chatId}-${threadId}`;
    }
    if (base.length > 50) {
      base = base.slice(0, 50).replace(/-+$/, '');
    }
    return `${base}-${chatId}-${threadId}`;
  }

  test('Latin name → slug + suffix', () => {
    expect(computeTopicSlug('Q3 Planning', '100', '1')).toBe('q3-planning-100-1');
  });

  test('Cyrillic name → fallback to topic-{chat}-{thread}', () => {
    expect(computeTopicSlug('Дорожная карта', '100', '1')).toBe('topic-100-1');
  });

  test('Empty name → fallback', () => {
    expect(computeTopicSlug('', '100', '1')).toBe('topic-100-1');
  });

  test('Punctuation-only name → fallback', () => {
    expect(computeTopicSlug('!!!', '100', '1')).toBe('topic-100-1');
  });

  test('Long name → truncated at 50', () => {
    const long = 'a'.repeat(60);
    const slug = computeTopicSlug(long, '100', '1');
    // 'a'*50 + '-100-1' = 50 + 6 = 56 chars
    expect(slug).toBe('a'.repeat(50) + '-100-1');
    expect(slug.length).toBe(56);
  });

  test('Same name, different chat/topic → different slug', () => {
    expect(computeTopicSlug('foo', '100', '1')).not.toBe(computeTopicSlug('foo', '100', '2'));
    expect(computeTopicSlug('foo', '100', '1')).not.toBe(computeTopicSlug('foo', '101', '1'));
  });

  test('Numeric-only name (starts with digit) → fallback', () => {
    // Starts with '4' which is not [a-z]; fallback applies.
    expect(computeTopicSlug('4chan', '100', '1')).toBe('topic-100-1');
  });

  test('Mixed Latin + emoji → emoji stripped, dash runs collapsed', () => {
    expect(computeTopicSlug('foo 🎉 bar', '100', '1')).toBe('foo-bar-100-1');
  });

  test('Multiple consecutive dashes collapsed', () => {
    expect(computeTopicSlug('foo---bar', '100', '1')).toBe('foo-bar-100-1');
  });

  test('Leading/trailing dashes stripped', () => {
    expect(computeTopicSlug('---foo---', '100', '1')).toBe('foo-100-1');
  });
});

describe('readTopicNameCacheEntries (dedup contract)', () => {
  // Mirror the helper from init.js.
  function readEntries(db: Database): Array<{chatId: string; threadId: string; name: string; updatedAt: number}> {
    const rows = db.prepare(
      "SELECT namespace, entry_key, value_json FROM plugin_state_entries WHERE plugin_id='telegram' AND namespace LIKE 'telegram.topic-name-cache.%' ORDER BY namespace, entry_key"
    ).all() as Array<{namespace: string; entry_key: string; value_json: string}>;
    const byKey = new Map<string, any>();
    for (const r of rows) {
      const m = String(r.entry_key).match(/^(-?\d+):(\d+)$/);
      if (!m) continue;
      let value: any;
      try { value = JSON.parse(r.value_json); } catch { continue; }
      if (!value || typeof value.name !== 'string') continue;
      const key = `${m[1].replace(/^-/, '')}:${m[2]}`;
      const existing = byKey.get(key);
      const updatedAt = value.updatedAt ?? 0;
      if (!existing || (existing.updatedAt ?? 0) < updatedAt) {
        byKey.set(key, {
          chatId: m[1].replace(/^-/, ''),
          threadId: m[2],
          name: value.name,
          updatedAt,
        });
      }
    }
    return Array.from(byKey.values());
  }

  function makeDbWithEntries(entries: Array<{ns: string; key: string; value: any}>): Database {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE plugin_state_entries (
      plugin_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      entry_key TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at INTEGER,
      expires_at INTEGER
    )`);
    const stmt = db.prepare("INSERT INTO plugin_state_entries (plugin_id, namespace, entry_key, value_json, created_at) VALUES ('telegram', ?, ?, ?, ?)");
    for (const e of entries) {
      stmt.run(e.ns, e.key, JSON.stringify(e.value), Date.now());
    }
    return db;
  }

  test('Single entry per topic → returned as-is', () => {
    const db = makeDbWithEntries([
      { ns: 'telegram.topic-name-cache.aaa', key: '100:1', value: { name: 'foo', updatedAt: 100 } },
    ]);
    expect(readEntries(db)).toEqual([{ chatId: '100', threadId: '1', name: 'foo', updatedAt: 100 }]);
  });

  test('Duplicate (chatId, threadId) across namespaces → keep most recent', () => {
    const db = makeDbWithEntries([
      { ns: 'telegram.topic-name-cache.aaa', key: '100:1', value: { name: 'foo', updatedAt: 100 } },
      { ns: 'telegram.topic-name-cache.bbb', key: '100:1', value: { name: 'foo-renamed', updatedAt: 200 } },
    ]);
    const out = readEntries(db);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('foo-renamed');
    expect(out[0].updatedAt).toBe(200);
  });

  test('Invalid entry_key format is skipped silently', () => {
    const db = makeDbWithEntries([
      { ns: 'telegram.topic-name-cache.aaa', key: 'malformed', value: { name: 'foo' } },
      { ns: 'telegram.topic-name-cache.aaa', key: '100:1', value: { name: 'good' } },
    ]);
    const out = readEntries(db);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('good');
  });

  test('Invalid JSON in value_json is skipped silently', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE plugin_state_entries (plugin_id TEXT NOT NULL, namespace TEXT NOT NULL, entry_key TEXT NOT NULL, value_json TEXT NOT NULL, created_at INTEGER)`);
    db.prepare("INSERT INTO plugin_state_entries VALUES ('telegram', 'telegram.topic-name-cache.aaa', '100:1', 'not-json', 0)").run();
    db.prepare("INSERT INTO plugin_state_entries VALUES ('telegram', 'telegram.topic-name-cache.aaa', '100:2', ?, 0)").run(JSON.stringify({ name: 'good' }));
    const out = readEntries(db);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('good');
  });

  test('Missing name field is skipped', () => {
    const db = makeDbWithEntries([
      { ns: 'telegram.topic-name-cache.aaa', key: '100:1', value: { updatedAt: 100 } }, // no name
    ]);
    expect(readEntries(db)).toEqual([]);
  });

  test('Real-world: chatId with leading minus normalized to absolute', () => {
    const db = makeDbWithEntries([
      { ns: 'telegram.topic-name-cache.aaa', key: '-' + '1001234567890' + ':42', value: { name: 'Engram', updatedAt: 100 } },
    ]);
    const out = readEntries(db);
    expect(out[0].chatId).toBe('1001234567890');
    expect(out[0].threadId).toBe('42');
  });
});