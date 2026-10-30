// Source-backed forest death pool, drop rolls and character experience.
// World submission is deliberately left to the controller's atomic transaction.
import {settleNativeSkillProgress,learnEligiblePartySkills} from './battle_skill_growth.mjs';
import {runtimeContent,requireRegisteredRoles} from './content_registry.mjs';
const copy = value => structuredClone(value);
const u32 = value => value >>> 0;
const i32 = value => value | 0;
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function integer(value, label, max = 0x7fffffff) {
  requireValue(Number.isInteger(value) && value >= 0 && value <= max, `${label}无效`); return value;
}
function bytes(hex, size) {
  requireValue(typeof hex === 'string' && hex.length === size * 2 && /^[0-9a-f]+$/.test(hex), '奖励原始记录无效');
  return Uint8Array.from(hex.match(/../g), b => parseInt(b, 16));
}
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');
const get = (b, at) => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(at, true);
const put = (b, at, v) => new DataView(b.buffer, b.byteOffset, b.byteLength).setInt32(at, i32(v), true);

export function validateForestRewards(data,content=runtimeContent) {
  requireValue(['seventh-seal-forest-rewards','seventh-seal-party-rewards'].includes(data?.schema) && data.version === 1, '森林奖励版本不兼容');
  requireRegisteredRoles(Object.keys(data.enemies??{}),{side:'enemy',complete:true},content);
  for (const [key, enemy] of Object.entries(data.enemies)) {
    requireValue(enemy.id === key && typeof enemy.name === 'string' && enemy.reward_slots?.length === 6, '森林奖励来源无效');
    integer(enemy.experience, '敌方经验');
    enemy.reward_slots.forEach(slot => requireValue(Number.isInteger(slot) && slot >= -0x7fffffff && slot <= 0x7fffffff && (slot <= 0 || data.items[slot]), '奖励槽未支持'));
    bytes(enemy.source.raw_header_hex, 0x30b);
  }
  requireValue(data.tables?.exp_a?.length === 100 && data.tables?.exp_b?.length === 100 && data.tables?.growth_rows?.length >= 1, '成长表缺失');
  for (const row of data.tables.growth_rows) requireValue(row.length === 10 && row.every(v => Number.isInteger(v) && v >= 0), '成长行无效');
  requireValue(data.chain_bonuses?.length === 41 && data.skill_practice_bonuses?.length === 41, '连击奖励表缺失');
  for (const item of Object.values(data.items ?? {})) {
    integer(item.id, '道具编号'); requireValue(item.type_raw >= 2 && item.unique_raw === 0 && item.initialization_rng_calls === 0, '森林掉落类型未支持');
    requireValue(Number.isInteger(item.drop_rate) && item.drop_rate >= -1 && item.drop_rate <= 100, '道具掉落率无效');
    bytes(item.instance_raw_hex, 0xe5); bytes(item.source.definition_raw_hex, 0x3bf);
  }
  bytes(data.initial_roles?.['001']?.header_raw_hex, 0x30b); integer(data.initial_money, '原始金钱', 0xffffffff);
  if (data.schema === 'seventh-seal-party-rewards') {
    requireValue(data.world_source?.kind === 'native-new-game' && data.world_source.seed_id === 'opening-new-game-v1'
      && data.world_source.path === 'GAME.exe' && data.world_source.sha256 === data.source_hashes?.['GAME.exe'], '新游戏奖励来源无效');
    requireRegisteredRoles(Object.keys(data.initial_roles??{}),{side:'player',complete:true},content);
    for (const id of Object.keys(data.initial_roles)) {
      const role=data.initial_roles[id], b=bytes(role?.header_raw_hex,0x30b);
      requireValue(role.source?.path===`Fight_Role/${id}.CHR` && role.source.sha256===data.source_hashes[role.source.path]
        && role.source.header_file_offset===8 && role.level===get(b,0x24) && role.growth_row===get(b,0x60)
        && data.tables.growth_rows[role.growth_row], '新游戏成长来源无效');
    }
    requireValue(['eligibility_status','eligibility_hp','victory_assembly'].every(key=>data.evidence[key]), '全队奖励入口证据缺失');
  }
  requireValue(Object.keys(data.evidence ?? {}).length >= 14 && Object.values(data.evidence).every(e => /^ev_[0-9a-f]{64}$/.test(e.evidence_id)), '奖励原生证据缺失');
  return copy(data);
}

