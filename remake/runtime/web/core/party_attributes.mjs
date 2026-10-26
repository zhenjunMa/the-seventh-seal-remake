// Native-new-game player attributes. No historical-save fallback and no gear
// inferred from inventory rewards. Battle statuses and stance are fresh copies.
import {idiv} from './combat_rules.mjs';
import {equipmentRows} from './equipment.mjs';
import {partyFormationSlots} from './party_formation.mjs';
import {socketEquipmentRows,crystalSocketRows,validateCrystalSocketDefinitions} from './crystal_sockets.mjs';
import {equipmentPassiveRows} from './item_passives.mjs';
import {runtimeContent,requireRegisteredRoles} from './content_registry.mjs';
const copy = value => structuredClone(value);
const addr = n => `0x${n.toString(16).padStart(8, '0')}`;
const need = (ok, message) => { if (!ok) throw new Error(message); };
const i32 = (n, label) => { need(Number.isInteger(n) && n >= -0x80000000 && n <= 0x7fffffff, `${label}不是有符号原始值`); return n; };
const u32 = (n, label) => { need(Number.isInteger(n) && n >= 0 && n <= 0xffffffff, `${label}不是原始DWORD`); return n; };
const bytes = (raw, count, label) => {
  need(typeof raw === 'string' && new RegExp(`^(?:[0-9a-f]{2}){${count}}$`).test(raw), `${label}原始记录无效`);
  return Uint8Array.from(raw.match(/../g), b => parseInt(b, 16));
};
const dataView = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
const add = (a, b) => (a + b) | 0;
const pct = (base, amount, percent) => add(amount, idiv(Math.imul(add(base, amount), percent), 100));
const GROWTH_OFFSETS = [0x24,0x28,0x2c,0x30,0x34,0x38,0x3c,0x40,0x44,0x48,0x4c,0x58,0x5c,0x64];

function savedHeader(role, template) {
  const initial = bytes(template.header_raw_hex, 0x30b, '初始角色头');
  const b = role.combat_progress ? bytes(role.combat_progress.header_raw_hex, 0x30b, '保存成长头') : initial.slice();
  const v = dataView(b), at = n => v.getInt32(n, true);
  if (!role.combat_progress) need(role.level === template.level, '此等级缺少保存成长来源');
  need(role.name === template.name && at(0x24) === role.level && role.level >= 1 && role.level <= 99,
    '保存角色身份或等级与来源不一致');
  need(at(0x34) === role.hp.maximum && at(0x3c) === role.mp.maximum && at(0x34) >= 0 && at(0x3c) >= 0,
    '保存成长头与资源上限不一致');
  for (const [name, offset] of [['attack',0x40], ['defense',0x48]])
    need(role.attributes_stored?.[name]?.current === at(offset) && role.attributes_stored?.[name]?.base === at(offset + 4),
      '保存成长属性不一致');
  // Native level growth modifies these recovered DWORDs only. Source identity,
  // side, growth-row selector, resistances and the rest of this bounded header
  // are retained rather than accepting a foreign CHR under the same role ID.
  const mutable = new Set(GROWTH_OFFSETS.flatMap(n => [n,n+1,n+2,n+3]));
  for (let n = 0; n < b.length; n++) if (!mutable.has(n))
    need(b[n] === initial[n], '保存成长头包含尚未接入的角色字段变化');
  v.setUint32(0x30, u32(role.hp.current, 'HP'), true);
  v.setUint32(0x38, u32(role.mp.current, 'MP'), true);
  return {b, v, at};
}

