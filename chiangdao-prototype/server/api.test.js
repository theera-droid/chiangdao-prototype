import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.js';
import { createAvailabilityReader, isVisitDate } from './availability.js';
test('valid dates exclude Wednesdays, invalid dates and off-season', () => {
  assert(isVisitDate('2026-11-16'));
  for (const value of ['2026-11-18', '2027-02-13', '2026-11-31', '../', undefined]) assert(!isVisitDate(value));
});
test('live response, cache, stale fallback, and unknown are distinct', async () => {
  let time = Date.now(), mode = 'ok', calls = 0;
  const read = createAvailabilityReader({ now: () => time, fetchImpl: async url => {
    calls++;
    if (url.includes('/chiangdao/open')) return Response.json({ data: { q: { open: false } } });
    if (mode === 'fail') throw new Error('offline');
    return Response.json({ success: true, data: { date: new URL(url).searchParams.get('date'), available: mode === 'bad' ? null : 0, capacity: 100 } });
  } });
  const first = await read('2026-11-16');
  assert.equal(first.day.status, 'full'); assert.equal(first.bookingOpen, false);
  assert.equal((await read('2026-11-16')).cached, true); assert.equal(calls, 2);
  time += 301000; mode = 'fail';
  const stale = await read('2026-11-16');
  assert.equal(stale.stale, true); assert.equal(stale.day.observedAt, first.day.observedAt);
  time += 61000; mode = 'bad';
  const unknown = await read('2026-11-17');
  assert.equal(unknown.day.available, null); assert.equal(unknown.day.status, 'unknown');
});
test('access denial backs off', async () => {
  let calls = 0;
  const read = createAvailabilityReader({ fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  assert.match((await read('2026-11-16')).error, /403/);
  await assert.rejects(read('2026-11-17')); assert.equal(calls, 1);
});
test('API validates dates and exposes only read route', async () => {
  const app = createApp({ snapshotPath: null, fetchImpl: async url => Response.json(url.includes('/chiangdao/open') ? { data: { q: { open: true } } } : { success: true, data: { date: '2026-11-16', available: 8, capacity: 100 } }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/availability?date=bad`)).status, 400);
    const result = await (await fetch(`${base}/api/availability?date=2026-11-16`)).json();
    assert.equal(result.day.available, 8);
    assert.equal((await fetch(`${base}/api/demo/refresh`, { method: 'POST' })).status, 404);
  } finally { app.locals.close(); await new Promise(resolve => server.close(resolve)); }
});
