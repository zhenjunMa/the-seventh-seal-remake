// Isolated browser handoffs from the earned main/guild/tablet/trial chain.
// Battle wins and media completion remain declared rule callbacks.
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeSave} from '../web/core/world.mjs';
import {locomotion} from '../web/core/movement.mjs';
import {innerWhiteForestSource} from '../tests/helpers/inner_white_forest_world.mjs';
import {sealRegionComplete} from '../tests/helpers/seal_region_world.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function createSealRegionFixtures({out,nearEvents=false}){
  assert.ok(out,'需要 --out <remake 内新输出目录>');
  const runtime=fileURLToPath(new URL('../',import.meta.url)),remake=resolve(runtime,'..'),directory=resolve(out),within=relative(remake,directory);
  assert.ok(within&&within!=='..'&&!within.startsWith('..\\')&&!within.startsWith('../')&&!isAbsolute(within),'交接输出必须留在 remake 内新目录');
  assert.ok(!existsSync(directory),'输出目录已存在；请使用新目录，禁止覆盖旧交接或报告');
  const source=await innerWhiteForestSource(),checkpoints=[];
  const earned=await sealRegionComplete(source,{checkpoint:async(name,current)=>{
    if(name.startsWith('seal_'))checkpoints.push({name,world:current.snapshot()});
  }});
  assert.ok(checkpoints.length,'真实规则链没有产出 seal_ 检查点');
  const targets={
    seal_water_before:{kind:'npc',index:14},
    seal_moon_antidote_before:{kind:'npc',index:19},
    seal_fire_choice_before:{kind:'npc',index:15},
    seal_fire_guard_before:{kind:'npc',index:12},
    seal_region_entry:{kind:'route-to',map_id:'REBIRTH-A04'},
    seal_trial_fire_before:{kind:'trigger',index:2},
    seal_trial_fire_guardian_before:{kind:'trigger',index:3},
    seal_trial_sun_before:{kind:'trigger',index:2},
    seal_trial_sun_guardian_before:{kind:'source-object',record_id:2},
    seal_trial_water_before:{kind:'route-to',map_id:'YEARN-C01'},
    seal_trial_water_guardian_before:{kind:'trigger',index:5},
    seal_water_c02_pad_before:{kind:'object',index:8},
    seal_water_d02_pad_before:{kind:'object',index:7},
    seal_trial_earth_before:{kind:'route-to',map_id:'RUINOUSLY-A02'},
    seal_trial_earth_guardian_before:{kind:'source-object',record_id:1},
    seal_trial_moon_before:{kind:'route-to',map_id:'SILENCE-A03'},
    seal_trial_moon_guardian_before:{kind:'trigger',index:3},
    seal_wind_start:{kind:'route-to',map_id:'WING-A01-A'},
    seal_combine_before:{kind:'source-object',record_id:1},
    seal_finale_before:{kind:'trigger',index:2}
  };
  const files=[],positionHandoffs=[],occurrences=new Map();
  const scope={natural_walking:false,battle_resolution:'source-rule-victory-callback',battle_damage_simulated:false,
    scripted_battle_rewards_simulated:false,farming_rewards:'shared-native-reward-ledger',
    media_completion:'instant-rule-hook',player_saves_written:false};
  await mkdir(directory,{recursive:true});
  for(const [counter,checkpoint]of checkpoints.entries()){
    assert.match(checkpoint.name,/^seal_[a-z0-9_]+$/);
    const occurrence=(occurrences.get(checkpoint.name)??0)+1;occurrences.set(checkpoint.name,occurrence);
    const mapId=checkpoint.world.location.map_id,map=source.maps[mapId],table=source.story.maps[mapId];
    let target=targets[checkpoint.name]??null,positionHandoff=null;
    if(/^seal_wind_[abc]_guardian_before$/.test(checkpoint.name))target={kind:'trigger',index:3};
    if(/^seal_wind_[abc]_partial$/.test(checkpoint.name)){
      const sequence=checkpoint.world.native_sequence,digit=sequence.target[sequence.input_count];
      assert.match(digit,/^[1-7]$/);target={kind:'object',index:7+Number(digit),purpose:'输入原目标序列的下一个音符；未修改题目或输入进度'};
    }
    if(target?.kind==='route-to'){
      const queue=[[mapId]],seen=new Set([mapId]);let route;
      while(queue.length){
        const path=queue.shift(),last=path.at(-1);if(last===target.map_id){route=path;break;}
        for(const exit of source.maps[last].exits)if(exit.state==='ready'&&exit.target_map&&!seen.has(exit.target_map)){
          seen.add(exit.target_map);queue.push([...path,exit.target_map]);
        }
      }
      assert.ok(route?.length>1,`${checkpoint.name} 缺少至 ${target.map_id} 的源 DAT 通路`);
      const exit=map.exits.find(row=>row.state==='ready'&&row.target_map===route[1]);
      target={kind:'exit',id:exit.id,target_map:exit.target_map,planned_route:route};
    }
    if(target?.kind==='source-object'){
      const object=table.objects.find(row=>row.interaction_record_raw_f6===target.record_id);
      assert.ok(object,`${checkpoint.name} 缺少 TLK ${target.record_id} 的源交互物件`);
      target={kind:'object',index:object.index,record_id:target.record_id};
    }
    if(nearEvents&&target){
      let points,provenance;
      if(target.kind==='trigger'||target.kind==='exit'){
        const row=target.kind==='trigger'?table.descriptors.find(row=>row.id===target.index):map.exits.find(row=>row.id===target.id);
        assert.ok(row?.cells.length,`${checkpoint.name} 缺少源事件格`);
        points=row.cells.map(({x,y})=>({x:(x+.5)*16,y:(y+.5)*16}));provenance=row.source;
      }else if(target.kind==='object'){
        const object=table.objects.find(row=>row.index===target.index);assert.ok(object,`${checkpoint.name} 源物件缺失`);
        points=[{x:object.x_native*2,y:object.y_native*2}];provenance=object.source;
      }else{
        const npc=source.resources.npcs_by_map[mapId].find(row=>row.slot_zero_based===target.index);
        assert.ok(npc,`${checkpoint.name} 源人物缺失`);points=[{x:npc.x,y:npc.y}];provenance=npc.source;
      }
      const candidates=[],triggerCells=new Set(map.movement.triggers.map(({x,y})=>`${x},${y}`));
      for(let y=0;y<map.movement.height;y++)for(let x=0;x<map.movement.width;x++){
        if(map.movement.terrain_rows[y][x]!=='0'||triggerCells.has(`${x},${y}`))continue;
        const px=(x+.5)*16,py=(y+.5)*16;
        for(const point of points){
          const distance=Math.hypot(px-point.x,py-point.y),isGate=target.kind==='trigger'||target.kind==='exit';
          if(isGate?Math.abs(px-point.x)+Math.abs(py-point.y)!==16:distance<20||distance>=48)continue;
          candidates.push({x:px,y:py,point,distance});
        }
      }
      candidates.sort((a,b)=>a.distance-b.distance||b.y-a.y||a.x-b.x);const at=candidates[0];
      assert.ok(at,`${checkpoint.name} 缺少原 terrain0 且无 trigger 的邻格`);
      const {location:before,...retained}=checkpoint.world;
      checkpoint.world.location={map_id:mapId,x:at.x,y:at.y,
        direction:locomotion({dx:Math.sign(at.point.x-at.x),dy:Math.sign(at.point.y-at.y)},false).direction};
      const {location:after,...restored}=checkpoint.world;assert.deepEqual(restored,retained);
      positionHandoff={counter,name:checkpoint.name,occurrence,from:before,to:after,target,source:provenance,
        terrain_raw:'0',trigger_present:false,unchanged_nonlocation_sha256:hash(JSON.stringify(retained))};
      positionHandoffs.push(positionHandoff);
    }
    const envelope=await encodeSave(checkpoint.world),bytes=JSON.stringify(envelope)+'\n',file=`${String(counter).padStart(3,'0')}_${checkpoint.name}.json`;
    await writeFile(resolve(directory,file),bytes,{flag:'wx'});
    files.push({counter,name:checkpoint.name,occurrence,file,sha256:hash(bytes),payload_sha256:envelope.sha256,
      location:checkpoint.world.location,target,source_map:table.map_source,position_handoff:positionHandoff,
      validation_scope:{...scope,position_adjustment:positionHandoff?'location-only':'none',
        limitation:'开发交接检查点；没有自然步行、实战伤害或媒体自然结束的证明。'},
      party:checkpoint.world.party.map(({id,level})=>({id,level})),
      items:[9,290,291,292,293,294,299,300,301,302,303,304,387,135].map(id=>({id,quantity:checkpoint.world.inventory.filter(row=>row.id===id).reduce((n,row)=>n+row.quantity,0)}))});
  }
  const inputPaths=['web/data/runtime_content.json','web/data/runtime_content.mjs','web/data/chapter_story.json',
    'web/data/chapter_map_resources.json','web/data/encounters.json','web/data/world_map.json','web/data/story/shared.json',
    'web/data/items.json','web/data/config/items.json','web/data/config/index.json','web/data/party_rewards.json',
    'web/data/party_skills.json','web/data/party_combat.json','web/data/opening_seed.json',
    'web/core/chapter.mjs','web/core/story_flow.mjs','web/core/story_flow_compiler.mjs','web/core/native_story_conditions.mjs',
    'web/core/native_story_mutations.mjs','web/core/native_map_chests.mjs','web/core/map_stage.mjs','web/core/movement.mjs',
    'web/core/world.mjs','web/core/battle_rewards.mjs','web/core/native_economy.mjs',
    'tests/helpers/inner_white_forest_world.mjs','tests/helpers/inner_white_forest_seal_world.mjs',
    'tests/helpers/floating_city_world.mjs','tests/helpers/yc05_jl03_world.mjs','tests/helpers/floating_city_pc02_world.mjs',
    'tests/helpers/fairy_forest_temple_world.mjs','tests/helpers/wind_region_world.mjs','tests/helpers/guild_world.mjs',
    'tests/helpers/seal_tablets_world.mjs','tests/helpers/seal_wind_world.mjs','tests/helpers/seal_region_world.mjs',
    'tools/create_seal_region_fixtures.mjs'];
  const runtimeInputs=Object.fromEntries(await Promise.all(inputPaths.map(async path=>[path,hash(await readFile(resolve(runtime,path)))])));
  const retainedSources={...source.story.source_hashes,...source.resources.source_hashes,...source.items.source_hashes};
  const runtimeInputSetSha256=hash(JSON.stringify(runtimeInputs)),retainedSourceSetSha256=hash(JSON.stringify(retainedSources));
  for(const file of files){file.runtime_input_set_sha256=runtimeInputSetSha256;file.retained_original_source_set_sha256=retainedSourceSetSha256;}
  const {trace}=earned;
  const manifest={schema:'seventh-seal-seal-region-handoffs',version:1,created_at:new Date().toISOString(),
    scope:'从正式新游戏来源及既有完整主线/工会规则链赚取六石版，再完成遗迹六试炼、合成与最终三战。仅导出 seal_ 检查点；没有注入旗标、物品、金钱、题目或先前历史。',
    validation_scope:{...scope,limitation:'剧情战仅提供胜利回调，不模拟伤害或战斗经验；仅显式材料刷怪应用共用奖励台账。TLK奖励实际执行，媒体即时完成。开发交接不代表自然贯通或浏览器实玩验收。'},
    near_events:nearEvents,position_handoff_scope:'仅调整玩家 location 的地图内坐标和朝向到具体源交互的原 terrain0、无 trigger 邻格；其余字段逐项相等。未修改玩家存档目录。',
    duplicate_checkpoint_policy:'同名检查点全部保留，以 counter 文件前缀和 occurrence 区分，不按名称覆盖。',
    game_sha256:hash(await readFile(resolve(remake,'../GAME.exe'))),runtime_inputs:runtimeInputs,runtime_input_set_sha256:runtimeInputSetSha256,
    retained_original_source_hashes:retainedSources,position_handoffs:positionHandoffs,files,
    trace:{seal_tablets:trace.seal,seal_region:trace.seal_region,
      animations:trace.animations,battles:trace.battles.map(row=>({map_id:row.map_id,stage:row.stage,enemies:row.members.map(member=>member.id)})),
      routes:trace.routes,objects:trace.objects,transfers:trace.transfers}};
  await writeFile(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{out:{type:'string'},'near-events':{type:'boolean'}}});
  const manifest=await createSealRegionFixtures({out:values.out,nearEvents:values['near-events']});
  console.log(JSON.stringify({out:resolve(values.out),files:manifest.files.length,position_handoffs:manifest.position_handoffs.length,
    scripted_battle_callbacks:manifest.trace.battles.length,scope:manifest.scope}));
}
