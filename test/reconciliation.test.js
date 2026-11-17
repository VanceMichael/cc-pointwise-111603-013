import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RosterStore } from '../src/roster-store.js';
import { AttendanceStore } from '../src/attendance-store.js';
import { SettlementStore } from '../src/settlement-store.js';
import { buildDailyReport, buildSessionReport, reconcileSettlement } from '../src/reconciliation.js';

const r1v1 = {
  registrationId: 'R1', partner: 'P1', session: 'hall-a', personRef: 'person-1',
  name: 'Local Attendee', revision: 1, status: 'registered', modifiedAt: '2026-11-16T08:00:00Z',
};
const r2 = {
  registrationId: 'R2', partner: 'P1', session: 'hall-a', personRef: 'person-2',
  name: 'Second Guest', revision: 1, status: 'registered', modifiedAt: '2026-11-16T08:05:00Z',
};
const x9 = {
  registrationId: 'X9', partner: 'P2', session: 'hall-a', personRef: 'person-1',
  name: 'Local Attendee', revision: 1, status: 'registered', modifiedAt: '2026-11-16T08:00:00Z',
};

async function seededStores(directory) {
  const roster = new RosterStore(join(directory, 'roster.json'));
  const attendance = new AttendanceStore(join(directory, 'attendance.json'));
  const settlements = new SettlementStore(join(directory, 'settlements.json'));
  await roster.appendObservations([r1v1, r2, x9], { batchId: 'b1', observedAt: '2026-11-16T08:05:00Z' });
  await attendance.merge([
    { eventId: 'entry-1', personRef: 'person-1', session: 'hall-a', at: '2026-11-16T08:10:00Z' },
    { eventId: 'entry-2', personRef: 'person-2', session: 'hall-a', at: '2026-11-16T08:12:00Z' },
  ]);
  return { roster, attendance, settlements };
}

