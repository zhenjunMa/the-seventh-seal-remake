/** Meaningful checks against the recovered finite Python contracts and PE bytes. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hpState, effectiveHp, commitKnownDamage, rawActionClassRejected,
  rawRollPasses, manualSettlement, userPositionCompatibility, RULE_EVIDENCE } from '../web/battle_rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const gamePath = path.join(root, 'GAME.exe');
const data = fs.readFileSync(gamePath);
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
assert.equal(sha(data), 'fc6c01945d4898a221e40be72c32158371205896c096622727fa23f7ee794d18');
const evidence = JSON.parse(fs.readFileSync(path.join(root, 'remake/runtime/evidence/source/combat_native_20261011.json'), 'utf8'));
const records = new Map(evidence.records.map(r => [r.evidence_id, r]));
for (const item of Object.values(RULE_EVIDENCE)) assert.equal(records.get(item.assembly).subject.digest.sha256, sha(data));
function bytesAtVA(address, length) {
  const pe = data.readUInt32LE(0x3c);
  assert.equal(data.subarray(pe, pe + 4).toString('hex'), '50450000');
  const optional = pe + 24;
  assert.equal(data.readUInt16LE(optional), 0x10b);
  const rva = address - data.readUInt32LE(optional + 28);
  for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
    const entry = optional + data.readUInt16LE(pe + 20) + i * 40;
    const va = data.readUInt32LE(entry + 12), size = data.readUInt32LE(entry + 16);
    if (va <= rva && rva + length <= va + size) {
      const start = data.readUInt32LE(entry + 20) + rva - va;
      return data.subarray(start, start + length);
    }
  }
  throw new Error('PE 地址未落在原文件初始化区域');
}
for (const [va, hex] of [[0x500642, '7c2f'], [0x500653, '2b4510'], [0x5006d9, 'b801000000'],
  [0x41da58, '83e101'], [0x41daa6, '83e002'], [0x41daf1, '83e204']]) {
  assert.equal(bytesAtVA(va, hex.length / 2).toString('hex'), hex);
}
let checks = 0;
for (let mask = 0; mask < 256; mask++) for (let cls = 0; cls < 256; cls++) {
  const rejected = Boolean((mask & 1 && cls === 1) || (mask & 2 && cls === 2) || (mask & 4 && cls === 3));
  assert.equal(rawActionClassRejected(mask, cls), rejected); checks++;
}
assert.equal(rawActionClassRejected(0, 255, 1), true);
assert.equal(rawActionClassRejected(7, 1, 255, 1), false);
for (const args of [[256, 1], [0, -1], [0, 1, true], [0, 1, 0, -1]]) assert.throws(() => rawActionClassRejected(...args));
const original = hpState({ raw_hp: 100, side_raw: 1, role_link_raw: 1, linked_hp_bonus: 50, status_hp_raw: 27 });
const nonlethal = commitKnownDamage(original, 120, 0);
assert.equal(nonlethal.target.raw_hp, -20); assert.equal(nonlethal.effective_hp, 30);
assert.equal(original.raw_hp, 100); assert.deepEqual(nonlethal.events, []);
const equal = commitKnownDamage(original, 150, 0), over = commitKnownDamage(original, 151, -1);
assert.equal(equal.target.status_hp_raw, 27); assert.equal(over.target.status_hp_raw, 0);
assert.equal(equal.target.raw_hp, -50); assert.equal(over.target.raw_hp, -50);
assert.equal(equal.target.state_raw, 4); assert.equal(equal.native_return, 1);
assert.deepEqual(equal.events.map(e => e.kind), ['attacker-byte-write', 'death-handler']);
assert.deepEqual(over.events.map(e => e.kind), ['death-handler']);
for (const fields of [{ side_raw: 0 }, { role_link_raw: 0 }]) assert.equal(effectiveHp(hpState({ ...original, ...fields })), 100);
for (const gate of ['global_00679c6c', 'global_055ee004', 'global_055edfec']) {
  const result = commitKnownDamage(original, 150, 0, { [gate]: 1 });
  assert.equal(result.applied, false); assert.deepEqual(result.target, original);
}
assert.equal(commitKnownDamage(hpState({ raw_hp: 100 }), 5, 0, { global_055edfec: 1 }).applied, true);
assert.equal(commitKnownDamage(hpState({ state_raw: 4 }), 1).applied, false);
for (const damage of [-1, true, 0x80000000]) assert.throws(() => commitKnownDamage(original, damage));
assert.equal(rawRollPasses(0, 0), true); assert.equal(rawRollPasses(20, 20), true); assert.equal(rawRollPasses(21, 20), false);
const setup = { target: hpState({ raw_hp: 100 }), attackerIndex: 0 };
assert.equal(manualSettlement(setup).status, 'unresolved');
assert.equal(manualSettlement({ ...setup, useClassGate: true }).status, 'unresolved');
assert.equal(manualSettlement({ ...setup, damage: 30, useClassGate: true, actionMask: 1, targetClass: 1 }).native_return, -1);
assert.equal(manualSettlement({ ...setup, damage: 30, useRoll: true, roll: 21, threshold: 20 }).status, 'explicit-roll-failed');
assert.equal(manualSettlement({ ...setup, damage: 30 }).effective_hp, 70);
assert.deepEqual(userPositionCompatibility(['middle', 'lower'], ['middle', 'lower']).intersection, ['middle', 'lower']);
assert.equal(userPositionCompatibility(['upper'], ['middle', 'lower']).compatible, false);
assert.equal(userPositionCompatibility(['upper', 'middle', 'lower'], ['middle', 'lower']).compatible, true);
assert.equal(userPositionCompatibility(['upper', 'middle'], ['middle', 'lower']).compatible, true);
assert.equal(userPositionCompatibility(null, ['middle', 'lower']).status, 'unknown');
assert.equal(userPositionCompatibility(['lower'], null).compatible, null);
assert.equal(userPositionCompatibility([], ['middle']).compatible, false);
assert.throws(() => userPositionCompatibility([1], ['middle']));
assert.equal(sha(fs.readFileSync(gamePath)), sha(data));
console.log(JSON.stringify({ passed: true, raw_class_combinations: checks,
  hp: 'nonlethal/exact/overkill/linked fields/death events/gates/immutable input',
  settlement: 'unresolved by default; explicit inputs only', source_unchanged: true }));
