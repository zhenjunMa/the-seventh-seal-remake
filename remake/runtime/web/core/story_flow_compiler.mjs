// Source adapters produce one runtime format; neither adapter executes events.
import {validateStoryFlow} from './story_flow.mjs';
import {NATIVE_STORY_CONDITION_TYPES,nativeConditionByte} from './native_story_conditions.mjs';
const copy=structuredClone;
const nativeFlowId=mapId=>`${mapId}:tlk`;
export {nativeFlowId};
const flagIndex=n=>Number.isInteger(n)&&n>=0&&n<2000;
export function compileTlkFlow(table,{choices}){
  const id=nativeFlowId(table.id),end=`${id}:end`,commands=[],entries={};
  const at=recordId=>recordId?`${id}:${recordId}`:end;
  for(const record of table.records){
    const entry=at(record.id),source=record.source??table.source;entries[record.id]=entry;
    let sequence=0;
    const add=(op,fields={})=>{
      const commandId=sequence===0?entry:`${entry}:${sequence}`;sequence++;
      commands.push({id:commandId,op,record_id:record.id,source:copy(source),...fields});
    };
    add('record');
    const type=record.mutation_type,bit=record.mutation_bit|0,index=record.mutation_index||table.map_flag_index;
    if(type===0&&bit){
      if(!flagIndex(index)||bit<-32||bit>32)add('unsupported',{reason:'剧情旗标变更无效'});
      else add(bit>0?'set_flag_bit':'clear_flag_bit',{index,bit:Math.abs(bit)});
    }else if(type!==0){
      const op={1:'set_native_object',2:'restore_party',4:'request_save',5:'give_item',9:'world_map_command',10:'restore_native_resources',11:'restore_native_resources',14:'learn_native_skill',16:'native_noop',17:'unlock_recipe'}[type];
      add(op??'unsupported',op?{}:{reason:`剧情变更 ${type} 尚未接入`});
    }
    if(record.condition_type!==0){
      if(NATIVE_STORY_CONDITION_TYPES.has(record.condition_type))add('test_native_condition',{
        condition_type:record.condition_type,condition_index:record.condition_index,condition_bit:record.condition_bit,
        condition_byte_raw_0b:nativeConditionByte(record),if_true:at(record.if_true),if_false:`${entry}:${sequence+1}`});
      else add('unsupported',{reason:`剧情条件 ${record.condition_type} 尚未接入`});
    }
    const testBit=record.condition_bit|0,testIndex=record.condition_index||table.map_flag_index;
    if(record.condition_type===0&&testBit){
      if(!flagIndex(testIndex)||testBit<1||testBit>32)add('unsupported',{reason:'剧情旗标条件无效'});
      else add('test_flag_bit',{index:testIndex,bit:testBit,if_true:at(record.if_true),if_false:`${entry}:${sequence+1}`});
    }
    if(record.kind===0){
      const options=record.style===1?choices(record):[];
      const presentation={speaker:record.speaker,style:record.style,portrait_id:record.portrait_id,region_byte_raw:record.region_byte_raw};
      const dialogue={text:record.text_raw,text_id:record.text_id??`${table.id}:TLK:${record.id}`,presentation};
      if(options.length)add('choice',{...dialogue,choices:options.map(row=>({...copy(row),target:at(row.recordId)}))});
      else if(record.text_raw)add('say',dialogue);
    }else if(record.kind===1)add('animation',{program_id:record.text_raw.replace(/\.anm$/i,'').toLowerCase()});
    else if(record.kind===2)add('transfer_native_map');
    else if(record.kind===5)add('native_battle');
    else add('unsupported',{reason:`对白类型 ${record.kind} 尚未接入`});
    add('jump',{target:at(record.next)});
  }
  commands.push({id:end,op:'end'});
  return validateStoryFlow({schema:'seventh-seal-story-flow',version:1,id,map_id:table.id,entry:entries[table.records[0].id],entries,commands});
}
export function compileEventFlow(event){
  const address=pc=>`${event.id}:command:${pc}`;
  const commands=event.program.map((source,pc)=>{
    const command=copy(source),objectId=command.op==='set_object'?command.id:undefined;
    command.id=address(pc);if(objectId!==undefined)command.object_id=objectId;
    for(const key of ['target','if_true','if_false'])if(command[key]!==undefined)command[key]=address(command[key]);
    if(command.op==='say')command.record_id=command.source?.record_id;
    if(command.op==='unsupported')command.reason=`事件分支尚未恢复：${command.reason??''}`;
    return command;
  });
  return validateStoryFlow({schema:'seventh-seal-story-flow',version:1,id:event.id,map_id:event.map_id,entry:address(0),commands});
}
