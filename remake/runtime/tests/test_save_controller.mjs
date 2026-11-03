import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {WorldStore,encodeSave,decodeSave,validateWorld,DEFAULT_GAME_SETTINGS} from '../web/core/world.mjs';
import {SceneController} from '../web/core/scenes.mjs';
import {createServicesController} from '../web/controllers/services.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {createInputController} from '../web/controllers/input.mjs';
import {createMenuController} from '../web/controllers/menu.mjs';
import {PhaserRuntime} from '../web/phaser/runtime.mjs';
import {MANUAL_SAVE_SLOTS} from '../web/core/save_slots.mjs';

const {createSessionController}=await import('../web/controllers/session.mjs');
globalThis.document={createElement:()=>({textContent:''})};

const load=name=>JSON.parse(readFileSync(new URL(`../web/data/${name}.json`,import.meta.url)));
const seed=load('opening_seed');seed.opening.status='complete';
const partyCombat=load('party_combat'),itemData=load('items'),partySkills=load('party_skills');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGgAAABMCAIAAAAOQ2XWAAAAuUlEQVR4nO3SMREAIAADMUASclCCfDTwc7J3+evc5w7+rbBBuM7jIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhIuEi4SLhRvMAV4QBnCTMUicAAAAASUVORK5CYII=';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const summaryOf=envelope=>{if(!envelope)return null;const world=JSON.parse(envelope.payload);return {sha256:envelope.sha256,party:world.party.map(({name})=>({name})),location:{map_id:world.location.map_id},play_time_ms:world.play_time_ms??0};};
const ALL_SLOTS=[...MANUAL_SAVE_SLOTS,'quick'];
const settled=()=>new Promise(done=>setImmediate(done));
function fixture(initial=seed,{now=()=>0}={}){
  const nodes=new Map(),$=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'',hidden:false,dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},append(){},children:[],replaceChildren(...children){this.children=children;if(!children.some(row=>row.value===this.value))this.value=children[0]?.value??'';}});return nodes.get(id);};
  const world=new WorldStore(initial),state={world,partyCombat,itemData,partySkills,logs:[],keys:new Set(),clock:0,view:{},phaseNames:{},saveSlots:Object.fromEntries(ALL_SLOTS.map(slot=>[slot,null])),saveOperation:null,
    catalog:{maps:[{id:initial.location.map_id}],roles:initial.party.map(role=>({id:role.id}))},startupView:{hide(){},showMenu(){}}};
  const actions={captureSavePreview:()=>png,buildHud(){},updateNearest(){}},canvas={focus(){}};
  Object.assign(actions,createServicesController({state,actions,$,canvas,now}));
  state.scenes=new SceneController({world,prepare:async()=>({data:{id:initial.location.map_id}}),validateEntry(){},commitView(){},onPhase:actions.busy});
  state.scenes.current={data:{id:initial.location.map_id}};state.scenes.setPhase('map');
  Object.assign(actions,createStoryController({state,actions,$,canvas}));
  Object.assign(actions,createSessionController({state,actions,$,canvas}));
  state.saveMenu={active:false,show(options){this.active=true;this.options=options;},hide(){this.active=false;},setEntries(entries){this.entries=entries;},setMessage(message){this.message=message;},key(key){if(!this.active)return false;if(key==='Escape')actions.closeSaveMenu();return true;}};
  const files=new Map(),storageCalls=[];
  state.saveStorage={read:async slot=>files.get(slot)??null,write:async(envelope,slot,createOnly,options)=>{storageCalls.push({slot,envelope,createOnly,options});files.set(slot,envelope);return {summary:summaryOf(envelope),path:`remake/saves/${slot==='quick'?'Game.SAV':`SaveGame${Number(slot)}.Dat`}`};},list:async()=>ALL_SLOTS.map(slot=>({slot,summary:summaryOf(files.get(slot)),error:null}))};
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
  assert.equal(written.slot,'quick');assert.deepEqual(await decodeSave(written.envelope),{...seed,play_time_ms:0,game_settings:DEFAULT_GAME_SETTINGS});
  assert.equal(state.saveSlots.quick,null);assert.equal($('saveStatus').textContent,'');
  gate.resolve({path:'remake/saves/Game.SAV',summary:summaryOf(written.envelope)});await pending;
  assert.equal(state.scenes.phase,'map');assert.equal(state.saveOperation,null);
  assert.deepEqual(state.saveSlots.quick,summaryOf(written.envelope));assert.equal(state.saveSlots['00'],null);
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

