"""Actual ITM medicine admission and direct508BB0 item-contact oracles."""
from pathlib import Path
import json
import subprocess
import sys
import unittest
import tempfile
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME / 'tools'))
import export_chapter_items as items
import export_enemy_content as enemies
import export_party_skills as skills
import export_item_presentation as presentation

IDS = [13, 21, *range(23, 29), *range(272, 277), *range(278, 281),
       *range(283, 286), *range(307, 312), 315, 320, 321, 323, 324, 331, 399]

CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {deriveItemConfiguration,compileItemConfiguration} from './web/core/item_registry.mjs';
import {restoreActorWithItem,itemTargetEligible} from './web/core/items.mjs';
import {withItemQuantity} from './web/core/equipment.mjs';
import {initializeNativeStatuses,applyNativeItemStatus,removeNativeStatus,tickNativeStatuses} from './web/core/battle_status.mjs';
import {selectNativeRevivalAnimation} from './web/core/battle_reactions.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
import {WorldStore,encodeSave,decodeSave} from './web/core/world.mjs';
import {createRewardLedger,collectEnemyDefeat,planVictoryRewards} from './web/core/battle_rewards.mjs';
import {admitPartyMember} from './web/core/party_members.mjs';
import {BattleController} from './web/core/combat.mjs';
import {createPartySample} from './web/party_sample.mjs';
import {assembleForestSample} from './web/forest_sample.mjs';
import {resolveAction,applyNativeDamage} from './web/core/combat_rules.mjs';
import {partyResourcesForWorld,consumePartyMp} from './web/core/party_attributes.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;
const cfg=deriveItemConfiguration(input.catalog),data=compileItemConfiguration(input.catalog,cfg,'original').data;
const functions={...input.instructions.instructions,'0x508bb0':input.proof.normalized_result.assembly,
 '0x507e20':input.clearProof.normalized_result.assembly};
for(const record of input.recovery.records)if(record.operation==='procedure_assembly'&&['0x41bfb0','0x401aaa'].includes(record.parameters.procedure))
 functions[record.parameters.procedure]=record.normalized_result.trim().split(/\r?\n/);
const args=block=>{const raw=Buffer.alloc(200);Buffer.from(block,'hex').copy(raw);return [0,...Array.from({length:50},(_,i)=>raw.readInt32LE(i*4))];};
class Oracle extends NativeAssemblyOracle{
 constructor(actor,rng){super(functions,[actor],rng);for(const [index,row]of actor.native_status_slots.entries())Buffer.from(row.raw_hex,'hex').forEach((v,i)=>this.write(0x521a7d2+index*0xc6+i,v,1));this.write(0x521f52a,actor.status_flags_raw);
  for(const metadata of Object.values(input.status.effects)){const at=0x30000000+metadata.id_raw*0x1000;this.write(0x55eb0c3+(metadata.id_raw-1)*0xeb,at);this.write(0x55eb0cb+(metadata.id_raw-1)*0xeb,metadata.frame_count);this.write(at+1,metadata.interval_ms);}
 }
 regRead(name){return name==='BL'?this.reg.EBX&255:super.regRead(name);}
 regWrite(name,value){if(name==='BL')this.reg.EBX=(this.reg.EBX&~255)|(value&255);else super.regWrite(name,value);}
 external(target){const arg=i=>this.read(this.reg.ESP+i*4);
  if(target===0x570a40){for(let i=0;i<arg(2);i++)this.write(arg(0)+i,arg(1),1);this.reg.EAX=arg(0);return;}
  if(target===0x570d10){const bytes=Array.from({length:arg(2)},(_,i)=>this.read(arg(1)+i,1));bytes.forEach((value,i)=>this.write(arg(0)+i,value,1));this.reg.EAX=arg(0);return;}
  if(target===0x507c60){this.write(arg(0),(this.read(arg(0))|(arg(1)&0x3ff))>>>0);return;}
  if(target===0x401609)return;return super.external(target);
 }
 compare(actor){
  assert.equal(this.read(0x521f52a)>>>0,actor.status_flags_raw);
  for(const field of input.status.aggregation)assert.equal(this.read(Number(field.address),field.bits===8?1:4),actor.status_by_address[field.address],field.address);
  for(let i=0;i<100;i++)assert.equal(Buffer.from(Array.from({length:0xc6},(_,j)=>this.read(0x521a7d2+i*0xc6+j,1))).toString('hex'),actor.native_status_slots[i].raw_hex);
 }
}
const item=id=>{const def=data.definitions[id];return withItemQuantity({id:Number(id),name:def.name,instance_id:`itm:${id}`,source_raw_hex:def.initialized_raw_hex},3);};
const enemy=()=>initializeNativeStatuses(copy(input.enemy),input.status),player=()=>initializeNativeStatuses({
 ...copy(input.player),current_skill:copy(input.reactions.roles['001'].skills[0]),native_active:false,current_target_id:null,reaction_special_gate_raw:0,native_z_raw:0},input.status);
