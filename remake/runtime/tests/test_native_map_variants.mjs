import test from 'node:test';
import assert from 'node:assert/strict';
import {mapId,runtimeContent,validateContentRegistration} from '../web/core/content_registry.mjs';
import {validateCompactRecords,STORY_RESOURCE_TABLES,storyDigest} from '../web/core/story_packages.mjs';
import {validateChapterStory} from '../web/core/chapter.mjs';
import {StoryRepository} from '../web/core/story_repository.mjs';
import {validateQuests} from '../web/core/story_quests.mjs';
import {createAudioController} from '../web/core/audio.mjs';
import {planRouteExit} from '../web/core/route.mjs';

const variants=['M17030','M17030-1','M17030-2'];
const binding=id=>({path:`data/maps/${id.toLowerCase()}.json`,triggers:[],objects:[],rests:[],routes:[]});
const invalidIds=['../M17030-1','M17030-1/../M17020','M17030-x','M17030-','M17030-1-2','m17030-1'];

test('native map variants are separate admitted identities and reject invalid paths',()=>{
  const content=structuredClone(runtimeContent);
  for(const id of variants){assert.equal(mapId(id),true);content.maps[id]=binding(id);}
  validateContentRegistration(content);
  assert.deepEqual(variants.map(id=>content.maps[id].path),['data/maps/m17030.json','data/maps/m17030-1.json','data/maps/m17030-2.json']);
  for(const id of invalidIds){
    assert.equal(mapId(id),false,id);
    const invalid=structuredClone(content);invalid.maps[id]=binding(id);
    assert.throws(()=>validateContentRegistration(invalid),/地图路径无效/);
  }
});

test('variant compact TLK tables keep exact map and text identities',()=>{
  for(const id of variants){
    const record={id:1,text_id:`${id}:TLK:1`,text_raw:'source dialogue',choices:[]};
    for(const key of ['kind','style','region_byte_raw','speaker','condition_type','condition_index','condition_bit','mutation_type','mutation_index','mutation_bit','if_true','next'])record[key]=0;
    const source={path:`Map/${id.toLowerCase()}.TLK`,sha256:'a'.repeat(64)};
    const table={id,map_flag_index:1,source,records:[record]};
    validateCompactRecords(table);
    validateChapterStory({schema:'seventh-seal-chapter-story',version:2,maps:{[id]:table},source_hashes:{[source.path]:source.sha256}});
    const collapsed=structuredClone(table);collapsed.records[0].text_id='M17030:TLK:1';
    if(id!=='M17030')assert.throws(()=>validateCompactRecords(collapsed),/文本编号无效/);
  }
});

test('repository loads variant packages independently and quest references retain each variant',async()=>{
  const content={maps:Object.fromEntries(variants.map(id=>[id,binding(id)])),roles:{},programs:{}};
  const quests=[{id:'fire-altar',name:'Fire altar',maps:[...variants],stages:[{id:'available',status:'available',text:'',when:{all:[]}}]}];
  validateQuests(quests,content);
  const definition={maps:variants},files=new Map();
  async function reference(path,value){files.set(path,value);return {path,sha256:await storyDigest(value)};}
  const shared=await reference('data/story/shared.json',{schema:'seventh-seal-story-shared',version:1,
    chapter:{source_hashes:{},item_definitions:{},role_definitions:{}},roles:{},quests});
  const maps={};
  for(const id of variants)maps[id]=await reference(`data/story/maps/${id.toLowerCase()}.json`,{
    schema:'seventh-seal-story-map',version:2,map_id:id,chapter:null,texts:{},events:[],flows:{},programs:{},
    resources:Object.fromEntries(STORY_RESOURCE_TABLES.map(key=>[key,[]]))});
  const repository=await StoryRepository.create({read:async path=>structuredClone(files.get(path)),content,definition,capacity:3,
    index:{schema:'seventh-seal-story-index',version:2,definition_sha256:await storyDigest(definition),shared,maps}});
  for(const id of variants)await repository.ensureMap(id);
  assert.deepEqual([...repository.loaded.keys()],variants);
  assert.deepEqual(Object.keys(repository.resources.npcs_by_map),variants);
  assert.deepEqual(repository.journal({flags:[],party:[]})[0].maps,variants);
  for(const id of invalidIds)await assert.rejects(repository.ensureMap(id),/尚未登记/);
});

test('variant music and exit route selection do not collapse to the base map',()=>{
  const manifest={schema:'seventh-seal-audio',version:1,clips:{},maps:Object.fromEntries(variants.map(id=>[id,{clip:null,evidence:[]}])),battles:{},cues:{}};
  const audio=createAudioController(manifest);
  for(const id of variants){
    assert.doesNotThrow(()=>audio.setScene({mapId:id}));
    const record={id:1,kind:0,condition_type:0,condition_index:1,condition_bit:0,mutation_type:9,mutation_index:0,mutation_bit:0,region_byte_raw:0,next:0};
    const content={maps:{[id]:{...binding(id),flag_index:1}}};
    const route=planRouteExit({flags:[]},id,1,{[id]:{records:[record],source:{path:`Map/${id.toLowerCase()}.TLK`}}},content);
    assert.equal(route.source.path,`Map/${id.toLowerCase()}.TLK`);
    assert.deepEqual(route.commands,[{mode:0,area:0,destination:0}]);
  }
  for(const id of invalidIds)assert.throws(()=>audio.setScene({mapId:id}),/地图无效/);
  audio.dispose();
});
