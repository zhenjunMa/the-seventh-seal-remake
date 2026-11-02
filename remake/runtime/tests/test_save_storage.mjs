import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSaveStorage} from '../web/core/save_storage.mjs';
import {encodeSave} from '../web/core/world.mjs';
import {MANUAL_SAVE_SLOTS,SAVE_SLOT_COUNT,normalizeSaveSlot,saveSlotLabel} from '../web/core/save_slots.mjs';
const seed=JSON.parse(readFileSync(new URL('../web/data/opening_seed.json',import.meta.url)));
const saved=()=>encodeSave(seed);
const reply=(status,value)=>({status,ok:status>=200&&status<300,json:async()=>value,blob:async()=>value});
const emptySlots=()=>[...MANUAL_SAVE_SLOTS,'quick'].map(slot=>({slot,summary:null,error:null}));
const savedSummary=()=>({schema:'seventh-seal-save-summary',version:1,sha256:'1'.repeat(64),party:[{name:'英格妮'}],location:{map_id:'M72061'},play_time_ms:12300,thumbnail:null});

test('empty disk slots remain empty and browser JSON progress is never migrated',async()=>{
  let legacyReads=0;const calls=[];
  const storage=createSaveStorage({legacyStorage:{getItem(){legacyReads++;return 'old JSON';}},fetchImpl:async(url,options)=>{
    calls.push({url,options});return reply(404,{});
  }});
  assert.equal(await storage.read(),null);
  assert.equal(await storage.read('quick'),null);
  assert.equal(legacyReads,0);
  assert.deepEqual(calls.map(row=>[row.url,row.options.method??'GET']),[['/api/saves/00','GET'],['/api/saves/quick','GET']]);
});

test('unavailable service and invalid saves never report successful persistence or fall back silently',async()=>{
  const envelope=await saved();
  const disconnected=createSaveStorage({fetchImpl:async()=>{throw new Error('offline');}});
  await assert.rejects(disconnected.write(envelope),/无法连接本地存档服务/);
  const denied=createSaveStorage({fetchImpl:async()=>reply(500,{error:'disk full'})});
  await assert.rejects(denied.write(envelope,'quick'),/disk full/);
  const bad={...envelope,sha256:'0'.repeat(64)};let calls=0;
  const untouched=createSaveStorage({fetchImpl:async()=>{calls++;return reply(200,{});}});
  await assert.rejects(untouched.write(bad),/校验失败/);assert.equal(calls,0);
  const corrupt=createSaveStorage({fetchImpl:async()=>reply(422,{error:'corrupt file'})});
  await assert.rejects(corrupt.read(),/corrupt file/);
});

test('twenty padded manual slot IDs are strict and manual aliases slot 00',()=>{
  assert.equal(SAVE_SLOT_COUNT,20);
  assert.deepEqual(MANUAL_SAVE_SLOTS,Array.from({length:20},(_,index)=>String(index).padStart(2,'0')));
  assert.equal(normalizeSaveSlot(),'00');
  assert.equal(normalizeSaveSlot('manual'),'00');
  assert.equal(saveSlotLabel('05'),'05');
  assert.equal(saveSlotLabel('quick'),'快速存档');
  for(const invalid of ['0','20','000','00.json','../00',0,null])assert.throws(()=>normalizeSaveSlot(invalid),/存档槽不存在/);
});

test('numbered writes include conditional overwrite fingerprints and reject illegal slots before fetching',async()=>{
  const envelope=await saved(),calls=[];
  const storage=createSaveStorage({fetchImpl:async(url,options)=>{calls.push({url,options});return reply(200,{slot:'19'});}});
  await storage.write(envelope,'19',false,{expectedSha:envelope.sha256});
  assert.equal(calls[0].url,'/api/saves/19');
  assert.equal(calls[0].options.headers['If-Match'],`"${envelope.sha256}"`);
  await storage.write(envelope,'manual',true);
  assert.equal(calls[1].url,'/api/saves/00');
  assert.equal(calls[1].options.headers['If-None-Match'],'*');
  for(const invalid of ['0','20','../../00']){
    await assert.rejects(storage.read(invalid),/存档槽不存在/);
    await assert.rejects(storage.write(envelope,invalid),/存档槽不存在/);
  }
  await assert.rejects(storage.write(envelope,'00',false,{expectedSha:'bad'}),/校验指纹无效/);
  assert.equal(calls.length,2);
});

test('list reads only summaries with one request and isolates invalid summaries without decoding worlds',async()=>{
  const summary=savedSummary(),slots=emptySlots(),calls=[];
  slots[1].summary=summary;
  slots[2].summary={...summary,sha256:'invalid'};
  slots[3].error='unreadable file';
  slots[4].summary=false;
  slots.at(-1).summary=summary;
  const storage=createSaveStorage({fetchImpl:async(url)=>{calls.push(url);return reply(200,{slots});}});
  const listed=await storage.list();
  assert.deepEqual(calls,['/api/saves']);
  assert.equal(listed.length,21);
  assert.deepEqual(listed[0],{slot:'00',summary:null,error:null});
  assert.deepEqual(listed[1],{slot:'01',summary,error:null});
  assert.equal(listed[2].summary,null);assert.match(listed[2].error,/存档摘要格式无效/);
  assert.deepEqual(listed[3],{slot:'03',summary:null,error:'unreadable file'});
  assert.equal(listed[4].summary,null);assert.match(listed[4].error,/存档摘要格式无效/);
  assert.deepEqual(listed.at(-1),{slot:'quick',summary,error:null});
});

test('list never consults browser JSON and rejects malformed responses',async()=>{
  const summary=savedSummary();
  for(const row of [{slot:'00',summary:null,error:null},{slot:'00',summary,error:null},{slot:'00',summary:null,error:'corrupt file'}]){
    const slots=emptySlots();slots[0]=row;let legacyReads=0;
    const storage=createSaveStorage({legacyStorage:{getItem(){legacyReads++;return 'bad';}},fetchImpl:async()=>reply(200,{slots})});
    await storage.list();assert.equal(legacyReads,0);
  }
  for(const value of [{}, {slots:[]}, {slots:emptySlots().map(row=>({...row,slot:'00'}))}]){
    const storage=createSaveStorage({fetchImpl:async()=>reply(200,value)});
    await assert.rejects(storage.list(),/本地存档列表格式无效/);
  }
});

test('native file import and export use binary conversion endpoints',async()=>{
  const envelope=await saved(),file=new Blob([new Uint8Array([2,0,0,0])]),calls=[];
  const storage=createSaveStorage({fetchImpl:async(url,options)=>{
    calls.push({url,options});return reply(200,url.endsWith('/decode')?envelope:file);
  }});
  assert.deepEqual(await storage.decodeFile(file),envelope);
  assert.equal(calls[0].url,'/api/saves/decode');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.body,file);
  assert.equal(calls[0].options.headers['Content-Type'],'application/octet-stream');
  assert.equal(await storage.encodeFile(envelope),file);
  assert.equal(calls[1].url,'/api/saves/encode');
  assert.equal(calls[1].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body),envelope);
  const invalid=createSaveStorage({fetchImpl:async()=>reply(422,{error:'原版存档格式无效'})});
  await assert.rejects(invalid.decodeFile(file),/原版存档格式无效/);
  await assert.rejects(invalid.encodeFile(envelope),/原版存档格式无效/);
});
