import { effectiveState, billingGroups } from './roster-store.js';
import { billingKey } from './identity.js';

// 对账引擎：按场次与时点解释有效报名、取消与实际到场，并对照不可变的结算确认解释差异。
// 所有结论只基于传入的留痕集合；后到更正会形成新观察，但不会改写已经确认的依据。

function registrationIndex(registrations) {
  return new Map(registrations.map((registration) => [registration.key, registration]));
}

function snapshotRoster(document, session, asOf) {
  const { registrations } = effectiveState(document, asOf);
  return registrations.filter((registration) => registration.session === session);
}

function explainBillingDuplicates(registrations) {
  const discrepancies = [];
  for (const group of billingGroups(registrations).filter((item) => item.registrationKeys.length > 1)) {
    discrepancies.push({
      code: 'duplicate-billing-identity',
      billingKey: group.billingKey,
      registrationKeys: group.registrationKeys,
      message: `同一参会人在该场次存在 ${group.registrationKeys.length} 条有效报名，计费只能按一个身份结算一次`,
    });
  }
  return discrepancies;
}

// 单个场次在某时点的日报：有效报名、撤回、实际到场，以及身份层面的重复计费风险。
export function buildSessionReport(rosterDocument, attendanceDocument, session, asOf) {
  const registrations = snapshotRoster(rosterDocument, session, asOf);
  const attendance = attendanceDocument.events
    .filter((event) => event.session === session && Date.parse(event.at) <= Date.parse(asOf))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.eventId.localeCompare(right.eventId));
  const index = registrationIndex(registrations);
  const valid = registrations.filter((registration) => registration.valid);
  const cancelled = registrations.filter((registration) => registration.cancelled);
  const attendedPersonRefs = new Set(attendance.map((event) => event.personRef));
  const attendedWithoutValidRegistration = attendance.filter((event) =>
    !valid.some((registration) => registration.personRef === event.personRef));

  return {
    session,
    asOf,
    counts: {
      registrations: registrations.length,
      valid: valid.length,
      cancelled: cancelled.length,
      attendanceEvents: attendance.length,
      attendedPersons: attendedPersonRefs.size,
      billableIdentities: billingGroups(valid).length,
    },
    validRegistrations: valid.map((registration) => ({
      key: registration.key,
      personRef: registration.personRef,
      name: registration.name,
      revision: registration.revision,
      modifiedAt: registration.modifiedAt,
      observedAt: registration.observedAt,
    })),
    cancelledRegistrations: cancelled.map((registration) => ({
      key: registration.key,
      personRef: registration.personRef,
      name: registration.name,
      revision: registration.revision,
      modifiedAt: registration.modifiedAt,
      observedAt: registration.observedAt,
    })),
    attendance: attendance.map((event) => ({
      eventId: event.eventId,
      personRef: event.personRef,
      at: event.at,
      linkedRegistrationKeys: registrations
        .filter((registration) => registration.personRef === event.personRef)
        .map((registration) => registration.key)
        .sort(),
    })),
    discrepancies: [
      ...explainBillingDuplicates(registrations),
      ...attendedWithoutValidRegistration.map((event) => ({
        code: 'attendance-without-valid-registration',
        eventId: event.eventId,
        personRef: event.personRef,
        at: event.at,
        message: '现场签到找不到同时点的有效报名，签到事实保留但不能据此补计报名服务费',
      })),
    ],
  };
}

// 全量日报：可指定场次，也可按所有已观察场次汇总。
export function buildDailyReport(rosterDocument, attendanceDocument, asOf, sessionFilter = null) {
  const sessions = new Set();
  for (const registration of rosterDocument.observations) sessions.add(registration.session);
  for (const event of attendanceDocument.events) sessions.add(event.session);
  const orderedSessions = [...sessions].filter((session) => !sessionFilter || session === sessionFilter).sort();
  const reports = orderedSessions.map((session) => buildSessionReport(rosterDocument, attendanceDocument, session, asOf));
  return {
    asOf,
    sessions: reports,
    totals: reports.reduce((totals, report) => {
      for (const [field, value] of Object.entries(report.counts)) totals[field] = (totals[field] ?? 0) + value;
      return totals;
    }, {}),
  };
}

