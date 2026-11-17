import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/server.js';
import { SourceClient } from './source-client.js';
import { RosterStore } from './roster-store.js';
import { AttendanceStore } from './attendance-store.js';
import { SettlementStore } from './settlement-store.js';
import { collectRoster } from './collector.js';
import { buildSessionReport, reconcileSettlement } from './reconciliation.js';

// 端到端演示：合作方名单采集留痕 → 现场签到独立留存 → 按身份归并的时点日报
// → 不可变结算确认 → 确认后改名/缺席/撤回/补录 → 对账解释差异。
const lifecycle = await startSource(new URL('../fixtures/source-lifecycle.json', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'reconciliation-demo-'));
const clock = {
  opening: '2026-11-16T08:05:00Z', renamed: '2026-11-16T09:30:00Z',
  missing: '2026-11-16T09:45:00Z', withdrawn: '2026-11-16T10:30:00Z', backfilled: '2026-11-16T11:00:00Z',
};
try {
  const roster = new RosterStore(join(directory, 'roster.json'));
  const attendance = new AttendanceStore(join(directory, 'attendance.json'));
  const settlements = new SettlementStore(join(directory, 'settlements.json'));
  const client = new SourceClient(lifecycle.url);
  const etagCache = new Map();

  await collectRoster(client, roster, { partners: ['P1', 'P2'], now: clock.opening, etagCache });
  await attendance.merge([
    { eventId: 'entry-1', personRef: 'person-1', session: 'hall-a', at: '2026-11-16T08:10:00Z' },
    { eventId: 'entry-2', personRef: 'person-2', session: 'hall-a', at: '2026-11-16T08:12:00Z' },
  ]);

  const confirmedAt = '2026-11-16T08:30:00Z';
  const report = buildSessionReport(await roster.load(), await attendance.load(), 'hall-a', confirmedAt);
  const confirmation = {
    session: 'hall-a', confirmedAt,
    registrations: report.validRegistrations.map((row) => row.key),
    attendanceEvents: ['entry-1', 'entry-2'],
  };
  await settlements.confirm(confirmation);

  for (const stage of ['renamed', 'missing', 'withdrawn', 'backfilled']) {
    lifecycle.publish(stage);
    await collectRoster(client, roster, { partners: ['P1', 'P2'], now: clock[stage], etagCache });
  }

  const basis = (await settlements.load()).confirmations[0];
  const result = reconcileSettlement(
    await roster.load(), await attendance.load(), basis, '2026-11-16T12:00:00Z');
  console.log(JSON.stringify({
    结算时点: confirmedAt,
    确认报名: basis.registrations,
    确认签到: basis.attendanceEvents,
    确认时计费身份数: report.counts.billableIdentities,
    当前有效报名: result.report.counts.valid,
    当前撤回: result.report.counts.cancelled,
    实际到场人次: result.report.counts.attendanceEvents,
    差异解释: result.discrepancies.map((item) => ({ code: item.code, ...item })),
  }, null, 2));
} finally {
  await lifecycle.close();
  await rm(directory, { recursive: true, force: true });
}
