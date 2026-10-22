// New-game party commands use their CHR records, independent of the retained
// historical battle fixture. Every implemented role command uses the same
// owner/source-bound numeric configuration registry.
import {createPartyActors} from './core/party_attributes.mjs';
import {runtimeSkillParameters,skillOwner} from './core/skill_registry.mjs';
import {battleMenuSkillOrder,validateSourceSkillShortcuts} from './core/skill_shortcuts.mjs';
import {supportedBattleRecoverySkills,battleSkillEligibility,effectiveSkillSource,applySavedSkillProgress} from './core/battle_skill_access.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const fixed=skill=>{need(/^(?:[0-9a-f]{2}){1053}$/.test(skill?.fixed_raw_hex),'队伍技能源记录缺失');return Uint8Array.from(skill.fixed_raw_hex.match(/../g),x=>parseInt(x,16));};
const canonical=value=>JSON.stringify(Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
const same=(a,b)=>canonical(a)===canonical(b);
export function createPartySample(world,attributes,commands,configured=null,itemData=null){
  need(commands?.schema==='seventh-seal-party-skills'&&commands.version===1,'队伍技能版本不兼容');
  const effectiveSource=effectiveSkillSource(commands,world);validateSourceSkillShortcuts(world,effectiveSource);
  const ids=new Set(world.party.map(r=>r.id)),skills={};
  for(const [id,original]of Object.entries({...commands.skills,...supportedBattleRecoverySkills(commands)})){
    if(!ids.has(original.actor_id))continue;
    need(original.source?.path===`Fight_Role/${original.actor_id}.CHR`&&
      original.source.sha256===commands.source_hashes[original.source.path], '队伍技能与角色来源不同');
    const raw=fixed(original);
    if(!battleSkillEligibility(world,original).available)continue;
    need(original.id===id&&(raw[0x32]&15)!==0&&(raw[0x25]===0||original.battle_handler==='native-revival'),
      '队伍命令未学会或目标规则尚未接入');
    need(world.source.source_hashes?.[original.source.path]===commands.source_hashes[original.source.path], '队伍技能源指纹不同');
    let skill=copy(original);
    if(configured){
      const overlay=configured.skill_registry?.[id],cfg=overlay?.configuration;
      need(cfg&&same(cfg.owner,skillOwner(original,'player'))&&same(overlay.source,original.source),'队伍技能未登记统一配置或角色来源不同');
      need(same(runtimeSkillParameters(original),cfg.original)&&same(overlay.actions,original.actions),'队伍技能数值或动作与配置基线不同');
      skill=copy(overlay);
    }
    skill=applySavedSkillProgress(skill,world.party.find(role=>role.id===skill.actor_id));skill.learned_effective=true;skills[id]=skill;
  }
  const selected=Object.fromEntries([...ids].map(id=>{const first=Object.values(skills).find(s=>s.actor_id===id);need(first,'当前角色没有已接入的可用攻击');return [id,first];}));
  const actors=createPartyActors(world,attributes,selected,itemData);
  return {actors,skills,skill_data:commands,order:actors.map(a=>a.id),source:{party_new_game:true,world_revision:world.revision,
    player_command_order:Object.fromEntries([...ids].map(id=>[id,battleMenuSkillOrder(world,effectiveSource,skills,id)])),
    source_hashes:{...attributes.source_hashes,...commands.source_hashes},
    required_world_source:copy(attributes.source.required_world_source),
    ...(configured?.audit?{runtime_configuration:copy(configured.audit)}:{}),
    command_policy:'Live frame-driven charging; ready living party actors queue source learned direct attacks while other animations continue.',
    skill_configuration_scope:'All implemented player and enemy skills share config/skills.json; owner/source/original are verified before numeric parameters are applied.',
    limitations:['Source gear must be equipped through the operation menu; legacy saves retain initial source weapons until first equipment change.', 'All seven native slot bindings drive the wheel; direct attacks, item, defense and per-actor escape are connected. Player composed-technique execution remains unrecovered.']}};
}
