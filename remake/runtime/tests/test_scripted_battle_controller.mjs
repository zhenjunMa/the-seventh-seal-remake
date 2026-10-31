// Browser-controller lifecycle fixtures. Combat outcomes are adapter inputs;
// source arithmetic/rewards are covered separately by their native oracles.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBattleController} from '../web/controllers/battle.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {ChapterAnimationRunner} from '../web/core/chapter_animation.mjs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {battleResources} from '../web/core/battle_resources.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {StoryPlayback} from '../web/core/story_playback.mjs';
import {nativeScriptedBattle} from '../web/core/scripted_battle.mjs';
import {skillOwner,runtimeSkillParameters} from '../web/core/skill_registry.mjs';
import {supportedBattleRecoverySkills} from '../web/core/battle_skill_access.mjs';
const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,story,partyCombat,partySkills,partyReactions,statusData]=await Promise.all(['opening_seed','chapter_story','party_combat','party_skills','party_reactions','forest_status'].map(read));
const configured=Object.fromEntries(await Promise.all(Object.entries({combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',items:'items'}).map(async([key,name])=>[key,await read(name)])));
// Use current immutable source parameters directly. This lifecycle fixture
// does not read or rewrite the user's editable numeric configuration files.
configured.skill_registry=Object.fromEntries(Object.entries({...partySkills.skills,...supportedBattleRecoverySkills(partySkills)}).map(([id,skill])=>[id,{...copy(skill),configuration:{owner:skillOwner(skill,'player'),original:runtimeSkillParameters(skill)}}]));
const group=nativeScriptedBattle(story.maps['M17030-2'],story.maps['M17030-2'].records.find(row=>row.id===31));
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
class Node{
  constructor(doc){Object.assign(this,{ownerDocument:doc,childNodes:[],parentNode:null,style:{},dataset:{},hidden:false,attributes:{}});doc.nodes.push(this);}
  append(...nodes){for(const node of nodes){node.remove();this.childNodes.push(node);node.parentNode=this;}}
  replaceChildren(...nodes){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this.append(...nodes);}
  remove(){if(this.parentNode){const siblings=this.parentNode.childNodes;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
  setAttribute(key,value){this.attributes[key]=value;}getAttribute(key){return this.attributes[key];}
  getContext(){return {};}getBoundingClientRect(){return {width:640,height:480};}focus(){}
}
const oldObserver=globalThis.ResizeObserver,oldJson=battleResources.json,oldPrepare=BattleMenuView.prototype.prepare,oldUpdate=BattleMenuView.prototype.update;
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
battleResources.json=path=>read(path.replace(/^data\//,'').replace(/\.json$/,''));
let hudPreparation=null;
BattleMenuView.prototype.prepare=async function(){this.testPrepareStarted=true;if(hudPreparation)await hudPreparation.promise;};
BattleMenuView.prototype.update=function(snapshot){this.snapshot=snapshot;};
after(()=>{globalThis.ResizeObserver=oldObserver;battleResources.json=oldJson;BattleMenuView.prototype.prepare=oldPrepare;BattleMenuView.prototype.update=oldUpdate;});
function fixture({jsonGate=null,configGate=null,viewGate=null}={}){
  const doc={nodes:[],createElement(){return new Node(doc);},getElementById(id){return this.nodes.find(node=>node.id===id&&node.parentNode)??null;}},nodes=new Map();
  const $=id=>{if(!nodes.has(id)){const node=doc.createElement();node.id=id;nodes.set(id,node);}return nodes.get(id);};
  const oldButton=doc.createElement();oldButton.id='battleReturn';$('battleHud').append(oldButton);
  $('openingShade').hidden=false;$('openingShade').style.opacity='0.7';$('dialogue').hidden=true;
  const value=copy(seed);value.opening.status='complete';value.location={map_id:'M17030-2',x:608,y:1408,direction:2};
  const world=new WorldStore(value),draft=world.snapshot(),canvas={hidden:false,focus(){}},events=[];
  const previous={battle:null,battleView:{previous:true},battleMenu:{disposed:false,dispose(){this.disposed=true;}},battleRng:null,battleNatural:false,
    battleCursorMemory:new Map([['001',1]]),sidePriority:0,battlePresentationError:null,battleEntryPending:false,itemData:null};
  const cached={stops:0,rosters:0,async prepare(){events.push('prepare-view');if(viewGate)await viewGate.promise;},setRoster(){this.rosters++;},stop(){this.stops++;},draw(){},actorPositions(){return [];}};
  const state={...previous,world,partyCombat,partySkills,partyReactions,statusData,catalog:{},view:{x:100,y:200},battleHistory:[],
    openingView:{active:true,actors:new Map([['sentinel',{}]]),dispose(){this.active=false;}},battleViews:new Map([['scripted:/data/stages/stage12.json',cached]]),
    scenes:{phase:'event',setPhase(value){this.phase=value;}},audio:{setScene(value){events.push(value);}}};
  const actions={json:()=>jsonGate?jsonGate.promise:Promise.resolve({}),readConfiguredData:()=>configGate?configGate.promise:Promise.resolve(copy(configured)),
    resize(){},status(){},log:event=>events.push(event),guarded:fn=>fn};
  const playback=new StoryPlayback(),controller=createBattleController({state,actions,$,canvas});
  return {state,previous,world,draft,canvas,events,$,oldButton,cached,playback,controller,actions,run:(options={})=>controller.startScriptedBattle({group,draft,playback,...options})};
}
async function until(predicate){
  // Real manifest reads need I/O time; a fixed number of immediate turns can
  // expire before the filesystem callback during the full source suite.
  const deadline=Date.now()+10000;
  while(Date.now()<deadline){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('controller fixture did not reach its checkpoint');
}
async function entered(f){
  await until(()=>f.state.scenes.phase==='battle-entry');
  // This controller fixture supplies presentation completion explicitly.
  for(const event of [...f.state.battle.presentationSnapshot().lifecycle_events])if(event.kind==='entry')assert.equal(f.state.battle.ackLifecycle(event),true);
  assert.equal(f.state.scenes.phase,'battle-charging');
}
async function cancel(f,running){f.playback.cancel();await assert.rejects(running,{name:'AbortError'});assert.equal(f.state.scenes.phase,'event');assert.equal(f.state.scriptedBattleSession,null);}
test('cancellation settles while JSON/configuration resources remain unresolved and late completion cannot install state',async()=>{
  for(const kind of ['json','config']){
    const gate=deferred(),f=fixture(kind==='json'?{jsonGate:gate}:{configGate:gate}),before=f.world.snapshot(),running=f.run();
    await cancel(f,running);const sentinel={next:true};f.state.battleView=sentinel;f.$('battleHud').replaceChildren(f.oldButton);
    gate.resolve(kind==='json'?{}:copy(configured));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.state.battleView,sentinel);assert.deepEqual(f.$('battleHud').childNodes,[f.oldButton]);assert.deepEqual(f.world.snapshot(),before);
    assert.equal(f.previous.battleMenu.disposed,false);assert.equal(f.state.sidePriority,0);
  }
});
test('cancelling cached view preparation leaves the cache reusable and ignores its late result',async()=>{
  const gate=deferred(),f=fixture({viewGate:gate}),running=f.run();await until(()=>f.events.includes('prepare-view'));await cancel(f,running);
  const sentinel={next:true};f.state.battleView=sentinel;gate.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.battleView,sentinel);assert.equal(f.cached.rosters,0);assert.equal(f.cached.stops,0);assert.equal(f.previous.battleMenu.disposed,false);
});
test('pending detached HUD cannot steal an old return button or install after cancellation, including unstarted battle cleanup',async()=>{
  hudPreparation=deferred();const gate=hudPreparation,f=fixture(),running=f.run();await until(()=>f.state.scriptedBattleSession?.menu?.testPrepareStarted);
  assert.deepEqual(f.$('battleHud').childNodes,[f.oldButton]);assert.equal(f.state.battle.state,null);
  assert.equal(f.state.scenes.phase,'battle-loading');
  assert.deepEqual(f.events.filter(event=>event.battle),[{mapId:f.draft.location.map_id,battle:true,stageId:group.stage}]);
  await cancel(f,running);const replacement=f.$('battleHud').ownerDocument.createElement();f.$('battleHud').replaceChildren(replacement);
  gate.resolve();hudPreparation=null;await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.$('battleHud').childNodes,[replacement]);assert.equal(f.state.battle,f.previous.battle);assert.equal(f.previous.battleMenu.disposed,false);
});
for(const outcome of ['victory','escaped'])test(`${outcome} return retains final side priority, merges private resources/RNG once and restores the active ANM scene and shade`,async()=>{
  const f=fixture(),before=f.world.snapshot(),running=f.run();await entered(f);
  const battle=f.state.battle,session=f.state.scriptedBattleSession;
  battle.state.scheduler.side_priority=1;battle.finish=()=>{battle.state.phase='closed';session.simulation.world.transact(next=>{next.party[0].hp.current=7;next.money+=10;});return {outcome};};
  f.state.scenes.setPhase('battle-result');await f.controller.returnFromBattle();await running;
  assert.equal(f.state.sidePriority,1);assert.equal(f.draft.party[0].hp.current,7);assert.equal(f.draft.money,before.money+10);
  assert.equal(f.draft.encounters.rng_state,session.simulation.rng.state);assert.equal(f.draft.revision,before.revision);assert.deepEqual(f.world.snapshot(),before);
  assert.equal(f.state.openingView.active,true);assert.equal(f.state.scenes.phase,'event');assert.deepEqual(f.state.view,{x:100,y:200});
  assert.equal(f.$('openingShade').hidden,false);assert.equal(f.$('openingShade').style.opacity,'0.7');assert.deepEqual(f.$('battleHud').childNodes,[f.oldButton]);
  assert.equal(f.state.battleHistory.length,1);await f.controller.returnFromBattle();assert.equal(f.state.battleHistory.length,1);
});
test('cancelled active combat and a delayed retired combat publish cannot reclaim the ANM phase or a subsequent HUD',async()=>{
  const f=fixture(),before=copy(f.draft),running=f.run();await entered(f);const retired=f.state.battle;
  await cancel(f,running);const next={fresh:true};f.state.battle=next;const node=f.$('battleCommands');node.dataset.phase='fresh';
  retired.interrupt(new Error('late playSequence rejection'));
  assert.equal(f.state.scenes.phase,'event');assert.equal(node.dataset.phase,'fresh');assert.equal(f.state.battle,next);assert.deepEqual(f.draft,before);assert.equal(f.state.sidePriority,0);
});
test('late cancelled entry-transition callbacks cannot reveal battle or overwrite the restored story HUD',async()=>{
  const f=fixture(),gate=deferred();let paint,started=false;
  f.state.battleTransition={capture(){return {};},async run(_before,callback){paint=callback;started=true;await gate.promise;return callback();},cancel(){}};
  const running=f.run();await until(()=>started);await cancel(f,running);
  const next=f.$('battleHud').ownerDocument.createElement();f.$('battleHud').replaceChildren(next);
  assert.throws(()=>paint(),/会话已失效/);gate.resolve();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.scenes.phase,'event');assert.equal(f.state.battleEntryPending,false);assert.deepEqual(f.$('battleHud').childNodes,[next]);assert.equal(f.canvas.hidden,false);
});
test('failed return rolls back side priority and private battle mutations',async()=>{
  const f=fixture(),before=copy(f.draft),running=f.run();await entered(f);
  const battle=f.state.battle,session=f.state.scriptedBattleSession;battle.state.scheduler.side_priority=1;
  battle.finish=()=>{battle.state.phase='closed';session.simulation.world.transact(next=>{next.money+=10;});return {outcome:'interrupted'};};
  f.state.scenes.setPhase('battle-interrupted');await f.controller.returnFromBattle();await assert.rejects(running,/中止/);
  assert.equal(f.state.sidePriority,0);assert.deepEqual(f.draft,before);assert.equal(f.state.scenes.phase,'event');
});
test('whole-party defeat propagates game-over policy, restores the story owner and leaves the caller draft uncommitted',async()=>{
  const f=fixture(),before=copy(f.draft),running=f.run();await entered(f);
  const battle=f.state.battle;battle.state.outcome='defeat';
  for(const actor of battle.state.actors)if(actor.side==='player'){actor.hp.current=0;actor.state_raw=7;actor.native_active=false;}
  battle.state.lifecycle_events=[];battle.state.pending_outcome=null;
  battle.finish=()=>{battle.state.phase='closed';return {outcome:'defeat'};};
  f.state.scenes.setPhase('battle-result');await f.controller.returnFromBattle();
  await assert.rejects(running,error=>error.gameOverPolicy?.mode==='game-over'&&error.gameOverPolicy.can_save===false);
  assert.deepEqual(f.draft,before);assert.equal(f.state.scenes.phase,'event');assert.equal(f.state.scriptedBattleSession,null);assert.equal(f.state.sidePriority,0);
});
test('outer story failure rolls back a successful nested battle priority and completed native ANM camera parameters',async()=>{
  const f=fixture();f.state.anmVisualState={shakeCycles:10,shakeAmplitudeNative:4};const visual=f.state.anmVisualState;
  const controller=createStoryController({state:f.state,actions:f.actions,$:f.$,canvas:f.canvas});
  const running=controller.playStory(async playback=>{
    const hooks=Object.fromEntries(['map','actor','move','camera','wait','fade','media','sound'].map(name=>[name,async()=>{}]));
    await new ChapterAnimationRunner({program:story.programs['m17030-1'],hooks,visualState:visual,playback,
      initialLocation:{map_id:'M17032',x:640,y:480,direction:0},runTlk:async()=>{},joinActor:async()=>{},leaveActor:async()=>{},flagCommand:()=>({nextIndex:null})}).run();
    assert.deepEqual(visual,{shakeCycles:40,shakeAmplitudeNative:10});
    const battleRun=f.run({playback});await entered(f);const battle=f.state.battle;
    battle.state.scheduler.side_priority=1;battle.finish=()=>{battle.state.phase='closed';return {outcome:'victory'};};
    f.state.scenes.setPhase('battle-result');await f.controller.returnFromBattle();await battleRun;assert.equal(f.state.sidePriority,1);
    throw new Error('later movie failed');
  });
  await assert.rejects(running,/later movie failed/);assert.equal(f.state.sidePriority,0);assert.equal(f.state.anmVisualState,visual);
  assert.deepEqual(visual,{shakeCycles:10,shakeAmplitudeNative:4});assert.equal(f.state.storyPlayback,null);
});
test('outer rollback never overwrites a replaced world, its revision, or a newer story owner',async()=>{
  for(const replacement of ['revision','same-revision-world','owner']){
    const f=fixture(),gate=deferred();f.state.anmVisualState={shakeCycles:10,shakeAmplitudeNative:4};
    const controller=createStoryController({state:f.state,actions:f.actions,$:f.$,canvas:f.canvas});
    const running=controller.playStory(async()=>{await gate.promise;throw new Error('retired story failed');});
    f.state.sidePriority=1;f.state.anmVisualState.shakeCycles=40;let newer;
    if(replacement==='revision')f.world.transact(next=>{next.money++;});
    else if(replacement==='same-revision-world')f.world.replace(f.world.snapshot());
    else{newer=new StoryPlayback();f.state.storyPlayback=newer;}
    gate.resolve();await assert.rejects(running,/retired story failed/);
    assert.equal(f.state.sidePriority,1);assert.equal(f.state.anmVisualState.shakeCycles,40);
    if(newer){assert.equal(f.state.storyPlayback,newer);assert.equal(f.state.openingView.active,true);newer.dispose();}
  }
});
