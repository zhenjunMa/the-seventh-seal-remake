// Runtime dependencies are independent of atlas packing and combat eligibility.
// Exporters keep the full inventory; live battles prepare base poses first.
export function effectReferences(value, result = new Set()) {
  if (Array.isArray(value)) value.forEach(row => effectReferences(row, result));
  else if (value && typeof value === 'object' && !value.missing_source_file) {
    for (const key of ['asset_id', 'effect_asset_id', 'effect_id', 'carrier_asset_id']) {
      if (typeof value[key] === 'string') result.add(value[key]);
    }
    if (value.command_raw === 4 && /^(?:[a-f0-9]{2}){176}$/i.test(value.raw_hex ?? '')) {
      const bytes = Uint8Array.from(value.raw_hex.match(/../g), byte => parseInt(byte, 16));
      const id = new TextDecoder().decode(bytes.slice(0x4e, 0x62)).split('\0')[0].replace(/\.dgp$/i, '');
      if (id) result.add(id);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'deferred_effects' && child && typeof child === 'object') effectReferences(child, result);
    }
  }
  return result;
}

const canonical = path => '/' + path.replace(/^\/+/, '');

export class BattleAssetPlan {
  constructor({meta, itemMeta, lifecycleMeta, descriptors, layers, actors, skills, inventory}) {
    Object.assign(this, {meta, itemMeta, lifecycleMeta, skills});
    this.descriptors = new Map(descriptors.map(asset => [asset.path, asset]));
    this.actors = new Map(actors.map(actor => [actor.id, actor.resource_id ?? actor.id]));
    this.roles = new Map(meta.roles.map(role => [role.id, role]));
    this.effects = new Map();
    for (const effect of meta.effects) if (!this.effects.has(effect.id)) this.effects.set(effect.id, effect);
    this.pairs = new Map(layers.flatMap(bank => bank.frames.map(pair => [`${bank.role_id}:${pair.source_frame}`, pair])));
    this.itemIds = new Set(inventory.filter(item => item.quantity > 0).map(item => String(item.id)));
    this.base = new Set(descriptors.filter(asset => asset.owners.includes('shared')).map(asset => asset.path));
    for (const id of new Set(this.actors.values())) {
      const role = this.roles.get(id);
      if (!role) throw new Error(`战斗资源计划缺少角色：${id}`);
      this.sequence(role, {segments: role.idle_sequence?.segments ?? [role.idle, role.reaction]}, this.base);
      this.sequence(role, {segments: [role.reaction]}, this.base);
      for (const skill of role.response_skills ?? []) this.sequence(role, skill, this.base);
      const lifecycle = lifecycleMeta?.roles.find(row => row.id === id);
      for (const skill of lifecycle?.skills ?? []) {
        if (skill.source_skill?.battle_handler !== 'native-revival') this.sequence(role, skill, this.base);
      }
    }
  }

  body(role, actionIndex, frame, paths) {
    const action = role.actions.find(row => row.index === actionIndex);
    if (!action) throw new Error(`战斗资源计划缺少动作：${role.id}:${actionIndex}`);
    const pair = this.pairs.get(`${role.id}:${action.first_frame + frame}`);
    if (pair) {
      paths.add(canonical(pair.main.path));
      if (pair.intrinsic.active) paths.add(canonical(pair.intrinsic.path));
    } else paths.add(action.sheet);
  }

  addEffects(source, paths) {
    for (const id of effectReferences(source)) {
      const effect = this.effects.get(id);
      if (!effect) {
        if (this.meta.missing_effects?.some(row => row.id === id && row.source_exists === false)) continue;
        throw new Error(`战斗资源计划缺少特效：${id}`);
      }
      for (const path of effect.layer_order ? effect.layer_order.map(layer => effect[`${layer}_sheet`]) : [effect.sheet]) paths.add(path);
    }
  }

  sequence(role, skill, paths = new Set()) {
    for (const segment of skill.segments ?? []) {
      for (const frame of segment.frames) this.body(role, segment.action_index, frame, paths);
    }
    for (const step of skill.timeline ?? []) {
      if (step.kind === 'sprite') this.body(role, step.action_index, step.action_frame, paths);
    }
    this.addEffects(skill, paths);
    return paths;
  }

  skill(actorId, skillId, paths = new Set(), seen = new Set()) {
    if (seen.has(skillId)) return paths;
    seen.add(skillId);
    const skill = this.skills[skillId], role = this.roles.get(this.actors.get(actorId));
    if (!skill || skill.actor_id !== actorId || !role) throw new Error(`本场战斗没有该招式：${skillId}`);
    if (skill.battle_handler === 'combination') {
      for (const id of skill.component_skill_ids.filter(Boolean)) this.skill(actorId, id, paths, seen);
      return paths;
    }
    const source = [role.skill, ...(role.alternate_skills ?? [])].find(row =>
      row.runtime_skill_id === skillId || Number.isInteger(skill.original_skill_index) && (row.chr_skill_index === skill.original_skill_index ||
      row.source_skill?.original_skill_index === skill.original_skill_index));
    if (!source) throw new Error(`招式缺少资源依赖：${skillId}`);
    return this.sequence(role, source, paths);
  }

  item(actorId, itemId, paths = new Set()) {
    if (!this.itemIds.has(String(itemId))) throw new Error(`本场背包没有该道具：${itemId}`);
    const item = this.itemMeta?.items[String(itemId)], id = this.actors.get(actorId);
    const source = this.itemMeta?.roles.find(row => row.id === id);
    if (!item || !source) throw new Error(`道具缺少资源依赖：${itemId}`);
    this.sequence(this.roles.get(id), source.sequence, paths);
    this.addEffects(item, paths);
    return paths;
  }

  action(result, compiled = null) {
    if (result.item_id !== undefined) return this.item(result.actor_id, result.item_id);
    // Validate against the battle's learned/AI command set, including compositions.
    const paths = this.skill(result.actor_id, result.skill_id);
    if (compiled) {
      const role = this.roles.get(this.actors.get(result.actor_id));
      for (const step of compiled.steps) {
        const visual = step.command_raw === undefined ? step : step.visual;
        if (visual) this.body(role, visual.action_index, visual.action_frame, paths);
      }
      this.addEffects(compiled, paths);
    }
    return paths;
  }

  assets(paths) {
    return [...paths].map(path => {
      const asset = this.descriptors.get(canonical(path));
      if (!asset) throw new Error(`战斗资源未登记：${path}`);
      return asset;
    });
  }
}
