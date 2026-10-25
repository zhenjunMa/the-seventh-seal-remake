/** Source-backed sprites; every HP/MP change belongs to the battle controller.
 * Entry/death/get-up use independent actor clocks and source DGP intervals.
 * Existing attack choreography and the 65 ms attack clock remain adapters.
 */

import {compileNativeSequence} from './core/skill_sequence.mjs';
import {idlePoseAt} from './core/battle_scheduler.mjs';
import {BattleLifecyclePlayback} from './battle_lifecycle_view.mjs';
import {battleViewport,battleActorPositions} from './core/battle_layout.mjs';
import {battleResources,drawBattleImage} from './core/battle_resources.mjs';
import {runtimeContent,requireRegisteredRoles} from './core/content_registry.mjs';
import {validateForestStage,forestStageAssets,drawForestStageBackground} from './forest_stage.mjs';
const clone = value => structuredClone(value);
const abortError = reason => Object.assign(new Error(reason || '战斗表现已取消'), {name: 'AbortError'});
const urlAllowed = path => typeof path === 'string' &&
  /^\/(?:assets\/|data\/)[A-Za-z0-9_./-]+$/.test(path) &&
  !path.split('/').some(part => part === '..' || part === '.');
const integer = (value, minimum = 0) => Number.isInteger(value) && value >= minimum;
const skillsOf = role => [role.skill, ...(role.alternate_skills ?? [])];
const contactCount = skill => [...skill.segments,...(skill.command_effects??[])].filter(s=>s.event).length;
const poseFrame=(segment,elapsed,loop=false)=>{
  const step=Math.floor(Math.max(0,elapsed)/segment.interval_raw);
  return segment.frames[loop?step%segment.frames.length:Math.min(segment.frames.length-1,step)];
};

export function validateBattleViewMetadata(meta,content=runtimeContent) {
  if (meta?.schema !== 'seventh-seal-battle-view' || meta.version !== 1 ||
      !Array.isArray(meta.roles) || !Array.isArray(meta.effects) ||
      !urlAllowed(meta.layers?.path)) throw new Error('战斗表现清单无效');
  requireRegisteredRoles(meta.roles.map(role=>role.id),{roster:meta.policy?.roster??'sample'},content);
  for (const role of meta.roles) {
    if (!integer(role.frame_width, 1) || !integer(role.frame_height, 1) ||
        !Number.isFinite(role.anchor?.x) || !Number.isFinite(role.anchor?.y) ||
        role.mirror !== false || role.direction !== 0 || !Array.isArray(role.actions)) {
      throw new Error(`资源 ${role.id} 尺寸或原朝向无效`);
    }
    const actions = new Map();
    for (const action of role.actions) {
      if (!integer(action.index) || actions.has(action.index) || !integer(action.frame_count, 1) ||
          !integer(action.directions, 1) || !integer(action.first_frame) ||
          !urlAllowed(action.sheet) || !/^[a-f0-9]{64}$/.test(action.sha256)) throw new Error('动作图集无效');
      actions.set(action.index, action);
    }
    for (const segment of [role.idle, ...(role.idle_sequence?.segments??[]), role.reaction, ...(role.skill?.segments || []),...[...(role.alternate_skills??[]),...(role.response_skills??[])].flatMap(s=>s.segments??[])]) {
      const action = actions.get(segment?.action_index);
      if (!action || !Array.isArray(segment.frames) || !segment.frames.length ||
          segment.frames.some(frame => !integer(frame) || frame >= action.frame_count) ||
          !integer(segment.start) || segment.end_exclusive - segment.start !== segment.frames.length ||
          !Number.isFinite(segment.interval_raw) || segment.interval_raw<=0) {
        throw new Error('原作动作帧范围无效');
      }
      if (segment.event && (!integer(segment.event.frame) || segment.event.frame < segment.start ||
          segment.event.frame >= segment.end_exclusive || segment.event.field !== '0x49')) {
        throw new Error('原结算事件不在动作逻辑帧范围内');
      }
      if (!Array.isArray(segment.effects)) throw new Error('动作效果清单无效');
      if (segment.movement_step_raw !== undefined && (!Number.isInteger(segment.movement_step_raw) || segment.movement_source_field !== '0x1e')) throw new Error('原动作位移字段无效');
    }
    if (role.skill.role_id !== role.id || !role.skill.segments.length ||
        (meta.policy.complete_contacts?contactCount(role.skill)<1:contactCount(role.skill)!==1)) throw new Error('技能源结算事件无效');
    for(const skill of role.alternate_skills??[])if(skill.role_id!==role.id||(meta.policy.complete_contacts?!/^[A-Za-z0-9_]+$/.test(skill.runtime_skill_id):skill.runtime_skill_id!=='yanci')||!skill.segments.length||(meta.policy.complete_contacts?contactCount(skill)<1:contactCount(skill)!==1)||
      (skill.layers&&(!urlAllowed(skill.layers.path)||!/^[a-f0-9]{64}$/.test(skill.layers.sha256))))throw new Error('追加技能表现未支持');
    for(const skill of skillsOf(role))for(const c of skill.command_effects??[]){
      if(![0,4,6,7,8,11].includes(c.command_raw)||c.type_raw!==1)throw new Error('原类型命令范围未支持');
      if(c.command_raw===4&&!c.missing_source_file&&(!meta.effects.some(e=>e.id===c.effect_asset_id)||![0,1].includes(c.wait_raw)||!['actor','target'].includes(c.slot)||!Array.isArray(c.frames)||!c.frames.length||c.end_exclusive-c.start!==c.frames.length||c.event&&(c.event.frame<c.start||c.event.frame>=c.end_exclusive)))throw new Error('原类型4效果范围无效');
    }
  }
  for (const effect of meta.effects) {
    if (!urlAllowed(effect.sheet) || !/^[a-f0-9]{64}$/.test(effect.sha256) ||
        !integer(effect.frame_width, 1) || !integer(effect.frame_height, 1) ||
        !integer(effect.frame_count, 1) || !Array.isArray(effect.frames) ||
        effect.frames.some(frame => !integer(frame) || frame >= effect.frame_count) ||
        effect.blend !== 'lighter' || !Number.isFinite(effect.anchor?.x) || !Number.isFinite(effect.anchor?.y)) {
      throw new Error('原作效果图集无效');
    }
    if(effect.layer_order){
      if(effect.layer_order.join(',')!=='shadow,main,intrinsic'||effect.shadow_blend!=='source-over'||effect.main_blend!=='source-over'||effect.intrinsic_blend!=='lighter'||effect.shadow_alpha!==128||!(effect.interval_ms>0))throw new Error('原特效分层或时钟无效');
      for(const layer of ['shadow','main','intrinsic'])if(!urlAllowed(effect[`${layer}_sheet`])||!/^[a-f0-9]{64}$/.test(effect[`${layer}_sha256`]))throw new Error('原特效分层资源缺失');
      if(effect.sheet!==effect.intrinsic_sheet||effect.sha256!==effect.intrinsic_sha256)throw new Error('原特效兼容层绑定不一致');
    }
  }
  const effectIds = new Set(meta.effects.map(effect => effect.id));
  for (const role of meta.roles) for (const skill of [...skillsOf(role),...(role.response_skills??[])]) for (const segment of skill.segments) for (const effect of segment.effects) {
    if (!effectIds.has(effect.asset_id) || !integer(effect.frame) || effect.frame < segment.start ||
        effect.frame >= segment.end_exclusive || !['actor', 'target'].includes(effect.slot)) throw new Error('效果事件无法绑定源帧');
  }
  if (!(meta.policy?.frame_ms > 0 && meta.policy.frame_ms <= 1000) ||
      !(meta.policy.tail_ms >= 0 && meta.policy.tail_ms <= 3000)) throw new Error('预览时钟无效');
  return meta;
}

