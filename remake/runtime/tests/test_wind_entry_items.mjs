// Actual ITM/CHR records exercise the shared item/status paths introduced by
// the first wind chapter. The optional catalog is an isolated producer output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto,createHash} from 'node:crypto';
import {runtimeContent} from '../web/core/content/content_registry.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world/world.mjs';
import {compileItemConfiguration} from '../web/core/items/item_registry.mjs';
import {initializeChapterItem,chapterRoleFromDefinition} from '../web/core/story/chapter_runner.mjs';
import {withItemQuantity} from '../web/core/party/equipment.mjs';
import {restoreActorWithItem,useWorldItem,usableItems} from '../web/core/items/items.mjs';
import {createPartyActors,partyResourcesForWorld,consumePartyMp} from '../web/core/party/party_attributes.mjs';
import {initializeNativeStatuses,tickNativeStatuses,applyNativeSkillStatus} from '../web/core/battle/battle_status.mjs';
import {createPartySample} from '../web/party_sample.mjs';
import {assembleForestSample} from '../web/forest_sample.mjs';
import {BattleController} from '../web/core/battle/battle_controller.mjs';
import {createNativeRng,resolveAction,applyNativeDamage} from '../web/core/battle/combat_rules.mjs';
import {commandReady} from './helpers/battle_clock.mjs';
import {compileNativeSequence,directSequence} from '../web/core/battle/skill_sequence.mjs';
import {beginNativeColorFade,advanceNativeColorFade} from '../web/core/battle/battle_camera.mjs';
import {validateEnemySequenceClosure} from '../web/core/content/content_dependencies.mjs';
import {nativeLoadedSkillCodes} from '../web/core/content/native_skill_loading.mjs';
import {BattleView} from '../web/battle_view.mjs';
globalThis.crypto??=webcrypto;
const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [published,overrides,attributes,statusBase,seedBase,skills,forest,scheduler,ai,rewards,reactions]=await Promise.all(
  ['items','config/items','party_combat','forest_status','opening_seed','party_skills','forest_combat','battle_scheduler','forest_ai','party_rewards','party_reactions'].map(json));
const source=process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG?JSON.parse(await readFile(process.env.SEVENTH_SEAL_ITEM_TEST_CATALOG,'utf8')):published;
const data=compileItemConfiguration(source,overrides,'original').data,copy=structuredClone,statusData=copy(statusBase),content=copy(runtimeContent);
const itm=await readFile(new URL('../../../SYSTEM/Object.ITM',import.meta.url));
for(const id of [16,18,313,322]){
  const offset=0x61c+(id-1)*959,raw=itm.subarray(offset,offset+959),block=raw.subarray(0x2a8,0x36e),effectId=block[1];
  statusData.item_effects??={};statusData.effects??={};
  statusData.item_effects[id]={item_id:id,effect_raw_hex:block.toString('hex'),effect_id_raw:effectId,mode_raw:block[0xb]};
  if(!statusData.effects[effectId]){
    const name=`Fight_Role/Status/${String(effectId).padStart(3,'0')}.dgp`,bytes=await readFile(new URL(`../../../${name}`,import.meta.url)),action=bytes.subarray(67,67+0xac);
    statusData.effects[effectId]={id_raw:effectId,interval_ms:action.readUInt32LE(1),frame_count:action[14],source:{path:name,sha256:createHash('sha256').update(bytes).digest('hex'),action_raw_hex:action.toString('hex')}};
  }
}
const instance=(id,quantity=3)=>withItemQuantity({id,name:data.definitions[id].name,instance_id:`wind-item-${id}`,source_raw_hex:Buffer.from(initializeChapterItem(data.definitions[id])).toString('hex')},quantity);
function world(){const seed=copy(seedBase);seed.opening.status='complete';seed.location={map_id:'M17026',x:400,y:320,direction:0};
  seed.party.push(chapterRoleFromDefinition(seed.source.role_definitions['002']));seed.inventory=[18,33,36,322,398].map(id=>instance(id));return new WorldStore(seed,['M17026']);}
