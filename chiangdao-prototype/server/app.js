import express from 'express';
import { fileURLToPath } from 'node:url';
import { createAvailabilityReader, isVisitDate } from './availability.js';
import { createSnapshots, MONTHS } from './snapshots.js';
export function createApp(options = {}) {
  const app = express();
  const read = createAvailabilityReader(options);
  const snapshots = createSnapshots({ read, path: options.snapshotPath === undefined ? fileURLToPath(new URL('../.cache/availability.json', import.meta.url)) : options.snapshotPath });
  app.locals.close = snapshots.close;
  app.locals.warm = () => snapshots.warm(MONTHS[0]);
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/availability/month', async (req, res) => {
    if (!MONTHS.includes(req.query.month)) return res.status(400).json({ error: 'เดือนอยู่นอกช่วงเปิดเส้นทาง' });
    res.json(await snapshots.get(req.query.month));
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
