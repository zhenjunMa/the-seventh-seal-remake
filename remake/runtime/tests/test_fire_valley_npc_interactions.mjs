import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ChapterRunner} from '../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../web/core/chapter_animation.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
import {compileItemConfiguration} from '../web/core/item_registry.mjs';
import {insertCrystal,crystalSocketCandidates} from '../web/core/crystal_sockets.mjs';
import {createPartyActors} from '../web/core/party_attributes.mjs';
const read=async file=>JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));
const [story,seed,mapData]=await Promise.all([read('../web/data/chapter_story.json'),read('../web/data/opening_seed.json'),read('../web/data/world_map.json')]);
const maps=Object.keys(runtimeContent.maps),regional=maps.filter(id=>id.startsWith('M170'));
function world(mapId,{returnVisit=false,arrivalComplete=false}={}){
  const value=structuredClone(seed);value.opening.status='complete';value.location={map_id:mapId,x:0,y:0,direction:1};
  value.flags[12]=returnVisit?value.flags[12]|1:value.flags[12]&~1;
  value.flags[10]=arrivalComplete?value.flags[10]|16:value.flags[10]&~16;
  return new WorldStore(value,maps);
}
function runner(value,extra={}){
  return new ChapterRunner({world:value,data:story,content:runtimeContent,say:async()=>{},
    choose:async({choices})=>choices[0].index,
    worldMapState:()=>({areas:mapData.areas.map(({id,selected_index,statuses})=>({id,selected_index,statuses:[...statuses]}))}),
    // Rules-only execution. Visual timing and real traversal are verified in
    // browser separately; the hooks here never claim original gameplay.
    animate:async({program,runTlk,joinActor,draft})=>{
      const result=await new ChapterAnimationRunner({program,runTlk,joinActor,initialLocation:draft.location,
        hooks:Object.fromEntries(['map','actor','move','camera','wait','fade'].map(key=>[key,async()=>{}]))}).run();
      draft.location=result.location;
    },...extra});
}

test('all 21 admitted Fire Valley maps retain native identities and every NPC entry executes under three source flag states',async()=>{
  assert.equal(regional.length,21);let checks=0;
  for(const phase of [{},{returnVisit:true},{returnVisit:true,arrivalComplete:true}])for(const mapId of regional){
    const binding=runtimeContent.maps[mapId],table=story.maps[mapId];
    assert.ok(Array.isArray(binding.npcs),`${mapId} must explicitly admit its dialogue slots`);
    for(const slot of binding.npcs){
      const entry=table.index_nonzero.find(row=>row.slot===slot);assert.ok(entry,`${mapId}:${slot}`);
      const value=world(mapId,phase);
      await assert.doesNotReject(runner(value).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}}),`${mapId} NPC ${slot} ${JSON.stringify(phase)}`);
      checks++;
    }
  }
  assert.ok(checks>=150,'all admitted NPC entries must be exercised in each phase');
});

for(const [mapId,itemId]of [['M17024',150],['M17028',156]])test(`${mapId} source crystal gift ${itemId} is saved once and a failed dialogue rolls it back`,async()=>{
  const binding=runtimeContent.maps[mapId],table=story.maps[mapId];
  const entry=table.index_nonzero.find(row=>row.slot===binding.npcs[0]);
  const value=world(mapId);
  // Gift eligibility comes from Lienan's request and Abao's reply, rather
  // than simply entering either room for the first time.
  value.transact(draft=>{draft.flags[50]|=3;if(mapId==='M17028')draft.flags[43]|=1;});
  const before=value.snapshot();
  let stagedGift=false;
  await assert.rejects(runner(value,{say:async({record,draft})=>{
    if(record.id!==(mapId==='M17024'?4:10))return;
    assert.equal(draft.inventory.find(row=>row.id===itemId)?.quantity,1);
    stagedGift=true;throw new Error('dialogue interrupted');
  }}).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}}),/interrupted/);
  assert.equal(stagedGift,true,'failure occurs after the source gift is staged');
  assert.deepEqual(value.snapshot(),before);
  await runner(value).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}});
  assert.equal(value.value.inventory.find(row=>row.id===itemId)?.quantity,1);
  const restored=new WorldStore(await decodeSave(await encodeSave(value.snapshot()),maps),maps),inventory=structuredClone(restored.value.inventory);
  await runner(restored).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}});
  assert.deepEqual(restored.value.inventory,inventory);
});

test('Lienan request, Abao reply and both crystal gifts advance through their original cross-map flags',async()=>{
  const value=world('M17028');
  async function talk(mapId){
    value.transact(draft=>{draft.location.map_id=mapId;});
    const entry=story.maps[mapId].index_nonzero.find(row=>row.slot===10);
    await runner(value).runTlk({mapId,recordId:entry.record,context:{steps:0,explicitInteraction:true}});
  }
  await talk('M17024');assert.equal(value.value.inventory.some(row=>row.id===150),false);
  await talk('M17028');assert.equal(value.value.flags[50]&3,1);
  await talk('M17028');assert.equal(value.value.flags[50]&3,3);
  await talk('M17024');assert.equal(value.value.flags[43]&1,1);
  assert.equal(value.value.inventory.find(row=>row.id===150)?.quantity,1);
  await talk('M17028');assert.equal(value.value.flags[50]&7,7);
  assert.equal(value.value.inventory.find(row=>row.id===156)?.quantity,1);
  const inventory=structuredClone(value.value.inventory);
  await talk('M17024');await talk('M17028');assert.deepEqual(value.value.inventory,inventory);
  const [items,configuration,attributes]=await Promise.all([read('../web/data/items.json'),read('../web/data/config/items.json'),read('../web/data/party_combat.json')]);
  const itemData=compileItemConfiguration(items,configuration,'original').data;
  assert.deepEqual(crystalSocketCandidates(value.value.inventory,itemData).map(row=>row.id),[150,156],'actual quest rewards are usable under the original configuration');
  const plain=createPartyActors(value.snapshot(),attributes,{},itemData)[0];
  for(const [slot,id]of [[1,150],[2,156]])insertCrystal({worldStore:value,attributes,itemData,roleId:'001',socketIndex:slot,
    instanceId:value.value.inventory.find(row=>row.id===id).instance_id});
  const actor=createPartyActors(value.snapshot(),attributes,{},itemData)[0];
  assert.equal(actor.linked_by_address['0x04f990e0'],plain.linked_by_address['0x04f990e0']+50,'red crystal20 plus ruby30 reaches the native linked fire getter');
  const saved=value.snapshot(),restored=new WorldStore(await decodeSave(await encodeSave(saved),maps),maps);
  assert.deepEqual(restored.value.crystal_sockets,saved.crystal_sockets);
  assert.deepEqual(createPartyActors(restored.snapshot(),attributes,{},itemData)[0].linked_by_address,actor.linked_by_address);
  await talk('M17024');await talk('M17028');assert.deepEqual(value.value.inventory,saved.inventory,'installed rewards cannot be granted again');
});
