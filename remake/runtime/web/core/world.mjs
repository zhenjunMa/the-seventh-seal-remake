// Persistent game data. Camera, image caches and animation cursors live elsewhere.
export const WORLD_SCHEMA = 'seventh-seal-world';
export const WORLD_VERSION = 1;
import {validateEncounterState} from './encounters.mjs';
import {validateEquipmentState} from './equipment.mjs';
import {validateSkillShortcutState} from './skill_shortcuts.mjs';
import {validateTechniqueBindingsState,validateTechniqueCombinationState} from './menu_techniques.mjs';
import {validateFormationSlots} from './party_formation.mjs';
import {validateCrystalSocketState} from './crystal_sockets.mjs';
import {validateBattleSkillProgress} from './battle_skill_access.mjs';
const copy = value => structuredClone(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function uint(value, label) {
  requireValue(Number.isInteger(value) && value >= 0 && value <= 0xffffffff, `${label}无效`);
  return value;
}
function safeKey(value) { return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) && !['__proto__','constructor','prototype'].includes(value); }
function text(value, max = 150) { return typeof value === 'string' && value.length <= max; }

// Native 0x49f260 saves two areas. This version retains only the recovered
// selected byte and seven status bytes per area, never menu handles/UI state.
export function validateWorldMapState(value) {
  requireValue(object(value) && Object.keys(value).length === 1 && Array.isArray(value.areas) && value.areas.length === 2, '大地图状态表无效');
  const ids = new Set();
  for (const area of value.areas) {
    requireValue(object(area) && Object.keys(area).length === 3 && Object.keys(area).every(key => ['id','selected_index','statuses'].includes(key)), '大地图区域字段未支持');
    requireValue(Number.isInteger(area.id) && area.id >= 0 && area.id < 2 && !ids.has(area.id), '大地图区域编号无效');
    ids.add(area.id);
    requireValue(Array.isArray(area.statuses) && area.statuses.length === 7 && area.statuses.every(status => Number.isInteger(status) && status >= 0 && status <= 2), '大地图目的地状态无效');
    requireValue(Number.isInteger(area.selected_index) && area.selected_index >= 0 && area.selected_index < area.statuses.length, '大地图选择编号无效');
  }
  return copy(value);
}

