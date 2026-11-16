export const entryPath = "/partners/P1/roster";

export function parsePage(response) {
  const items = [...response.text.matchAll(/<script type="application\/json" class="source-record">([\s\S]*?)<\/script>/g)]
    .map((match) => JSON.parse(match[1]));
  if (!items.length) throw new Error('source layout contains no records');
  const next = response.text.match(/rel="next" href="([^"]+)"/)?.[1] ?? null;
  return { next, records: items.map((item) => ({
    sourceId: String(item["registrationId"]),
    source: "展会报名同步台",
    observedAt: item["modifiedAt"],
    label: String(item["name"]),
    attributes: structuredClone(item),
  })) };
}
