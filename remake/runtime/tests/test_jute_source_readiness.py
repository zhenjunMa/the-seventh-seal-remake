"""Actual 005 source admission contracts, including its cross-group response."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

RUNTIME = Path(__file__).resolve().parents[1]
ROOT = RUNTIME.parents[1]
sys.path.insert(0, str(RUNTIME / "tools"))
import export_party_combat as combat_export
import export_party_skills as skills_export
import export_skill_layers as layers_export
from export_battle_view import sequence
from export_combat_presentation import native_frame_sequence, indexed_contribution
from route_extract_resources import anm_record
from source.combat_resources import CHR
from source.dgp import DGP, DGPError


NODE_CONTRACT = r"""
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {admitPartyMember} from './web/core/party_members.mjs';
import {ChapterAnimationRunner} from './web/core/chapter_animation.mjs';
import {runtimeContent} from './web/core/content_registry.mjs';
import {createPartyActors} from './web/core/party_attributes.mjs';
import {battleMenuSkillOrder,skillShortcuts} from './web/core/skill_shortcuts.mjs';
import {learnedOperationSkills} from './web/core/operation_menu.mjs';
import {compileNativeSequence,directSequence} from './web/core/skill_sequence.mjs';
import {resolveAction,createNativeRng} from './web/core/combat_rules.mjs';
import {NativeAssemblyOracle} from './tests/native_assembly_oracle.mjs';
const input=JSON.parse(fs.readFileSync(0,'utf8')),copy=structuredClone;
const world=copy(input.seed),content=copy(runtimeContent),definition=world.source.role_definitions['005'];
content.roles['005']={side:'player',native_slot:4,source:{path:definition.path,sha256:definition.sha256},
 battle_skills:[19,20,21,22].map(index=>({index,id:`005_${index}`,handler:'direct'})),primary_skill:19};
content.programs[input.program.id]=copy(input.program.source);
content.maps.M17014??={path:'data/maps/m17014.json'};
world.formation_slots=['001',null,null,null];
const calls=[],joins=[];
async function replay(){
 const runner=new ChapterAnimationRunner({program:input.program,content,initialLocation:{map_id:'M17014',x:0,y:0},
  hooks:Object.fromEntries(['map','actor','move','camera','wait'].map(name=>[name,async()=>{}])),
  runTlk:async request=>calls.push(request.recordId),joinActor:async({actorSlot,modeRaw})=>{
   assert.equal(actorSlot,4);assert.equal(modeRaw,0);
   joins.push(admitPartyMember(world,'005',{definitions:world.source.role_definitions,content}));
  }});
 await runner.run();
}
await replay();assert.deepEqual(world.party.map(r=>r.id),['001','005']);
assert.deepEqual(world.formation_slots,['001','005',null,null]);
assert.equal(world.party[1].level,14);assert.equal(world.party[1].hp.current,1330);
assert.equal(joins[0].added,true);await replay();assert.equal(joins[1].added,false);
assert.equal(calls.length,4); // two original TLK commands on each replay
const source={roles:{'005':input.role},skills:input.skills};
assert.deepEqual(skillShortcuts(world,source,'005'),[19,20,21]);
assert.deepEqual(battleMenuSkillOrder(world,source,input.skills,'005'),['005_19','005_20','005_21','005_22']);
const menu=learnedOperationSkills(world,source,null,'005');
assert.deepEqual(menu.filter(row=>row.implemented).map(row=>row.index),[19,20,21,22]);
const response=input.role.skills.find(s=>s.original_id_raw===9);
const compiled=compileNativeSequence({roles:[input.view],effects:[]},'005',
 {...directSequence(response),allow_no_contacts:true},[input.bank]);
