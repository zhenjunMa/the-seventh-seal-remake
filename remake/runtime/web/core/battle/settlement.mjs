const copy = (value) => structuredClone(value);

/** 将本场人物投影回世界结构；不自行提交 WorldStore。 */
export function writeBattleResources(world, resourcesByActor) {
  for (const [id, resources] of Object.entries(resourcesByActor)) {
    const role = world.party.find((actor) => actor.id === id);
    role.hp.current = resources.hp;
    role.mp.current = resources.mp;
    if (resources.header_raw_hex) {
      role.combat_progress = {header_raw_hex: resources.header_raw_hex};
      role.hp.maximum = resources.hp_maximum;
      role.mp.maximum = resources.mp_maximum;
      role.attributes_stored = resources.attributes_stored;
    }
  }
}

/** 保留原 DWORD 资源位模式；只验证回写值，不改变战斗人物。 */
export function captureBattleResources(players, resourcesForWorld) {
  const resources = Object.fromEntries(players.map((player) => [player.id, resourcesForWorld(copy(player))]));
  for (const row of Object.values(resources)) {
    for (const key of ['hp', 'mp']) {
      if (!Number.isInteger(row[key]) || row[key] < 0 || row[key] > 0xffffffff) {
        throw new Error(`回写${key}无效`);
      }
    }
  }
  return resources;
}

export function hasBattleWorldChanges(before, state, resources, rewards) {
  if (rewards?.applied || state.encounters) return true;
  if (state.inventory && JSON.stringify(state.inventory) !== JSON.stringify(before.inventory)) return true;
  return Object.entries(resources).some(([id, row]) => {
    const role = before.party.find((actor) => actor.id === id);
    return (
      role.hp.current !== row.hp ||
      role.mp.current !== row.mp ||
      (row.header_raw_hex !== undefined && role.combat_progress?.header_raw_hex !== row.header_raw_hex)
    );
  });
}

/** 在调用者的事务草稿中一次性应用资源、库存与已规划奖励。 */
export function applyBattleSettlement(draft, state, resources, rewards) {
  writeBattleResources(draft, resources);
  if (state.inventory) draft.inventory = copy(state.inventory);
  if (state.encounters) draft.encounters = copy(state.encounters);
  if (rewards?.applied) {
    Object.assign(draft, copy(rewards.world_patch));
    draft.reward_records ??= [];
    if (draft.reward_records.some((row) => row.battle_id === state.id)) throw new Error('奖励已经提交');
    draft.reward_records.push(copy(rewards.reward_record));
  }
}
