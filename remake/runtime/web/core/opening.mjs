import {AnmActions, COMMON_ANM_OPCODES} from './anm_runtime.mjs';
// Bounded Resurrect.ANM playback. Native authority: GAME.exe 0x473e30
// (ev_021cb8364fd8c2778f25fa267a76fa12a34176836d4cba37ae4610b05af773bc),
// outer tick 0x477330, and new-game caller 0x4a8960. This module does not
// mutate the WorldStore: the caller commits control/save state after run().
const fail = (condition, message) => { if (!condition) throw new Error(message); };
const SHIPPED_SHA256 = '6dc46a32c4733931b4b2e37e1e5c9c2a54f71f426be04d1d2809a8dbb19f7268';
const OPCODES = new Set([10, 14, 16, 17, 30, 31, 32, 33, 35, 41, 48, 49, 255]);
const REQUIRED_HOOKS = ['map', 'actor', 'move', 'camera', 'fade', 'say', 'wait'];
export const OPENING_LIMITATIONS = Object.freeze([
  'The source/native evidence is static; this player does not establish original GAME.exe runtime equivalence.',
  'Browser hooks render movement, camera, fades and animation. Their visual/audio output and wall-clock timing are not guaranteed to match the native renderer.',
  'Action barriers use hook completion promises followed by one frame. Native actor busy-flag polling is not reproduced instruction by instruction.',
  'Actor state effects at native fields +0x4bd/+0x4be are passed to renderer hooks as raw modes; the VM writes and visibility are source-backed, but the full pixel blending transitions remain a renderer limitation.',
  'Only the unconditional text dialogue chains used by Resurrect.ANM are supported; retained TLK trailing payload is not executed.',
]);

