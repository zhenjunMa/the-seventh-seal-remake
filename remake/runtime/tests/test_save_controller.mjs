import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {createServicesController} from '../web/controllers/services.mjs';
import {createInputController} from '../web/controllers/input.mjs';
import {PhaserRuntime} from '../web/phaser/runtime.mjs';
import {MANUAL_SAVE_SLOTS} from '../web/core/save_slots.mjs';

registerHooks({resolve(specifier,context,next){
  if(specifier==='/prototype/movement.mjs')return {url:new URL('../../prototype/web/movement.mjs',import.meta.url).href,shortCircuit:true};
  return next(specifier,context);
}});
const {createSessionController}=await import('../web/controllers/session.mjs');
globalThis.document={createElement:()=>({textContent:''})};

const seed=JSON.parse(readFileSync(new URL('../web/data/world_seed.json',import.meta.url)));
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAABMCAIAAAAOQ2XWAAAAuUlEQVR4nO3SMREAIAADMUASclCCfDTwc7J3+evc5w7+rbBBuM7jIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhRvMAV4QBnCTMUicAAAAASUVORK5CYII=';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const ALL_SLOTS=[...MANUAL_SAVE_SLOTS,'quick'];
const settled=()=>new Promise(done=>setImmediate(done));
function fixture(){
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,dataset:{},classList:{toggle(){}},append(){},children:[]});return nodes.get(id);};
  const world=new WorldStore(seed),state={world,logs:[],keys:new Set(),clock:0,view:{},phaseNames:{},saveSlots:Object.fromEntries(ALL_SLOTS.map(slot=>[slot,null])),saveOperation:null,
    catalog:{maps:[{id:seed.location.map_id}],roles:seed.party.map(role=>({id:role.id}))},startupView:{hide(){},showMenu(){}}};
  const actions={captureSavePreview:()=>png,buildHud(){},updateNearest(){}},canvas={focus(){}};
  Object.assign(actions,createServicesController({state,actions,$,canvas}));
  state.scenes=new SceneController({world,prepare:async()=>({data:{id:seed.location.map_id}}),validateEntry(){},commitView(){}});
  state.scenes.current={data:{id:seed.location.map_id}};state.scenes.setPhase('map');
  Object.assign(actions,createSessionController({state,actions,$,canvas}));
  state.saveMenu={active:false,show(options){this.active=true;this.options=options;},hide(){this.active=false;},setEntries(entries){this.entries=entries;},setMessage(message){this.message=message;},key(key){if(!this.active)return false;if(key==='Escape')actions.closeSaveMenu();return true;}};
  const files=new Map(),storageCalls=[];
  state.saveStorage={read:async slot=>files.get(slot)??null,write:async(envelope,slot,createOnly,options)=>{storageCalls.push({slot,envelope,createOnly,options});files.set(slot,envelope);return {path:`remake/saves/SaveGame${slot}.json`};},list:async()=>ALL_SLOTS.map(slot=>({slot,envelope:files.get(slot)??null,error:null}))};
  return {state,actions,$,canvas,files,storageCalls};
}

test('file save holds exploration and blocks load, new game and scene transitions until its write completes',async()=>{
  const {state,actions,$}=fixture(),gate=deferred(),entered=deferred();let written;
  state.saveStorage={write:async(envelope,slot)=>{written={envelope,slot};entered.resolve();return gate.promise;}};
  const pending=actions.saveProgress('quick');
  assert.equal(state.scenes.phase,'save-io');
  await assert.rejects(actions.loadProgress(),/正在存取/);
  await assert.rejects(actions.beginOpening(),/正在存取/);
  assert.throws(()=>actions.showTitle(),/正在存取/);
  await assert.rejects(state.scenes.loadLocation(seed.location),/尚未完成/);
  await entered.promise;
  assert.equal(written.slot,'quick');assert.deepEqual(await decodeSave(written.envelope),await decodeSave(await encodeSave(seed)));
  assert.equal(state.saveSlots.quick,null);assert.equal($('saveStatus').textContent,'');
  gate.resolve({path:'remake/saves/quick.json'});await pending;
  assert.equal(state.scenes.phase,'map');assert.equal(state.saveOperation,null);
  assert.equal(state.saveSlots.quick,written.envelope);assert.equal(state.saveSlots['00'],null);
  assert.match($('saveStatus').textContent,/快速存档已保存/);
});

test('failed writes never mark progress saved and failed reads or checksums preserve the world and release the lock',async()=>{
  const {state,actions,$}=fixture(),before=state.world.snapshot();
  state.saveStorage={write:async()=>{throw new Error('磁盘写入失败');},read:async()=>{throw new Error('存档读取失败');}};
  await assert.rejects(actions.saveProgress(),/磁盘写入失败/);
  assert.equal(state.saveSlots['00'],null);assert.equal($('saveStatus').textContent,'');
  await assert.rejects(actions.loadProgress(),/读取失败/);
  const damaged={...await encodeSave(seed),sha256:'0'.repeat(64)};
  await assert.rejects(actions.restore(damaged),/校验失败/);
  assert.deepEqual(state.world.snapshot(),before);assert.equal(state.scenes.phase,'map');assert.equal(state.saveOperation,null);
});

