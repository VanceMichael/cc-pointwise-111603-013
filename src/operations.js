const fields = ["registrationId", "partner", "session", "personRef", "name", "revision", "status", "modifiedAt"];

export async function readOperations(repository) {
  const records = await repository.read();
  return { product: "展会报名同步台", rows: records.map((record) => ({
    sourceId: record.sourceId,
    source: record.source,
    observedAt: record.observedAt,
    attributes: Object.fromEntries(fields.map((field) => [field, record.attributes[field] ?? null])),
  })) };
}

// 新业务读取入口：名单修订、本地签到、结算确认三类留痕保持各自独立，
// 日报只做时点解释，不回写任何来源。asOf 缺省取当前时间，测试可注入固定时钟。
export async function readLedger(stores, options = {}) {
  const asOf = options.asOf ?? new Date().toISOString();
  const [roster, attendance, settlements] = await Promise.all([
    stores.roster.load(),
    stores.attendance.load(),
    stores.settlements.load(),
  ]);
  const { buildDailyReport } = await import('./reconciliation.js');
  return {
    product: "展会报名同步台",
    asOf,
    report: buildDailyReport(roster, attendance, asOf, options.session ?? null),
    settlementConfirmations: settlements.confirmations,
    rosterBatches: roster.batches,
  };
}
