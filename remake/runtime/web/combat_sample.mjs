// Bounded adapter from raw persistent DWORD resource bits to native battle data.
// The actor/equipment source is one verified historical level-12 save. This is
// an explicitly controlled encounter and fresh status/stance initialization.
import {configureSkills} from './core/skill_config.mjs';
const clone = value => structuredClone(value);
const addr = n => `0x${n.toString(16).padStart(8,'0')}`;
function requireValue(ok,message) { if(!ok)throw new Error(message); }
function uint(value,name) { requireValue(Number.isInteger(value)&&value>=0&&value<=0xffffffff,`${name}不是原始DWORD`);return value; }
function int(value,name) { requireValue(Number.isInteger(value)&&value>=-2147483648&&value<=2147483647,`${name}不是有符号原始值`);return value; }
function applyProgress(player,role){
  if(!role.combat_progress)return;
  const raw=role.combat_progress.header_raw_hex;requireValue(/^(?:[0-9a-f]{2}){779}$/.test(raw),'保存成长头无效');
  const b=Uint8Array.from(raw.match(/../g),h=>parseInt(h,16)),v=new DataView(b.buffer),at=n=>v.getInt32(n,true);
  requireValue(at(0x24)===role.level&&at(0x34)===role.hp.maximum&&at(0x3c)===role.mp.maximum,'保存成长头不匹配');
  for(const [name,p]of [['attack',0x40],['defense',0x48]])requireValue(role.attributes_stored?.[name]?.current===at(p)&&role.attributes_stored?.[name]?.base===at(p+4),'保存成长属性不匹配');
  player.level=role.level;player.header_raw_hex=raw;
  for(const key of Object.keys(player.raw_by_address))player.raw_by_address[key]=at(Number(key)-0x0524a6d1);
  const sums=player.equipment.item_sums_by_offset,t=o=>{const n=sums['0x'+o.toString(16)];requireValue(Number.isInteger(n),'原装备属性缺失');return n;},link=player.linked_by_address;
  const hp=Math.trunc((at(0x34)+t(0x11))*t(0x35)/100),mp=Math.trunc((at(0x3c)+t(0x19))*t(0x3d)/100);
  for(const [n,value]of [[0x4f99088,t(0x0d)+hp],[0x4f9908c,t(0x11)+hp],[0x4f99090,t(0x15)+mp],[0x4f99094,t(0x19)+mp]])link[addr(n)]=value;
  for(const [n,p,add,pct]of [[0x4f99098,0x40,0x1d,0x41],[0x4f9909c,0x48,0x21,0x45],[0x4f990a0,0x50,0x25,0x49],[0x4f990a4,0x58,0x29,0x4d]])link[addr(n)]=t(add)+Math.trunc((at(p)+t(add))*t(pct)/100);
  link[addr(0x4f990a8)]=t(0x2d)+Math.trunc((at(0xb8)+t(0x1d))*t(0x51)/100);
  player.raw_hp_maximum=at(0x34);player.raw_mp_maximum=at(0x3c);player.resource_bonuses={hp_current:link[addr(0x4f99088)],hp_maximum:link[addr(0x4f9908c)],mp_current:link[addr(0x4f99090)],mp_maximum:link[addr(0x4f99094)]};
  player.equipment.current_and_max_hp_percent_term=hp;player.equipment.current_and_max_mp_percent_term=mp;
}

/** Copy a persistent snapshot into one isolated native battle fixture.
 * No equipment/header defaults are silently substituted for a different save.
 * A dead raw HP DWORD is decoded as signed before adding linked HP, so callers
 * can also use this adapter to show the field HUD without resurrecting actors.
 */
