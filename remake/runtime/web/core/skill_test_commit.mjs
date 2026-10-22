// Native test flag suppresses damage and skill MP costs, not inventory use or
// resource recovery. The caller keeps simulation private until this commit.
const need=(ok,message)=>{if(!ok)throw new Error(message);};
export function commitSkillTestResources(world,battle,result,expectedRevision){
  need(world.value.revision===expectedRevision,'测试期间地图进度已变化，测试结果未覆盖新进度');
  need(battle?.test_mode===true&&result?.test_mode===true,'技巧测试提交来源无效');
  const ids=battle.actors.filter(a=>a.side==='player').map(a=>a.id),resources=result.resources_by_actor;
  need(resources&&Object.keys(resources).length===ids.length&&ids.every(id=>resources[id]&&world.value.party.some(a=>a.id===id)),'技巧测试人物资源不匹配');
  for(const row of Object.values(resources))for(const key of ['hp','mp'])need(Number.isInteger(row[key])&&row[key]>=0&&row[key]<=0xffffffff,'技巧测试资源无效');
  const resourcesChanged=ids.some(id=>{const actor=world.value.party.find(a=>a.id===id),row=resources[id];return actor.hp.current!==row.hp||actor.mp.current!==row.mp;});
  const inventoryChanged=battle.inventory!==undefined&&JSON.stringify(battle.inventory)!==JSON.stringify(world.value.inventory);
  if(resourcesChanged||inventoryChanged)world.transact(draft=>{
    for(const id of ids){const actor=draft.party.find(a=>a.id===id);actor.hp.current=resources[id].hp;actor.mp.current=resources[id].mp;}
    if(inventoryChanged)draft.inventory=structuredClone(battle.inventory);
  });
  return {changed:resourcesChanged||inventoryChanged,resources_changed:resourcesChanged,inventory_changed:inventoryChanged,world_revision:world.value.revision};
}