let comparisons=0,cures=0,periodic=0,clears=0;
for(const id of input.ids){
 const def=data.definitions[id];assert.equal(def.runtime_enabled,true,id);
 if(def.behavior.kind==='status-attack'){
  assert.equal(itemTargetEligible(enemy(),def,player()),true);assert.equal(itemTargetEligible(player(),def,player()),false);
  assert.throws(()=>restoreActorWithItem(player(),item(id),data,{statusData:input.status,rng:()=>0}),/阵营/);
  assert.throws(()=>restoreActorWithItem(enemy(),item(id),data,{scope:'field'}),/配置禁用/);
  for(const draw of [0,70,71,99]){
   const actor=enemy(),oracle=new Oracle(actor,()=>draw),result=applyNativeItemStatus({actor,item_id:id,data:input.status,rng:()=>draw});
   oracle.run(0x508bb0,args(def.status_attack.effect_raw_hex));oracle.compare(result.actor);
   assert.equal(result.native_return,oracle.reg.EAX);assert.deepEqual(result.trace.filter(row=>row.kind==='rng').map(row=>row.raw),oracle.rng_calls);comparisons++;
   if(result.applied){
    const duplicate=applyNativeItemStatus({actor:result.actor,item_id:id,data:input.status,rng:()=>assert.fail('duplicate item RNG')});assert.equal(duplicate.native_return,0);
   }
  }
  const accepted=restoreActorWithItem(enemy(),item(id),data,{statusData:input.status,rng:()=>0});
  assert.equal(accepted.applied,true);assert.equal(accepted.actor.native_status_slots.some(row=>row.raw_hex===def.status_attack.effect_raw_hex),true);
  // Advance the unchanged source gauge through a real periodic threshold.
  // Its resulting death request remains owned by the normal controller.
  const block=Buffer.from(def.status_attack.effect_raw_hex,'hex'),metadata=input.status.effects[block[1]];
  const ticks=tickNativeStatuses({actor:accepted.actor,data:input.status,now:metadata.interval_ms,threshold:1,rng:()=>0,
   onPeriodicEffect:({actor})=>({actor})});
  const oracle=new Oracle(accepted.actor,()=>assert.fail('periodic item RNG'));oracle.write(0x679c74,1);
  // These are explicit transaction boundaries: the controller owns reaction
  // selection and finalized death, while41BFB0 owns resource/state changes.
  const external=oracle.external.bind(oracle);oracle.external=target=>{if([0x4ffe90,0x51c640].includes(target))return;external(target);};
  oracle.run(0x509e10,[metadata.interval_ms,0]);oracle.compare(ticks.actor);
  for(const [field,at]of [['raw_hp',0x524a701],['raw_hp_maximum',0x524a705],['raw_mp',0x524a709],['raw_mp_maximum',0x524a70d]])assert.equal(ticks.actor[field],oracle.read(at),`${id}:${field}`);
  assert.equal(ticks.actor.state_raw,oracle.read(0x521a77b,1));assert.equal(ticks.ticks,1);periodic++;
 }else if(def.behavior.kind==='status-clear'){
  assert.equal(itemTargetEligible(enemy(),def,player()),true);assert.equal(itemTargetEligible(player(),def,player()),false);
  assert.throws(()=>restoreActorWithItem(player(),item(id),data,{statusData:input.status}),/阵营/);
  assert.throws(()=>restoreActorWithItem(enemy(),item(id),data,{scope:'field'}),/配置禁用/);
  for(const populated of [false,true]){
   const actor=populated?applyNativeItemStatus({actor:enemy(),item_id:273,data:input.status,rng:()=>0}).actor:enemy();
   const oracle=new Oracle(actor,()=>assert.fail('clear RNG'));
   const result=restoreActorWithItem(actor,item(id),data,{statusData:input.status,rng:()=>assert.fail('clear RNG')});
   oracle.run(0x508bb0,args(def.status_clear.effect_raw_hex));oracle.compare(result.actor);
   assert.equal(result.native_return,oracle.reg.EAX);assert.equal(result.applied,true);clears++;
  }
 }else if(def.behavior.kind==='status-cure'){
  const actor=def.battle.same_side_raw_157?player():enemy(),source=copy(def.status_cure),raw=Buffer.from(id===399?input.status20:source.effect_raw_hex,'hex');raw[0xb]=0;
  assert.equal(itemTargetEligible(actor,def,player()),true);
  actor.native_status_slots[3]={raw_hex:raw.toString('hex')};
  const oracle=new Oracle(actor,()=>assert.fail('cure RNG')),result=removeNativeStatus({actor,effect_raw_hex:source.effect_raw_hex,data:input.status});
  oracle.run(0x508bb0,args(source.effect_raw_hex));oracle.compare(result.actor);assert.equal(result.native_return,1);cures++;
 }
}
assert.equal(data.definitions[13].effect.restore_mp_flat,300);
const restored=restoreActorWithItem(player(),item(13),data,{scope:'field'});assert.equal(restored.applied,true);
const dead=player();dead.raw_hp=-dead.resource_bonuses.hp_current;dead.raw_by_address['0x0524a701']=dead.raw_hp;dead.hp.current=0;dead.state_raw=7;
const def=data.definitions[21];assert.equal(itemTargetEligible(dead,def,player()),true);assert.equal(itemTargetEligible(player(),def,player()),false);
let draws=0;const revived=restoreActorWithItem(dead,item(21),data,{statusData:input.status,rng:()=>{draws++;return 0;},
 selectAnimation:(actor,{rng})=>selectNativeRevivalAnimation({actor,data:input.reactions,rng})});