export function validateWorld(value, mapIds = null) {
  requireValue(object(value) && value.schema === WORLD_SCHEMA && value.version === WORLD_VERSION, '存档格式或版本不兼容');
  const allowed = new Set(['schema','version','revision','location','leader_id','party','inventory','flags','event_records','object_states','source','world_map','encounters','money','reward_records','opening','equipment','skill_shortcuts','technique_bindings','technique_combinations','formation_slots','crystal_sockets']);
  requireValue(Object.keys(value).every(key => allowed.has(key)), '存档包含未支持的世界字段');
  // Optional v1 extension. Legacy saves keep their existing progress and do
  // not acquire a pending prologue simply because they predate this field.
  if ('opening' in value) {
    requireValue(object(value.opening) && Object.keys(value.opening).length === 2
      && value.opening.id === 'resurrect' && ['pending','complete'].includes(value.opening.status), '序章状态无效');
    requireValue(value.opening.status !== 'pending' || value.location?.map_id === 'M72061', '待播放序章的地图无效');
  }
  uint(value.revision, '世界版本');
  const at = value.location;
  requireValue(object(at) && safeKey(at.map_id) && (!mapIds || mapIds.includes(at.map_id)), '存档地图未纳入当前版本');
  requireValue(Number.isFinite(at.x) && Number.isFinite(at.y) && at.x >= 0 && at.y >= 0, '存档位置无效');
  requireValue(Number.isInteger(at.direction) && at.direction >= 0 && at.direction < 8, '存档朝向无效');
  requireValue(Array.isArray(value.party) && value.party.length > 0 && value.party.length <= 10, '队伍数据无效');
  const ids = new Set();
  for (const role of value.party) {
    requireValue(object(role) && safeKey(role.id) && !ids.has(role.id) && text(role.name), '队伍角色无效'); ids.add(role.id);
    if('skill_progress' in role)validateBattleSkillProgress(role.skill_progress);
    for (const field of ['hp','mp']) {
      requireValue(object(role[field]), `${field}数据无效`);
      uint(role[field].current, field); uint(role[field].maximum, field);
      // Original effective attributes may exceed stored maxima; retain observed values.
    }
    if('combat_progress' in role){
      requireValue(object(role.combat_progress)&&Object.keys(role.combat_progress).length===1&&/^(?:[0-9a-f]{2}){779}$/.test(role.combat_progress.header_raw_hex),'角色成长存档无效');
      const b=Uint8Array.from(role.combat_progress.header_raw_hex.match(/../g),h=>parseInt(h,16)),v=new DataView(b.buffer);
      requireValue(Number.isInteger(role.level)&&role.level>=1&&role.level<=99&&v.getUint32(0x24,true)===role.level&&v.getUint32(0x34,true)===role.hp.maximum&&v.getUint32(0x3c,true)===role.mp.maximum,'角色成长与保存上限不一致');
      for(const [name,at] of [['attack',0x40],['defense',0x48]])requireValue(role.attributes_stored?.[name]?.current===v.getInt32(at,true)&&role.attributes_stored?.[name]?.base===v.getInt32(at+4,true),'角色成长与保存属性不一致');
    }
  }
  requireValue(ids.has(value.leader_id), '当前角色不在队伍中');
  if('formation_slots' in value)validateFormationSlots(value.formation_slots,value.party);
  if('skill_shortcuts' in value)validateSkillShortcutState(value.skill_shortcuts,value.party);
  if('technique_bindings' in value)validateTechniqueBindingsState(value.technique_bindings,value.party);
  if('technique_combinations' in value)validateTechniqueCombinationState(value.technique_combinations,value.party);
  if ('equipment' in value) {
    validateEquipmentState(value.equipment, value.party);
    const equippedIds = new Set(Object.values(value.equipment.roles).flat().map(row=>row.instance_id));
    requireValue(Array.isArray(value.inventory)&&!value.inventory.some(row=>equippedIds.has(row.instance_id)), '同一实例不能同时在背包和装备栏');
  }
  requireValue(Array.isArray(value.flags) && value.flags.length === 2000, '事件旗标表应有2000项');
  value.flags.forEach(flag => uint(flag, '事件旗标'));
  requireValue(Array.isArray(value.event_records) && value.event_records.length === 2000, '事件记录表应有2000项');
  let recordCount = 0;
  for (const records of value.event_records) {
    requireValue(Array.isArray(records) && records.length <= 10000, '事件记录数量无效');
    recordCount += records.length;
    requireValue(records.every(raw => typeof raw === 'string' && /^[0-9a-f]{28}$/.test(raw)), '原始事件记录无效');
  }
  requireValue(recordCount <= 100000, '事件记录超出当前版本上限');
  requireValue(Array.isArray(value.inventory) && value.inventory.length <= 1000, '背包无效');
  const instances = new Set();
  for (const item of value.inventory) {
    requireValue(object(item) && safeKey(item.instance_id) && !instances.has(item.instance_id) && text(item.name), '背包实例无效');
    instances.add(item.instance_id); uint(item.id, '道具编号'); uint(item.quantity, '道具数量');
    requireValue(typeof item.source_raw_hex === 'string' && /^[0-9a-f]{458}$/.test(item.source_raw_hex), '道具原始实例缺失');
  }
  if('crystal_sockets' in value)validateCrystalSocketState(value.crystal_sockets,value.party,[...instances,...Object.values(value.equipment?.roles??{}).flat().map(row=>row.instance_id)]);
  requireValue(object(value.object_states) && Object.keys(value.object_states).length <= 10000, '场景对象状态无效');
  for (const [key, state] of Object.entries(value.object_states)) {
    requireValue(safeKey(key) && object(state), '场景对象状态键无效');
    requireValue(Object.keys(state).every(k => ['visible','frame','direction'].includes(k)), '场景对象字段未支持');
    if ('visible' in state) requireValue(typeof state.visible === 'boolean', '场景对象可见性无效');
    if ('frame' in state) uint(state.frame, '场景对象帧');
    if ('direction' in state) requireValue(Number.isInteger(state.direction) && state.direction >= 0 && state.direction < 8, '场景对象朝向无效');
  }
  requireValue(object(value.source) && text(value.source.path, 300) && /^[0-9a-f]{64}$/.test(value.source.sha256), '样本来源指纹缺失');
  if ('world_map' in value) validateWorldMapState(value.world_map);
  if ('encounters' in value) validateEncounterState(value.encounters,value.party);
  if('money' in value)uint(value.money,'金钱');
  if('reward_records' in value){
    requireValue(Array.isArray(value.reward_records)&&value.reward_records.length<=10000,'奖励记录数量无效');const seen=new Set();
    for(const r of value.reward_records){requireValue(object(r)&&Object.keys(r).length===2&&safeKey(r.battle_id)&&!seen.has(r.battle_id)&&object(r.summary)&&r.summary.battle_id===r.battle_id&&JSON.stringify(r.summary).length<=20000,'奖励提交记录无效');seen.add(r.battle_id);
      requireValue(Array.isArray(r.summary.experience)&&Array.isArray(r.summary.drops)&&r.summary.drops.length<=1000,'奖励结果存档无效');for(const key of ['money','money_before','money_after','maximum_player_chain','drop_bonus'])uint(r.summary[key],`奖励${key}`);
    }
  }
  const normalized = copy(value);
  // Exit marker/native coordinates belong to map evidence, never current position.
  normalized.location = {map_id: at.map_id, x: at.x, y: at.y, direction: at.direction};
  return normalized;
}

