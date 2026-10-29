// GAME 4621D0: six packed 11-byte predicates at TLK +37, in order.
// Byte +6 belongs to the native record but is not read by these branches.
import {evaluateNativeStoryCondition,validateNativeStoryCondition} from './native_story_conditions.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`原组合条件：${message}`);};
export const NATIVE_COMBINATION_EVIDENCE='ev_d195721514131b053b486b0eeeadf9baa29bc5df621e93beeaf0f2d6f05ea2b2';
export function nativeCombinationHex(record){
  need(record?.kind===4,'对白类型无效');
  let value=record.native_combination_hex;
  if(record.raw_hex!==undefined){
    need(typeof record.raw_hex==='string'&&/^[0-9a-f]{3294}$/i.test(record.raw_hex),'TLK 来源记录无效');
    const raw=record.raw_hex.slice(0x37*2,(0x37+66)*2);
    need(value===undefined||value===raw,'条件表与来源不同');value=raw;
  }
  need(typeof value==='string'&&/^[0-9a-f]{132}$/i.test(value),'缺少六项原条件表');
  return value;
}
export function nativeCombinationConditions(record,table){
  const b=Uint8Array.from(nativeCombinationHex(record).match(/../g),part=>parseInt(part,16)),v=new DataView(b.buffer);
  return Array.from({length:6},(_,i)=>{
    const at=i*11,type=b[at],index=v.getUint32(at+2,true),bit=v.getUint32(at+7,true);
    const row={condition_type:type,condition_byte_raw_0b:b[at+1],condition_index:index,condition_bit:bit};
    // Zero flag/object parameters are native empty clauses, not terminators.
    if(type===0){
      const effective=index||table?.map_flag_index;
      need(Number.isInteger(effective)&&effective>=0&&effective<2000&&bit<=32,'旗标索引或位无效');
    }else if(type===1&&bit===0){}
    else if([1,2,4,10].includes(type)){
      if(type===4){row.condition_index=b[at+1];row.condition_bit=index;}
      if(type!==4||index!==0)validateNativeStoryCondition(row,table);
    }else need([7,9].includes(type),`类型 ${type} 尚未接入`);
    return row;
  });
}
export function evaluateNativeStoryCombination(record,world,table){
  return nativeCombinationConditions(record,table).every(row=>{
    if(row.condition_type===0){
      const index=row.condition_index||table.map_flag_index;
      return !index||!row.condition_bit||Boolean(world.flags[index]&(1<<(row.condition_bit-1)));
    }
    if([7,9].includes(row.condition_type)||row.condition_type===1&&row.condition_bit===0
      ||row.condition_type===4&&row.condition_bit===0)return true;
    return evaluateNativeStoryCondition(row,world,table);
  });
}
