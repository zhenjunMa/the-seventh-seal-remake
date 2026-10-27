// Rule fixtures use checked-in source tables and production party/story APIs.
// This is an explicit development handoff, not a natural full-game playthrough.
import {readFile} from 'node:fs/promises';
import {WorldStore} from '../../web/core/world.mjs';
import {ChapterRunner} from '../../web/core/chapter.mjs';
import {ChapterAnimationRunner} from '../../web/core/chapter_animation.mjs';
import {admitPartyMember,deactivatePartyMember,controlPartyActor} from '../../web/core/party_members.mjs';
import {runtimeContent} from '../../web/core/content_registry.mjs';
import {worldMapEntry} from '../../web/core/map_connections.mjs';

const read=async name=>JSON.parse(await readFile(new URL(`../../web/data/${name}.json`,import.meta.url),'utf8'));
const [story,seed,worldMap]=await Promise.all(['chapter_story','opening_seed','world_map'].map(read));

export function headlessRunner(world){
  const trace={animations:[],transfers:[]};
  const runner=new ChapterRunner({world,data:story,content:runtimeContent,
    say:async()=>{},choose:async({choices})=>choices[0].index,wait:async()=>{},
    worldMapState:()=>({areas:worldMap.areas.map(({id,selected_index,statuses})=>({id,selected_index,statuses:[...statuses]}))}),
    transfer:async({destination})=>{
      const location=worldMapEntry({},destination,story);trace.transfers.push(location);return {location};
    },
    animate:async({program,runTlk,joinActor,leaveActor,flagCommand,draft})=>{
      const result=await new ChapterAnimationRunner({program,content:runtimeContent,runTlk,joinActor,leaveActor,flagCommand,
        initialLocation:draft.location,
        hooks:Object.fromEntries(['map','actor','move','camera','wait','fade','sound','media'].map(key=>[key,async()=>{}]))}).run();
      // Facing belongs to OpeningView. This rules-only fixture retains its
      // incoming facing and makes no presentation/pose claim.
      draft.location={...result.location,direction:draft.location.direction};
      trace.animations.push({id:program.id,commands:result.commands});
    }});
  return {runner,trace};
}

export async function fireValleyPartyFixture(){
  const draft=structuredClone(seed);draft.opening.status='complete';
  draft.location={map_id:'M03039',x:616,y:728,direction:0};
  // The incoming source ANM adds 001/005 and removes 004. Prepare its external
  // party handoff through the same APIs, keeping original role/gear records.
  for(const id of ['003','004'])admitPartyMember(draft,id,{definitions:story.role_definitions});
  controlPartyActor(draft,'003');deactivatePartyMember(draft,'001');
  const world=new WorldStore(draft),before_incoming=world.snapshot();
  const {runner,trace}=headlessRunner(world);
  // Execute the admitted source ANM caller; no historical generator/report.
  await runner.runTlk({mapId:'M03039',recordId:13,context:{explicitInteraction:true,steps:0}});
  return {worlds:{before_incoming,after_incoming:world.snapshot()},trace};
}