export function validatePartyRewards(data,content=runtimeContent) {
  requireValue(data?.schema==='seventh-seal-party-rewards', '全队奖励版本不兼容');
  return validateForestRewards(data,content);
}

/** One fresh pool per encounter. No world mutation or random call. */
export function createRewardLedger(battleId, actors) {
  requireValue(typeof battleId === 'string' && battleId.length > 0 && battleId.length <= 100, '奖励战斗编号无效');
  const enemies = actors.filter(a => a.side === 'enemy');
  requireValue(enemies.length >= 1 && enemies.length <= 4 && new Set(enemies.map(a => a.id)).size === enemies.length, '奖励敌组无效');
  return {battle_id:battleId, expected_enemy_ids:enemies.map(a => a.id), defeated_ids:[], experience:0, money:0, candidates:[],
    chain:{target_id:null, attacker_side:null, count:0, maximum:0}, trace:[]};
}

/** Native 0x4FFE90/0x50CB60: called once at enemy death initialization. */
export function collectEnemyDefeat(ledger, actor, context) {
  requireValue(ledger?.expected_enemy_ids?.includes(actor?.id) && actor.side === 'enemy' && actor.hp.current === 0, '奖励死亡入口无效');
  if (ledger.defeated_ids.includes(actor.id)) return false;
  const data = context?.data, enemy = data?.enemies?.[actor.resource_id ?? actor.id];
  requireValue(enemy, '敌人奖励资源未支持');
  ledger.defeated_ids.push(actor.id);
  ledger.experience = i32(ledger.experience + enemy.experience);
  for (const value of enemy.reward_slots) {
    if (value < 0) ledger.money = i32(ledger.money - value);
    if (value > 0) {
      const item = data.items[value]; requireValue(item, '奖励道具未支持');
      const queued = ledger.candidates.find(row => row.id === value);
      if (!queued) ledger.candidates.push({id:value, count:1});
      else if (item.unique_raw === 0) queued.count++;
    }
  }
  ledger.trace.push({type:'enemy-reward-collected', actor_id:actor.id, resource_id:enemy.id, experience:enemy.experience, reward_slots:[...enemy.reward_slots]});
  return true;
}

/** Invoke only for the native numeric hit branch. Miss/class rejection is false.
 * settledBefore is read before the numeric routine writes target.settled_raw=1.
 * The gate is attacker skill fixed+0x24, not target recovery status.
 */
export function recordNativeContact(ledger, {attacker, target, skill, hit, settledBefore}) {
  if (!hit || !settledBefore || bytes(skill.fixed_raw_hex, 0x41d)[0x24] !== 0) return false;
  const chain = ledger.chain;
  if (chain.target_id !== target.id || chain.attacker_side !== attacker.side_raw) chain.count = 0;
  chain.target_id = target.id; chain.attacker_side = attacker.side_raw;
  if (chain.count === 0) chain.count = 1;
  chain.count++;
  if (attacker.side_raw !== 0) chain.maximum = Math.max(chain.maximum, chain.count);
  return true;
}

/** Native score(mode=0) at dispatch/idle resets the chain targeting this actor. */
export function resetNativeChain(ledger, actorId) {
  if (ledger.chain.target_id === actorId && ledger.chain.count !== 0) { ledger.chain.count = 0; return true; }
  return false;
}

/** Recover optional progress in an old remake save from the verified source.
 * Mutable HP/MP are retained; missing progress at a different level is rejected.
 */
export function progressHeaderForRole(role, data) {
  requireValue(data.initial_roles?.[role.id], '角色成长来源未支持');
  let b;
  if (role.combat_progress) {
    requireValue(Object.keys(role.combat_progress).length === 1, '角色成长字段未支持');
    b = bytes(role.combat_progress.header_raw_hex, 0x30b);
  } else {
    const initial = data.initial_roles[role.id]; requireValue(initial && initial.level === role.level, '旧存档缺少此等级的成长来源');
    b = bytes(initial.header_raw_hex, 0x30b);
  }
  requireValue(get(b,0x24) === role.level && u32(get(b,0x34)) === role.hp.maximum && u32(get(b,0x3c)) === role.mp.maximum, '角色成长与世界资源上限不一致');
  for (const [name, at] of [['attack',0x40], ['defense',0x48]]) {
    requireValue(role.attributes_stored?.[name]?.current === get(b,at) && role.attributes_stored?.[name]?.base === get(b,at+4), '角色成长与保存属性不一致');
  }
  requireValue(data.tables.growth_rows[get(b,0x60)], '角色成长行未支持');
  put(b, 0x30, role.hp.current); put(b, 0x38, role.mp.current);
  return b;
}

