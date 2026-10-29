// Bounded Fire Valley TLK state interpreter. Native records apply their
// mutation on entry; the remake stages those writes until a complete dialogue
// or animation succeeds so failed asset/UI work cannot consume story rewards.
import {validateWorld} from './world.mjs';
import {restorePartyAfterRest} from './recovery.mjs';
import {admitPartyMember,deactivatePartyMember,controlPartyActor} from './party_members.mjs';
import {applyNativeAnmFlagCommand} from './native_anm_commands.mjs';
export {chapterRoleFromDefinition} from './party_members.mjs';
import {runtimeContent,storyBindings} from './content_registry.mjs';
import {validateCompactRecords} from './story_packages.mjs';
import {StoryFlowRunner} from './story_flow.mjs';
import {evaluateNativeStoryCondition} from './native_story_conditions.mjs';
import {applyNativeStoryMutation} from './native_story_mutations.mjs';
import {removeNativeStoryItem} from './native_story_inventory.mjs';
import {applyWorldMapCommandToDraft} from './world_map.mjs';
import {compileTlkFlow,nativeFlowId} from './story_flow_compiler.mjs';
import {playbackDelay} from './story_playback.mjs';
import {nativeMapTransfer} from './map_connections.mjs';
import {nativeScriptedBattle} from './scripted_battle.mjs';
import {nativeKeyedChest,canOpenNativeChest} from './native_map_chests.mjs';
import {evaluateNativeStoryCombination} from './native_story_combinations.mjs';
import {isNativeMapId} from './native_map_identity.mjs';

const copy = value => structuredClone(value);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const hex = value => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value, count, label) => {
  need(typeof value === 'string' && new RegExp(`^(?:[0-9a-f]{2}){${count}}$`).test(value), `${label}原始记录无效`);
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
};
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const flagIndex = value => Number.isInteger(value) && value >= 0 && value < 2000;
const FIELD_OFFSETS = {speaker:0x0f, id:0x13, condition_type:0x17, condition_index:0x1b,
  condition_bit:0x1f, mutation_type:0x23, mutation_index:0x27, mutation_bit:0x2b, if_true:0x2f, next:0x33};
const VALUE_PAIRS = [[0x0d,0x17e],[0x11,0x186],[0x15,0x18e],[0x19,0x196],
  [0x1d,0x19e],[0x21,0x1a6],[0x25,0x1ae],[0x29,0x1b6],[0x2d,0x1ce],
  [0x31,0x1ea],[0x35,0x1f2],[0x39,0x1fa],[0x3d,0x202],[0x41,0x20a],
  [0x45,0x212],[0x49,0x21a],[0x4d,0x222],[0x51,0x29a],[0x55,0x22a],
  [0x59,0x232],[0x5d,0x23a],[0x61,0x242],
  ...Array.from({length:10}, (_, i) => [0x65 + i * 4, 0x24a + i * 8])];
const ZERO_EVENT = '00'.repeat(14);

export function initializeChapterItem(definition,{allowWeapon=false}={}) {
  const b = bytes(definition?.raw_hex, 0x3bf, '剧情道具定义'), v = view(b);
  need(v.getUint32(0, true) === definition.id && (allowWeapon?[1,2,3,5]:[2,3,5]).includes(b[0x24]), '剧情道具类别尚未接入');
  // TLK case5 uses the 0xCC-filled 0x461780 local buffer, not a fabricated
  // zeroed native instance. 0x47B3C0 only overwrites the fields below;
  // 0x47BDC0 writes quantity when the buffer enters inventory.
  // ev_bf9af000fbc18c6f6eac561f0f48cc7069f26b2dea7441564896eb1ba836a96f
  // ev_fe1630510a8718f8ab0965c11e9be770980ccad78da2fa07cb2a796be29da761.
  const instance = new Uint8Array(0xe5).fill(0xcc), out = view(instance);
  instance.set(b.slice(0, 4));
  instance[9] = b[0x176];
  instance.fill(0, 10, 13);
  for (const [to, from] of VALUE_PAIRS) {
    const minimum = v.getInt32(from, true), maximum = v.getInt32(from + 4, true);
    need(minimum === maximum, '剧情道具随机初始化范围尚未接入');
    out.setInt32(to, minimum, true);
  }
  return instance;
}

