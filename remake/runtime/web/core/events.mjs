// Retained source-program validation and audit adapter. Playable content uses
// StoryFlowRunner through ChapterRunner; this adapter has no second VM loop.
import {StoryFlowRunner} from './story_flow.mjs';
import {compileEventFlow} from './story_flow_compiler.mjs';
const OPS = new Set(['say','if_flag','set_flag','add_flag','jump','end','wait','set_object',
  'test_flag_bit','test_all_flag_bits','set_flag_bit','unsupported']);
const flagIndex = index => Number.isInteger(index) && index >= 0 && index < 2000;
const flagBit = bit => Number.isInteger(bit) && bit >= 1 && bit <= 32;
export function validateProgram(event) {
  if (!event || !Array.isArray(event.program) || !event.program.length || event.program.length > 10000) throw new Error('事件程序无效');
  event.program.forEach((command, pc) => {
    if (!OPS.has(command.op)) throw new Error(`事件 ${event.id} 第${pc+1}条命令未支持：${command.op}`);
    if (!command.source || !Array.isArray(command.evidence) || !command.evidence.length) throw new Error(`事件命令${pc+1}缺少来源`);
    if (['if_flag','set_flag','add_flag'].includes(command.op) && !flagIndex(command.index)) throw new Error('事件旗标索引越界');
    if (['if_flag','set_flag','add_flag'].includes(command.op) && (!Number.isInteger(command.value)||command.value<0||command.value>0xffffffff)) throw new Error('事件旗标值无效');
    if (command.op==='if_flag' && !['eq','ne','lt','le','gt','ge'].includes(command.compare)) throw new Error('事件比较符未支持');
    if (['test_flag_bit','set_flag_bit'].includes(command.op) && (!flagIndex(command.index)||!flagBit(command.bit))) throw new Error('事件旗标位越界');
    if (command.op==='test_all_flag_bits' && (!Array.isArray(command.conditions)||command.conditions.some(c=>!flagIndex(c.index)||!flagBit(c.bit)))) throw new Error('事件组合旗标条件无效');
    if (command.op === 'say' && (typeof command.text !== 'string' || command.text.length > 2000)) throw new Error('事件对白无效');
    if (['jump','if_flag'].includes(command.op) && (!Number.isInteger(command.target) || command.target < 0 || command.target >= event.program.length)) throw new Error('事件跳转越界');
    if (['test_flag_bit','test_all_flag_bits'].includes(command.op) && [command.if_true,command.if_false].some(target=>!Number.isInteger(target)||target<0||target>=event.program.length)) throw new Error('事件条件跳转越界');
    if (command.op === 'wait' && (!Number.isInteger(command.ms) || command.ms < 0 || command.ms > 30000)) throw new Error('事件等待无效');
    if (command.op==='set_object' && (typeof command.id!=='string'||! /^[A-Za-z0-9_.:-]{1,100}$/.test(command.id)||['__proto__','constructor','prototype'].includes(command.id))) throw new Error('事件对象标识无效');
  });
  return event;
}
export class EventRunner {
  constructor({world, say, wait, log = () => {}, setPhase = () => {}}) {
    Object.assign(this, {world,say,wait,log,setPhase});this.running=false;
    this.flowRunner=new StoryFlowRunner({
      say:command=>this.say(command.speaker??'',command.text,command.style_raw??0,{source:command.source,
        ...(command.presentation?{mapId:this.activeMapId,record:command.presentation}:{})}),
      wait:command=>this.wait(command.ms)});
  }
  async run(event) {
    if (this.running) throw new Error('事件正在执行');
    validateProgram(event);
    const flow=compileEventFlow(event);this.activeMapId=event.map_id;
    this.running = true; this.setPhase('event');
    const before = this.world.snapshot(), draft = structuredClone(before);
    const immediate = event.commit_policy === 'native-entry';
    let expectedRevision = before.revision, mutationCount = 0;
    try {
      await this.flowRunner.execute(flow,{draft,
        onMutation:immediate?change=>{
          // The executor already changed the private draft; only source audits
          // request the historical native-entry writes to the real store.
          const snapshot=this.world.transact(change);expectedRevision=snapshot.revision;mutationCount++;
          this.log({type:'event-mutation',event:event.id,revision:expectedRevision,timing:'native-record-entry',
            changes:snapshot.flags.flatMap((value,index)=>value===before.flags[index]?[]:[{index,before:before.flags[index],after:value}])});
        }:null,
        check:()=>{if(this.world.value.revision!==expectedRevision)throw new Error('世界状态在事件执行期间发生变化');},
        onCommand:(command,pc)=>this.log({type:'event-command',event:event.id,pc,op:command.op,source:command.source})});
      if (this.world.value.revision !== expectedRevision) throw new Error('世界状态在事件执行期间发生变化');
      if (!immediate) {draft.revision = (before.revision + 1) >>> 0;this.world.replace(draft);}
      const changes = draft.flags.flatMap((value,index) => value === before.flags[index] ? [] : [{index,before:before.flags[index],after:value}]);
      this.log({type:'event-commit',event:event.id,changes});
      return {changes};
    } catch (error) { this.log({type:'event-failed',event:event.id,error:error.message,committed:immediate&&mutationCount>0}); throw error; }
    finally { this.running=false; this.setPhase('map'); }
  }
}
