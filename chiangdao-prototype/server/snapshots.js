import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isVisitDate } from './availability.js';

export const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02'];
const TTL = 300000;
export function visitDates(month) {
  if (!MONTHS.includes(month)) return [];
  const [year, m] = month.split('-').map(Number);
  return Array.from({ length: new Date(year, m, 0).getDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).filter(isVisitDate);
}
export function createSnapshots({ read, path = null, now = Date.now, pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) }) {
  const records = {}, states = new Map(), queue = [];
  let worker = null, closed = false, globalRetryAt = 0;
  const state = month => {
    if (!states.has(month)) states.set(month, { activeUntil: 0, nextRefresh: 0, error: '' });
    return states.get(month);
  };
  const ready = (async () => {
    if (!path) return;
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (saved.version !== 1) return;
      for (const [date, row] of Object.entries(saved.records ?? {})) {
        const d = row?.day, observed = Date.parse(d?.observedAt);
        if (isVisitDate(date) && row.source === 'live' && d?.date === date && Number.isInteger(d.available) && d.available >= 0 && Number.isInteger(d.capacity) && d.capacity >= d.available && Number.isFinite(observed) && observed <= now()) records[date] = row;
      }
    } catch (error) { if (error.code !== 'ENOENT') console.warn('Snapshot cache could not be read; live refresh will rebuild it.'); }
  })();
  async function persist() {
    if (!path) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(`${path}.tmp`, JSON.stringify({ version: 1, records }), 'utf8');
      await rename(`${path}.tmp`, path);
    } catch { console.warn('Snapshot cache could not be saved; in-memory data remains available.'); }
  }
  function fresh(date) {
    const row = records[date];
    return row && !row.stale && !row.error && now() - Date.parse(row.day.observedAt) < TTL;
  }
  function schedule(month) {
    const s = state(month);
    if (closed || now() < globalRetryAt || now() < s.nextRefresh || queue.includes(month) || s.running) return;
    if (visitDates(month).every(fresh)) return;
    queue.push(month);
    if (!worker) worker = run().finally(() => { worker = null; });
  }
  async function run() {
    await ready;
    while (queue.length && !closed) {
      const month = queue.shift(), s = state(month);
      if (now() < globalRetryAt) break;
      s.running = true; s.error = '';
      try {
        for (const date of visitDates(month)) {
          if (closed || fresh(date)) continue;
          try {
            const row = await read(date);
            if (closed) break;
            // Preserve a persisted last good value if the fresh process cannot read this day.
            records[date] = row.error && !row.day.observedAt && records[date]?.day.observedAt
              ? { ...records[date], stale: true, error: row.error } : row;
            if (row.error) s.error = row.error;
            if (row.blocked) { globalRetryAt = now() + TTL; queue.length = 0; break; }
          } catch (error) {
            s.error = error.message;
            if (records[date]) records[date] = { ...records[date], stale: true, error: error.message };
            if (error.status === 503) { globalRetryAt = now() + TTL; queue.length = 0; break; }
          }
          if (!closed) await pause(1500);
        }
        await persist();
      } finally { s.running = false; s.nextRefresh = now() + TTL; }
    }
  }
  const timer = setInterval(() => {
    for (const [month, s] of states) if (s.activeUntil > now()) schedule(month);
  }, 10000);
  timer.unref?.();
  async function get(month) {
    if (!MONTHS.includes(month)) throw new Error('Invalid month');
    await ready;
    const s = state(month);
    s.activeUntil = now() + 600000;
    schedule(month);
    const dates = visitDates(month);
    const rows = dates.filter(date => records[date]).map(date => ({ ...records[date], stale: !fresh(date) }));
    return { source: 'live', month, records: rows, loading: Boolean(s.running || queue.includes(month)), loaded: rows.filter(row => row.day.observedAt).length, total: dates.length, error: s.error, nextRefreshAt: s.nextRefresh ? new Date(Math.max(s.nextRefresh, globalRetryAt)).toISOString() : null };
  }
  return { get, warm: month => get(month), settle: async () => { await ready; await worker; }, close: () => { closed = true; clearInterval(timer); queue.length = 0; } };
}
