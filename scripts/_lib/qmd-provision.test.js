import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addQmdCollection, addQmdCollectionSync } from './qmd-provision.js';

test('resume accepts exact registration but rejects root/mask drift without invoking QMD', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'engram-provision-resume-'));
  try {
    mkdirSync(join(workspace, '.qmd'));
    writeFileSync(join(workspace, '.qmd/index.yml'), 'collections: {}\n');
    writeFileSync(join(workspace, 'engram.json'), JSON.stringify({qmd:{localIndex:true,command:'/nonexistent-qmd',collections:['self']}}));
    const db = new Database(join(workspace, '.qmd/index.sqlite'));
    db.run('CREATE TABLE store_collections(name TEXT PRIMARY KEY, path TEXT, pattern TEXT)');
    db.run('INSERT INTO store_collections VALUES (?, ?, ?)', ['self', workspace, '*.md']);
    db.close();
    const input = {workspace, collection:'self', path:workspace, mask:'*.md'};
    expect((await addQmdCollection(input)).ok).toBe(true);
    expect(addQmdCollectionSync(input).ok).toBe(true);
    expect((await addQmdCollection({...input,path:join(workspace,'wrong')})).ok).toBe(false);
    expect(addQmdCollectionSync({...input,mask:'**/*.md'}).ok).toBe(false);
  } finally { rmSync(workspace, {recursive:true,force:true}); }
});