export function chapterObjectState(world, mapId, objectIndex, data) {
  const table = data.maps?.[mapId], object = table?.objects?.find(row => row.index === objectIndex);
  need(object, '剧情物件来源缺失');
  const record = world.event_records[table.map_flag_index]?.[objectIndex];
  return record ? bytes(record, 14, '剧情物件事件')[0] : bytes(object.raw_hex, 0x112, '剧情物件')[0xd0];
}

function setObjectEventState(draft, mapFlagIndex, objectIndex, state) {
  const records = draft.event_records[mapFlagIndex];
  while (records.length <= objectIndex) records.push(ZERO_EVENT);
  const old = bytes(records[objectIndex], 14, '剧情物件事件');
  old[0] = state;
  records[objectIndex] = hex(old);
}

export function validateChapterStory(data) {
  need(data?.schema === 'seventh-seal-chapter-story' && [1,2].includes(data.version) && data.maps, '剧情版本不兼容');
  for (const [mapId, table] of Object.entries(data.maps)) {
    if(table.dialogue_status==='source-file-absent'){
      need(isNativeMapId(mapId)&&flagIndex(table.map_flag_index)
        &&table.source===null&&Array.isArray(table.records)&&table.records.length===0
        &&table.record_count===0&&table.index_count===0
        &&table.header_setup_tlk_raw===0&&table.header_entry_tlk_raw===0
        &&table.map_source?.path?.toLowerCase()===`map/${mapId.toLowerCase()}.dat`
        &&/^[0-9a-f]{64}$/.test(table.map_source.sha256)
        &&data.source_hashes?.[table.map_source.path]===table.map_source.sha256,'无对白地图来源无效');
      continue;
    }
    need(isNativeMapId(mapId) && flagIndex(table.map_flag_index) && Array.isArray(table.records)
      && table.records.length > 0 && table.records.length <= 10000, '火之谷对白表无效');
    need(table.source?.path?.toLowerCase() === `map/${mapId.toLowerCase()}.tlk`
      && /^[0-9a-f]{64}$/.test(table.source.sha256)
      && data.source_hashes?.[table.source.path] === table.source.sha256, '火之谷对白来源缺失');
    if(data.version===2){validateCompactRecords(table);continue;}
    const ids = new Set();
    for (const record of table.records) {
      const b = bytes(record.raw_hex, 0x66f, '对白'), v = view(b);
      need(Number.isInteger(record.id) && record.id > 0 && record.offset === table.record_base + (record.id - 1) * 0x66f
        && !ids.has(record.id), '火之谷对白编号无效');
      ids.add(record.id);
      for (const [field, offset] of Object.entries(FIELD_OFFSETS))
        need(record[field] === v.getUint32(offset, true), `对白 ${mapId}:${record.id} 字段 ${field} 与原始记录不同`);
      need(record.kind === b[0] && record.style === b[1] && (record.region_byte_raw ?? b[7]) === b[7], '火之谷对白类型与原始记录不同');
      const rawText = b.slice(0x37, 0x137), end = rawText.indexOf(0);
      // kind8 overlays the text area with ushort goods IDs; its retained text
      // projection uses the source exporter's replacement decoding.
      const text = new TextDecoder('gbk', {fatal:record.kind!==8}).decode(end < 0 ? rawText : rawText.slice(0, end));
      need(record.text_raw === text, '火之谷对白文字与原始记录不同');
      if (record.source) need(record.source.path === table.source.path && record.source.offset === record.offset
        && record.source.sha256 === table.source.sha256 && record.source.record_id === record.id,
        '火之谷对白记录来源不一致');
    }
    // kind2 +2F names a destination DAT entry marker, not a TLK record.
    for (const record of table.records) for (const target of [...(record.kind===2?[]:[record.if_true]), record.next])
      need(target === 0 || ids.has(target), `对白 ${mapId}:${record.id} 跳转目标缺失`);
  }
  return data;
}

export function chapterProgress(world) {
  // Legacy v1 worlds are read as-is. These original flags do not fabricate
  // party members, gear, or a pending opening during load.
  return {kai_joined:world.party.some(role => role.id === '002'),
    invitation_complete:Boolean(world.flags[51] & 1),
    equipment_ready:Boolean(world.flags[48] & 1)};
}