function recalculateLinked(actor, header, entries) {
  const sums = Object.fromEntries(Array.from({length:28}, (_, i) => [0x0d + i * 4, 0]));
  for (const entry of entries) {
    const raw = bytes(entry.effective_raw_hex??entry.source_raw_hex, 0xe5, '初始装备'), v = dataView(raw);
    need(v.getUint32(0, true) === entry.item_id, '初始装备编号与实例不同');
    for (const offset of Object.keys(sums).map(Number)) sums[offset] = add(sums[offset], v.getInt32(offset, true));
  }
  const at = n => header.getInt32(n, true), t = n => sums[n], link = actor.linked_by_address;
  const hp = idiv(Math.imul(add(at(0x34),t(0x11)),t(0x35)),100);
  const mp = idiv(Math.imul(add(at(0x3c),t(0x19)),t(0x3d)),100);
  for (const [n,value] of [[0x4f99088,add(t(0x0d),hp)],[0x4f9908c,add(t(0x11),hp)],
    [0x4f99090,add(t(0x15),mp)],[0x4f99094,add(t(0x19),mp)]]) link[addr(n)] = value;
  for (const [n,base,additive,percent] of [[0x4f99098,0x40,0x1d,0x41],[0x4f9909c,0x48,0x21,0x45],
    [0x4f990a0,0x50,0x25,0x49],[0x4f990a4,0x58,0x29,0x4d]]) link[addr(n)] = pct(at(base),t(additive),t(percent));
  // The original uses attack additive (+1D), even for the +B8 stat.
  link[addr(0x4f990a8)] = add(t(0x2d),idiv(Math.imul(add(at(0xb8),t(0x1d)),t(0x51)),100));
  for (const [n,offset] of [[0x4f990d0,0x55],[0x4f990d4,0x59],[0x4f990d8,0x5d],[0x4f990dc,0x61]]) link[addr(n)] = t(offset);
  for (let n = 0; n < 6; n++) link[addr(0x4f990e0 + n * 4)] = t(0x65 + n * 4);
  actor.resource_bonuses = {hp_current:link[addr(0x4f99088)],hp_maximum:link[addr(0x4f9908c)],
    mp_current:link[addr(0x4f99090)],mp_maximum:link[addr(0x4f99094)]};
  actor.equipment.item_sums_by_offset = Object.fromEntries(Object.entries(sums).map(([n,v]) => ['0x'+Number(n).toString(16),v]));
  actor.equipment.current_and_max_hp_percent_term = hp;
  actor.equipment.current_and_max_mp_percent_term = mp;
}

/** Return isolated actors for the world party in its current order. Slots used
 * to address native equipment belong to character identity, not party order.
 * Optional selectedSkills is an ID-to-source-skill map; an omitted entry leaves
 * current_skill unset so the encounter adapter must select a real command.
 */
