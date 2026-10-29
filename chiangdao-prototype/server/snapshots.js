import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isVisitDate } from './availability.js';

export const MONTHS = ['2026-11', '2026-12', '2027-01', '2027-02'];
const TTL = 60000;
export function visitDates(month) {
  if (!MONTHS.includes(month)) return [];
  const [year, m] = month.split('-').map(Number);
  return Array.from({ length: new Date(year, m, 0).getDate() }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`).filter(isVisitDate);
}
export function createSnapshots({ read, path = null, now = Date.now, pause = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); }) }) {
  const records = {}, states = new Map(), queue = [], listeners = new Map();
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
      s.running = true; s.error = ''; emit(month);
      try {
        const staged = {}, dates = visitDates(month).filter(date => !fresh(date));
        for (let index = 0; index < dates.length && !closed; index += 3) {
          const started = now(), batch = dates.slice(index,index+3);
          const outcomes = await Promise.allSettled(batch.map(date => read(date)));
          if (closed) break;
          let blocked = false;
          for (let i=0;i<batch.length;i++) {
            const date=batch[i], outcome=outcomes[i];
            if (outcome.status === 'fulfilled') {
              const row=outcome.value;
              staged[date] = row.error && !row.day.observedAt && records[date]?.day.observedAt
                ? {...records[date],stale:true,error:row.error} : row;
              if(row.error) s.error=row.error;
              if(row.blocked) { blocked=true;globalRetryAt=Math.max(globalRetryAt,Date.parse(row.retryAt)||now()+300000); }
            } else {
              s.error=outcome.reason.message;
              staged[date]=records[date] ? {...records[date],stale:true,error:s.error} : {source:'live',stale:true,error:s.error,day:{date,available:null,capacity:null,status:'unknown',observedAt:null}};
              if(outcome.reason.status===503) {blocked=true;globalRetryAt=Math.max(globalRetryAt,now()+TTL);}
            }
          }
          if(blocked) { queue.length=0;break; }
          if(index+3<dates.length && !closed) await pause(Math.max(0,1250-(now()-started)));
        }
        if (!closed) {
          Object.assign(records,staged);
          if(now()<globalRetryAt) for(const [date,row] of Object.entries(records)) records[date]={...row,stale:true};
        }
        await persist();
      } finally {
        s.running = false;
        const observed = visitDates(month).map(date => Date.parse(records[date]?.day.observedAt)).filter(Number.isFinite);
        s.nextRefresh = s.error ? now() + TTL : Math.max(now() + 1000, Math.min(...observed) + TTL);
        emit(month);
      }
    }
  }
  const timer = setInterval(() => {
    for (const [month, s] of states) if (s.activeUntil > now() || listeners.get(month)?.size) schedule(month);
  }, 2000);
  timer.unref?.();
  async function get(month) {
    if (!MONTHS.includes(month)) throw new Error('Invalid month');
    await ready;
    const s = state(month);
    s.activeUntil = now() + 600000;
    schedule(month);
    return view(month);
  }
  function view(month) {
    const s = state(month), dates = visitDates(month);
    const rows = dates.filter(date => records[date]).map(date => ({ ...records[date], stale: !fresh(date) }));
    return { source: 'live', month, records: rows, loading: Boolean(s.running || queue.includes(month)), loaded: rows.filter(row => row.day.observedAt).length, total: dates.length, error: s.error || (now() < globalRetryAt ? 'ยังเชื่อมต่อต้นทางไม่ได้ กำลังพักก่อนลองใหม่' : ''), nextRefreshAt: s.nextRefresh ? new Date(Math.max(s.nextRefresh, globalRetryAt)).toISOString() : null };
  }
  function emit(month) { for (const listener of listeners.get(month) ?? []) listener(view(month)); }
  function subscribe(month, listener) {
    if (!listeners.has(month)) listeners.set(month, new Set());
    listeners.get(month).add(listener);
    return () => listeners.get(month)?.delete(listener);
  }
  return { get, subscribe, warm: month => get(month), settle: async () => { await ready; await worker; }, close: () => { closed = true; clearInterval(timer); queue.length = 0; listeners.clear(); } };
}