// Native style1 stores three 100-byte GBK labels followed by DWORD TLK targets.
export function chapterChoices(record) {
  need(record?.kind === 0 && record.style === 1, '剧情选择记录无效');
  if(record.raw_hex===undefined&&Array.isArray(record.choices))return copy(record.choices);
  const b = bytes(record.raw_hex, 0x66f, '剧情选择'), v = view(b), choices = [];
  for (let index = 0; index < 3; index++) {
    const offset = 0x537 + index * 104, textBytes = b.slice(offset, offset + 100), end = textBytes.indexOf(0);
    const text = new TextDecoder('gbk', {fatal:true}).decode(end < 0 ? textBytes : textBytes.slice(0, end));
    const target = v.getUint32(offset + 100, true);
    if (text) choices.push({index, text, recordId:target});
    else need(target === 0, '剧情空选择含未支持的跳转');
  }
  return choices;
}
export function chapterRestChoices(record,binding=null) {
  const choices=chapterChoices(record);
  binding??=Object.entries(runtimeContent.maps).find(([id,row])=>record.source?.path?.toLowerCase()===`map/${id.toLowerCase()}.tlk`&&row.rests.some(rest=>rest.record_id===record.id))?.[1].rests.find(rest=>rest.record_id===record.id);
  need(choices.length>=1&&choices.length<=3&&binding?.choices?.length===choices.length&&choices.every((choice,index)=>{
    const expected=binding.choices[index];return choice.index===expected.index&&choice.text===expected.text&&choice.recordId===expected.record_id;
  }), '休息原始选择不兼容');
  return choices;
}

