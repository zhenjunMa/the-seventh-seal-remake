// GAME.exe 41A640 / 4D9BF0 / 4DB570. Ancient glyphs retain their original
// zero-based WordDiscWord.pak indices; these are not Unicode passwords.
// 124 repairs the native setter(0) no-op by writing bit32, which the native
// getter(0) already reads. Other rewards retain their one-based source bits.
import {giveNativeStoryItem} from '../story/native_story_inventory.mjs';
import {validateChapterItemDefinition} from './native_story_items.mjs';
import {createNativeRng} from '../battle/combat_rules.mjs';
import {initialEncounterState} from '../exploration/encounters.mjs';

const need=(ok,message)=>{if(!ok)throw new Error(`特殊服务：${message}`);};
export const NATIVE_STATUES=Object.freeze([
  {index:1,symbols:[15,0,10,21,1,13],itemId:139,flagBit:3},
  {index:2,symbols:[15,5,23,9,19,13],itemId:142,flagBit:5},
  {index:3,symbols:[15,4,16,22,14,13],itemId:124,flagBit:32},
  {index:4,symbols:[15,2,8,17,11,13],itemId:134,flagBit:1},
  {index:5,symbols:[15,9,17,20,19,13],itemId:138,flagBit:2},
  {index:6,symbols:[15,3,12,6,20,13],itemId:141,flagBit:4},
  {index:7,symbols:[15,1,15,7,21,13],itemId:143,flagBit:6},
].map(row=>Object.freeze({...row,symbols:Object.freeze(row.symbols)})));
export const NATIVE_CASINO_CODES=Object.freeze({
  '651111':205,'132456':175,'745621':177,'632411':178,'734206':179,
  '753642':180,'179584':187,'403785':182,'324325':181,'501429':183,
  '399281':184,'225698':185,'407635':186,'432441':188,'775236':189,
  '863221':190,'206241':200,'523201':201,'809654':203,'661124':204,
  '298445':205,'100236':206,'660528':207,'457965':208,'600404':209,
});
export const NATIVE_LOTTO_REWARDS=Object.freeze([205,175,177,178,179,180,187,182,181,183,
  184,185,186,188,189,190,200,201,203,204,174,206,207,208,209]);

export function readNativeSpecialService(record){
  need(record?.mutation_type===18,'缺少原TLK特殊服务指令');
  const mode=record.mutation_index,index=record.mutation_bit;
  need([0,2,3,4,5].includes(mode),'原模式尚未接入');
  need(Number.isInteger(index)&&(mode===2?index>=1&&index<=7:index===0),'原参数无效');
  return {mode,index,...(mode===2?{statue:NATIVE_STATUES[index-1]}:{})};
}

export function nativeSpecialRewardIds(record){
  const service=readNativeSpecialService(record);
  return service.mode===2?[service.statue.itemId]:service.mode===0?[...NATIVE_LOTTO_REWARDS]:
    service.mode===5?[...new Set(Object.values(NATIVE_CASINO_CODES))]:[];
}

// 402513 -> 4BD830 scales one CRT output; unlike combat's 41D990,
// the upper endpoint is reachable only when rand() returns32767.
export function nativeSpecialRandom(draft,minimum,maximum){
  draft.encounters??=initialEncounterState(draft.party);
  const rng=createNativeRng(draft.encounters.rng_state),value=rng();
  draft.encounters.rng_state=rng.state;
  return minimum+Math.trunc(value*(maximum-minimum)/32767);
}

export function nativeSmallLottoPrize(faces){
  need(Array.isArray(faces)&&faces.length===6&&faces.every(n=>Number.isInteger(n)&&n>=1&&n<=24),'小乐透结果无效');
  // Preserve 4F6DF2's last-match scan, including its non-adjacent-group
  // overcount. Counting a Map of frequencies would change native payouts.
  let last=-1,prize=0;
  const awards=[0,250,500,1500,6000,30000];
  for(let i=0;i<5;i++){
    if(faces[i]===last)continue;
    let matches=0;
    for(let j=i+1;j<6;j++)if(faces[j]===faces[i]){matches++;last=faces[i];}
    prize+=awards[matches];
  }
  return prize;
}

