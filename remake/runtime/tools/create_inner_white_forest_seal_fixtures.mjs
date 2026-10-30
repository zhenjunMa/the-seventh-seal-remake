// YC-04 browser handoffs. Source rules earn state; only approach positions and
// the separately labelled battle-growth sample are changed for UI observation.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {encodeSave} from '../web/core/world.mjs';
import {applyExperience,progressHeaderForRole} from '../web/core/battle_rewards.mjs';
import {innerWhiteForestSource} from '../tests/helpers/inner_white_forest_world.mjs';
import {innerWhiteForestSealComplete} from '../tests/helpers/inner_white_forest_seal_world.mjs';

const runtime=new URL('../',import.meta.url),folder=new URL('evidence/inner_white_forest_20261030_yc04/browser_saves/',runtime);
const source=await innerWhiteForestSource(),checkpoints=new Map();
await innerWhiteForestSealComplete(source,{checkpoint:async(name,world)=>checkpoints.set(name,world.snapshot())});
const entries=[
  ['01','tabas_first_visit_before','trigger',3],
  ['02','tabas_artifact_advice_before','npc',10],
  ['03','artifact_295_before','object',19],
  ['04','artifact_295_after','trigger',1],
  ['05','artifact_296_before','object',19],
  ['06','artifact_296_after','trigger',1],
  ['07','artifact_297_before','object',19],
  ['08','artifact_297_after','trigger',1],
  ['09','seal_hint_before','object',23],
  ['10','synthesis_before','npc',11],
  ['11','seal_before','object',23],
  ['12','tabas_seal_revisit_before','npc',10],
  ['13','seal_before','object',23,40],
];
const manifest={schema:'seventh-seal-inner-white-forest-seal-browser-fixtures',version:1,
  kind:'生产 TLK/ANM/DAT 规则回放后的分段开发交接',
  boundaries:['规则战斗结果为有界胜利回调，不证明自然连续实玩。','浏览器单独运行真实 Phaser、剧情演出及战斗。',
    '仅修改交互附近的可走无触发格；slot13另通过正式经验成长升至40级，成长随机为0。','不写 remake/saves；不覆盖旧证据或 slot00 的旧浏览器朱特结束档。',
    'slot00旧证据缺少48/51原前置，仅归档，不用于返城或本轮入口验收。'],fixtures:[]};
await mkdir(folder,{recursive:true});
for(const [slot,name,kind,index,level]of entries){
  const world=structuredClone(checkpoints.get(name)),before=structuredClone(world.location),mapId=world.location.map_id,map=source.maps[mapId];
  let targets;
  if(kind==='trigger')targets=map.movement.triggers.filter(row=>row.id===index).map(({x,y})=>({x:(x+.5)*16,y:(y+.5)*16}));
  else if(kind==='npc')targets=source.resources.npcs_by_map[mapId].filter(row=>row.slot_zero_based===index);
  else targets=source.story.maps[mapId].objects.filter(row=>row.index===index).map(row=>({x:row.x_native*2,y:row.y_native*2}));
  if(!targets.length)throw new Error(`${name}: missing ${kind} ${index}`);
  const candidates=[];
  for(let y=0;y<map.movement.height;y++)for(let x=0;x<map.movement.width;x++){
    if(map.movement.terrain_rows[y][x]!=='0'||map.movement.triggers.some(row=>row.x===x&&row.y===y))continue;
    const px=(x+.5)*16,py=(y+.5)*16;
    for(const target of targets){
      const distance=Math.hypot(px-target.x,py-target.y);
      if(kind==='trigger'?(Math.abs(px-target.x)+Math.abs(py-target.y)!==16):(distance<20||distance>=48))continue;
      candidates.push({x:px,y:py,target,distance});
    }
  }
  candidates.sort((a,b)=>a.distance-b.distance||b.y-a.y||a.x-b.x);
  const at=candidates[0];if(!at)throw new Error(`${name}: no passable approach`);
  const dx=at.target.x-at.x,dy=at.target.y-at.y,direction=Math.abs(dx)>Math.abs(dy)?dx>0?1:3:dy>0?0:2;
  world.location={map_id:mapId,x:at.x,y:at.y,direction};delete world.map_npc_state;
  let growth;
  if(level){
    const rewards=JSON.parse(await readFile(new URL('web/data/party_rewards.json',runtime),'utf8'));growth=[];
    for(let i=0;i<world.party.length;i++){
      let role=world.party[i];const trace=[],from=role.level;
      while(role.level<level){const bytes=progressHeaderForRole(role,rewards),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
        role=applyExperience(role,Math.max(1,view.getInt32(0x2c,true)-view.getInt32(0x28,true)),rewards,()=>0,trace).role;}
      world.party[i]=role;growth.push({id:role.id,from,to:role.level,trace});
    }
  }
  const envelope=await encodeSave(world),file=`SaveGame${slot}.json`;
  await writeFile(new URL(file,folder),JSON.stringify(envelope,null,2)+'\n');
  await writeFile(new URL(`source_${name}.json`,folder),JSON.stringify(checkpoints.get(name),null,2)+'\n');
  manifest.fixtures.push({slot,file,checkpoint:name,target:{kind,index},source_location:before,approach:world.location,
    next_action:kind==='trigger'?['Down','Right','Up','Left'][direction]:'Space',payload_sha256:envelope.sha256,...(growth?{growth}:{})});
}
manifest.source_sha256=Object.fromEntries(await Promise.all(['web/data/chapter_story.json','web/data/chapter_map_resources.json','web/data/runtime_content.json','web/data/party_rewards.json',
  'tests/helpers/inner_white_forest_world.mjs','tests/helpers/inner_white_forest_seal_world.mjs'].map(async path=>[path,createHash('sha256').update(await readFile(new URL(path,runtime))).digest('hex')])));
await writeFile(new URL('yc04_manifest.json',folder),JSON.stringify(manifest,null,2)+'\n');
console.log(`已生成 ${entries.length} 个 YC-04 分段浏览器交接档；玩家存档未写入。`);
