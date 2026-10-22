// Changes carry a baseline version. Concurrent edits preserve both values;
// a concurrent deletion never destroys the other device's edit.
export function mergeEntries(remoteEntries, localEntries, pending) {
  const entries = new Map(remoteEntries.map(item => [item.id, { ...item }]));
  const local = new Map(localEntries.map(item => [item.id, item]));
  let conflicts = 0;
  for (const [id, change] of Object.entries(pending)) {
    const ours = local.get(id);
    if (!ours) throw new Error('Incomplete local vault.');
    const theirs = entries.get(id);
    if (theirs?.version === ours.version || entries.get(ours.version)?.version === ours.version) continue;
    if ((theirs?.version ?? null) === change.baseVersion) {
      entries.set(id, { ...ours });
    } else {
      conflicts++;
      if (!ours.deleted) {
        // The mutation UUID is a deterministic copy ID, making retries idempotent.
        const copyId = ours.version;
        entries.set(copyId, { ...ours, id: copyId, name: `${ours.name} (conflict copy)` });
      }
    }
  }
  return { entries: [...entries.values()], conflicts };
}

export function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 10_000) throw new Error('Invalid vault contents.');
  const ids = new Set();
  for (const item of entries) {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.version !== 'string'
      || typeof item.name !== 'string' || typeof item.value !== 'string' || typeof item.kind !== 'string'
      || (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 2000))
      || typeof item.deleted !== 'boolean' || typeof item.updatedAt !== 'string') throw new Error('Invalid vault item.');
    ids.add(item.id);
  }
  return entries;
}