/** 0x50D1C0 passes the whole pool to each player row; 0x50A710 rejects
 * active non-mode6 effects with negative duration and flag bits 5/6/7.
 * hp.current is effective HP (0x500350), including the actor's linked HP.
 */
export function nativeExperienceEligibility(actor) {
  requireValue(actor?.side==='player' && Number.isInteger(actor.hp?.current) && actor.hp.current>=0
    && Number.isInteger(actor.immune_raw) && actor.immune_raw>=0 && actor.immune_raw<=255
    && Number.isInteger(actor.state_raw) && actor.state_raw>=0 && actor.state_raw<=255, '参战奖励状态无效');
  let blocked=false;
  if(actor.native_status_slots!==undefined) {
    requireValue(Array.isArray(actor.native_status_slots)&&actor.native_status_slots.length===100, '奖励状态槽无效');
    for(const record of actor.native_status_slots) {
      const b=bytes(record?.raw_hex,0xc6);
      if(b[1]!==0 && b[0xb]!==6 && get(b,2)<0 && (u32(get(b,0xb8))&0xe0)!==0)blocked=true;
    }
  }
  return actor.immune_raw===0 && actor.state_raw!==11 && !blocked && actor.hp.current>0;
}

export function applyExperience(role, amount, data, rng, trace) {
  const next = copy(role), b = progressHeaderForRole(role, data), oldLevel = get(b,0x24);
  const beforeTotal=get(b,0x28),beforeNext=get(b,0x2c),levels=[],notifications=[];
  integer(amount, '发放经验');
  put(b,0x28,get(b,0x28)+amount);
  // 0x50E070 consumes the row's pending amount, so applying it again adds zero.
  while (get(b,0x24) < 99 && get(b,0x28) >= get(b,0x2c) && amount !== 0) {
    const gainedAt=Math.max(1,get(b,0x2c)-beforeTotal),before={level:get(b,0x24),hp_maximum:get(b,0x34),mp_maximum:get(b,0x3c),attack:get(b,0x44),defense:get(b,0x4c),speed:get(b,0x5c)};
    const level = get(b,0x24)+1, row = data.tables.growth_rows[get(b,0x60)]; requireValue(row, '角色成长行未支持');
    put(b,0x24,level);
    for (const [i,current,base] of [[0,0x30,0x34],[1,0x38,0x3c],[2,0x40,0x44],[3,0x48,0x4c],[4,0x58,0x5c]]) {
      const min=row[i*2], max=row[i*2+1]; let increment=min;
      if (u32(min)<u32(max)) { const roll=integer(rng(), '成长随机', 32767); increment+=roll%u32(max-min); trace.push({type:'growth-roll',role_id:role.id,level,attribute_offset:base,roll}); }
      put(b,base,get(b,base)+increment); put(b,current,get(b,base));
    }
    let threshold=0;
    if (level < 99) for (let i=0;i<level && i<100;i++) threshold=i32(threshold+Math.imul(data.tables.exp_a[i],data.tables.exp_b[i]));
    else threshold=i32(get(b,0x2c)+Math.imul(data.tables.exp_a[99],data.tables.exp_b[99]));
    put(b,0x2c,threshold); put(b,0x64,threshold-get(b,0x28));
    const after={level,hp_maximum:get(b,0x34),mp_maximum:get(b,0x3c),attack:get(b,0x44),defense:get(b,0x4c),speed:get(b,0x5c)};
    levels.push({level,gained_at:gainedAt,next_level_experience:threshold});
    notifications.push({type:'role-level-up',actor_id:role.id,actor_name:role.name,skill_index:null,skill_name:null,before,after,experience_gained_at:gainedAt,after_next_level_experience:threshold});
    trace.push({type:'role-level-up',role_id:role.id,level,next_level_experience:threshold});
  }
  next.level=get(b,0x24); next.hp={current:u32(get(b,0x30)),maximum:u32(get(b,0x34))}; next.mp={current:u32(get(b,0x38)),maximum:u32(get(b,0x3c))};
  next.attributes_stored={...next.attributes_stored,attack:{current:get(b,0x40),base:get(b,0x44)},defense:{current:get(b,0x48),base:get(b,0x4c)}};
  next.combat_progress={header_raw_hex:hex(b)};
  return {role:next,notifications,summary:{role_id:role.id,experience:amount,level_before:oldLevel,level_after:next.level,
    before_total_experience:beforeTotal,before_next_level_experience:beforeNext,levels,
    total_experience:get(b,0x28),next_level_experience:get(b,0x2c),experience_remaining_raw:get(b,0x64)}};
}

