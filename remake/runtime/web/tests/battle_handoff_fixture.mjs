// Controlled source-data scenarios shared by Node and the Phaser check page.
// HP submission is held only to observe a whole chain; masks, reactions,
// charging, animation intervals and normal action arbitration stay in core.
import {BattleView} from '../battle_view.mjs';
import {BattleController} from '../core/battle/battle_controller.mjs';
import {WorldStore} from '../core/world/world.mjs';
import {createPartySkillSample} from '../core/party/party_skill_sample.mjs';
import {createPartyActors,consumePartyMp} from '../core/party/party_attributes.mjs';
import {assembleForestSample} from '../forest_sample.mjs';
import {directSequence,composeNativeSequence} from '../core/battle/skill_sequence.mjs';
import {resolveAction} from '../core/battle/combat_rules.mjs';
import {createRewardLedger} from '../core/battle/battle_rewards.mjs';

const relay=[['004_19','004_18'],['001_46','001_33'],['003_21','003_26','003_29'],['kai_luoyan','002_26']];
export const handoffCases={
  relay:{lists:relay,enemy:'012',ordered:true},
  natural:{lists:relay,enemy:'012',ordered:false},
  ordinary:{lists:[['yantu'],['kai_mieyan'],['003_21'],['006_20']],enemy:'013',ordered:false},
  gap:{lists:[['yantu'],['kai_mieyan']],enemy:'013',ordered:false,blocked:true},
};

export async function createHandoffFixture({load,canvas,assetLoader,scenario='relay',onImages=()=>{},onEvent=()=>{}}){
  const config=handoffCases[scenario];if(!config)throw new Error('未知交接验证场景');
  const [seed,attributes,commands,forest,scheduler,reactions,ai,rewards]=await Promise.all(
    ['opening_seed','party_combat','party_skills','forest_combat','battle_scheduler','party_reactions','forest_ai','party_rewards'].map(name=>load(`/data/${name}.json`)));
  const ids=config.lists.map(list=>commands.skills[list[0]].actor_id),active=[...ids];
  for(const id of ['001','002','003','004','005','006'])if(active.length<4&&!active.includes(id))active.push(id);
  const initial=createPartySkillSample(seed,rewards,commands,{map_id:'M70010',x:608,y:1408,direction:2},{activeRoleIds:active});
  const world=new WorldStore(initial,['M17010','M70010']);
  const skills=Object.fromEntries([...new Set(config.lists.flat())].map(id=>[id,structuredClone(commands.skills[id])]));
  const sample=assembleForestSample({actors:createPartyActors(world.snapshot(),attributes).filter(actor=>ids.includes(actor.id)),skills,skill_data:commands,source:{party_new_game:true}},
    forest,{map_id:'M70010',members:[{id:config.enemy}]},{...scheduler,idle_skills:{...scheduler.idle_skills,...commands.idle_skills}},ai,null,reactions);
  const commandIds=config.lists.map((list,index)=>{
    if(list.length===1)return list[0];
    const members=list.map(id=>skills[id]),units=members.reduce((n,s)=>n+new DataView(Uint8Array.from(s.fixed_raw_hex.match(/../g),h=>parseInt(h,16)).buffer).getUint32(0x36,true),0);
    if(new Set(list).size!==list.length||units>7)throw new Error('验证编成不符合球数或重复限制');
    const id=`handoff:${ids[index]}`;
    sample.skills[id]={...structuredClone(members[0]),id,battle_handler:'combination',component_skill_ids:list,mp_cost:members.reduce((n,s)=>n+s.mp_cost,0)};
    return id;
  });
  const view=new BattleView({canvas,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json',jsonLoader:load,assetLoader});
  const leases=[];await view.prepare({actors:sample.actors,skills:sample.skills,inventory:[],staged:true});view.setRoster(sample.actors,sample.skills);onImages(view.images);
  for(const skill of [...commandIds.map(id=>sample.skills[id]),...Object.values(sample.skills).filter(skill=>skill.actor_id==='enemy-0')]){
    const members=skill.battle_handler==='combination'?skill.component_skill_ids.map(id=>sample.skills[id]):[skill];
    const plan=members.length===1?directSequence(skill):composeNativeSequence(members,members.map(s=>s.original_skill_index));
    const lease=await view.prepareAction({actor_id:skill.actor_id,target_id:skill.actor_id==='enemy-0'?ids[0]:'enemy-0',skill_id:skill.id,plan});
    leases.push(lease);onImages(lease.images);
  }
  let now=0,charged=false;const events=[];
  const battle=new BattleController({world,now:()=>now,id:()=>`handoff-${scenario}`,consumeResources:consumePartyMp,resolveAction,applyDamage:actor=>actor,
    playSequence:(event,hooks)=>view.playSequence(event,hooks),log:event=>{
      const row={at:now,...event};
      if(event.type==='battle-impact'){
        const entry=battle.state.history.find(h=>h.action_id===event.action_id),contact=entry.contacts.at(-1);
        row.target_skill_before=parseInt(contact.before.target.current_skill.fixed_raw_hex.slice(0,2),16);
        row.settled_before=contact.before.target.settled_raw;row.chain=battle.state.reward_ledger.chain.count;
        if(event.hit&&!charged&&battle.actor(event.actor_id).side==='player'){
          const enemy=battle.actor('enemy-0');enemy.charge.delay=0;enemy.charge.gauge=battle.state.scheduler.threshold;charged=true;
        }
      }
      if(event.type==='battle-scheduled'&&event.actor_id==='enemy-0')battle.actor('enemy-0').charge.delay=1000000;
      events.push(row);onEvent(row);
    }});
  battle.start({...sample,lifecycle_enabled:true,rng:()=>50});
  for(const event of [...battle.state.lifecycle_events])battle.ackLifecycle(event);
  battle.state.reward_ledger=createRewardLedger(battle.state.id,battle.state.actors);
  view.nativeControl=battle;view.nativeControlIsCurrent=()=>view.nativeControl===battle;
  for(const actor of battle.state.actors){actor.charge.gauge=battle.state.scheduler.threshold;actor.charge.delay=actor.side==='enemy'||config.blocked&&actor.id!==ids[0]?1000000:0;}
  for(const [index,id]of ids.entries())battle.queueCommand({actor_id:id,skill_id:commandIds[index],target_id:'enemy-0'});
  const chooseOrder=()=>{if(config.ordered&&battle.state.scheduler.pending)battle.actor(battle.state.scheduler.pending.actor_id).charge.gauge=10000000;};
  chooseOrder();battle.scheduleReady();
  return {battle,view,world,events,config,sample,
    async advance(at,{render=true,repaints=1}={}){
      now=at;chooseOrder();battle.advanceClock(now);const snapshot=battle.presentationSnapshot();view.advance(snapshot,now);
      if(render)for(let paint=0;paint<repaints;paint++)view.draw(snapshot,now);
      for(const event of view.drainLifecycleCompleted())battle.ackLifecycle(event);
      for(let index=0;index<6;index++)await Promise.resolve();
      if(battle.state.phase==='interrupted')throw new Error(battle.state.error);
    },
    get finished(){return events.some(e=>e.type==='battle-scheduled'&&e.actor_id==='enemy-0')&&!battle.running&&!battle.pendingPresentations.size&&!battle.hasLifecycle();},
    dispose(){battle.interrupt(new Error('交接验证结束'));view.destroy();for(const lease of leases)lease.release();},
  };
}
