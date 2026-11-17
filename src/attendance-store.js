import { JsonStateStore } from './state-store.js';
import { personKey } from './identity.js';

// 现场签到是独立事实来源：单独文件留存，名单修订不会改写签到，签到也不会回写报名状态。
export function normalizeAttendanceEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('attendance event must be an object');
  }
  const eventId = String(input.eventId ?? '').trim();
  const personRef = String(input.personRef ?? '').trim();
  const session = String(input.session ?? '').trim();
  const at = String(input.at ?? '').trim();
  if (!eventId) throw new Error('missing eventId for attendance event');
  if (!personRef) throw new Error(`missing personRef for attendance event ${eventId}`);
  if (!session) throw new Error(`missing session for attendance event ${eventId}`);
  if (!Number.isFinite(Date.parse(at))) throw new Error(`invalid at for attendance event ${eventId}`);
  return { eventId, personRef: personKey(personRef), session, at };
}

export class AttendanceStore {
  constructor(path) {
    this.store = new JsonStateStore(path, { events: [] });
  }

  // 按 eventId 幂等合并；后到的同 eventId 事件不能覆盖已经留存的现场事实。
  async merge(rawEvents) {
    const normalized = rawEvents.map(normalizeAttendanceEvent);
    return this.store.mutate((document) => {
      let added = 0;
      for (const event of normalized) {
        if (!document.events.some((known) => known.eventId === event.eventId)) {
          document.events.push(event);
          added += 1;
        }
      }
      document.events.sort((left, right) =>
        Date.parse(left.at) - Date.parse(right.at) || left.eventId.localeCompare(right.eventId));
      return { added, received: normalized.length, stored: document.events.length };
    });
  }

  async load() { return this.store.load(); }

  async eventsAt(asOf) {
    const limit = Date.parse(asOf);
    if (!Number.isFinite(limit)) throw new Error(`invalid asOf: ${asOf}`);
    const document = await this.store.load();
    return document.events.filter((event) => Date.parse(event.at) <= limit);
  }
}