test('play time counts once across failed or repeated saves, pauses on the title and resets on load or new game',async()=>{
  let clock=0;const initial={...structuredClone(seed),play_time_ms:100*3600_000};
  const {state,actions,files}=fixture(initial,{now:()=>clock}),before=state.world.snapshot();
  clock=1500;const write=state.saveStorage.write;state.saveStorage.write=async()=>{throw Error('disk full');};
  await assert.rejects(actions.saveProgress('quick'),/disk full/);assert.equal(actions.currentPlayTime(),initial.play_time_ms+1500);
  state.saveStorage.write=write;clock=2500;await actions.saveProgress('quick');await actions.saveProgress('quick');
  assert.equal((await decodeSave(files.get('quick'))).play_time_ms,initial.play_time_ms+2500);assert.deepEqual(state.world.snapshot(),before);
  state.scenes.setPhase('menu');clock=12500;
  const picker=actions.openSaveMenu({mode:'load'});await settled();clock=13500;actions.closeSaveMenu();await picker;
  assert.equal(actions.currentPlayTime(),initial.play_time_ms+2500);
  state.scenes.setPhase('map');clock=14500;await actions.saveProgress('quick');
  assert.equal((await decodeSave(files.get('quick'))).play_time_ms,initial.play_time_ms+3500);
  clock=100000;await actions.loadProgress('quick');assert.equal(actions.currentPlayTime(),initial.play_time_ms+3500);
  actions.resetPlayTime(0);clock+=250;assert.equal(actions.currentPlayTime(),250);
});

test('loading applies saved audio and cursor settings only after success; saving captures later preference edits',async()=>{
  const saved=structuredClone(seed);saved.play_time_ms=321000;
  saved.game_settings={audio:{master:{volume:.5,muted:false},music:{volume:.25,muted:true},effects:{volume:0,muted:false}},battle_cursor:'initial'};
  const {state,actions,$}=fixture(),channels=structuredClone(DEFAULT_GAME_SETTINGS.audio);let cursor='memory';
  state.audio={setChannelVolume(name,value){channels[name].volume=value;},setChannelMuted(name,value){channels[name].muted=value;},
    snapshot:()=>({channels:structuredClone(channels),volume:channels.master.volume,muted:channels.master.muted})};
  state.menuSettings={setBattleCursor(value){cursor=value;},snapshot:()=>({battleCursor:cursor})};
  const envelope=await encodeSave(saved);
  await assert.rejects(actions.restore({...envelope,sha256:'0'.repeat(64)}),/校验失败/);
  assert.deepEqual(channels,DEFAULT_GAME_SETTINGS.audio);assert.equal(cursor,'memory');
  await actions.restore(envelope);assert.deepEqual(channels,saved.game_settings.audio);assert.equal(cursor,'initial');
  assert.equal($('audioVolume').value,'50');assert.equal(actions.currentPlayTime(),321000);
  channels.effects={volume:.75,muted:true};cursor='memory';
  const next=await decodeSave(await actions.saveEnvelope());assert.deepEqual(next.game_settings,{audio:channels,battle_cursor:'memory'});
  assert.deepEqual(state.world.value.game_settings,saved.game_settings,'saving preferences does not mutate live progress');
});