export function playNativeSmallLotto(draft){
  if(draft.money<50)return {changed:false,message:'金钱不足，每次需要50库伦。'};
  draft.money=(draft.money-50)>>>0;
  const faces=Array.from({length:6},()=>nativeSpecialRandom(draft,1,24)),prize=nativeSmallLottoPrize(faces);
  draft.money=(draft.money+prize)>>>0;
  return {changed:true,cost:50,prize,faces,message:`结果：${faces.join('、')}\n奖金：${prize}库伦。`};
}

export const NATIVE_ROULETTE_LABELS=Object.freeze([
  ...Array.from({length:24},(_,i)=>`${i+1}`),'阴（二分）','阳（二分）','中（三分）',
  '地','水','火','风','日','月','阴（三分）','阳（三分）',
]);

export function nativeRoulettePrize(bets,outcome){
  need(Array.isArray(bets)&&bets.length===35&&bets.every(n=>Number.isInteger(n)&&n>=0&&n<=99),'转盘注数无效');
  need(Number.isInteger(outcome)&&outcome>=0&&outcome<24,'转盘结果无效');
  const r=outcome%6,third=[33,33,26,26,34,34][r],half=[24,24,24,25,25,25][r];
  return 1000*bets[outcome]+250*bets[r+27]+150*bets[third]+100*bets[half];
}

export function playNativeRoulette(draft,bets){
  // Validate before any money or RNG is consumed.
  nativeRoulettePrize(bets,0);
  const cost=50*bets.reduce((n,count)=>n+count,0);
  if(cost===0)return {changed:false,message:'请先下注，每注50库伦。'};
  if(cost>draft.money)return {changed:false,message:'金钱不足。'};
  draft.money=(draft.money-cost)>>>0;
  const outcome=nativeSpecialRandom(draft,0,23),prize=nativeRoulettePrize(bets,outcome);
  draft.money=(draft.money+prize)>>>0;
  return {changed:true,cost,prize,outcome,message:`转盘停在${outcome+1}号，${NATIVE_ROULETTE_LABELS[outcome%6+27]}。\n奖金：${prize}库伦。`};
}

export function nativeLottoTickets(count){
  need(Number.isInteger(count)&&count>=0&&count<=42,'大乐透选号数量无效');
  if(count<6)return 0;
  return count*(count-1)*(count-2)*(count-3)*(count-4)*(count-5)/720;
}

export function nativeLottoCounts(count,matches){
  need(Number.isInteger(count)&&count>=6&&count<=42&&Number.isInteger(matches)&&matches>=0&&matches<=6,'大乐透命中结果无效');
  let c6=0,c5=0,c4=0,c3=0,c2=0,temp=0;
  if(count===6){
    if(matches===6)c6=1;else if(matches===5)c5=1;else if(matches===4)c4=1;
    else if(matches===3)c3=1;else if(matches===2)c2=1;
  }else{
    // Preserve 4CDF19..4CEA1E's actual recurrence, including the source
    // count>=7/correct<2 consolation branch. This is not C(n,k) replacement.
    c2=1;let a=1,b=1,c=1;
    for(let i=6;i<count;i++){c++;b+=c;a+=b;c2+=a;}
    if(matches===6){
      c6=1;
      for(let i=7;i<=count;i++)c5+=6;
      for(let i=7;i<=count;i++)c4+=(i-7)*15;
      for(let i=8;i<=count;i++){temp+=(i-8)*20;c3+=temp;}
      c2=Math.max(0,c2-c3-c4-c5-c6);
    }else if(matches===5){
      c5=2;for(let i=7;i<=count;i++)c5++;
      for(let i=7;i<=count;i++)c4+=(i-6)*5;
      for(let i=7;i<=count;i++){temp+=(i-7)*10;c3+=temp;}
      c2=Math.max(0,c2-c3-c4-c5);
    }else if(matches===4){
      c4=3;temp=2;for(let i=7;i<=count;i++){temp++;c4+=temp;}
      temp=0;for(let i=7;i<=count;i++){temp+=i*4-24;c3+=temp;}
      c2=Math.max(0,c2-c3-c4);
    }else if(matches===3){
      c3=4;temp=3;b=2;for(let i=8;i<=count;i++){b++;temp+=b;c3+=temp;}
      c2=Math.max(0,c2-c3);
    }
  }
  return {six:c6,five:c5,four:c4,three:c3,two:c2,cards:20*c6+6*c5+c4,money:200*c3+50*c2};
}

