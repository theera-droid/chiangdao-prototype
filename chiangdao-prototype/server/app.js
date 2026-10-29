import express from 'express';
import { fileURLToPath } from 'node:url';
import { createAvailabilityReader, isVisitDate } from './availability.js';
import { createSnapshots, MONTHS } from './snapshots.js';
export function createApp(options = {}) {
  const app = express();
  const read = createAvailabilityReader(options);
  const snapshots = createSnapshots({ read, pause: options.snapshotPause, path: options.snapshotPath === undefined ? fileURLToPath(new URL('../.cache/availability.json', import.meta.url)) : options.snapshotPath });
  const streams = new Set();
  app.locals.close = () => { for (const res of streams) res.end(); snapshots.close(); };
  app.locals.warm = () => snapshots.warm(MONTHS[0]);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/availability/month', async (req, res) => {
    if (!MONTHS.includes(req.query.month)) return res.status(400).json({ error: 'เดือนอยู่นอกช่วงเปิดเส้นทาง' });
    res.json(await snapshots.get(req.query.month));
  });
  app.get('/api/availability/events', async (req, res) => {
    const month = req.query.month;
    if (!MONTHS.includes(month)) return res.status(400).json({ error: 'เดือนอยู่นอกช่วงเปิดเส้นทาง' });
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    streams.add(res);
    res.write('retry: 3000\n\n');
    const send = body => { if (!res.destroyed) res.write(`data: ${JSON.stringify(body)}\n\n`); };
    const unsubscribe = snapshots.subscribe(month, send);
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': heartbeat\n\n'); }, 15000);
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(res); });
    try { send(await snapshots.get(month)); } catch { res.end(); }
  });
  app.get('/api/availability', async (req, res) => {
    const date = req.query.date;
    if (!isVisitDate(date)) return res.status(400).json({ error: 'เลือกวันในช่วงเปิดเส้นทาง 16 พ.ย. 2569 – 12 ก.พ. 2570 ยกเว้นวันพุธ' });
    try { res.json(await read(date)); }
    catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(fileURLToPath(new URL('../dist/', import.meta.url))));
  return app;
}
