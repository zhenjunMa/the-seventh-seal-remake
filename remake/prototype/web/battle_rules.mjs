/** Finite raw-field contracts recovered from GAME.exe. No complete battle formula. */
export const RULE_EVIDENCE = Object.freeze({
  hp: { function: '0x5005C0', helpers: ['0x500350', '0x5003F0', '0x4FFD40'],
    assembly: 'ev_e76dc0fc2a37ba715b7005825ea4ce93f1523440769a6aa6549a0ac77569df72' },
  rawClass: { function: '0x41D990', range: '0x41D9E5..0x41DB21',
    assembly: 'ev_2a07b703ffba4f257babff8aa568885165fed9b0aaff627398713aa8b09bc85d' },
});

function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label}应为 ${min} 至 ${max} 的整数`);
  }
  return value;
}
const signed = (value, label) => integer(value, -0x80000000, 0x7fffffff, label);
const byte = (value, label) => integer(value, 0, 255, label);
export const i32 = (value) => {
  if (!Number.isSafeInteger(value)) throw new RangeError('32 位运算需要精确整数');
  return value | 0;
};

export function hpState(fields = {}) {
  const state = { raw_hp: 100, side_raw: 0, role_link_raw: 0,
    linked_hp_bonus: 0, status_hp_raw: 0, state_raw: 0, ...fields };
  for (const field of ['raw_hp', 'role_link_raw', 'linked_hp_bonus', 'status_hp_raw']) signed(state[field], field);
  for (const field of ['side_raw', 'state_raw']) byte(state[field], field);
  return state;
}
export function activeBonus(target) {
  return target.side_raw && target.role_link_raw ? target.linked_hp_bonus : 0;
}
export function effectiveHp(target) { return i32(target.raw_hp + activeBonus(target)); }

/** Apply caller-known nonnegative damage. Never infer attack damage or victory. */
export function commitKnownDamage(target, damage, attackerIndex = -1, gates = {}) {
  const original = hpState(target);
  signed(damage, '已知伤害'); signed(attackerIndex, '攻击者索引');
  if (damage < 0 || attackerIndex < -1) throw new RangeError('实验合同要求伤害非负，攻击者索引至少为 -1');
  const gate = { global_00679c6c: 0, global_055ee004: 0, global_055edfec: 0, ...gates };
  Object.entries(gate).forEach(([key, value]) => signed(value, key));
  const blocked = Boolean(gate.global_00679c6c || gate.global_055ee004 ||
    (gate.global_055edfec && original.side_raw) || original.state_raw >= 4);
  if (blocked) return { target: original, applied: false, native_return: 0,
    effective_hp: effectiveHp(original), events: [] };
  const updated = { ...original };
  if (effectiveHp(original) < damage) {
    updated.raw_hp = i32(-activeBonus(original));
    updated.status_hp_raw = 0;
  } else updated.raw_hp = i32(original.raw_hp - damage);
  const dead = effectiveHp(updated) <= 0;
  const events = [];
  if (dead) {
    if (attackerIndex !== -1) events.push({ kind: 'attacker-byte-write', index: attackerIndex,
      base: '0x0521F5F9', stride: '0x30274', value: 2 });
    events.push({ kind: 'death-handler', function: '0x4FFD40', attacker_index: attackerIndex });
    updated.state_raw = 4;
  }
  return { target: updated, applied: true, native_return: Number(dead),
    effective_hp: effectiveHp(updated), events };
}

/** Raw classes only. Bits have no established upper/middle/lower labels. */
export function rawActionClassRejected(mask, targetClass, targetSkillGate = 0, effectToken = 0) {
  byte(mask, '原拒绝掩码'); byte(targetClass, '原分类'); byte(targetSkillGate, '目标技能门字段');
  integer(effectToken, 0, 0x7fffffff, '实验 effectToken');
  if (effectToken !== 0) return false;
  if (targetSkillGate !== 0) return true;
  const bit = targetClass === 1 ? 1 : targetClass === 2 ? 2 : targetClass === 3 ? 4 : 0;
  return Boolean(mask & bit);
}

/** Explicit comparison subitem only; native bypasses/RNG order are not recovered. */
export function rawRollPasses(roll, threshold) {
  integer(roll, 0, 99, '显式 roll'); integer(threshold, 0, 100, '实验 threshold');
  return roll <= threshold;
}

/** Explicit user-reported position sets; unrelated to native class byte/bit numbering. */
export function userPositionCompatibility(skillPositions, targetPositions) {
  const valid = new Set(['upper', 'middle', 'lower']);
  for (const positions of [skillPositions, targetPositions]) {
    if (positions === null) continue;
    if (!Array.isArray(positions) || positions.some(position => !valid.has(position))) {
      throw new RangeError('观察规则的方位应为明确的 upper/middle/lower 数组或未知 null');
    }
  }
  if (skillPositions === null || targetPositions === null) return { status: 'unknown', compatible: null, intersection: [] };
  const intersection = [...new Set(skillPositions)].filter(position => targetPositions.includes(position));
  return { status: 'user-reported-set-intersection', compatible: intersection.length > 0, intersection };
}

/** A browser experiment coordinator, not an original attack evaluator. */
export function manualSettlement({ target, damage = null, attackerIndex = 0,
  useClassGate = false, actionMask = null, targetClass = null,
  targetSkillGate = 0, effectToken = 0, useRoll = false, roll = null, threshold = null,
  gates = {} }) {
  if (useClassGate) {
    if (actionMask === null || targetClass === null) return { status: 'unresolved', reason: '原分类或拒绝掩码尚未输入' };
    if (rawActionClassRejected(actionMask, targetClass, targetSkillGate, effectToken)) {
      return { status: 'raw-class-rejected', native_return: -1, target: hpState(target),
        effective_hp: effectiveHp(target), events: [] };
    }
  }
  if (useRoll) {
    if (roll === null || threshold === null) return { status: 'unresolved', reason: '显式 roll / threshold 尚未输入' };
    if (!rawRollPasses(roll, threshold)) return { status: 'explicit-roll-failed', target: hpState(target),
      effective_hp: effectiveHp(target), events: [] };
  }
  if (damage === null) return { status: 'unresolved', reason: '完整伤害公式未恢复，请输入已知伤害' };
  return { status: 'manual-known-damage', ...commitKnownDamage(target, damage, attackerIndex, gates) };
}
