// 通用剧情执行与事务协调。来源校验、原版道具初始化和物件状态各有独立模块。
// 所有变更先写入剧情草稿，完整事件成功后再提交世界。
import {validateWorld} from '../world/world.mjs';
import {restorePartyAfterRest} from '../party/recovery.mjs';
import {admitPartyMember, deactivatePartyMember, controlPartyActor} from '../party/party_members.mjs';
import {applyNativeAnmFlagCommand, nativeAnmObjectTarget} from './native_anm_commands.mjs';
export {chapterRoleFromDefinition} from '../party/party_members.mjs';
import {runtimeContent, storyBindings} from '../content/content_registry.mjs';
import {isEmptyStoryFlowPath, StoryFlowRunner} from './story_flow.mjs';
import {evaluateNativeStoryCondition, NATIVE_SEQUENCE_MATCH_CONDITION} from './native_story_conditions.mjs';
import {applyNativeStoryMutation} from './native_story_mutations.mjs';
import {removeNativeStoryItem, giveNativeStoryItem} from './native_story_inventory.mjs';
import {applyWorldMapCommandToDraft} from '../exploration/world_map.mjs';
import {
  compileTlkFlow,
  nativeFlowId,
  compileNativeTriggerFlow,
  nativeTriggerFlowId,
} from './story_flow_compiler.mjs';
import {playbackDelay} from './story_playback.mjs';
import {nativeMapTransfer} from '../exploration/map_connections.mjs';
import {nativeScriptedBattle} from '../battle/scripted_battle.mjs';
import {
  nativeKeyedChest,
  nativeScriptedChest,
  nativeToggleObject,
  canOpenNativeChest,
  hasNativeObjectKey,
} from '../exploration/native_map_chests.mjs';
import {nativeMapMechanism, restingMapMechanismState} from '../exploration/native_map_mechanisms.mjs';
import {evaluateNativeStoryCombination} from './native_story_combinations.mjs';
import {createNativeRng} from '../battle/combat_rules.mjs';
import {initialEncounterState} from '../exploration/encounters.mjs';

import {bytes, view} from '../content/native_bytes.mjs';
import {validateChapterStory, chapterChoices, chapterRestChoices, flagIndex} from './native_records.mjs';
import {chapterObjectState, setObjectEventState} from './object_state.mjs';
export {validateChapterStory, chapterChoices, chapterRestChoices} from './native_records.mjs';
export {validateChapterItemDefinition, initializeChapterItem} from '../items/native_story_items.mjs';
export {chapterObjectState} from './object_state.mjs';

const copy = (value) => structuredClone(value);
const need = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function chapterProgress(world) {
  // Legacy v1 worlds are read as-is. These original flags do not fabricate
  // party members, gear, or a pending opening during load.
  return {
    kai_joined: world.party.some((role) => role.id === '002'),
    invitation_complete: Boolean(world.flags[51] & 1),
    equipment_ready: Boolean(world.flags[48] & 1),
  };
}