export function drawNativeLottoNumbers(draft){
  const draw=Array(6).fill(-1);
  for(let tries=0;tries<10000;tries++){
    for(let i=0;i<6;i++)if(draw[i]===-1)draw[i]=nativeSpecialRandom(draft,1,42);
    for(let i=0;i<5;i++)for(let j=i+1;j<6;j++)if(draw[i]===draw[j])draw[i]=-1;
    if(!draw.includes(-1))return draw.sort((a,b)=>a-b);
  }
  throw new Error('大乐透随机号码未能完成，当前事件已取消。');
}

export function revealNativeLottoCard(draft,{definitions,sourceHashes,mapId,recordId}={}){
  const itemId=NATIVE_LOTTO_REWARDS[nativeSpecialRandom(draft,1,25)-1];
  const result=giveNativeStoryItem(draft,definitions[itemId],{sourceHashes,
    instanceId:`lotto-${mapId}-${recordId}-${draft.revision}-${draft.inventory.length}`,
    initializationSource:'native-lotto-4CF148-47B3C0-47BDC0'});
  return {...result,itemId};
}

export function playNativeLotto(draft,numbers,multiplier,{definitions,sourceHashes,mapId,recordId,deferRewards=false}={}){
  if(!Array.isArray(numbers)||new Set(numbers).size!==numbers.length||
    !numbers.every(n=>Number.isInteger(n)&&n>=1&&n<=42)||numbers.length<6)
    return {changed:false,message:'请从1至42中至少选择六个不同号码。'};
  if(!Number.isSafeInteger(multiplier)||multiplier<1)
    return {changed:false,message:'投注倍数须为正整数。'};
  if(numbers.length>6)multiplier=1;
  const tickets=nativeLottoTickets(numbers.length),cost=tickets*50,requiredMoney=cost*multiplier;
  if(requiredMoney>draft.money)return {changed:false,message:'金钱不足。'};
  // This is the casino-local balance: 4CDDF4 subtracts the base ticket
  // cost, while the admission test includes the multiplier. The controller
  // retains the native exit contract (items persist; this balance does not).
  draft.money=(draft.money-cost)>>>0;
  let draw=drawNativeLottoNumbers(draft),matches=draw.filter(n=>numbers.includes(n)).length;
  let counts=nativeLottoCounts(numbers.length,matches);
  if(numbers.length<7&&[1,9,11,12,21,30].every(n=>numbers.includes(n))){
    draw=[1,9,11,12,21,30];matches=6;counts=nativeLottoCounts(6,6);
  }else if(numbers.length<7&&[9,10,13,14,33].every(n=>numbers.includes(n))){
    draw=[9,10,13,14,33,draw[5]];matches=5;counts=nativeLottoCounts(6,5);
  }
  const prize=counts.money*multiplier,rewards={},missed={};
  draft.money=(draft.money+prize)>>>0;
  for(let i=0;!deferRewards&&i<counts.cards;i++){
    const result=revealNativeLottoCard(draft,{definitions,sourceHashes,mapId,recordId});
    const totals=result.changed?rewards:missed;totals[result.itemId]=(totals[result.itemId]??0)+1;
  }
  const names=rows=>Object.entries(rows).map(([id,n])=>`${definitions[id].name} ×${n}`).join('、');
  return {changed:true,cost,required_money:requiredMoney,tickets,multiplier,prize,draw,matches,counts,rewards,missed,
    remainingCards:deferRewards?counts.cards:0,card:null,
    message:`开奖号码：${draw.join('、')}\n命中${matches}个，奖金${prize}库伦，刮刮卡${counts.cards}张。`+
      (Object.keys(rewards).length?`\n揭奖取得：${names(rewards)}。`:'')+
      (Object.keys(missed).length?`\n因背包或持有上限未能收下：${names(missed)}。`:'')};
}

