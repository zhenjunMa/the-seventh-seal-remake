// Shared source-backed fixtures; mutable worlds remain private to each case.
import {readFile} from 'node:fs/promises';
import {ChapterRunner} from '../../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../../web/core/chapter_animation.mjs';
import {WorldStore} from '../../web/core/world.mjs';
import {runtimeContent} from '../../web/core/content_registry.mjs';
const read=async file=>JSON.parse(await readFile(new URL(file,new URL('../',import.meta.url)),'utf8'));
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


export {read,story,maps,regional,world,runner};
