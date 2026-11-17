// 跨来源身份约定：
// registrationKey 是合作方命名空间内的报名身份（同一 registrationId 在不同合作方不是同一报名）；
// personKey 是明确提供的参会人关联号，改名不产生新人；
// billingKey 是同一场次内的计费去重单位，用于发现同一人换名字重复计费。

export function registrationKey(partner, registrationId) {
  return `${partner}:${registrationId}`;
}

export function parseRegistrationKey(key) {
  const separator = key.indexOf(':');
  if (separator < 0) throw new Error(`invalid registration key: ${key}`);
  return { partner: key.slice(0, separator), registrationId: key.slice(separator + 1) };
}

export function personKey(personRef) {
  return String(personRef);
}

export function billingKey(personRef, session) {
  return `${personRef}@${session}`;
}
