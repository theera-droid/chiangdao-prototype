import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from './app.js';
import { createAvailabilityReader } from './availability.js';
import { restore, save } from '../src/saved-data.js';

test('browser restores last known data as stale, never as a newly verified count', () => {
  let data;
  const storage = {setItem:(_k,v)=>data=v,getItem:()=>data};
  const observedAt=new Date().toISOString();
  save(storage, {'2026-11-16':{source:'live',stale:false,day:{date:'2026-11-16',available:8,capacity:100,status:'low',observedAt}}});
  const result=restore(storage);
  assert.equal(result['2026-11-16'].stale,true);
  assert.equal(result['2026-11-16'].day.observedAt,observedAt);
  data='invalid json';assert.deepEqual(restore(storage),{});
  assert.deepEqual(restore(undefined),{});
});
test('three consecutive failures pause reads; recovery replaces unknown with actual data', async () => {
  let time=Date.now(), offline=true, calls=0;
  const read=createAvailabilityReader({now:()=>time,fetchImpl:async url=>{
    calls++;
    if(url.includes('/chiangdao/open'))return Response.json({data:{q:{open:true}}});
    if(offline)throw new Error('network offline');
    return Response.json({success:true,data:{date:new URL(url).searchParams.get('date'),available:7,capacity:100}});
  }});
  for(const date of ['2026-11-16','2026-11-17','2026-11-19']){await read(date);time+=1300;}
  const count=calls;
  await assert.rejects(read('2026-11-20'));assert.equal(calls,count);
  offline=false;time+=61000;
  const result=await read('2026-11-16');assert.equal(result.day.available,7);assert.equal(result.stale,false);
});
test('SSE sends snapshots and new counts without a browser polling interval', async () => {
  const app=createApp({snapshotPath:null,snapshotPause:async()=>{},fetchImpl:async url=>Response.json(url.includes('/chiangdao/open')?{data:{q:{open:true}}}:{success:true,data:{date:new URL(url).searchParams.get('date'),available:8,capacity:100}})});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const controller=new AbortController();let reader;
  const timeout=setTimeout(()=>controller.abort(),5000);
  try {
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/availability/events?month=2026-11`,{signal:controller.signal});
    assert.match(res.headers.get('content-type'),/text\/event-stream/);
    reader=res.body.getReader();let text='';
    while(!text.includes('"available":8')) { const chunk=await reader.read();if(chunk.done)break;text+=new TextDecoder().decode(chunk.value); }
    assert.match(text,/"available":8/);assert.match(text,/"observedAt"/);
  } finally {
    clearTimeout(timeout);await reader?.cancel();controller.abort();app.locals.close();
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
