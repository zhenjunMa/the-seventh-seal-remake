// Native successful-step counter and group selection, with an explicit
// continuous-motion adapter and persistent development RNG initialization.
import {createNativeRng} from './combat_rules.mjs';
import {runtimeContent,mapId,sourceHash,requireRegisteredRoles,battleStage} from './content_registry.mjs';
const clone=v=>structuredClone(v);
function requireValue(ok,message){if(!ok)throw new Error(message);}
export function validateEncounterState(state,party){
  requireValue(state&&[3,4].includes(Object.keys(state).length)&&Object.keys(state).every(k=>['rng_state','counters','remainders','global_pool_map_id'].includes(k)),'遇敌状态字段无效');
  requireValue(Number.isInteger(state.rng_state)&&state.rng_state>=0&&state.rng_state<=0xffffffff,'遇敌随机状态无效');
  if('global_pool_map_id' in state)requireValue(state.global_pool_map_id===null||mapId(state.global_pool_map_id),'遇敌全局池来源无效');
  for(const key of ['counters','remainders']){
    requireValue(state[key]&&typeof state[key]==='object'&&!Array.isArray(state[key])&&Object.keys(state[key]).length===party.length,'遇敌角色表无效');
    requireValue(Object.keys(state[key]).every(id=>party.some(actor=>actor.id===id)),'遇敌角色未接入');
  }
  requireValue(Object.values(state.counters).every(v=>Number.isInteger(v)&&v>=0&&v<=255),'遇敌步数无效');
  requireValue(Object.values(state.remainders).every(v=>Number.isFinite(v)&&v>=0&&v<16),'遇敌剩余距离无效');
  return clone(state);
}
export function initialEncounterState(party,seed=0x20261011){return {rng_state:seed>>>0,counters:Object.fromEntries(party.map(a=>[a.id,0])),remainders:Object.fromEntries(party.map(a=>[a.id,0]))};}
export function loadEncounterMap(draft,map_id,data){
  const map=data?.maps[map_id];
  if(!(map?.global_pool_load_raw??Boolean(map?.members.length)))return;
  const state=draft.encounters??=initialEncounterState(draft.party);
  // Native DAT+13F reloads one process-global STG pool. Retaining its source
  // identity in saves is the same deterministic adapter as the saved CRT.
  state.global_pool_map_id=map.members.length?map_id:null;
}
export function validateEncounterData(data,content=runtimeContent){
  requireValue(data?.schema==='seventh-seal-encounters'&&data.version===1&&data.source&&data.evidence?.length,'遇敌配置来源缺失');
  requireValue(data.policy?.step_pixels===16&&data.policy.equipment_bonus===0&&data.policy.buff_bonus===0,'遇敌修正尚未接入');
  requireValue(Array.isArray(data.compositions)&&data.compositions.length===13&&data.compositions.every(r=>r.length===3&&r[1]===0&&r.every(n=>Number.isInteger(n)&&n>=0)),'敌组组成表无效');
  for(const [id,map] of Object.entries(data.maps)){
    requireValue(mapId(id)&&content.maps[id]&&Number.isInteger(map.frequency)&&map.frequency>=0&&map.frequency<=500
      &&Array.isArray(map.members)&&map.evidence?.length,'地图遇敌规则未支持');
    if(map.global_pool_load_raw!==undefined)requireValue(Number.isInteger(map.global_pool_load_raw)&&map.global_pool_load_raw>=0&&map.global_pool_load_raw<=255,'全局遇敌池加载字段无效');
    requireValue(map.members.length>0||map.global_pool_load_raw!==undefined,'地图遇敌池来源缺失');
    // The recovered composition algorithm supports A and B pools only.
    requireValue(map.members.every(m=>['A','B'].includes(m.pool)&&m.source&&sourceHash(m.source.sha256)&&m.chr_source?.path===content.roles[m.id]?.source.path&&m.chr_source.sha256===content.roles[m.id]?.source.sha256),'敌组资源未支持');
    if(map.members.length){requireRegisteredRoles(map.members.map(m=>m.id),{side:'enemy'},content);battleStage(map.stage,content);}
  }
  return data;
}
export function generateGroup(map,data,rng,map_id=Object.keys(data.maps).find(id=>data.maps[id]===map)){
  requireValue(mapId(map_id)&&data.maps[map_id]===map,'敌组地图身份缺失');
  const draws=[],draw=(mod,label)=>{const raw=rng();requireValue(Number.isInteger(raw)&&raw>=0&&raw<=32767,'原随机输出无效');draws.push({label,raw,mod,value:raw%mod});return raw%mod;};
  const tier=draw(100,'count-tier'),range=tier<40?3:tier<60?4:tier<80?5:6,count=Math.min(4,draw(range,'enemy-count')+1);
  const pools={A:map.members.filter(m=>m.pool==='A'),B:map.members.filter(m=>m.pool==='B')};
  const length=pools.A.length>=2?13:pools.A.length===1?10:6;
  const eligible=data.compositions.slice(0,length).map((row,index)=>({row,index})).filter(({row})=>row.reduce((n,v)=>n+v,0)===count);
  requireValue(eligible.length,'没有可用原敌组组成');
  const chosen=eligible[draw(eligible.length,'composition')],members=[];
  for(const [pool,n] of [['A',chosen.row[0]],['B',chosen.row[2]]])for(let i=0;i<n&&pools[pool].length;i++)members.push(clone(pools[pool][draw(pools[pool].length,'member-'+pool)]));
  if(!members.length)members.push(clone(map.members[0]));
  return {map_id,stage:map.stage,members,composition_index:chosen.index,draws,source:clone(map.source),evidence:[...map.evidence,...data.evidence]};
}
// A non-mutating preview lets resource preparation fail without consuming the
// draw/counter reset. The caller locks exploration before preparing a battle.
export function previewMovement(state,{party,leader_id,map_id,dx,dy,transition=false,phase='map'},data,rngOverride=null,content=runtimeContent){
  validateEncounterData(data,content);const next=validateEncounterState(state,party);
  requireValue(Number.isFinite(dx)&&Number.isFinite(dy),'遇敌移动量无效');
  if(phase!=='map'||(!dx&&!dy))return {state:next,encounter:null,steps:0};
  requireValue(Object.hasOwn(next.counters,leader_id),'遇敌领队缺失');
  const travel=Math.max(Math.abs(dx),Math.abs(dy))+next.remainders[leader_id],steps=Math.floor((travel+1e-9)/16);
  next.remainders[leader_id]=Math.max(0,travel-steps*16);
  requireValue(steps<=8,'遇敌移动步长超出当前运行时');
  const rng=rngOverride??createNativeRng(next.rng_state),map=data.maps[map_id];let encounter=null,accepted=0;
  const poolMapId=next.global_pool_map_id===undefined?(map?.members.length?map_id:null):next.global_pool_map_id;
  const pool=poolMapId===null?null:data.maps[poolMapId];
  if(poolMapId!==null)requireValue(pool?.members.length>0,'保存的全局遇敌池尚未接入');
  for(let i=0;i<steps;i++){
    accepted++;next.counters[leader_id]=(next.counters[leader_id]+1)&255;
    if(next.counters[leader_id]<=40||transition||!map||map.frequency===0)continue;
    const roll=rng();requireValue(Number.isInteger(roll)&&roll>=0&&roll<=32767,'原随机输出无效');
    const chance=map.frequency+data.policy.equipment_bonus+data.policy.buff_bonus;
    if(chance>0&&roll%1000>=1000-2*chance){
      next.counters[leader_id]=0;
      if(pool){
        encounter=generateGroup(pool,data,rng,poolMapId);encounter.map_id=map_id;encounter.pool_source_map_id=poolMapId;
        if(poolMapId!==map_id)encounter.source=[...clone(map.source),...encounter.source];
        encounter.trigger_roll={raw:roll,mod:1000,value:roll%1000,threshold:1000-2*chance};
        next.remainders[leader_id]=0;break;
      }
    }
  }
  if(!rngOverride)next.rng_state=rng.state;
  return {state:next,encounter,steps:accepted};
}
