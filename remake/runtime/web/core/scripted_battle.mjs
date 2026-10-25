// Native TLK kind5: seven fixed 20-byte C strings, not a random STG group.
import {runtimeContent,battleStage} from './content_registry.mjs';
import {WorldStore,validateWorld} from './world.mjs';
import {initialEncounterState} from './encounters.mjs';
import {createNativeRng} from './combat_rules.mjs';
import {isNativeBattleFilename,isNativeScriptedBattleNames,NATIVE_BATTLE_FILENAME_BYTES} from './native_battle_filenames.mjs';
const copy=structuredClone;
const need=(ok,message)=>{if(!ok)throw new Error(`剧情战斗：${message}`);};
export function scriptedBattleSource(record){
  need(record?.kind===5,'缺少原kind5记录');
  if(record.raw_hex===undefined){
    const row=record.scripted_battle;
    need(row&&typeof row.stage_file==='string'&&Array.isArray(row.enemy_files)&&row.enemy_files.length===6,'运行包缺少原战斗字段');
    need(isNativeScriptedBattleNames(row),'原战斗文件名无效');
    return copy(row);
  }
  need(/^[a-f0-9]{3294}$/.test(record.raw_hex),'原TLK字节无效');
  const raw=Uint8Array.from(record.raw_hex.match(/../g),part=>parseInt(part,16));
  const names=Array.from({length:7},(_,index)=>{
    const field=raw.slice(0x37+index*NATIVE_BATTLE_FILENAME_BYTES,0x37+(index+1)*NATIVE_BATTLE_FILENAME_BYTES),end=field.indexOf(0);
    need(end>=0,'原文件名缺少NUL边界');
    const value=new TextDecoder('ascii',{fatal:true}).decode(field.slice(0,end));
    need(isNativeBattleFilename(value,index===0?'scn':'dgp',{allowEmpty:index!==0}),'原战斗文件名无效');
    return value;
  });
  return {stage_file:names[0],enemy_files:names.slice(1)};
}
export function nativeScriptedBattle(table,record,content=runtimeContent){
  const source=scriptedBattleSource(record),stage=source.stage_file.toLowerCase();
  need(content.maps[table?.id]&&record.source?.path?.toLowerCase()===`map/${table.id.toLowerCase()}.tlk`
    &&record.source.sha256===table.source?.sha256,'剧情地图或记录来源不匹配');
  battleStage(stage,content);
  const members=source.enemy_files.flatMap((filename,source_slot)=>{
    if(!filename)return [];
    const id=filename.slice(0,-4),role=content.roles[id];
    need(role?.side==='enemy','原敌人尚未登记');
    return [{id,source_slot,source:copy(role.source)}];
  });
  need(members.length>0&&members.length<=4,'原敌人数超出当前已恢复战斗上限');
  return {kind:'scripted',map_id:table.id,stage,members,source:copy(record.source),
    evidence:['0x461ED0','0x4451C0'],selection_policy:'literal-TLK-six-filenames-no-STG-draw'};
}
export function beginScriptedBattle(draft,mapIds){
  const before=copy(draft),world=new WorldStore(before,mapIds);
  // Match ordinary exploration's one-time development stream initialization;
  // subsequent story battles continue the persisted CRT stream unchanged.
  const encounters=copy(draft.encounters??initialEncounterState(draft.party)),rng=createNativeRng(encounters.rng_state);
  const transitionRaw=rng(),transitionKind=transitionRaw%7;
  return {world,before,rng,encounters,transitionRaw,transitionKind};
}
export function commitScriptedBattle(draft,session,result){
  need(result&&['victory','escaped'].includes(result.outcome),'只有原战斗正常返回后才能续接演出');
  need(JSON.stringify(draft)===JSON.stringify(session.before),'战斗期间剧情草稿已变化');
  const next=session.world.snapshot();
  next.encounters={...copy(session.encounters),rng_state:session.rng.state};
  next.revision=draft.revision;validateWorld(next,session.world.mapIds);
  for(const key of Object.keys(draft))if(!Object.hasOwn(next,key))delete draft[key];
  Object.assign(draft,next);
  return {outcome:result.outcome,rng_state:session.rng.state};
}