function actor(){const out=createPartyActors(world().snapshot(),attributes,{},data)[0];out.current_skill=copy(skills.skills[Object.keys(skills.skills)[0]]);return initializeNativeStatuses(out,statusData,content);}

test('source36 uses the native no-RNG descending pair while only the six real element fields change and survive save/load',async()=>{
  const raw=Buffer.from(initializeChapterItem(data.definitions[36]));assert.equal(raw.readInt32LE(0x7d),768);
  const store=world(),before=store.snapshot(),base=createPartyActors(before,attributes,{},data)[0],result=useWorldItem(store,attributes,data,{instanceId:instance(36).instance_id,targetId:'001'});
  assert.equal(result.applied,true);assert.equal(store.value.inventory.find(row=>row.id===36).quantity,2);
  const header=Buffer.from(store.value.party[0].combat_progress.header_raw_hex,'hex'),original=Buffer.from(base.header_raw_hex,'hex');
  assert.equal(header.readInt32LE(0x86),Math.min(999,original.readInt32LE(0x86)+30));
  for(let offset=0;offset<header.length;offset++)if(offset<0x86||offset>=0x8a)assert.equal(header[offset],original[offset],String(offset));
  const loaded=await decodeSave(await encodeSave(store.snapshot()),store.mapIds);assert.deepEqual(createPartyActors(loaded,attributes,{},data),createPartyActors(store.snapshot(),attributes,{},data));
  assert.deepEqual(store.value.source,before.source);
});

test('actual periodic medicine17 templates tick through the existing source clock and duplicate guard without immediate healing',()=>{
  let target=actor();target.raw_hp=1;target.raw_hp_maximum=5000;target.hp={current:1+target.resource_bonuses.hp_current,maximum:5000+target.resource_bonuses.hp_maximum};
  target.raw_by_address['0x0524a701']=1;target.raw_by_address['0x0524a705']=5000;
  const used=restoreActorWithItem(target,instance(16),data,{statusData,content,rng:()=>0});assert.equal(used.applied,true);assert.equal(used.actor.raw_hp,1);
  const duplicate=restoreActorWithItem(used.actor,instance(16),data,{statusData,content,rng:()=>{throw Error('duplicate must not roll');}});assert.equal(duplicate.applied,false);
  const tick=tickNativeStatuses({actor:used.actor,threshold:1,now:statusData.effects[17].interval_ms,data:statusData,content,rng:()=>0});
  assert.equal(tick.actor.raw_hp,2001);assert.ok(tick.trace.some(row=>row.kind==='status-periodic-effect'));
  assert.equal(usableItems([instance(16)],data,'field').length,0);
});

test('actual313 changes enemy MP maximum by the source -15 percent and398 clears allied slots without rolling',()=>{
  let target=actor();target.side='enemy';target.side_raw=0;target.raw_mp=100;target.raw_mp_maximum=100;target.resource_bonuses.mp_current=0;target.resource_bonuses.mp_maximum=0;target.mp={current:100,maximum:100};
  target.raw_by_address['0x0524a709']=100;target.raw_by_address['0x0524a70d']=100;
  const used=restoreActorWithItem(target,instance(313),data,{statusData,content,caster:{side:'player'},rng:()=>0});
  assert.equal(used.actor.raw_mp_maximum,85);assert.equal(used.actor.raw_mp,85);assert.equal(used.actor.mp.maximum,85);
  const allied=restoreActorWithItem(actor(),instance(16),data,{statusData,content,rng:()=>0}).actor;
  const cleared=restoreActorWithItem(allied,instance(398),data,{statusData,content,rng:()=>{throw Error('clear must not roll');}});
  assert.equal(cleared.applied,true);assert.ok(cleared.actor.native_status_slots.every(row=>row.raw_hex==='00'.repeat(0xc6)));
  target.raw_mp=2000;target.raw_mp_maximum=2000;target.raw_by_address['0x0524a709']=2000;target.raw_by_address['0x0524a70d']=2000;target.mp={current:2000,maximum:2000};
  const capped=restoreActorWithItem(target,instance(313),data,{statusData,content,caster:{side:'player'},rng:()=>0});
  assert.equal(capped.actor.raw_mp_maximum,999);assert.equal(capped.actor.raw_mp,999);
});

