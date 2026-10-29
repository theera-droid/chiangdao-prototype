const KEY = 'chiangdao:last-known:v1';
export function restore(storage, now = Date.now()) {
  try {
    const data = JSON.parse(storage.getItem(KEY) || '{}'), result = {};
    for (const [date,row] of Object.entries(data)) {
      const day = row?.day, at = Date.parse(day?.observedAt);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && day?.date === date && row.source === 'live' && Number.isFinite(at) && at <= now && Number.isInteger(day.available) && day.available >= 0 && Number.isInteger(day.capacity) && day.capacity >= day.available && ['full','low','available'].includes(day.status)) result[date] = { ...row, stale: true };
    }
    return result;
  } catch { return {}; }
}
export function save(storage, records) {
  try { storage.setItem(KEY, JSON.stringify(records)); } catch { /* Storage is optional. */ }
}
