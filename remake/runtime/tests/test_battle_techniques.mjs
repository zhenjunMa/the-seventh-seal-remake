import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {createTechniqueCombination,changeTechniqueSlot,techniqueSlots} from '../web/core/menu_techniques.mjs';
import {battleTechniqueId} from '../web/core/battle_techniques.mjs';
import {deriveRuntimeConfiguration,compileRuntimeConfiguration} from '../web/core/runtime_config.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/combat.mjs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {BattleView} from '../web/battle_view.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {compileNativeSequence,composeNativeSequence} from '../web/core/skill_sequence.mjs';
import {resolveAction,applyNativeDamage,createNativeRng} from '../web/core/combat_rules.mjs';
import {consumePartyMp,partyResourcesForWorld} from '../web/core/party_attributes.mjs';

const read=async name=>JSON.parse(await readFile(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
const names={combat:'combat_sample',forest:'forest_combat',scheduler:'battle_scheduler',ai:'forest_ai',rewards:'party_rewards',party_skills:'party_skills',items:'items'};
const data=Object.fromEntries(await Promise.all(Object.entries(names).map(async([key,name])=>[key,await read(name)])));
const [attributes,meta,reactions,statuses,ui]=await Promise.all(['party_combat','party_battle_view','party_reactions','forest_status','operation_techniques'].map(read));
const initial=JSON.parse(JSON.parse(await readFile(new URL('../evidence/chapter_systems_home_save.json',import.meta.url),'utf8')).payload);
const config=deriveRuntimeConfiguration(data),copy=structuredClone;
config.manifest.mode='debug';
for(const [id,cost,delay]of [['yanci',2,101],['yantu',3,203],['yancui',5,307],['kai_mieyan',4,409],['kai_suizu',6,503]])
  Object.assign(config.skills.entries[id].parameters,{mp_cost:cost,preparation_delay_raw:delay});
const configured=compileRuntimeConfiguration(data,config),source=data.party_skills;
const add=(world,indices,roleId='001')=>createTechniqueCombination(world,source,{roleId,indices,nameCodes:[1,7,45],icon:9,capacity:7});
function party(world){return createPartySample(world.snapshot(),attributes,source,configured,data.items,ui.name_charset);}

function fixture({indices=[21,22],testMode=false,defer=null}={}){
  const world=new WorldStore(copy(initial));add(world,indices);
  const scheduler={...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...source.idle_skills}};
  const sample=assembleForestSample(party(world),configured.forest,{map_id:'M70010',members:[{id:'012'},{id:'013'}]},scheduler,configured.ai,null,reactions,statuses);
  const logs=[],sources=[],consumed=[];let now=0,battle;
  battle=new BattleController({world,id:()=> 'composed-test',now:()=>now,waitTick:async()=>{now+=20;},log:event=>logs.push(event),
    resolveAction:input=>{sources.push(copy(input.skill));return resolveAction(input);},applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,
    consumeResources:(actor,cost)=>{consumed.push([actor.id,cost]);return consumePartyMp(actor,cost);},
    playSequence:async(event,hooks)=>{
      const actor=battle.actor(event.actor_id),compiled=compileNativeSequence(meta,actor.resource_id,event.plan);
      for(const step of compiled.steps){
        hooks.onRecord(step);if(!step.event)continue;
        const contact={...step,contact_key:event.action_id+':'+step.index},result=hooks.onContact(contact);
        assert.deepEqual(hooks.onContact(contact),result,'replayed frames must not repeat contacts');
        if(result.reaction_descriptor)hooks.onReactionEnd(result.reaction_descriptor,true);
      }
      if(defer)await defer;
      hooks.onPrimaryEnd();return {completed:true};
    }});
  battle.start({...sample,test_mode:testMode,rng:createNativeRng(12345)});
  for(const actor of battle.state.actors){actor.charge.gauge=0;actor.charge.delay=1000000;
    if(actor.side==='enemy'){actor.raw_hp=1000000;actor.raw_by_address['0x0524a701']=1000000;actor.hp.current=1000000;}}
  const ready=(id='001')=>{Object.assign(battle.actor(id).charge,{gauge:battle.state.scheduler.threshold,delay:0,recovery:0,recovery_ticks:0});battle.selectPlayer(id);};
  ready();return {world,battle,logs,sources,consumed,ready,id:battleTechniqueId('001',1)};
}

test('saved composition, duplicate bindings and its actual name reach the next battle after save/reload without numeric definitions',async()=>{
  const world=new WorldStore(copy(initial)),original=copy(source);add(world,[21,22]);
  for(const slotIndex of [0,6])changeTechniqueSlot(world,source,{roleId:'001',slotIndex,type:1,indexOneBased:1});
  const restored=await decodeSave(await encodeSave(world.snapshot())),sample=party(new WorldStore(restored)),id=battleTechniqueId('001',1);
  assert.equal(sample.skills[id].name,'火炎斩');assert.deepEqual(sample.skills[id].component_skill_ids,['yanci','yantu']);
  assert.equal(sample.skills[id].mp_cost,5);assert.equal(sample.skills[id].fixed_raw_hex,undefined);
  assert.equal(sample.source.player_command_order['001'][0],id);assert.equal(sample.source.player_command_order['002'].includes(id),false);
  assert.deepEqual(techniqueSlots(restored,source,'001').filter(slot=>slot.type===1).map(slot=>slot.index_one_based),[1,1]);
  assert.deepEqual(restored,world.value);assert.deepEqual(source,original);assert.equal(configured.skill_registry[id],undefined);
});

test('a combination dispatches once with distinct configured attributes, all contacts, summed MP/debt and per-member practice',async()=>{
  const f=fixture({indices:[21,22,37]}),player=f.battle.actor('001'),mp=player.mp.current;
  assert.equal(f.battle.canChoose(f.id),true);await f.battle.choose(f.id,'enemy-0');
  const entry=f.battle.state.history[0];assert.equal(f.battle.state.history.length,1);assert.equal(entry.skill_id,f.id);
  assert.equal(entry.plan.kind,'combination');assert.deepEqual(entry.plan.skill_indices,[21,22,37]);
  assert.deepEqual(entry.contacts.map(contact=>contact.source.source_skill_index),[21,22,37]);
  assert.deepEqual(f.sources.map(skill=>skill.id),['yanci','yantu','yancui']);
  for(const skill of f.sources)assert.equal(skill.fixed_raw_hex,configured.skill_registry[skill.id].fixed_raw_hex);
  assert.deepEqual(f.consumed,[['001',10]]);assert.equal(player.mp.current,mp-10);
  assert.equal(player.charge.delay,611);assert.equal(player.charge.gauge,-f.battle.state.scheduler.threshold);
  assert.deepEqual(f.logs.filter(event=>event.type==='battle-skill-practice').map(event=>[event.skill_index,event.component_count]),[[21,3],[22,3],[37,3]]);
  assert.ok(entry.contacts.every(contact=>contact.result.damage>=0));assert.ok(entry.contacts.some(contact=>contact.result.damage>0));
  assert.equal(f.world.value.party.find(role=>role.id==='001').mp.current,initial.party.find(role=>role.id==='001').mp.current);
});

test('MP, silence, level and actor ownership reject a whole combination atomically',async()=>{
  const f=fixture({indices:[21,37]}),player=f.battle.actor('001');
  for(const mutate of [()=>{player.mp.current=6;},()=>{player.mp.current=50;player.status_flags_raw=2;},()=>{player.status_flags_raw=0;player.level=0;}]){
    mutate();const state=f.battle.snapshot();assert.equal(f.battle.canChoose(f.id),false);await assert.rejects(f.battle.choose(f.id,'enemy-0'));assert.deepEqual(f.battle.snapshot(),state);
  }
  player.level=11;f.ready('002');assert.equal(f.battle.canChoose(f.id),false);await assert.rejects(f.battle.choose(f.id,'enemy-0'),/玩家命令/);
  assert.deepEqual(f.consumed,[]);assert.equal(f.battle.state.history.length,0);
});

test('unsupported source members retain their saved composition and show an unavailable reason instead of inventing an attack',()=>{
  const f=fixture({indices:[21,24]});assert.equal(f.battle.canChoose(f.id),false);
  assert.match(f.battle.skillUnavailableReason(f.id),/尚未接入战斗/);
  assert.deepEqual(f.world.value.technique_combinations.roles['001'][0].indices,[21,24]);assert.equal(f.battle.skills[f.id].component_skill_ids[1],null);
});

test('skill-test uses the same mixed sequence and MP admission but preserves HP and MP',async()=>{
  const f=fixture({indices:[21,22,37],testMode:true}),player=f.battle.actor('001'),mp=player.mp.current,hp=f.battle.actor('enemy-0').hp.current;
  await f.battle.choose(f.id,'enemy-0');assert.deepEqual(f.consumed,[]);assert.equal(player.mp.current,mp);assert.equal(f.battle.actor('enemy-0').hp.current,hp);
  assert.deepEqual(f.battle.state.history[0].contacts.map(contact=>contact.source.source_skill_index),[21,22,37]);
});

test('the wheel and skill list both select a saved composition and pass through normal target confirmation',()=>{
  const f=fixture(),view=Object.create(BattleMenuView.prototype),picked=[];
  Object.assign(view,{battle:f.battle,snapshot:f.battle.presentationSnapshot(),stage:'wheel',getBindings:id=>techniqueSlots(f.world.value,source,id),remember(){},
    wheelButtons:Array.from({length:7},()=>({dataset:{},attributes:{},setAttribute(key,value){this.attributes[key]=value;}})),chooseSkill:(skill,from)=>picked.push([skill.id,from]),openList(stage){this.stage=stage;}});
  changeTechniqueSlot(f.world,source,{roleId:'001',slotIndex:0,type:1,indexOneBased:1});
  view.syncWheel();assert.equal(view.wheelButtons[0].attributes['aria-disabled'],'false');assert.equal(view.wheelButtons[0].attributes['aria-label'],'火炎斩');
  view.activateWheel(0);assert.deepEqual(picked,[[f.id,'wheel']]);view.openSkills();
  const index=view.entries.findIndex(entry=>entry.id===f.id);assert.ok(index>=0);view.remember=()=>{};view.selectEntry(index);assert.deepEqual(picked.at(-1),[f.id,'skills']);
});

test('the actual battle renderer admits compositions through their existing member atlases and still rejects unknown direct skills',()=>{
  const f=fixture(),view=Object.create(BattleView.prototype);
  Object.assign(view,{ready:true,run:null,meta,content:runtimeContent});
  view.setRoster(f.battle.state.actors,f.battle.skills);
  assert.ok(view.roster.find(actor=>actor.id==='001').skill_ids.includes('yanci'));
  assert.equal(view.roster.find(actor=>actor.id==='001').skill_ids.includes(f.id),false);
  assert.throws(()=>view.setRoster(f.battle.state.actors,{...f.battle.skills,unknown:{...f.battle.skills.yanci,id:'unknown'}}),/尚未接入/);
});

test('another ready member can queue a different composition during playback without borrowing the first actor command',async()=>{
  let release;const deferred=new Promise(resolve=>{release=resolve;}),f=fixture({defer:deferred});
  // Construct the second command before combat; its members retain the same
  // configuration identities, while only the owning actor can dispatch it.
  add(f.world,[19,20],'002');const second=party(f.world).skills[battleTechniqueId('002',1)];
  f.battle.skills[second.id]=second;f.battle.expectedRevision=f.world.value.revision;
  const first=f.battle.choose(f.id,'enemy-0');assert.equal(f.battle.running,true);
  f.ready('002');await f.battle.choose(second.id,'enemy-0');assert.equal(f.battle.state.scheduler.pending.actor_id,'002');
  release();await first;await f.battle.scheduleReady();
  assert.deepEqual(f.battle.state.history.map(entry=>[entry.actor_id,entry.skill_id]),[['001',f.id],['002',second.id]]);
  assert.deepEqual(f.consumed,[['001',5],['002',10]]);
});

test('native composition accepts the seven-unit menu bound and retains member source indices',()=>{
  const skill=source.skills.yanci,plan=composeNativeSequence([skill],Array(7).fill(21));
  assert.equal(plan.skill_indices.length,7);assert.equal(plan.body_count,7);assert.throws(()=>composeNativeSequence([skill],Array(8).fill(21)),/数量/);
});

test('all registered composable pairs compile their actual source bodies, including mixed and carrier-first sequences',()=>{
  let pairs=0;
  for(const role of Object.values(source.roles)){
    const skills=Object.values(source.skills).filter(skill=>skill.actor_id===role.id&&(skill.type_flags_u32_0x32&256));
    for(const first of skills)for(const second of skills){if(first.id===second.id)continue;
      const indices=[first.original_skill_index,second.original_skill_index],plan=composeNativeSequence(skills,indices),compiled=compileNativeSequence(meta,role.id,plan);
      const contacts=compiled.steps.flatMap(step=>step.carrier_spawn?.steps??[step]).filter(step=>step.event);
      assert.ok(contacts.some(step=>step.source_skill_index===indices[0]),first.id+' -> '+second.id);
      assert.ok(contacts.some(step=>step.source_skill_index===indices[1]),first.id+' -> '+second.id);pairs++;
    }
  }
  assert.ok(pairs>100);
});

test('a queued composition retargets a fallen opponent through the same native selector as a direct command',()=>{
  const f=fixture(),target=f.battle.actor('enemy-0');target.hp.current=0;target.state_raw=4;
  const pending={actor_id:'001',skill_id:f.id,target_id:target.id};
  const replacement=f.battle.queuedTarget(pending,f.battle.actor('001'),f.battle.skills[f.id]);
  assert.equal(replacement.id,'enemy-1');assert.equal(pending.target_id,'enemy-1');
  assert.ok(f.logs.some(event=>event.type==='battle-command-retargeted'));
});
