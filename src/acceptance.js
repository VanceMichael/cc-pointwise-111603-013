import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { parsePage, entryPath } from './adapter.js';
import { RecordRepository } from './repository.js';
import { CollectionService } from './service.js';
import { readOperations, readLedger } from './operations.js';
import { RosterStore } from './roster-store.js';
import { AttendanceStore } from './attendance-store.js';
import { SettlementStore } from './settlement-store.js';
import { collectRoster } from './collector.js';
import { reconcileSettlement, buildSessionReport } from './reconciliation.js';

const source = await startSource(new URL('../fixtures/source.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'collection-acceptance-'));
try {
  // —— 既有基线：首批来源读取、结构化导入、重启回读、重放、业务查询 ——
  const page = parsePage(await new SourceClient(source.url).read(entryPath));
  assert.ok(page.records.length > 0, '初始来源须有可接收的业务记录');
  const path = join(directory, 'records.json');
  const repository = new RecordRepository(path);
  const first = await new CollectionService(repository).ingest(page.records);
  assert.equal(first.accepted, page.records.length);
  const stored = await repository.read();
  const reopened = new RecordRepository(path);
  assert.deepEqual(await new CollectionService(reopened).query({}), stored, '重新打开后读取同一份业务记录');
  const second = await new CollectionService(reopened).ingest(page.records);
  assert.equal(second.stored, stored.length, '重放首批记录不重复保存');
  const operations = await readOperations(reopened);
  assert.deepEqual(operations.rows.map(row => row.sourceId), stored.map(row => row.sourceId));

  // —— 可追溯结算对账：名单留痕、签到独立留存、身份归并、不可变确认、时点日报 ——
  await source.close();
  const lifecycle = await startSource(new URL('../fixtures/source-lifecycle.json', import.meta.url));
  const roster = new RosterStore(join(directory, 'roster.json'));
  const attendance = new AttendanceStore(join(directory, 'attendance.json'));
  const settlements = new SettlementStore(join(directory, 'settlements.json'));
  const etagCache = new Map();
  await collectRoster(new SourceClient(lifecycle.url), roster, {
    partners: ['P1', 'P2'], now: '2026-11-16T08:05:00Z', etagCache,
  });
  await attendance.merge([
    { eventId: 'entry-1', personRef: 'person-1', session: 'hall-a', at: '2026-11-16T08:10:00Z' },
    { eventId: 'entry-2', personRef: 'person-2', session: 'hall-a', at: '2026-11-16T08:12:00Z' },
  ]);

  // 08:30 确认结算依据：两个合作方对 person-1 的报名只归并为一个计费身份。
  const confirmedAt = '2026-11-16T08:30:00Z';
  const reportAtConfirmation = buildSessionReport(await roster.load(), await attendance.load(), 'hall-a', confirmedAt);
  assert.equal(reportAtConfirmation.counts.billableIdentities, 2, '同一 personRef 跨合作方不重复计费');
  const confirmation = {
    session: 'hall-a', confirmedAt,
    registrations: reportAtConfirmation.validRegistrations.map((row) => row.key),
    attendanceEvents: ['entry-1', 'entry-2'],
  };
  await settlements.confirm(confirmation);

  // 确认后来源发生改名、页面缺席、撤回、补录；已确认依据保持不变。
  for (const [stage, clock] of [
    ['renamed', '2026-11-16T09:30:00Z'],
    ['missing', '2026-11-16T09:45:00Z'],
    ['withdrawn', '2026-11-16T10:30:00Z'],
    ['backfilled', '2026-11-16T11:00:00Z'],
  ]) {
    lifecycle.publish(stage);
    await collectRoster(new SourceClient(lifecycle.url), roster, {
      partners: ['P1', 'P2'], now: clock, etagCache,
    });
  }
  const basis = (await settlements.load()).confirmations[0];
  assert.deepEqual(basis.registrations, confirmation.registrations, '后到更正不改变已确认依据');
  const reconciliation = reconcileSettlement(
    await roster.load(), await attendance.load(), basis, '2026-11-16T12:00:00Z');
  const codes = reconciliation.discrepancies.map((item) => item.code);
  assert.ok(codes.includes('cancelled-after-confirmation'));
  assert.ok(codes.includes('renamed-after-confirmation'));
  assert.ok(codes.includes('registered-after-confirmation'));
  assert.ok(!codes.some((code) => code === 'confirmed-registration-missing'), '页面缺席不抹除已确认报名');
  await assert.rejects(settlements.confirm({ ...confirmation, registrations: ['P1:R1'] }),
    /already confirmed and cannot be rewritten/, '结算确认不可被重写');

  const ledger = await readLedger({ roster, attendance, settlements }, { asOf: '2026-11-16T12:00:00Z' });
  assert.equal(ledger.report.sessions.length, 1);
  assert.equal(ledger.settlementConfirmations.length, 1);

  await lifecycle.close();
  console.log(JSON.stringify({
    accepted: first.accepted, persisted: stored.length, replayStored: second.stored,
    operationRows: operations.rows.length,
    confirmedRegistrations: basis.registrations.length,
    discrepancyKinds: [...new Set(codes)],
    status: 'ok',
  }));
} finally {
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
