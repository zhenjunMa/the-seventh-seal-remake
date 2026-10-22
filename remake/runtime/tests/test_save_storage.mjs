import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSaveStorage} from '../web/core/save_storage.mjs';
import {encodeSave} from '../web/core/world.mjs';
const seed=JSON.parse(readFileSync(new URL('../web/data/opening_seed.json',import.meta.url)));
const saved=()=>encodeSave(seed);
const reply=(status,value)=>({status,ok:status>=200&&status<300,json:async()=>value});

test('manual browser save migrates only to an empty file slot and retains the legacy copy',async()=>{
  const envelope=await saved(),calls=[],legacy=JSON.stringify(envelope);
  const storage=createSaveStorage({legacyStorage:{getItem:()=>legacy},legacyKey:'old',fetchImpl:async(url,options)=>{
    calls.push({url,options});return reply(options.method?200:404,options.method?{slot:'manual'}:{});
  }});
  assert.deepEqual(await storage.read(),envelope);
  assert.deepEqual(calls.map(row=>[row.url,row.options.method??'GET']),[['/api/saves/manual','GET'],['/api/saves/manual','PUT']]);
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