test('the world boundary validates optional play time and settings while accepting older in-memory fixtures',()=>{
  assert.doesNotThrow(()=>validateWorld(seed));
  for(const play_time_ms of [-1,.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateWorld({...seed,play_time_ms}),/累计游戏时间/);
  for(const change of [s=>s.audio.master.volume=1.01,s=>s.audio.music.muted=1,s=>s.battle_cursor='fast',s=>s.audio.extra={volume:1,muted:false}]){
    const game_settings=structuredClone(DEFAULT_GAME_SETTINGS);change(game_settings);assert.throws(()=>validateWorld({...seed,game_settings}),/游戏.*设置/);
  }
  assert.equal(validateWorld({...seed,play_time_ms:1000*3600_000,game_settings:DEFAULT_GAME_SETTINGS}).play_time_ms,1000*3600_000);
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
  state.saveStorage={list:async()=>ALL_SLOTS.map(slot=>({slot,summary:slot==='quick'?summaryOf(quick):null,error:slot==='00'?'文件损坏':null}))};
  const errors=await actions.refreshSaveSlots({quiet:true});
  assert.equal(errors.length,1);assert.equal(state.saveSlots['00'],null);assert.deepEqual(state.saveSlots.quick,summaryOf(quick));assert.match($('saveStatus').textContent,/文件损坏/);
});

test('F4 and F5 precede active views, cancel browser defaults, ignore repeats and always use the quick slot',async()=>{
  const calls=[],listeners=new Map(),nodes=new Map();
  const $=id=>{if(!nodes.has(id))nodes.set(id,{setAttribute(){}});return nodes.get(id);};
  const previousDocument=globalThis.document,previousWindow=globalThis.window;
  globalThis.document={activeElement:{tagName:'INPUT'},addEventListener(){}};
  globalThis.window={addEventListener:(kind,handler)=>listeners.set(kind,handler)};
  try{
    const state={keys:new Set(),engine:{paused:false},startupView:{key(){throw new Error('view received function key');}}};
    const actions={guarded:fn=>fn,saveProgress:slot=>calls.push(['save',slot]),loadProgress:slot=>calls.push(['load',slot]),menuOperation:fn=>fn,exportRuntimeLog:()=>calls.push(['export-log'])};
    const controller=createInputController({state,actions,$,canvas:{addEventListener(){}}});controller.wire();
    assert.equal($('exportLog').onclick,actions.exportRuntimeLog);
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
  assert.deepEqual(state.saveMenu.entries[0].summary,summaryOf(existing));
  await actions.selectSaveSlot(state.saveMenu.entries.find(row=>row.slot==='01'));
  assert.equal(storageCalls.length,1);assert.equal(storageCalls[0].slot,'01');assert.equal(storageCalls[0].createOnly,true);assert.equal(storageCalls[0].options.expectedSha,undefined);
  assert.equal(files.get('00'),existing);assert.deepEqual(state.saveSlots['00'],summaryOf(existing));assert.deepEqual(state.saveSlots['01'],summaryOf(files.get('01')));
  assert.equal(state.scenes.phase,'save-menu');assert.match(state.saveMenu.message,/栏位 01 已保存/);
  state.saveMenu.key('Escape');await opened;
  assert.equal(state.scenes.phase,'map');assert.equal(state.saveMenu.active,false);assert.equal(state.saveMenuContext,null);
});

test('slot page passes the displayed save fingerprint to overwrite and blocks closing or other saves during I/O',async()=>{
  const {state,actions,files}=fixture(),existing=await encodeSave(seed),gate=deferred(),entered=deferred();files.set('00',existing);
  const opened=actions.openSaveCrystal();await settled();
  let write;
  state.saveStorage.write=async(envelope,slot,createOnly,options)=>{write={envelope,slot,createOnly,options};entered.resolve();await gate.promise;files.set(slot,envelope);return {path:'remake/saves/SaveGame0.Dat',summary:summaryOf(envelope)};};
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
  await assert.rejects(actions.selectSaveSlot({slot:'02',summary:null}),/disk full/);
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

test('an original-save world opens the party menu, saves either slot kind and restores learned shortcuts without origin metadata',async()=>{
  const native=structuredClone(seed);native.source={kind:'native-save',path:'Game.SAV',sha256:'1'.repeat(64)};
  native.play_time_ms=90123;native.game_settings=structuredClone(DEFAULT_GAME_SETTINGS);
  native.equipment={version:1,roles:{'001':[]}};native.formation_slots=[null,null,null,'001'];
  const learned=partySkills.roles['001'].skills.find(skill=>!skill.learned_raw&&(skill.type_flags_u32_0x32&15)!==0).original_skill_index;
  native.party[0].skill_progress={version:1,learned_indices:[learned]};
  native.skill_shortcuts={version:1,roles:{'001':[learned,learned,learned]}};
  const header=Buffer.from(native.party[0].combat_progress.header_raw_hex,'hex');header.writeInt32LE(75,0x7a);
  native.party[0].combat_progress.header_raw_hex=header.toString('hex');
  const {state,actions,$,canvas,files,storageCalls}=fixture(native),rendered=[];
  state.audio={playCue(){},snapshot:()=>({channels:structuredClone(DEFAULT_GAME_SETTINGS.audio),volume:1,muted:false})};state.menuSettings={snapshot:()=>({battleCursor:'memory'})};
  state.operationMenu={focusInitial(){},page(){},suspend(){},stats(){},roster(rows){rendered.push(...rows);},mnuText(){},items(){},itemButtons:new Map(),
    manifest:{},equipment(){},equipmentView:{render(){}},weapon(){},system:{render(){}}};
  actions.readConfiguredData=async()=>({items:{...itemData,runtime_configuration:{differences:[]}},party_skills:partySkills,audit:{mode:'original'}});
  Object.assign(actions,createMenuController({state,actions,$,canvas}));
  await actions.openPartyMenu();
  assert.equal(state.scenes.phase,'party-menu');assert.equal($('partyMenu').hidden,false);
  assert.equal(rendered[0].hp.current,native.party[0].hp.current);assert.ok(rendered[0].elements.includes(75));
  actions.closePartyMenu();assert.equal(state.scenes.phase,'map');
  const picker=actions.openSaveCrystal();await settled();await actions.selectSaveSlot(state.saveMenu.entries.find(row=>row.slot==='19'));
  actions.closeSaveMenu();await picker;await actions.saveProgress('quick');
  assert.deepEqual(storageCalls.map(row=>row.slot),['19','quick']);
  const saved=await decodeSave(files.get('19'));assert.deepEqual(saved,native);
  state.world.transact(draft=>{draft.party[0].hp.current-=9;draft.money+=17;draft.formation_slots=['001',null,null,null];});
  await actions.loadProgress('quick');
  assert.deepEqual(state.world.snapshot(),native);assert.equal(state.scenes.phase,'map');
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
  assert.deepEqual(state.saveMenu.entries[0].summary,summaryOf(newer));assert.equal(state.scenes.phase,'save-menu');actions.closeSaveMenu();await opened;
});

test('runtime log download exports only the latest fight without cloning or serializing a whole battle',async()=>{
  const {state,actions}=fixture(),raw='00'.repeat(2000),history=Array.from({length:64},(_,index)=>({action_id:`action-${index}`,before:{native_status_slots:[{raw_hex:raw}]},contacts:[{damage:index}]}));
  state.logs=history.map((entry,index)=>({sequence:index+1,type:'battle-action',entry}));
  state.battle={state:{id:'older-controller',phase:'closed',history:[{action_id:'old-action'}]},snapshot:()=>assert.fail('Export must not clone the current battle history')};
  state.lastBattle={result:{outcome:'escaped'},battle:{id:'latest-technique-test',phase:'closed',history}};
  state.audio={snapshot:()=>({muted:false})};state.catalog.scope='保留完整诊断记录';
  const expected={schema:'seventh-seal-runtime-log',version:3,events:state.logs,current_battle:state.lastBattle.battle,battle_result:state.lastBattle.result,world:state.world.snapshot(),audio:state.audio.snapshot(),scope:state.catalog.scope};
  const before=structuredClone(expected),stringify=JSON.stringify,previousDocument=globalThis.document,create=URL.createObjectURL,revoke=URL.revokeObjectURL,timeout=globalThis.setTimeout;
  const anchor={click(){this.clicked=true;}},timers=[],revoked=[];let blob,maxChunk=0;
  try{
    globalThis.document={createElement:kind=>{assert.equal(kind,'a');return anchor;}};
    URL.createObjectURL=value=>{blob=value;return 'blob:runtime-log';};URL.revokeObjectURL=url=>revoked.push(url);
    globalThis.setTimeout=callback=>{timers.push(callback);return 1;};
    JSON.stringify=(value,...options)=>{
      assert.notEqual(value,expected);assert.notEqual(value,state.logs);assert.notEqual(value,state.lastBattle.battle);assert.notEqual(value,state.battle.state);assert.notEqual(value,history);
      const text=stringify(value,...options);maxChunk=Math.max(maxChunk,text.length);return text;
    };
    actions.exportRuntimeLog();
  }finally{JSON.stringify=stringify;globalThis.document=previousDocument;URL.createObjectURL=create;URL.revokeObjectURL=revoke;globalThis.setTimeout=timeout;}
  assert.equal(anchor.clicked,true);assert.equal(anchor.download,'seventh-seal-runtime-log.json');assert.ok(blob instanceof Blob);assert.equal(blob.type,'application/json');
  const exported=await blob.text();assert.deepEqual(JSON.parse(exported),before);assert.deepEqual(expected,before);
  const worldMetadataLength=stringify({world:expected.world,audio:expected.audio,scope:expected.scope}).length;
  assert.ok(maxChunk<=Math.max(worldMetadataLength,exported.length/8),'Only one event, action or the world metadata block is serialized at once');
  // The delayed revocation belongs to the normal download adapter.
  URL.revokeObjectURL=url=>revoked.push(url);try{timers.forEach(callback=>callback());}finally{URL.revokeObjectURL=revoke;}
  assert.deepEqual(revoked,['blob:runtime-log']);
  assert.equal(Object.hasOwn(JSON.parse(exported),'battle_history'),false);assert.ok(!exported.includes('old-action'));
  state.battle=null;state.lastBattle=null;state.logs=[];
  try{
    globalThis.document={createElement:()=>anchor};URL.createObjectURL=value=>{blob=value;return 'blob:empty-log';};globalThis.setTimeout=()=>1;
    actions.exportRuntimeLog();
  }finally{globalThis.document=previousDocument;URL.createObjectURL=create;globalThis.setTimeout=timeout;}
  const empty=JSON.parse(await blob.text());assert.equal(empty.current_battle,null);assert.equal(empty.battle_result,null);assert.equal(Object.hasOwn(empty,'battle_history'),false);assert.deepEqual(empty.events,[]);
});
