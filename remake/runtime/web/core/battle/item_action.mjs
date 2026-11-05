import {consumeInventoryItem, restoreActorWithItem} from '../items/items.mjs';
import {applyEncounterItemEffect, initialEncounterState} from '../exploration/encounters.mjs';
import {commandForActor, dispatchItemCharge, setIdleSkill} from './battle_scheduler.mjs';
import {selectNativeRevivalAnimation} from './battle_reactions.mjs';

const copy = (value) => structuredClone(value);

/**
 * 执行一次已调度的药品行动。context 只包含本场规则数据及所需回调。
 * 库存先规划，在原动作的 onUse 接触点重新检查目标后才消耗；重复接触不重复提交。
 * 这里只修改本场战斗，世界回写由结算或外层剧情事务负责。
 */
export async function executeItemAction(context, {attacker, target, instanceId, skillId}) {
  const {state, items, statuses, reactions, schedulerData, rng, now, playTime, getWorld, hooks} = context;
  const scheduler = state.scheduler;
  const consumed = consumeInventoryItem(state.inventory, instanceId, items);
  const definition = items.definitions[String(consumed.item.id)];
  let result = {name: definition.name};
  let committed = false;

  hooks.setActiveItem(instanceId);
  const charge = dispatchItemCharge(attacker, scheduler);
  const actionId = `${state.id}:${state.action_count + 1}`;
  state.phase = 'action';
  hooks.publish();

  const onUse = () => {
    if (!committed) {
      hooks.checkWorld();
      const before = copy(target);
      const group = Boolean(definition.battle?.all_targets_raw_156);
      // 原 41B3C0：指令发出后，载体或状态仍可能使目标失效；此时不消耗药品。
      const targets = group
        ? state.actors.filter((actor) => hooks.targetAvailable(actor, instanceId, attacker))
        : [target];
      const groupResults = [];

      for (const member of targets) {
        const used = hooks.targetAvailable(member, instanceId, attacker)
          ? restoreActorWithItem(member, consumed.item, items, {
              statusData: statuses,
              caster: attacker,
              rng,
              selectAnimation: (actor, {rng}) => selectNativeRevivalAnimation({actor, data: reactions, rng}),
            })
          : {
              actor: copy(member),
              name: result.name,
              changes: {},
              applied: false,
              native_return: 0,
              effect_requested: false,
              cancel_command: false,
              trace: [],
            };

        if (used.effect_requested) {
          if (used.revived) hooks.revive(member, used);
          else Object.assign(member, used.actor);
        }
        if (used.encounter_effect) {
          const world = getWorld();
          state.encounters = applyEncounterItemEffect(
            state.encounters ?? world.encounters ?? initialEncounterState(world.party),
            used.encounter_effect,
            playTime(),
          );
        }
        if (used.cancel_command) {
          const command = commandForActor(scheduler, member.id);
          if (command) hooks.cancelCommand(command, 'actor-status');
        }
        groupResults.push({
          target_id: member.id,
          hit: true,
          damage: 0,
          item_used: used.applied,
          item_effect: used.effect_requested,
          native_return: used.native_return,
          remainingHp: member.hp.current,
          changes: used.changes,
          trace: used.trace,
          revived: Boolean(used.revived),
        });
      }

      const used = groupResults.some((row) => row.item_used);
      const effect = groupResults.some((row) => row.item_effect);
      result = {
        name: definition.name,
        applied: used,
        effect_requested: effect,
        native_return: Number(used),
        revived: groupResults.some((row) => row.revived),
        changes: groupResults[0]?.changes ?? {},
        trace: groupResults.flatMap((row) => row.trace),
        group_results: groupResults,
      };
      if (result.applied) state.inventory = consumed.inventory;
      committed = true;
      hooks.setActiveItem(null);
      state.action_count++;

      const entry = {
        action_id: actionId,
        actor_id: attacker.id,
        target_id: target.id,
        skill_id: skillId,
        item_id: consumed.item.id,
        round: state.round,
        impact: false,
        result: {
          hit: true,
          damage: 0,
          changes: result.changes,
          native_return: result.native_return,
          item_used: result.applied,
          item_effect: result.effect_requested,
          trace: result.trace,
          ...(group ? {group_results: groupResults} : {}),
        },
        before,
        after: copy(target),
      };
      const historyIndex = state.history.push(entry) - 1;
      hooks.recordImpact(entry, historyIndex);
      hooks.log({type: 'battle-item-used', battle_id: state.id, ...copy(entry), name: result.name, charge});
      hooks.publish();
    }
    return {
      hit: true,
      damage: 0,
      item_used: result.applied,
      item_effect: result.effect_requested,
      native_return: result.native_return,
      group_results: result.group_results,
      ...(!result.effect_requested ? {skipped: 'item-target-unavailable'} : {}),
      revived: Boolean(result.revived),
      remainingHp: target.hp.current,
    };
  };

  await hooks.playItem(
    {
      action_id: actionId,
      actor_id: attacker.id,
      target_id: target.id,
      item_id: consumed.item.id,
      name: result.name,
      skill_id: skillId,
    },
    {onUse},
  );
  hooks.checkWorld();
  if (!committed) throw new Error('道具原动作没有触发使用事件');
  scheduler.active_actor_id = null;
  setIdleSkill(attacker, schedulerData, now());
  state.round++;
}