function addItem(inventory, item, battleId, sequence) {
  const template=bytes(item.instance_raw_hex,0xe5);
  // All forest instances use stack flag +0x0C=0; the first matching raw instance wins.
  const existing=inventory.find(row => row.id===0 || (row.id===item.id && bytes(row.source_raw_hex,0xe5)[0x0c]===0));
  if (existing) {
    if (existing.id===0) {
      put(template,4,1);Object.assign(existing,{id:item.id,name:item.name,quantity:1,source_raw_hex:hex(template)});
      return {id:item.id,instance_id:existing.instance_id,quantity:1};
    }
    existing.quantity=Math.min(99,existing.quantity+1);
    const raw=bytes(existing.source_raw_hex,0xe5); put(raw,4,existing.quantity); existing.source_raw_hex=hex(raw);
    return {id:item.id,instance_id:existing.instance_id,quantity:existing.quantity};
  }
  if (inventory.length>=1000) return {id:item.id,inventory_full:true};
  put(template,4,1);
  const row={instance_id:`reward-${battleId}-${sequence}`,id:item.id,name:item.name,quantity:1,source_raw_hex:hex(template)};
  requireValue(!inventory.some(old => old.instance_id===row.instance_id), '奖励道具实例标识冲突'); inventory.push(row);
  return {id:item.id,instance_id:row.instance_id,quantity:1};
}

/** Pure plan: root commits world_patch and reward_record together exactly once.
 * actors is the final battle roster. Only its actual player participants receive rows.
 * RNG runs in native order: queue IDs, each occurrence, then experience growth.
 */
