// Bounded Fire Valley TLK state interpreter. Native records apply their
// mutation on entry; the remake stages those writes until a complete dialogue
// or animation succeeds so failed asset/UI work cannot consume story rewards.
import {validateWorld} from './world.mjs';
import {restorePartyAfterRest} from './recovery.mjs';
import {admitPartyMember} from './party_members.mjs';
export {chapterRoleFromDefinition} from './party_members.mjs';
import {runtimeContent,storyBindings} from './content_registry.mjs';

const copy = value => structuredClone(value);
const need = (ok, message) => { if (!ok) throw new Error(message); };
const hex = value => Array.from(value, b => b.toString(16).padStart(2, '0')).join('');
const bytes = (value, count, label) => {
  need(typeof value === 'string' && new RegExp(`^(?:[0-9a-f]{2}){${count}}$`).test(value), `${label}原始记录无效`);
  return Uint8Array.from(value.match(/../g), part => parseInt(part, 16));
};
const view = b => new DataView(b.buffer, b.byteOffset, b.byteLength);
const flagIndex = value => Number.isInteger(value) && value >= 0 && value < 2000;
const signed = value => value | 0;
const FIELD_OFFSETS = {speaker:0x0f, id:0x13, condition_type:0x17, condition_index:0x1b,
  condition_bit:0x1f, mutation_type:0x23, mutation_index:0x27, mutation_bit:0x2b, if_true:0x2f, next:0x33};
const VALUE_PAIRS = [[0x0d,0x17e],[0x11,0x186],[0x15,0x18e],[0x19,0x196],
  [0x1d,0x19e],[0x21,0x1a6],[0x25,0x1ae],[0x29,0x1b6],[0x2d,0x1ce],
  [0x31,0x1ea],[0x35,0x1f2],[0x39,0x1fa],[0x3d,0x202],[0x41,0x20a],
  [0x45,0x212],[0x49,0x21a],[0x4d,0x222],[0x51,0x29a],[0x55,0x22a],
  [0x59,0x232],[0x5d,0x23a],[0x61,0x242],
  ...Array.from({length:10}, (_, i) => [0x65 + i * 4, 0x24a + i * 8])];
const ZERO_EVENT = '00'.repeat(14);

