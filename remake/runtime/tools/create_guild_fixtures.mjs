// Earned-source handoffs for guild UI acceptance. Rule battle/reward callbacks
// and instant ANM media are retained explicitly, never reported as live wins.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WorldStore,decodeSave,encodeSave} from '../web/core/world/world.mjs';
import {locomotion} from '../web/core/exploration/movement.mjs';
import {innerWhiteForestSource} from '../tests/helpers/inner_white_forest_world.mjs';
import {guildComplete} from '../tests/helpers/guild_world.mjs';
import {createPartySkillSample} from '../web/core/party/party_skill_sample.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function createGuildFixtures({from,out,nearEvents=false,violent=false,level99=false}){
  assert.ok(out,'需要 --out <新目录>；--from可选，省略时由早期原入口赚齐前置');
  const runtime=fileURLToPath(new URL('../',import.meta.url)),directory=resolve(out),within=relative(resolve(runtime,'..'),directory);
  assert.ok(within!=='..'&&!within.startsWith('../')&&!within.startsWith('..\\')&&!isAbsolute(within),'交接输出须位于remake内');
  const source=await innerWhiteForestSource(),inputPath=from?resolve(from):resolve(runtime,'web/data/opening_seed.json'),input=await readFile(inputPath);
  const world=from?new WorldStore(await decodeSave(JSON.parse(input),source.mapIds),source.mapIds):undefined,checkpoints=[];
  const {trace}=await guildComplete(source,{world,peaceful:!violent,verifyFailures:false,
    checkpoint:async(name,current)=>checkpoints.push({name,world:current.snapshot()})});
  if(level99){
    const [rewards,skills]=await Promise.all(['party_rewards','party_skills'].map(async name=>JSON.parse(await readFile(resolve(runtime,`web/data/${name}.json`),'utf8'))));
    for(const checkpoint of checkpoints){
      const before=checkpoint.world,activeRoleIds=[before.leader_id,...['001','003','004','006'].filter(id=>id!==before.leader_id)].slice(0,4);
      checkpoint.world=createPartySkillSample(structuredClone(before),rewards,skills,before.location,{activeRoleIds});
      checkpoint.world.encounters={...before.encounters,
        counters:Object.fromEntries(activeRoleIds.map(id=>[id,before.encounters.counters[id]??0])),
        remainders:Object.fromEntries(activeRoleIds.map(id=>[id,before.encounters.remainders[id]??0]))};
      for(const key of ['flags','inventory','money','event_records','recipe_unlock_indices','reward_records'])assert.deepEqual(checkpoint.world[key],before[key]);
    }
  }
  const targets={tongs_before:{kind:'npc',index:12},iron_drill_before:{kind:'npc',index:12},ember_flame_before:{kind:'npc',index:12},house_gift_before:{kind:'npc',index:11},
    moss_synthesis_before:{kind:'npc',index:15},tea_synthesis_before:{kind:'npc',index:15},giant_hammer_before:{kind:'npc',index:19},
    god_drill_before:{kind:'npc',index:19},god_flame_before:{kind:'npc',index:19},god_hammer_before:{kind:'npc',index:19},
    ocean_heart_before:{kind:'npc',index:12},wolf_first_before:{kind:'trigger',index:32},wolf_e_before:{kind:'trigger',index:32},
    wolf_i_before:{kind:'trigger',index:31},wolf_v_before:{kind:'trigger',index:32},research_six_enemy_before:{kind:'object',index:95},
    research_final_before:{kind:'trigger',index:2},first_weapon_forge_before:{kind:'npc',index:10},god_hammer_forge_before:{kind:'npc',index:10}};
  const positionHandoffs=[];
  if(nearEvents)for(const checkpoint of checkpoints){
    const target=targets[checkpoint.name];if(!target)continue;
    const mapId=checkpoint.world.location.map_id,map=source.maps[mapId],table=source.story.maps[mapId];let points,provenance;
    if(target.kind==='trigger'){
      const descriptor=table.descriptors.find(row=>row.id===target.index);
      points=descriptor.cells.map(({x,y})=>({x:(x+.5)*16,y:(y+.5)*16}));provenance=descriptor.source;
    }else if(target.kind==='object'){
      const object=table.objects.find(row=>row.index===target.index);
      points=[{x:object.x_native*2,y:object.y_native*2}];provenance=object.source;
    }else{
      const npc=source.resources.npcs_by_map[mapId].find(row=>row.slot_zero_based===target.index);
      points=[{x:npc.x,y:npc.y}];provenance=npc.source;
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
    const {location:after,...unchanged}=checkpoint.world;assert.deepEqual(unchanged,retained);
    positionHandoffs.push({name:checkpoint.name,from:before,to:after,target,source:provenance,unchanged_nonlocation_sha256:hash(JSON.stringify(retained))});
  }
  const inputs=Object.fromEntries(await Promise.all(['web/data/runtime_content.json','web/data/runtime_content.mjs','web/data/chapter_story.json',
    'web/data/chapter_map_resources.json','web/data/encounters.json','web/data/items.json','web/data/forest_rewards.json',
    'web/data/config/items.json','web/data/story/shared.json','tests/helpers/guild_world.mjs','tools/create_guild_fixtures.mjs']
    .map(async name=>[name,hash(await readFile(resolve(runtime,name)))])));
  await mkdir(directory,{recursive:true});const files=[];
  for(const [index,checkpoint]of checkpoints.entries()){
    const envelope=await encodeSave(checkpoint.world),bytes=JSON.stringify(envelope)+'\n',file=`${String(index).padStart(2,'0')}_${checkpoint.name}.json`;
    await writeFile(resolve(directory,file),bytes,{flag:'wx'});
    files.push({name:checkpoint.name,file,sha256:hash(bytes),payload_sha256:envelope.sha256,location:checkpoint.world.location,
      target:targets[checkpoint.name]??null,party:checkpoint.world.party.map(({id,level})=>({id,level})),
      flags:Object.fromEntries([386,419,521,614,126].map(index=>[index,checkpoint.world.flags[index]]))});
  }
  const manifest={schema:'seventh-seal-guild-handoffs',version:1,created_at:new Date().toISOString(),
    input:{path:inputPath,sha256:hash(input)},violent,level99,scope:'从提供的合格交接档或早期source handoff执行正式源DAT/TLK/ANM；默认路线先经早期完整NPC赚侦探线索，再逐阶段传递同一world。主线与工会战斗采用规则胜利回调、媒体即时完成，材料来自真实箱子/商店/制作/原RNG奖励回放；未注入金钱、物品或任务旗标，不证明自然步行、正常成长、实战或影片播放。',
    development_growth:level99?'每个源赚取检查点再调用既有createPartySkillSample：六角色按原成长升99并授全部命名技能、选四名活动队友并保留原队长；随后恢复原CRT及已有人物计步，新人物计步为0。旗标、库存、金钱、物件事件、配方与奖励记录逐项不变，不代表自然成长。':null,
    position_handoff_scope:'--near-events只调整已赚得检查点的坐标和朝向，其他字段逐项相等；不是自然步行。',
    position_handoffs:positionHandoffs,runtime_inputs:inputs,files,trace};
  await writeFile(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{from:{type:'string'},out:{type:'string'},'near-events':{type:'boolean'},violent:{type:'boolean'},level99:{type:'boolean'}}});
  const manifest=await createGuildFixtures({...values,nearEvents:values['near-events']});
  console.log(JSON.stringify({out:resolve(values.out),files:manifest.files.length,scope:manifest.scope}));
}
