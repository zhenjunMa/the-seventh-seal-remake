// 462600 reads up to fifteen WORD(target,weight) pairs at TLK+37,
// then selects a cumulative interval using CRT rand()%100. An uncovered
// percentage re-enters the same record; its ordinary header is bypassed.
export function nativeRandomBranches(record){
  if(record.native_random_branches)return record.native_random_branches;
  if(record.kind!==3||typeof record.raw_hex!=='string'||record.raw_hex.length!==0x66f*2)
    throw new Error('原随机对白缺少来源');
  const raw=Uint8Array.from(record.raw_hex.match(/../g),part=>parseInt(part,16)),view=new DataView(raw.buffer),branches=[];
  for(let index=0;index<15;index++){
    const recordId=view.getUint16(0x37+index*4,true),weight=view.getUint16(0x39+index*4,true);
    if(!recordId||!weight)break;
    branches.push({recordId,weight});
  }
  if(!branches.length)throw new Error('原随机对白没有有效分支');
  return branches;
}
