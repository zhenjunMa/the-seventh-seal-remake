// All playable dialogue and event sources compile to this command graph.
// The executor owns control flow; WorldStore transactions and game effects
// are supplied by the caller, never selected by a region or source format.
const need=(ok,message)=>{if(!ok)throw new Error(`剧情流程：${message}`);};
const flagIndex=n=>Number.isInteger(n)&&n>=0&&n<2000;
const flagBit=n=>Number.isInteger(n)&&n>=1&&n<=32;
const OPS=new Set(['record','say','choice','if_flag','test_flag_bit','test_all_flag_bits',
  'set_flag','add_flag','set_flag_bit','clear_flag_bit','set_object','jump','end','wait',
  'animation','give_item','restore_party','request_save','set_native_object','test_native_condition','test_native_combination','change_native_money','native_service',
  'learn_native_skill','native_noop','unlock_recipe','world_map_command','transfer_native_map','native_battle','restore_native_resources','unsupported']);
export function validateStoryFlow(flow){
  need(flow?.schema==='seventh-seal-story-flow'&&flow.version===1&&typeof flow.id==='string'
    &&Array.isArray(flow.commands)&&flow.commands.length>0&&flow.commands.length<=50000,'版本或命令表无效');
  const ids=new Set();
  for(const command of flow.commands){
    need(typeof command.id==='string'&&command.id.length>0&&!ids.has(command.id)&&OPS.has(command.op),'命令编号重复或操作未支持');ids.add(command.id);
    if(['if_flag','set_flag','add_flag'].includes(command.op))need(flagIndex(command.index)&&Number.isInteger(command.value)&&command.value>=0&&command.value<=0xffffffff,'旗标值无效');
    if(command.op==='if_flag')need(['eq','ne','lt','le','gt','ge'].includes(command.compare),'比较符无效');
    if(['test_flag_bit','set_flag_bit','clear_flag_bit'].includes(command.op))need(flagIndex(command.index)&&flagBit(command.bit),'旗标位无效');
    if(command.op==='test_all_flag_bits')need(Array.isArray(command.conditions)&&command.conditions.every(row=>flagIndex(row.index)&&flagBit(row.bit)),'组合旗标条件无效');
    if(['say','choice'].includes(command.op))need(typeof command.text==='string','对白文本缺失');
    if(command.op==='choice')need(Array.isArray(command.choices)&&command.choices.length>0&&command.choices.length<=3
      &&new Set(command.choices.map(row=>row.index)).size===command.choices.length
      &&command.choices.every(row=>Number.isInteger(row.index)&&row.index>=0&&row.index<3&&typeof row.text==='string'),'选择无效');
    if(command.op==='wait')need(Number.isInteger(command.ms)&&command.ms>=0&&command.ms<=30000,'等待时长无效');
    if(command.op==='set_object')need(typeof command.object_id==='string'&&/^[A-Za-z0-9_.:-]{1,100}$/.test(command.object_id)&&!['__proto__','constructor','prototype'].includes(command.object_id),'物件编号无效');
    if(command.op==='record')need(Number.isInteger(command.record_id)&&command.record_id>0,'原记录编号无效');
  }
  need(ids.has(flow.entry),'入口缺失');
  for(const target of Object.values(flow.entries??{}))need(ids.has(target),'记录入口缺失');
  for(const command of flow.commands){
    const targets=command.op==='jump'||command.op==='if_flag'?[command.target]
      :['test_flag_bit','test_all_flag_bits','test_native_condition','test_native_combination'].includes(command.op)?[command.if_true,command.if_false]
      :command.op==='choice'?command.choices.map(row=>row.target):[];
    for(const target of targets)need(ids.has(target),`${command.id} 跳转 ${target} 缺失`);
  }
  return flow;
}
export function hydrateStoryFlow(source,texts){
  const flow=structuredClone(source);
  const text=id=>{need(typeof texts[id]==='string',`文本 ${id} 缺失`);return texts[id];};
  for(const command of flow.commands){
    if(command.text_id!==undefined)command.text=text(command.text_id);
    for(const choice of command.choices??[])if(choice.text_id!==undefined)choice.text=text(choice.text_id);
  }
  return validateStoryFlow(flow);
}
const bitSet=(draft,index,bit)=>Boolean(draft.flags[index]&(1<<(bit-1)));
function compare(actual,command){
  switch(command.compare){
    case 'eq':return actual===command.value;
    case 'ne':return actual!==command.value;
    case 'lt':return actual<command.value;
    case 'le':return actual<=command.value;
    case 'gt':return actual>command.value;
    case 'ge':return actual>=command.value;
  }
}
export class StoryFlowRunner {
  constructor(handlers={}){this.handlers=handlers;}
  async execute(flow,{draft,entry=flow.entry,context={steps:0},onMutation=null,check=()=>{},onCommand=()=>{},playback=context.playback}){
    validateStoryFlow(flow);
    const positions=new Map(flow.commands.map((command,index)=>[command.id,index]));
    const traversed=[],dialogueIds=[];
    const execution={mapId:flow.map_id,flowId:flow.id,draft,context};
    const mutate=change=>{change(draft);onMutation?.(change);};
    const call=async(name,command)=>{
      need(typeof this.handlers[name]==='function',`${name} 显示或行为接口缺失`);
      return this.handlers[name](command,execution);
    };
    let pc=positions.get(entry),steps=0;
    need(pc!==undefined,'执行入口缺失');
    while(pc<flow.commands.length){
      need(++steps<=10000,'执行超过步数上限');
      if(playback?.paused)await playback.ready();
      playback?.check();check();
      const command=flow.commands[pc];onCommand(command,pc);
      switch(command.op){
        case 'record':
          need(++context.steps<=1000,'原剧情超过执行步数');traversed.push(command.record_id);
          need(typeof this.handlers.record==='function','原记录接口缺失');this.handlers.record(command,execution);break;
        case 'say':await call('say',command);if(command.record_id!==undefined)dialogueIds.push(command.record_id);break;
        case 'choice':{
          const selected=await call('choice',command),choice=command.choices.find(row=>row.index===selected);
          need(choice,'剧情选择结果无效');dialogueIds.push(command.record_id);pc=positions.get(choice.target);continue;
        }
        case 'if_flag':if(compare(draft.flags[command.index],command)){pc=positions.get(command.target);continue;}break;
        case 'test_flag_bit':pc=positions.get(bitSet(draft,command.index,command.bit)?command.if_true:command.if_false);continue;
        case 'test_all_flag_bits':pc=positions.get(command.conditions.every(row=>bitSet(draft,row.index,row.bit))?command.if_true:command.if_false);continue;
        case 'test_native_condition':case 'test_native_combination':pc=positions.get(await call(command.op,command)?command.if_true:command.if_false);continue;
        case 'set_flag':mutate(next=>{next.flags[command.index]=command.value;});break;
        case 'add_flag':mutate(next=>{next.flags[command.index]=(next.flags[command.index]+command.value)>>>0;});break;
        case 'set_flag_bit':mutate(next=>{next.flags[command.index]=(next.flags[command.index]|(1<<(command.bit-1)))>>>0;});break;
        case 'clear_flag_bit':mutate(next=>{next.flags[command.index]=(next.flags[command.index]&~(1<<(command.bit-1)))>>>0;});break;
        case 'set_object':mutate(next=>{next.object_states[command.object_id]={...next.object_states[command.object_id],...command.state};});break;
        case 'jump':pc=positions.get(command.target);continue;
        case 'unsupported':throw new Error(command.reason??'剧情分支尚未恢复');
        case 'end':return {traversed,dialogueIds};
        default:await call(command.op,command);break;
      }
      pc++;
    }
    throw new Error('剧情流程缺少结束命令');
  }
}
