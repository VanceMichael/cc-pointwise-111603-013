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