export class WorldStore {
  constructor(seed, mapIds) { this.mapIds = mapIds; this.value = validateWorld(seed, mapIds); }
  snapshot() { return copy(this.value); }
  get location() { return {...this.value.location}; }
  transact(change) {
    const next = this.snapshot(); change(next);
    next.revision = (this.value.revision + 1) >>> 0;
    this.value = validateWorld(next, this.mapIds);
    return this.snapshot();
  }
  replace(next) { this.value = validateWorld(next, this.mapIds); return this.snapshot(); }
  setEncounterState(next) {
    this.value.encounters=validateEncounterState(next,this.value.party);
    this.value.revision=(this.value.revision+1)>>>0;
  }
  setPosition(x, y, direction) {
    requireValue(Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0, '移动位置无效');
    requireValue(Number.isInteger(direction) && direction >= 0 && direction < 8, '移动朝向无效');
    const at = this.value.location;
    if (at.x === x && at.y === y && at.direction === direction) return;
    this.value.location = {...at, x, y, direction};
    this.value.revision = (this.value.revision + 1) >>> 0;
  }
}

export async function encodeSave(world) {
  const normalized = validateWorld(world);
  const payload = JSON.stringify(normalized);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return {schema: 'seventh-seal-save', version: 1, saved_at: new Date().toISOString(),
    payload, sha256: Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('')};
}

export async function decodeSave(input, mapIds) {
  requireValue(object(input) && input.schema === 'seventh-seal-save' && input.version === 1, '存档封装版本不兼容');
  requireValue(typeof input.payload === 'string' && input.payload.length <= 8_000_000 && /^[0-9a-f]{64}$/.test(input.sha256), '存档内容无效');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.payload));
  const actual = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  requireValue(actual === input.sha256, '存档校验失败，当前进度已保留');
  return validateWorld(JSON.parse(input.payload), mapIds);
}
