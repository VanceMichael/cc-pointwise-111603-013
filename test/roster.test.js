import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RosterStore, normalizeObservation, effectiveState, billingGroups } from '../src/roster-store.js';

const observation = (overrides = {}) => ({
  registrationId: 'R1', partner: 'P1', session: 'hall-a', personRef: 'person-1',
  name: 'Local Attendee', revision: 1, status: 'registered',
  modifiedAt: '2026-11-16T08:00:00Z', ...overrides,
});

test('normalization requires explicit partner identity and valid timestamps', () => {
  const normalized = normalizeObservation(observation());
  assert.equal(normalized.key, 'P1:R1');
  assert.equal(normalized.personRef, 'person-1');
  assert.throws(() => normalizeObservation(observation({ personRef: ' ' })), /missing personRef/);
  assert.throws(() => normalizeObservation(observation({ modifiedAt: 'nope' })), /invalid modifiedAt/);
  assert.throws(() => normalizeObservation(observation({ revision: 'x' })), /invalid revision/);
});

test('observations are append-only and identical re-collection is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-'));
  try {
    const store = new RosterStore(join(directory, 'roster.json'));
    const first = await store.appendObservations([observation()], {
      batchId: 'b1', observedAt: '2026-11-16T08:00:00Z', path: '/partners/P1/roster',
    });
    assert.deepEqual(first, { added: 1, received: 1, missingKeys: [], batchId: 'b1' });
    const replay = await store.appendObservations([observation()], {
      batchId: 'b2', observedAt: '2026-11-16T08:10:00Z', path: '/partners/P1/roster',
    });
    assert.equal(replay.added, 0, '相同观察重复采集不新增条目');
    const document = await store.load();
    assert.equal(document.observations.length, 1);
    assert.equal(document.batches.length, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('renaming appends a revision instead of replacing the person', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-rename-'));
  try {
    const store = new RosterStore(join(directory, 'roster.json'));
    await store.appendObservations([observation()], { batchId: 'b1', observedAt: '2026-11-16T08:00:00Z' });
    await store.appendObservations([observation({
      name: 'Local Attendee Updated', revision: 2, modifiedAt: '2026-11-16T09:30:00Z',
    })], { batchId: 'b2', observedAt: '2026-11-16T09:30:00Z' });
    const document = await store.load();
    assert.equal(document.observations.length, 2);
    assert.equal(new Set(document.observations.map((item) => item.personRef)).size, 1, 'personRef 不变，不产生新人');
    const atEight = await store.effectiveAt('2026-11-16T08:30:00Z');
    assert.equal(atEight.registrations[0].name, 'Local Attendee');
    const later = await store.effectiveAt('2026-11-16T10:00:00Z');
    assert.equal(later.registrations[0].name, 'Local Attendee Updated');
    assert.equal(later.registrations[0].valid, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('page absence is recorded but never cancels a registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'roster-missing-'));
  try {
    const store = new RosterStore(join(directory, 'roster.json'));
    await store.appendObservations([
      observation(),
      observation({ registrationId: 'R2', personRef: 'person-2', name: 'Second Guest', modifiedAt: '2026-11-16T08:05:00Z' }),
    ], { batchId: 'b1', observedAt: '2026-11-16T08:05:00Z' });
    const secondBatch = await store.appendObservations([
      observation({ registrationId: 'R2', personRef: 'person-2', name: 'Second Guest', modifiedAt: '2026-11-16T08:05:00Z' }),
    ], { batchId: 'b2', observedAt: '2026-11-16T09:00:00Z' });
    assert.deepEqual(secondBatch.missingKeys, ['P1:R1']);
    const state = await store.effectiveAt('2026-11-16T09:30:00Z');
    const r1 = state.registrations.find((item) => item.key === 'P1:R1');
    assert.equal(r1.valid, true, '页面缺席不改变有效报名状态');
    assert.equal(r1.cancelled, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('only explicit cancelled status withdraws a registration', async () => {
  const document = { observations: [
    normalizeObservation(observation(), { batchId: 'b1', observedAt: '2026-11-16T08:00:00Z' }),
    normalizeObservation(observation({
      revision: 2, status: 'cancelled', modifiedAt: '2026-11-16T10:30:00Z',
    }), { batchId: 'b2', observedAt: '2026-11-16T10:30:00Z' }),
  ], batches: [] };
  const before = effectiveState(document, '2026-11-16T09:00:00Z');
  assert.equal(before.registrations[0].valid, true);
  const after = effectiveState(document, '2026-11-16T11:00:00Z');
  assert.equal(after.registrations[0].valid, false);
  assert.equal(after.registrations[0].cancelled, true);
});

test('billing groups collapse multiple partner registrations of the same person in one session', () => {
  const document = { observations: [
    normalizeObservation(observation(), { observedAt: '2026-11-16T08:00:00Z' }),
    normalizeObservation(observation({
      registrationId: 'X9', partner: 'P2', name: 'A New Name',
      modifiedAt: '2026-11-16T08:00:00Z',
    }), { observedAt: '2026-11-16T08:00:00Z' }),
  ], batches: [] };
  const state = effectiveState(document, '2026-11-16T09:00:00Z');
  const groups = billingGroups(state.registrations);
  assert.equal(groups.length, 1, '同一 personRef+场次只形成一个计费身份');
  assert.deepEqual(groups[0].registrationKeys, ['P1:R1', 'P2:X9']);
});
