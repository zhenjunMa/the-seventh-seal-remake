// Native 473E30 case0x14, using the same transaction draft as its TLK caller.
// ANM jump operands are one-based command numbers, never TLK record IDs.
const need=(ok,message)=>{if(!ok)throw new Error(`剧情动画旗标：${message}`);};
// Source 473E30 case12 -> 40C5C0. This phase admits source CF7 objects
// without rewards, spawns, proximity dispatch or closing TLK side effects.
export function nativeAnmObjectTarget(command,mapId,story){
  const active=story.maps[mapId],mapFlag=command.u32_plus5||active.map_flag_index;
  if(!command.u32_plus25)return null;
  const table=mapFlag===active.map_flag_index?active:Object.values(story.maps).find(table=>table.map_flag_index===mapFlag);
  need(table,'物件目标地图来源缺失');
  const objectIndex=command.u32_plus25-1,object=table.objects.find(row=>row.index===objectIndex);
  need(object,'物件来源缺失');
  if(table.id===mapId){
    const raw=Uint8Array.from(object.raw_hex.match(/../g),value=>parseInt(value,16)),view=new DataView(raw.buffer);
    need(raw[0xcf]===7&&raw[0x109]===0&&raw[0x51]===0&&view.getUint32(0x4c,true)===0
      &&view.getUint32(0xba,true)===0&&view.getUint32(0xf6,true)===0
      &&view.getUint32(0xe3,true)===0&&view.getUint32(0xe7,true)===0
      &&Array.from({length:10},(_,slot)=>view.getUint32(0x54+slot*4,true)).every(id=>id===0),'物件联动或主动类型尚未恢复');
  }
  return {mapId:table.id,mapFlag,objectIndex,enabled:command.byte_plus29===0};
}
export function applyNativeAnmFlagCommand(draft,command,mapFlagIndex){
  need(command?.opcode===20&&Array.isArray(draft?.flags),'命令或世界状态无效');
  const index=command.u32_plus5||mapFlagIndex,bit=command.u32_plus25,mode=command.byte_plus29;
  need(Number.isInteger(index)&&index>=0&&index<draft.flags.length,'索引无效');
  need(Number.isInteger(bit)&&bit>=0&&bit<=32&&Number.isInteger(mode)&&mode>=0&&mode<=255,'位或模式无效');
  if(index===0)return {nextIndex:null};
  if(mode===0||mode===1){
    if(bit){const mask=2**(bit-1);draft.flags[index]=(mode===0?draft.flags[index]|mask:draft.flags[index]&~mask)>>>0;}
    return {nextIndex:null};
  }
  const target=bit===0||Boolean(draft.flags[index]&2**(bit-1))?command.u32_plus13:command.u32_plus17;
  need(Number.isInteger(target)&&target>=0,'分支目标无效');
  // A zero conditional target falls through. Native bit0 explicitly jumps;
  // malformed zero bit0 targets are rejected instead of reading ANM[-1].
  if(bit===0)need(target>0,'无条件跳转缺少目标');
  return {nextIndex:target?target-1:null};
}
