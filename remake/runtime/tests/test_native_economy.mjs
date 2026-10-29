// Actual TLK goods and ITM records through the common economy and save rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {readNativeService,nativeEconomyCatalog,nativeServiceRows,nativeOwnedQuantity,applyNativeServiceAction} from '../web/core/native_economy.mjs';
import {initializeChapterItem,ChapterRunner} from '../web/core/chapter.mjs';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {withItemQuantity} from '../web/core/equipment.mjs';
import {runtimeContent} from '../web/core/content_registry.mjs';
const json=async name=>JSON.parse(await readFile(new URL(`../web/data/${name}.json`,import.meta.url),'utf8'));
const [items,story,seed]=await Promise.all(['items','chapter_story','opening_seed'].map(json));
const catalog=nativeEconomyCatalog(items);
const service=(map,id)=>readNativeService(story.maps[map].records[id-1],story.maps[map]);
function inventory(id,quantity=1){
  const raw=initializeChapterItem(catalog[id],{allowWeapon:true});new DataView(raw.buffer).setUint32(4,quantity,true);
  return {id,name:catalog[id].name,quantity,instance_id:`test:${id}`,source_raw_hex:Buffer.from(raw).toString('hex')};
}
function world(){const value=structuredClone(seed);value.money=100000;value.inventory=[];return value;}

test('source shop goods, prices, half-price selling and the owned99 cap survive a save',async()=>{
  const shop=service('M01033',3),armor=service('M01063',2),value=world();
  assert.deepEqual(shop.goods,[8,11,12,13,23,24,25,26,27,28,272,280,315,320,321,323,324,21]);
  assert.deepEqual(shop.allowedModes,['buy','sell']);
  for(const id of shop.goods){
    const raw=Buffer.from(items.definitions[id].raw_hex,'hex');
    assert.equal(catalog[id].price,raw.readInt32LE(0x14c));
  }
  const price=Buffer.from(items.definitions[13].raw_hex,'hex').readInt32LE(0x14c);
  const bought=applyNativeServiceAction(value,shop,catalog,{mode:'buy',id:13,quantity:3,mapId:'M01033',recordId:3});
  assert.equal(bought.changed,true);assert.equal(value.money,100000-price*3);
  assert.equal(value.inventory[0].quantity,3);assert.equal(Buffer.from(value.inventory[0].source_raw_hex,'hex').readUInt32LE(4),3);
  const instance=value.inventory[0].instance_id;
  applyNativeServiceAction(value,shop,catalog,{mode:'sell',id:instance,quantity:2});
  assert.equal(value.money,100000-price*3+(price>>1)*2);assert.equal(value.inventory[0].quantity,1);
  value.inventory[0]=withItemQuantity(value.inventory[0],98);
  const before=structuredClone(value);
  assert.equal(applyNativeServiceAction(value,shop,catalog,{mode:'buy',id:13,quantity:2}).changed,false);
  assert.deepEqual(value,before);
  const armorRows=nativeServiceRows(armor,value,catalog,{mode:'buy',category:'equipment'});
  assert.equal(armorRows.length,20);assert.ok(armorRows.every(row=>catalog[row.item_id].type===2));
  value.money=0;assert.equal(applyNativeServiceAction(value,armor,catalog,{mode:'buy',category:'equipment',id:60}).changed,false);
  const decoded=await decodeSave(await encodeSave(value),Object.keys(runtimeContent.maps));
  assert.equal(decoded.money,value.money);assert.deepEqual(decoded.inventory,value.inventory);
});

test('source recipes consume exact ingredients, charge no money, and forge to the allowed role',async()=>{
  const forge=service('M01042',7),synthesis=service('M01062',11),value=world();
  assert.deepEqual(forge.allowedModes,['forge']);assert.deepEqual(synthesis.allowedModes,['synthesize']);
  value.recipe_unlock_indices=[215,252,253,264];
  assert.deepEqual(catalog[216].ingredients,[210,229]);
  assert.deepEqual(catalog[253].ingredients,[173,224,228,227]);
  assert.deepEqual(nativeServiceRows(forge,value,catalog,{mode:'forge',category:'weapon'}).map(row=>row.item_id),[253,254]);
  assert.deepEqual(nativeServiceRows(forge,value,catalog,{mode:'forge',category:'crystal'}).map(row=>row.item_id),[]);
  assert.ok(nativeServiceRows(synthesis,value,catalog,{mode:'synthesize',category:'all'}).every(row=>!row.enabled));
  value.inventory=[inventory(210,2),inventory(229)];
  assert.equal(applyNativeServiceAction(value,synthesis,catalog,{mode:'synthesize',category:'material',id:216}).changed,true);
  assert.equal(value.money,100000);assert.equal(nativeOwnedQuantity(value,210),1);assert.equal(nativeOwnedQuantity(value,229),0);assert.equal(nativeOwnedQuantity(value,216),1);
  const before=structuredClone(value);
  assert.equal(applyNativeServiceAction(value,synthesis,catalog,{mode:'synthesize',category:'material',id:216}).changed,false);assert.deepEqual(value,before);
  value.inventory.push(...catalog[253].ingredients.map(id=>inventory(id)));
  const oldWeapon=value.source.initial_equipment.find(row=>row.role_id==='001').item_id;
  assert.equal(applyNativeServiceAction(value,forge,catalog,{mode:'forge',category:'weapon',id:253}).changed,true);
  assert.equal(value.equipment.roles['001'].find(row=>row.slot_id==='weapon').id,253);
  assert.equal(nativeOwnedQuantity(value,oldWeapon),0);assert.equal(value.money,100000);
  for(const id of catalog[253].ingredients)assert.equal(nativeOwnedQuantity(value,id),0);
  const decoded=await decodeSave(await encodeSave(value),Object.keys(runtimeContent.maps));assert.deepEqual(decoded.equipment,value.equipment);
});

test('a real kind8 service uses the existing story draft and rolls purchases back if the interaction aborts',async()=>{
  const value=world();value.location={map_id:'M01033',x:640,y:480,direction:0};value.opening.status='complete';
  const store=new WorldStore(value,Object.keys(runtimeContent.maps));
  const before=structuredClone(store.value);
  const runner=new ChapterRunner({world:store,data:story,content:runtimeContent,say:async()=>{},choose:async()=>0,
    service:async({record,table,draft})=>{
      assert.equal(applyNativeServiceAction(draft,readNativeService(record,table),catalog,{mode:'buy',id:13,quantity:2,mapId:'M01033',recordId:3}).changed,true);
      throw new Error('test interaction cancelled');
    }});
  await assert.rejects(runner.runTlk({mapId:'M01033',recordId:3,context:{explicitInteraction:true,steps:0}}),/test interaction cancelled/);
  assert.deepEqual(store.value,before);
});