// A CHR sequence may address the next physical DGP frames beyond an action's
// nominal count. Both atlases still map column n to first_frame+n; only their
// coverage differs. Admission requires the original file and action identities.
export function mergeNativeActionAtlases(role, sourceRole, sourceHashes) {
  const fail=()=>{throw new Error('战斗入场死亡动作冲突：原始动作或帧池不一致');};
  const dgp=`Fight_Role/${role.id}.dgp`,chr=`Fight_Role/${role.id}.CHR`;
  if(sourceRole.id!==role.id||sourceRole.source_dgp!==dgp||sourceRole.source_chr!==chr||
      !/^[a-f0-9]{64}$/.test(sourceRole.source_dgp_sha256)||
      !/^[a-f0-9]{64}$/.test(sourceRole.source_chr_sha256)||
      sourceHashes?.[dgp]!==sourceRole.source_dgp_sha256||
      sourceHashes?.[chr]!==sourceRole.source_chr_sha256||
      !integer(sourceRole.source_frame_pool_count,1))fail();
  const pool=sourceRole.source_frame_pool_count,actions=new Map(),required=new Set();
  for(const action of sourceRole.actions){
    if(actions.has(action.index)||!integer(action.index)||!/^[a-f0-9]{344}$/.test(action.native_raw_hex))fail();
    const raw=Uint8Array.from(action.native_raw_hex.match(/../g),byte=>parseInt(byte,16)),view=new DataView(raw.buffer);
    if(action.first_frame!==view.getUint32(0x72,true)||action.source_frame_count!==raw[14]||
        action.directions!==Math.max(1,raw[0])||action.directions!==1||
        action.interval_raw!==view.getUint32(1,true)||!integer(action.frame_count,1)||
        action.frame_count<action.source_frame_count||action.first_frame+action.frame_count>pool)fail();
    actions.set(action.index,{action,frames:new Set()});
  }
  const reference=(index,frame,physical)=>{
    const entry=actions.get(index);if(!entry||!integer(frame)||frame>=entry.action.frame_count||
      physical!==undefined&&physical!==entry.action.first_frame+frame)fail();
    entry.frames.add(frame);required.add(entry.action.first_frame+frame);
  };
  for(const skill of sourceRole.skills){
    for(const segment of skill.segments)for(const frame of segment.frames)reference(segment.action_index,frame);
    for(const step of skill.timeline)if(step.kind==='sprite')reference(step.action_index,step.action_frame,step.source_frame);
  }
  for(const {action,frames} of actions.values()){
    if(action.frame_count!==Math.max(action.source_frame_count,...[...frames].map(frame=>frame+1)))fail();
    const existing=role.actions.find(row=>row.index===action.index);
    if(existing){
      const segments=[role.skill,...(role.alternate_skills??[]),...(role.response_skills??[])].flatMap(skill=>skill.segments??[])
        .concat(role.idle_sequence?.segments??[role.idle],role.reaction);
      const referenced=segments.filter(segment=>segment?.action_index===existing.index).flatMap(segment=>segment.frames);
      if(existing.frame_count!==Math.max(action.source_frame_count,...referenced.map(frame=>frame+1)))fail();
      if(existing.native_raw_hex!==action.native_raw_hex||existing.source_frame_count!==action.source_frame_count||
          existing.first_frame!==action.first_frame||existing.directions!==action.directions||
          !integer(existing.frame_count,1)||existing.frame_count<existing.source_frame_count||
          existing.first_frame+existing.frame_count>pool||
          existing.interval_raw!==undefined&&existing.interval_raw!==action.interval_raw)fail();
      if(action.frame_count>existing.frame_count)Object.assign(existing,clone(action));
    }else role.actions.push(clone(action));
  }
  return required;
}

function validateLayers(layers, meta, skillId = 'yantu') {
  if (layers?.schema !== 'seventh-seal-skill-layers' || layers.version !== 1 || layers.id !== skillId ||
      !meta.roles.some(role=>role.id===layers.role_id) || !Array.isArray(layers.frames)) throw new Error('技能本体层清单无效');
  const role = meta.roles.find(item => item.id === layers.role_id);
  const skill = (role?.skill.runtime_skill_id??'yantu')===skillId ? role.skill : role?.alternate_skills?.find(s => s.runtime_skill_id === skillId);
  if (!skill) throw new Error('技能本体层缺少动作');
  const expected = skill.segments.flatMap((segment, index) => segment.frames.map(frame => ({segment: index, action: segment.action_index, frame})));
  if (expected.length !== layers.frames.length || layers.frame_width !== role.frame_width ||
      layers.frame_height !== role.frame_height || layers.anchor.x !== role.anchor.x || layers.anchor.y !== role.anchor.y) {
    throw new Error('技能本体与人物坐标空间不一致');
  }
  for (let index = 0; index < expected.length; index++) {
    const pair = layers.frames[index], source = expected[index];
    const action = role.actions.find(item => item.index === source.action);
    if (pair.sequence_index !== index || pair.segment_index !== source.segment || pair.action_index !== source.action ||
        pair.action_frame !== source.frame || pair.source_frame !== action.first_frame + source.frame) {
      throw new Error('技能人物与本体层未绑定同一个源帧');
    }
    for (const layer of [pair.main, pair.intrinsic]) {
      if (!urlAllowed('/' + layer?.path) || !/^[a-f0-9]{64}$/.test(layer?.sha256)) throw new Error('技能单帧资源无效');
    }
  }
  return layers;
}

export function compileActionTimeline(meta, layers, roleId,skillId=null,alternateLayers=null,content=runtimeContent) {
  validateBattleViewMetadata(meta,content);
  validateLayers(layers, meta);
  const role = meta.roles.find(item => item.id === roleId);
  if (!role) throw new Error('首版动作角色无效');
  const skill=skillId?(role.alternate_skills??[]).find(s=>s.runtime_skill_id===skillId):role.skill;
  if(!skill)throw new Error('追加技能时间线缺失');
  const pairs = skillId ? (skill.layers ? validateLayers(alternateLayers,meta,skillId).frames : null) : layers.role_id===role.id?layers.frames:null;
  const steps = [];
  skill.segments.forEach((segment, segmentIndex) => segment.frames.forEach((frame, cursor) => {
    const action = role.actions.find(item => item.index === segment.action_index);
    const logicalFrame = segment.start + cursor;
    const index = steps.length;
    steps.push({index, segment_index: segmentIndex, action_index: action.index, action_frame: frame,
      logical_frame: logicalFrame, source_frame: action.first_frame + frame,
      chr_record_index: segment.chr_record_index, source: clone(segment.source),
      event: segment.event?.frame === logicalFrame ? clone(segment.event) : null,
      effects: segment.effects.filter(effect => effect.frame === logicalFrame).map(clone),
      pair: pairs ? clone(pairs[index]) : null});
  }));
  return steps;
}

async function loadJson(path, expectedHash) {
  if (!urlAllowed(path)) throw new Error('战斗清单路径无效');
  return battleResources.json(path,expectedHash);
}

/** The Phaser frame loop calls draw while playAction is pending. No own timer. */
export class BattleView {
  constructor({canvas, assetLoader = null, jsonLoader = loadJson,metadataPath='/data/battle_view.json',itemMetadataPath=null,stageMetadataPath=null,lifecycleMetadataPath=null,content=runtimeContent} = {}) {
    if (!canvas?.getContext) throw new Error('战斗画布缺失');
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('战斗画布无法初始化');
    this.resourcePool=assetLoader?null:battleResources;
    this.assetLoader = assetLoader;
    this.jsonLoader = jsonLoader;
    this.content=content;
    this.metadataPath=metadataPath;
    this.itemMetadataPath=itemMetadataPath;this.itemMeta=null;
    this.stageMetadataPath=stageMetadataPath;this.stageMeta=null;this.stageStarted=null;
    this.lifecycleMetadataPath=lifecycleMetadataPath;this.lifecycle=null;
    this.roster=[{id:'001',resource_id:'001',side:'player',skill_id:'yantu'},{id:'012',resource_id:'012',side:'enemy',skill_id:'snow_attack'}];
    this.images = new Map();
    this.meta = null;
    this.layers = null;
    this.alternateLayers = new Map();
    this.timelines = new Map();
    this.run = null;
    this.detachedRuns = [];
    this.damageTexts = [];
    this.damageTextSerial = 0;
    this.ready = false;
    this.destroyed = false;
    this.generation = 0;
  }

