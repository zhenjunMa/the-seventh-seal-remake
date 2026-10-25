// GAME.exe 0x501E90: combine source CHR records, retaining provenance.
// Never concatenate whole independent animations or flatten skill attributes.
const clone=structuredClone;
const fail=(v,m)=>{if(!v)throw new Error(m);};
export const recordBytes=hex=>{fail(/^(?:[0-9a-f]{2}){176}$/i.test(hex),'原动作记录缺失');return Uint8Array.from(hex.match(/../g),h=>parseInt(h,16));};
const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');
const view=b=>new DataView(b.buffer,b.byteOffset,b.byteLength);
export function composeNativeSequence(skills,indices){
 fail(Array.isArray(indices)&&indices.length>0&&indices.length<=7,'原技能组合数量未支持');
 const selected=indices.map(i=>{const s=skills.find(s=>(s.index??s.original_skill_index)===i);fail(s&&Array.isArray(s.actions)&&s.actions.length,'组合源技能缺失');return s;});
 const records=[];let movement=false,bodies=0;
 const add=(skill,action,rebind)=>{const b=recordBytes(action.raw_hex);if(rebind)b[0x92]=skill.index??skill.original_skill_index;records.push({raw_hex:hex(b),source:clone(skill.source),source_skill_index:skill.index??skill.original_skill_index,source_action_index:action.index,source_offset:action.offset,source_raw_hex:action.raw_hex});};
 const prefix=s=>{const stop=s.actions.findIndex(a=>recordBytes(a.raw_hex)[0x2e]!==0);fail(stop>=0,'原组合缺少攻击主体');return s.actions.slice(0,stop);};
 for(const action of prefix(selected[0])){add(selected[0],action,false);if(view(recordBytes(action.raw_hex)).getInt32(0x1e,true)!==0)movement=true;}
 for(const skill of selected){
  const before=prefix(skill);
  if(!movement&&before.some(a=>view(recordBytes(a.raw_hex)).getInt32(0x1e,true)!==0)){for(const a of before)add(skill,a,true);movement=true;}
  for(const a of skill.actions)if(recordBytes(a.raw_hex)[0x2e]){add(skill,a,true);bodies++;}
 }
 fail(bodies>0,'原组合未生成攻击主体');
 const last=selected.at(-1),bodyLast=last.actions.findLastIndex(a=>recordBytes(a.raw_hex)[0x2e]);
 for(const a of last.actions.slice(bodyLast+1))add(last,a,true);
 let bodyRun=false;
 records.forEach((r,i)=>{
  const b=recordBytes(r.raw_hex),v=view(b);
  if(b[0x2e]&&!bodyRun){v.setInt32(0x2f,v.getInt32(0x37,true),true);v.setInt32(0x33,v.getInt32(0x3b,true),true);bodyRun=true;r.raw_hex=hex(b);}
  else if(!b[0x2e]&&bodyRun){const previous=recordBytes(records[i-1].raw_hex),p=view(previous);p.setInt32(0x2f,p.getInt32(0x3f,true),true);p.setInt32(0x33,p.getInt32(0x43,true),true);records[i-1].raw_hex=hex(previous);bodyRun=false;}
 });
 return {kind:'combination',skill_indices:[...indices],records,body_count:bodies,
  skill_handlers:Object.fromEntries(selected.filter(s=>s.battle_handler).map(s=>[s.index??s.original_skill_index,s.battle_handler])),
  evidence:['ev_83211444e38be8006ea27651f70345eacf6b681907e03ef2386c58dcd58028e5','ev_2ba5ba98c31056a99780bfa1b4e343ec5aa47cce71e34b29cae6c9510cfff685']};
}
export function directSequence(skill){return {kind:'single',handler:skill.battle_handler??'direct',skill_indices:[skill.index??skill.original_skill_index],records:skill.actions.map(a=>({raw_hex:a.raw_hex,source:clone(skill.source),source_skill_index:skill.index??skill.original_skill_index,source_action_index:a.index,source_offset:a.offset,source_raw_hex:a.raw_hex}))};}
export function compileNativeSequence(meta,roleId,plan,layers=[]){
 const role=meta.roles.find(r=>r.id===roleId);fail(role&&Array.isArray(plan.records),'原组合表现资源缺失');
 const independent=plan.records.some(record=>{const b=recordBytes(record.raw_hex),v=view(b);return b[0]===1&&v.getUint32(1,true)===4&&!b[0x1d]&&v.getUint32(0x49,true)!==0;});
 const verticalClock=plan.records.some(record=>{const b=recordBytes(record.raw_hex);return b[0]===1&&view(b).getUint32(1,true)===3;});
 const pairs=new Map(layers.filter(l=>l.role_id===roleId).flatMap(l=>l.frames).map(p=>[p.source_frame,p])),steps=[],segments=[];
 for(let ri=0;ri<plan.records.length;ri++){
  const record=plan.records[ri],b=recordBytes(record.raw_hex),v=view(b),group=v.getUint32(1,true);
  if(b[0]!==0){
   const vertical=group===3&&[2,3].includes(b[0x47]);
   const handler=plan.kind==='single'?plan.handler:plan.skill_handlers?.[record.source_skill_index];
   const magic=vertical||['effect-carrier','native-revival','native-support'].includes(handler);
   fail(b[0]===1&&(group===11||vertical||magic&&[0,4,6,7,8].includes(group)),'原组合类型命令未支持');
   if(!magic)continue;
   const previous=steps.findLast(s=>!s.command_raw&&s.command_raw!==0),visual=previous?.visual??previous??null;
   const base={segment_index:visual?.segment_index??0,plan_record_index:ri,chr_record_index:record.source_action_index,
    source_skill_index:plan.kind==='combination'?b[0x92]:plan.skill_indices[0],class_raw:b[0x24],action_mask_raw:b[0x78],source:clone(record),
    command_raw:group,visual:visual?{action_index:visual.action_index,action_frame:visual.action_frame,source_frame:visual.source_frame,pair:clone(visual.pair)}:null};
   if(group!==4){steps.push({...base,index:steps.length,logical_frame:0,event:null,effects:[],duration_ms:0,
    control:{mode_raw:b[0x47],step_i32_raw:v.getInt32(0x1e,true),amount_i32_raw:v.getInt32(5,true)},...(vertical?{vertical_raw_hex:record.raw_hex}:{})});
    if(group===7||group===8){
     const mode=b[0x47],ticks=group===7?({1:7,7:39}[mode]):({1:30,2:30,3:30,4:30,5:30,6:30,7:30,9:39}[mode]);
     fail(Number.isInteger(ticks),'原角色显隐模式尚未恢复');
     const previous=steps.findLast(step=>step.command_raw===undefined),nativeAction=role.actions.find(action=>action.index===previous?.action_index);
     const clock=group===7?60:new DataView(Uint8Array.from(nativeAction.native_raw_hex.match(/../g),h=>parseInt(h,16)).buffer).getUint32(1,true);
     fail(clock>0,'原角色显隐时钟缺失');
     const step=steps.at(-1);step.duration_ms=ticks*clock;step.visibility={kind:group===7?'appear':'disappear',mode,complete_ticks:ticks,clock_ms:clock};
     steps.push({...base,index:steps.length,logical_frame:1,event:null,effects:[],duration_ms:0,
       visibility_end:true,control:clone(step.control),visibility:clone(step.visibility)});
    }
    continue;}
   const token=new TextDecoder().decode(b.slice(9,29)).split('\0')[0].replace(/\.dgp$/i,''),asset=meta.effects.find(e=>e.id===token);
   // 51FCC4 failed CreateFile -> 505400/505990 return before allocating a
   // carrier or setting F5F6 wait. 5130D0 then advances the source record.
   // Only an explicitly audited missing literal follows this native branch.
   if(!asset&&meta.missing_effects?.some(e=>e.id===token&&e.source_exists===false)){
    steps.push({...base,index:steps.length,logical_frame:0,event:null,effects:[],duration_ms:0,missing_effect:token});continue;
   }
   fail(asset&&asset.native_raw_hex,'原类型4效果动作缺失');
   const d=Uint8Array.from(asset.native_raw_hex.match(/../g),h=>parseInt(h,16)),dv=view(d);
   const start=v.getUint32(0x26,true),end=v.getUint32(0x2a,true)||asset.frames.length,contact=v.getUint32(0x49,true),wait=b[0x1d]!==0;
   fail(start>=0&&end>start&&end<=asset.frames.length&&(!contact||contact>start&&contact<end),'原特效接触范围未支持');
   const frames=Array.from({length:end-start},(_,i)=>(d[0xd]&15)?start+i:d[0x16+start+i]);
   const slot=b[0x22]?'target':'actor',targetEffect=new TextDecoder().decode(b.slice(0x4e,0x62)).split('\0')[0].replace(/\.dgp$/i,'');
   if(!wait){
    const interval=dv.getUint32(1,true);fail(interval>0,'原独立特效时钟缺失');
    // 505990 copies the source index/target and leaves +3FE0 zero. 507930
    // visits live carriers in allocation order; 5074C0 increments the logical
    // cursor before contact and end checks. No F5F6 wait is set for +1D=0.
    const carrierSteps=Array.from({length:end-start},(_,i)=>{const logical=start+i+1,hit=logical===contact&&logical<end;
     return {...base,independent_carrier:true,logical_frame:logical,carrier_asset_id:token,
      carrier_source_frame:logical<end?frames[i+1]:null,carrier_end:logical===end,
      effect_contact:hit,effect_token:hit?1:0,event:hit?{frame:logical,field:'0x49'}:null,
      effects:hit&&targetEffect?[{asset_id:targetEffect,frame:logical,slot:'target'}]:[],duration_ms:interval};});
    steps.push({...base,index:steps.length,logical_frame:start,event:null,effects:[],duration_ms:0,
     carrier_spawn:{asset_id:token,slot,start,end_exclusive:end,frames,interval_ms:interval,steps:carrierSteps}});continue;
   }
   const visit=wait?frames:[frames[0]];
   visit.forEach((frame,i)=>{const logical=start+i,effects=[];
    if(i===0)effects.push({asset_id:token,frame:logical,slot,unconditional:true,frame_count:end-start});
    if(contact&&logical===contact&&targetEffect)effects.push({asset_id:targetEffect,frame:logical,slot:'target'});
    steps.push({...base,index:steps.length,logical_frame:logical,carrier_asset_id:token,carrier_source_frame:frame,
     effect_contact:contact!==0&&logical===contact,effect_token:contact!==0&&logical===contact?1:0,
     event:contact!==0&&logical===contact?{frame:logical,field:'0x49'}:null,effects,duration_ms:wait?(['native-revival','native-support'].includes(plan.handler)?dv.getUint32(1,true):undefined):0});
   });continue;
  }
  const action=role.actions.find(a=>a.index===group);fail(action&&action.native_raw_hex,'原组合DGP动作缺失');
  const d=Uint8Array.from(action.native_raw_hex.match(/../g),h=>parseInt(h,16)),dv=view(d),combo=plan.kind==='combination';
  const useCombo=combo&&(!(d[0x0d]&15)||v.getUint32(0x33,true)!==0);
  const start=v.getUint32(useCombo?0x2f:0x26,true),end=v.getUint32(useCombo?0x33:0x2a,true);
  fail(end>=start&&end-start<=300,'原组合帧边界无效');
  let frames=Array.from({length:end-start},(_,i)=>(d[0x0d]&15)?start+i:d[0x16+start+i]);
  if(!(d[0x0d]&15))fail(end<=dv.getUint32(0x12,true)&&end<=0x5c,'原DGP逻辑帧表越界');
  fail(frames.every(f=>Number.isInteger(f)&&f<action.frame_count),'原组合物理帧越界');if(b[0x1d])frames.reverse();
  const effectList=[];for(const [field,trigger,slot]of [[9,5,'actor'],[0x4e,0x49,'target']]){
   const token=new TextDecoder().decode(b.slice(field,field+20)).split('\0')[0];if(token)effectList.push({asset_id:token.replace(/\.dgp$/i,''),frame:v.getUint32(trigger,true),slot});
  }
  const si=segments.length,segment={chr_record_index:record.source_action_index,action_index:group,start,end_exclusive:end,frames,movement_step_raw:v.getInt32(0x1e,true),movement_source_field:'0x1e',source:clone(record),effects:effectList};segments.push(segment);
  frames.forEach((frame,i)=>{
   const logical=b[0x1d]?end-1-i:start+i,contact=v.getUint32(0x49,true),source_frame=action.first_frame+frame;
   steps.push({index:steps.length,segment_index:si,plan_record_index:ri,chr_record_index:record.source_action_index,action_index:group,action_frame:frame,logical_frame:logical,source_frame,
    source_skill_index:combo?b[0x92]:plan.skill_indices[0],class_raw:b[0x24],action_mask_raw:b[0x78],source:clone(record),event:contact!==0&&contact===logical?{frame:logical,field:'0x49'}:null,
    effects:effectList.filter(e=>e.frame===logical),pair:clone(pairs.get(source_frame)??null),...(independent||verticalClock||plan.kind==='single'&&['native-revival','native-support'].includes(plan.handler)?{duration_ms:dv.getUint32(1,true)}:{})});
  });
 }
 fail(steps.length>0&&(plan.allow_no_contacts||steps.some(s=>s.event||s.carrier_spawn?.steps.some(c=>c.event))),'原完整技能缺少接触事件');return {steps,segments,independent_carriers:independent};
}
