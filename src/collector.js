import { parseRosterPage, partnerRosterPath } from './adapter.js';

// 名单采集器：遍历合作方入口与 rel=next 分页，逐页解析并追加到可追溯的名单留痕。
// - 每个合作方形成独立批次，批次记录 seenKeys/missingKeys，页面缺席留痕但不触发撤回；
// - ETag/304 表示来源未变化，跳过解析、不制造新观察；
// - 某合作方失败时显式报错，其他合作方的已采集结果不回滚，失败本身在结果中可见。
export async function collectRoster(client, rosterStore, options = {}) {
  const partners = options.partners ?? ['P1'];
  const now = options.now ?? new Date().toISOString();
  // ETag 记忆可以跨采集调用复用（由调用方持有），未传则退化为单次采集内记忆。
  const etagCache = options.etagCache ?? new Map();
  const results = [];
  for (const partner of partners) {
    const batchId = options.batchIdFactory
      ? options.batchIdFactory(partner)
      : `batch-${partner}-${now.replace(/[:.]/g, '-')}`;
    let path = partnerRosterPath(partner);
    const pageRecords = [];
    const pages = [];
    let etag = etagCache.get(partner) ?? null;
    let notModified = false;
    while (path) {
      const response = await client.read(path, etag ? { etag } : {});
      if (response.notModified) {
        pages.push({ path, notModified: true });
        notModified = true;
        break;
      }
      etag = response.etag ?? etag;
      const page = parseRosterPage(response);
      pageRecords.push(...page.records);
      pages.push({ path, records: page.records.length, next: page.next });
      path = page.next;
    }
    if (notModified) {
      // 来源未变化：不制造观察，也不制造"全缺席"批次。
      results.push({ partner, batchId, pages, added: 0, received: 0, missingKeys: [], notModified: true });
      continue;
    }
    if (etag) etagCache.set(partner, etag);
    const stored = await rosterStore.appendObservations(pageRecords, {
      batchId, partner, path: partnerRosterPath(partner), observedAt: now, etag,
    });
    results.push({ partner, batchId, pages, ...stored });
  }
  return { collectedAt: now, partners: results };
}
