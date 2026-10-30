// Direct CF4 chests: 410850 rebuilds +48 as a selection-queue ordinal;
// 411F50 checks +F2 through 47B0C0, and 447DE0 reads ten reward IDs at +54.
// The reward is dispatched by 468B30 only when 4137C0 reaches state3.
import {evaluateNativeStoryCondition} from './native_story_conditions.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`原地图宝箱：${message}`);};
function sourceBytes(hex,count,label){
  need(typeof hex==='string'&&new RegExp(`^(?:[0-9a-f]{2}){${count}}$`,'i').test(hex),`${label}来源无效`);
  const raw=Uint8Array.from(hex.match(/../g),part=>parseInt(part,16));
  return {raw,view:new DataView(raw.buffer)};
}
export function nativeScriptedChest(object){
  const {raw,view}=sourceBytes(object?.raw_hex,0x112,'物件');
  const behavior=raw[0xcf],recordId=view.getUint32(0xf6,true);
  need([3,4].includes(behavior)&&recordId>0&&raw[0x109]===0,'脚本箱来源或状态类型无效');
  if(behavior===4)need(raw[0x51]===0&&view.getUint32(0x4c,true)===0
    &&view.getUint32(0xe3,true)===0&&view.getUint32(0xe7,true)===0
    &&Array.from({length:10},(_,slot)=>view.getInt32(0x54+slot*4,true)).every(id=>id===0),
  '脚本箱直接奖励或物件联动尚未接入');
  // 4137C0 dispatches a nonzero +F6 before checking the CF4 +F2 key.
  return {behavior,recordId};
}
export function nativeKeyedChest(object){
  const {raw,view}=sourceBytes(object?.raw_hex,0x112,'物件');
  need(raw[0xcf]===4&&view.getUint32(0xf6,true)===0&&raw[0x109]===0,'仅接入原地 CF4 直接奖励箱');
  // BA is an optional denial TLK and +53 chooses another possession mode.
  // Linked objects/spawns need their own recovered adapter before admission.
  need(raw[0x53]===0&&view.getUint32(0xba,true)===0
    &&view.getUint32(0x4c,true)===0&&raw[0x51]===0
    &&view.getUint32(0xe3,true)===0&&view.getUint32(0xe7,true)===0,
  '钥匙模式、拒绝剧情或物件联动尚未接入');
  // 411A50 reads the +52 direction mask only when +51 enables a spawn.
  const keyId=view.getUint32(0xf2,true),rewards=[];
  need(keyId>=0&&keyId<=416,'钥匙编号无效');
  for(let slot=0;slot<10;slot++){
    const id=view.getInt32(0x54+slot*4,true);
    need(id>=0&&id<=416,'金币或特殊掉落尚未接入');
    if(id)rewards.push({slot,id});
  }
  need(rewards.length>0,'直接奖励来源缺失');
  return {keyId,rewards};
}
export function canOpenNativeChest(world,chest){
  // Mode0 compares IDs across inventory and all retained native equipment;
  // it neither consumes the key nor requires it on the controlled actor.
  // 411F7F bypasses 47B0C0 when +F2 is zero; 412136 returns success.
  return chest.keyId===0||evaluateNativeStoryCondition({condition_type:4,condition_index:0xffffffff,condition_bit:chest.keyId},world);
}
export function nativeChestAnimation(resource,behavior){
  need([3,4].includes(behavior),'动画行为尚未接入');
  if(behavior===4){
    const firstAction=resource.actions.find(row=>row.index===0);
    const {raw}=sourceBytes(firstAction?.raw_hex??firstAction?.source_action_raw_hex,0xac,'首动作');
    // 4137C0 reads action0+7F before selecting the collection action. A
    // nonzero value requires actor D5=10 / 46F370, not direct collection.
    need(raw[0x7f]===0,'首动作所需人物攻击尚未接入');
  }
  const index=behavior===4&&resource.actions.length>=2?1:0;
  const action=resource.actions.find(row=>row.index===index);
  need(action,'开箱动作缺失');
  const {raw,view}=sourceBytes(action.raw_hex??action.source_action_raw_hex,0xac,'动作');
  const count=view.getUint32((raw[13]&15)===0?0x12:0x0e,true),first=view.getUint32(0x72,true);
  need(count>=1&&count<=255&&((raw[13]&15)!==0||count<=20),'开箱动作帧数无效');
  const frameIndices=Array.from({length:count},(_,i)=>first+((raw[13]&15)===0?raw[0x16+i]:i));
  need(raw[0]===0&&raw[0x7f]===0&&action.interval_raw>0&&action.interval_raw===view.getUint32(1,true)
    &&frameIndices.every(frame=>frame>=resource.frames.length||resource.frames.some(row=>row.index===frame)),
  '开箱帧序列、人物动作或时钟模式尚未接入');
  // 52AF12 rejects a physical frame outside the DGP pool without drawing.
  // Preserve that logical frame and its wait; do not clamp it to the last image.
  return {action,frameIndices};
}