export class ChapterRunner {
  constructor({world, data, say, choose = null, animate, transfer, battle, service, objectData = null, objectAnimation = async () => {}, wait=playbackDelay, setPhase = () => {}, log = () => {},content=runtimeContent,worldMapState}) {
    validateChapterStory(data);
    Object.assign(this, {world, data:data.version===2?data:copy(data), objectData:data.version===2?objectData:copy(objectData), objectAnimation, say, choose, animate, transfer, battle, service, wait, setPhase, log,content,worldMapState});
    if(data.version===1)this.data.flows=Object.fromEntries(Object.values(this.data.maps).filter(table=>table.dialogue_status!=='source-file-absent').map(table=>{
      const flow=compileTlkFlow(table,{choices:chapterChoices});return [flow.id,flow];
    }));
    this.flowRunner=new StoryFlowRunner(Object.fromEntries(['record','say','choice','animation','give_item','restore_party','request_save','set_native_object','wait',
      'test_native_condition','test_native_combination','change_native_money','native_service','learn_native_skill','native_noop','unlock_recipe','world_map_command','transfer_native_map','native_battle','restore_native_resources']
      .map(op=>[op,(command,execution)=>this.applyFlowCommand(op,command,execution)])));
    this.running = false;
  }
  async runTlk({mapId, recordId, triggerId, draft, context = {steps:0}, playback = context.playback} = {}) {
    if(playback)context.playback=playback;
    if(triggerId!==undefined){
      const table=this.data.maps[mapId],descriptor=table?.descriptors.find(row=>row.id===triggerId);
      need(storyBindings(mapId,this.content).triggers.includes(triggerId)&&descriptor?.state_raw===2
        &&descriptor.field_26_raw===recordId,'原地形触发器与剧情入口不同');
      context.transition={mapId,triggerId,triggerRecordId:recordId};
    }
    if (draft) return this.walkTlk({mapId, recordId, draft, context});
    context.deferTransferRelease=true;let completed=false;
    try{
      const result=await this.atomic({mapId, recordId, playback}, next => this.walkTlk({mapId, recordId, draft:next, context}));
      completed=true;return result;
    }finally{
      for(const release of (context.transferReleases??[]).splice(0).reverse())release({failed:!completed});
      delete context.deferTransferRelease;
    }
  }
  async runEvent(event,{playback}={}){
    need(event.map_id===this.world.location.map_id,'NPC 事件不在当前地图');
    const flow=this.data.flows?.[event.flow_id];
    need(flow&&flow.id===event.flow_id&&flow.map_id===event.map_id,'NPC 剧情流程缺失');
    return this.atomic({mapId:event.map_id,eventId:event.id,playback},draft=>this.flowRunner.execute(flow,{draft,context:{steps:0,explicitInteraction:true,playback}}));
  }
  async runRest({explicitInteraction = false,descriptorId=null,playback} = {}) {
    need(explicitInteraction === true, '休息需要主动操作床铺');
    const mapId = this.world.location.map_id, table = this.data.maps[mapId];
    const binding=storyBindings(mapId,this.content).rests.find(row=>descriptorId===null||row.descriptor_id===descriptorId);
    need(binding&&table, '当前地点没有已恢复的休息入口');
    const descriptor = table.descriptors?.find(row => row.id === binding.descriptor_id);
    need(descriptor?.state_raw === 2 && descriptor.field_26_raw === binding.record_id
      && descriptor.field_2a_raw === 0 && descriptor.field_2e_raw === 1
      && descriptor.source?.sha256 === this.data.source_hashes[descriptor.source.path], '床铺原始剧情入口缺失');
    return this.runTlk({mapId, recordId:binding.record_id, context:{steps:0, explicitInteraction:true},playback});
  }
  async atomic({mapId, recordId, objectIndex, eventId, playback}, execute) {
    need(!this.running, '火之谷剧情正在执行');
    this.running = true;
    const before = this.world.snapshot(), next = copy(before);
    try {
      playback?.check();this.setPhase('event');
      if(playback?.paused)await playback.ready();
      const result = await execute(next);
      if(playback?.paused)await playback.ready();
      playback?.check();
      need(this.world.value.revision === before.revision, '世界状态在剧情执行期间发生变化');
      next.revision = (before.revision + 1) >>> 0;
      validateWorld(next, this.world.mapIds);
      this.world.replace(next);
      this.log({type:'chapter-commit', mapId, recordId, revision:next.revision,
        ...(eventId?{event:eventId}:{}),
        ...(objectIndex === undefined ? {} : {objectIndex}),
        commit_policy:'remake-atomic-success', native_mutation_timing:'record-entry'});
      return {...result, world:this.world.snapshot()};
    } catch (error) {
      this.log({type:'chapter-failed', mapId, recordId, objectIndex, committed:false, error:error.message});
      throw error;
    } finally {
      this.running = false;
      this.setPhase('map');
    }
  }
  objectFor(mapId, objectIndex) {
    const binding=storyBindings(mapId,this.content).objects.find(row=>row.index===objectIndex);
    need(binding&&['stationary-chest','keyed-chest','tlk-object'].includes(binding.handler), '剧情物件行为尚未接入');
    const table = this.data.maps[mapId], object = table?.objects.find(row => row.index === objectIndex);
    need(object, '剧情物件来源缺失');
    const b = bytes(object.raw_hex, 0x112, '剧情物件'), v = view(b);
    need(object.source?.sha256 === this.data.source_hashes[object.source.path], '剧情箱子来源无效');
    const chest=binding.handler==='keyed-chest'?nativeKeyedChest(object):null;
    const repeatable=binding.handler==='tlk-object';
    if(!chest)need(b[0xcf] === (repeatable?1:3) && b[0x109] === 0 && table.records.some(row=>row.id===v.getUint32(0xf6,true)), '剧情物件来源或状态类型无效');
    if (this.objectData) {
      const manifest = this.objectData[mapId]?.find(row => row.object_index_zero_based === objectIndex);
      need(manifest?.source?.path === object.source.path && manifest.source.offset === object.source.offset
        && manifest.source.sha256 === object.source.sha256 && manifest.source.raw_hex === object.raw_hex,
        '剧情物件清单与原始地图不一致');
    }
    return {table, object, recordId:v.getUint32(0xf6, true),chest,repeatable};
  }
  async runObject({mapId, objectIndex, playback} = {}) {
    need(!this.running, '火之谷剧情正在执行');
    const {table, object, recordId,chest,repeatable} = this.objectFor(mapId, objectIndex);
    need(this.world.location.map_id === mapId, '剧情物件不在当前地图');
    if(repeatable)return this.runTlk({mapId,recordId,playback,
      context:{steps:0,explicitInteraction:true,objectMapId:mapId,objectIndex}});
    const initialState = chapterObjectState(this.world.snapshot(), mapId, objectIndex, this.data);
    if (initialState === 3) return {mapId, objectIndex, already_done:true, state:3, world:this.world.snapshot()};
    need([0,1,2].includes(initialState), '剧情物件保存状态尚未接入');
    if(chest&&initialState!==2&&!canOpenNativeChest(this.world.snapshot(),chest))
      return {mapId,objectIndex,locked:true,key_id:chest.keyId,state:initialState,world:this.world.snapshot()};
    return this.atomic({mapId, recordId, objectIndex, playback}, async draft => {
      let result = {traversed:[], dialogueIds:[]};
      // Source 0x4137C0 clears pending state1 before dispatching +F6.
      // Saved state2 means its event already ran: finish the animation only.
      if(chest)setObjectEventState(draft,table.map_flag_index,objectIndex,2);
      else{
        if (initialState === 1) setObjectEventState(draft, table.map_flag_index, objectIndex, 0);
        if (initialState !== 2) result = await this.walkTlk({mapId, recordId, draft,context:{steps:0,playback}});
      }
      let state = chapterObjectState(draft, mapId, objectIndex, this.data);
      if (state === 2) {
        playback?.check();
        await this.objectAnimation({mapId, objectIndex, draft, source:object.source, fromState:2, toState:3,playback,signal:playback?.signal});
        playback?.check();
        if(chest){
          for(const reward of chest.rewards){
            // Reward work stays inside the existing atomic-success policy.
            // A full inventory cannot silently consume a direct chest here.
            need(draft.inventory.length<1000||draft.inventory.some(row=>row.id===0
              ||row.id===reward.id&&bytes(row.source_raw_hex,0xe5,'背包')[0x0c]===0),'背包已满，宝箱奖励无法接收');
            this.applyMutation(draft,table,{id:`object-${objectIndex}-${reward.slot}`,mutation_type:5,mutation_index:0,mutation_bit:reward.id},
              {itemInitializationSource:'native-object-447DE0-47BCF0-469820-47BFF0-47BDC0'});
          }
          result.rewards=copy(chest.rewards);
        }
        setObjectEventState(draft, table.map_flag_index, objectIndex, 3);
        state = 3;
      }
      return {...result, mapId, objectIndex, state, already_done:false};
    });
  }
  async walkTlk({mapId, recordId, draft, context = {steps:0}}) {
    const flow=this.data.flows?.[nativeFlowId(mapId)],entry=flow?.entries?.[recordId];
    need(entry&&Number.isInteger(recordId)&&recordId>0,`剧情入口 ${mapId}:${recordId} 未接入`);
    context.transferDepth=(context.transferDepth??0)+1;
    let completed=false;
    try{
      const result=await this.flowRunner.execute(flow,{entry,draft,context});
      completed=true;
      return {mapId,recordId,...result,save_requested:Boolean(context.saveRequested),world_map_requested:context.worldMapRequested??null};
    }finally{
      if(--context.transferDepth===0&&!context.deferTransferRelease){for(const release of (context.transferReleases??[]).splice(0).reverse())release({failed:!completed});}
    }
  }
  applyFlowCommand(op,command,{mapId,flowId,draft,context}){
    const table=this.data.maps[mapId],native=flowId===nativeFlowId(mapId),playback=context.playback;
    const record=native?table?.records.find(row=>row.id===command.record_id):{
      ...command.presentation,id:command.record_id,text_raw:command.text,source:command.source,
      ...(typeof command.speaker==='string'?{speaker_name:command.speaker}:{})};
    if(op==='record'){
      need(record,'剧情记录缺失');
      if(storyBindings(mapId,this.content).rests.some(row=>row.restore_records.includes(record.id)))need(context.explicitInteraction===true,'休息需要主动操作床铺');
      this.log({type:'chapter-record',mapId,recordId:record.id,source:command.source});return;
    }
    if(op==='transfer_native_map'){
      const transition=context.transition?.mapId===mapId?context.transition:
        context.explicitInteraction&&context.npcMapId===mapId?{npcSlot:context.npcSlot,sortCode:draft.native_map_sort_code??1}:
        context.explicitInteraction&&context.objectMapId===mapId?{objectIndex:context.objectIndex,sortCode:draft.native_map_sort_code??1}:null;
      need(native&&record&&transition,'地图跳转缺少原地形触发器或主动交互');
      const destination=nativeMapTransfer(table,record,transition,this.content);
      need(typeof this.transfer==='function','地图跳转显示接口缺失');
      return (async()=>{
        playback?.check();
        const result=await this.transfer({mapId,destination,draft,playback,signal:playback?.signal});
        if(result?.release)(context.transferReleases??=[]).push(result.release);
        playback?.check();
        need(result?.location?.map_id===destination.map_id,'地图跳转未返回原目标位置');
        draft.location=copy(result.location);draft.native_map_sort_code=destination.sort_code;
        const entry=storyBindings(destination.map_id,this.content).entry_record;
        if(entry)await this.runTlk({mapId:destination.map_id,recordId:entry,draft,context,playback});
        return destination;
      })();
    }
    if(op==='test_native_condition'){
      need(native&&record,'条件缺少原剧情来源');
      return evaluateNativeStoryCondition(record,draft,table);
    }
    if(op==='test_native_combination'){
      need(native&&record,'组合条件缺少原剧情来源');
      return evaluateNativeStoryCombination(record,draft,table);
    }
    if(op==='native_service'){
      need(native&&record&&context.explicitInteraction===true&&typeof this.service==='function','原商店服务接口缺失或没有主动交互入口');
      return (async()=>{
        playback?.check();
        const result=await this.service({mapId,table,record,draft,playback,signal:playback?.signal});
        playback?.check();return result;
      })();
    }
    if(op==='native_battle'){
      need(native&&record&&typeof this.battle==='function','原剧情战斗接口缺失');
      const group=nativeScriptedBattle(table,record,this.content);
      return this.battle({group,draft,playback,signal:playback?.signal});
    }
    if(op==='say'){
      need(typeof this.say==='function','剧情对白显示接口缺失');
      return this.say({mapId,record:{...record,text_raw:command.text},source:command.source,draft,playback,signal:playback?.signal});
    }
    if(op==='choice'){
      need(context.explicitInteraction===true,'剧情选择需要已恢复的主动交互入口');
      const rest=storyBindings(mapId,this.content).rests.find(row=>row.record_id===record.id);
      if(rest)chapterRestChoices(record,rest);
      need(typeof this.choose==='function','剧情选择显示接口缺失');
      return this.choose({mapId,record,choices:copy(command.choices),draft,playback,signal:playback?.signal});
    }
    if(op==='animation'){
      const program=this.data.programs?.[command.program_id];
      need(program&&typeof this.animate==='function',`剧情演出 ${command.program_id} 尚未接入`);
      return this.animate({program,mapId,draft,playback,signal:playback?.signal,
        runTlk:args=>this.runTlk({...args,draft,context}),joinActor:args=>this.joinActor({...args,draft}),
        leaveActor:args=>this.leaveActor({...args,draft}),
        flagCommand:({command,mapId:activeMap})=>{
          const active=this.data.maps[activeMap];need(active,'剧情旗标地图来源缺失');
          return applyNativeAnmFlagCommand(draft,command,active.map_flag_index);
        }});
    }
    if(op==='wait')return playback?playback.wait(command.ms):this.wait(command.ms);
    need(native&&record,'原剧情行为记录缺失');
    this.applyMutation(draft,table,record,context);
  }
  applyMutation(draft, table, record, context={}) {
    if([3,10,11,14,16,17].includes(record.mutation_type))return applyNativeStoryMutation(draft,record,{roleDefinitions:this.data.role_definitions});
    if(record.mutation_type===9){
      const request=applyWorldMapCommandToDraft(draft,{mode:record.mutation_index,area:record.region_byte_raw,destination:record.mutation_bit},
        {initialState:this.worldMapState});
      if(request)context.worldMapRequested=request;
      return;
    }
    if(record.mutation_type===4){
      need(context.explicitInteraction===true&&record.mutation_index===0&&record.mutation_bit===0,
        '存档需要主动交互入口');
      // Native 0x464d80 case4 clears dialogue then opens 0x4794e0. Defer UI
      // until the complete story transaction commits and exploration resumes.
      context.saveRequested=true;
      this.log({type:'chapter-save-request',mapId:table.id,recordId:record.id,source:record.source,native_handler:'0x464d80:case4'});
      return;
    }
    if (record.mutation_type === 2) {
      need((context.explicitInteraction===true||storyBindings(table.id,this.content).rests.some(row=>row.restore_records.includes(record.id))) && record.mutation_index === 0
        && record.mutation_bit === 0, '剧情恢复行为尚未接入');
      const resources = restorePartyAfterRest(draft);
      this.log({type:'chapter-restored', mapId:table.id, recordId:record.id, resources,
        source:record.source, native_handler:'0x461861'});
      return;
    }
    if (record.mutation_type === 1) {
      need(record.region_byte_raw === 0 && record.mutation_index === 0
        && Number.isInteger(record.mutation_bit)&&record.mutation_bit>0, '剧情物件状态变更尚未接入');
      const objectIndex=record.mutation_bit-1;
      this.objectFor(table.id, objectIndex);
      if (chapterObjectState(draft, table.id, objectIndex, this.data) !== 3)
        setObjectEventState(draft, table.map_flag_index, objectIndex, 2);
      return;
    }
    if (record.mutation_type === 5) {
      if(record.mutation_index!==0){
        const result=removeNativeStoryItem(draft,record.mutation_bit);
        this.log({type:'chapter-item-removed',mapId:table.id,recordId:record.id,id:record.mutation_bit,...result,
          native_handler:'0x4618FF / 0x47C8E0(-1,id)'});
        return result;
      }
      const definition = this.data.item_definitions?.[record.mutation_bit];
      need(definition && definition.source?.sha256 === this.data.source_hashes[definition.source.path], '剧情道具来源缺失');
      const template = initializeChapterItem(definition);
      const inventory = draft.inventory;
      // 0x47BDC0 checks each stored slot in order, choosing the first matching
      // stack (+0x0C=0) or empty ID0 slot. Gear type2 joins inventory too.
      const slot = inventory.find(row => row.id === 0
        || (row.id === definition.id && bytes(row.source_raw_hex, 0xe5, '背包')[0x0c] === 0));
      if (slot && slot.id !== 0) {
        const quantity = (slot.quantity + 1) >>> 0;
        slot.quantity = quantity < 100 ? quantity : 99;
        const raw = bytes(slot.source_raw_hex, 0xe5, '背包');
        view(raw).setUint32(4, slot.quantity, true);
        slot.source_raw_hex = hex(raw);
      } else if (slot || inventory.length < 1000) {
        view(template).setUint32(4, 1, true);
        const row = {instance_id:slot?.instance_id ?? `chapter-${table.id}-${record.id}-${draft.revision}-${inventory.length}`,
          id:definition.id, name:definition.name, quantity:1, source_raw_hex:hex(template),
          source_definition:copy(definition.source),
          initialization_source:context.itemInitializationSource??'native-TLK-case5-0xCC-buffer-0x47B3C0-0x47BDC0'};
        if (slot) Object.assign(slot, row); else inventory.push(row);
      } else this.log({type:'chapter-inventory-full', id:definition.id, native_capacity:1000});
      return;
    }
    throw new Error(`剧情行为 ${record.mutation_type} 尚未接入`);
  }
  joinActor({actorSlot, modeRaw, draft}) {
    // GAME.exe 0x4B6720 modes0/1 -> 0x45E400 (only mode3 switches control).
    // m71014-1:c12 uses mode1; its XY fields are not read by this branch.
    // Native proof: evidence/jade_lake_battle_20261028/anm36_native.json.
    // The helper returns when the
    // character is already active; it never resets their HP/MP or progress.
    // Evidence ev_fd3e9e25a462ab6603ac334f9da52bed0b8b6590039f4b9655186099bc542eda
    // and ev_12df7bc4462bc0b911805dff6085f4bc98d698f681847adf18ee0aca472088f9.
    const id=Object.keys(this.content.roles).find(id=>this.content.roles[id].side==='player'&&this.content.roles[id].native_slot===actorSlot);
    need(id && [0,1,3].includes(modeRaw) && draft, '剧情入队角色或模式尚未接入');
    if(modeRaw===3){
      const result=controlPartyActor(draft,id,{content:this.content});
      this.log({type:'chapter-control',actorSlot,modeRaw,...result});return result;
    }
    const result=admitPartyMember(draft,id,{definitions:this.data.role_definitions,content:this.content});
    if(!result.added)return result;
    this.log({type:'chapter-join', actorSlot, modeRaw, ...result,
      evidence:['ev_fd3e9e25a462ab6603ac334f9da52bed0b8b6590039f4b9655186099bc542eda',
        'ev_12df7bc4462bc0b911805dff6085f4bc98d698f681847adf18ee0aca472088f9']});
    return {id,added:true,...(result.reactivated?{reactivated:true}:{})};
  }
  leaveActor({actorSlot,draft}){
    const id=Object.keys(this.content.roles).find(id=>this.content.roles[id].side==='player'&&this.content.roles[id].native_slot===actorSlot);
    need(id&&draft,'剧情离队角色尚未接入');
    const result=deactivatePartyMember(draft,id,{content:this.content});
    this.log({type:'chapter-departure',actorSlot,...result,native_handler:'0x4B6660 / 0x45E560'});
    return result;
  }
}
