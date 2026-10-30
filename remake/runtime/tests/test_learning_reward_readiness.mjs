import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {requireLearningRewardReadiness} from '../web/core/content_readiness.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {validateEnemyReactionClosure} from '../web/core/content_dependencies.mjs';
const story=JSON.parse(await readFile(new URL('../web/data/chapter_story.json',import.meta.url),'utf8'));
const rewards=[['M17010',93,'001',36],['M17010',94,'002',31],['M17010',95,'005',30],
  ['M17028',13,'001',35],['M17028',16,'002',30],['M17028',17,'003',33]];

test('every real Fire Valley learning reward resolves its source ID and requires execution for original menu skills',()=>{
  for(const [mapId,recordId,roleId,index]of rewards){
    const record=story.maps[mapId].records.find(row=>row.id===recordId),content=structuredClone(runtimeContent);
    content.roles[roleId].battle_skills=content.roles[roleId].battle_skills.filter(row=>row.index!==index);
    content.roles[roleId].field_skills=(content.roles[roleId].field_skills??[]).filter(row=>row.index!==index);
    assert.throws(()=>requireLearningRewardReadiness(record,content,story.role_definitions),/尚无已接入技能处理器/);
    content.roles[roleId].battle_skills.push({id:`${roleId}_${index}`,index,handler:'effect-carrier'});
    assert.equal(requireLearningRewardReadiness(record,content,story.role_definitions).index,index);
  }
});

test('a missing source ID remains the original no-op while missing role definitions cannot silently admit a reward',()=>{
  const record={mutation_type:14,mutation_index:0,mutation_bit:255};
  assert.equal(requireLearningRewardReadiness(record,runtimeContent,story.role_definitions),null);
  assert.throws(()=>requireLearningRewardReadiness(record,runtimeContent,{}),/缺少原技能源定义/);
});

test('source enemy skills close over every admitted player response, including stage12 airborne hits',async()=>{
  const [ai,reactions]=await Promise.all(['forest_ai','party_reactions'].map(async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'))));
  assert.doesNotThrow(()=>validateEnemyReactionClosure(ai,reactions,runtimeContent));
  const unsupported=structuredClone(reactions),airborne=unsupported.roles['002'].skills.find(skill=>skill.original_id_raw===5);
  assert.ok(airborne);
  let changed=0;
  for(const action of airborne.actions){
    const bytes=Buffer.from(action.raw_hex,'hex');
    if(bytes[0]===1&&bytes.readUInt32LE(1)===3){bytes[0x47]=0;action.raw_hex=bytes.toString('hex');changed++;}
  }
  assert.ok(changed,'perturb an actual source vertical command, not a synthetic enemy');
  assert.throws(()=>validateEnemyReactionClosure(ai,unsupported,runtimeContent),/敌人 032／技能索引(?:9|10|11) → 玩家 002/);
});
