// Content admission is data; source formats and implemented handlers remain code.
import compiledContent from '../data/runtime_content.mjs';
export {definition as runtimeContentDefinition} from '../data/runtime_content.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`内容登记：${message}`);};
export const roleId=id=>typeof id==='string'&&/^\d{3}$/.test(id);
export const mapId=id=>typeof id==='string'&&/^M\d{5}$/.test(id);
export const sourceHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateContentRegistration(content){
  need(content?.schema==='seventh-seal-runtime-content'&&content.version===1,'版本无效');
  // Four active formation positions are a recovered rule, not a content option.
  need(content.party_limit===4,'当前只实现四个参战队列位置');
  need(content.roles&&Object.keys(content.roles).length>0,'角色表缺失');
  const slots=new Set(),skillIds=new Set();
  for(const [id,role]of Object.entries(content.roles)){
    need(roleId(id)&&['player','enemy'].includes(role.side),'角色编号或阵营无效');
    need(role.source?.path===`Fight_Role/${id}.CHR`&&sourceHash(role.source.sha256),`角色 ${id} 来源无效`);
    if(role.side==='player'){
      need(Number.isInteger(role.native_slot)&&role.native_slot>=0&&role.native_slot<10&&!slots.has(role.native_slot),'原角色槽重复或无效');
      slots.add(role.native_slot);
      need(Array.isArray(role.battle_skills)&&role.battle_skills.length>0&&role.battle_skills.some(skill=>skill.index===role.primary_skill),'玩家缺少主要战斗技能登记');
      for(const rows of [role.battle_skills,role.field_skills??[]]){
        need(new Set(rows.map(row=>row.index)).size===rows.length,'角色技能索引重复');
        for(const skill of rows){
          need(Number.isInteger(skill.index)&&skill.index>=0&&skill.index<200&&/^[A-Za-z0-9_]+$/.test(skill.id)&&!skillIds.has(skill.id),'技能源索引或ID无效');skillIds.add(skill.id);
        }
      }
      need(role.battle_skills.every(skill=>['direct','effect-carrier'].includes(skill.handler)),'战斗技能处理器尚未实现');
    }
  }
  for(const [name,ids]of Object.entries(content.battle_rosters??{})){
    need(name&&Array.isArray(ids)&&ids.length>=2&&new Set(ids).size===ids.length&&ids.every(id=>content.roles[id]),'战斗资源名单无效');
  }
  for(const [id,stage]of Object.entries(content.stages??{})){
    need(/^[A-Za-z0-9_-]+$/.test(id)&&/^data\/[A-Za-z0-9_/-]+\.json$/.test(stage.path),'战斗场景路径无效');
    need(['seventh-seal-forest-stage','seventh-seal-battle-stage'].includes(stage.schema)&&/^assets\/[A-Za-z0-9_/-]+\/$/.test(stage.asset_prefix),'战斗场景格式未支持');
  }
  const stages=Object.values(content.stages??{});
  need(new Set(stages.map(row=>row.path)).size===stages.length&&new Set(stages.map(row=>row.asset_prefix)).size===stages.length,'战斗场景产物路径重复');
  for(const [id,source]of Object.entries(content.programs??{}))
    need(/^[a-z0-9_-]+$/.test(id)&&source?.path?.toLowerCase()===`animate/${id}.anm`&&sourceHash(source.sha256),'演出来源无效');
  for(const [id,row]of Object.entries(content.maps??{})){
    need(mapId(id)&&row.path===`data/maps/${id.toLowerCase()}.json`,'地图路径无效');
    for(const key of ['triggers','objects','rests','routes'])need(Array.isArray(row[key]),`地图 ${id} 缺少 ${key}`);
    for(const [rows,key]of [[row.triggers.map(id=>({id})),'id'],[row.objects,'index'],[row.rests,'descriptor_id'],[row.routes,'record_id']])
      need(rows.every(r=>Number.isInteger(r[key])&&r[key]>=0)&&new Set(rows.map(r=>r[key])).size===rows.length,`地图 ${id} 入口重复或无效`);
    need(row.objects.every(r=>r.handler==='stationary-chest'),'物件处理器尚未实现');
    need(row.rests.every(r=>Number.isInteger(r.record_id)&&r.record_id>0&&Array.isArray(r.restore_records)&&r.restore_records.length>0&&r.restore_records.every(n=>Number.isInteger(n)&&n>0)&&Array.isArray(r.choices)&&r.choices.length>=1&&r.choices.length<=3&&r.choices.every(c=>Number.isInteger(c.index)&&c.index>=0&&c.index<3&&typeof c.text==='string'&&Number.isInteger(c.record_id)&&c.record_id>=0)),'休息入口无效');
    if(row.entry_record!==undefined)need(Number.isInteger(row.entry_record)&&row.entry_record>0,'进入剧情记录无效');
    if(row.npcs!==undefined)need(Array.isArray(row.npcs)&&new Set(row.npcs).size===row.npcs.length&&row.npcs.every(n=>Number.isInteger(n)&&n>=0&&n<499),'NPC 槽登记无效');
    need(row.routes.every(r=>Number.isInteger(r.record_id)&&r.record_id>0&&(r.descriptor_id===undefined||Number.isInteger(r.descriptor_id)&&r.descriptor_id>=0)),'出口记录无效');
    need(row.routes.every(r=>r.requires_flag===undefined||Number.isInteger(r.requires_flag?.index)&&r.requires_flag.index>=0&&r.requires_flag.index<2000&&Number.isInteger(r.requires_flag.bit)&&r.requires_flag.bit>=1&&r.requires_flag.bit<=32),'出口前置旗标无效');
    need(row.routes.every(r=>r.animation===undefined||typeof r.animation==='string'&&Number.isInteger(r.denial_record_id)&&r.denial_record_id>0&&content.roles[r.speaker_role_id]?.side==='player'),'出口拒绝分支无效');
  }
  return content;
}
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
// Validate at boot/export boundaries. Keeping import free of validation lets
// the exporter repair an older generated registration after schema additions.
export const runtimeContent=freeze(compiledContent);
export function registeredRoles(side,content=runtimeContent){return Object.keys(content.roles).filter(id=>!side||content.roles[id].side===side);}
export function requireRegisteredRoles(ids,{side=null,roster=null,complete=false}={},content=runtimeContent){
  need(Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&ids.every(id=>roleId(id)&&content.roles[id]&&(!side||content.roles[id].side===side)),'角色未登记、重复或阵营不符');
  const expected=roster?content.battle_rosters[roster]:complete?registeredRoles(side,content):null;
  if(roster)need(expected,`战斗名单 ${roster} 未登记`);
  if(expected)need(ids.length===expected.length&&ids.every(id=>expected.includes(id)),'资源角色表与登记名单不同');
  return ids;
}
export function storyBindings(id,content=runtimeContent){return content.maps[id]??{triggers:[],objects:[],rests:[],routes:[]};}
export function battleStage(stage,content=runtimeContent){
  const id=stage?.replace(/\.scn$/i,''),entry=content.stages[id];
  need(entry,`战斗场景 ${stage} 未登记`);return entry;
}