  async prepare({actors=null,onProgress=()=>{}}={}) {
    if (this.destroyed) throw new Error('战斗表现已销毁');
    if (this.run) throw new Error('行动播放期间不能重新准备战斗');
    if (this.ready) {
      const generation=++this.generation;
      if(this.resourcePool)this.images=await this._preparePackedImages(this.assetDescriptors,actors,onProgress,()=>!this.destroyed&&generation===this.generation);
      return clone(this.meta);
    }
    const generation = ++this.generation;
    const check = () => {if (generation !== this.generation || this.destroyed) throw abortError();};
    const meta = validateBattleViewMetadata(await this.jsonLoader(this.metadataPath),this.content);
    let itemMeta=null;
    if(this.itemMetadataPath){
      itemMeta=await this.jsonLoader(this.itemMetadataPath);
      if(itemMeta?.schema!=='seventh-seal-item-presentation'||itemMeta.version!==1||!Array.isArray(itemMeta.roles)||!Array.isArray(itemMeta.effects))throw new Error('道具表现清单无效');
      for(const row of itemMeta.roles){const role=meta.roles.find(r=>r.id===row.id);
        if(!role||role.frame_width!==row.frame_width||role.frame_height!==row.frame_height||role.actions.some(a=>row.actions.some(b=>a.index===b.index)))throw new Error('道具动作角色或编号冲突');
        role.actions.push(...clone(row.actions));
      }
      meta.effects.push(...clone(itemMeta.effects));meta.extra_layer_banks=[...(meta.extra_layer_banks??[]),...itemMeta.roles.map(r=>r.layer_bank)];
      validateBattleViewMetadata(meta,this.content);
    }
    let lifecycleMeta=null;
    const lifecycleFrames=new Map();
    if(this.lifecycleMetadataPath){
      lifecycleMeta=await this.jsonLoader(this.lifecycleMetadataPath);
      if(lifecycleMeta?.schema!=='seventh-seal-battle-lifecycle'||![1,2].includes(lifecycleMeta.version)||!Array.isArray(lifecycleMeta.roles))throw new Error('战斗入场死亡清单无效');
      for(const row of lifecycleMeta.roles){
        const role=meta.roles.find(r=>r.id===row.id);if(!role)continue;
        if(role.frame_width!==row.frame_width||role.frame_height!==row.frame_height||role.anchor.x!==row.anchor.x||role.anchor.y!==row.anchor.y)throw new Error('战斗入场死亡坐标不一致');
        for(const source of [row.source_chr,row.source_dgp])if(lifecycleMeta.source_hashes?.[source]!==meta.source_hashes?.[source])throw new Error('战斗入场死亡来源不一致');
        lifecycleFrames.set(row.layer_bank.path,{row,required:mergeNativeActionAtlases(role,row,meta.source_hashes)});
        for(const skill of row.skills.filter(s=>s.source_skill?.battle_handler==='native-revival')){
          role.alternate_skills??=[];role.alternate_skills.push({...clone(skill),runtime_skill_id:`${row.id}_${skill.source_skill.original_skill_index}`,segments:skill.segments.map(segment=>({...clone(segment),movement_source_field:'0x1e'}))});
        }
        meta.extra_layer_banks=[...(meta.extra_layer_banks??[]),clone(row.layer_bank)];
      }
      for(const effect of lifecycleMeta.effects)if(!meta.effects.some(e=>e.id===effect.id))meta.effects.push(clone(effect));
      meta.missing_effects=clone(lifecycleMeta.missing_effects??[]);
      validateBattleViewMetadata(meta,this.content);
    }
    check();
    const layers = validateLayers(await this.jsonLoader(meta.layers.path, meta.layers.sha256), meta);
    check();
    const alternateLayers = new Map(),physicalLayers=new Map();
    for(const descriptor of [meta.extra_layers,...(meta.extra_layer_banks??[])].filter(Boolean)){
      const bank=await this.jsonLoader(descriptor.path,descriptor.sha256),role=meta.roles.find(r=>r.id===bank.role_id),lifecycle=lifecycleFrames.get(descriptor.path);
      if(bank.schema!=='seventh-seal-native-layer-bank'||bank.version!==1||!role||bank.frame_width!==role.frame_width||bank.frame_height!==role.frame_height||!Array.isArray(bank.frames))throw new Error('反击本体图层清单无效');
      if(lifecycle&&(bank.role_id!==lifecycle.row.id||bank.source_frame_pool_count!==lifecycle.row.source_frame_pool_count||
          bank.anchor?.x!==role.anchor.x||bank.anchor?.y!==role.anchor.y||
          [lifecycle.row.source_chr,lifecycle.row.source_dgp].some(source=>bank.source_hashes?.[source]!==meta.source_hashes[source])))throw new Error('战斗入场死亡图层来源不一致');
      const frames=new Set();
      for(const p of bank.frames){
        if(!integer(p.source_frame)||frames.has(p.source_frame)||lifecycle&&p.source_frame>=lifecycle.row.source_frame_pool_count||
            [p.main,p.intrinsic].some(l=>!urlAllowed('/'+l?.path)||!/^[a-f0-9]{64}$/.test(l?.sha256)||
              (lifecycle||l.width!==undefined)&&l.width!==role.frame_width||(lifecycle||l.height!==undefined)&&l.height!==role.frame_height))throw new Error('反击本体源帧无效');
        frames.add(p.source_frame);
        const key=`${bank.role_id}:${p.source_frame}`,previous=physicalLayers.get(key);
        if(previous&&['main','intrinsic'].some(layer=>previous[layer].sha256!==p[layer].sha256))throw new Error('同一原始帧的本体图层冲突');
        physicalLayers.set(key,p);
      }
      if(lifecycle&&[...lifecycle.required].some(frame=>!frames.has(frame)))throw new Error('战斗入场死亡图层缺少原始帧');
      alternateLayers.set(`${bank.role_id}:bank:${descriptor.path}`,bank);check();
    }
    for (const role of meta.roles) for (const skill of role.alternate_skills ?? []) if (skill.layers) {
      alternateLayers.set(`${role.id}:${skill.runtime_skill_id}`,validateLayers(await this.jsonLoader(skill.layers.path,skill.layers.sha256),meta,skill.runtime_skill_id));
      check();
    }
    const descriptors = new Map();
    const add = (path, sha256, width, height,owner='shared') => {
      const previous=descriptors.get(path),owners=[...new Set([...(previous?.owners??[]),owner])];
      descriptors.set(path, {path, sha256, width, height,owners});
    };
    const stageMeta=this.stageMetadataPath?validateForestStage(await this.jsonLoader(this.stageMetadataPath),this.content):null;
    if(stageMeta)for(const asset of forestStageAssets(stageMeta))add(asset.path,asset.sha256,asset.width,asset.height);
    for (const role of meta.roles) for (const action of role.actions) {
      add(action.sheet, action.sha256, role.frame_width * action.frame_count, role.frame_height * action.directions,role.id);
    }
    for (const effect of meta.effects) {
      if(effect.layer_order)for(const layer of effect.layer_order)add(effect[`${layer}_sheet`],effect[`${layer}_sha256`],effect.frame_width*effect.frame_count,effect.frame_height);
      else add(effect.sheet,effect.sha256,effect.frame_width*effect.frame_count,effect.frame_height);
    }
    for (const source of [layers,...alternateLayers.values()]) for (const pair of source.frames) for (const layer of [pair.main, pair.intrinsic]) {
      add('/' + layer.path, layer.sha256, source.frame_width, source.frame_height,source.role_id);
    }
    // Commit readiness only after every actor, reaction, effect and intrinsic PNG
    // has decoded successfully. A failed batch leaves no partly ready command.
    const assets=[...descriptors.values()],loaded=new Array(assets.length);let nextAsset=0;
    // Hundreds of verified body/intrinsic frames can exceed the local server's
    // connection backlog when fetched together. Bound requests and decoding,
    // while readiness still waits for every source asset.
    let packedImages;
    if(this.resourcePool)packedImages=await this._preparePackedImages(assets,actors,onProgress,()=>!this.destroyed&&generation===this.generation);
    else await Promise.all(Array.from({length:Math.min(12,assets.length)},async()=>{
      while(nextAsset<assets.length){const index=nextAsset++,asset=assets[index];
        const result=await this.assetLoader(clone(asset));check();
        const image=result?.image||result;
        if((image?.naturalWidth||image?.width)!==asset.width||(image?.naturalHeight||image?.height)!==asset.height||
          (result?.sha256&&result.sha256!==asset.sha256))throw new Error(`战斗图片尺寸或指纹不符：${asset.path}`);
        loaded[index]=[asset.path,image];
      }
    }));
    check();
    this.meta = clone(meta);
    this.itemMeta=clone(itemMeta);
    this.stageMeta=clone(stageMeta);
    this.layers = clone(layers);
    this.alternateLayers = alternateLayers;
    this.lifecyclePairs=new Map([...alternateLayers.values()].flatMap(bank=>bank.frames.map(pair=>[`${bank.role_id}:${pair.source_frame}`,pair])));
    this.lifecycleBounds=new Map();
    this.lifecycle=lifecycleMeta?new BattleLifecyclePlayback(lifecycleMeta,{appearanceBounds:(roleId,pose)=>this._appearanceBounds(roleId,pose),nativeBridge:actorId=>this._nativeBridge(actorId)}):null;
    this.assetDescriptors=assets;
    this.images = packedImages??new Map(loaded);
    this.timelines = new Map(meta.roles.map(role => [role.id, compileActionTimeline(meta, layers, role.id,null,null,this.content)]));
    for(const role of meta.roles)for(const skill of role.alternate_skills??[])this.timelines.set(`${role.id}:${skill.runtime_skill_id}`,compileActionTimeline(meta,layers,role.id,skill.runtime_skill_id,alternateLayers.get(`${role.id}:${skill.runtime_skill_id}`),this.content));
    this.ready = true;
    return clone(meta);
  }