// 4E0890..4E0EED checks six numeric positions. The recovered source uses
// x86 shift counts, so rewards175/207 and177/209 share their original flags.
// Keep this source-save compatibility instead of inventing persistence bits.
export function applyNativeCasinoCode(draft,code,{definitions,sourceHashes,mapId,recordId}={}){
  const id=typeof code==='string'&&/^[0-9]{6}$/.test(code)?NATIVE_CASINO_CODES[code]:undefined;
  if(!id)return {changed:false,matched:false,message:'兑换码不正确，请输入六位数字。'};
  const mask=1<<((id-147)&31);
  if(draft.flags[1998]&mask)return {changed:false,matched:true,already_claimed:true,message:'这个兑换码对应的奖励已经领取。'};
  const result=giveNativeStoryItem(draft,definitions[id],{sourceHashes,
    instanceId:`casino-code-${mapId}-${recordId}-${draft.revision}-${draft.inventory.length}`,
    initializationSource:'native-casino-code-4E0890-47B3C0-47BDC0'});
  if(!result.changed)return {...result,matched:true,message:result.full?'背包已满。':'同种物品已经达到持有上限。'};
  draft.flags[1998]=(draft.flags[1998]|mask)>>>0;
  // 41A2A3..41A2AF ->439C50 registers the zero-based synthesis recipe.
  if(!draft.recipe_unlock_indices?.includes(id-1))(draft.recipe_unlock_indices??=[]).push(id-1);
  return {...result,matched:true,message:`取得水晶石【${definitions[id].name}】一颗及合成方法`};
}

export function validateNativeSpecialService(record,{definitions,sourceHashes}={}){
  const service=readNativeSpecialService(record);
  for(const id of nativeSpecialRewardIds(record)){
    const definition=definitions?.[id];
    need(definition&&definition.source?.sha256===sourceHashes?.[definition.source.path],`奖励 ${id} 来源缺失`);
    validateChapterItemDefinition(definition);
  }
  return service;
}

export function applyNativeStatue(draft,service,symbols,{definitions,sourceHashes,mapId,recordId}={}){
  need(service.mode===2&&service.statue===NATIVE_STATUES[service.index-1],'石像来源无效');
  const statue=service.statue;
  if(!Array.isArray(symbols)||symbols.length!==6||symbols.some((symbol,i)=>symbol!==statue.symbols[i]))
    return {changed:false,matched:false,message:'古文字排列不正确。'};
  if((draft.flags[1997]&(1<<(statue.flagBit-1)))!==0)
    return {changed:false,matched:true,already_claimed:true,message:'这座石像的宝器已经领取。'};
  const result=giveNativeStoryItem(draft,definitions[statue.itemId],{sourceHashes,
    instanceId:`statue-${mapId}-${recordId}-${draft.revision}-${draft.inventory.length}`,
    initializationSource:'native-statue-41A785-47B3C0-47BDC0'});
  if(!result.changed)return {...result,matched:true,message:result.full?'背包已满。':'同种物品已经达到持有上限。'};
  draft.flags[1997]=(draft.flags[1997]|(1<<(statue.flagBit-1)))>>>0;
  return {...result,matched:true,message:`取得宝器【${definitions[statue.itemId].name}】一个`};
}