test('034 source HP100000 is clamped9999 even when322 fails or repeats; target mutation does not authorize consumption',async()=>{
  const chr=await readFile(new URL('../../../Fight_Role/034.CHR',import.meta.url)),maximum=chr.readInt32LE(8+0x34);assert.equal(maximum,100000);
  let boss=actor();boss.side='enemy';boss.side_raw=0;boss.resource_id='034';boss.raw_hp=maximum;boss.raw_hp_maximum=maximum;boss.resource_bonuses.hp_current=0;boss.resource_bonuses.hp_maximum=0;
  boss.hp={current:maximum,maximum};boss.raw_by_address['0x0524a701']=maximum;boss.raw_by_address['0x0524a705']=maximum;
  const failed=restoreActorWithItem(boss,instance(322),data,{statusData,content,caster:{side:'player'},rng:()=>99});
  assert.equal(failed.applied,false);assert.equal(failed.native_return,0);assert.equal(failed.state_changed,true);assert.equal(failed.actor.raw_hp_maximum,9999);assert.equal(failed.actor.raw_hp,9999);
  boss=restoreActorWithItem(boss,instance(322),data,{statusData,content,caster:{side:'player'},rng:()=>0}).actor;
  boss.raw_hp=maximum;boss.raw_hp_maximum=maximum;boss.hp={current:maximum,maximum};boss.raw_by_address['0x0524a701']=maximum;boss.raw_by_address['0x0524a705']=maximum;
  const duplicate=restoreActorWithItem(boss,instance(322),data,{statusData,content,caster:{side:'player'},rng:()=>{throw Error('duplicate must not roll');}});
  assert.equal(duplicate.applied,false);assert.equal(duplicate.actor.raw_hp_maximum,9999);assert.equal(duplicate.actor.raw_hp,9999);
});

test('whole-side items touch each eligible native actor once, consume one unit, and battle element growth persists on exit',async()=>{
  const store=world(),sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,data),forest,{map_id:'M70010',members:[{id:'013'},{id:'014'}]},
    {...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,rewards,reactions,statusData);
  let now=0;const log=[];const battle=new BattleController({world:store,itemData:data,resolveAction,applyDamage:applyNativeDamage,resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,
    now:()=>now,waitTick:async()=>{now+=20;},log:entry=>log.push(entry),playAction:async()=>{},playSequence:async()=>{}});
  battle.start({...sample,rng:createNativeRng(123)});for(const enemy of battle.state.actors.filter(row=>row.side==='enemy'))enemy.charge.delay=1000000;
  for(const [id,target]of [[18,'001'],[322,battle.state.actors.find(row=>row.side==='enemy').id],[398,'001'],[33,'001']]){
    await commandReady(battle,'001');battle.selectPlayer('001');await battle.chooseItem(instance(id).instance_id,target);
    assert.equal(battle.state.inventory.find(row=>row.id===id).quantity,2);
  }
  // Failed repeated status still submits47D960's target writes, preserving
  // the already-consumed count from the first successful whole-side throw.
  const enemies=battle.state.actors.filter(row=>row.side==='enemy');
  for(const enemy of enemies){Object.assign(enemy,restoreActorWithItem(enemy,instance(322),data,{statusData,content,caster:{side:'player'},rng:()=>0}).actor);
    enemy.raw_hp=100000;enemy.raw_hp_maximum=100000;enemy.hp={current:100000,maximum:100000};enemy.resource_bonuses.hp_current=0;enemy.resource_bonuses.hp_maximum=0;enemy.raw_by_address['0x0524a701']=100000;enemy.raw_by_address['0x0524a705']=100000;}
  await commandReady(battle,'001');battle.selectPlayer('001');await battle.chooseItem(instance(322).instance_id,enemies[0].id);
  assert.ok(enemies.every(enemy=>enemy.raw_hp_maximum===9999&&enemy.raw_hp===9999));assert.equal(battle.state.inventory.find(row=>row.id===322).quantity,2);
  const groupEvents=log.filter(row=>row.type==='battle-item-used'&&[18,322,398].includes(row.item_id));
  for(const event of groupEvents){assert.equal(event.result.group_results.length,2);assert.equal(new Set(event.result.group_results.map(row=>row.target_id)).size,2);}
  const initial=Buffer.from(seedBase.source.role_definitions['001'].header_raw_hex,'hex').readInt32LE(0x7a);
  battle.finish();assert.equal(Buffer.from(store.value.party[0].combat_progress.header_raw_hex,'hex').readInt32LE(0x7a),Math.min(999,initial+30));
  const loaded=await decodeSave(await encodeSave(store.snapshot()),store.mapIds);assert.doesNotThrow(()=>createPartyActors(loaded,attributes,{},data));
});

