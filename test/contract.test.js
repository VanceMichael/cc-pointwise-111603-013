import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { startSource } from '../source/server.js';
import { parsePage, entryPath } from '../src/adapter.js';
import { SourceClient } from '../src/source-client.js';

async function observe(stage = 'opening', path = entryPath) {
  const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
  try {
    source.publish(stage);
    return parsePage(await new SourceClient(source.url).read(path));
  } finally { await source.close(); }
}

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
}

test('roster revisions, attendance and settlement references remain separate facts', async () => {
  const initial = (await observe()).records[0].attributes;
  const changed = (await observe('updated')).records[0].attributes;
  assert.equal(initial.personRef, changed.personRef);
  assert.equal(changed.status, 'cancelled');
  assert.notEqual(initial.name, changed.name);
  const attendance = await fixture('attendance');
  const settlements = await fixture('settlements');
  assert.equal(attendance[0].personRef, initial.personRef);
  assert.equal(settlements[0].confirmedAt, '2026-11-16T08:30:00Z');
});