export class ChapterRunner {
  constructor({
    world,
    data,
    say,
    choose = null,
    animate,
    transfer,
    battle,
    service,
    sound = () => {},
    objectData = null,
    objectInteraction = async () => {},
    objectAnimation = async () => {},
    wait = playbackDelay,
    setPhase = () => {},
    log = () => {},
    content = runtimeContent,
    worldMapState,
  }) {
    validateChapterStory(data);
    Object.assign(this, {
      world,
      data: data.version === 2 ? data : copy(data),
      objectData: data.version === 2 ? objectData : copy(objectData),
      objectInteraction,
      objectAnimation,
      say,
      choose,
      animate,
      transfer,
      battle,
      service,
      sound,
      wait,
      setPhase,
      log,
      content,
      worldMapState,
    });
    if (data.version === 1)
      this.data.flows = Object.fromEntries(
        Object.values(this.data.maps)
          .filter((table) => table.dialogue_status !== 'source-file-absent')
          .map((table) => {
            const flow = compileTlkFlow(table, {choices: chapterChoices});
            return [flow.id, flow];
          }),
      );
    if (data.version === 1)
      for (const table of Object.values(this.data.maps))
        for (const descriptor of table.descriptors ?? []) {
          if (
            descriptor.state_raw === 1 &&
            storyBindings(table.id, content).triggers.includes(descriptor.id)
          ) {
            const flow = compileNativeTriggerFlow(table, descriptor);
            this.data.flows[flow.id] = flow;
          }
        }
    this.flowRunner = new StoryFlowRunner(
      Object.fromEntries(
        [
          'record',
          'say',
          'choice',
          'animation',
          'give_item',
          'restore_party',
          'request_save',
          'set_native_object',
          'wait',
          'test_native_condition',
          'test_native_combination',
          'random_jump',
          'change_native_money',
          'native_service',
          'native_special_service',
          'native_sound',
          'learn_native_skill',
          'native_noop',
          'unlock_recipe',
          'set_native_sequence',
          'append_native_sequence',
          'world_map_command',
          'transfer_native_map',
          'native_battle',
          'restore_native_resources',
        ].map((op) => [op, (command, execution) => this.applyFlowCommand(op, command, execution)]),
      ),
    );
    this.running = false;
  }
  triggerHasEffect(mapId, triggerId) {
    const table = this.data.maps[mapId];
    const descriptor = table?.descriptors?.find((row) => row.id === triggerId);
    if (descriptor?.state_raw !== 2) return true;
    const flow = this.data.flows?.[nativeFlowId(mapId)];
    const world = this.world.value;
    return !isEmptyStoryFlowPath(flow, flow?.entries?.[descriptor.field_26_raw], world, (command) => {
      const record = table.records.find((row) => row.id === command.record_id);
      if (!record) return undefined;
      // An incorrect sequence resets its input count as part of execution.
      if (command.op === 'test_native_condition' && record.condition_type === NATIVE_SEQUENCE_MATCH_CONDITION)
        return undefined;
      return command.op === 'test_native_condition'
        ? evaluateNativeStoryCondition(record, world, table)
        : evaluateNativeStoryCombination(record, world, table);
    });
  }
  async runTrigger({mapId, triggerId, playback} = {}) {
    const table = this.data.maps[mapId],
      descriptor = table?.descriptors.find((row) => row.id === triggerId);
    need(
      this.world.location.map_id === mapId &&
        storyBindings(mapId, this.content).triggers.includes(triggerId) &&
        descriptor &&
        [1, 2].includes(descriptor.state_raw),
      '原地形触发器尚未接入',
    );
    if (descriptor.state_raw === 2)
      return this.runTlk({mapId, triggerId, recordId: descriptor.field_26_raw, playback});
    const flow = this.data.flows?.[nativeTriggerFlowId(mapId, triggerId)];
    need(flow, '原DAT演出触发流程缺失');
    return this.atomic({mapId, eventId: flow.id, playback}, (draft) =>
      this.flowRunner.execute(flow, {draft, context: {steps: 0, playback}}),
    );
  }
  async runTlk({mapId, recordId, triggerId, draft, context = {steps: 0}, playback = context.playback} = {}) {
    if (playback) context.playback = playback;
    if (triggerId !== undefined) {
      const table = this.data.maps[mapId],
        descriptor = table?.descriptors.find((row) => row.id === triggerId);
      need(
        storyBindings(mapId, this.content).triggers.includes(triggerId) &&
          descriptor?.state_raw === 2 &&
          descriptor.field_26_raw === recordId,
        '原地形触发器与剧情入口不同',
      );
      context.transition = {mapId, triggerId, triggerRecordId: recordId};
    }
    if (draft) return this.walkTlk({mapId, recordId, draft, context});
    context.deferTransferRelease = true;
    let completed = false;
    try {
      const result = await this.atomic({mapId, recordId, playback}, (next) =>
        this.walkTlk({mapId, recordId, draft: next, context}),
      );
      completed = true;
      return result;
    } finally {
      for (const release of (context.transferReleases ?? []).splice(0).reverse())
        release({failed: !completed});
      delete context.deferTransferRelease;
    }
  }
  async runEvent(event, {playback} = {}) {
    need(event.map_id === this.world.location.map_id, 'NPC 事件不在当前地图');
    const flow = this.data.flows?.[event.flow_id];
    need(flow && flow.id === event.flow_id && flow.map_id === event.map_id, 'NPC 剧情流程缺失');
    return this.atomic({mapId: event.map_id, eventId: event.id, playback}, (draft) =>
      this.flowRunner.execute(flow, {draft, context: {steps: 0, explicitInteraction: true, playback}}),
    );
  }
  async runRest({explicitInteraction = false, descriptorId = null, playback} = {}) {
    need(explicitInteraction === true, '休息需要主动操作床铺');
    const mapId = this.world.location.map_id,
      table = this.data.maps[mapId];
    const binding = storyBindings(mapId, this.content).rests.find(
      (row) => descriptorId === null || row.descriptor_id === descriptorId,
    );
    need(binding && table, '当前地点没有已恢复的休息入口');
    const descriptor = table.descriptors?.find((row) => row.id === binding.descriptor_id);
    need(
      descriptor?.state_raw === 2 &&
        descriptor.field_26_raw === binding.record_id &&
        descriptor.field_2a_raw === 0 &&
        descriptor.field_2e_raw === 1 &&
        descriptor.source?.sha256 === this.data.source_hashes[descriptor.source.path],
      '床铺原始剧情入口缺失',
    );
    return this.runTlk({
      mapId,
      recordId: binding.record_id,
      context: {steps: 0, explicitInteraction: true},
      playback,
    });
  }
  async atomic({mapId, recordId, objectIndex, eventId, playback}, execute) {
    need(!this.running, '当前剧情正在执行');
    this.running = true;
    const before = this.world.snapshot(),
      next = copy(before);
    try {
      playback?.check();
      this.setPhase('event');
      if (playback?.paused) await playback.ready();
      const result = await execute(next);
      if (playback?.paused) await playback.ready();
      playback?.check();
      need(this.world.value.revision === before.revision, '世界状态在剧情执行期间发生变化');
      next.revision = (before.revision + 1) >>> 0;
      validateWorld(next, this.world.mapIds);
      this.world.replace(next);
      this.log({
        type: 'chapter-commit',
        mapId,
        recordId,
        revision: next.revision,
        ...(eventId ? {event: eventId} : {}),
        ...(objectIndex === undefined ? {} : {objectIndex}),
        commit_policy: 'remake-atomic-success',
        native_mutation_timing: 'record-entry',
      });
      return {...result, world: this.world.snapshot()};
    } catch (error) {
      this.log({
        type: 'chapter-failed',
        mapId,
        recordId,
        objectIndex,
        committed: false,
        error: error.message,
      });
      throw error;
    } finally {
      this.running = false;
      this.setPhase('map');
    }
  }
  objectFor(mapId, objectIndex) {
    const binding = storyBindings(mapId, this.content).objects.find((row) => row.index === objectIndex);
    need(
      binding &&
        [
          'stationary-chest',
          'keyed-chest',
          'tlk-object',
          'scripted-switch',
          'scripted-object',
          'toggle-object',
          'mechanism',
        ].includes(binding.handler),
      '剧情物件行为尚未接入',
    );
    const table = this.data.maps[mapId],
      object = table?.objects.find((row) => row.index === objectIndex);
    need(object, '剧情物件来源缺失');
    const b = bytes(object.raw_hex, 0x112, '剧情物件'),
      v = view(b);
    need(object.source?.sha256 === this.data.source_hashes[object.source.path], '剧情箱子来源无效');
    const chest = binding.handler === 'keyed-chest' ? nativeKeyedChest(object) : null;
    const toggle = binding.handler === 'toggle-object' ? nativeToggleObject(object) : null;
    const mechanism = binding.handler === 'mechanism' ? nativeMapMechanism(object) : null;
    const repeatable = binding.handler === 'tlk-object';
    if (!chest && !toggle && !mechanism) {
      if (repeatable) need(b[0xcf] === 1 && b[0x109] === 0, '剧情物件来源或状态类型无效');
      else if (binding.handler === 'scripted-switch') {
        need(b[0xcf] === 9 && v.getUint32(0xf6, true) > 0, '机关剧情入口无效');
        nativeAnmObjectTarget(
          {u32_plus5: table.map_flag_index, u32_plus25: objectIndex + 1, byte_plus29: 0},
          mapId,
          this.data,
        );
      } else {
        nativeScriptedChest(object);
        need(binding.handler !== 'scripted-object' || b[0xcf] === 2, '脚本物件原行为类型不符');
      }
      need(
        table.records.some((row) => row.id === v.getUint32(0xf6, true)),
        '剧情物件入口缺失',
      );
    }
    if (this.objectData) {
      const manifest = this.objectData[mapId]?.find((row) => row.object_index_zero_based === objectIndex);
      need(
        manifest?.source?.path === object.source.path &&
          manifest.source.offset === object.source.offset &&
          manifest.source.sha256 === object.source.sha256 &&
          manifest.source.raw_hex === object.raw_hex,
        '剧情物件清单与原始地图不一致',
      );
    }
    return {
      table,
      object,
      recordId: v.getUint32(0xf6, true),
      chest,
      toggle,
      mechanism,
      repeatable,
      scriptedSwitch: binding.handler === 'scripted-switch',
      interactionActionGroup: b[0xb5],
    };
  }
  async runObject({mapId, objectIndex, playback} = {}) {
    need(!this.running, '当前剧情正在执行');
    const {table, object, recordId, chest, toggle, mechanism, repeatable, scriptedSwitch, interactionActionGroup} =
      this.objectFor(mapId, objectIndex);
    need(this.world.location.map_id === mapId, '剧情物件不在当前地图');
    if (mechanism) return this.runMapMechanism({table, object, mechanism, interactionActionGroup, playback});
    if (repeatable)
      return this.runTlk({
        mapId,
        recordId,
        playback,
        context: {steps: 0, explicitInteraction: true, objectMapId: mapId, objectIndex},
      });
    const initialState = chapterObjectState(this.world.snapshot(), mapId, objectIndex, this.data);
    if (initialState === 3)
      return {mapId, objectIndex, already_done: true, state: 3, world: this.world.snapshot()};
    need([0, 1, 2].includes(initialState), '剧情物件保存状态尚未接入');
    // 4137C0 -> 412640 -> 4121D0 starts the ordinary actor action before
    // 411F50 checks possession. It is independent of the action+7F strike.
    const interaction =
      initialState === 2 || scriptedSwitch
        ? null
        : this.objectInteraction({
            mapId,
            objectIndex,
            object,
            actionGroup: interactionActionGroup,
            playback,
            signal: playback?.signal,
          });
    if (chest && initialState !== 2 && !canOpenNativeChest(this.world.snapshot(), chest)) {
      await interaction;
      playback?.check();
      return {
        mapId,
        objectIndex,
        locked: true,
        key_id: chest.keyId,
        state: initialState,
        world: this.world.snapshot(),
      };
    }
    return this.atomic({mapId, recordId, objectIndex, playback}, async (draft) => {
      let result = {traversed: [], dialogueIds: []};
      // Source 0x4137C0 clears pending state1 before dispatching +F6.
      // Saved state2 means its event already ran: finish the animation only.
      if (chest || toggle) setObjectEventState(draft, table.map_flag_index, objectIndex, 2);
      else {
        if (initialState === 1) setObjectEventState(draft, table.map_flag_index, objectIndex, 0);
        if (initialState !== 2)
          result = await this.walkTlk({
            mapId,
            recordId,
            draft,
            context: {steps: 0, playback, explicitInteraction: true, objectMapId: mapId, objectIndex},
          });
      }
      let state = chapterObjectState(draft, mapId, objectIndex, this.data);
      if (state === 2) {
        playback?.check();
        // An ANM may already have unloaded this object map. Native 40C5C0
        // persists completed state for an off-map target without replaying it.
        await Promise.all([
          interaction,
          ...(draft.location.map_id === mapId
            ? [
                this.objectAnimation({
                  mapId,
                  objectIndex,
                  draft,
                  source: object.source,
                  fromState: 2,
                  toState: 3,
                  playback,
                  signal: playback?.signal,
                }),
              ]
            : []),
        ]);
        playback?.check();
        if (chest) {
          for (const reward of chest.rewards) {
            // Reward work stays inside the existing atomic-success policy.
            // A full inventory cannot silently consume a direct chest here.
            need(
              draft.inventory.length < 1000 ||
                draft.inventory.some(
                  (row) =>
                    row.id === 0 ||
                    (row.id === reward.id && bytes(row.source_raw_hex, 0xe5, '背包')[0x0c] === 0),
                ),
              '背包已满，宝箱奖励无法接收',
            );
            this.applyMutation(
              draft,
              table,
              {
                id: `object-${objectIndex}-${reward.slot}`,
                mutation_type: 5,
                mutation_index: 0,
                mutation_bit: reward.id,
              },
              {itemInitializationSource: 'native-object-447DE0-47BCF0-469820-47BFF0-47BDC0'},
            );
          }
          result.rewards = copy(chest.rewards);
        }
        setObjectEventState(draft, table.map_flag_index, objectIndex, 3);
        state = 3;
      }
      await interaction;
      playback?.check();
      return {...result, mapId, objectIndex, state, already_done: false};
    });
  }
  async runMapMechanism({table, object, mechanism, interactionActionGroup, playback}) {
    const mapId = table.id, mapFlag = table.map_flag_index, objectIndex = object.index;
    const world = this.world.snapshot();
    const initialState = chapterObjectState(world, mapId, objectIndex, this.data);
    const enabled = initialState === 2 || restingMapMechanismState(initialState) === 0;
    if (!enabled && !mechanism.reversible)
      return {mapId, objectIndex, already_done: true, mechanism: true, state: 3, world};
    const undo = [];
    try {
      return await this.atomic({mapId, objectIndex, playback}, async draft => {
        await this.objectInteraction({
          mapId, objectIndex, object, actionGroup: interactionActionGroup, playback, signal: playback?.signal,
        });
        playback?.check();
        if (enabled && initialState !== 2 && !hasNativeObjectKey(draft, mechanism.keyId)) {
          return {mapId, objectIndex, locked: true, mechanism: true, key_id: mechanism.keyId, state: initialState};
        }
        const visited = new Set();
        let current = object, currentMechanism = mechanism, opening = enabled;
        while (current) {
          need(!visited.has(current.index), '地图机关存在循环联动');
          visited.add(current.index);
          const fromState = opening ? 2 : 5, toState = opening ? 3 : 0;
          setObjectEventState(draft, mapFlag, current.index, fromState);
          const restore = await this.objectAnimation({
            mapId, objectIndex: current.index, draft, source: current.source,
            fromState, toState, playback, signal: playback?.signal,
          });
          if (typeof restore === 'function') undo.push(restore);
          playback?.check();
          setObjectEventState(draft, mapFlag, current.index, toState);
          const target = currentMechanism.target;
          if (!target) break;
          // 40ED70 writes the remote pose. Store its settled state directly.
          // On the same map, the target animates and may link onward.
          if (target.mapFlag && target.mapFlag !== mapFlag) {
            setObjectEventState(draft, target.mapFlag, target.index, toState);
            break;
          }
          current = table.objects.find(row => row.index === target.index);
          currentMechanism = nativeMapMechanism(current, {linked: true});
          opening = restingMapMechanismState(chapterObjectState(draft, mapId, current.index, this.data)) === 0;
          if (!opening && !currentMechanism.reversible) break;
        }
        return {mapId, objectIndex, mechanism: true, state: enabled ? 3 : 0};
      });
    } catch (error) {
      for (const restore of undo.reverse()) restore();
      throw error;
    }
  }
  async walkTlk({mapId, recordId, draft, context = {steps: 0}}) {
    const flow = this.data.flows?.[nativeFlowId(mapId)],
      entry = flow?.entries?.[recordId];
    need(entry && Number.isInteger(recordId) && recordId > 0, `剧情入口 ${mapId}:${recordId} 未接入`);
    context.transferDepth = (context.transferDepth ?? 0) + 1;
    let completed = false;
    try {
      const result = await this.flowRunner.execute(flow, {entry, draft, context});
      completed = true;
      return {
        mapId,
        recordId,
        ...result,
        save_requested: Boolean(context.saveRequested),
        world_map_requested: context.worldMapRequested ?? null,
      };
    } finally {
      if (--context.transferDepth === 0 && !context.deferTransferRelease) {
        for (const release of (context.transferReleases ?? []).splice(0).reverse())
          release({failed: !completed});
      }
    }
  }
  applyFlowCommand(op, command, {mapId, flowId, draft, context}) {
    const table = this.data.maps[mapId],
      native = flowId === nativeFlowId(mapId),
      playback = context.playback;
    const record = native
      ? table?.records.find((row) => row.id === command.record_id)
      : {
          ...command.presentation,
          id: command.record_id,
          text_raw: command.text,
          source: command.source,
          ...(typeof command.speaker === 'string' ? {speaker_name: command.speaker} : {}),
        };
    if (op === 'random_jump') {
      draft.encounters ??= initialEncounterState(draft.party);
      const rng = createNativeRng(draft.encounters.rng_state),
        roll = rng() % 100;
      draft.encounters.rng_state = rng.state;
      this.log({type: 'chapter-random', mapId, recordId: record.id, roll});
      return roll;
    }
    if (op === 'native_sound') {
      // 462600 calls 4BAFA0 with TLK+37, then immediately follows next.
      this.sound({token: command.token, playback, signal: playback?.signal});
      return;
    }
    if (op === 'record') {
      need(record, '剧情记录缺失');
      if (storyBindings(mapId, this.content).rests.some((row) => row.restore_records.includes(record.id)))
        need(context.explicitInteraction === true, '休息需要主动操作床铺');
      this.log({type: 'chapter-record', mapId, recordId: record.id, source: command.source});
      return;
    }
    if (op === 'transfer_native_map') {
      const transition =
        context.transition?.mapId === mapId
          ? context.transition
          : context.explicitInteraction && context.npcMapId === mapId
            ? {npcSlot: context.npcSlot, sortCode: draft.native_map_sort_code ?? 1}
            : context.explicitInteraction && context.objectMapId === mapId
              ? {objectIndex: context.objectIndex, sortCode: draft.native_map_sort_code ?? 1}
              : null;
      need(native && record && transition, '地图跳转缺少原地形触发器或主动交互');
      const destination = nativeMapTransfer(table, record, transition, this.content);
      need(typeof this.transfer === 'function', '地图跳转显示接口缺失');
      return (async () => {
        playback?.check();
        const result = await this.transfer({mapId, destination, draft, playback, signal: playback?.signal});
        if (result?.release) (context.transferReleases ??= []).push(result.release);
        playback?.check();
        need(result?.location?.map_id === destination.map_id, '地图跳转未返回原目标位置');
        draft.location = copy(result.location);
        draft.native_map_sort_code = destination.sort_code;
        const entry = storyBindings(destination.map_id, this.content).entry_record;
        if (entry) await this.runTlk({mapId: destination.map_id, recordId: entry, draft, context, playback});
        return destination;
      })();
    }
    if (op === 'test_native_condition') {
      need(native && record, '条件缺少原剧情来源');
      return evaluateNativeStoryCondition(record, draft, table);
    }
    if (op === 'test_native_combination') {
      need(native && record, '组合条件缺少原剧情来源');
      return evaluateNativeStoryCombination(record, draft, table);
    }
    if (op === 'native_service' || op === 'native_special_service') {
      need(
        native && record && context.explicitInteraction === true && typeof this.service === 'function',
        '原城镇服务接口缺失或没有主动交互入口',
      );
      return (async () => {
        playback?.check();
        const result = await this.service({mapId, table, record, draft, playback, signal: playback?.signal});
        playback?.check();
        return result;
      })();
    }
    if (op === 'native_battle') {
      need(native && record && typeof this.battle === 'function', '原剧情战斗接口缺失');
      const group = nativeScriptedBattle(table, record, this.content);
      return this.battle({group, draft, playback, signal: playback?.signal});
    }
    if (op === 'say') {
      need(typeof this.say === 'function', '剧情对白显示接口缺失');
      return this.say({
        mapId,
        record: {...record, text_raw: command.text},
        source: command.source,
        draft,
        playback,
        signal: playback?.signal,
      });
    }
    if (op === 'choice') {
      need(
        context.explicitInteraction === true || context.transition?.mapId === mapId,
        '剧情选择需要已恢复的主动交互入口',
      );
      const rest = storyBindings(mapId, this.content).rests.find((row) => row.record_id === record.id);
      if (rest) chapterRestChoices(record, rest);
      need(typeof this.choose === 'function', '剧情选择显示接口缺失');
      return this.choose({
        mapId,
        record,
        choices: copy(command.choices),
        draft,
        playback,
        signal: playback?.signal,
      });
    }
    if (op === 'animation') {
      const program = this.data.programs?.[command.program_id];
      need(program && typeof this.animate === 'function', `剧情演出 ${command.program_id} 尚未接入`);
      return this.animate({
        program,
        mapId,
        draft,
        playback,
        signal: playback?.signal,
        runTlk: (args) => this.runTlk({...args, draft, context}),
        joinActor: (args) => this.joinActor({...args, draft}),
        leaveActor: (args) => this.leaveActor({...args, draft}),
        flagCommand: ({command, mapId: activeMap}) => {
          const active = this.data.maps[activeMap];
          need(active, '剧情旗标地图来源缺失');
          return applyNativeAnmFlagCommand(draft, command, active.map_flag_index);
        },
        objectCommand: ({command, mapId: activeMap}) => {
          const target = nativeAnmObjectTarget(command, activeMap, this.data);
          if (!target) return null;
          const {mapId, mapFlag, objectIndex, enabled, behavior} = target;
          if (mapId !== activeMap) {
            setObjectEventState(draft, mapFlag, objectIndex, enabled ? 3 : 0);
            return null;
          }
          if (!enabled && behavior === 9) return null;
          const before = chapterObjectState(draft, mapId, objectIndex, this.data);
          if ((enabled && before === 3) || (!enabled && before === 0)) return null;
          const state = enabled ? 2 : 5;
          setObjectEventState(draft, mapFlag, objectIndex, state);
          return {
            mapId,
            objectIndex,
            state,
            complete: () => setObjectEventState(draft, mapFlag, objectIndex, enabled ? 3 : 0),
          };
        },
      });
    }
    if (op === 'wait') return playback ? playback.wait(command.ms) : this.wait(command.ms);
    need(native && record, '原剧情行为记录缺失');
    this.applyMutation(draft, table, record, context);
    if (
      record.mutation_type === 1 &&
      record.mutation_bit &&
      (record.mutation_index === 0 || record.mutation_index === table.map_flag_index)
    ) {
      const objectIndex = record.mutation_bit - 1,
        object = table.objects.find((row) => row.index === objectIndex);
      if (
        [2, 9].includes(object?.behavior_raw_cf) &&
        chapterObjectState(draft, table.id, objectIndex, this.data) === 2
      )
        return (async () => {
          await this.objectAnimation({
            mapId: table.id,
            objectIndex,
            draft,
            playback,
            signal: playback?.signal,
          });
          playback?.check();
          setObjectEventState(draft, table.map_flag_index, objectIndex, 3);
        })();
    }
  }
  applyMutation(draft, table, record, context = {}) {
    if ([3, 7, 8, 10, 11, 14, 16, 17].includes(record.mutation_type))
      return applyNativeStoryMutation(draft, record, {roleDefinitions: this.data.role_definitions});
    if (record.mutation_type === 9) {
      const request = applyWorldMapCommandToDraft(
        draft,
        {mode: record.mutation_index, area: record.region_byte_raw, destination: record.mutation_bit},
        {initialState: this.worldMapState},
      );
      if (request) context.worldMapRequested = request;
      return;
    }
    if (record.mutation_type === 4) {
      need(
        context.explicitInteraction === true && record.mutation_index === 0 && record.mutation_bit === 0,
        '存档需要主动交互入口',
      );
      // Native 0x464d80 case4 clears dialogue then opens 0x4794e0. Defer UI
      // until the complete story transaction commits and exploration resumes.
      context.saveRequested = true;
      this.log({
        type: 'chapter-save-request',
        mapId: table.id,
        recordId: record.id,
        source: record.source,
        native_handler: '0x464d80:case4',
      });
      return;
    }
    if (record.mutation_type === 2) {
      need(
        (context.explicitInteraction === true ||
          storyBindings(table.id, this.content).rests.some((row) =>
            row.restore_records.includes(record.id),
          )) &&
          record.mutation_index === 0 &&
          record.mutation_bit === 0,
        '剧情恢复行为尚未接入',
      );
      const resources = restorePartyAfterRest(draft);
      this.log({
        type: 'chapter-restored',
        mapId: table.id,
        recordId: record.id,
        resources,
        source: record.source,
        native_handler: '0x461861',
      });
      return;
    }
    if (record.mutation_type === 1) {
      need(
        [0, 1].includes(record.region_byte_raw) &&
          flagIndex(record.mutation_index) &&
          Number.isInteger(record.mutation_bit) &&
          record.mutation_bit >= 0 &&
          record.mutation_bit <= 1000,
        '剧情物件状态变更尚未接入',
      );
      need(
        record.region_byte_raw === 0 ||
          (record.mutation_index !== 0 && record.mutation_index !== table.map_flag_index),
        '当前地图物件反播TLK尚未接入',
      );
      if (record.mutation_bit === 0) return;
      const active = table,
        objectIndex = record.mutation_bit - 1;
      const mapFlag = record.mutation_index || active.map_flag_index;
      // 464D80 case1 passes TLK +27/+2B and byte+7 to 40C5C0.
      // Current map: start state2 unless complete; another map: persist3.
      if (mapFlag === active.map_flag_index) {
        const object = active.objects.find((row) => row.index === objectIndex);
        if ([2, 9].includes(object?.behavior_raw_cf))
          nativeAnmObjectTarget(
            {u32_plus5: mapFlag, u32_plus25: objectIndex + 1, byte_plus29: 0},
            active.id,
            this.data,
          );
        else this.objectFor(active.id, objectIndex);
        if (chapterObjectState(draft, active.id, objectIndex, this.data) !== 3)
          setObjectEventState(draft, mapFlag, objectIndex, 2);
      } else {
        // 464D80 case1 always passes arg3=1 to40C5C0. For another map,
        // mode1 in arg4 is ignored and the source event state remains3.
        setObjectEventState(draft, mapFlag, objectIndex, 3);
      }
      return;
    }
    if (record.mutation_type === 5) {
      if (record.mutation_index !== 0) {
        const result = removeNativeStoryItem(draft, record.mutation_bit);
        this.log({
          type: 'chapter-item-removed',
          mapId: table.id,
          recordId: record.id,
          id: record.mutation_bit,
          ...result,
          native_handler: '0x4618FF / 0x47C8E0(-1,id)',
        });
        return result;
      }
      const result = giveNativeStoryItem(draft, this.data.item_definitions?.[record.mutation_bit], {
        sourceHashes: this.data.source_hashes,
        instanceId: `chapter-${table.id}-${record.id}-${draft.revision}-${draft.inventory.length}`,
        initializationSource: context.itemInitializationSource,
      });
      if (result.full) this.log({type: 'chapter-inventory-full', id: record.mutation_bit, native_capacity: 1000});
      return result;
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
    const id = Object.keys(this.content.roles).find(
      (id) => this.content.roles[id].side === 'player' && this.content.roles[id].native_slot === actorSlot,
    );
    need(id && [0, 1, 3].includes(modeRaw) && draft, '剧情入队角色或模式尚未接入');
    if (modeRaw === 3) {
      const result = controlPartyActor(draft, id, {content: this.content});
      this.log({type: 'chapter-control', actorSlot, modeRaw, ...result});
      return result;
    }
    const result = admitPartyMember(draft, id, {
      definitions: this.data.role_definitions,
      content: this.content,
    });
    if (!result.added) return result;
    this.log({
      type: 'chapter-join',
      actorSlot,
      modeRaw,
      ...result,
      evidence: [
        'ev_fd3e9e25a462ab6603ac334f9da52bed0b8b6590039f4b9655186099bc542eda',
        'ev_12df7bc4462bc0b911805dff6085f4bc98d698f681847adf18ee0aca472088f9',
      ],
    });
    return {id, added: true, ...(result.reactivated ? {reactivated: true} : {})};
  }
  leaveActor({actorSlot, draft}) {
    const id = Object.keys(this.content.roles).find(
      (id) => this.content.roles[id].side === 'player' && this.content.roles[id].native_slot === actorSlot,
    );
    need(id && draft, '剧情离队角色尚未接入');
    const result = deactivatePartyMember(draft, id, {content: this.content});
    this.log({type: 'chapter-departure', actorSlot, ...result, native_handler: '0x4B6660 / 0x45E560'});
    return result;
  }
}
