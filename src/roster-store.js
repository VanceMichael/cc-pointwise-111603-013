import { JsonStateStore } from './state-store.js';
import { billingKey, personKey, registrationKey } from './identity.js';

// 合作方名单的本地留痕模型：
// - observations 只追加，记录每次来源观察到的报名快照（补录、改名、撤回都成为新观察，不覆盖旧观察）；
// - batches 记录完整采集批次，页面缺席通过批次的 missingKeys 留痕，缺席本身不改变有效报名状态；
// - 只有来源明确给出 status=cancelled 才是撤回证据。

const rosterFields = ['registrationId', 'partner', 'session', 'personRef', 'name', 'revision', 'status', 'modifiedAt'];

function requireString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`missing ${field} for roster observation`);
  return text;
}

export function normalizeObservation(input, fallback = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('roster observation must be an object');
  }
  const attributes = input.attributes && typeof input.attributes === 'object' && !Array.isArray(input.attributes)
    ? structuredClone(input.attributes) : structuredClone(input);
  const partner = requireString(attributes.partner, 'partner');
  const registrationId = requireString(attributes.registrationId, 'registrationId');
  const personRef = requireString(attributes.personRef, 'personRef');
  const session = requireString(attributes.session, 'session');
  const name = requireString(attributes.name, 'name');
  const status = requireString(attributes.status, 'status');
  const revision = Number(attributes.revision);
  if (!Number.isFinite(revision)) throw new Error(`invalid revision for ${registrationKey(partner, registrationId)}`);
  const modifiedAt = requireString(attributes.modifiedAt, 'modifiedAt');
  if (!Number.isFinite(Date.parse(modifiedAt))) throw new Error(`invalid modifiedAt for ${registrationKey(partner, registrationId)}`);
  const observedAt = requireString(input.observedAt ?? fallback.observedAt ?? modifiedAt, 'observedAt');
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error(`invalid observedAt for ${registrationKey(partner, registrationId)}`);
  return {
    key: registrationKey(partner, registrationId),
    personRef,
    session,
    name,
    status,
    revision,
    modifiedAt,
    observedAt,
    batchId: fallback.batchId ?? input.batchId ?? null,
    attributes: Object.fromEntries(rosterFields.map((field) => [field, attributes[field] ?? null])),
  };
}

function sameObservation(left, right) {
  return left.revision === right.revision && left.status === right.status
    && left.name === right.name && left.modifiedAt === right.modifiedAt
    && left.session === right.session && left.personRef === right.personRef;
}

export class RosterStore {
  constructor(path) {
    this.store = new JsonStateStore(path, { observations: [], batches: [] });
  }

  // 追加一批观察。同一报名同内容观察重复采集是幂等的；改名/换状态/升版本则保留为新条目。
  async appendObservations(rawObservations, batch = {}) {
    const normalized = rawObservations.map((item) => normalizeObservation(item, batch));
    return this.store.mutate((document) => {
      let added = 0;
      for (const observation of normalized) {
        const known = document.observations.filter((item) => item.key === observation.key);
        if (!known.some((item) => sameObservation(item, observation))) {
          document.observations.push(observation);
          added += 1;
        }
      }
      const batchId = batch.batchId ?? null;
      const seenKeys = [...new Set(normalized.map((item) => item.key))].sort();
      // 缺席判断只在同一合作方命名空间内比较，避免把其他合作方的报名误记为缺席。
      const partnerPrefix = batch.partner ? `${batch.partner}:` : null;
      const knownKeys = [...new Set(document.observations
        .filter((item) => !partnerPrefix || item.key.startsWith(partnerPrefix))
        .map((item) => item.key))];
      const missingKeys = knownKeys.filter((key) => !seenKeys.includes(key)).sort();
      if (batchId) {
        document.batches.push({
          batchId,
          partner: batch.partner ?? null,
          path: batch.path ?? null,
          observedAt: batch.observedAt ?? null,
          etag: batch.etag ?? null,
          seenKeys,
          missingKeys,
        });
      }
      document.observations.sort((left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt)
        || left.key.localeCompare(right.key)
        || left.revision - right.revision);
      return { added, received: normalized.length, missingKeys, batchId };
    });
  }

  async load() { return this.store.load(); }

  // 某时点的报名视图：取 observedAt <= asOf 内每个报名的最新观察；
  // 页面缺席不参与决策，只有最新观察 status=cancelled 才视为已撤回。
  async effectiveAt(asOf) {
    return effectiveState(await this.store.load(), asOf);
  }

  async latest() {
    const document = await this.store.load();
    if (!document.observations.length) return { asOf: null, registrations: [] };
    const asOf = document.observations.reduce((max, item) =>
      (Date.parse(item.observedAt) > Date.parse(max) ? item.observedAt : max), document.observations[0].observedAt);
    return effectiveState(document, asOf);
  }
}

export function effectiveState(document, asOf) {
  const limit = Date.parse(asOf);
  if (!Number.isFinite(limit)) throw new Error(`invalid asOf: ${asOf}`);
  const latest = new Map();
  for (const observation of document.observations) {
    if (Date.parse(observation.observedAt) > limit) continue;
    const current = latest.get(observation.key);
    if (!current || Date.parse(observation.observedAt) >= Date.parse(current.observedAt)) {
      latest.set(observation.key, observation);
    }
  }
  const registrations = [...latest.values()]
    .map((observation) => ({
      ...structuredClone(observation),
      valid: observation.status !== 'cancelled',
      cancelled: observation.status === 'cancelled',
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  return { asOf, registrations };
}

// 同一 personRef 在同一 session 出现多条有效报名（合作方之间或改名后），计费去重只保留一组。
export function billingGroups(registrations) {
  const groups = new Map();
  for (const registration of registrations) {
    if (!registration.valid) continue;
    const key = billingKey(personKey(registration.personRef), registration.session);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(registration.key);
  }
  return [...groups.entries()]
    .map(([key, registrationKeys]) => ({ billingKey: key, registrationKeys: registrationKeys.sort() }))
    .sort((left, right) => left.billingKey.localeCompare(right.billingKey));
}
