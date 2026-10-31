// Browser preparation only: original DAT routes and complete TLK/ANM execute
// through the production rules. These files do not prove natural walking,
// rendered combat victories or movie completion. Scripted battle callbacks
// return victory without applying damage, growth, money or drop rewards.
// --growth-only skips all replay and only grows the supplied save's party.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {WorldStore,encodeSave,decodeSave} from '../../web/core/world.mjs';
import {applyExperience,progressHeaderForRole} from '../../web/core/battle_rewards.mjs';
import {innerWhiteForestSource} from './inner_white_forest_world.mjs';
import {forestSealComplete,templeComplete,forestSwitches} from './fairy_forest_temple_world.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function prepareFairyForestHandoffs({phase,from,out,nearEvents=false,partyLevel,growthOnly=false}){
  if(growthOnly){
    assert.ok(from&&partyLevel!==undefined,'--growth-only 需要 --from 和 --party-level');
    assert.equal(nearEvents,false,'--growth-only 不允许 --near-events 改动位置');
    phase??='ff02';
  }
  if(!['ff01','ff02'].includes(phase)||!out)throw new Error('需要 --phase ff01/ff02 和 --out <新输出目录>');
  if(partyLevel!==undefined){partyLevel=Number(partyLevel);assert.ok(Number.isInteger(partyLevel)&&partyLevel>=25&&partyLevel<=99,'--party-level 需要25到99的整数');}
  const directory=resolve(out),remake=fileURLToPath(new URL('../../../',import.meta.url)),within=relative(remake,directory);
  if(within==='..'||within.startsWith(`..\\`)||within.startsWith('../')||isAbsolute(within))throw new Error('交接输出必须留在 remake 内');
  const source=await innerWhiteForestSource(),checkpoints=[];
  let world,input=null;
  if(from){
    const bytes=await readFile(resolve(from));input={path:resolve(from),sha256:hash(bytes)};
    world=new WorldStore(await decodeSave(JSON.parse(bytes),source.mapIds),source.mapIds);
  }
  let result;
  if(growthOnly){
    for(const name of ['growth_only_before','growth_only_after'])checkpoints.push({name,world:world.snapshot(),animations:0,battles:0});
    result={world,trace:{animations:[],battles:[],objects:[],media:[],transfers:[]}};
  }else{
    const replay=phase==='ff01'?forestSealComplete:templeComplete;
    result=await replay(source,{world,checkpoint:async(name,current,trace)=>{
      checkpoints.push({name,world:current.snapshot(),animations:trace.animations.length,battles:trace.battles.length});
    }});
  }
  const position_handoffs=[];
  const placeNear=(checkpoint,{x,y},provenance)=>{
    const from=checkpoint.world.location,{location,...retained}=checkpoint.world;
    const cell={x:Math.floor(x/16),y:Math.floor(y/16)},movement=source.maps[from.map_id].movement;
    const terrain=movement.terrain_rows[cell.y]?.[cell.x];
    if(provenance.source_descriptor)assert.equal(terrain,'0',`${checkpoint.name} 事件邻格必须是原DAT可通行格`);
    checkpoint.world.location={...from,x,y};
    const {location:placed,...after}=checkpoint.world;assert.deepEqual(after,retained);
    position_handoffs.push({name:checkpoint.name,from,to:placed,...provenance,
      native_grid:{cell_size:16,cell,terrain_raw:Number(terrain)},unchanged_state_sha256:hash(JSON.stringify(retained))});
  };
  if(nearEvents){
    for(const checkpoint of checkpoints.filter(row=>/^switch_\d+_before$/.test(row.name))){
      const completed=checkpoints.find(row=>row.name===checkpoint.name.replace('_before','_complete'));
      const row=forestSwitches[Number(checkpoint.name.match(/\d+/)[0])-1];
      placeNear(checkpoint,completed.world.location,{source_checkpoint:completed.name,
        source_program:{id:row.program,...source.story.programs[row.program].source}});
    }
    if(phase==='ff01'){
      const map=source.story.maps.M72050,descriptor=map.descriptors.find(row=>row.id===3),vine=map.objects.find(row=>row.index===11);
      const point={x:vine.x_native*2,y:(Math.max(...descriptor.cells.map(row=>row.y))+1)*16+8};
      for(const name of ['seal_unfinished','seal_partial','vine_before']){
        placeNear(checkpoints.find(row=>row.name===name),point,{source_descriptor:descriptor,source_object:vine.source});
      }
      const unseal=checkpoints.find(row=>row.name==='unseal_before'),warning={...structuredClone(unseal),name:'warning_before'};
      const retreat=source.story.maps['M72050-1'].descriptors.find(row=>row.id===1),xs=retreat.cells.map(row=>row.x),ys=retreat.cells.map(row=>row.y);
      placeNear(warning,{x:(Math.min(...xs)+Math.max(...xs)+1)*8,y:(Math.min(...ys)-1)*16+8},
        {source_checkpoint:unseal.name,source_descriptor:retreat});
      checkpoints.splice(checkpoints.indexOf(unseal)+1,0,warning);
    }else{
      const targets=[['ff02_start',2],...Array.from({length:5},(_,i)=>[`stair_${i+1}_before`,i===0?32:31]),['plaza_before',31]];
      for(const [name,id]of targets){
        const checkpoint=checkpoints.find(row=>row.name===name),descriptor=source.story.maps[checkpoint.world.location.map_id].descriptors.find(row=>row.id===id);
        const movement=source.maps[checkpoint.world.location.map_id].movement,occupied=new Set(movement.triggers.map(row=>`${row.x},${row.y}`));
        const xs=descriptor.cells.map(row=>row.x),ys=descriptor.cells.map(row=>row.y),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
        const candidates=descriptor.cells.filter(row=>movement.terrain_rows[row.y+1]?.[row.x]==='0'&&!occupied.has(`${row.x},${row.y+1}`));
        candidates.sort((a,b)=>(a.x-cx)**2+(a.y+1-cy)**2-((b.x-cx)**2+(b.y+1-cy)**2)||a.x-b.x);
        const trigger=candidates[0];assert.ok(trigger,`${name} 原触发区缺少可通行南邻格`);
        placeNear(checkpoint,{x:trigger.x*16+8,y:(trigger.y+1)*16+8},
          {source_descriptor:descriptor,approach:{side:'south',trigger_cell:{x:trigger.x,y:trigger.y}}});
      }
    }
  }
  const growth_grants=[];
  if(partyLevel!==undefined){
    // The shared source helper does not expose rewards. Read the same formal
    // party table as the battle controller, without granting learned skills.
    const rewards=JSON.parse(await readFile(new URL('../../web/data/party_rewards.json',import.meta.url),'utf8'));
    for(const checkpoint of checkpoints.filter(row=>!growthOnly||row.name==='growth_only_after')){
      const {party,...retained}=checkpoint.world,roles=[];
      checkpoint.world.party=party.map(initial=>{
        let role=initial,experience=0;const trace=[];
        while(role.level<partyLevel){
          const raw=progressHeaderForRole(role,rewards),view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
          const amount=Math.max(1,view.getInt32(0x2c,true)-view.getInt32(0x28,true));
          role=applyExperience(role,amount,rewards,()=>0,trace).role;experience+=amount;
        }
        assert.deepEqual(role.skill_progress,initial.skill_progress);
        roles.push({id:role.id,from:initial.level,to:role.level,experience_granted:experience,trace});return role;
      });
      const {party:grown,...after}=checkpoint.world;assert.deepEqual(after,retained);
      growth_grants.push({checkpoint:checkpoint.name,target_minimum_level:partyLevel,roles,
        unchanged_nonparty_sha256:hash(JSON.stringify(retained))});
    }
    result.world.replace(checkpoints.at(-1).world);
  }
  const runtime_inputs=Object.fromEntries(await Promise.all(['runtime_content.json','runtime_content.mjs','chapter_story.json','chapter_map_resources.json','encounters.json',
    ...(partyLevel===undefined?[]:['party_rewards.json'])].map(async name=>{
    const path=`web/data/${name}`,bytes=await readFile(new URL(`../../${path}`,import.meta.url));return [path,hash(bytes)];
  })));
  const files=[];
  // Preparation and its assertions complete before writing evidence. Historical
  // evidence names are never overwritten; use a new --out directory per run.
  await mkdir(directory,{recursive:true});
  for(const [index,checkpoint]of checkpoints.entries()){
    const envelope=await encodeSave(checkpoint.world),bytes=JSON.stringify(envelope)+'\n';
    const file=`${String(index).padStart(2,'0')}_${checkpoint.name}.json`;
    await writeFile(resolve(directory,file),bytes,{flag:'wx'});
    files.push({name:checkpoint.name,file,sha256:hash(bytes),payload_sha256:envelope.sha256,
      location:checkpoint.world.location,party:checkpoint.world.party.map(({id,level})=>({id,level})),
      money:checkpoint.world.money,flags:Object.fromEntries([96,615,388,464,465].map(index=>[index,checkpoint.world.flags[index]])),
      completed_animations:checkpoint.animations,scripted_battle_callbacks:checkpoint.battles});
  }
  const {trace}=result;
  const manifest={schema:'seventh-seal-fairy-forest-handoffs',version:1,phase,created_at:new Date().toISOString(),input,
    growth_only:growthOnly,preparation_order:growthOnly?['input-save-checkpoint','development-growth-only']:['source-rules-replay','optional-position-handoffs','optional-development-growth-grants'],
    scope:growthOnly?'仅对输入存档作development growth grant；未回放任何剧情、战斗或影片，未修改位置、旗标、库存、组合、存档RNG或技能，不代表自然训练或实战胜利。':'源规则回放和分段浏览器交接；未模拟自然步行、实战胜利或影片自然结束；battle callback victory不应用伤害、成长、金钱或掉落。',
    position_handoffs,position_handoff_scope:growthOnly?'growth-only 保留输入存档的位置与朝向；无坐标交接。':'可选近点交接仅改玩家XY坐标：六机关使用同一原ANM完成落点，事件使用原DAT触发区相邻可通行格；机关、旗标、队伍、资源、库存、方向、版本与RNG保持原检查点状态，不代表自然步行。',
    growth_grants,growth_grant_scope:'可选development growth grant仅对既有参战角色调用生产applyExperience按原阈值和成长行升级；成长随机固定独立取0，不推进存档RNG，不授予技能、物品、金钱或旗标，不代表自然训练。',
    runtime_inputs,files,trace:{animations:trace.animations,battles:trace.battles.map(({map_id,stage,members})=>({map_id,stage,members:members.map(({id})=>id)})),
      objects:trace.objects,media:trace.media??[],transfers:trace.transfers}};
  await writeFile(resolve(directory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return {world:result.world,trace,manifest};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{phase:{type:'string'},from:{type:'string'},out:{type:'string'},'near-events':{type:'boolean'},'party-level':{type:'string'},'growth-only':{type:'boolean'}}});
  const {manifest}=await prepareFairyForestHandoffs({...values,nearEvents:values['near-events'],partyLevel:values['party-level'],growthOnly:values['growth-only']});
  console.log(JSON.stringify({phase:manifest.phase,out:resolve(values.out),files:manifest.files.length,animations:manifest.trace.animations.length,
    scripted_battle_callbacks:manifest.trace.battles.length,scope:manifest.scope}));
}
