export const SOURCE = 'https://q.wildlifesanctuaryfca16.com/';
const AVAILABILITY = `${SOURCE}api/v1/bookings/availability`;
const OPEN = 'https://wildlifesanctuaryfca16.com/api/chiangdao/open';
export function isVisitDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === date && date >= '2026-11-16' && date <= '2027-02-12' && d.getUTCDay() !== 3;
}
export function createAvailabilityReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map(), failures = new Map(), pending = new Map();
  let blockedUntil = 0, nextRequest = 0, openCache;
  async function get(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) {
        blockedUntil = now() + 300000;
        throw new Error(`ต้นทางจำกัดการเข้าถึง (HTTP ${response.status}) พักการเรียกข้อมูล 5 นาที`);
      }
      throw new Error(`ต้นทางตอบ HTTP ${response.status}`);
    }
    return response.json();
  }
  return async function read(date) {
    if (!isVisitDate(date)) throw new Error('Invalid date');
    const cached = cache.get(date);
    if (cached && now() - cached.at < 300000) return { ...cached.result, cached: true };
    if (pending.has(date)) return pending.get(date);
    const failure = failures.get(date);
    if (failure && now() - failure.at < 60000) return failure.result;
    if (now() < blockedUntil) throw Object.assign(new Error('ต้นทางจำกัดการเข้าถึง กำลังพักการเรียกข้อมูล'), { status: 503 });
    if (pending.size || now() < nextRequest) throw Object.assign(new Error('กรุณารอสักครู่ก่อนตรวจวันถัดไป'), { status: 429 });
    nextRequest = now() + 1200;
    const task = (async () => {
      let bookingOpen = openCache && now() - openCache.at < 60000 ? openCache.value : null;
      try {
        if (bookingOpen === null) {
          try {
            const body = await get(OPEN);
            if (typeof body?.data?.q?.open === 'boolean') {
              bookingOpen = body.data.q.open;
              openCache = { at: now(), value: bookingOpen };
            }
          } catch (error) { if (now() < blockedUntil) throw error; }
        }
        const body = await get(`${AVAILABILITY}?date=${encodeURIComponent(date)}`), d = body?.data;
        if (body.success !== true || d?.date !== date || !Number.isInteger(d.available) || !Number.isInteger(d.capacity) || d.available < 0 || d.capacity < d.available) throw new Error('รูปแบบยอดจากต้นทางเปลี่ยนไปหรือข้อมูลไม่ครบ');
        const checkedAt = new Date(now()).toISOString();
        const result = { source: 'live', sourceUrl: SOURCE, bookingOpen, checkedAt, stale: false, cached: false, day: { date, available: d.available, capacity: d.capacity, status: d.available === 0 ? 'full' : d.available <= 10 ? 'low' : 'available', observedAt: checkedAt } };
        cache.set(date, { at: now(), result }); failures.delete(date);
        return result;
      } catch (error) {
        const result = { source: 'live', sourceUrl: SOURCE, bookingOpen, blocked: now() < blockedUntil, checkedAt: new Date(now()).toISOString(), stale: Boolean(cached), error: error.name === 'TimeoutError' ? 'ต้นทางตอบช้าเกินกำหนด' : error.message, day: cached?.result.day ?? { date, available: null, capacity: null, status: 'unknown', observedAt: null } };
        failures.set(date, { at: now(), result }); return result;
      }
    })();
    pending.set(date, task);
    try { return await task; } finally { pending.delete(date); }
  };
}