test('029 original skill13 invokes primary mode5 clear after a valid contact',async()=>{
  const chr=await readFile(new URL('../../../Fight_Role/029.CHR',import.meta.url));let offset=8+0x30b;
  for(let index=0;index<13;index++)offset+=0x41d+chr.readUInt32LE(offset+0x15)*0xb0;
  const fixed=chr.subarray(offset,offset+0x41d),block=fixed.subarray(0x16b,0x231);assert.equal(block[1],0);assert.equal(block[0xb],5);
  const target=restoreActorWithItem(actor(),instance(16),data,{statusData,content,rng:()=>0}).actor;
  const result=applyNativeSkillStatus({actor:target,skill:{fixed_raw_hex:fixed.toString('hex')},data:statusData,content,now:0,rng:()=>{throw Error('clear must not roll');}});
  assert.equal(result.native_return,1);assert.ok(result.actor.native_status_slots.every(row=>row.raw_hex==='00'.repeat(0xc6)));
});

test('034 all learned source sequences compile, and shared admission rejects unsupported command payloads',async()=>{
  const view=await json('enemy_battle_view'),chr=await readFile(new URL('../../../Fight_Role/034.CHR',import.meta.url)),role=ai.roles['034'];
  assert.equal(createHash('sha256').update(chr).digest('hex'),role.source.sha256);
  assert.deepEqual(role.learned_indices,[9,10,11,12,13,14,15,16,17]);
  validateEnemySequenceClosure(ai,view,content);
  //4FED00 gameplay mode0 clears these file shortcut codes.034's real AI
  // has no combination candidates, even when its20% combination gate passes.
  assert.ok(role.learned_indices.every(i=>nativeLoadedSkillCodes(role.skills)[i]===0));
  for(const index of role.learned_indices){
    const skill=role.skills[index],compiled=compileNativeSequence(view,'034',directSequence(skill));
    assert.equal(chr.subarray(skill.source_record_offset,skill.source_record_offset+1053).toString('hex'),skill.fixed_raw_hex);
    for(const a of skill.actions)assert.equal(chr.subarray(a.offset,a.offset+176).toString('hex'),a.raw_hex);
    assert.ok(compiled.steps.some(s=>s.event||s.carrier_spawn?.steps.some(c=>c.event)));
  }
  const altered=copy(ai),action=altered.roles['034'].skills[12].actions[3],raw=Buffer.from(action.raw_hex,'hex');raw[0x47]=2;action.raw_hex=raw.toString('hex');
  assert.throws(()=>validateEnemySequenceClosure(altered,view,content),/原背景减色模式未支持/);
  const controls=compileNativeSequence(view,'034',directSequence(role.skills[12])).steps.filter(s=>s.command_raw===0);
  assert.deepEqual(controls.map(s=>s.control),[{mode_raw:0,step_i32_raw:0,amount_i32_raw:0,color_mask_raw:7},{mode_raw:1,step_i32_raw:0,amount_i32_raw:0,color_mask_raw:0}]);
  let fade=beginNativeColorFade(controls[0].control,0);fade=advanceNativeColorFade(fade,400);
  assert.deepEqual([fade.value,fade.count,fade.active,fade.mask],[40,20,false,7]);
  fade=beginNativeColorFade(controls[1].control,400,fade);fade=advanceNativeColorFade(fade,800);
  assert.deepEqual([fade.value,fade.count,fade.active,fade.mask],[0,0,false,7]);
});

