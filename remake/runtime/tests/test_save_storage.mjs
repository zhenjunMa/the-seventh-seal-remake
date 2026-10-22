import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSaveStorage} from '../web/core/save_storage.mjs';
import {encodeSave} from '../web/core/world.mjs';
import {MANUAL_SAVE_SLOTS,SAVE_SLOT_COUNT,normalizeSaveSlot,saveSlotLabel} from '../web/core/save_slots.mjs';
const seed=JSON.parse(readFileSync(new URL('../web/data/opening_seed.json',import.meta.url)));
const saved=()=>encodeSave(seed);
const reply=(status,value)=>({status,ok:status>=200&&status<300,json:async()=>value});
const emptySlots=()=>[...MANUAL_SAVE_SLOTS,'quick'].map(slot=>({slot,envelope:null,error:null}));

test('manual browser save migrates only to an empty file slot and retains the legacy copy',async()=>{
  const envelope=await saved(),calls=[],legacy=JSON.stringify(envelope);
  const storage=createSaveStorage({legacyStorage:{getItem:()=>legacy},legacyKey:'old',fetchImpl:async(url,options)=>{
    calls.push({url,options});return reply(options.method?200:404,options.method?{slot:'manual'}:{});
  }});
  assert.deepEqual(await storage.read(),envelope);
  assert.deepEqual(calls.map(row=>[row.url,row.options.method??'GET']),[['/api/saves/00','GET'],['/api/saves/00','PUT']]);
  assert.equal(calls[1].options.body,legacy);
  calls.length=0;
  assert.equal(await storage.read('quick'),null);
  assert.equal(calls.length,1);
});

test('existing disk save takes precedence over browser progress',async()=>{
  const envelope=await saved();let legacyReads=0;
  const storage=createSaveStorage({legacyStorage:{getItem(){legacyReads++;return 'bad';}},fetchImpl:async()=>reply(200,envelope)});
  assert.deepEqual(await storage.read(),envelope);assert.equal(legacyReads,0);
});

test('a migration racing another tab preserves the newly created disk save',async()=>{
  const legacy=await saved(),current=await saved();current.saved_at='2026-10-23T01:00:00Z';let reads=0;
  const storage=createSaveStorage({legacyStorage:{getItem:()=>JSON.stringify(legacy)},fetchImpl:async(_url,options)=>{
    if(options.method){assert.equal(options.headers['If-None-Match'],'*');return reply(412,{error:'already exists'});}
    return ++reads===1?reply(404,{}):reply(200,current);
  }});
  assert.deepEqual(await storage.read(),current);
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
  const corrupt=createSaveStorage({legacyStorage:{getItem:()=>JSON.stringify(envelope)},fetchImpl:async()=>reply(422,{error:'corrupt file'})});
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

test('list validates all occupied slots with one request and isolates each damaged slot',async()=>{
  const envelope=await saved(),slots=emptySlots(),calls=[];
  slots[1].envelope=envelope;
  slots[2].envelope={...envelope,sha256:'0'.repeat(64)};
  slots[3].error='unreadable file';
  slots[4].envelope=false;
  slots.at(-1).envelope=envelope;
  const storage=createSaveStorage({fetchImpl:async(url)=>{calls.push(url);return reply(200,{slots});}});
  const listed=await storage.list();
  assert.deepEqual(calls,['/api/saves']);
  assert.equal(listed.length,21);
  assert.deepEqual(listed[0],{slot:'00',envelope:null,error:null});
  assert.deepEqual(listed[1],{slot:'01',envelope,error:null});
  assert.equal(listed[2].envelope,null);assert.match(listed[2].error,/校验失败/);
  assert.deepEqual(listed[3],{slot:'03',envelope:null,error:'unreadable file'});
  assert.equal(listed[4].envelope,null);assert.match(listed[4].error,/存档封装版本不兼容/);
  assert.deepEqual(listed.at(-1),{slot:'quick',envelope,error:null});
});

test('list migrates the browser copy only to an empty 00 without reading twenty separate files',async()=>{
  const envelope=await saved(),calls=[];
  const storage=createSaveStorage({legacyStorage:{getItem:()=>JSON.stringify(envelope)},fetchImpl:async(url,options)=>{
    calls.push({url,options});return reply(200,options.method?{slot:'00'}:{slots:emptySlots()});
  }});
  const slots=await storage.list();
  assert.deepEqual(calls.map(row=>[row.url,row.options.method??'GET']),[['/api/saves','GET'],['/api/saves/00','PUT']]);
  assert.equal(calls[1].options.headers['If-None-Match'],'*');
  assert.deepEqual(slots[0].envelope,envelope);
  assert.ok(slots.slice(1).every(row=>row.envelope===null&&row.error===null));
});

test('list preserves a new file created during browser migration and keeps migration failures in 00',async()=>{
  const legacy=await saved(),current=await saved();current.saved_at='2026-10-23T01:00:00Z';
  const storage=createSaveStorage({legacyStorage:{getItem:()=>JSON.stringify(legacy)},fetchImpl:async(url,options)=>{
    if(url==='/api/saves')return reply(200,{slots:emptySlots()});
    return options.method?reply(412,{error:'already exists'}):reply(200,current);
  }});
  assert.deepEqual((await storage.list())[0].envelope,current);
  const corruptBrowser=createSaveStorage({legacyStorage:{getItem:()=>'{bad'},fetchImpl:async()=>reply(200,{slots:emptySlots()})});
  const listing=await corruptBrowser.list();
  assert.match(listing[0].error,/旧浏览器存档格式无效/);
  assert.ok(listing.slice(1).every(row=>!row.error));
});

test('list does not migrate over an occupied or corrupt slot 00 and rejects malformed responses',async()=>{
  const envelope=await saved();
  for(const row of [{slot:'00',envelope,error:null},{slot:'00',envelope:null,error:'corrupt file'}]){
    const slots=emptySlots();slots[0]=row;let legacyReads=0;
    const storage=createSaveStorage({legacyStorage:{getItem(){legacyReads++;return 'bad';}},fetchImpl:async()=>reply(200,{slots})});
    await storage.list();assert.equal(legacyReads,0);
  }
  for(const value of [{}, {slots:[]}, {slots:emptySlots().map(row=>({...row,slot:'00'}))}]){
    const storage=createSaveStorage({fetchImpl:async()=>reply(200,value)});
    await assert.rejects(storage.list(),/本地存档列表格式无效/);
  }
});
