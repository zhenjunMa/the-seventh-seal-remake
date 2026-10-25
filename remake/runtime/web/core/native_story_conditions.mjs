// TLK conditions beyond flag bits, recovered from 462600 and its helpers.
// This only reads a world snapshot; it never awards items or changes progress.
const need=(ok,message)=>{if(!ok)throw new Error(`原剧情条件：${message}`);};
const uint=value=>Number.isInteger(value)&&value>=0&&value<=0xffffffff;
export const NATIVE_STORY_CONDITION_TYPES=new Set([1,4,10]);
export const NATIVE_STORY_CONDITION_EVIDENCE={
  dispatch:'ev_e14d28c11ec31e5eebdf4c08a994a900102658650d8e5364d58b848cbd114ea7',
  object:'ev_ae80938b5372bbdb5a8910aed7225ecd370a8f09ab420dfa11092554bcbd6dac',
  inventory:'ev_dafa0c988c45fa7e7114cf4af701d9849866e3a182f1432485d4201c59994dca',
  party:'ev_8da059ef56c5de88c95fdb157a91830e05541173e328cebfe7839957303d230b'
};

export function nativeConditionByte(record){
  let value=record.condition_byte_raw_0b;
  if(record.raw_hex!==undefined){
    need(typeof record.raw_hex==='string'&&/^[0-9a-f]{3294}$/i.test(record.raw_hex),'TLK 来源记录无效');
    const raw=parseInt(record.raw_hex.slice(0x0b*2,0x0c*2),16);
    need(value===undefined||value===raw,'条件字节与来源不同');value=raw;
  }
  need(Number.isInteger(value)&&value>=0&&value<=255,'缺少条件字节 +0x0B');
  return value;
}

export function validateNativeStoryCondition(record,table){
  need(NATIVE_STORY_CONDITION_TYPES.has(record?.condition_type),`类型 ${record?.condition_type} 尚未接入`);
  need(uint(record.condition_index)&&uint(record.condition_bit),'条件参数无效');
  const type=record.condition_type;
  if(type===1){
    const index=record.condition_index||table?.map_flag_index;
    need(Number.isInteger(index)&&index>=0&&index<2000&&record.condition_bit>=1&&record.condition_bit<=1000,'物件事件索引无效');
    nativeConditionByte(record);
  }else if(type===4){
    // 462600 calls 47B0C0(index,itemId,0): mode0 includes equipment
    // for every native role as well as inventory, regardless of active party.
    need(record.condition_bit>=1&&record.condition_bit<=416,'道具编号无效');
  }else need(nativeConditionByte(record)<10,'队伍角色槽无效');
  return record;
}

function retainedEquipment(world){
  const current=world.equipment?.roles??{},rows=Object.values(current).flat();
  for(const row of world.source?.initial_equipment??[])
    if(!Object.hasOwn(current,row.role_id))rows.push(row);
  rows.push(...Object.values(world.crystal_sockets?.roles??{}).flat().filter(Boolean));
  return rows;
}

export function evaluateNativeStoryCondition(record,world,table){
  validateNativeStoryCondition(record,table);
  switch(record.condition_type){
    case 1:{
      const index=record.condition_index||table.map_flag_index;
      const raw=world.event_records?.[index]?.[record.condition_bit-1];
      need(raw===undefined||typeof raw==='string'&&/^[0-9a-f]{28}$/i.test(raw),'物件事件记录无效');
      const state=raw===undefined?0:parseInt(raw.slice(0,2),16),inactive=[0,5,6].includes(state);
      return nativeConditionByte(record)!==0?inactive:!inactive;
    }
    case 4:{
      const id=record.condition_bit;
      // The native helper compares IDs, without testing stored quantity.
      return retainedEquipment(world).some(row=>(row.id??row.item_id)===id)
        ||(world.inventory??[]).some(row=>row.id===id);
    }
    case 10:{
      const id=String(nativeConditionByte(record)+1).padStart(3,'0');
      return (world.party??[]).some(role=>role.id===id);
    }
  }
}
