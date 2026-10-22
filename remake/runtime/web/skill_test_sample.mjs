// The menu's test command uses the normal source party/enemy assemblers.
// The separate WorldStore belongs to this temporary session, not the map.
import {createPartySample} from './party_sample.mjs';
import {assembleForestSample} from './forest_sample.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(message);};
export function createSkillTestSample(world,attributes,commands,configured,items,rules,reactions,statuses){
  need(rules?.schema==='seventh-seal-skill-test'&&rules.version===1&&rules.native_mode?.global_055ee004===1,'技巧测试来源无效');
  need(Array.isArray(rules.enemy_resources)&&rules.enemy_resources.length===3&&rules.enemy_resources.every(id=>configured.forest.actors[id]),'技巧测试敌人来源缺失');
  const scheduler={...structuredClone(configured.scheduler),idle_skills:{...structuredClone(configured.scheduler.idle_skills),...structuredClone(commands.idle_skills)}};
  const party=createPartySample(world,attributes,commands,configured,items);
  const group={kind:'skill-test',map_id:null,members:rules.enemy_resources.map(id=>({id}))};
  const sample=assembleForestSample(party,configured.forest,group,scheduler,configured.ai,null,reactions,statuses);
  sample.test_mode=true;
  sample.source={...sample.source,scope:'Original menu technique test: joined party and fixed source targets; ordinary scheduler, contacts, animations and commands.',
    skill_test:{stage_id:rules.stage.stage_id,enemy_resources:[...rules.enemy_resources],native_mode:structuredClone(rules.native_mode),source:structuredClone(rules.source??rules.source_hashes),evidence:structuredClone(rules.evidence)},
    limitations:[...(sample.source.limitations??[]),'Temporary test session; no natural encounter or main-story acquisition is claimed.']};
  return sample;
}