export function createPartyActors(world, data, selectedSkills = {}, itemData = null, content=runtimeContent) {
  need(data?.schema === 'seventh-seal-party-combat' && data.version === 1, '新游戏战斗属性版本不兼容');
  const required = data.source?.required_world_source;
  need(world?.source?.kind === 'native-new-game' && world.source.kind === required?.kind
    && world.source.path === required.path && world.source.sha256 === required.sha256
    && world.source.seed_id === data.source.required_seed_id, '当前世界不是已验证的新游戏来源');
  need(Array.isArray(world.party) && world.party.length >= 1 && world.party.length <= content.party_limit
    && new Set(world.party.map(role => role.id)).size === world.party.length, '当前新游戏队伍未支持');
  requireRegisteredRoles(world.party.map(role=>role.id),{side:'player'},content);
  for (const [path, sha] of Object.entries(data.source_hashes))
    need(world.source.source_hashes?.[path] === sha, '新游戏资源指纹不同');
  const formation=partyFormationSlots(world);
  if(world.crystal_sockets)validateCrystalSocketDefinitions(world.crystal_sockets,itemData);
  return world.party.map((role) => {
    const template = data.actors?.[role.id]; need(template, '当前新游戏角色尚未接入');
    const definition = world.source.role_definitions?.[role.id];
    need(definition?.path === template.source.path && definition.sha256 === template.source.sha256
      && definition.header_raw_hex === template.header_raw_hex, '新游戏角色定义来源不同');
    const {b,v,at} = savedHeader(role, template), actor = copy(template);
    const entries = equipmentRows(world, data, itemData, role.id).concat(socketEquipmentRows(world,data,itemData,role.id));
    recalculateLinked(actor,v,entries);
    // 47A6A0 scans all entries even without category entry0. Numeric linking
    // instead skips hidden crystals when no weapon exists (47CC30).
    const passiveEntries = equipmentRows(world,data,itemData,role.id).concat(itemData
      ? crystalSocketRows(world,data,itemData,role.id).filter(row=>row.item).map(row=>({
        item_id:row.item.id,group_index:0,entry_index:row.socket_index})) : []);
    actor.equipment_passives = equipmentPassiveRows(passiveEntries,itemData);
    actor.level = role.level; actor.party_slot_zero_based = formation.indexOf(role.id); actor.header_raw_hex = hex(b);
    for (const key of Object.keys(actor.raw_by_address)) actor.raw_by_address[key] = at(Number(key) - 0x0524a6d1);
    actor.raw_hp = u32(role.hp.current, 'HP') | 0; actor.raw_mp = u32(role.mp.current, 'MP') | 0;
    actor.raw_hp_maximum = at(0x34); actor.raw_mp_maximum = at(0x3c);
    const bonus = actor.resource_bonuses;
    const hp = i32(actor.raw_hp + bonus.hp_current, '实际HP'), mp = i32(actor.raw_mp + bonus.mp_current, '实际MP');
    // Native getters return signed raw+linked directly. UI/action eligibility
    // floors depleted values at zero while preserving the original DWORDs;
    // removing a bonus weapon must never rewrite or refill stored resources.
    actor.effective_hp_raw=hp;actor.effective_mp_raw=mp;
    actor.hp = {current:Math.max(0,hp), maximum:i32(at(0x34) + bonus.hp_maximum, '实际HP上限')};
    actor.mp = {current:Math.max(0,mp), maximum:i32(at(0x3c) + bonus.mp_maximum, '实际MP上限')};
    actor.state_raw = hp <= 0 ? 4 : 0;
    const skill = selectedSkills[role.id];
    if (skill) {
      bytes(skill.fixed_raw_hex,0x41d,'选择技能');
      need(skill.actor_id === role.id && Number.isInteger(skill.class_raw) && Number.isInteger(skill.action_mask_raw), '选择技能不属于当前角色');
      actor.current_skill = copy(skill); actor.class_raw = skill.class_raw; actor.action_mask_raw = skill.action_mask_raw;
    }
    actor.initialization.world_revision = world.revision;
    return actor;
  });
}

/** Persistent raw DWORDs retain lethal -equipment-HP values on reload. */
export function partyResourcesForWorld(actor,options={}) {
  const content=options.content??runtimeContent;
  need(actor?.side === 'player', '持久资源适配需要玩家角色');
  requireRegisteredRoles([actor.resource_id??actor.id],{side:'player'},content);
  const bonus = actor.resource_bonuses;
  need(bonus && actor.status_by_address?.[addr(0x521f551)] === 0 && actor.status_by_address?.[addr(0x521f559)] === 0,
    '状态资源调整尚未纳入持久化');
  const hp = i32(actor.raw_hp, '原始HP'), mp = i32(actor.raw_mp, '原始MP');
  need(actor.hp.current===Math.max(0,hp+bonus.hp_current) && actor.raw_by_address?.[addr(0x524a701)] === hp, 'HP显示与原始提交字段不一致');
  need(actor.mp.current===Math.max(0,mp+bonus.mp_current) && actor.raw_by_address?.[addr(0x524a709)] === mp, 'MP显示与原始提交字段不一致');
  need(actor.hp.maximum === actor.raw_hp_maximum + bonus.hp_maximum && actor.mp.maximum === actor.raw_mp_maximum + bonus.mp_maximum,
    '当前资源上限发生未支持的变化');
  return {hp:hp >>> 0, mp:mp >>> 0};
}

export function consumePartyMp(actor, cost,content=runtimeContent) {
  need(Number.isInteger(cost) && cost >= 0 && cost <= 0x7fffffff, 'MP成本无效');
  partyResourcesForWorld(actor,{content});
  need(actor.mp.current >= cost, 'MP不足');
  const raw = i32(actor.raw_mp - cost, '扣费后原始MP');
  return {...copy(actor), raw_mp:raw, effective_mp_raw:raw+actor.resource_bonuses.mp_current, raw_by_address:{...actor.raw_by_address,[addr(0x524a709)]:raw},
    mp:{...actor.mp,current:actor.mp.current - cost}};
}