// 对照已确认结算依据：确认内容是快照，当前留痕只用于解释差异，不能回写确认。
export function reconcileSettlement(rosterDocument, attendanceDocument, confirmation, asOf) {
  const report = buildSessionReport(rosterDocument, attendanceDocument, confirmation.session, asOf);
  const current = registrationIndex(snapshotRoster(rosterDocument, confirmation.session, asOf));
  const confirmedAt = confirmation.confirmedAt;
  const discrepancies = [];

  for (const key of confirmation.registrations) {
    const registration = current.get(key);
    if (!registration) {
      discrepancies.push({ code: 'confirmed-registration-missing', registrationKey: key,
        message: '已确认报名在当前名单观察中缺席；页面缺席不等于撤回，仍以确认依据为准' });
      continue;
    }
    if (registration.cancelled && Date.parse(registration.observedAt) > Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'cancelled-after-confirmation', registrationKey: key,
        cancelledObservedAt: registration.observedAt,
        message: '撤回发生在结算确认之后，确认依据不变，差异单独列示' });
    }
    if (registration.valid && Date.parse(registration.modifiedAt) > Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'revised-after-confirmation', registrationKey: key,
        latestRevision: registration.revision, latestModifiedAt: registration.modifiedAt,
        message: '确认后报名被修订（如改名），身份关联不变，确认依据不被改写' });
    }
    const confirmedObservation = rosterDocument.observations
      .filter((item) => item.key === key && Date.parse(item.observedAt) <= Date.parse(confirmedAt))
      .at(-1);
    if (confirmedObservation && registration.name !== confirmedObservation.name) {
      discrepancies.push({ code: 'renamed-after-confirmation', registrationKey: key,
        confirmedName: confirmedObservation.name, currentName: registration.name, personRef: registration.personRef,
        message: '确认后发生改名，personRef 证明是同一参会人，不得按新名字重复计费' });
    }
  }
  for (const registration of report.validRegistrations) {
    if (!confirmation.registrations.includes(registration.key)
      && Date.parse(registration.observedAt) <= Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'valid-registration-not-in-confirmation', registrationKey: registration.key,
        personRef: registration.personRef,
        message: '确认时点已存在的有效报名未进入结算依据，需要人工解释而不是静默补账' });
    }
    if (!confirmation.registrations.includes(registration.key)
      && Date.parse(registration.observedAt) > Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'registered-after-confirmation', registrationKey: registration.key,
        personRef: registration.personRef, observedAt: registration.observedAt,
        message: '结算确认后补录的报名，不改变已确认依据，进入下一结算周期' });
    }
  }

  const currentEvents = new Set(report.attendance.map((event) => event.eventId));
  for (const eventId of confirmation.attendanceEvents) {
    if (!currentEvents.has(eventId)) {
      discrepancies.push({ code: 'confirmed-attendance-missing', eventId,
        message: '已确认的签到事件在当前留痕中缺席，以确认依据为准' });
    }
  }
  for (const event of report.attendance) {
    if (!confirmation.attendanceEvents.includes(event.eventId) && Date.parse(event.at) <= Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'attendance-not-in-confirmation', eventId: event.eventId,
        message: '确认时点已发生的签到未进入结算依据，需要人工解释' });
    }
    if (!confirmation.attendanceEvents.includes(event.eventId) && Date.parse(event.at) > Date.parse(confirmedAt)) {
      discrepancies.push({ code: 'attendance-after-confirmation', eventId: event.eventId, at: event.at,
        message: '确认后到达的签到记录，不改变已确认依据' });
    }
  }
  discrepancies.push(...report.discrepancies);

  return {
    settlementId: confirmation.settlementId,
    session: confirmation.session,
    confirmedAt,
    asOf,
    confirmed: {
      registrations: confirmation.registrations,
      attendanceEvents: confirmation.attendanceEvents,
    },
    currentCounts: report.counts,
    discrepancies,
    report,
  };
}