test('quick load reads the quick slot and restores through the validated scene transaction',async()=>{
  const {state,actions}=fixture(),saved=await encodeSave(seed),gate=deferred();let slot;
  state.world.setPosition(seed.location.x+16,seed.location.y,seed.location.direction);
  state.saveStorage={read:async selected=>{slot=selected;return gate.promise;}};
  const pending=actions.loadProgress('quick');
  assert.equal(slot,'quick');assert.equal(state.scenes.phase,'save-io');
  gate.resolve(saved);await pending;
  assert.deepEqual(state.world.snapshot(),await decodeSave(saved));assert.equal(state.scenes.phase,'map');
});

test('a rejected title load restores the menu phase and permits a subsequent valid load',async()=>{
  const {state,actions}=fixture(),saved=await encodeSave(seed);
  state.scenes.setPhase('menu');state.saveStorage={read:async()=>({...saved,sha256:'0'.repeat(64)})};
  await assert.rejects(actions.loadProgress('quick'),/校验失败/);
  assert.equal(state.scenes.phase,'menu');assert.equal(state.saveOperation,null);
  state.saveStorage.read=async()=>saved;await actions.loadProgress('quick');assert.equal(state.scenes.phase,'map');
});

test('unavailable boot saves do not throw and a readable second slot remains available',async()=>{
  const {state,actions,$}=fixture(),quick=await encodeSave(seed);
  state.saveStorage={list:async()=>ALL_SLOTS.map(slot=>({slot,envelope:slot==='quick'?quick:null,error:slot==='00'?'文件损坏':null}))};
  const errors=await actions.refreshSaveSlots({quiet:true});
  assert.equal(errors.length,1);assert.equal(state.saveSlots['00'],null);assert.equal(state.saveSlots.quick,quick);assert.match($('saveStatus').textContent,/文件损坏/);
});

test('F4 and F5 precede active views, cancel browser defaults, ignore repeats and always use the quick slot',async()=>{
  const calls=[],listeners=new Map(),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id);};
  const previousDocument=globalThis.document,previousWindow=globalThis.window;
  globalThis.document={activeElement:{tagName:'INPUT'},addEventListener(){}};
  globalThis.window={addEventListener:(kind,handler)=>listeners.set(kind,handler)};
  try{
    const state={keys:new Set(),engine:{paused:false},startupView:{key(){throw new Error('view received function key');}}};
    const actions={guarded:fn=>fn,saveProgress:slot=>calls.push(['save',slot]),loadProgress:slot=>calls.push(['load',slot]),menuOperation:fn=>fn};
    const controller=createInputController({state,actions,$,canvas:{addEventListener(){}}});controller.wire();
    let prevented=0;
    for(const [key,repeat] of [['F4',false],['F4',true],['F5',false],['F5',true]])listeners.get('keydown')({key,repeat,preventDefault(){prevented++;}});
    assert.equal(prevented,4);assert.deepEqual(calls,[['save','quick'],['load','quick']]);controller.disposeInput();
  }finally{globalThis.document=previousDocument;globalThis.window=previousWindow;}
});

test('save I/O keeps the exploration drawing visible while pausing its simulation',()=>{
  const runtime={destroyed:false,mode:'exploration',syncScenes(){this.synced=true;}};
  PhaserRuntime.prototype.setPhase.call(runtime,'save-io');
  assert.equal(runtime.mode,'exploration');assert.equal(runtime.phase,'save-io');assert.equal(runtime.synced,true);
});

test('communications crystal opens the slot page without writing and saves only the selected numbered slot',async()=>{
  const {state,actions,files,storageCalls}=fixture(),existing=await encodeSave(seed);
  files.set('00',existing);
  const opened=actions.openSaveCrystal();await settled();
  assert.equal(state.scenes.phase,'save-menu');assert.equal(state.saveMenu.active,true);assert.equal(state.saveMenu.options.mode,'save');
  assert.deepEqual(storageCalls,[]);assert.equal(state.saveMenu.entries.length,21);
  assert.equal(state.saveMenu.entries[0].envelope,existing);
  await actions.selectSaveSlot(state.saveMenu.entries.find(row=>row.slot==='01'));
  assert.equal(storageCalls.length,1);assert.equal(storageCalls[0].slot,'01');assert.equal(storageCalls[0].createOnly,true);assert.equal(storageCalls[0].options.expectedSha,undefined);
  assert.equal(files.get('00'),existing);assert.equal(state.saveSlots['00'],existing);assert.equal(state.saveSlots['01'],files.get('01'));
  assert.equal(state.scenes.phase,'save-menu');assert.match(state.saveMenu.message,/栏位 01 已保存/);
  state.saveMenu.key('Escape');await opened;
  assert.equal(state.scenes.phase,'map');assert.equal(state.saveMenu.active,false);assert.equal(state.saveMenuContext,null);
});

