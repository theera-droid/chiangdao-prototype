import { createServer } from 'vite';
import { createApp } from '../server/app.js';
const app = createApp();
const api = app.listen(3001, '127.0.0.1', () => app.locals.warm());
api.on('error', error => { console.error(error.message); process.exit(1); });
let vite;
try {
  vite = await createServer();
  await vite.listen();
  vite.printUrls();
} catch (error) {
  console.error(error);
  api.close();
  process.exitCode = 1;
}
async function close() { app.locals.close(); await vite?.close(); api.close(() => process.exit()); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