test('daily report explains valid, cancelled and attended counts per session and point in time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-report-'));
  try {
    const { roster, attendance } = await seededStores(directory);
    const report = buildSessionReport(await roster.load(), await attendance.load(), 'hall-a', '2026-11-16T08:30:00Z');
    assert.equal(report.counts.registrations, 3);
    assert.equal(report.counts.valid, 3);
    assert.equal(report.counts.cancelled, 0);
    assert.equal(report.counts.attendanceEvents, 2);
    assert.equal(report.counts.attendedPersons, 2);
    assert.equal(report.counts.billableIdentities, 2, '两条 person-1 报名只算一个计费身份');
    const duplicate = report.discrepancies.find((item) => item.code === 'duplicate-billing-identity');
    assert.ok(duplicate);
    assert.deepEqual(duplicate.registrationKeys, ['P1:R1', 'P2:X9']);

    // 时点语义以本地留痕 observedAt 为准：08:01 时点还没有任何入库观察。
    const emptyAtEight = buildDailyReport(await roster.load(), await attendance.load(), '2026-11-16T08:01:00Z', 'hall-a');
    assert.equal(emptyAtEight.sessions[0].counts.valid, 0);
    assert.equal(emptyAtEight.sessions[0].counts.attendanceEvents, 0);
    // 08:05 批次入库后，08:10 时点能看到全部报名但签到尚未发生。
    const beforeAttendance = buildDailyReport(await roster.load(), await attendance.load(), '2026-11-16T08:09:00Z', 'hall-a');
    assert.equal(beforeAttendance.sessions[0].counts.valid, 3);
    assert.equal(beforeAttendance.sessions[0].counts.attendanceEvents, 0, '08:10 的签到在 08:09 时点尚未发生');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('attendance is linked through personRef and never overwrites roster state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-link-'));
  try {
    const { roster, attendance } = await seededStores(directory);
    await roster.appendObservations([{ ...r1v1, name: 'Local Attendee Updated', revision: 2, modifiedAt: '2026-11-16T09:30:00Z' },
      r2, { ...x9, name: 'Local Attendee Updated', revision: 2, modifiedAt: '2026-11-16T09:30:00Z' }],
      { batchId: 'b2', observedAt: '2026-11-16T09:30:00Z' });
    const report = buildSessionReport(await roster.load(), await attendance.load(), 'hall-a', '2026-11-16T10:00:00Z');
    const entry = report.attendance.find((event) => event.eventId === 'entry-1');
    assert.deepEqual(entry.linkedRegistrationKeys, ['P1:R1', 'P2:X9'], '改名后仍通过 personRef 关联到两条报名');
    const attendanceDocument = await attendance.load();
    assert.equal(attendanceDocument.events.length, 2, '名单改名没有改动签到留痕');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('confirmed settlement is immutable and late revisions only surface as discrepancies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-confirm-'));
  try {
    const { roster, attendance, settlements } = await seededStores(directory);
    const confirmation = {
      session: 'hall-a', confirmedAt: '2026-11-16T08:30:00Z',
      registrations: ['P1:R1', 'P1:R2', 'P2:X9'], attendanceEvents: ['entry-1', 'entry-2'],
    };
    await settlements.confirm(confirmation);
    const repeated = await settlements.confirm(confirmation);
    assert.equal(repeated.added, false, '完全相同的重复确认是幂等的');
    await assert.rejects(settlements.confirm({ ...confirmation, registrations: ['P1:R1'] }),
      /already confirmed and cannot be rewritten/);

    // 确认之后：R1 改名、R2 撤回、R3 补录。
    await roster.appendObservations([
      { ...r1v1, name: 'Local Attendee Updated', revision: 2, modifiedAt: '2026-11-16T09:30:00Z' },
      { ...r2, revision: 2, status: 'cancelled', modifiedAt: '2026-11-16T10:30:00Z' },
      { registrationId: 'R3', partner: 'P1', session: 'hall-a', personRef: 'person-3',
        name: 'Late Entry', revision: 1, status: 'registered', modifiedAt: '2026-11-16T11:00:00Z' },
      { ...x9, name: 'Local Attendee Updated', revision: 2, modifiedAt: '2026-11-16T09:30:00Z' },
    ], { batchId: 'b2', observedAt: '2026-11-16T11:00:00Z' });

    const stored = await settlements.load();
    assert.deepEqual(stored.confirmations[0].registrations, ['P1:R1', 'P1:R2', 'P2:X9'], '确认依据保持原样');
    const result = reconcileSettlement(await roster.load(), await attendance.load(), stored.confirmations[0], '2026-11-16T12:00:00Z');
    const codes = result.discrepancies.map((item) => item.code);
    assert.ok(codes.includes('renamed-after-confirmation'));
    assert.ok(codes.includes('revised-after-confirmation'));
    assert.ok(codes.includes('cancelled-after-confirmation'));
    assert.ok(codes.includes('registered-after-confirmation'));
    assert.ok(codes.includes('duplicate-billing-identity'));
    const renamed = result.discrepancies.find((item) => item.code === 'renamed-after-confirmation');
    assert.equal(renamed.personRef, 'person-1');
    assert.equal(renamed.confirmedName, 'Local Attendee');
    assert.equal(renamed.currentName, 'Local Attendee Updated');
    const backfill = result.discrepancies.find((item) => item.code === 'registered-after-confirmation');
    assert.equal(backfill.registrationKey, 'P1:R3');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('absence on the page keeps a confirmed registration valid; explicit cancellation is dated separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-absence-'));
  try {
    const { roster, attendance, settlements } = await seededStores(directory);
    const confirmation = {
      session: 'hall-a', confirmedAt: '2026-11-16T08:30:00Z',
      registrations: ['P1:R1', 'P1:R2', 'P2:X9'], attendanceEvents: ['entry-1', 'entry-2'],
    };
    await settlements.confirm(confirmation);
    // 新批次页面上 R1 缺席，但没有任何 cancelled 观察。
    await roster.appendObservations([r2, x9], { batchId: 'b2', observedAt: '2026-11-16T09:00:00Z' });
    const result = reconcileSettlement(await roster.load(), await attendance.load(),
      (await settlements.load()).confirmations[0], '2026-11-16T09:30:00Z');
    assert.equal(result.discrepancies.filter((item) => item.code === 'cancelled-after-confirmation').length, 0);
    assert.equal(result.report.counts.valid, 3, '缺席不等于撤回，R1 仍是有效报名');
    assert.deepEqual(result.confirmed.registrations, ['P1:R1', 'P1:R2', 'P2:X9']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('orphan attendance is retained but flagged rather than creating a billable registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-orphan-'));
  try {
    const { roster, attendance } = await seededStores(directory);
    await attendance.merge([
      { eventId: 'entry-9', personRef: 'person-9', session: 'hall-a', at: '2026-11-16T08:40:00Z' },
    ]);
    const report = buildSessionReport(await roster.load(), await attendance.load(), 'hall-a', '2026-11-16T09:00:00Z');
    const orphan = report.discrepancies.find((item) => item.code === 'attendance-without-valid-registration');
    assert.ok(orphan);
    assert.equal(orphan.eventId, 'entry-9');
    assert.equal(report.counts.billableIdentities, 2, '签到不会凭空制造报名计费身份');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('attendance arriving after confirmation is explained without rewriting the basis', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'recon-late-'));
  try {
    const { roster, attendance, settlements } = await seededStores(directory);
    const confirmation = {
      session: 'hall-a', confirmedAt: '2026-11-16T08:30:00Z',
      registrations: ['P1:R1', 'P1:R2', 'P2:X9'], attendanceEvents: ['entry-1', 'entry-2'],
    };
    await settlements.confirm(confirmation);
    await attendance.merge([
      { eventId: 'entry-3', personRef: 'person-1', session: 'hall-a', at: '2026-11-16T11:30:00Z' },
    ]);
    const result = reconcileSettlement(await roster.load(), await attendance.load(),
      (await settlements.load()).confirmations[0], '2026-11-16T12:00:00Z');
    assert.ok(result.discrepancies.some((item) => item.code === 'attendance-after-confirmation' && item.eventId === 'entry-3'));
    assert.deepEqual(result.confirmed.attendanceEvents, ['entry-1', 'entry-2']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
