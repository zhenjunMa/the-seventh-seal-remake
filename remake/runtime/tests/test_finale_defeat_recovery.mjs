// The unedited browser capture is the regression input, including its full
// source/configuration/contact records. No fixture rewrites the HP formula.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {planPartyDefeat} from '../web/core/recovery.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {partyResourcesForWorld} from '../web/core/party_attributes.mjs';
import {WorldStore} from '../web/core/world.mjs';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {createBattleController} from '../web/controllers/battle.mjs';
import {createStoryController} from '../web/controllers/story.mjs';
import {createSessionController} from '../web/controllers/session.mjs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {battleResources} from '../web/core/battle_resources.mjs';
import {skillOwner,runtimeSkillParameters} from '../web/core/skill_registry.mjs';
import {supportedBattleRecoverySkills} from '../web/core/battle_skill_access.mjs';
const copy=structuredClone,read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const captureUrl=new URL('../evidence/fire_valley_20261025/browser_diagnostic/delivery_finale_defeat_validation_failure_log.json',import.meta.url);
const captureBytes=await readFile(captureUrl),capture=JSON.parse(captureBytes),terminal=capture.battle_history.at(-1);
const captureHash=createHash('sha256').update(captureBytes).digest('hex');
const [story,partyCombat,partySkills,partyReactions,statusData]=await Promise.all(['chapter_story','party_combat','party_skills','party_reactions','forest_status'].map(read));
const configured=Object.fromEntries(await Promise.all(Object.entries({combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',items:'items'}).map(async([key,name])=>[key,await read(name)])));
configured.skill_registry=Object.fromEntries(Object.entries({...partySkills.skills,...supportedBattleRecoverySkills(partySkills)}).map(([id,skill])=>[id,{...copy(skill),configuration:{owner:skillOwner(skill,'player'),original:runtimeSkillParameters(skill)}}]));

test('the complete captured stage12 defeat accepts category7 with equipment display HP and preserves every source byte/value',()=>{
  assert.equal(terminal.result.outcome,'defeat');assert.equal(terminal.result.rewards_applied,false);
  assert.equal(captureHash,'5adac71a20aec9904a1eab35c9eb5ef034b9efdb760bf12ff641cad0db48fd42');
  const battle=copy(terminal.battle),before=copy(battle),players=battle.actors.filter(actor=>actor.side==='player');
  assert.deepEqual(players.map(actor=>[actor.id,actor.raw_hp,actor.hp.current,actor.state_raw]),[
    ['001',-24552,0,7],['002',-24948,0,7],['004',-22869,0,7],['005',0,28215,7]]);
  assert.deepEqual(battle.lifecycle_events,[]);assert.equal(battle.pending_outcome,null);
  const policy=planPartyDefeat({battle});
  assert.equal(policy.mode,'game-over');assert.equal(policy.can_explore,false);assert.equal(policy.can_save,false);assert.equal(policy.can_award_rewards,false);
  assert.deepEqual(battle,before);
});

test('completed-death admission never converts live, escaped, airborne, active, or unfinished source actors into defeat',()=>{
  const changes=[
    actor=>{actor.state_raw=0;}, // rawHP0 with a positive equipment bonus is live until category4 submission.
    actor=>{actor.state_raw=0;actor.raw_hp=1;actor.hp.current=1;},
    actor=>{actor.state_raw=0;actor.hp.current=0;}, // A source category cannot be replaced by the legacy display-HP contract.
    actor=>{actor.state_raw=11;actor.hp.current=0;},
    actor=>{actor.escaped=true;actor.hp.current=0;},
    actor=>{actor.state_raw=4;actor.native_z_raw=-12;actor.hp.current=0;},
    actor=>{actor.state_raw=4;actor.hp.current=0;},
    actor=>{actor.state_raw=5;actor.hp.current=0;},
    actor=>{actor.native_z_raw=-1;},
    actor=>{actor.native_active=true;},
  ];
  for(const change of changes){
    const battle=copy(terminal.battle);change(battle.actors.find(actor=>actor.id==='005'));const before=copy(battle);
    assert.throws(()=>planPartyDefeat({battle}),/仍有可继续/);assert.deepEqual(battle,before);
  }
  for(const patch of [{pending_outcome:'defeat'},{lifecycle_events:[{kind:'death',actor_id:'005'}]}]){
    const battle={...copy(terminal.battle),...patch};assert.throws(()=>planPartyDefeat({battle}),/仍有可继续/);
  }
  const battle=copy(terminal.battle),enemy=battle.actors.find(actor=>actor.side==='enemy'),header=Buffer.from(enemy.header_raw_hex,'hex');
  header.writeUInt32LE(1,0x20a);enemy.header_raw_hex=header.toString('hex');
  assert.throws(()=>planPartyDefeat({battle}),/专属败北剧情/);
});

class Node{
  constructor(doc){Object.assign(this,{ownerDocument:doc,childNodes:[],parentNode:null,style:{},dataset:{},hidden:false,attributes:{}});doc.nodes.push(this);}
  append(...nodes){for(const node of nodes){node.remove();this.childNodes.push(node);node.parentNode=this;}}
  replaceChildren(...nodes){for(const child of this.childNodes)child.parentNode=null;this.childNodes=[];this.append(...nodes);}
  remove(){if(this.parentNode){const siblings=this.parentNode.childNodes;siblings.splice(siblings.indexOf(this),1);this.parentNode=null;}}
  setAttribute(key,value){this.attributes[key]=value;}getAttribute(key){return this.attributes[key];}
  getContext(){return {};}getBoundingClientRect(){return {width:640,height:480};}focus(){}
  play(){queueMicrotask(()=>this.onended?.());return Promise.resolve();}pause(){}
}
const original={observer:globalThis.ResizeObserver,json:battleResources.json,prepare:BattleMenuView.prototype.prepare,update:BattleMenuView.prototype.update};
globalThis.ResizeObserver=class{observe(){}unobserve(){}disconnect(){}};
battleResources.json=path=>read(path.replace(/^data\//,'').replace(/\.json$/,''));
BattleMenuView.prototype.prepare=async function(){};
BattleMenuView.prototype.update=function(snapshot){this.snapshot=snapshot;};
after(()=>{globalThis.ResizeObserver=original.observer;battleResources.json=original.json;BattleMenuView.prototype.prepare=original.prepare;BattleMenuView.prototype.update=original.update;});
function fixture(){
  const world=new WorldStore(copy(capture.world)),events=[],doc={nodes:[],createElement(){return new Node(doc);},getElementById(id){return this.nodes.find(node=>node.id===id&&node.parentNode)??null;}},nodes=new Map();
  const $=id=>{if(!nodes.has(id)){const node=doc.createElement();node.id=id;nodes.set(id,node);}return nodes.get(id);};
  const scene={data:{id:world.location.map_id}},canvas={hidden:false,focus(){}},cached={async prepare(){},setRoster(){},stop(){},draw(){},actorPositions(){return [];}};
  const state={world,partyCombat,partySkills,partyReactions,statusData,catalog:{},view:{x:100,y:200},battleHistory:[],keys:new Set(),
    sidePriority:0,anmVisualState:{shakeCycles:10,shakeAmplitudeNative:4},battleCursorMemory:new Map(),
    openingView:{active:true,actors:new Map(),dispose(){this.active=false;}},battleViews:new Map([['scripted:/data/stages/stage12.json',cached]]),
    scenes:{phase:'map',current:scene,setPhase(phase){events.push({type:'phase',phase});this.phase=phase;},captureView(){return copy(state.view);},rollbackView(value){Object.assign(state.view,value);}},
    startupView:{showMenu(options){events.push({type:'title',options});}},audio:{suspend(){},setScene(){}}};
  const actions={json:async()=>({}),readConfiguredData:async()=>copy(configured),resize(){},buildHud(){},updateNearest(){},commitView(){},
    status:message=>events.push({type:'status',message}),log:event=>events.push(event),guarded:fn=>fn};
  const battleController=createBattleController({state,actions,$,canvas}),storyController=createStoryController({state,actions,$,canvas});
  Object.assign(actions,createSessionController({state,actions,$,canvas,completionStorage:{getItem(){return null;},setItem(){throw Error('defeat must not write completion metadata');}}}));
  state.chapterRunner=new ChapterRunner({world,data:story,setPhase:phase=>state.scenes.setPhase(phase),log:actions.log,say:async()=>{},battle:request=>battleController.startScriptedBattle(request)});
  return {world,state,events,$,canvas,actions,battleController,storyController,scene};
}
async function until(predicate){for(let turn=0;turn<250;turn++){if(predicate())return;await new Promise(resolve=>setImmediate(resolve));}throw Error('defeat controller fixture did not reach its checkpoint');}

test('captured completed defeat returns through real battle, story transaction and game-over controllers without committing the ANM draft or rewards',async()=>{
  const f=fixture(),before=f.world.snapshot(),beforeSide=f.state.sidePriority;
  const running=f.storyController.runChapter({mapId:'M17030-2',recordId:31});
  await until(()=>f.state.scenes.phase==='battle-charging');
  const core=f.state.battle,session=f.state.scriptedBattleSession;
  // Restore the completed capture to the immediately-before-finish boundary;
  // every actor, resource, raw record, contact and RNG source stays unchanged.
  core.state=copy(terminal.battle);core.state.phase='defeat';core.completed=null;
  const sourceActors=copy(core.state.actors),draftBefore=copy(session.simulation.before);
  f.state.scenes.setPhase('battle-result');await f.battleController.returnFromBattle();await running;
  assert.equal(core.completed.outcome,'defeat');assert.equal(core.completed.rewards_applied,false);
  assert.deepEqual(core.completed.resources_by_actor,terminal.result.resources_by_actor,'native DWORD resources survive finish without replacing the HP formula');
  assert.deepEqual(core.state.actors.map(a=>({id:a.id,raw_hp:a.raw_hp,hp:a.hp,state_raw:a.state_raw})),sourceActors.map(a=>({id:a.id,raw_hp:a.raw_hp,hp:a.hp,state_raw:a.state_raw})));
  assert.deepEqual(f.world.snapshot(),before);assert.deepEqual(session.simulation.before,draftBefore);
  assert.equal(f.state.sidePriority,beforeSide);assert.equal(f.state.scriptedBattleSession,null);assert.equal(f.state.storyPlayback,null);
  assert.equal(f.state.openingView,null);assert.equal(f.state.chapterRunner.running,false);assert.equal(f.state.scenes.current,f.scene);
  assert.equal(f.state.scenes.phase,'menu');assert.equal(f.$('menuResume').hidden,true);
  assert.ok(f.events.some(event=>event.type==='phase'&&event.phase==='game-over'));
  assert.deepEqual(f.events.find(event=>event.type==='title').options,{allowResume:false});
  const gameOver=f.events.find(event=>event.type==='game-over');assert.equal(gameOver.policy.mode,'game-over');assert.equal(gameOver.playback_error,null);
  assert.equal(f.events.some(event=>event.type==='chapter-commit'),false);assert.equal(f.events.some(event=>event.type==='story-complete'),false);
  assert.equal(f.state.battleHistory.length,1);assert.equal(f.state.battleHistory[0].result.outcome,'defeat');
});

test('the adjacent ordinary battle return uses the same completed native defeat without replacing raw world resources or awarding rewards',async()=>{
  const f=fixture(),before=f.world.snapshot(),battle=new BattleController({world:f.world,resourcesForWorld:partyResourcesForWorld,log:f.actions.log});
  battle.state=copy(terminal.battle);battle.state.phase='defeat';battle.expectedRevision=f.world.value.revision;battle.pendingCarriers=new Set();
  Object.assign(f.state,{battle,battleView:{stop(){}},battleNatural:true,battleRng:{state:123456},battleCheckpoint:{x:100,y:200}});
  f.state.scenes.setPhase('battle-result');await f.battleController.returnFromBattle();
  assert.equal(f.state.scenes.phase,'menu');assert.equal(f.$('menuResume').hidden,true);
  assert.ok(f.events.some(event=>event.type==='game-over'));assert.equal(battle.completed.rewards_applied,false);
  for(const actor of f.world.value.party)assert.equal(actor.hp.current,terminal.result.resources_by_actor[actor.id].hp);
  assert.deepEqual(f.world.value.inventory,before.inventory);assert.equal(f.world.value.money,before.money);assert.deepEqual(f.world.value.reward_records,before.reward_records);
  assert.equal(f.world.value.encounters.rng_state,123456);assert.equal(f.state.battleHistory.length,1);
});
