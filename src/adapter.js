export const entryPath = "/partners/P1/roster";

// 合作方入口按伙伴编号生成；来源协议保持兼容，采集端负责遍历多个合作方。
export function partnerRosterPath(partner) {
  return `/partners/${partner}/roster`;
}

const recordPattern = /<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g;

// 名单允许整页缺席（空页不报错）：缺席不是撤回，只是本批次没有观察到记录。
export function parseRosterPage(response) {
  const items = [...response.text.matchAll(recordPattern)].map((match) => JSON.parse(match[1]));
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["registrationId"]),
    source: "展会报名同步台",
    observedAt: item["modifiedAt"],
    label: String(item["name"]),
    attributes: structuredClone(item),
  })) };
}

// 兼容首批导入：首批页面必须至少有一条记录，否则视为来源结构异常。
export function parsePage(response) {
  const parsed = parseRosterPage(response);
  if (!parsed.records.length) throw new Error('source layout contains no records');
  return parsed;
}
