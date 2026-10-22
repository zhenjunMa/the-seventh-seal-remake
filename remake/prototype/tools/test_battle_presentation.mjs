import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillSequence, previewTravel, sceneEnvelope, validSceneMessage } from '../web/battle_presentation.mjs';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
const manifest = JSON.parse(fs.readFileSync(path.join(web, 'combat_manifest.json'), 'utf8'));
const presentation = JSON.parse(fs.readFileSync(path.join(web, 'combat_presentation.json'), 'utf8'));
const role = manifest.roles.find(r => r.id === '001');
const verified = [];
for (const [skillIndex, uniqueGroup, eventFrame] of [[22, 28, 5], [24, 31, 9], [25, 32, 6]]) {
  const skill = role.skills.find(s => s.index === skillIndex);
  const sequence = skillSequence(role, skill, presentation);
  assert.deepEqual(sequence.segments.map(s => s.action.index), [7, 11, 8, uniqueGroup, 9, 12, 10]);
  assert.equal(sequence.segments[3].combat_event.frame, eventFrame);
  assert.ok(sequence.segments.every(s => s.sequence_basis === 'native-confirmed-frame-selection'));
  assert.ok(sequence.segments.some(s => s.effects.some(e => e.placement === 'target')));
  assert.ok(sequence.segments.some(s => s.effects.some(e => e.placement === 'player')));
  assert.equal(sequence.recipe.target_reaction.role_id, '012');
  assert.equal(sequence.recipe.target_reaction.action_index, 1);
  assert.equal(sequence.recipe.death_action, null);
  for (const segment of sequence.segments) for (const effect of segment.effects) {
    const asset = presentation.assets.find(a => a.id === effect.asset_id);
    assert.equal(asset.blend, 'additive');
    assert.equal(asset.pixel_encoding, 'rgb565-additive-contribution');
    assert.ok(segment.frames.includes(effect.trigger_frame));
  }
  const invalid = structuredClone(presentation);
  invalid.skills.find(s => s.skill_index === skillIndex).sequence[0].action_index = 38;
  assert.throws(() => skillSequence(role, skill, invalid));
  const outOfRange = structuredClone(presentation);
  outOfRange.skills.find(s => s.skill_index === skillIndex).sequence[0].frame_sequence = [10000];
  assert.throws(() => skillSequence(role, skill, outOfRange));
  verified.push({ skill_index: skillIndex, image_segments: sequence.segments.length, combat_event_frame: eventFrame });
}
assert.equal(previewTravel(0, 7, 0), 0);
assert.equal(previewTravel(6, 7, 1), 0);
assert.equal(previewTravel(3, 7, 0), 1);
for (let i = 0; i < 7; i++) for (const progress of [-1, 0, .5, 1, 2]) assert.ok(previewTravel(i, 7, progress) >= 0 && previewTravel(i, 7, progress) <= 1);
const parent = {}, origin = 'http://127.0.0.1:8765', sessionId = 'test-session';
const data = sceneEnvelope(sessionId, 'battle-enter', { context: { entry_kind: 'development_demo', player_role_id: '001' } });
const event = { origin, source: parent, data };
assert.equal(validSceneMessage(event, parent, origin, sessionId), true);
for (const changed of [{ origin: 'http://example.com' }, { source: {} }, { data: { ...data, session_id: 'wrong' } },
  { data: { ...data, type: 'world-update' } }, { data: { ...data, context: { ...data.context, player_role_id: '999' } } }]) {
  assert.equal(validSceneMessage({ ...event, ...changed }, parent, origin, sessionId), false);
}
assert.throws(() => sceneEnvelope('', 'battle-ready'));
console.log(JSON.stringify({ passed: true, verified, scene_message_rejections: 5, preview_travel_bounds: 35 }));
