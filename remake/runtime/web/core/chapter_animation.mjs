import {AnmActions, COMMON_ANM_OPCODES} from './anm_runtime.mjs';
import {runtimeContent} from './content_registry.mjs';
// Registered source programs share the recovered opcode handlers. Unknown
// opcodes/modes remain errors; TLK and joining use the caller's world draft.
const OPCODES = new Set([10,14,16,17,30,31,32,33,35,36,48,49]);
const need = (value, message) => { if (!value) throw new Error(message); };
export function validateChapterAnimation(program,content=runtimeContent) {
  need(program?.schema === 'seventh-seal-chapter-anm' && program.version === 1
    && program.source?.sha256 === content.programs[program.id]?.sha256
    && program.source.path.toLowerCase() === `animate/${program.id}.anm`, '剧情动画来源不兼容');
  need(program.commands?.length > 0 && program.commands.length <= 256
    && program.source.bytes === 67 + program.commands.length * 74, '剧情动画长度无效');
  for (const [index, c] of program.commands.entries()) {
    need(c.index === index && OPCODES.has(c.opcode) && /^[0-9a-f]{148}$/.test(c.raw_hex), '剧情动画命令未支持');
    const b = Uint8Array.from(c.raw_hex.match(/../g), part => parseInt(part,16)), v = new DataView(b.buffer);
    need(c.opcode === b[0] && c.source.offset === 67 + index*74
      && c.source.sha256 === program.source.sha256 && c.source.path === program.source.path, '剧情动画记录来源不符');
    for (const offset of [1,5,9,13,17,21,25]) need(c[`u32_plus${offset}`] === v.getUint32(offset,true), '剧情动画字段不符');
    for (const offset of [29,30,31,32,33]) need(c[`byte_plus${offset}`] === b[offset], '剧情动画字节不符');
    if ([32,33,35,36,48,49].includes(c.opcode)) need(c.u32_plus5>=10||Object.values(content.roles).some(role=>role.side==='player'&&role.native_slot===c.u32_plus5), '剧情动画人物未接入');
    if (c.opcode === 10) need(c.filename?.toUpperCase() === `${program.expected.control_map}.DAT`
      && c.u32_plus5 === 0, '剧情动画地图入口未支持');
    if (c.opcode === 33) need(c.byte_plus29 === 0 && c.u32_plus25 <= 255, '剧情移动模式未支持');
    if (c.opcode === 36) need(Object.values(content.roles).some(role=>role.side==='player'&&role.native_slot===c.u32_plus5)&&c.byte_plus29 === 0, '剧情队伍操作未支持');
    if (c.opcode === 48) need(c.u32_plus13 >= 1 && c.u32_plus17 > c.u32_plus13
      && c.u32_plus17 <= 512 && c.u32_plus25 > 0, '剧情动作帧范围无效');
  }
  return program;
}
export class ChapterAnimationRunner {
  constructor({program,hooks,runTlk,joinActor,initialLocation,content=runtimeContent}) {
    validateChapterAnimation(program,content);
    for (const name of ['map','actor','move','camera','wait']) need(typeof hooks?.[name] === 'function', `剧情动画接口缺失：${name}`);
    Object.assign(this,{program,hooks,runTlk,joinActor,initialLocation}); this.phase = 'idle';
  }
  async run() {
    need(this.phase === 'idle','剧情动画已执行'); this.phase = 'running';
    const positions = new Map([[0,{...this.initialLocation}]]);
    let mapId = this.initialLocation.map_id;
    const actions = new AnmActions({hooks:this.hooks, context:() => ({mapId}), positions});
    try {
      for (const c of this.program.commands) {
        actions.check();
        if (COMMON_ANM_OPCODES.has(c.opcode)) { await actions.execute(c); continue; }
        switch(c.opcode) {
          case 10:
            await actions.flush(); mapId = c.filename.slice(0,-4).toUpperCase();
            await actions.call('map', c, {mapId, initialLocation:this.initialLocation}); break;
          case 14:
            await this.runTlk({mapId, recordId:c.u32_plus5}); await actions.frame(c); break;
          case 36: await this.joinActor({actorSlot:c.u32_plus5, modeRaw:c.byte_plus29}); break;
          default: throw new Error(`剧情动画指令${c.opcode}尚未支持`);
        }
      }
      await actions.flush(); this.phase = 'complete';
      return {location:positions.get(0),commands:this.program.commands.length,source:this.program.source};
    } catch(error) { actions.abort(error); this.phase = 'failed'; throw error; }
  }
}