  async _preparePackedImages(descriptors,actors,onProgress,isCurrent){
    const ids=actors?new Set(actors.map(a=>a.resource_id??a.id)):null;
    const selected=descriptors.filter(a=>!ids||a.owners.includes('shared')||a.owners.some(id=>ids.has(id)));
    const images=await this.resourcePool.prepare(selected,{scope:'battle-actors',onProgress,isCurrent});
    this.resourceLease=this.resourcePool.scopes.get('battle-actors');
    return images;
  }

  setRoster(actors,skills){
    this.stageStarted=null;
    this.lifecycle?.reset();
    this.defendClocks=new Map();
    this.damageTexts=[];
    if(!this.ready||this.run)throw new Error('战斗资源尚未就绪或正在行动');
    if(!Array.isArray(actors)||actors.length<2||actors.length>8||new Set(actors.map(a=>a.id)).size!==actors.length||actors.filter(a=>a.side==='player').length<1||actors.filter(a=>a.side==='player').length>4||actors.filter(a=>a.side==='enemy').length<1||actors.filter(a=>a.side==='enemy').length>4)throw new Error('战斗表现角色表无效');
    this.roster=actors.map(actor=>{
      const resource_id=actor.resource_id??actor.id,role=this.meta.roles.find(r=>r.id===resource_id),selected=Object.values(skills).filter(s=>s.actor_id===actor.id);
      if(!role||!selected.length||actor.side!==this.content.roles[resource_id]?.side||selected.some(s=>actor.side==='player'&&s.id!==(role.skill.runtime_skill_id??'yantu')&&!(role.alternate_skills??[]).some(a=>a.runtime_skill_id===s.id)))throw new Error('战斗人物或技能表现尚未接入');
      return {id:actor.id,resource_id,side:actor.side,party_slot_zero_based:actor.party_slot_zero_based,skill_id:selected[0].id,skill_ids:selected.map(s=>s.id)};
    });
  }

  _nativeBridge(actorId,control=this.nativeControl,guard=this.nativeControlIsCurrent){
    const check=()=>{if(!control||this.nativeControl!==control||guard&&!guard())throw abortError('原动作控制器已失效');};
    return {begin:(raw,at)=>{check();return control.beginNativeVertical(actorId,raw,at);},
      state:()=>{check();return control.nativeVerticalFor(actorId);},
      record:raw=>{check();control.nativeSourceRecord(actorId,raw);},
      advance:at=>{check();control.advanceNativeVerticals(at);}};
  }

