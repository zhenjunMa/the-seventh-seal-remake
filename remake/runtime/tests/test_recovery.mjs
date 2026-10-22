import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {planPartyDefeat,restorePartyAfterRest} from '../web/core/recovery.mjs';
const read = file => JSON.parse(fs.readFileSync(new URL(file, import.meta.url),'utf8'));
const forest = read('../web/data/forest_combat.json');
const seed = read('../web/data/opening_seed.json');
const copy = value => structuredClone(value);
const defeat = () => ({phase:'defeat',outcome:'defeat',actors:[
  {id:'001',side:'player',hp:{current:0}},
  {id:'002',side:'player',hp:{current:0}},
  ...Object.values(forest.actors).map(enemy => ({...copy(enemy),side:'enemy'})),
]});

test('Actual forest CHR defeat entries use the game-over menu and never fabricate a recovery map or reward', () => {
  const battle = defeat(), before = copy(battle), plan = planPartyDefeat({battle});
  assert.equal(plan.mode,'game-over');
  assert.deepEqual(plan.choices,['load','new-game']);
  assert.equal(plan.native_movie_path,'Animate/GO02.bik');
  assert.equal(plan.can_explore,false);
  assert.equal(plan.can_save,false);
  assert.equal(plan.can_award_rewards,false);
  assert.deepEqual(battle,before);
});

test('Special authored defeat TLKs and surviving players are refused explicitly', () => {
  const battle = defeat();
  const b = Buffer.from(battle.actors[2].header_raw_hex,'hex');b.writeUInt32LE(42,0x20a);
  battle.actors[2].header_raw_hex = b.toString('hex');
  assert.throws(() => planPartyDefeat({battle}),/专属败北剧情/);
  battle.actors[0].hp.current = 1;
  assert.throws(() => planPartyDefeat({battle}),/仍有可继续/);
  assert.throws(() => planPartyDefeat({battle:{...defeat(),phase:'victory',outcome:'victory'}}),/尚未全队败北/);
});

test('Rest preflights every saved character before mutating a caller draft', () => {
  const draft = copy(seed);
  draft.party.push({...copy(seed.party[0]),id:'002',hp:{current:1,maximum:-1}});
  const before = copy(draft);
  assert.throws(() => restorePartyAfterRest(draft),/上限无效/);
  assert.deepEqual(draft,before);
});
