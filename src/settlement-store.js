import { JsonStateStore } from './state-store.js';

// 已确认结算依据是不可变记录：确认后名单补录、改名、撤回、迟到更正都不能悄悄改写它。
// 重新提交同一 (session, confirmedAt) 必须与原确认完全一致，否则显式报错。
export function normalizeSettlement(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('settlement confirmation must be an object');
  }
  const session = String(input.session ?? '').trim();
  const confirmedAt = String(input.confirmedAt ?? '').trim();
  if (!session) throw new Error('missing session for settlement confirmation');
  if (!Number.isFinite(Date.parse(confirmedAt))) throw new Error('invalid confirmedAt for settlement confirmation');
  const registrations = [...new Set((input.registrations ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
  const attendanceEvents = [...new Set((input.attendanceEvents ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
  return {
    settlementId: `${session}@${confirmedAt}`,
    session,
    confirmedAt,
    registrations,
    attendanceEvents,
  };
}

export class SettlementStore {
  constructor(path) {
    this.store = new JsonStateStore(path, { confirmations: [] });
  }

  async confirm(rawSettlement) {
    const settlement = normalizeSettlement(rawSettlement);
    return this.store.mutate((document) => {
      const known = document.confirmations.find((item) => item.settlementId === settlement.settlementId);
      if (known) {
        if (JSON.stringify(known) !== JSON.stringify(settlement)) {
          throw new Error(`settlement ${settlement.settlementId} already confirmed and cannot be rewritten`);
        }
        return { added: false, settlement: structuredClone(known) };
      }
      document.confirmations.push(settlement);
      document.confirmations.sort((left, right) =>
        left.session.localeCompare(right.session) || Date.parse(left.confirmedAt) - Date.parse(right.confirmedAt));
      return { added: true, settlement: structuredClone(settlement) };
    });
  }

  async load() { return this.store.load(); }

  async find(session, confirmedAt) {
    const document = await this.store.load();
    return document.confirmations.find((item) => item.session === session && item.confirmedAt === confirmedAt) ?? null;
  }
}
