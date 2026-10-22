/** Real CHR/DGP segments with explicitly labelled preview choreography. */
export function skillSequence(role, skill, presentation = null) {
  if (!role || !skill) throw new Error('请选择角色与技能');
  const recipe = presentation?.skills?.find(s => String(s.role_id) === role.id && s.skill_index === skill.index);
  const actions = new Map(role.actions.map(a => [a.index, a]));
  const rawRecords = new Map(skill.actions.map(a => [a.index, a]));
  const descriptors = recipe?.sequence || skill.actions.filter(a => a.type_raw === 0).map(a => ({
    chr_record_index: a.index, action_index: a.dgp_action_index,
    preview_sequence: Array.from({ length: actions.get(a.dgp_action_index)?.frames_per_direction || 0 }, (_, i) => i),
    effects: [],
  }));
  const segments = descriptors.map(segment => {
    const record = rawRecords.get(segment.chr_record_index), action = actions.get(segment.action_index);
    if (!record || record.type_raw !== 0 || !action || record.dgp_action_index !== action.index) {
      throw new Error('技能表现清单与原CHR图集索引不一致');
    }
    const frames = segment.frame_sequence || segment.preview_sequence ||
      Array.from({ length: action.frames_per_direction }, (_, i) => i);
    if (!frames.length || frames.some(frame => !Number.isInteger(frame) || frame < 0 || frame >= action.frames_per_direction)) {
      throw new Error('技能帧序超出原图集范围');
    }
    return { ...segment, record, action, frames,
      sequence_basis: segment.frame_sequence ? 'native-confirmed-frame-selection' : 'physical-frame-preview',
      effects: segment.effects || [] };
  });
  if (!segments.length) throw new Error('此技能尚无可播放的角色动作段');
  return { recipe, segments,
    omitted_command_types: [...new Set(skill.actions.filter(a => a.type_raw !== 0).map(a => a.type_raw))],
    scheduler_basis: 'ordered-CHR-image-segment-preview; complete-native-scheduler-not-implemented' };
}

/** Smooth approach/return only for presentation; never alters battle or map coordinates. */
export function previewTravel(index, length, progress) {
  if (length < 2) return 0;
  const middle = Math.floor(length / 2), t = Math.max(0, Math.min(1, progress));
  const point = index < middle ? (index + t) / Math.max(1, middle) :
    1 - (index - middle + t) / Math.max(1, length - middle);
  const clamped = Math.max(0, Math.min(1, point));
  return clamped * clamped * (3 - 2 * clamped);
}

export function sceneEnvelope(sessionId, type, detail = {}) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 100) throw new Error('战斗场景会话无效');
  return { schema: 'seventh-seal-scene', version: 1, session_id: sessionId, type, ...detail };
}

export function validSceneMessage(event, parentWindow, origin, sessionId) {
  const data = event.data;
  return event.origin === origin && event.source === parentWindow && data?.schema === 'seventh-seal-scene' &&
    data.version === 1 && data.session_id === sessionId && data.type === 'battle-enter' &&
    ['001', '002'].includes(data.context?.player_role_id) && data.context?.entry_kind === 'development_demo';
}
