import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from '../src/source-client.js';
import { RosterStore } from '../src/roster-store.js';
import { collectRoster } from '../src/collector.js';
import { readLedger } from '../src/operations.js';

const scenarioPath = new URL('../fixtures/source-lifecycle.json', import.meta.url);
const fixedClock = (stage) => ({
  opening: '2026-11-16T08:05:00Z',
  renamed: '2026-11-16T09:30:00Z',
  missing: '2026-11-16T09:45:00Z',
  withdrawn: '2026-11-16T10:30:00Z',
  backfilled: '2026-11-16T11:00:00Z',
}[stage]);

test('collection walks every partner route and keeps missing pages distinct from cancellations', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'collect-lifecycle-'));
  try {
    const roster = new RosterStore(join(directory, 'roster.json'));
    const client = new SourceClient(source.url);

    const opening = await collectRoster(client, roster, { partners: ['P1', 'P2'], now: fixedClock('opening') });
    assert.equal(opening.partners.length, 2);
    assert.equal(opening.partners.reduce((sum, item) => sum + item.received, 0), 3);

    source.publish('renamed');
    const renamed = await collectRoster(client, roster, { partners: ['P1', 'P2'], now: fixedClock('renamed') });
    assert.equal(renamed.partners.reduce((sum, item) => sum + item.added, 0), 2, '两个合作方的改名各产生一条新观察');

    source.publish('missing');
    const missing = await collectRoster(client, roster, { partners: ['P1', 'P2'], now: fixedClock('missing') });
    assert.deepEqual(missing.partners.find((item) => item.partner === 'P1').missingKeys, ['P1:R1'], '批次记录页面缺席');
    const stateWhileMissing = await roster.effectiveAt(fixedClock('missing'));
    assert.equal(stateWhileMissing.registrations.find((item) => item.key === 'P1:R1').valid, true);

    source.publish('withdrawn');
    await collectRoster(client, roster, { partners: ['P1'], now: fixedClock('withdrawn') });
    const withdrawn = await roster.effectiveAt(fixedClock('withdrawn'));
    const r2 = withdrawn.registrations.find((item) => item.key === 'P1:R2');
    assert.equal(r2.cancelled, true, '只有显式 cancelled 才撤回');
    assert.equal(withdrawn.registrations.find((item) => item.key === 'P1:R1').valid, true);

    source.publish('backfilled');
    await collectRoster(client, roster, { partners: ['P1', 'P2'], now: fixedClock('backfilled') });
    const finalState = await roster.effectiveAt(fixedClock('backfilled'));
    assert.equal(finalState.registrations.length, 4);
    assert.deepEqual(finalState.registrations.filter((item) => item.valid).map((item) => item.key).sort(),
      ['P1:R1', 'P1:R3', 'P2:X9']);

    const document = await roster.load();
    assert.equal(document.batches.length, 9, '每次合作方采集都留下批次留痕（opening/renamed/missing 各 2、withdrawn 1、backfilled 2）');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('304 responses add no observations and no absence batch', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'collect-etag-'));
  try {
    const roster = new RosterStore(join(directory, 'roster.json'));
    const client = new SourceClient(source.url);
    const etagCache = new Map();
    await collectRoster(client, roster, { partners: ['P1'], now: fixedClock('opening'), etagCache });
    const before = await roster.load();
    const replay = await collectRoster(client, roster, { partners: ['P1'], now: fixedClock('opening'), etagCache });
    assert.equal(replay.partners[0].added, 0);
    assert.equal(replay.partners[0].notModified, true);
    const after = await roster.load();
    assert.equal(after.observations.length, before.observations.length, '未变化来源不制造观察');
    assert.equal(after.batches.length, before.batches.length, '未变化来源不制造缺席批次');
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('business ledger reads roster, attendance and confirmations as separate facts', async () => {
  const source = await startSource(scenarioPath);
  const directory = await mkdtemp(join(tmpdir(), 'collect-ledger-'));
  try {
    const stores = {
      roster: new RosterStore(join(directory, 'roster.json')),
      attendance: new (await import('../src/attendance-store.js')).AttendanceStore(join(directory, 'attendance.json')),
      settlements: new (await import('../src/settlement-store.js')).SettlementStore(join(directory, 'settlements.json')),
    };
    await collectRoster(new SourceClient(source.url), stores.roster, {
      partners: ['P1', 'P2'], now: fixedClock('opening'),
    });
    await stores.attendance.merge([
      { eventId: 'entry-1', personRef: 'person-1', session: 'hall-a', at: '2026-11-16T08:10:00Z' },
    ]);
    const ledger = await readLedger(stores, { asOf: '2026-11-16T08:30:00Z' });
    assert.equal(ledger.report.sessions[0].session, 'hall-a');
    assert.equal(ledger.report.sessions[0].counts.attendedPersons, 1);
    assert.equal(ledger.report.sessions[0].counts.billableIdentities, 2);
    assert.equal(ledger.settlementConfirmations.length, 0);
  } finally {
    await source.close();
    await rm(directory, { recursive: true, force: true });
  }
});