export function createBattleSample(worldSnapshot,data,skillConfig=null) {
  requireValue(data?.schema==='seventh-seal-combat-sample'&&data.version===1,'战斗样本版本不兼容');
  requireValue(worldSnapshot?.source?.sha256===data.source.required_world_source.sha256,'当前存档不属于已验证的战斗属性样本');
  const role=worldSnapshot.party?.find(actor=>actor.id==='001');
  requireValue(role,'当前队伍没有英格妮');
  const sample=clone(data), player=sample.actors.find(actor=>actor.id==='001');
  requireValue(player&&sample.actors.length===2,'战斗样本角色缺失');
  applyProgress(player,role);
  requireValue(role.level===player.level&&role.name===player.name,'当前等级尚未纳入战斗属性恢复');
  for(const [field,offset] of [['attack',0x40],['defense',0x48]]) {
    const stored=role.attributes_stored?.[field];
    requireValue(stored?.current===player.raw_by_address[addr(0x0524a6d1+offset)]&&
      stored?.base===player.raw_by_address[addr(0x0524a6d1+offset+4)],'当前保存属性尚未纳入战斗装备映射');
  }
  requireValue(uint(role.hp.maximum,'HP最大值')===player.raw_hp_maximum&&
    uint(role.mp.maximum,'MP最大值')===player.raw_mp_maximum,'当前最大资源尚未纳入战斗装备百分比映射');
  const rawHP=uint(role.hp.current,'HP')|0, rawMP=uint(role.mp.current,'MP')|0;
  const bonus=player.resource_bonuses;
  const hp=int(rawHP+bonus.hp_current,'实际HP'), mp=int(rawMP+bonus.mp_current,'实际MP');
  requireValue(hp>=0&&mp>=0,'原始资源低于当前装备可表示的范围');
  Object.assign(player,{raw_hp:rawHP,raw_mp:rawMP,state_raw:hp===0?4:0,
    hp:{current:hp,maximum:role.hp.maximum+bonus.hp_maximum},
    mp:{current:mp,maximum:role.mp.maximum+bonus.mp_maximum}});
  player.raw_by_address[addr(0x0524a701)]=rawHP;
  player.raw_by_address[addr(0x0524a705)]=role.hp.maximum;
  player.raw_by_address[addr(0x0524a709)]=rawMP;
  player.raw_by_address[addr(0x0524a70d)]=role.mp.maximum;
  if(skillConfig){sample.skills=configureSkills(sample.skills,skillConfig);sample.source.skill_configuration={mode:skillConfig.mode,version:skillConfig.version,
    skills:Object.fromEntries(Object.entries(sample.skills).map(([id,skill])=>[id,clone(skill.configuration)]))};}
  for(const actor of sample.actors) {
    const skill=sample.skills[actor.side==='player'?'yantu':sample.enemy_skill_id];
    actor.current_skill=clone(skill);
    actor.action_mask_raw=skill.action_mask_raw;
    actor.class_raw=skill.class_raw;
  }
  sample.source.world_revision=worldSnapshot.revision;
  sample.source.current_world_raw_resources={hp_uint32:role.hp.current,mp_uint32:role.mp.current,hp_signed:rawHP,mp_signed:rawMP};
  return sample;
}

/** Convert battle HUD resources back to the original stored DWORD bits.
 * Native lethal damage sets raw HP to -linkedHP (e.g. -96 = 0xffffffa0).
 * Encoding those bits preserves death on re-entry and matches native DWORD
 * serialization; clamping raw to zero would restore 96 effective HP.
 */
export function resourcesForWorld(actor) {
  requireValue(actor?.side==='player'&&actor.id==='001','当前资源适配只覆盖英格妮');
  const bonus=actor.resource_bonuses;
  requireValue(bonus&&actor.status_by_address?.[addr(0x0521f551)]===0&&actor.status_by_address?.[addr(0x0521f559)]===0,'当前状态资源调整尚未纳入持久化');
  const hp=int(actor.hp.current-bonus.hp_current,'原始HP'), mp=int(actor.mp.current-bonus.mp_current,'原始MP');
  requireValue(actor.raw_hp===hp&&actor.raw_by_address?.[addr(0x0524a701)]===hp,'HP显示与原始提交字段不一致');
  requireValue(actor.raw_mp===mp&&actor.raw_by_address?.[addr(0x0524a709)]===mp,'MP显示与原始提交字段不一致');
  requireValue(actor.hp.maximum===actor.raw_hp_maximum+bonus.hp_maximum&&actor.mp.maximum===actor.raw_mp_maximum+bonus.mp_maximum,'当前资源上限发生未支持的变化');
  return {hp:hp>>>0,mp:mp>>>0};
}

/** MP cost commits effective/current raw resources together at dispatch.
 * Original sample costs remain zero; nonzero costs are explicit debug inputs.
 */
export function consumeBattleMp(actor,cost){
  requireValue(Number.isInteger(cost)&&cost>=0&&cost<=0x7fffffff,'MP成本无效');
  requireValue(actor.mp.current>=cost,'MP不足');
  const bonus=actor.resource_bonuses?.mp_current;
  requireValue(Number.isInteger(bonus)&&actor.raw_mp===actor.mp.current-bonus&&actor.raw_by_address?.[addr(0x0524a709)]===actor.raw_mp,'MP显示与原始提交字段不一致');
  const raw=int(actor.raw_mp-cost,'扣费后原始MP');
  return {...clone(actor),raw_mp:raw,raw_by_address:{...actor.raw_by_address,[addr(0x0524a709)]:raw},mp:{...actor.mp,current:actor.mp.current-cost}};
}