export function initializeChapterItem(definition) {
  const b = bytes(definition?.raw_hex, 0x3bf, '剧情道具定义'), v = view(b);
  need(v.getUint32(0, true) === definition.id && [2,5].includes(b[0x24]), '剧情道具类别尚未接入');
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
  need(data?.schema === 'seventh-seal-chapter-story' && data.version === 1 && data.maps, '火之谷剧情版本不兼容');
  for (const [mapId, table] of Object.entries(data.maps)) {
    need(/^M\d{5}$/.test(mapId) && flagIndex(table.map_flag_index) && Array.isArray(table.records)
      && table.records.length > 0 && table.records.length <= 10000, '火之谷对白表无效');
    need(table.source?.path?.toLowerCase() === `map/${mapId.toLowerCase()}.tlk`
      && /^[0-9a-f]{64}$/.test(table.source.sha256)
      && data.source_hashes?.[table.source.path] === table.source.sha256, '火之谷对白来源缺失');
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
      const text = new TextDecoder('gbk', {fatal:true}).decode(end < 0 ? rawText : rawText.slice(0, end));
      need(record.text_raw === text, '火之谷对白文字与原始记录不同');
      if (record.source) need(record.source.path === table.source.path && record.source.offset === record.offset
        && record.source.sha256 === table.source.sha256 && record.source.record_id === record.id,
        '火之谷对白记录来源不一致');
    }
    for (const record of table.records) for (const target of [record.if_true, record.next])
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

// The bounded home-bed question uses two of the native three entries. Each
// entry has a 100-byte GBK label followed by a DWORD TLK target; the final
// unused entry is zero. Read raw bytes so the displayed choices and targets
// cannot diverge from the original record.
export function chapterRestChoices(record,binding=null) {
  need(record?.kind === 0 && record.style === 1, '休息选择记录无效');
  const b = bytes(record.raw_hex, 0x66f, '休息选择'), v = view(b), choices = [];
  for (let index = 0; index < 3; index++) {
    const offset = 0x537 + index * 104, textBytes = b.slice(offset, offset + 100), end = textBytes.indexOf(0);
    const text = new TextDecoder('gbk', {fatal:true}).decode(end < 0 ? textBytes : textBytes.slice(0, end));
    const target = v.getUint32(offset + 100, true);
    if (text) choices.push({index, text, recordId:target});
    else need(target === 0, '休息空选择含未支持的跳转');
  }
  binding??=Object.entries(runtimeContent.maps).find(([id,row])=>record.source?.path?.toLowerCase()===`map/${id.toLowerCase()}.tlk`&&row.rests.some(rest=>rest.record_id===record.id))?.[1].rests.find(rest=>rest.record_id===record.id);
  need(choices.length>=1&&choices.length<=3&&binding?.choices?.length===choices.length&&choices.every((choice,index)=>{
    const expected=binding.choices[index];return choice.index===expected.index&&choice.text===expected.text&&choice.recordId===expected.record_id;
  }), '休息原始选择不兼容');
  return choices;
}

export class ChapterRunner {
  constructor({world, data, say, choose = null, animate, objectData = null, objectAnimation = async () => {}, setPhase = () => {}, log = () => {},content=runtimeContent}) {
    validateChapterStory(data);
    Object.assign(this, {world, data:copy(data), objectData:copy(objectData), objectAnimation, say, choose, animate, setPhase, log,content});
    this.running = false;
  }
  async runTlk({mapId, recordId, draft, context} = {}) {
    if (draft) return this.walkTlk({mapId, recordId, draft, context});
    return this.atomic({mapId, recordId}, next => this.walkTlk({mapId, recordId, draft:next, context}));
  }
  async runRest({explicitInteraction = false,descriptorId=null} = {}) {
    need(explicitInteraction === true, '休息需要主动操作床铺');
    const mapId = this.world.location.map_id, table = this.data.maps[mapId];
    const binding=storyBindings(mapId,this.content).rests.find(row=>descriptorId===null||row.descriptor_id===descriptorId);
    need(binding&&table, '当前地点没有已恢复的休息入口');
    const descriptor = table.descriptors?.find(row => row.id === binding.descriptor_id);
    need(descriptor?.state_raw === 2 && descriptor.field_26_raw === binding.record_id
      && descriptor.field_2a_raw === 0 && descriptor.field_2e_raw === 1
      && descriptor.source?.sha256 === this.data.source_hashes[descriptor.source.path], '床铺原始剧情入口缺失');
    return this.runTlk({mapId, recordId:binding.record_id, context:{steps:0, explicitInteraction:true}});
  }
  async atomic({mapId, recordId, objectIndex}, execute) {
    need(!this.running, '火之谷剧情正在执行');
    this.running = true;
    const before = this.world.snapshot(), next = copy(before);
    try {
      this.setPhase('event');
      const result = await execute(next);
      need(this.world.value.revision === before.revision, '世界状态在剧情执行期间发生变化');
      next.revision = (before.revision + 1) >>> 0;
      validateWorld(next, this.world.mapIds);
      this.world.replace(next);
      this.log({type:'chapter-commit', mapId, recordId, revision:next.revision,
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
    need(storyBindings(mapId,this.content).objects.some(row=>row.index===objectIndex&&row.handler==='stationary-chest'), '剧情物件行为尚未接入');
    const table = this.data.maps[mapId], object = table?.objects.find(row => row.index === objectIndex);
    need(object, '剧情物件来源缺失');
    const b = bytes(object.raw_hex, 0x112, '剧情物件'), v = view(b);
    need(object.source?.sha256 === this.data.source_hashes[object.source.path]
      && b[0xcf] === 3 && b[0x109] === 0 && table.records.some(row=>row.id===v.getUint32(0xf6,true)), '剧情箱子来源或状态类型无效');
    if (this.objectData) {
      const manifest = this.objectData[mapId]?.find(row => row.object_index_zero_based === objectIndex);
      need(manifest?.source?.path === object.source.path && manifest.source.offset === object.source.offset
        && manifest.source.sha256 === object.source.sha256 && manifest.source.raw_hex === object.raw_hex,
        '剧情物件清单与原始地图不一致');
    }
    return {table, object, recordId:v.getUint32(0xf6, true)};
  }
  async runObject({mapId, objectIndex} = {}) {
    need(!this.running, '火之谷剧情正在执行');
    const {table, object, recordId} = this.objectFor(mapId, objectIndex);
    need(this.world.location.map_id === mapId, '剧情物件不在当前地图');
    const initialState = chapterObjectState(this.world.snapshot(), mapId, objectIndex, this.data);
    if (initialState === 3) return {mapId, objectIndex, already_done:true, state:3, world:this.world.snapshot()};
    need([0,1,2].includes(initialState), '剧情物件保存状态尚未接入');
    return this.atomic({mapId, recordId, objectIndex}, async draft => {
      let result = {traversed:[], dialogueIds:[]};
      // Source 0x4137C0 clears pending state1 before dispatching +F6.
      // Saved state2 means its event already ran: finish the animation only.
      if (initialState === 1) setObjectEventState(draft, table.map_flag_index, objectIndex, 0);
      if (initialState !== 2) result = await this.walkTlk({mapId, recordId, draft});
      let state = chapterObjectState(draft, mapId, objectIndex, this.data);
      if (state === 2) {
        await this.objectAnimation({mapId, objectIndex, draft, source:object.source, fromState:2, toState:3});
        setObjectEventState(draft, table.map_flag_index, objectIndex, 3);
        state = 3;
      }
      return {...result, mapId, objectIndex, state, already_done:false};
    });
  }
  async walkTlk({mapId, recordId, draft, context = {steps:0}}) {
    const table = this.data.maps[mapId];
    need(table && Number.isInteger(recordId) && recordId > 0, '火之谷剧情入口无效');
    const records = new Map(table.records.map(record => [record.id, record]));
    const traversed = [], dialogueIds = [];
    let id = recordId;
    while (id) {
      need(++context.steps <= 1000, '火之谷剧情超过执行步数');
      const record = records.get(id);
      need(record, `火之谷对白记录 ${mapId}:${id} 未接入`);
      if (storyBindings(mapId,this.content).rests.some(row=>row.restore_records.includes(record.id)))
        need(context.explicitInteraction === true, '休息需要主动操作床铺');
      traversed.push(id);
      this.applyMutation(draft, table, record);
      this.log({type:'chapter-record', mapId, recordId:id, source:record.source ?? table.source});
      if (this.condition(draft, table, record)) { id = record.if_true; continue; }
      if (record.kind === 0) {
        if (storyBindings(mapId,this.content).rests.some(row=>row.record_id===record.id)) {
          need(context.explicitInteraction === true,
            '剧情选择需要已恢复的主动交互入口');
          need(typeof this.choose === 'function', '休息选择显示接口缺失');
          const binding=storyBindings(mapId,this.content).rests.find(row=>row.record_id===record.id);
          const choices = chapterRestChoices(record,binding), selected = await this.choose({mapId, record, choices:copy(choices), draft});
          const choice = choices.find(row => row.index === selected);
          need(choice, '休息选择结果无效');
          dialogueIds.push(id);
          id = choice.recordId;
          continue;
        }
        if (record.text_raw) {
          need(typeof this.say === 'function', '火之谷对白显示接口缺失');
          await this.say({mapId, record, source:table.source, draft});
          dialogueIds.push(id);
        }
        id = record.next;
      } else if (record.kind === 1) {
        const name = record.text_raw.replace(/\.anm$/i, '').toLowerCase();
        const program = this.data.programs?.[name];
        need(program && typeof this.animate === 'function', `火之谷演出 ${record.text_raw} 尚未接入`);
        await this.animate({program, mapId, draft,
          runTlk:args => this.runTlk({...args, draft, context}),
          joinActor:args => this.joinActor({...args, draft})});
        id = record.next;
      } else throw new Error(`火之谷对白类型 ${record.kind} 尚未接入`);
    }
    return {mapId, recordId, traversed, dialogueIds};
  }
  condition(draft, table, record) {
    need(record.condition_type === 0, `火之谷剧情条件 ${record.condition_type} 尚未接入`);
    const bit = signed(record.condition_bit);
    if (bit === 0) return false;
    const index = record.condition_index || table.map_flag_index;
    need(flagIndex(index) && bit >= 1 && bit <= 32, '火之谷剧情旗标条件无效');
    return Boolean(draft.flags[index] & (1 << (bit - 1)));
  }
  applyMutation(draft, table, record) {
    if (record.mutation_type === 2) {
      need(storyBindings(table.id,this.content).rests.some(row=>row.restore_records.includes(record.id)) && record.mutation_index === 0
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
      need(record.mutation_index === 0, '剧情道具移除尚未接入');
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
          initialization_source:'native-TLK-case5-0xCC-buffer-0x47B3C0-0x47BDC0'};
        if (slot) Object.assign(slot, row); else inventory.push(row);
      } else this.log({type:'chapter-inventory-full', id:definition.id, native_capacity:1000});
      return;
    }
    need(record.mutation_type === 0, `火之谷剧情变更 ${record.mutation_type} 尚未接入`);
    const bit = signed(record.mutation_bit);
    if (!bit) return;
    const index = record.mutation_index || table.map_flag_index;
    need(flagIndex(index) && bit >= -32 && bit <= 32, '火之谷剧情旗标变更无效');
    const mask = 1 << (Math.abs(bit) - 1);
    draft.flags[index] = (bit > 0 ? draft.flags[index] | mask : draft.flags[index] & ~mask) >>> 0;
  }
  joinActor({actorSlot, modeRaw, draft}) {
    // GAME.exe 0x4B6720 mode0 -> 0x45E400. The helper returns when the
    // character is already active; it never resets their HP/MP or progress.
    // Evidence ev_fd3e9e25a462ab6603ac334f9da52bed0b8b6590039f4b9655186099bc542eda
    // and ev_12df7bc4462bc0b911805dff6085f4bc98d698f681847adf18ee0aca472088f9.
    const id=Object.keys(this.content.roles).find(id=>this.content.roles[id].side==='player'&&this.content.roles[id].native_slot===actorSlot);
    need(id && modeRaw === 0 && draft, '剧情入队角色或模式尚未接入');
    const result=admitPartyMember(draft,id,{definitions:this.data.role_definitions,content:this.content});
    if(!result.added)return result;
    this.log({type:'chapter-join', actorSlot, modeRaw, ...result,
      evidence:['ev_fd3e9e25a462ab6603ac334f9da52bed0b8b6590039f4b9655186099bc542eda',
        'ev_12df7bc4462bc0b911805dff6085f4bc98d698f681847adf18ee0aca472088f9']});
    return {id, added:true};
  }
}