test('slot page passes the displayed save fingerprint to overwrite and blocks closing or other saves during I/O',async()=>{
  const {state,actions,files}=fixture(),existing=await encodeSave(seed),gate=deferred(),entered=deferred();files.set('00',existing);
  const opened=actions.openSaveCrystal();await settled();
  let write;
  state.saveStorage.write=async(envelope,slot,createOnly,options)=>{write={envelope,slot,createOnly,options};entered.resolve();await gate.promise;files.set(slot,envelope);return {path:'remake/saves/SaveGame00.json'};};
  const saving=actions.selectSaveSlot(state.saveMenu.entries[0]);await entered.promise;
  assert.equal(write.slot,'00');assert.equal(write.createOnly,false);assert.equal(write.options.expectedSha,existing.sha256);
  assert.equal(state.scenes.phase,'save-io');assert.equal(actions.closeSaveMenu(),false);
  await assert.rejects(actions.saveProgress('quick'),/正在存取/);
  await assert.rejects(actions.openSaveCrystal(),/当前操作完成/);
  gate.resolve();await saving;
  assert.equal(state.scenes.phase,'save-menu');assert.equal(actions.closeSaveMenu(),true);await opened;assert.equal(state.scenes.phase,'map');
});

test('slot page keeps a failed save available for retry and returns load pages to their origin on cancel',async()=>{
  const {state,actions,storageCalls}=fixture();
  const opened=actions.openSaveCrystal();await settled();
  state.saveStorage.write=async()=>{throw new Error('disk full');};
  await assert.rejects(actions.selectSaveSlot({slot:'02',envelope:null}),/disk full/);
  assert.equal(state.scenes.phase,'save-menu');assert.equal(state.saveMenu.active,true);assert.equal(state.saveSlots['02'],null);assert.equal(storageCalls.length,0);
  actions.closeSaveMenu();await opened;state.scenes.setPhase('menu');
  const loading=actions.openSaveMenu({mode:'load'});await settled();
  assert.equal(state.scenes.phase,'save-menu');state.saveMenu.key('Escape');await loading;assert.equal(state.scenes.phase,'menu');
});

test('loading a numbered slot through the page restores the world and closes back to exploration',async()=>{
  const {state,actions,files}=fixture(),saved=await encodeSave(seed);files.set('19',saved);
  state.world.setPosition(seed.location.x+16,seed.location.y,seed.location.direction);
  state.scenes.setPhase('menu');const opened=actions.openSaveMenu({mode:'load'});await settled();
  await actions.selectSaveSlot(state.saveMenu.entries.find(row=>row.slot==='19'));await opened;
  assert.deepEqual(state.world.snapshot(),await decodeSave(saved));assert.equal(state.scenes.phase,'map');assert.equal(state.saveMenu.active,false);assert.equal(state.saveMenuContext,null);
});

test('a legacy pending prologue releases the numbered picker and still attempts playback, with usable title on failure',async()=>{
  const {state,actions,files}=fixture(),pending=structuredClone(seed);
  pending.location.map_id='M72061';pending.opening={id:'resurrect',status:'pending'};state.catalog.maps.push({id:'M72061'});
  files.set('19',await encodeSave(pending));actions.clearDialogue=()=>{};state.scenes.setPhase('menu');
  const opened=actions.openSaveMenu({mode:'load'});await settled();
  await assert.rejects(actions.selectSaveSlot(state.saveMenu.entries.find(row=>row.slot==='19')));
  await opened;assert.equal(state.saveMenu.active,false);assert.equal(state.saveMenuContext,null);assert.equal(state.saveOperation,null);assert.equal(state.scenes.phase,'menu');
});

test('an overwrite conflict refreshes the displayed slot before a new confirmation can retry',async()=>{
  const {state,actions,files}=fixture(),old=await encodeSave(seed);files.set('00',old);
  const opened=actions.openSaveCrystal();await settled();const displayed=state.saveMenu.entries[0];
  const changed=structuredClone(seed);changed.revision++;const newer=await encodeSave(changed);files.set('00',newer);
  state.saveStorage.write=async()=>{const error=new Error('slot changed');error.status=412;throw error;};
  await assert.rejects(actions.selectSaveSlot(displayed),/slot changed/);
  assert.equal(state.saveMenu.entries[0].envelope,newer);assert.equal(state.scenes.phase,'save-menu');actions.closeSaveMenu();await opened;
});
