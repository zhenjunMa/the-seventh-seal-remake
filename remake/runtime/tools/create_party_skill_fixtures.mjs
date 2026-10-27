// Source-backed level-99 development saves; never installs into player slots.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createPartySkillSample,PARTY_SKILL_SAMPLE_ROSTERS,partySampleSkillIndices} from '../web/core/party_skill_sample.mjs';
import {allPartyRoles} from '../web/core/party_roster.mjs';
import {encodeSave,decodeSave} from '../web/core/world.mjs';

const runtime=new URL('../',import.meta.url),folder=new URL('evidence/party_skill_alignment_20261027/',runtime);
const read=async path=>JSON.parse(await readFile(new URL(path,runtime),'utf8'));
const digest=raw=>createHash('sha256').update(raw).digest('hex');
const check=process.argv.slice(2).includes('--check');
if(process.argv.slice(2).some(arg=>arg!=='--check'))throw new Error('用法：node remake/runtime/tools/create_party_skill_fixtures.mjs [--check]');
const [seed,rewards,commands,forest]=await Promise.all(['web/data/opening_seed.json','web/data/party_rewards.json','web/data/party_skills.json','web/data/maps/m70010.json'].map(read));
const {x,y,direction}=forest.route_entry,location={map_id:forest.id,x,y,direction};
const files=new Map(),entries=[];
const runtimeSkills=new Map([...Object.values(commands.skills),...Object.values(commands.field_skills??{})].map(skill=>[`${skill.actor_id}_${skill.original_skill_index}`,skill]));
function prerequisites(skill,role){
  const raw=Buffer.from(skill.fixed_raw_hex,'hex'),parts=[];
  for(let slot=0;slot<4;slot++){
    const id=raw.readInt8(0x360+slot*5);if(!id)continue;
    const index=role.skills.findIndex(row=>Buffer.from(row.fixed_raw_hex,'hex').readInt8(0)===id-1);
    parts.push(`${index<0?'原ID '+(id-1):role.skills[index].name||'原索引 '+index} 技巧等级≥${raw.readInt32LE(0x361+slot*5)}`);
  }
  return parts.join('；')||'无';
}
function document(group,world,envelope){
  const active=world.party.map(role=>`${role.name}（${role.id}）`).join('、'),reserve=world.reserve_party.map(entry=>`${entry.role.name}（${entry.role.id}）`).join('、');
  const lines=[`# 六队友技能测试 ${group}：99级全技能`, '',`日期：2026-10-27。出场四人：${active}；候补：${reserve}。两组存档都保存六名队友的99级状态。`,'',
    `测试存档：[party_skill_${group.toLowerCase()}_99_save.json](party_skill_${group.toLowerCase()}_99_save.json)；校验 SHA-256：\`${envelope.sha256}\`。另一组见 [测试 ${group==='A'?'B':'A'}](test_${group==='A'?'b':'a'}_99.md)。`,'',
    '从 `remake/start.cmd` 启动游戏，进入地图后，在“开发检查”选择对应的“99级全技能”样本。也可在游戏“导入存档”中选择上面的 JSON，直接恢复这组世界；导入只替换当前运行进度，需要时再手动另存为空槽。生成工具不会写入 `remake/saves` 或覆盖已有玩家存档。','',
    '六人均调用正式 `applyExperience` 和各自的原成长行逐级升到99级，成长随机固定取0。已学标记保存在每人的 `skill_progress`；保留原技巧等级和熟练度经验。源 CHR、技能类型、数值配置、学习等级和前置技巧等级都不修改，正常新游戏不会获得这些测试授予。','',
    '检查方法：','',
    '1. 打开人物菜单，核对当前四名队友均为99级、HP／MP为升级后资源；切换角色核对下表技能名称和原索引。候补两人保持99级并保留技能进度，当前菜单及战斗仍只使用出场四人。',
    '2. 白木森林入口已设置开发遇敌检查点（原RNG seed 294、领队计数40）；向可行走方向移动满16像素后，沿正式遇敌和战斗入口测试四人。',
    '3. 依次测试攻击、恢复、复活、状态、援攻和奥义；在战斗与场外分别检查菜单资格、目标、耗蓝、原动作、命中特效、结算以及死亡／起身。原type0记录只核对学习持久化和原菜单资格。',
    '4. 将测试进度手动存入空槽，返回标题再读档，核对六人等级、出场／候补、已学索引和熟练度仍一致。随后导入另一组，覆盖其余人物。',
    '5. 正式条件回归使用正常新游戏或未授予样本：未学技巧仍不可用，已学技巧仍检查原等级。下表“原学习等级”和“原前置技巧等级”来自固定记录，不因本样本99级或已学标记而变更。','',
    '下表等级0表示原记录无额外等级门槛；“原初始已学”只记录来源字节。前置技巧栏保留原四槽全部非零条件，不把没有前置技巧的未学记录推断为已经完成自然学习。type1／2／3沿原分类；两条原type0援攻保留原类型。','',
    '以下为本组四名出场人物的全量命名技巧；正式学习处理仍沿共享成长／学习规则执行。',''];
  for(const role of world.party){
    const source=commands.roles[role.id],indices=partySampleSkillIndices(source);
    lines.push(`## ${role.name}（${role.id}）：${indices.length} 条`, '',
      '| 原索引／配置编号 | 技巧 | 原类型 | 原学习等级 | 原初始已学 | 原前置技巧等级 | 运行登记 |',
      '| --- | --- | --- | --- | --- | --- | --- |');
    for(const index of indices){
      const skill=source.skills[index],key=`${role.id}_${index}`,live=runtimeSkills.get(key),raw=Buffer.from(skill.fixed_raw_hex,'hex');
      lines.push(`| ${index}／\`${live?.id??key}\` | ${skill.name} | ${skill.type_raw} | ${raw.readInt32LE(0x143)} | ${raw[0x23]?'是':'否'} | ${prerequisites(skill,source)} | ${live?live.battle_handler??'场外技能':skill.type_raw===0?'保留原type0资格':'未登记'} |`);
    }
    lines.push('');
  }
  lines.push('重建及只读核对（从游戏目录执行）：','', '```console',
    'node remake/runtime/tools/create_party_skill_fixtures.mjs',
    'node remake/runtime/tools/create_party_skill_fixtures.mjs --check', '```','',
    '重建仅更新本证据目录的两份样本和说明。来源文件及payload指纹见 [fixture_manifest.json](fixture_manifest.json)。此文档提供可重复步骤；浏览器逐技能实测结果由同目录后续验证材料记录。','');
  return lines.join('\n');
}
for(const [group,activeRoleIds]of Object.entries(PARTY_SKILL_SAMPLE_ROSTERS)){
  const world=createPartySkillSample(seed,rewards,commands,location,{activeRoleIds}),envelope=await encodeSave(world);
  const name=`party_skill_${group.toLowerCase()}_99_save.json`;
  if(check){
    const actual=await decodeSave(await read(`evidence/party_skill_alignment_20261027/${name}`));
    if(!isDeepStrictEqual(actual,world))throw new Error(`${name} 与当前来源不一致，请重建`);
  }else files.set(name,JSON.stringify(envelope,null,2)+'\n');
  files.set(`test_${group.toLowerCase()}_99.md`,document(group,world,envelope));
  entries.push({group,file:name,payload_sha256:envelope.sha256,active_role_ids:activeRoleIds,reserve_role_ids:world.reserve_party.map(entry=>entry.role.id),
    roles:allPartyRoles(world).sort((a,b)=>a.id.localeCompare(b.id)).map(role=>({id:role.id,name:role.name,level:role.level,learned_indices:role.skill_progress.learned_indices,
      named_type_1_2_3:commands.roles[role.id].skills.filter(skill=>skill.name?.trim()&&[1,2,3].includes(skill.type_raw)).length}))});
}
const sourceFiles=['web/data/opening_seed.json','web/data/party_rewards.json','web/data/party_skills.json','web/data/maps/m70010.json','web/data/config/skills.json'];
const source_sha256=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>[path,digest(await readFile(new URL(path,runtime)))])));
files.set('fixture_manifest.json',JSON.stringify({schema:'seventh-seal-party-skill-fixtures',version:1,date:'2026-10-27',location,
  level:99,growth_rng:'constant 0 through normal applyExperience',learning:'saved learned_indices only; source type and conditions preserved',
  writes_player_slots:false,source_sha256,fixtures:entries},null,2)+'\n');
if(!check)await mkdir(folder,{recursive:true});
for(const [name,body]of files){
  if(check){if(await readFile(new URL(name,folder),'utf8')!==body)throw new Error(`${name} 与当前来源不一致，请重建`);}
  else await writeFile(new URL(name,folder),body);
}
console.log(check?'两份99级全技能存档、说明与来源指纹一致。':`已生成：${[...files.keys()].join('、')}；玩家存档未写入。`);
