// Native 473E30 case0x14, using the same transaction draft as its TLK caller.
// ANM jump operands are one-based command numbers, never TLK record IDs.
const need=(ok,message)=>{if(!ok)throw new Error(`剧情动画旗标：${message}`);};
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
