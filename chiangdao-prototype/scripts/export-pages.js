import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAvailabilityReader } from '../server/availability.js';
import { createSnapshots, MONTHS } from '../server/snapshots.js';

const cachePath=fileURLToPath(new URL('../.cache/availability.json',import.meta.url));
const output=fileURLToPath(new URL('../public/data/',import.meta.url));
const previousUrl=process.env.PAGES_PREVIOUS_URL;
if(previousUrl) {
  const response=await fetch(previousUrl,{signal:AbortSignal.timeout(20000),cache:'no-store'});
  if(response.ok) {
    const previous=await response.json();
    if(previous.version!==1 || !previous.months) throw new Error('Invalid previous snapshot; keeping the deployed site unchanged.');
    const records={};
    for(const month of MONTHS) for(const row of previous.months[month]?.records??[]) if(row?.day?.date) records[row.day.date]=row;
    await mkdir(fileURLToPath(new URL('../.cache/',import.meta.url)),{recursive:true});
    await writeFile(cachePath,JSON.stringify({version:1,records}));
  } else if(response.status!==404) throw new Error(`Previous snapshot HTTP ${response.status}; keeping the deployed site unchanged.`);
}
const store=createSnapshots({read:createAvailabilityReader(),path:cachePath,pause:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
const months={};
try {
  for(const month of MONTHS) { await store.get(month);await store.settle();months[month]=await store.get(month); }
  const count=Object.values(months).reduce((n,month)=>n+month.loaded,0);
  if(!count) throw new Error('No verified availability to publish; keeping the previous deployment.');
  await mkdir(output,{recursive:true});
  const payload={version:1,publishedAt:new Date().toISOString(),mode:'scheduled',months};
  await writeFile(`${output}/availability.json`,JSON.stringify(payload));
  console.log(`Exported ${count} last-known daily counts. Per-day observedAt timestamps are preserved.`);
} finally {store.close();}