assert.deepEqual(compiled.steps.map(step=>step.source_frame),[36,37,38,39,40,41,42]);
assert.ok(compiled.steps.every(step=>step.pair?.source_frame===step.source_frame));
const actors=createPartyActors(world,input.attributes,{'005':input.skills['005_19']},null,content);
const attackerSource=actors.find(actor=>actor.id==='005');let comparisons=0;
for(const skill of Object.values(input.skills)){
 const plan=compileNativeSequence({roles:[input.view],effects:[]},'005',directSequence(skill),[input.bank]);
 assert.equal(plan.steps.filter(step=>step.event).length,1);
 for(const targetSource of Object.values(input.forest.actors))for(const seed of [0,1,12345,0x20261024]){
  const attacker=copy(attackerSource),target=copy(targetSource),contact=skill.actions.find(action=>action.contact_u32_raw_0x49);
  Object.assign(attacker,{current_skill:copy(skill),class_raw:contact.class_raw,action_mask_raw:contact.action_mask_raw});
  const actual=resolveAction({attacker,target,skill,rng:createNativeRng(seed)});
  const oracle=new NativeAssemblyOracle(input.assembly.functions,[attacker,target],createNativeRng(seed));
  const native=oracle.run(0x41d990,[0,1,0x20000000,0]);
  assert.equal(actual.native_return,native.eax,skill.id);assert.equal(actual.reaction,oracle.read(0x20000000));
  assert.deepEqual(actual.trace.filter(row=>row.kind==='rng').map(row=>row.raw),native.rng_calls);comparisons++;
 }
}
process.stdout.write(JSON.stringify({comparisons,response_frames:compiled.steps.length,joins:joins.map(row=>row.added)}));
"""


@unittest.skipUnless((ROOT / 'Fight_Role/005.CHR').exists(), 'Original 005 sources unavailable')
class JuteSourceReadiness(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chr = CHR(ROOT / 'Fight_Role/005.CHR')
        cls.dgp = DGP(ROOT / 'Fight_Role/005.dgp')
        cls.walk = DGP(ROOT / 'ROLE/005.dgp')
        with patch.object(skills_export, 'COMMANDS', {'005': {i: f'005_{i}' for i in range(19, 23)}}):
            cls.role = skills_export.source_role(cls.chr)
        cls.skills = {f'005_{i}': {**skills_export.source_skill(cls.chr, cls.chr.skills[i]),
                                   'id': f'005_{i}', 'battle_handler': 'direct'} for i in range(19, 23)}

    def test_four_source_attacks_and_walk_assets_fit_existing_handlers(self):
        self.assertEqual(self.chr.name, '朱特')
        self.assertEqual(self.role['default_hotkey_indices'], [19, 20, 21])
        effect_ids = set()
        for skill in self.skills.values():
            raw = bytes.fromhex(skill['fixed_raw_hex'])
            self.assertEqual(skill['type_raw'], 1)
            self.assertEqual(skill['learned_raw'], 1)
            self.assertEqual(skill['target_side_raw'], 0)
            self.assertEqual(skill['mp_cost'], 0)
            self.assertEqual(raw[0x16B:0x231], bytes(0xC6))
            self.assertTrue(all(a['type_raw'] == 0 or a['type_raw'] == 1 and a['u32_at_0x01_raw'] == 11 for a in skill['actions']))
            view = sequence(self.chr, self.dgp, skill['original_skill_index'])
            self.assertEqual(sum(segment['event'] is not None for segment in view['segments']), 1)
            for segment in view['segments']:
                for effect in segment['effects']:
                    effect_ids.add(effect['asset_id'])
        for ident in effect_ids:
            effect = DGP(ROOT / f'Fight_Role/Effect/{ident}.dgp')
            self.assertEqual(len(effect.actions), 1)
            self.assertEqual(effect.actions[0]['directions'], 1)
            self.assertEqual(sum(n for frame in range(effect.frame_count) for _, spans in effect.rows(frame) for _, n, _ in spans), 0)
            audit = layers_export.SourceAudit(effect.data)
            for frame in range(effect.frame_count):
                self.assertEqual(indexed_contribution(effect, frame)[0].tobytes(), audit.sparse(frame, True)[0])
        self.assertTrue(all(action['directions'] == 8 for action in self.walk.actions))

    def test_source_response9_uses_global36_through42_without_changing_raw_group_size(self):
        raw = self.dgp.raw_actions[6]
        self.assertEqual(raw[0x0E], 6)
        self.assertEqual(struct.unpack_from('<I', raw, 0x72)[0], 36)
        with self.assertRaises(DGPError):
            native_frame_sequence(raw, 0, 7, 0)
        self.assertEqual(native_frame_sequence(raw, 0, 7, 0, total_frames=318), list(range(7)))
        with self.assertRaisesRegex(DGPError, 'global frame pool'):
            native_frame_sequence(raw, 0, 283, 0, total_frames=318)
        view = sequence(self.chr, self.dgp, 9)
        self.assertEqual(view['segments'][0]['frames'], list(range(7)))

    def test_isolated_generic_assets_preserve_spill_pixels_and_actual_join_menu_combat_contracts(self):
        indices = [i for i, s in enumerate(self.chr.skills) if s['id_raw'] in (0, *skills_export.RESPONSE_IDS)]
        views = {i: sequence(self.chr, self.dgp, i) for i in {*indices, *range(19, 23)}}
        for i, view in views.items():
            if i in range(19, 23):
                view['runtime_skill_id'] = f'005_{i}'
        role = {'id': '005', 'name': self.chr.name, 'frame_width': self.dgp.width, 'frame_height': self.dgp.height,
                'anchor': dict(x=self.dgp.anchor_raw[0], y=self.dgp.anchor_raw[1]),
                'mirror': False, 'direction': 0, 'idle': views[0]['segments'][0],
                'reaction': views[1]['segments'][0], 'skill': views[19],
                'alternate_skills': [views[i] for i in range(20, 23)],
                'response_skills': [views[i] for i in indices if i != 0]}
        with tempfile.TemporaryDirectory(prefix='jute-source-test-', dir=RUNTIME) as temporary:
            runtime = Path(temporary)
            web = runtime / 'web'
            (web / 'data').mkdir(parents=True)
            (runtime / 'evidence').mkdir()
            seed = RUNTIME / 'web/data/opening_seed.json'
            shutil.copyfile(seed, web / 'data/opening_seed.json')
            for filename, _, _ in combat_export.EVIDENCE_REQUESTS.values():
                shutil.copyfile(RUNTIME / 'evidence' / filename, runtime / 'evidence' / filename)
            with patch.multiple(combat_export, RUNTIME=runtime), patch.object(combat_export, 'role_ids', return_value=('001', '005')), redirect_stdout(io.StringIO()):
                combat_export.export()
            sources = {'Fight_Role/005.CHR': self.chr.sha256, 'Fight_Role/005.dgp': self.dgp.sha256}
            checks = []
            with patch.multiple(skills_export, RUNTIME=runtime, WEB=web), patch.object(layers_export, 'WEB', web):
                skills_export.export_role_assets(role, self.chr, self.dgp, sources, checks)
            action = next(a for a in role['actions'] if a['index'] == 6)
            self.assertEqual((action['source_frame_count'], action['frame_count']), (6, 7))
            self.assertEqual(bytes.fromhex(action['native_raw_hex'])[0x0E], 6)
            from PIL import Image
            with Image.open(web / action['sheet'].lstrip('/')) as image:
                self.assertEqual(image.crop((self.dgp.width * 6, 0, self.dgp.width * 7, self.dgp.height)).convert('RGBA').tobytes(), self.dgp.decode(42).tobytes())
            bank = json.loads((web / 'data/party_role_layers_005.json').read_text('utf-8'))
            self.assertTrue(any(frame['source_frame'] == 42 for frame in bank['frames']))
            parsed = anm_record(ROOT / 'Animate/m17010-2.anm')
            commands = []
            for record in parsed['records']:
                raw = bytes.fromhex(record['raw_hex'])
                command = {'index': record['index'], 'opcode': raw[0], 'raw_hex': raw.hex(),
                           'source': {'path': parsed['path'], 'sha256': parsed['sha256'], 'offset': record['offset']}}
                command.update({f'u32_plus{offset}': struct.unpack_from('<I', raw, offset)[0] for offset in [1, 5, 9, 13, 17, 21, 25]})
                command.update({f'byte_plus{offset}': raw[offset] for offset in range(29, 34)})
                if raw[0] == 10:
                    command['filename'] = raw[54:74].split(b'\0')[0].decode('ascii')
                commands.append(command)
            program = {'schema': 'seventh-seal-chapter-anm', 'version': 1, 'id': 'm17010-2',
                       'source': {key: parsed[key] for key in ['path', 'sha256', 'bytes']}, 'commands': commands,
                       'maps': ['M17014'], 'expected': {'control_map': 'M17014', 'caller_maps': ['M17014']}}
            payload = {'seed': json.loads(seed.read_text('utf-8')), 'attributes': json.loads((web / 'data/party_combat.json').read_text('utf-8')),
                       'role': self.role, 'skills': self.skills, 'view': role, 'bank': bank, 'program': program,
                       'forest': json.loads((RUNTIME / 'web/data/forest_combat.json').read_text('utf-8')),
                       'assembly': json.loads((RUNTIME / 'evidence/turn_rules_assembly_20261011.json').read_text('utf-8'))}
            result = subprocess.run(['node', '--input-type=module', '-e', NODE_CONTRACT], cwd=RUNTIME,
                                    input=json.dumps(payload), encoding='utf-8', capture_output=True, check=True)
            result = json.loads(result.stdout)
            self.assertEqual(result, {'comparisons': 16 * len(payload['forest']['actors']), 'response_frames': 7, 'joins': [True, False]})


if __name__ == '__main__':
    unittest.main()