function bytesOf(record) {
  fail(typeof record.raw_hex === 'string' && /^(?:[a-f\d]{2}){74}$/i.test(record.raw_hex),
    `Opening command ${record.index}: missing 74-byte source record`);
  return Uint8Array.from(record.raw_hex.match(/../g), value => parseInt(value, 16));
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function dialogueChain(program, mapId, firstId) {
  const group = program.dialogues?.[mapId];
  fail(group && typeof group.source?.path === 'string' && /^[a-f\d]{64}$/i.test(group.source.sha256),
    `Opening dialogue source missing for ${mapId}`);
  fail(Array.isArray(group.records), `Opening dialogue records missing for ${mapId}`);
  const seen = new Set(), chain = [];
  for (let id = firstId; id; ) {
    fail(chain.length < 32 && !seen.has(id), `Opening dialogue cycle at ${mapId}:${id}`);
    seen.add(id);
    const record = group.records.find(entry => entry.id === id);
    fail(record && Number.isInteger(record.offset) && record.offset >= 0 && typeof record.raw_hex === 'string',
      `Opening dialogue record missing at ${mapId}:${id}`);
    fail(record.kind === 0 && record.condition_type === 0 && record.mutation_type === 0 && record.if_true === 0,
      `Opening dialogue ${mapId}:${id} has unsupported control/state payload`);
    fail(typeof record.text_raw === 'string' && Number.isInteger(record.next) && record.next >= 0,
      `Opening dialogue text/link invalid at ${mapId}:${id}`);
    fail(/^(?:[a-f\d]{2}){1647}$/i.test(record.raw_hex), `Opening dialogue source bytes invalid at ${mapId}:${id}`);
    const bytes = Uint8Array.from(record.raw_hex.match(/../g), value => parseInt(value, 16));
    const view = new DataView(bytes.buffer);
    for (const [field, offset] of [['speaker', 0x0f], ['id', 0x13], ['condition_type', 0x17],
      ['condition_index', 0x1b], ['condition_bit', 0x1f], ['mutation_type', 0x23], ['mutation_index', 0x27],
      ['mutation_bit', 0x2b], ['if_true', 0x2f], ['next', 0x33]])
      fail(record[field] === view.getUint32(offset, true), `Opening dialogue ${mapId}:${id} field ${field} differs from source bytes`);
    fail(record.kind === bytes[0] && record.style === bytes[1] && record.region_byte_raw === bytes[7],
      `Opening dialogue ${mapId}:${id} header differs from source bytes`);
    const textBytes = bytes.slice(0x37, 0x137), terminator = textBytes.indexOf(0);
    const text = new TextDecoder('gbk').decode(terminator < 0 ? textBytes : textBytes.slice(0, terminator));
    fail(record.text_raw === text, `Opening dialogue ${mapId}:${id} text differs from source bytes`);
    chain.push(record);
    id = record.next;
  }
  fail(chain.length > 0, `Opening empty dialogue at ${mapId}:${firstId}`);
  return chain;
}

/** Preflight every source record and text link before invoking any UI hook.
 * This is intentionally a bounded compatibility player, not a general ANM VM.
 * Unknown opcodes or unsupported variants fail visibly; opcode 255 is the
 * shipped comment record (native default return 0), never an end marker.
 */
export function validateOpeningProgram(program) {
  fail(program?.schema === 'seventh-seal-opening-program' && program.version === 1,
    'Unsupported opening program schema');
  fail(program.id === 'new-game-resurrect' && typeof program.source?.path === 'string'
    && program.source.path.toLowerCase() === 'animate/resurrect.anm'
    && program.source.sha256 === SHIPPED_SHA256, 'Opening source identity is not Resurrect.ANM');
  fail(Array.isArray(program.commands) && program.commands.length > 0 && program.commands.length <= 256,
    'Opening command count exceeds the bounded player');
  fail(program.source.bytes === 67 + program.commands.length * 74, 'Opening source record count/length mismatch');
  fail(program.source.bytes === 4211 && program.commands.length === 56, 'Opening source is incomplete');
  let mapId = null;
  const maps = [], dialogueIds = [];
  for (const [index, record] of program.commands.entries()) {
    const context = `Opening command ${index} (opcode ${record.opcode})`;
    fail(OPCODES.has(record.opcode), `${context}: unsupported opcode`);
    fail(record.index === index && record.source?.record_index === index && record.source.offset === 67 + index * 74
      && record.source.path === program.source.path && record.source.sha256 === program.source.sha256,
      `${context}: inconsistent source provenance`);
    const bytes = bytesOf(record), view = new DataView(bytes.buffer);
    fail(bytes[0] === record.opcode, `${context}: opcode/source bytes mismatch`);
    for (const offset of [1, 5, 9, 13, 17, 21, 25])
      fail(record[`u32_plus${offset}`] === view.getUint32(offset, true), `${context}: field +${offset} differs from source bytes`);
    for (const offset of [29, 30, 31, 32, 33])
      fail(record[`byte_plus${offset}`] === bytes[offset], `${context}: field +${offset} differs from source bytes`);
    fail(record.map_index_raw === view.getUint32(34, true), `${context}: map index differs from source bytes`);
    fail(Array.isArray(record.evidence) && record.evidence.length > 0, `${context}: native evidence missing`);
    const actor = record.u32_plus5;
    if ([32, 33, 35, 41, 48, 49].includes(record.opcode))
      fail(actor <= 255 && !(actor >= 6 && actor < 10), `${context}: unsupported actor selector`);
    switch (record.opcode) {
      case 10: {
        const filename = new TextDecoder().decode(bytes.slice(54)).split('\0')[0];
        fail(record.filename === filename && /^M\d{5}\.DAT$/i.test(filename) && record.u32_plus5 === 0,
          `${context}: unsupported map entry variant`);
        mapId = filename.slice(0, -4).toUpperCase();
        fail(program.maps?.includes(mapId), `${context}: map resource missing`);
        maps.push(mapId);
        break;
      }
      case 14:
        fail(mapId && actor > 0, `${context}: no active dialogue map/id`);
        dialogueIds.push(...dialogueChain(program, mapId, actor).map(entry => `${mapId}:${entry.id}`));
        break;
      case 16:
        fail(actor === 0 && record.u32_plus25 <= 10000, `${context}: unsupported render/capture variant`);
        break;
      case 17:
        fail(actor === 0 && record.byte_plus29 <= 1, `${context}: unsupported fade effect`);
        break;
      case 30:
        fail(actor === 0, `${context}: only full actor/control restore is supported`);
        break;
      case 31:
        fail(record.byte_plus29 === 0, `${context}: unsupported barrier mode`);
        break;
      case 32:
        fail(record.byte_plus29 <= 1, `${context}: unsupported camera focus mode`);
        break;
      case 33:
        fail(record.byte_plus29 === 0 && (record.u32_plus25&255) <= 8,
          `${context}: unsupported movement action/speed`);
        break;
      case 35:
        fail(record.u32_plus1 <= 1 && record.u32_plus25 <= 10000, `${context}: unsupported actor placement variant`);
        break;
      case 41:
        fail(record.u32_plus1 === 0 && record.byte_plus29 === 1, `${context}: unsupported actor behavior mode`);
        break;
      case 48:
        fail(record.u32_plus1 === 0 && record.u32_plus13 >= 1 && record.u32_plus17 > record.u32_plus13
          && record.u32_plus17 <= 512 && record.u32_plus25 > 0 && record.u32_plus25 <= 255,
          `${context}: unsupported animation frame/repetition range`);
        break;
      case 49:
        fail(record.u32_plus1 === 0 && [1, 6].includes(record.byte_plus29), `${context}: unsupported actor +0x4bd effect mode`);
        break;
      case 255:
        // Explicitly supported source comment. Native VM falls through with EAX=0.
        break;
    }
  }
  fail(mapId === program.expected?.control_map, 'Opening does not end on its declared control map');
  return {command_count: program.commands.length, maps, dialogue_ids: dialogueIds};
}

/** Hooks receive source-bound payloads and an AbortSignal. map/actor place,
 * camera/fade/say/wait are awaited. move and actor facing/behavior/animation
 * launch synchronously, return completion promises, and may run concurrently
 * until opcode 31. The actor hook must handle each named kind explicitly.
 * A map hook starts a cutscene view; actor restore resets temporary ANM actor
 * state. Neither hook should commit persistent world/save state.
 *
 * wait({kind:'frame',frames}) supplies native frame yields; wait({kind:'barrier',
 * frames:1,pendingCount}) is called once all launched actions have completed.
 * Hooks control actual rendering cadence. sound is reserved; this shipped ANM
 * contains no direct sound opcode, so there is no fabricated sound request.
 */
export class OpeningRunner {
  constructor({program, hooks, onPhase} = {}) {
    validateOpeningProgram(program);
    for (const name of REQUIRED_HOOKS) fail(typeof hooks?.[name] === 'function', `Opening hook missing: ${name}`);
    this.program = freeze(structuredClone(program));
    this.hooks = hooks;
    this.onPhase = onPhase;
    this.phase = 'idle';
    this.index = -1;
    this.lastError = null;
    this.result = null;
  }

  async run() {
    fail(this.phase === 'idle', `Opening cannot run in phase ${this.phase}`);
    this.phase = 'running';
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const positions = new Map(), executed = [], dialogueIds = [];
    let mapId = null;
    const notify = () => this.onPhase?.({phase:this.phase, index:this.index, mapId});
    const actions = new AnmActions({hooks:this.hooks, positions, controller:this.abortController,
      context:() => ({mapId}), nativeMetadata:true,
      describeError:(error, command) => new Error(`Opening command ${command.index} (opcode ${command.opcode}) failed: ${error?.message ?? error}`, {cause:error})});
    try {
      notify();
      for (const command of this.program.commands) {
        actions.check();
        this.index = command.index;
        notify();
        const actor = command.u32_plus5;
        if (COMMON_ANM_OPCODES.has(command.opcode)) {
          await actions.execute(command);
        } else switch (command.opcode) {
          case 10: {
            await actions.flush();
            const nextMap = command.filename.slice(0,-4).toUpperCase();
            await actions.call('map', command, {mapId:nextMap, filename:command.filename, mapModeRaw:command.byte_plus29});
            mapId = nextMap; positions.clear(); break;
          }
          case 14: {
            const records = dialogueChain(this.program, mapId, actor);
            await actions.call('say', command, {records, source:this.program.dialogues[mapId].source});
            dialogueIds.push(...records.map(entry => `${mapId}:${entry.id}`));
            await actions.frame(command); break;
          }
          case 41:
            actions.launch('actor', command, {kind:'behavior', actor, behaviorModeRaw:command.byte_plus29,
              nativeField:'0x4be', nativeStateRaw:command.byte_plus29 + 1,
              hidden:false, motionModeRaw:command.u32_plus1}); break;
          case 255: break;
          default: throw new Error(`Opening command ${command.index}: unsupported opcode ${command.opcode}`);
        }
        executed.push(command.index);
      }
      await actions.flush();
      const location = positions.get(this.program.expected.final_move_actor);
      fail(location && location.map_id === this.program.expected.control_map
        && location.x === this.program.expected.final_move_pixels[0] && location.y === this.program.expected.final_move_pixels[1],
      'Opening completion location differs from the source program');
      this.result = freeze({program_id: this.program.id, control_map: mapId, location: {...location},
        source: structuredClone(this.program.source), executed_indices: executed, dialogue_ids: dialogueIds,
        limitations: [...OPENING_LIMITATIONS, ...(this.program.limitations ?? [])]});
      this.phase = 'completed';
      notify();
      return this.result;
    } catch (error) {
      this.abortController.abort(error);
      this.lastError = error;
      this.result = null;
      this.phase = 'failed';
      try { notify(); } catch { /* Preserve the playback failure. */ }
      throw error;
    }
  }
}
