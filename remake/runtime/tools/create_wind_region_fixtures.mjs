// Browser handoffs from a supplied earned FF-02 save. Source rules replay
// transport/story; guardian victory and media completion are callbacks only.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorldStore,encodeSave,decodeSave} from '../web/core/world.mjs';
import {locomotion} from '../web/core/movement.mjs';
import {innerWhiteForestSource} from '../tests/helpers/inner_white_forest_world.mjs';
import {windRegionComplete,windIslandChests} from '../tests/helpers/wind_region_world.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function createWindRegionFixtures({from,out,nearEvents=false,servicesOnly=false}){
  assert.ok(from&&out,'需要 --from <FF-02真实结束存档> 和 --out <新输出目录>');
  const directory=resolve(out),runtime=fileURLToPath(new URL('../',import.meta.url)),remake=resolve(runtime,'..'),within=relative(remake,directory);
  assert.ok(within!=='..'&&!within.startsWith(`..\\`)&&!within.startsWith('../')&&!isAbsolute(within),'交接输出必须留在 remake 内');
  const inputBytes=await readFile(resolve(from)),source=await innerWhiteForestSource();
  const world=new WorldStore(await decodeSave(JSON.parse(inputBytes),source.mapIds),source.mapIds),checkpoints=[];
  const {trace}=await windRegionComplete(source,{world,verifyFailures:false,servicesOnly,checkpoint:async(name,current)=>checkpoints.push({name,world:current.snapshot()})});
  const targets={power_city_ticket_before:{kind:'npc',index:11},floating_plaza_exit_before:{kind:'trigger',index:9},
    island_ship_before:{kind:'npc',index:10},elder_gift_before:{kind:'npc',index:12},sacred_mountain_before:{kind:'trigger',index:2},
    coast_return:{kind:'npc',index:10},fire_valley_return_before:{kind:'trigger',index:6},
    power_city_inn_before:{kind:'npc',index:15},power_city_shop_before:{kind:'npc',index:12},power_city_synthesis_before:{kind:'npc',index:14}};
  for(const chest of windIslandChests)targets[`chest_${chest.mapId.toLowerCase()}_${chest.objectIndex}_before`]={kind:'object',index:chest.objectIndex};
  const positionHandoffs=[];
  if(nearEvents)for(const checkpoint of checkpoints){
    const target=targets[checkpoint.name];if(!target)continue;
    const mapId=checkpoint.world.location.map_id,map=source.maps[mapId],table=source.story.maps[mapId];let points,provenance;
    if(target.kind==='trigger'){
      const descriptor=table.descriptors.find(row=>row.id===target.index);
      points=descriptor.cells.map(({x,y})=>({x:(x+.5)*16,y:(y+.5)*16}));provenance=descriptor.source;
    }else if(target.kind==='object'){
      const object=table.objects.find(row=>row.index===target.index);points=[{x:object.x_native*2,y:object.y_native*2}];provenance=object.source;
    }else{
      const npc=source.resources.npcs_by_map[mapId].find(row=>row.slot_zero_based===target.index);points=[{x:npc.x,y:npc.y}];provenance=npc.source;
    }
    const candidates=[];
    for(let y=0;y<map.movement.height;y++)for(let x=0;x<map.movement.width;x++){
      if(map.movement.terrain_rows[y][x]!=='0'||map.movement.triggers.some(row=>row.x===x&&row.y===y))continue;
      const px=(x+.5)*16,py=(y+.5)*16;
      for(const point of points){
        const distance=Math.hypot(px-point.x,py-point.y);
        if(target.kind==='trigger'?Math.abs(px-point.x)+Math.abs(py-point.y)!==16:distance<20||distance>=48)continue;
        candidates.push({x:px,y:py,point,distance});
      }
    }
    candidates.sort((a,b)=>a.distance-b.distance||b.y-a.y||a.x-b.x);const at=candidates[0];assert.ok(at,`${checkpoint.name} 缺少原可通行邻格`);
    const {location:before,...retained}=checkpoint.world,dx=at.point.x-at.x,dy=at.point.y-at.y;
    checkpoint.world.location={map_id:mapId,x:at.x,y:at.y,direction:locomotion({dx:Math.sign(dx),dy:Math.sign(dy)},false).direction};
    const {location:after,...restored}=checkpoint.world;assert.deepEqual(restored,retained);
    positionHandoffs.push({name:checkpoint.name,from:before,to:after,target,source:provenance,unchanged_nonlocation_sha256:hash(JSON.stringify(retained))});
  }
  const runtimeInputs=Object.fromEntries(await Promise.all(['web/data/runtime_content.json','web/data/runtime_content.mjs','web/data/chapter_story.json',
    'web/data/chapter_map_resources.json','web/data/encounters.json','web/data/world_map.json','web/data/story/shared.json',
    'web/data/items.json','web/data/config/items.json','web/core/movement.mjs','tests/helpers/wind_region_world.mjs',
    'tools/create_wind_region_fixtures.mjs'].map(async path=>[path,hash(await readFile(new URL(path,new URL('../',import.meta.url))))])));
  await mkdir(directory,{recursive:true});const files=[];
  for(const [index,checkpoint]of checkpoints.entries()){
    const envelope=await encodeSave(checkpoint.world),bytes=JSON.stringify(envelope)+'\n',file=`${String(index).padStart(2,'0')}_${checkpoint.name}.json`;
    await writeFile(resolve(directory,file),bytes,{flag:'wx'});
    files.push({name:checkpoint.name,file,sha256:hash(bytes),payload_sha256:envelope.sha256,location:checkpoint.world.location,
      target:targets[checkpoint.name]??null,party:checkpoint.world.party.map(({id,level})=>({id,level})),
      flags:Object.fromEntries([10,12,465,436,477,519].map(index=>[index,checkpoint.world.flags[index]]))});
  }
  const manifest={schema:'seventh-seal-wind-region-handoffs',version:1,created_at:new Date().toISOString(),
    input:{path:resolve(from),sha256:hash(inputBytes)},services_only:servicesOnly,
    scope:servicesOnly?'从提供的FF-02结束档经神殿原出口、大地图及力城原DAT通路抵达宿屋、普通道具商和合成师；逐一执行完整NPC拒绝根。保留原175库伦、背包和角色资源，无金钱/物品/旗标注入；没有运行住宿、买卖或合成服务，没有战斗回调或媒体播放，不代表自然步行。':'从提供的FF-02结束档执行正式DAT/TLK/ANM规则；没有编造旗标、票务、队伍、物品或前置历史。034战使用胜利回调，不应用伤害、成长、金钱或掉落，影片即时完成；不证明自然步行、实战胜利或影片自然结束。',
    position_handoff_scope:'--near-events仅将原检查点玩家坐标和朝向调整到该地图原DAT可通行且无触发的事件邻格，其他字段逐项相等；不是自然步行。',
    position_handoffs:positionHandoffs,runtime_inputs:runtimeInputs,files,
    trace:{animations:trace.animations,battles:trace.battles.map(row=>({map_id:row.map_id,stage:row.stage,enemies:row.members.map(member=>member.id)})),
      media:trace.media,loaded_maps:trace.loaded_maps,command_indexes:trace.command_indexes,routes:trace.routes,objects:trace.objects,transfers:trace.transfers,services:trace.services??[]}};
  await writeFile(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{from:{type:'string'},out:{type:'string'},'near-events':{type:'boolean'},'services-only':{type:'boolean'}}});
  const manifest=await createWindRegionFixtures({...values,nearEvents:values['near-events'],servicesOnly:values['services-only']});
  console.log(JSON.stringify({out:resolve(values.out),files:manifest.files.length,animations:manifest.trace.animations,scripted_battle_callbacks:manifest.trace.battles.length,scope:manifest.scope}));
}