  playSequence(result,{onContact,onRecord,onReactionContact,onReactionRecord,onReactionEnd,onPrimaryEnd,onFrame,onCarrierStart,onCarrierEnd,onDetachedError}={}){
    if(!this.ready||this.destroyed||this.run)return Promise.reject(new Error('完整技能表现尚未就绪或上一行动未结束'));
    const actor=this.roster.find(a=>a.id===result.actor_id),target=this.roster.find(a=>a.id===result.target_id);
    if(!this.meta.policy.complete_contacts||!actor||!target||typeof onContact!=='function'||typeof onRecord!=='function')return Promise.reject(new Error('完整技能序列或接触回调缺失'));
    let compiled;try{compiled=compileNativeSequence(this.meta,actor.resource_id,result.plan,[this.layers,...this.alternateLayers.values()]);}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{this.run={sequence:true,native_control:this.nativeControl,native_guard:this.nativeControlIsCurrent,result:clone(result),steps:compiled.steps,segments:compiled.segments,resolve,reject,onContact,onRecord,onReactionContact,onReactionRecord,onReactionEnd,onPrimaryEnd,onFrame,onCarrierStart,onCarrierEnd,onDetachedError,children:[],carriers:[],independent_carriers:compiled.independent_carriers,main_done:false,death_until:0,
      started:null,elapsed:0,cursor:0,visited:-1,next_at:0,record_visited:-1,impact_called:false,impact_done:false,impact_elapsed:null,effects:[],generation:this.generation,
      observations:{draws:0,origin_slot:null,last_slot:null,contact_slot:null,bounds:null,intrinsic_source_frames:[],effect_ids:[],contacts:[],authority:'Actual remake Canvas draws with all source contacts; preview animation clock'}};});
  }

  playItem(result,{onUse,onFrame,onEffectFrame}={}){
    const actor=this.roster.find(a=>a.id===result.actor_id),role=this.itemMeta?.roles.find(r=>r.id===actor?.resource_id),item=this.itemMeta?.items[String(result.item_id)];
    if(!role||!item||typeof onUse!=='function')return Promise.reject(new Error('道具原动作或提交回调缺失'));
    const promise=this.playSequence({...result,plan:clone(role.source_plan),hit:true,damage:0},{onContact:onUse,onRecord:()=>{},onFrame});
    if(this.run){this.run.item_effect_id=item.effect_id;this.run.onEffectFrame=onEffectFrame;
      // Source intervals are retained; the browser RAF remains a preview clock.
      this.run.frame_ms=new DataView(Uint8Array.from(role.actions[0].native_raw_hex.match(/../g),h=>parseInt(h,16)).buffer).getUint32(1,true);
    }
    return promise;
  }

  playAction(result, {onImpact} = {}) {
    if (!this.ready || this.destroyed) return Promise.reject(new Error('战斗图片尚未全部准备好'));
    if (this.run) return Promise.reject(new Error('上一行动尚未播放结束'));
    const actor = result?.actor_id, target = result?.target_id;
    const acting=this.roster.find(a=>a.id===actor),targeting=this.roster.find(a=>a.id===target);
    if(!acting||!targeting||acting.side===targeting.side||!(acting.skill_ids??[acting.skill_id]).includes(result.skill_id))return Promise.reject(new Error('本轮技能缺少已接入的原作表现'));
    if (typeof onImpact !== 'function') return Promise.reject(new Error('行动缺少结算提交回调'));
    return new Promise((resolve, reject) => {
      this.run = {result: clone(result), steps: this.timelines.get(`${acting.resource_id}:${result.skill_id}`)??this.timelines.get(acting.resource_id), resolve, reject, onImpact,
        started: null, elapsed: 0, cursor: 0, visited: -1, impact_called: false, impact_done: false,
        impact_elapsed: null, effects: [], generation: this.generation,
        observations:{draws:0,origin_slot:null,last_slot:null,contact_slot:null,bounds:null,intrinsic_source_frames:[],effect_ids:[],authority:'Actual remake Canvas draws; not original game execution'}};
    });
  }

  get playback() {
    if (!this.run) return null;
    const run = this.run, step = run.steps[run.cursor];
    return {actor_id: run.result.actor_id, target_id: run.result.target_id, elapsed: run.elapsed,
      cursor: run.cursor, impact_called: run.impact_called, impact_done: run.impact_done,
      frame: clone(step), policy: 'source sequence, preview clock and choreography'};
  }

  stop(reason = '战斗表现已取消') {
    ++this.generation;
    this.damageTexts=[];
    this.lifecycle?.reset();
    for(const run of [this.run,...this.detachedRuns].filter(Boolean))if(!run.primary_resolved)run.reject(abortError(reason));
    this.run=null;this.detachedRuns=[];
    if(this.resourcePool&&this.resourcePool.scopes.get('battle-actors')===this.resourceLease)this.resourcePool.release('battle-actors');
  }

  destroy() {
    this.stop('战斗表现已销毁');
    this.destroyed = true;
    this.ready = false;
    for (const image of this.images.values()) image?.close?.();
    this.images.clear();
    if(this.resourcePool&&this.resourcePool.scopes.get('battle-actors')===this.resourceLease)this.resourcePool.release('battle-actors');
  }

  _fail(run, error) {
    if(this.run===run)this.run=null;
    this.detachedRuns=this.detachedRuns.filter(old=>old!==run);
    if(run.primary_resolved)run.onDetachedError?.(error);else run.reject(error);
  }

  _advance(now) {
    if(this.detachedRuns.length||this.run?.sequence||this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())&&Number.isFinite(this.nativeControl.nextNativeVerticalAt()))return this._advanceSequenceRuns(now);
    const run = this.run;
    if (!run) return null;
    if (run.started === null) run.started = now;
    run.elapsed = Math.max(run.elapsed, now - run.started);
    const ms = this.meta.policy.frame_ms;
    run.cursor = Math.min(run.steps.length - 1, Math.floor(run.elapsed / ms));
    for (let index = run.visited + 1; index <= run.cursor; index++) {
      const step = run.steps[index];
      for (const effect of step.effects) {
        if (effect.slot === 'target' && !this._damaging(run.result)) continue;
        run.effects.push({...clone(effect), at: index * ms});
      }
      if (step.event && !run.impact_called) {
        run.impact_called = true;
        run.impact_elapsed = index * ms;
        const detail = {actor_id: run.result.actor_id, target_id: run.result.target_id,
          skill_id: run.result.skill_id, source_frame: step.source_frame,
          action_index: step.action_index, logical_frame: step.logical_frame,
          chr_record_index: step.chr_record_index, event: clone(step.event), source: clone(step.source),
          basis: 'original CHR +0x49 logical event position; presentation preview clock'};
        try {
          const pending = run.onImpact(detail);
          if (pending && typeof pending.then === 'function') {
            Promise.resolve(pending).then(() => {if (this.run === run){run.impact_done = true;this._queueDamageText(run,run.result,this.lastDrawAt??now);}}, error => this._fail(run, error));
          } else {run.impact_done = true;this._queueDamageText(run,run.result,now);}
        } catch (error) {this._fail(run, error); return null;}
      }
    }
    run.visited = run.cursor;
    if (this.run !== run) return null;
    if (run.elapsed >= run.steps.length * ms + this.meta.policy.tail_ms && run.impact_done) {
      this.run = null;
      run.resolve({completed: true, impact_committed: true, actor_id: run.result.actor_id,
        source_frame: run.steps.find(step => step.event).source_frame,observations:clone(run.observations)});
      return null;
    }
    return run;
  }

  _sequenceChannels(run){return [...run.carriers,run,...run.children];}

  _advanceSequenceRuns(now){
    const roots=()=>[...this.detachedRuns,this.run].filter(run=>run?.sequence);
    for(const root of roots()){root.started??=now;root.elapsed=Math.max(root.elapsed,now-root.started);}
    // Merge every detached carrier with the current action before callbacks.
    // A later command cannot consume RNG ahead of an earlier carrier contact
    // merely because RAF delivered both in one render frame.
    for(let visits=0;visits<30000;visits++){
      let root=null,at=Infinity,carrierFirst=false;
      for(const candidate of roots())for(const channel of this._sequenceChannels(candidate)){
        if(channel.done||channel===candidate&&candidate.main_done)continue;
        const end=channel.visited+1>=channel.steps.length,tail=end&&!channel.carrier&&!candidate.independent_carriers?this.meta.policy.tail_ms:0;
        const due=candidate.started+channel.next_at+tail;
        if(due<at||due===at&&channel.carrier&&!carrierFirst){root=candidate;at=due;carrierFirst=Boolean(channel.carrier);}
      }
      const control=this.nativeControl,valid=control&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent());
      const verticalAt=valid?control.nextNativeVerticalAt():Infinity;
      if(verticalAt<=now&&(verticalAt<at||verticalAt===at&&!carrierFirst)){control.advanceNativeVerticals(verticalAt);continue;}
      if(!root||at>now)break;
      this._advanceSequence(now,root,1);
      if(visits===29999)throw new Error('独立特效访问超出范围');
    }
    for(const root of roots())this._advanceSequence(now,root,0);
    return this.run??this.detachedRuns[0]??null;
  }

  _advanceSequence(now,run=this.run,limit=20000){if(run.started===null)run.started=now;run.elapsed=Math.max(run.elapsed,now-run.started);
    const ms=run.frame_ms??this.meta.policy.frame_ms;
    try{
      if(run.native_control&&(this.nativeControl!==run.native_control||run.native_guard&&!run.native_guard()))throw abortError('原行动控制器已失效');
      // Merge parent/reaction frame visits by preview time; a slow RAF preserves
      // contact ordering and cannot collapse an entire counter into one callback.
      let iterations=0;
      while(true){
        if(iterations++>=limit)break;
        const channels=this._sequenceChannels(run);let selected=null,at=Infinity,ending=false;
        for(const channel of channels){if(channel.done||(channel===run&&run.main_done))continue;const end=channel.visited+1>=channel.steps.length,due=channel.next_at+(end&&!channel.carrier&&!run.independent_carriers?this.meta.policy.tail_ms:0);if(due<at){selected=channel;at=due;ending=end;}}
        if(!selected||at>run.elapsed)break;const channel=selected,child=Boolean(channel.descriptor),carrier=Boolean(channel.carrier);
        if(channel.vertical_wait){
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard);
          if(bridge.state().waiting){channel.next_at=at+20;continue;}channel.vertical_wait=false;
        }
        if(ending){if(carrier)channel.done=true;else if(child){channel.done=true;run.onReactionEnd?.(clone(channel.descriptor),true,run.started+at);}else{run.main_done=true;run.onPrimaryEnd?.(run.started+at);}continue;}
        const i=channel.visited+1,step=channel.steps[i];
        if(!carrier)run.onFrame?.({...clone(step),actor_id:channel.result.actor_id,target_id:channel.result.target_id,channel_id:child?channel.channel_id:'main'});
        channel.cursor=i;
        if(!carrier&&(step.plan_record_index!==channel.record_visited||step.visibility_end)){if(child)run.onReactionRecord?.({...clone(step),presentation_time_ms:run.started+at},clone(channel.descriptor));else run.onRecord({...clone(step),presentation_time_ms:run.started+at});channel.record_visited=step.plan_record_index;}
        if(step.vertical_raw_hex){
          const bridge=this._nativeBridge(channel.result.actor_id,run.native_control,run.native_guard),state=bridge.begin(step.vertical_raw_hex,run.started+at);
          channel.vertical_wait=state.waiting;
        }
        if(step.carrier_spawn){
          const source=step.carrier_spawn,id=`carrier-${run.carriers.length}`,firstAt=Math.max(at,source.interval_ms-run.started);
          const carrier={carrier:true,channel_id:id,descriptor:channel.descriptor??null,result:clone(channel.result),steps:clone(source.steps),segments:[],
            at,next_at:firstAt,elapsed:0,cursor:0,visited:-1,record_visited:-1,effects:[],done:false};
          carrier.effects.push({asset_id:source.asset_id,slot:source.slot,unconditional:true,frame_count:source.frames.length,
            source_frames:clone(source.frames),frame_ms:source.interval_ms,at:firstAt-at-source.interval_ms,visited_frame:-1});
          run.carriers.push(carrier);run.onCarrierStart?.({carrier_id:id,source:clone(step),actor_id:channel.result.actor_id});
        }
        if(step.carrier_end){channel.done=true;run.onCarrierEnd?.({carrier_id:channel.channel_id,source:clone(step),actor_id:channel.result.actor_id},run.started+at);}
        if(step.visibility)channel.visibility={...clone(step.visibility),started:step.visibility_end?channel.visibility?.started??at:at,complete:Boolean(step.visibility_end)};
        if(step.event){
          const detail={...clone(step),presentation_time_ms:run.started+at,contact_key:`${carrier||child?channel.channel_id:'main'}:${step.plan_record_index}:${step.logical_frame}`,actor_id:channel.result.actor_id,target_id:channel.result.target_id,skill_id:channel.result.skill_id,
            basis:'Original logical CHR contact position; original composition and DGP frame table, preview animation clock'};
          const response=child?run.onReactionContact?.(detail,clone(channel.descriptor)):run.onContact(detail);if(!response||typeof response.then==='function')throw new Error('完整接触结算必须同步返回原结算结果');
          channel.result={...channel.result,skipped:null,...clone(response)};channel.impact_called=true;channel.impact_done=true;channel.impact_elapsed=at-(channel.at??0);
          for(const hit of response.group_results??[response])this._queueDamageText({...channel,result:{...channel.result,target_id:hit.target_id??channel.result.target_id}},hit,now);
          if((response.item_effect??response.item_used)&&run.item_effect_id){const asset=this.meta.effects.find(e=>e.id===run.item_effect_id);if(!asset)throw new Error('药品恢复特效缺失');
            channel.effects.push({asset_id:asset.id,slot:'target',unconditional:true,at:at-(channel.at??0),frame_ms:asset.interval_raw,visited_frame:-1});}
          // Native killer F5F9 doubles the current record interval; entering
          // the next source record clears it. Base65ms remains a preview policy.
          if(response.killer_frame_factor===2&&!step.effect_contact)channel.slow_record=step.plan_record_index;
          if(response.death)run.death_until=Math.max(run.death_until,at+520);
          for(const hit of response.group_results??[response])run.observations.contacts.push({...detail,target_id:hit.target_id??detail.target_id,hit:hit.hit,damage:hit.damage,remainingHp:hit.remainingHp,skipped:hit.skipped??null});
          if(response.interrupt_actor_id===run.result.actor_id)run.main_done=true;
          for(const old of run.children)if(!old.done&&old.result.actor_id===response.interrupt_actor_id){old.done=true;run.onReactionEnd?.(clone(old.descriptor),false);}
          for(const hit of response.group_results??[response])if(hit.reaction_descriptor){
            const descriptor=clone(hit.reaction_descriptor),role=this._role(descriptor.actor_id),plan=clone(descriptor.plan);plan.allow_no_contacts=true;
            const compiled=compileNativeSequence(this.meta,role.id,plan,[this.layers,...this.alternateLayers.values()]);
            for(const old of run.children)if(!old.done&&old.result.actor_id===descriptor.actor_id){old.done=true;run.onReactionEnd?.(clone(old.descriptor),false);}
            run.children.push({sequence:true,result:{actor_id:descriptor.actor_id,target_id:descriptor.target_id,skill_id:descriptor.skill.id,plan},descriptor,steps:compiled.steps,segments:compiled.segments,
              channel_id:`reaction-${run.children.length}`,at,next_at:at,elapsed:0,cursor:0,visited:-1,record_visited:-1,impact_called:false,impact_done:false,impact_elapsed:null,effects:[],done:false});
          }
        }
        for(const effect of step.effects){
          const hits=effect.slot==='target'&&channel.result.group_results?channel.result.group_results:[channel.result];
          for(const hit of hits){if(effect.slot==='target'&&!effect.unconditional&&(!(hit.target_id??channel.result.target_id)||!this._damaging(hit)))continue;
            channel.effects.push({...clone(effect),...(effect.slot==='target'?{target_id:hit.target_id??channel.result.target_id}:{}),...(step.duration_ms>0?{frame_ms:step.duration_ms}:{}),at:at-(channel.at??0)});}
        }
        channel.visited=i;channel.next_at=at+(step.duration_ms??ms)*(channel.slow_record===step.plan_record_index?2:1);
      }
      for(const c of [...run.children,...run.carriers])c.elapsed=Math.max(0,run.elapsed-c.at);
      for(const channel of this._sequenceChannels(run))for(const effect of channel.effects){const asset=this.meta.effects.find(e=>e.id===effect.asset_id),cursor=Math.min(asset.frames.length-1,Math.floor((channel.elapsed-effect.at)/(effect.frame_ms??ms)));
        for(let frame=(effect.visited_frame??-1)+1;frame<=cursor;frame++)run.onEffectFrame?.({asset_id:asset.id,logical_frame:frame});effect.visited_frame=Math.max(effect.visited_frame??-1,cursor);}
      const visualEnd=Math.max(0,...this._sequenceChannels(run).flatMap(c=>c.effects.filter(e=>e.unconditional).map(e=>(c.at??0)+e.at+(e.frame_count??this.meta.effects.find(a=>a.id===e.asset_id).frames.length)*(e.frame_ms??ms))));
      const foregroundDone=run.main_done&&run.children.every(c=>c.done);
      if(foregroundDone&&run.independent_carriers&&!run.primary_resolved){
        run.primary_resolved=true;if(this.run===run)this.run=null;
        if(!this.detachedRuns.includes(run))this.detachedRuns.push(run);
        run.resolve({completed:true,interrupted:Boolean(run.interrupted),carriers_pending:run.carriers.some(c=>!c.done),impact_committed:run.observations.contacts.length>0,contact_count:run.observations.contacts.length,observations:clone(run.observations)});
      }
      if(foregroundDone&&run.carriers.every(c=>c.done)&&run.elapsed>=Math.max(run.death_until,visualEnd)){
        if(this.run===run)this.run=null;this.detachedRuns=this.detachedRuns.filter(old=>old!==run);
        if(!run.primary_resolved)run.resolve({completed:true,interrupted:Boolean(run.interrupted),impact_committed:run.observations.contacts.length>0,contact_count:run.observations.contacts.length,observations:clone(run.observations)});return null;
      }
      return run;
    }catch(error){this._fail(run,error);return null;}
  }

  _damaging(result) {return result.hit !== false && result.hit !== 'miss' && result.hit !== 'MISS' && Number(result.damage) > 0;}

  _queueDamageText(channel,result,now){
    if(result.skipped||result.item_used||result.item_effect||result.revived||result.supported&&!(result.hp_delta>0))return;
    const miss=result.hit===false||['miss','MISS'].includes(result.hit);
    if(!miss&&!(Number.isFinite(result.damage)&&result.damage>=0))return;
    const targetId=channel.result.target_id,slot=this._slots(channel)[targetId];if(!slot)return;
    this.damageTexts=this.damageTexts.filter(e=>now-e.created_at<900);
    const lane=this.damageTexts.filter(e=>e.target_id===targetId).length;
    this.damageTexts.push({id:++this.damageTextSerial,target_id:targetId,text:miss?'MISS':result.supported?`+${result.hp_delta}`:String(result.damage),miss,healed:Boolean(result.supported),created_at:now,
      x:Math.max(this.stageMeta?140:20,Math.min(this.stageMeta?820:940,slot[0]+34+Math.floor(lane/4)*28)),
      y:Math.max(28,slot[1]-70-(lane%4)*24)});
  }

  _drawDamageTexts(now){
    this.damageTexts=this.damageTexts.filter(e=>now-e.created_at<900);
    const c=this.context;
    for(const e of this.damageTexts){const age=Math.max(0,now-e.created_at);
      c.save();c.globalAlpha=1-age/900;c.textAlign='center';c.font='bold 28px "Microsoft YaHei", sans-serif';c.fillStyle=e.miss?'#e2e8e7':e.healed?'#9df7ac':'#ffda91';
      c.lineWidth=3;c.lineJoin='round';c.strokeStyle='#24190e';c.strokeText?.(e.text,e.x,e.y-age/60);
      c.fillText(e.text,e.x,e.y-age/60);c.restore();
    }
  }

  _role(id) {return this.meta.roles.find(role => role.id === (this.roster.find(a=>a.id===id)?.resource_id??id));}

  _sprite(role, actionIndex, frame, x, y, alpha = 1, pair = null) {
    const ctx = this.context, action = role.actions.find(item => item.index === actionIndex);
    const scale = this.meta.policy.sprite_scale, width = role.frame_width, height = role.frame_height;
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = 'source-over';
    const dx = x - role.anchor.x * scale, dy = y - role.anchor.y * scale;
    if (pair) {
      drawBattleImage(ctx,this.images.get('/' + pair.main.path), 0, 0, width, height, dx, dy, width * scale, height * scale);
      if (pair.intrinsic.active) {
        ctx.globalCompositeOperation = 'lighter';
        drawBattleImage(ctx,this.images.get('/' + pair.intrinsic.path), 0, 0, width, height, dx, dy, width * scale, height * scale);
      }
    } else {
      drawBattleImage(ctx,this.images.get(action.sheet), frame * width, role.direction * height,
        width, height, dx, dy, width * scale, height * scale);
    }
    ctx.restore();
  }

  _slots(run,ground=false) {
    const policy = this.meta.policy;
    const enemies=this.roster.filter(a=>a.side==='enemy'),players=this.roster.filter(a=>a.side==='player');
    const slots=Object.fromEntries(this.roster.map(a=>[a.id,a.side==='player'?[policy.player_slot[0]+(players.indexOf(a)%2)*95,policy.player_slot[1]+Math.floor(players.indexOf(a)/2)*100+(players.indexOf(a)%2)*65]:
      [policy.enemy_slot[0]+(enemies.indexOf(a)%2)*145,policy.enemy_slot[1]+(Math.floor(enemies.indexOf(a)/2)-(enemies.length>2?.5:0))*125]]));
    if(this.stageMeta)for(const [id,[x,y]]of Object.entries(battleActorPositions(this.roster)))slots[id]=[120+x*1.125,y*1.125];
    // Keep the existing preview feet/flight offsets on a separate ground
    // plane. Approach/return interpolate ground depth between both actors;
    // the target's visual altitude must not change actor ordering or shadows.
    if(ground&&this.stageMeta)for(const actor of this.roster)slots[actor.id][1]+=(this.content.roles[actor.resource_id]?.presentation?.ground_offset??32)*1.125;
    if (!run||run.main_done||run.done) return slots;
    const actingRole=this._role(run.result.actor_id),skill=(actingRole.alternate_skills??[]).find(s=>s.runtime_skill_id===run.result.skill_id)??actingRole.skill;
    const step = run.steps[run.cursor], segments = run.segments??skill.segments;
    if(step.command_raw!==undefined)return slots;
    let progress = 0;
    if (this.content.roles[actingRole.id]?.presentation?.legacy_motion==='bounce'&&!run.sequence) {
      if (step.segment_index === 0) progress = 0;
      else if (step.segment_index === 1) {
        const count = segments[1].frames.length;
        progress = step.logical_frame < count / 2 ? (step.logical_frame + 1) / (count / 2) : (count - step.logical_frame) / (count / 2);
      } else progress = 0;
      const amount = Math.max(0, Math.min(1, progress));
      slots[run.result.actor_id][0] += policy.approach_distance * amount;
      return slots;
    }
    // Native +0x1e's sign identifies outward/return records. Legacy metadata
    // lacks that field and retains its two previously tagged movement records.
    const signed = segments.some(s => s.movement_step_raw !== undefined);
    const tagged = segments.map((s,i) => s.movement_flag_raw ? i : -1).filter(i => i>=0);
    const outward = signed ? segments.findIndex(s => s.movement_step_raw>0) : tagged[0]??-1;
    const returning = signed ? segments.findIndex((s,i) => i>outward && s.movement_step_raw<0) : tagged.at(-1)??-1;
    if (outward<0 || returning<=outward) return slots;
    const fraction = Math.max(0,Math.min(1,(step.logical_frame-segments[step.segment_index].start + (run.elapsed % policy.frame_ms)/policy.frame_ms + 1)/segments[step.segment_index].frames.length));
    if (step.segment_index===outward) progress=fraction;
    else if (step.segment_index>outward && step.segment_index<returning) progress=1;
    else if (step.segment_index===returning) progress=1-fraction;
    const amount = Math.max(0, Math.min(1, progress));
    const origin=slots[run.result.actor_id], target=slots[run.result.target_id]??origin;
    const direction = Math.sign(target[0]-origin[0]) || (this.roster.find(actor=>actor.id===run.result.actor_id)?.side==='player'?-1:1);
    const gap = policy.contact_gap ?? 110;
    origin[0] += (target[0]-direction*gap-origin[0])*amount;
    origin[1] += (target[1]+(policy.contact_y_offset??0)-origin[1])*amount;
    return slots;
  }

  paintIdle(snapshot, now = performance.now()) {return this.draw(snapshot, now);}

  actorPositions(){
    if(!this.meta)return null;
    return Object.fromEntries(Object.entries(this._slots(this.run)).map(([id,[x,y]])=>[id,this.stageMeta?[(x-120)/1.125,y/1.125]:[x*640/960,y*480/540]]));
  }

  drainLifecycleCompleted(){return this.lifecycle?.drainCompleted()??[];}
  lifecycleSnapshot(){return this.lifecycle?.snapshot()??null;}

  _appearanceBounds(roleId,pose){
    const role=this.meta.roles.find(r=>r.id===roleId),action=role.actions.find(a=>a.index===(pose?.action_index??role.idle.action_index));
    const frame=pose?.action_frame??role.idle.frames[0],key=`${roleId}:${action.index}:${frame}`;
    if(this.lifecycleBounds.has(key))return this.lifecycleBounds.get(key);
    const scale=this.meta.policy.sprite_scale;
    // Scan the verified source sprite, never the composed battle background.
    // The appearance pixel motion is an alpha adapter; its completion follows
    // the occupied-pixel coordinates of the sprite at the renderer's scale.
    const sourcePose={action_index:action.index,action_frame:frame,source_frame:action.first_frame+frame};
    if(!globalThis.document?.createElement)return {min_x:0,max_y:Math.floor((role.frame_height-1)*scale),empty:false,pose:sourcePose};
    const pair=this.lifecyclePairs.get(`${roleId}:${action.first_frame+frame}`),image=this.images.get(pair?'/'+pair.main.path:action.sheet);
    const surface=document.createElement('canvas');surface.width=role.frame_width;surface.height=role.frame_height;
    const c=surface.getContext('2d',{willReadFrequently:true});
    drawBattleImage(c,image,pair?0:frame*role.frame_width,0,role.frame_width,role.frame_height,0,0,role.frame_width,role.frame_height);
    const rgba=c.getImageData(0,0,surface.width,surface.height).data;let minX=surface.width,maxY=-1;
    for(let y=0;y<surface.height;y++)for(let x=0;x<surface.width;x++)if(rgba[(y*surface.width+x)*4+3]){minX=Math.min(minX,x);maxY=Math.max(maxY,y);}
    const bounds={min_x:Math.floor(minX*scale),max_y:Math.floor(maxY*scale),empty:maxY<0,pose:sourcePose};this.lifecycleBounds.set(key,bounds);return bounds;
  }

  draw(snapshot, now = performance.now()) {
    if (this.destroyed) return;
    if (!Number.isFinite(now)) throw new Error('战斗表现时钟无效');
    this.lastDrawAt=now;
    const ctx = this.context, width = this.canvas.width, height = this.canvas.height;
    ctx.beginFrame?.();
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
    const viewport=battleViewport(width,height);
    ctx.save();ctx.beginPath();ctx.rect(viewport.x,viewport.y,viewport.width,viewport.height);ctx.clip();
    if(this.stageMeta)ctx.setTransform(viewport.scale/1.125,0,0,viewport.scale/1.125,viewport.x-120*viewport.scale/1.125,viewport.y);
    else ctx.setTransform(viewport.width/960,0,0,viewport.height/540,viewport.x,viewport.y);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 960, 540);
    if(this.stageMeta){this.stageStarted??=now;ctx.fillStyle='#101719';ctx.fillRect(0,0,960,540);drawForestStageBackground(ctx,this.stageMeta,this.images,now-this.stageStarted);}
    else{
      const backdrop = ctx.createLinearGradient(0, 0, 0, 540);
      backdrop.addColorStop(0, '#111f27'); backdrop.addColorStop(.68, '#273b42'); backdrop.addColorStop(1, '#142429');
      ctx.fillStyle = backdrop; ctx.fillRect(0, 0, 960, 540);
      ctx.strokeStyle = '#759a9a35'; ctx.beginPath(); ctx.moveTo(0, 384); ctx.lineTo(960, 384); ctx.stroke();
    }
    if (!this.ready){ctx.restore();return;}
    // Periodic source responses and deaths can replace a playing CHR record
    // between render frames. Retire its future contacts before replaying RAF
    // catch-up; the independent lifecycle channel owns the new source pose.
    if(this.run?.sequence&&snapshot?.lifecycle_events){
      const active=this.run;active.external_interrupts??=new Set();
      for(const event of snapshot.lifecycle_events){
        if(!['response','death','revive'].includes(event.kind)||active.external_interrupts.has(event.token))continue;
        active.external_interrupts.add(event.token);
        if(active.result.actor_id===event.actor_id){active.main_done=true;active.interrupted=true;}
        for(const child of active.children)if(!child.done&&child.result.actor_id===event.actor_id){child.done=true;active.onReactionEnd?.(clone(child.descriptor),false);}
      }
    }
    const run = this._advance(now), roots=[...this.detachedRuns,...(this.run?[this.run]:[])],slots = this._slots(run),groundSlots=this._slots(run,true);
    if(snapshot?.actors)this.lifecycle?.advance(snapshot,this.roster,now);
    if(run?.sequence)for(const c of roots.flatMap(root=>[...root.children,...(!root.main_done?[root]:[])]).filter(c=>!c.done)){slots[c.result.actor_id]=this._slots(c)[c.result.actor_id];groundSlots[c.result.actor_id]=this._slots(c,true)[c.result.actor_id];}
    if (run) {
      const o=run.observations,slot=slots[run.result.actor_id];o.draws++;
      o.origin_slot??=clone(this._slots(null)[run.result.actor_id]);o.last_slot=clone(slot);
      if(run.impact_called&&!o.contact_slot)o.contact_slot=clone(slot);
      o.bounds??=[...slot,...slot];o.bounds=[Math.min(o.bounds[0],slot[0]),Math.min(o.bounds[1],slot[1]),Math.max(o.bounds[2],slot[0]),Math.max(o.bounds[3],slot[1])];
    }
    const actors = new Map((snapshot?.actors || []).map(actor => [actor.id, actor]));
    const queue=[...this.roster.filter(a=>a.side==='enemy'),...this.roster.filter(a=>a.side==='player')].map(a=>({...a,depth_y:groundSlots[a.id][1]}));
    if(this.stageMeta)queue.sort((a,b)=>a.depth_y-b.depth_y);
    for (const {id} of queue) {
      const role = this._role(id), actor = actors.get(id), slot = slots[id];
      const nativeZ=this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())?this.nativeControl.actor(id)?.native_z_raw:actor?.native_z_raw;
      if(Number.isFinite(nativeZ))slot[1]+=nativeZ*(this.stageMeta?1.125:this.meta.policy.sprite_scale);
      if(actor?.escaped||actor?.state_raw===11)continue;
      if(this.lifecycle?.hidden(id))continue;
      const dead = actor?.alive === false || actor?.hp?.current === 0;
      let alpha = 1, segment = role.idle, frame = poseFrame(segment,now,true), pair = null;
      const idlePose=actor?.idle_pose??(role.idle_sequence?idlePoseAt(role.idle_sequence.segments,now):null);
      if(idlePose){segment={action_index:idlePose.action_index};frame=idlePose.action_frame;}
      const acting=run?.sequence?roots.flatMap(root=>[...root.children,...(!root.main_done?[root]:[])]).reverse().find(c=>!c.done&&c.result.actor_id===id):run?.result.actor_id===id?run:null;
      const impacting=run?.sequence?roots.flatMap(root=>this._sequenceChannels(root)).filter(c=>c.result.target_id===id&&c.impact_called&&this._damaging(c.result)).sort((a,b)=>(b.at??0)+(b.impact_elapsed??0)-(a.at??0)-(a.impact_elapsed??0))[0]:run?.result.target_id===id&&run.impact_called&&this._damaging(run.result)?run:null;
      const lifePose=this.lifecycle?.pose(id);
      if(lifePose){segment={action_index:lifePose.action_index};frame=lifePose.action_frame;alpha=lifePose.alpha??1;
        pair=this.lifecyclePairs.get(`${role.id}:${lifePose.source_frame}`)??null;
      } else if (acting) {
        const step = acting.steps[acting.cursor],visual=step.command_raw!==undefined?step.visual:step;
        if(visual){segment = {action_index: visual.action_index}; frame = visual.action_frame; pair = visual.pair;}
      } else if(actor?.defending&&role.response_skills?.some(s=>s.chr_skill_index===9)){
        if(!this.defendClocks.has(id))this.defendClocks.set(id,now);
        segment=role.response_skills.find(s=>s.chr_skill_index===9).segments[0];
        frame=poseFrame(segment,now-this.defendClocks.get(id));
      } else if (impacting) {
        const age = Math.max(0, impacting.elapsed - impacting.impact_elapsed);
        segment = role.reaction;
        frame = poseFrame(segment,age);
        if (!this.lifecycle&&(impacting.result.death || impacting.result.remainingHp === 0 || dead)) alpha = Math.max(0, 1 - age / 520);
        else if (age >= segment.frames.length * segment.interval_raw) {
          segment = idlePose?{action_index:idlePose.action_index}:role.idle; frame = idlePose?.action_frame??poseFrame(segment,now,true);
        }
      } else if (dead){
        if(!this.lifecycle)continue;
        segment=role.reaction;frame=segment.frames.at(-1);
      }
      const visibility=acting?.visibility;
      if(visibility){const progress=visibility.complete?1:Math.min(1,Math.max(0,run.elapsed-visibility.started)/(visibility.complete_ticks*visibility.clock_ms));alpha*=visibility.kind==='appear'?progress:1-progress;}
      else if(actor?.native_visibility?.complete&&actor.native_visibility.kind==='disappear')alpha=0;
      if(!lifePose)alpha*=this.lifecycle?.alpha(id)??1;
      if(!actor?.defending)this.defendClocks?.delete(id);
      ctx.save(); ctx.globalAlpha = alpha * .4; ctx.fillStyle = '#071315'; ctx.beginPath();
      const shadow=this.stageMeta?groundSlots[id]:[slot[0],slot[1]+24];ctx.ellipse(shadow[0],shadow[1],82,15,0,0,Math.PI*2);ctx.fill();ctx.restore();
      this._sprite(role, segment.action_index, frame, slot[0], slot[1], alpha, pair);
      if(acting&&pair?.intrinsic.active&&!run.observations.intrinsic_source_frames.includes(pair.source_frame))run.observations.intrinsic_source_frames.push(pair.source_frame);
    }
    if (run) {
      for (const [channel,effect] of (run.sequence?roots.flatMap(root=>this._sequenceChannels(root)):[run]).flatMap(c=>c.effects.map(e=>[c,e]))) {
        const asset = this.meta.effects.find(item => item.id === effect.asset_id);
        const cursor = Math.floor((channel.elapsed - effect.at) / (effect.frame_ms??run.frame_ms??this.meta.policy.frame_ms));
        if (cursor < 0 || cursor >= (effect.frame_count??asset.frames.length)) continue;
        const slot = slots[effect.slot === 'actor' ? channel.result.actor_id : effect.target_id??channel.result.target_id];if(!slot)continue;
        const scale = this.meta.policy.sprite_scale;
        ctx.save();
        for(const layer of asset.layer_order??[null]){
          ctx.globalCompositeOperation=layer?asset[`${layer}_blend`]:asset.blend;
          drawBattleImage(ctx,this.images.get(layer?asset[`${layer}_sheet`]:asset.sheet), (effect.source_frames??asset.frames)[cursor]*asset.frame_width,0,
            asset.frame_width,asset.frame_height,slot[0]-asset.anchor.x*scale,slot[1]-asset.anchor.y*scale,asset.frame_width*scale,asset.frame_height*scale);
        }
        ctx.restore();
        if(!run.observations.effect_ids.includes(asset.id))run.observations.effect_ids.push(asset.id);
      }
    }
    this._drawDamageTexts(now);
    ctx.restore();
  }
}