test('034 formal99-level handoff reproduces natural AI first skill12 through real BattleView contacts without player input',async()=>{
  const observed=JSON.parse(await readFile(new URL('../evidence/wind_region_20261031/browser_outputs/boss_first_blocked_log.json',import.meta.url),'utf8'));
  const store=new WorldStore(copy(observed.world),Object.keys(content.maps)),sample=assembleForestSample(createPartySample(store.snapshot(),attributes,skills,null,data),forest,
    observed.current_battle.source.encounter,{...scheduler,idle_skills:{...scheduler.idle_skills,...skills.idle_skills}},ai,null,reactions,statusData);
  const view=new BattleView({canvas:{getContext:()=>({})},metadataPath:'/data/party_battle_view.json',itemMetadataPath:'/data/item_presentation.json',
    lifecycleMetadataPath:'/data/battle_lifecycle.json',stageMetadataPath:'/data/stages/stage09.json',jsonLoader:path=>json(path.replace(/^\/data\//,'').replace(/\.json$/,'')),
    assetLoader:async asset=>({image:{width:asset.width,height:asset.height},sha256:asset.sha256})}),log=[];
  // Formal preparation merges source-identical lifecycle DGP actions and all
  // physical layer banks before contact reactions can select a player response.
  await view.prepare({actors:sample.actors,skills:sample.skills,inventory:store.value.inventory,staged:true});
  view.setRoster(sample.actors,sample.skills);
  let now=21400,index=0;const values=[13011,24462,8923];
  const battle=new BattleController({world:store,now:()=>now,resolveAction,applyDamage:applyNativeDamage,consumeResources:consumePartyMp,log:row=>log.push(row),
    playSequence:async(event,hooks)=>{const lease=await view.prepareAction(event),done=view.playSequence(event,hooks);view.run.resourceLease=lease;
      for(let tick=0;view.run&&tick<3000;tick++){view._advance(now);now+=20;}assert.equal(view.run,null);return done;}});
  battle.start({...sample,rng:()=>index<values.length?values[index++]:0});
  // Restore the observed pre-contact actor state; the interrupted compilation
  // changed no player HP. Return only the source charge to pre-dispatch value.
  battle.state.actors=copy(observed.current_battle.actors);Object.assign(battle.actor('enemy-0'),copy(observed.current_battle.history[0].before.attacker));
  battle.actor('enemy-0').charge.gauge=80250;battle.actor('enemy-0').charge.delay=0;
  battle.state.scheduler.ticks=1070;battle.state.scheduler.elapsed_ms=21400;
  assert.ok(battle.players().every(a=>a.level===99));assert.equal(battle.actor('enemy-0').hp.current,100000);
  assert.equal(battle.state.scheduler.pending,null);assert.deepEqual(battle.state.scheduler.queued_commands,[]);
  view.nativeControl=battle;view.nativeControlIsCurrent=()=>true;
  await battle.runScheduledReady({actor_id:'enemy-0'});
  assert.notEqual(battle.state.phase,'interrupted',battle.state.error);
  const scheduled=log.find(row=>row.type==='battle-scheduled');assert.deepEqual(scheduled.native_plan.skill_indices,[12]);assert.equal(scheduled.target_id,'006');
  assert.deepEqual(scheduled.native_plan.trace.filter(row=>row.kind==='rng').map(row=>row.raw),values);
  assert.equal(battle.state.history.length,1);assert.equal(battle.state.history[0].plan.handler,'direct');
  const contacts=battle.state.history[0].contacts;
  assert.equal(contacts.length,8);
  for(const id of ['001','003','004','006'])assert.equal(contacts.filter(row=>row.before.target.id===id).length,2);
  assert.ok(!log.some(row=>row.type==='battle-command-queued'));
  assert.ok(view.colorFade);view.stop();assert.equal(view.colorFade,null);view.destroy();
});