export function planVictoryRewards({world, ledger, data, rng, actors,skill_data=null,skill_practice={}}) {
  const required=data.world_source;
  requireValue(required ? world?.source?.path===required.path && world.source.sha256===required.sha256
    && world.source.kind===required.kind && world.source.seed_id===required.seed_id
    : world?.source?.sha256===data.source_hashes['save_analysis_20261010/verified_level12_SaveGame0.Dat'], '奖励存档来源不匹配');
  const old = world.reward_records?.find(record => (typeof record==='string'?record:record.battle_id)===ledger.battle_id);
  if (old) return {applied:false,world_patch:null,reward_record:null,summary:copy(typeof old==='object'?old.summary:null),trace:[]};
  requireValue(typeof rng==='function' && ledger?.battle_id && ledger.defeated_ids.length===ledger.expected_enemy_ids.length && ledger.expected_enemy_ids.every(id=>ledger.defeated_ids.includes(id)), '尚未胜利，不能发放奖励');
  requireValue(Array.isArray(actors) && actors.filter(a=>a.side==='enemy').every(a=>a.hp.current===0), '敌方仍可战斗，不能发放奖励');
  const participants=actors.filter(a=>a.side==='player');
  requireValue(participants.length>=1 && participants.length<=4 && new Set(participants.map(a=>a.id)).size===participants.length
    && participants.every(a=>data.initial_roles?.[a.id]) && participants.some(a=>a.hp.current>0), '参战奖励角色未支持或已经倒下');
  const eligibility=new Map(participants.map(actor=>[actor.id,nativeExperienceEligibility(actor)]));
  for (const actor of participants) {
    const role=world.party.find(role=>role.id===actor.id);requireValue(role,'奖励角色不在队伍');progressHeaderForRole(role,data);
  }
  const k=Math.trunc(integer(ledger.chain.maximum,'连击数')/5); requireValue(k<data.chain_bonuses.length,'连击奖励超出原局部表范围');
  const trace=copy(ledger.trace), inventory=copy(world.inventory), drops=[];
  let sequence=0;
  for (const candidate of ledger.candidates) {
    const item=data.items[candidate.id]; requireValue(item && item.unique_raw===0,'掉落类型未支持'); integer(candidate.count,'掉落候选数量');
    if (item.drop_rate===-1) {trace.push({type:'drop-skipped',id:item.id});continue;}
    const threshold=i32(item.drop_rate+data.chain_bonuses[k]);
    for(let i=0;i<candidate.count;i++) {
      const raw=integer(rng(),'掉落随机',32767),roll=raw%100,success=roll<threshold||item.drop_rate===0;
      const record={type:'drop-roll',id:item.id,occurrence:i,raw,roll,threshold,success};
      if(success) {record.inventory=addItem(inventory,item,ledger.battle_id,sequence++);const dropped=drops.find(d=>d.id===item.id);if(dropped)dropped.quantity++;else drops.push({id:item.id,name:item.name,quantity:1});}
      trace.push(record);
    }
  }
  const party=copy(world.party), experience=[],notifications=[],roleNotifications=[];let practiceTotal=0;
  for(const actor of participants) {
    const i=party.findIndex(role=>role.id===actor.id); requireValue(i>=0,'奖励角色不在队伍');
    if(skill_data){
      const growth=settleNativeSkillProgress({role:party[i],source_role:skill_data.roles[actor.id],practice:skill_practice[actor.id]??{},chain_bonus:data.skill_practice_bonuses[k],remake:true});
      party[i]=growth.role;notifications.push(...growth.notifications);practiceTotal=i32(practiceTotal+growth.practice_total);trace.push(...growth.trace);
    }
    // Original 0x50D1C0 sends the whole enemy experience pool to each eligible participant.
    const eligible=eligibility.get(actor.id);
    const result=applyExperience(party[i],eligible?ledger.experience:0,data,rng,trace);party[i]=result.role;experience.push(result.summary);roleNotifications.push(...result.notifications);
    if(skill_data&&result.summary.level_after>result.summary.level_before){
      const learned=learnEligiblePartySkills({role:party[i],source_role:skill_data.roles[actor.id]});party[i]=learned.role;
      for(const notice of learned.notifications){
        const required=bytes(skill_data.roles[actor.id].skills[notice.skill_index].fixed_raw_hex,0x41d),level=get(required,0x143);
        notice.experience_gained_at=result.summary.levels.find(row=>row.level>=level)?.gained_at??result.summary.levels.at(-1).gained_at;
        roleNotifications.push(notice);
      }
    }
  }
  // Practice notifications precede report ticks. Remake learning from a new
  // actor level follows that level notice at the same report XP boundary.
  const positions=new Map(participants.map((actor,index)=>[actor.id,index]));
  roleNotifications.sort((a,b)=>a.experience_gained_at-b.experience_gained_at||positions.get(a.actor_id)-positions.get(b.actor_id));
  const practiceBonus=data.skill_practice_bonuses[k];
  if(practiceBonus!==0)notifications.push({type:'practice-bonus',actor_id:null,actor_name:null,skill_index:null,skill_name:null,before:{value:0},after:{value:practiceBonus},value:practiceBonus,source_type_raw:6});
  notifications.push(...roleNotifications);notifications.forEach((notice,index)=>notice.id=`${ledger.battle_id}:notice:${index}`);
  const moneyBefore=world.money??data.initial_money;integer(moneyBefore,'当前金钱',0xffffffff);
  const summary={battle_id:ledger.battle_id,experience,money:ledger.money,money_before:moneyBefore,money_after:u32(moneyBefore+ledger.money),drops,
    maximum_player_chain:ledger.chain.maximum,drop_bonus:data.chain_bonuses[k],practice_total:practiceTotal,practice_bonus:practiceBonus,notifications,defeated_ids:[...ledger.defeated_ids]};
  return {applied:true,world_patch:{party,inventory,money:summary.money_after},reward_record:{battle_id:ledger.battle_id,summary:copy(summary)},summary,trace};
}
