// Current party commands use their CHR records, independent of the retained
// historical battle fixture. Every implemented role command uses the same
// owner/source-bound numeric configuration registry.
import {createPartyActors} from './core/party/party_attributes.mjs';
import {runtimeSkillParameters,skillOwner} from './core/config/skill_registry.mjs';
import {battleMenuSkillOrder,validateSourceSkillShortcuts} from './core/party/skill_shortcuts.mjs';
import {partyBattleSkills,battleSkillEligibility,effectiveBattleSkillRoles,applySavedSkillProgress} from './core/battle/battle_skill_access.mjs';
import {correctPartySkillType} from './core/party/party_skill_corrections.mjs';
import {createBattleTechniques} from './core/battle/battle_techniques.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(message);};
const fixed=skill=>{need(/^(?:[0-9a-f]{2}){1053}$/.test(skill?.fixed_raw_hex),'队伍技能源记录缺失');return skill.fixed_raw_hex;};
const byteAt=(hex,offset)=>parseInt(hex.slice(offset*2,(offset+1)*2),16);
const canonical=value=>JSON.stringify(value,(_key,row)=>row&&typeof row==='object'&&!Array.isArray(row)
  ?Object.fromEntries(Object.keys(row).sort().map(key=>[key,row[key]])):row);
const same=(a,b)=>canonical(a)===canonical(b);
export function createPartySample(world,attributes,commands,configured=null,itemData=null,techniqueCharset=null){
  need(commands?.schema==='seventh-seal-party-skills'&&commands.version===1,'队伍技能版本不兼容');
  const liveCommands=configured?.party_skills??commands,effectiveSource=effectiveBattleSkillRoles(liveCommands,world);validateSourceSkillShortcuts(world,effectiveSource);
  const ids=new Set(world.party.map(r=>r.id)),skills={};
  for(const [id,original]of Object.entries(partyBattleSkills(commands))){
    if(!ids.has(original.actor_id))continue;
    need(original.source?.path===`Fight_Role/${original.actor_id}.CHR`&&
      original.source.sha256===commands.source_hashes[original.source.path], '队伍技能与角色来源不同');
    const raw=fixed(correctPartySkillType(original));
    if(!battleSkillEligibility(world,configured?.skill_registry?.[id]??original).available)continue;
    need(original.id===id&&(byteAt(raw,0x32)&15)!==0&&(byteAt(raw,0x25)===0||['native-revival','native-support'].includes(original.battle_handler)),
      '队伍命令未学会或目标规则尚未接入');
    let skill=original;
    if(configured){
      const overlay=configured.skill_registry?.[id],cfg=overlay?.configuration;
      need(cfg&&same(cfg.owner,skillOwner(original,'player'))&&same(overlay.source,original.source),'队伍技能未登记统一配置或角色来源不同');
      need(same(runtimeSkillParameters(original),cfg.original)&&same(overlay.actions,original.actions),'队伍技能数值或动作与配置基线不同');
      skill=overlay;
    }
    skill=correctPartySkillType(applySavedSkillProgress(skill,world.party.find(role=>role.id===skill.actor_id)));skill.learned_effective=true;skills[id]=skill;
  }
  const selected=Object.fromEntries([...ids].map(id=>{const first=Object.values(skills).find(s=>s.actor_id===id);need(first,'当前角色没有已接入的可用攻击');return [id,first];}));
  const actors=createPartyActors(world,attributes,selected,itemData);
  Object.assign(skills,createBattleTechniques(world,effectiveSource,skills,techniqueCharset));
  return {actors,skills,skill_data:liveCommands,order:actors.map(a=>a.id),source:{party_new_game:true,world_revision:world.revision,
    player_command_order:Object.fromEntries([...ids].map(id=>[id,battleMenuSkillOrder(world,effectiveSource,skills,id)])),
    source_hashes:{...attributes.source_hashes,...commands.source_hashes},
    required_world_source:copy(attributes.source.required_world_source),
    ...(configured?.audit?{runtime_configuration:copy(configured.audit)}:{}),
    command_policy:'Live frame-driven charging; ready living party actors queue learned attacks and saved compositions while other animations continue.',
    skill_configuration_scope:'All implemented player and enemy skills share config/skills.json; source fingerprints and owner bindings are verified, overrides are merged with source defaults, and the full numeric snapshot is retained.',
    limitations:['Source gear must be equipped through the operation menu; legacy saves retain initial source weapons until first equipment change.', 'Compositions execute registered, learned and level-eligible member skills; unsupported source skills remain unavailable.']}};
}
