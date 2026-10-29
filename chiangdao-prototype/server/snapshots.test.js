import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshots, visitDates } from './snapshots.js';
const row = date => ({source:'live',stale:false,day:{date,available:8,capacity:100,status:'low',observedAt:new Date().toISOString()}});
test('snapshot returns immediately while one shared background job serves repeated visits', async () => {
  let release, calls=0;
  const hold = new Promise(resolve=>release=resolve);
  const store=createSnapshots({read:async date=>{calls++;await hold;return row(date);},pause:async()=>{}});
  const published=[];
  const unsubscribe=store.subscribe('2026-11', snapshot=>published.push(snapshot.loaded));
  try {
    const first=await store.get('2026-11');
    assert.equal(first.loaded,0);assert.equal(first.loading,true);
    await store.get('2026-11');await store.get('2026-11');
    assert.equal(calls,3);
    release();await store.settle();
    const ready=await store.get('2026-11');
    assert.equal(ready.loaded,visitDates('2026-11').length);
    assert.equal(ready.loading,false);assert.equal(calls,ready.loaded);
    assert(published.every(count=>count===0 || count===ready.total), 'month must be published atomically');
  } finally { unsubscribe();release();store.close(); }
});
test('persisted real snapshots survive restart and stay readable on upstream failure', async () => {
  const dir=await mkdtemp(join(tmpdir(),'chiangdao-cache-')),path=join(dir,'cache.json');
  const first=createSnapshots({path,read:async date=>row(date),pause:async()=>{}});
  let second;
  try {
    await first.get('2026-11');await first.settle();first.close();
    second=createSnapshots({path,now:()=>Date.now()+400000,read:async date=>({source:'live',error:'offline',day:{date,available:null,status:'unknown'}}),pause:async()=>{}});
    const initial=await second.get('2026-11');
    assert.equal(initial.loaded,visitDates('2026-11').length);assert(initial.records.every(r=>r.stale));
    await second.settle();const result=await second.get('2026-11');
    assert(result.records.every(r=>r.day.available===8 && r.stale));
    assert.equal(result.error,'offline');
  } finally { first.close();second?.close();await rm(dir,{recursive:true,force:true}); }
});
test('upstream restriction stops background collection across months', async () => {
  let calls=0;
  const store=createSnapshots({read:async date=>{calls++;return {...row(date),blocked:true,error:'403'};},pause:async()=>{}});
  try {await store.get('2026-11');await store.settle();await store.get('2026-12');await store.settle();assert.equal(calls,3);} finally {store.close();}
});