assert.equal(revived.applied,true);assert.equal(revived.revived,true);assert.equal(revived.actor.state_raw,0);assert.ok(revived.actor.hp.current>0);assert.equal(draws,1);
assert.equal(revived.actor.raw_hp,Math.min(dead.raw_hp_maximum,1+Math.trunc(dead.raw_hp_maximum/2)));
assert.equal(revived.animation.kind,'revive');assert.equal(revived.animation.skill.original_id_raw,14);
const field=restoreActorWithItem(dead,item(21),data,{scope:'field'});assert.equal(field.revived,false);assert.equal(field.actor.state_raw,0);
assert.equal(field.actor.raw_hp,Math.min(dead.raw_hp_maximum,dead.raw_hp+Math.trunc(dead.raw_hp_maximum/2)));
let scheduled=0;
for(const [id,mode]of [[273,'normal'],[273,'immune'],[279,'normal'],[311,'normal'],[21,'normal'],[21,'restored'],[272,'absent'],[331,'normal'],[331,'immune']]){
 const value=copy(input.seed);admitPartyMember(value,'002');const world=new WorldStore(value);
 world.transact(draft=>draft.inventory.push(item(id)));
 const source=assembleForestSample(createPartySample(world.snapshot(),input.attributes,input.commands,null,data),input.forest,
  {map_id:'M70010',members:[{id:'013'}]},input.scheduler,input.ai,input.rewards,input.reactions,input.status);
 let draws=0,battle,contacts=0,oldDeath=null;
 battle=new BattleController({world,itemData:data,resolveAction,applyDamage:applyNativeDamage,
  resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,now:()=>0,
  playSequence:async()=>assert.fail('item contract dispatched an ordinary attack'),playItem:async(event,{onUse})=>{
   if(mode==='immune')target.immune_raw=1;if(mode==='restored')target.state_raw=0;
   const first=onUse(),count=draws,after=copy({target,inventory:battle.state.inventory});contacts++;
   assert.deepEqual(onUse(),first);assert.equal(draws,count);assert.deepEqual({target,inventory:battle.state.inventory},after);
  }});
 battle.start({...source,lifecycle_enabled:true,rng:()=>{draws++;return 0;}});
 for(const event of copy(battle.state.lifecycle_events))battle.ackLifecycle(event);
 const target=battle.actor(['status-attack','status-clear'].includes(data.definitions[id].behavior.kind)?'enemy-0':'002');
 if(id===331)Object.assign(target,applyNativeItemStatus({actor:target,item_id:273,data:input.status,rng:()=>0}).actor);
 if(id===21){target.raw_hp=-target.resource_bonuses.hp_current;target.raw_by_address['0x0524a701']=target.raw_hp;target.hp.current=0;target.state_raw=4;battle.finalizeDeath(target);oldDeath=copy(battle.state.lifecycle_events.find(event=>event.actor_id==='002'));}
 for(const actor of battle.state.actors)actor.charge.gauge=actor.id==='001'?battle.state.scheduler.threshold:0;
 battle.state.phase='command';battle.selectPlayer('001');const before=world.snapshot(),entryDraws=draws;
 assert.ok(battle.itemTargetIds(`itm:${id}`).includes(target.id));
 await battle.chooseItem(`itm:${id}`,target.id);
 assert.equal(contacts,1);assert.equal(draws-entryDraws,mode==='normal'&&![272,331].includes(id)?1:0);
 const used=mode==='normal',remaining=battle.state.inventory.find(row=>row.instance_id===`itm:${id}`)?.quantity??0;
 assert.equal(remaining,used?2:3);assert.deepEqual(world.snapshot(),before);
 if(id===331)assert.equal(target.native_status_slots.some(row=>Buffer.from(row.raw_hex,'hex')[1]),!used);
 assert.equal(battle.state.action_count,1);assert.equal(battle.actor('001').charge.gauge,-battle.state.scheduler.threshold);
 if(id===21&&used){
  assert.equal(target.life_epoch,1);assert.equal(battle.ackLifecycle(oldDeath),false);
  const event=battle.state.lifecycle_events.find(event=>event.kind==='revive');assert.ok(event);assert.equal(event.source_id_raw,14);
  assert.equal(battle.ackLifecycle(event),true);assert.equal(battle.ackLifecycle(event),false);
 }
 if(oldDeath&&mode!=='normal')battle.state.lifecycle_events=battle.state.lifecycle_events.filter(event=>event.token!==oldDeath.token);
 battle.finish();assert.equal(world.value.inventory.find(row=>row.instance_id===`itm:${id}`).quantity,used?2:3);scheduled++;
}
// 399 is acquired from the actual024 reward slot, then dispatched by the
// existing ordinary item command. The original021 ID20 is a bounded removal
// fixture only; it does not register021, apply a new status, or enter the game.
assert.equal(input.dispatchProof.subject.digest.sha256,input.catalog.source_hashes['GAME.exe']);
assert.ok(input.dispatchProof.normalized_result.includes('FUN_00508bb0(local_10)'));
assert.equal(data.definitions[399].status_cure.effect_id_raw,20);
assert.equal(data.definitions[399].battle.same_side_raw_157,0);
assert.equal(data.definitions[399].raw_fields.effect_token_raw_126,'');
for(const mode of ['matching','absent','immune']){
 const value=copy(input.seed),defeated={id:'seal-024',resource_id:'024',side:'enemy',side_raw:0,hp:{current:0},state_raw:5,immune_raw:0},
  winner={id:'001',side:'player',side_raw:1,hp:{current:1},state_raw:0,immune_raw:0},actors=[winner,defeated],
  ledger=createRewardLedger(`item399-drop-${mode}`,actors);
 collectEnemyDefeat(ledger,defeated,{data:input.rewards});
 assert.deepEqual(input.rewards.enemies['024'].reward_slots,[331,399,268,0,0,0]);
 const plan=planVictoryRewards({world:value,ledger,data:input.rewards,actors,rng:()=>0});
 Object.assign(value,plan.world_patch);value.reward_records=[...(value.reward_records??[]),plan.reward_record];
 assert.equal(plan.summary.drops.find(row=>row.id===399).quantity,1);
 const world=new WorldStore(await decodeSave(await encodeSave(value))),item=world.value.inventory.find(row=>row.id===399),key=item.instance_id;
 assert.equal(item.quantity,1);assert.equal(item.source_raw_hex,input.rewards.items[399].instance_raw_hex);
 assert.equal(itemTargetEligible(player(),data.definitions[399],player()),false);
 assert.throws(()=>restoreActorWithItem(player(),item,data,{scope:'field'}),/配置禁用/);
 const source=assembleForestSample(createPartySample(world.snapshot(),input.attributes,input.commands,null,data),input.forest,
  {map_id:'M70010',members:[{id:'012'}]},input.scheduler,input.ai,input.rewards,input.reactions,input.status);
 let contacts=0,draws=0;const battle=new BattleController({world,itemData:data,resolveAction,applyDamage:applyNativeDamage,
  resourcesForWorld:partyResourcesForWorld,consumeResources:consumePartyMp,now:()=>0,
  playSequence:async()=>assert.fail('399 dispatched ordinary attack'),playItem:async(event,{onUse})=>{
   if(mode==='immune')target.immune_raw=1;const result=onUse();contacts++;assert.deepEqual(onUse(),result);
  }});
 battle.start({...source,lifecycle_enabled:true,rng:()=>{draws++;return 0;}});
 for(const event of copy(battle.state.lifecycle_events))battle.ackLifecycle(event);
 const target=battle.actor('enemy-0');if(mode!=='absent')target.native_status_slots[3]={raw_hex:input.status20};
 for(const actor of battle.state.actors)actor.charge.gauge=actor.id==='001'?battle.state.scheduler.threshold:0;
 battle.state.phase='command';battle.selectPlayer('001');const before=world.snapshot(),hp=copy(target.hp),mp=copy(target.mp),entryDraws=draws;
 assert.deepEqual(battle.itemTargetIds(key),['enemy-0']);await battle.chooseItem(key,target.id);
 assert.equal(contacts,1);assert.equal(draws,entryDraws);assert.equal(battle.state.inventory.some(row=>row.id===399),mode!=='matching');
 assert.equal(target.native_status_slots[3].raw_hex==='00'.repeat(0xc6),mode!=='immune');
 assert.deepEqual(target.hp,hp);assert.deepEqual(target.mp,mp);assert.deepEqual(world.snapshot(),before);
 battle.finish();const saved=await decodeSave(await encodeSave(world.snapshot()));
 assert.deepEqual(saved.inventory,world.value.inventory);assert.deepEqual(saved.reward_records,world.value.reward_records);
 assert.equal(saved.inventory.some(row=>row.id===399),mode!=='matching');
}
process.stdout.write(JSON.stringify({comparisons,cures,periodic,clears,revival:true,scheduled,item399:3}));
"""


class EmberCityItems(unittest.TestCase):
    def catalog(self):
        catalog = enemies.read('items')
        raw = (enemies.ROOT / 'SYSTEM/Object.ITM').read_bytes()
        for ident in IDS:
            at = 0x61c + (ident - 1) * 0x3bf
            catalog['definitions'][str(ident)], _ = items.catalog_fields(raw[at:at + 0x3bf], ident, at)
        admission = dict(sources={str(ident): [dict(kind='source-contract-item-selection', item_id=ident)] for ident in IDS})
        promoted = items.admit_registered_status_cures(catalog['definitions'], admission)
        self.assertEqual(promoted['promoted_item_ids'], sorted(IDS))
        return catalog, raw

    def test_all_admitted_item_effects_export_exact_original_pixels_and_empty_token_stays_empty(self):
        catalog, raw = self.catalog()
        selected = presentation.item_presentations(catalog, raw)
        self.assertIsNone(selected['279']['effect_id'])
        self.assertIsNone(selected['331']['effect_id'])
        self.assertIsNone(selected['399']['effect_id'])
        tokens = {selected[str(ident)]['effect_token_raw_126'] for ident in IDS} - {''}
        self.assertEqual(len(tokens), 23)
        checks, generated, previews = [], [], []
        with tempfile.TemporaryDirectory(prefix='ember-item-media-', dir=RUNTIME) as temporary:
            runtime = Path(temporary)
            with patch.multiple(presentation, RUNTIME=runtime, WEB=runtime / 'web'):
                effects = [presentation._export_item_effect(token, checks, generated, previews) for token in sorted(tokens)]
            self.assertEqual(sum(effect['frame_count'] for effect in effects), len(checks))
            self.assertTrue(all(effect['blend'] == 'lighter' for effect in effects))
            self.assertEqual(len(generated), 23)

    def test_actual_item_source_admission_damage_rng_cures_and_revival(self):
        catalog, raw = self.catalog()
        # This fixture supplies explicit source selections to isolate ability
        # admission. Production shop/grant reachability has its own source test.
        untouched = items.catalog_fields(raw[0x61c + 13 * 0x3bf:0x61c + 14 * 0x3bf], 14, 0x61c + 13 * 0x3bf)[0]
        self.assertFalse(untouched['availability']['enabled'])
        status = enemies.read('forest_status')
        blocks = enemies.item_status_blocks()
        status['item_effects'] = blocks
        skills.extend_status_descriptors(status, blocks, {}, retain_skills=False)
        self.assertEqual(status['effects']['8']['frame_count'], 0)
        self.assertEqual(status['effects']['8']['interval_ms'], 80)
        scheduler = enemies.read('battle_scheduler')
        scheduler['idle_skills'].update(enemies.read('party_skills')['idle_skills'])
        result = subprocess.run(['node', '--input-type=module', '-e', CONTRACT], cwd=RUNTIME,
            input=json.dumps(dict(catalog=catalog, ids=IDS, status=status,
                seed=enemies.read('opening_seed'), attributes=enemies.read('party_combat'), commands=enemies.read('party_skills'),
                forest=enemies.read('forest_combat'), scheduler=scheduler, ai=enemies.read('forest_ai'), rewards=enemies.read('party_rewards'),
                player=enemies.read('party_combat')['actors']['001'], enemy=enemies.read('forest_combat')['actors']['012'],
                reactions=enemies.read('party_reactions'),
                instructions=json.loads((RUNTIME / 'evidence/forest_status_instructions_20261011.json').read_text('utf-8')),
                recovery=json.loads((RUNTIME / 'evidence/battle_revive_recovery_native_20261015.json').read_text('utf-8')),
                clearProof=json.loads((RUNTIME / 'evidence/fire_valley_20261025/support_507e20.json').read_text('utf-8')),
                proof=json.loads((RUNTIME / 'evidence/fire_valley_20261024/stage12_status_apply.json').read_text('utf-8')),
                status20=bytes.fromhex(enemies.CHR(enemies.ROOT / 'Fight_Role/021.CHR').skills[16]['fixed_raw_hex'])[0x16b:0x231].hex(),
                dispatchProof=json.loads((RUNTIME / 'evidence/inner_white_forest_20261030/item399_native.json').read_text('utf-8'))['records'][0])),
            encoding='utf-8', capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(comparisons=56, cures=14, periodic=14, clears=2, revival=True, scheduled=9, item399=3))


if __name__ == '__main__':
    unittest.main()
