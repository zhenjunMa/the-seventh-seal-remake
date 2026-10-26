// Map-loader TLK (+0x8A) projects source NPC layouts on every load, including
// save previews. It uses the shared StoryFlow executor and never commits world
// progress or plays arrival dialogue (+0x13A).
import {StoryFlowRunner} from './story_flow.mjs';
import {nativeFlowId} from './story_flow_compiler.mjs';
import {validateChapterSetupAnimation} from './chapter_animation.mjs';
import {storyBindings,runtimeContent} from './content_registry.mjs';

const need=(ok,message)=>{if(!ok)throw new Error(`地图布置：${message}`);};
const PURE_COMMANDS=new Set(['record','test_flag_bit','jump','end','animation']);

export async function projectMapStage({mapId,world,story,npcs,roles,content=runtimeContent}){
  const result=structuredClone(npcs),binding=storyBindings(mapId,content);
  if(!binding.setup_record)return result;
  const table=story.maps[mapId],flow=story.flows?.[nativeFlowId(mapId)];
  need(table?.header_setup_tlk_raw===binding.setup_record&&flow?.entries?.[binding.setup_record],`${mapId} 缺少原加载入口`);
  const bySlot=new Map(result.map(npc=>[npc.slot_zero_based,npc]));
  const runner=new StoryFlowRunner({
    record(command){
      const row=table.records.find(row=>row.id===command.record_id);
      need(row&&row.condition_type===0&&row.mutation_type===0&&row.mutation_bit===0,`${mapId}:${command.record_id} 加载入口不是纯布局`);
    },
    animation(command){
      const program=story.programs[command.program_id];
      need(program,`布局演出 ${command.program_id} 未准备`);
      validateChapterSetupAnimation(program,mapId,content);
      for(const c of program.commands){
        if(c.opcode!==35)continue;
        // Party placement in the source loader is transient: saved/selected
        // player location remains authoritative. NPC instances are projected.
        if(c.u32_plus5<10)continue;
        const npc=bySlot.get(c.u32_plus5);need(npc,`布局人物槽 ${c.u32_plus5} 缺失`);
        if(c.u32_plus1){npc.hidden=true;continue;}
        const role=roles[npc.resource_id],flat=Math.max(0,c.u32_plus25-1);
        const action=role?.actions.find(a=>flat>=a.first_frame&&flat<a.first_frame+a.frame_count*a.directions);
        need(action,`布局人物槽 ${c.u32_plus5} 姿态 ${c.u32_plus25} 未恢复`);
        const relative=flat-action.first_frame;
        Object.assign(npc,{hidden:false,x:(c.u32_plus13|0)*2,y:(c.u32_plus17|0)*2,
          direction:Math.floor(relative/action.frame_count),stage_action:action.index,stage_frame:relative%action.frame_count});
      }
    }
  });
  await runner.execute(flow,{entry:flow.entries[binding.setup_record],draft:structuredClone(world),
    onCommand(command){need(PURE_COMMANDS.has(command.op),`加载入口不能执行 ${command.op}`);}});
  return result;
}
