import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPartySkillSample,PARTY_SKILL_SAMPLE_ROSTERS,partySampleSkillIndices} from '../web/core/party_skill_sample.mjs';
import {allPartyRoles} from '../web/core/party_roster.mjs';
import {admitPartyMember,deactivatePartyMember} from '../web/core/party_members.mjs';
import {encodeSave,decodeSave} from '../web/core/world.mjs';
import {battleSkillEligibility,effectiveSkillSource} from '../web/core/battle_skill_access.mjs';
import {previewMovement} from '../web/core/encounters.mjs';
const read=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [seed,rewards,commands,forest,encounters]=await Promise.all(['opening_seed','party_rewards','party_skills','maps/m70010','encounters'].map(read));
const {x,y,direction}=forest.route_entry,location={map_id:forest.id,x,y,direction};

test('Two four-person development worlds preserve all six grown records and source learning gates across save/load',async()=>{
  const before={seed:structuredClone(seed),rewards:structuredClone(rewards),commands:structuredClone(commands)};
  for(const activeRoleIds of Object.values(PARTY_SKILL_SAMPLE_ROSTERS)){
    const world=createPartySkillSample(seed,rewards,commands,location,{activeRoleIds});
    assert.deepEqual(world.party.map(role=>role.id),activeRoleIds);assert.equal(world.reserve_party.length,2);
    const owned=allPartyRoles(world);assert.equal(owned.length,6);
    const effective=effectiveSkillSource(commands,world);
    for(const role of owned){
      const initial=rewards.initial_roles[role.id],raw=Buffer.from(initial.header_raw_hex,'hex'),grown=Buffer.from(role.combat_progress.header_raw_hex,'hex');
      const levels=99-initial.level,row=rewards.tables.growth_rows[initial.growth_row];
      assert.equal(role.level,99);assert.equal(grown.readInt32LE(0x24),99);
      assert.equal(role.hp.maximum,raw.readInt32LE(0x34)+levels*row[0]);
      assert.equal(role.mp.maximum,raw.readInt32LE(0x3c)+levels*row[2]);
      assert.equal(grown.readInt32LE(0x5c),raw.readInt32LE(0x5c)+levels*row[8]);
      assert.equal(role.hp.current,role.hp.maximum);assert.equal(role.mp.current,role.mp.maximum);
      for(const index of partySampleSkillIndices(commands.roles[role.id])){
        assert.ok(role.skill_progress.learned_indices.includes(index));
        assert.equal(effective.roles[role.id].skills[index].learned_raw,1);
      }
    }
    assert.deepEqual(await decodeSave(await encodeSave(world)),world);
    const result=previewMovement(world.encounters,{party:world.party,leader_id:world.leader_id,map_id:forest.id,dx:16,dy:0},encounters);
    assert.equal(result.encounter.trigger_roll.raw,998);
  }
  const source=commands.roles['001'].skills[26],normal=battleSkillEligibility(seed,source);
  assert.equal(normal.required_level,12);assert.equal(normal.learned,false);assert.equal(normal.available,false);
  assert.deepEqual({seed,rewards,commands},before);
});

test('Returning a saved level-99 reserve member preserves learning and grown resources with the normal four-slot admission cap',()=>{
  const world=createPartySkillSample(seed,rewards,commands,location),reserve=structuredClone(world.reserve_party.find(entry=>entry.role.id==='005').role);
  assert.equal(admitPartyMember(world,'005').reason,'formation-full');
  deactivatePartyMember(world,'004');assert.equal(admitPartyMember(world,'005').reactivated,true);
  assert.deepEqual(world.party.find(role=>role.id==='005'),reserve);
  assert.ok(reserve.skill_progress.learned_indices.includes(29));assert.ok(reserve.skill_progress.learned_indices.includes(30));
  assert.equal(commands.roles['005'].skills[29].type_raw,0);assert.equal(commands.roles['005'].skills[30].type_raw,0);
});
