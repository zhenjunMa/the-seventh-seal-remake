/** Source-backed sprites; every HP/MP change belongs to the battle controller.
 * Entry/death/get-up use independent actor clocks and source DGP intervals.
 * Existing attack choreography and the 65 ms attack clock remain adapters.
 */

import {compileNativeSequence} from './core/battle/skill_sequence.mjs';
import {nativeEntryOffset} from './core/battle/battle_entry.mjs';
import {battleDefinitions} from './core/battle/battle_definition_cache.mjs';
import {freezeDefinition,freezeDefinitionMap} from './core/content/immutable_definition.mjs';
import {hasPartySkillTypeCorrection,addCorrectedPartyPresentations} from './core/party/party_skill_corrections.mjs';
import {BattleAssetPlan,effectReferences} from './core/battle/battle_asset_plan.mjs';
import {idlePoseAt} from './core/battle/battle_scheduler.mjs';
import {BattlePlayback} from './core/battle/battle_playback.mjs';
import {createDeathParticleSurface} from './death_particles.mjs';
import {battleViewport,battleActorPositions,battleActorCategory} from './core/battle/battle_layout.mjs';
import {battleResources,drawBattleImage} from './core/battle/battle_resources.mjs';
import {runtimeContent,requireRegisteredRoles} from './core/content/content_registry.mjs';
import {validateBattleStatusView,battleStatusAssets,drawBattleStatuses} from './battle_status_view.mjs';
import {validateForestStage,forestStageAssets,drawForestStageBackground,battleStageCameraOffset} from './forest_stage.mjs';
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

const victoriousActor=actor=>actor?.side==='player'&&actor.state_raw===9&&actor.hp.current>0&&!actor.escaped;
function victoryPoseAt(segments,elapsed){
  for(const segment of segments){
    const duration=segment.frames.length*segment.interval_raw;
    if(elapsed<duration)return {segment,frame:poseFrame(segment,elapsed)};
    elapsed-=duration;
  }
  const segment=segments.at(-1);
  return {segment,frame:segment.frames.at(-1)};
}

function effectOwners(meta, itemMeta, lifecycleMeta) {
  const owners = new Map(meta.effects.map(effect => [effect.id, new Set()]));
  const roles = new Set(meta.roles.map(role => role.id));
  const missing = new Set((meta.missing_effects ?? []).filter(row => row.source_exists === false).map(row => row.id));
  const add = (source, ids) => {
    for (const id of effectReferences(source)) {
      if (missing.has(id) && !owners.has(id)) continue;
      if (!owners.has(id)) throw new Error(`战斗特效依赖缺失：${id}`);
      for (const roleId of ids) owners.get(id).add(roleId);
    }
  };
  for (const role of meta.roles) add(role, [role.id]);
  for (const role of lifecycleMeta?.roles ?? []) if (roles.has(role.id)) add(role, [role.id]);
  for (const role of itemMeta?.roles ?? []) if (roles.has(role.id)) add(role, [role.id]);
  // All admitted medicines remain available to each participating item user;
  // temporary HP/MP, death or silence must not remove a later-needed effect.
  const itemUsers = (itemMeta?.roles ?? []).filter(role => roles.has(role.id)).map(role => role.id);
  if (itemUsers.length) add(itemMeta.items, itemUsers);
  return owners;
}

export function selectBattleAssets(descriptors, actors = null) {
  if (actors === null) return descriptors; // Full source inventory for exporters.
  const ids = new Set(actors.map(actor => actor.resource_id ?? actor.id));
  return descriptors.filter(asset => asset.owners.includes('shared') || asset.owners.some(id => ids.has(id)));
}

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
    for (const segment of [role.idle, ...(role.idle_sequence?.segments??[]), role.reaction, ...(role.victory_sequences??[]).flat(), ...(role.skill?.segments || []),...[...(role.alternate_skills??[]),...(role.response_skills??[])].flatMap(s=>s.segments??[])]) {
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
        (meta.policy.complete_contacts?contactCount(role.skill)<1&&!role.skill.contactless:contactCount(role.skill)!==1)) throw new Error('技能源结算事件无效');
    for(const skill of role.alternate_skills??[])if(skill.role_id!==role.id||(meta.policy.complete_contacts?!/^[A-Za-z0-9_]+$/.test(skill.runtime_skill_id):skill.runtime_skill_id!=='yanci')||!skill.segments.length||(meta.policy.complete_contacts?contactCount(skill)<1&&!skill.contactless:contactCount(skill)!==1)||
      (skill.layers&&(!urlAllowed(skill.layers.path)||!/^[a-f0-9]{64}$/.test(skill.layers.sha256))))throw new Error('追加技能表现未支持');
    for(const skill of skillsOf(role))for(const c of skill.command_effects??[]){
      if(![0,1,2,4,6,7,8,10,11].includes(c.command_raw)||c.type_raw!==1)throw new Error('原类型命令范围未支持');
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
    // Shipped actions retain unused visual triggers outside their visited
    // range (often frame0 with a nonzero start). Compilation visits only the
    // original range; retaining such a trigger does not make it executable.
    if ((!effectIds.has(effect.asset_id)&&!meta.missing_effects?.some(row=>row.id===effect.asset_id&&row.source_exists===false)) || !integer(effect.frame) || effect.frame < 0 ||
        !['actor', 'target'].includes(effect.slot)) throw new Error('效果事件无法绑定源帧');
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

/** Explicit advance owns playback; draw only paints the prepared state. */
export class BattleView {
  constructor({canvas, assetLoader = null, jsonLoader = loadJson,metadataPath='/data/battle_view.json',itemMetadataPath=null,stageMetadataPath=null,lifecycleMetadataPath=null,statusMetadataPath=null,content=runtimeContent,definitionCache=battleDefinitions} = {}) {
    if (!canvas?.getContext) throw new Error('战斗画布缺失');
    this.playbackRuntime=new BattlePlayback({
      isReady:()=>this.ready&&!this.destroyed,
      releaseResources:run=>this._releaseRunResources(run),
      feedback:(...args)=>this._queueDamageText(...args),
      sourceControl:(...args)=>this._nativeSourceControl(...args),
      lifecycleFrame:step=>this.onLifecycleFrame?.(step),
    });
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    if (!this.context) throw new Error('战斗画布无法初始化');
    this.resourcePool=assetLoader?null:battleResources;
    this.assetLoader = assetLoader;
    this.jsonLoader = jsonLoader;this.definitionCache=definitionCache;
    this.content=content;
    this.metadataPath=metadataPath;
    this.itemMetadataPath=itemMetadataPath;this.itemMeta=null;
    this.stageMetadataPath=stageMetadataPath;this.stageMeta=null;this.stageStarted=null;
    this.lifecycleMetadataPath=lifecycleMetadataPath;this.lifecycle=null;
    this.statusMetadataPath=statusMetadataPath;this.statusMeta=null;
    this.preparingEntry=false;this.entryFrameSounds=[];this.entryFrameControls=[];
    this.lastActorPoses=new Map();
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
    this.resourceScopes=new Set();this.compiledSequences=new WeakMap();this.preparedAssets=new WeakMap();this.retiredLeases=[];
  }

  get run(){return this.playbackRuntime.run;}
  set run(value){this.playbackRuntime.run=value;}
  get detachedRuns(){return this.playbackRuntime.detachedRuns;}
  set detachedRuns(value){this.playbackRuntime.detachedRuns=value;}
  get lifecycle(){return this.playbackRuntime.lifecycle;}
  set lifecycle(value){this.playbackRuntime.lifecycle=value;}
  get nativeControl(){return this.playbackRuntime.nativeControl;}
  set nativeControl(value){this.playbackRuntime.nativeControl=value;}
  get nativeControlIsCurrent(){return this.playbackRuntime.nativeControlIsCurrent;}
  set nativeControlIsCurrent(value){this.playbackRuntime.nativeControlIsCurrent=value;}
  get lastActorPoses(){return this.playbackRuntime.lastActorPoses;}
  set lastActorPoses(value){this.playbackRuntime.lastActorPoses=value;}
  get preparingEntry(){return this.playbackRuntime.preparingEntry;}
  set preparingEntry(value){this.playbackRuntime.preparingEntry=value;}
  get entryFrameSounds(){return this.playbackRuntime.entryFrameSounds;}
  set entryFrameSounds(value){this.playbackRuntime.entryFrameSounds=value;}
  get entryFrameControls(){return this.playbackRuntime.entryFrameControls;}
  set entryFrameControls(value){this.playbackRuntime.entryFrameControls=value;}
  get cameraShake(){return this.playbackRuntime.cameraShake;}
  set cameraShake(value){this.playbackRuntime.cameraShake=value;}
  get cameraPan(){return this.playbackRuntime.cameraPan;}
  set cameraPan(value){this.playbackRuntime.cameraPan=value;}
  get colorFade(){return this.playbackRuntime.colorFade;}
  set colorFade(value){this.playbackRuntime.colorFade=value;}

  _configurePlayback(){
    this.playbackRuntime.configure({meta:this.meta,stageMeta:this.stageMeta,roster:this.roster,
      layers:this.layers,alternateLayers:this.alternateLayers,compiledSequences:this.compiledSequences,
      generation:this.generation});
  }
  _nativeBridge(...args){this._configurePlayback();return this.playbackRuntime._nativeBridge(...args);}
  _nativeSourceControl(...args){this._configurePlayback();return this.playbackRuntime._nativeSourceControl(...args);}
  _sequenceChannels(run){return this.playbackRuntime._sequenceChannels(run);}
  _advance(now){this._configurePlayback();return this.playbackRuntime.currentRun=this.playbackRuntime._advance(now);}
  playSequence(...args){this._configurePlayback();return this.playbackRuntime.playSequence(...args);}
  advance(snapshot,now=performance.now()){
    if(this.destroyed)return;
    // A retiring action may still supply this update's final pose. Hold its
    // pixels through drawing, or only until the next update when rendering skips.
    for(const lease of this.retiredLeases.splice(0))lease.release();
    this._configurePlayback();this.advancing=true;
    try{
      const run=this.playbackRuntime.advance(snapshot,now);
      this.lastDrawAt=now;
      if(this.ready&&snapshot?.phase==='victory'&&!this.victoryPlayback){
        const sequences=new Map();
        for(const actor of snapshot.actors){
          if(!victoriousActor(actor))continue;
          const variants=this._role(actor.id)?.victory_sequences;
          if(!variants?.length)continue;
          // The selection is visual only and stays fixed for this victory.
          const index=variants.length===1?0:Math.floor(Math.random()*variants.length);
          sequences.set(actor.id,variants[index]);
        }
        this.victoryPlayback={started:now,sequences};
      }
      if(this.stageMeta)this.stageStarted??=now;
      for(const actor of snapshot?.actors??[]){
        if(actor.defending){if(!this.defendClocks.has(actor.id))this.defendClocks.set(actor.id,now);}
        else this.defendClocks?.delete(actor.id);
      }
      if(this.ready){
        const frame=this._actorPresentation(snapshot,now,{run});
        this.presentationFrame={snapshot,now,frame};this.drawnSlots=frame.slots;
        for(const {id,segment,frame:pose} of frame.entries)
          this.lastActorPoses.set(id,{action_index:segment.action_index,action_frame:pose});
      }
      return run;
    }finally{this.advancing=false;}
  }
  present(snapshot,now=performance.now(),options={}){
    if(!options.entryPreview)this.advance(snapshot,now);
    return this.draw(snapshot,now,options);
  }

  async prepare({actors=null,skills=null,inventory=null,staged=false,onProgress=()=>{}}={}) {
    if(this.destroyed)throw new Error('战斗表现已销毁');
    if(this.run||this.detachedRuns.length)throw new Error('行动播放期间不能重新准备战斗');
    this.resourceController?.abort(abortError('重新准备战斗'));this.resourceController=new AbortController();
    const generation=++this.generation,isCurrent=()=>!this.destroyed&&generation===this.generation;
    const check=()=>{if(!isCurrent())throw abortError();};
    if(!this.definition){
      const identity=JSON.stringify([this.metadataPath,this.itemMetadataPath,this.lifecycleMetadataPath,this.statusMetadataPath]);
      const definition=await this.definitionCache.load(this.jsonLoader,this.content,identity,()=>this._readDefinition());
      check();
      const stageMeta=this.stageMetadataPath?validateForestStage(await this.jsonLoader(this.stageMetadataPath),this.content):null;
      check();
      this.definition=definition;
      Object.assign(this,{meta:definition.meta,itemMeta:definition.itemMeta,lifecycleMeta:definition.lifecycleMeta,statusMeta:definition.statusMeta,
        layers:definition.layers,alternateLayers:definition.alternateLayers,lifecyclePairs:definition.lifecyclePairs,
        damageTextAssets:definition.damageTextAssets,stageMeta:freezeDefinition(stageMeta)});
      const descriptors=new Map(definition.assetDescriptors.map(asset=>[asset.path,asset]));
      for(const asset of stageMeta?forestStageAssets(stageMeta):[]){
        const previous=descriptors.get(asset.path);
        descriptors.set(asset.path,{...asset,owners:[...new Set([...(previous?.owners??[]),'shared'])]});
      }
      this.assetDescriptors=[...descriptors.values()];
      this.groundFootprints=new Map();this.lifecycleBounds=new Map();
      this._configurePlayback();
      this.playbackRuntime.configureLifecycle(this.lifecycleMeta,{
        appearanceBounds:(roleId,pose)=>this._appearanceBounds(roleId,pose),
        appearanceRenderMs:1000/60,
        disappearanceEffect:(actorId,roleId,mode,event)=>this._particleEffect(actorId,roleId,mode,event),
        appearanceEffect:(actorId,roleId,mode,event)=>this._particleEffect(actorId,roleId,mode,event,true),
      });
    }
    await this._prepareEntry({actors,skills,inventory,staged,onProgress,isCurrent});
    check();
    if(!staged&&!this.ready){
      for(const role of this.meta.roles)this.timelines.set(role.id,compileActionTimeline(this.meta,this.layers,role.id,null,null,this.content));
      for(const role of this.meta.roles)for(const skill of role.alternate_skills??[])this.timelines.set(`${role.id}:${skill.runtime_skill_id}`,compileActionTimeline(this.meta,this.layers,role.id,skill.runtime_skill_id,this.alternateLayers.get(`${role.id}:${skill.runtime_skill_id}`),this.content));
    }
    this.ready=true;
    return staged?this.resourceSnapshot():clone(this.meta);
  }

  async _readDefinition(){
    const meta = validateBattleViewMetadata(await this.jsonLoader(this.metadataPath),this.content);
    const statusMeta=this.statusMetadataPath?validateBattleStatusView(await this.jsonLoader(this.statusMetadataPath)):null;
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
        if(row.shadow){const s=row.shadow;
          if(!urlAllowed(s.sheet)||!/[a-f0-9]{64}/.test(s.sha256)||!['width','height','columns','frame_width','frame_height','frames'].every(k=>integer(s[k],1))||
            s.frames!==row.source_frame_pool_count||s.width!==s.columns*s.frame_width||s.height!==Math.ceil(s.frames/s.columns)*s.frame_height||
            !integer(s.x)||!integer(s.y)||s.x+s.frame_width>row.frame_width||s.y+s.frame_height>row.frame_height)throw new Error('战斗阴影来源或图集坐标无效');
        }
        role.shadow=clone(row.shadow??null);
        lifecycleFrames.set(row.layer_bank.path,{row,required:mergeNativeActionAtlases(role,row,meta.source_hashes)});
        role.victory_sequences=row.skills.filter(skill=>skill.skill_id_raw===13).map(skill=>
          skill.segments.slice(0,2).map(segment=>({...segment,movement_source_field:'0x1e'})));
        for(const skill of row.skills.filter(s=>s.source_skill?.battle_handler==='native-revival')){
          role.alternate_skills??=[];role.alternate_skills.push({...clone(skill),runtime_skill_id:`${row.id}_${skill.source_skill.original_skill_index}`,segments:skill.segments.map(segment=>({...clone(segment),movement_source_field:'0x1e'}))});
        }
        meta.extra_layer_banks=[...(meta.extra_layer_banks??[]),clone(row.layer_bank)];
      }
      for(const effect of lifecycleMeta.effects)if(!meta.effects.some(e=>e.id===effect.id))meta.effects.push(clone(effect));
      meta.missing_effects=[...new Map([...(meta.missing_effects??[]),...(lifecycleMeta.missing_effects??[])].map(row=>[row.id,clone(row)])).values()];
      validateBattleViewMetadata(meta,this.content);
    }
    validateBattleViewMetadata(meta,this.content);
    const layers = validateLayers(await this.jsonLoader(meta.layers.path, meta.layers.sha256), meta);
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
      alternateLayers.set(`${bank.role_id}:bank:${descriptor.path}`,bank);
    }
    for (const role of meta.roles) for (const skill of role.alternate_skills ?? []) if (skill.layers) {
      alternateLayers.set(`${role.id}:${skill.runtime_skill_id}`,validateLayers(await this.jsonLoader(skill.layers.path,skill.layers.sha256),meta,skill.runtime_skill_id));
      }
    const descriptors = new Map();
    const add = (path, sha256, width, height,owner='shared') => {
      const previous=descriptors.get(path),owners=[...new Set([...(previous?.owners??[]),...(Array.isArray(owner)?owner:[owner])])];
      descriptors.set(path, {path, sha256, width, height,owners});
    };
    const ui=await this.jsonLoader('/data/battle_ui.json');
    const damageTextAssets={damage:ui.assets.fight_var_text,healed:ui.assets.fight_var_textb,miss:ui.assets.fight_miss_text};
    for(const [kind,asset]of Object.entries(damageTextAssets)){
      if(!asset||asset.width!==(kind==='miss'?61:18)||asset.height!==(kind==='miss'?23:18)||asset.frames.length!==(kind==='miss'?1:10))throw new Error('战斗飘字素材无效');
      for(const frame of asset.frames){
        if(!urlAllowed('/'+frame.image)||!/^[a-f0-9]{64}$/.test(frame.png_sha256))throw new Error('战斗飘字来源无效');
        add('/'+frame.image,frame.png_sha256,asset.width,asset.height);
      }
    }
    for (const role of meta.roles) for (const action of role.actions) {
      add(action.sheet, action.sha256, role.frame_width * action.frame_count, role.frame_height * action.directions,role.id);
    }
    for(const role of meta.roles)if(role.shadow){const s=role.shadow;add(s.sheet,s.sha256,s.width,s.height,role.id);}
    const ownersByEffect=effectOwners(meta,itemMeta,lifecycleMeta),seenEffects=new Set();
    for (const effect of meta.effects) {
      // Rendering resolves the first matching ID. Retain later source variants
      // for export/oracle checks without decoding them for every actor roster.
      const owners=seenEffects.has(effect.id)?[]:[...ownersByEffect.get(effect.id)];seenEffects.add(effect.id);
      if(effect.layer_order)for(const layer of effect.layer_order)add(effect[`${layer}_sheet`],effect[`${layer}_sha256`],effect.frame_width*effect.frame_count,effect.frame_height,owners);
      else add(effect.sheet,effect.sha256,effect.frame_width*effect.frame_count,effect.frame_height,owners);
    }
    for (const source of [layers,...alternateLayers.values()]) for (const pair of source.frames) for (const layer of [pair.main, pair.intrinsic]) {
      add('/' + layer.path, layer.sha256, source.frame_width, source.frame_height,source.role_id);
    }
    const definition={meta,itemMeta,lifecycleMeta,layers,damageTextAssets,
      statusMeta,assetDescriptors:[...descriptors.values(),...battleStatusAssets(statusMeta)],alternateLayers:freezeDefinitionMap(alternateLayers),
      lifecyclePairs:freezeDefinitionMap([layers,...alternateLayers.values()].flatMap(bank=>bank.frames.map(pair=>[`${bank.role_id}:${pair.source_frame}`,pair])))};
    for(const bank of alternateLayers.values())freezeDefinition(bank);
    return freezeDefinition(definition);
  }

  async _prepareImages(descriptors,actors,onProgress,isCurrent){
    const selected=selectBattleAssets(descriptors,actors);
    if(this.resourcePool){
      const images=await this.resourcePool.prepare(selected,{scope:'battle-actors',onProgress,isCurrent});
      this.resourceLease=this.resourcePool.scopes.get('battle-actors');return images;
    }
    const images=new Map();let next=0;
    const workers=await Promise.allSettled(Array.from({length:Math.min(12,selected.length)},async()=>{
      while(next<selected.length){
        if(!isCurrent())throw abortError();
        const asset=selected[next++],cached=this.images.get(asset.path);
        const result=cached??await this.assetLoader(clone(asset));
        if(!isCurrent())throw abortError();
        const image=result?.image||result;
        if((image?.naturalWidth||image?.width)!==asset.width||(image?.naturalHeight||image?.height)!==asset.height||
          (result?.sha256&&result.sha256!==asset.sha256))throw new Error(`战斗图片尺寸或指纹不符：${asset.path}`);
        images.set(asset.path,image);onProgress({completed:images.size,total:selected.length});
      }
    }));
    const failure=workers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
    if(!isCurrent())throw abortError();return images;
  }

  async _prepareEntry({actors,skills,inventory,staged,onProgress,isCurrent}){
    const correctedRoles=new Set(Object.values(skills??{}).filter(skill=>{
      if(!hasPartySkillTypeCorrection(skill))return false;
      const role=this.meta.roles.find(row=>row.id===skill.actor_id);
      return role&&role.skill.runtime_skill_id!==skill.id&&!role.alternate_skills?.some(row=>row.runtime_skill_id===skill.id);
    }).map(skill=>skill.actor_id));
    if(correctedRoles.size){
      this.meta={...this.meta,roles:this.meta.roles.map(role=>correctedRoles.has(role.id)
        ?{...role,alternate_skills:[...(role.alternate_skills??[])]}:role)};
      addCorrectedPartyPresentations(this.meta,skills);
      validateBattleViewMetadata(this.meta,this.content);
      const owners=effectOwners(this.meta,this.itemMeta,this.lifecycleMeta);
      const additional=new Map();
      for(const effect of this.meta.effects)for(const path of [effect.sheet,effect.main_sheet,effect.intrinsic_sheet,effect.shadow_sheet])
        if(path)additional.set(path,[...(additional.get(path)??[]),...owners.get(effect.id)]);
      this.assetDescriptors=this.assetDescriptors.map(asset=>additional.has(asset.path)
        ?freezeDefinition({...asset,owners:[...new Set([...asset.owners,...additional.get(asset.path)])]}):asset);
      freezeDefinition(this.meta);
    }
    this.preparedAssets=new WeakMap();this.appearanceRasters?.clear();
    this.assetPlan=staged?new BattleAssetPlan({meta:this.meta,itemMeta:this.itemMeta,lifecycleMeta:this.lifecycleMeta,
      descriptors:this.assetDescriptors,layers:[this.layers,...this.alternateLayers.values()],actors,skills,inventory}):null;
    if(!staged){this.images=await this._prepareImages(this.assetDescriptors,actors,onProgress,isCurrent);return;}
    const previous=this.entryLease;
    this.entryLease=await this._loadAssets(this.assetPlan.assets(this.assetPlan.base),'battle-base',{onProgress,isCurrent});
    previous?.release();this.images=new Map(this.entryLease.images);this.entryImageCount=this.entryLease.images.size;
  }

  async _loadAssets(assets,label,{onProgress=()=>{},isCurrent=()=>true}={}){
    const scope=this.resourcePool?.createScope(label);let closed=false;
    const lease={images:null,release:()=>{if(closed)return;closed=true;scope?.release();this.resourceScopes.delete(lease);}};
    this.resourceScopes.add(lease);
    try{
      lease.images=scope?await scope.prepare(assets,{onProgress,isCurrent}):await this._prepareImages(assets,null,onProgress,()=>!closed&&isCurrent());
      if(closed||!isCurrent())throw abortError();
      for(const [path,image]of lease.images)this.images.set(path,image);
      return lease;
    }catch(error){lease.release();throw error;}
  }

  actionAssets(result){
    if(!this.assetPlan)return [];
    if(this.preparedAssets.has(result))return this.preparedAssets.get(result);
    let compiled=null;
    if(result.plan){compiled=this.compiledSequences.get(result)??compileNativeSequence(this.meta,this.assetPlan.actors.get(result.actor_id),result.plan,[this.layers,...this.alternateLayers.values()]);this.compiledSequences.set(result,compiled);}
    const assets=this.assetPlan.assets(this.assetPlan.action(result,compiled));this.preparedAssets.set(result,assets);return assets;
  }
  actionResourcesReady(result){return !this.assetPlan||Boolean(this.resourcePool?.has(this.actionAssets(result)));}
  async prepareAction(result){
    if(!this.assetPlan)return null;
    const generation=this.generation,lease=await this._loadAssets(this.actionAssets(result),'battle-action',
      {isCurrent:()=>!this.destroyed&&generation===this.generation});
    this.prefetchLease?.release();this.prefetchLease=null;return lease;
  }
  async prefetchCommand(command){
    if(!this.assetPlan)return;
    const plan=this.assetPlan,generation=this.generation,ticket={};this.prefetchTicket=ticket;
    this.prefetchLease?.release();this.prefetchLease=null;
    try{
      const paths=command.item_id!==undefined?plan.item(command.actor_id,command.item_id):plan.skill(command.actor_id,command.skill_id);
      const lease=await this._loadAssets(plan.assets(paths),'battle-lookahead',
        {isCurrent:()=>!this.destroyed&&generation===this.generation&&this.prefetchTicket===ticket});
      this.prefetchLease=lease;this.onResourcesPrepared?.(lease.images);
    }catch(error){if(error.name!=='AbortError'&&this.prefetchTicket===ticket&&generation===this.generation)this.onResourceError?.(error);}
  }
  resourceSnapshot(){return {staged:Boolean(this.assetPlan),entry_images:this.entryImageCount??this.images.size,scopes:this.resourceScopes.size};}
  _releaseRun(run){this.playbackRuntime._releaseRun(run);}
  _releaseRunResources(run){
    const lease=run?.resourceLease;if(lease){if(this.advancing||this.drawing)this.retiredLeases.push(lease);else lease.release();run.resourceLease=null;}
  }

  setRoster(actors,skills){
    this.lastActorPoses.clear();this.cameraShake=null;this.colorFade=null;this.cameraPan=null;
    this.stageStarted=null;this.victoryPlayback=null;
    this.drawnSlots=null;this.presentationFrame=null;
    this.lifecycle?.reset();this.entryFrameSounds=[];this.entryFrameControls=[];this.playbackRuntime.currentRun=null;
    this.defendClocks=new Map();
    this.damageTexts=[];
    if(!this.ready||this.run)throw new Error('战斗资源尚未就绪或正在行动');
    if(!Array.isArray(actors)||actors.length<2||actors.length>10||new Set(actors.map(a=>a.id)).size!==actors.length||actors.filter(a=>a.side==='player').length<1||actors.filter(a=>a.side==='player').length>4||actors.filter(a=>a.side==='enemy').length<1||actors.filter(a=>a.side==='enemy').length>6)throw new Error('战斗表现角色表无效');
    this.roster=actors.map(actor=>{
      // Compositions reuse their member sequences and have no separate atlas.
      const resource_id=actor.resource_id??actor.id,role=this.meta.roles.find(r=>r.id===resource_id),selected=Object.values(skills).filter(s=>s.actor_id===actor.id&&s.battle_handler!=='combination');
      if(!role||!selected.length||actor.side!==this.content.roles[resource_id]?.side||selected.some(s=>actor.side==='player'&&s.id!==(role.skill.runtime_skill_id??'yantu')&&!(role.alternate_skills??[]).some(a=>a.runtime_skill_id===s.id)))throw new Error('战斗人物或技能表现尚未接入');
      return {id:actor.id,resource_id,side:actor.side,category_raw:battleActorCategory(actor),party_slot_zero_based:actor.party_slot_zero_based,skill_id:selected[0].id,skill_ids:selected.map(s=>s.id)};
    });
  }

  playItem(result,{onUse,onFrame,onEffectFrame}={}){
    const actor=this.roster.find(a=>a.id===result.actor_id),role=this.itemMeta?.roles.find(r=>r.id===actor?.resource_id),item=this.itemMeta?.items[String(result.item_id)];
    if(!role||!item||typeof onUse!=='function')return Promise.reject(new Error('道具原动作或提交回调缺失'));
    const promise=this.playSequence({...result,plan:clone(role.source_plan),hit:true,damage:0},{onContact:onUse,onRecord:()=>{},onFrame,onEffectFrame});
    if(this.run){this.run.item_effect_id=item.effect_id;
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
    const role=this.meta.roles.find(row=>row.id===acting.resource_id),alternate=role.alternate_skills?.find(skill=>skill.runtime_skill_id===result.skill_id);
    const key=alternate?`${acting.resource_id}:${result.skill_id}`:acting.resource_id;
    if(!this.timelines.has(key))this.timelines.set(key,compileActionTimeline(this.meta,this.layers,acting.resource_id,alternate?result.skill_id:null,alternate?this.alternateLayers.get(key):null,this.content));
    return new Promise((resolve, reject) => {
      this.run = {result: clone(result), steps: this.timelines.get(key), resolve, reject, onImpact,
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

  cancelPreparation(reason='战斗准备已取消'){
    this.resourceController?.abort(abortError(reason));++this.generation;this.prefetchTicket=null;this.appearanceRasters?.clear();
    for(const lease of [...this.resourceScopes])lease.release();
  }

  stop(reason = '战斗表现已取消') {
    this.cancelPreparation(reason);
    this.lastActorPoses.clear();this.cameraShake=null;this.colorFade=null;this.cameraPan=null;
    this.drawnSlots=null;this.presentationFrame=null;
    this.damageTexts=[];
    this.lifecycle?.reset();this.entryFrameSounds=[];this.entryFrameControls=[];
    this.prefetchTicket=null;this.prefetchLease=null;
    for(const run of [this.run,...this.detachedRuns].filter(Boolean)){if(!run.primary_resolved)run.reject(abortError(reason));this._releaseRun(run);}
    this.run=null;this.detachedRuns=[];this.playbackRuntime.currentRun=null;
    for(const lease of this.retiredLeases.splice(0))lease.release();
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

  _damaging(result) {return result.hit !== false && result.hit !== 'miss' && result.hit !== 'MISS' && Number(result.damage) > 0;}

  _queueDamageText(channel,result,now){
    if(result.skipped||result.item_used||result.item_effect||result.revived||result.supported&&!(result.hp_delta>0))return;
    const miss=result.hit===false||['miss','MISS'].includes(result.hit);
    if(!miss&&!(Number.isFinite(result.damage)&&result.damage>=0))return;
    const targetId=channel.result.target_id,slot=this._slots(channel)[targetId];if(!slot)return;
    this.damageTexts=this.damageTexts.filter(e=>now-e.created_at<900);
    const lane=this.damageTexts.filter(e=>e.target_id===targetId).length;
    this.damageTexts.push({id:++this.damageTextSerial,target_id:targetId,text:miss?'MISS':String(result.supported?result.hp_delta:result.damage),miss,healed:Boolean(result.supported),created_at:now,
      x:this.stageMeta?slot[0]+34+Math.floor(lane/4)*28:Math.max(20,Math.min(940,slot[0]+34+Math.floor(lane/4)*28)),ground_y:slot[1],
      y:Math.max(28,slot[1]-70-(lane%4)*24)});
  }

  _drawDamageTexts(now){
    this.damageTexts=this.damageTexts.filter(e=>now-e.created_at<900);
    const c=this.context,scaleX=this.stageMeta?1.125:1.5,scaleY=1.125;
    for(const e of this.damageTexts){const age=Math.max(0,now-e.created_at);
      const asset=this.damageTextAssets[e.miss?'miss':e.healed?'healed':'damage'];
      const frames=e.miss?[asset.frames[0]]:[...e.text].map(digit=>asset.frames[Number(digit)]);
      const center=this.stageMeta?Math.max(140,Math.min(820,e.x-this._stageCameraOffset(e.ground_y))):e.x;
      const width=asset.width*scaleX,height=asset.height*scaleY,x=center-width*frames.length/2,y=e.y-age/60-height;
      c.save();c.globalAlpha=1-age/900;
      for(const [index,frame]of frames.entries())drawBattleImage(c,this.images.get('/'+frame.image),x+index*width,y,width,height);
      c.restore();
    }
  }

  _role(id) {return this.meta.roles.find(role => role.id === (this.roster.find(a=>a.id===id)?.resource_id??id));}

  _sprite(role, actionIndex, frame, x, y, alpha = 1, pair = null, appearanceScan = null) {
    const ctx = this.context, action = role.actions.find(item => item.index === actionIndex);
    const scale = this.meta.policy.sprite_scale, width = role.frame_width, height = role.frame_height;
    if(this.assetPlan&&!pair)pair=this.lifecyclePairs.get(`${role.id}:${action.first_frame+frame}`)??null;
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = 'source-over';
    const dx = x - role.anchor.x * scale, dy = y - role.anchor.y * scale;
    if(appearanceScan&&ctx.supportsNativeAppearance)ctx.nativeAppearance={...appearanceScan,
      x:dx,y:dy,width:width*scale,height:height*scale,native_width:width*scale,native_height:height*scale};
    const drawActor=(image,sx,sy,sw,sh,tx,ty,tw,th,smooth=true)=>{
      if(appearanceScan&&!ctx.supportsNativeAppearance&&globalThis.document?.createElement){
        const source=this._appearanceRaster(image,sx,sy,sw,sh,scale,appearanceScan);
        drawBattleImage(ctx,source,0,0,source.width,source.height,tx,ty,tw,th);
      }else if(smooth&&ctx.drawActorImage)ctx.drawActorImage(image,sx,sy,sw,sh,tx,ty,tw,th);
      else drawBattleImage(ctx,image,sx,sy,sw,sh,tx,ty,tw,th);
    };
    if (pair) {
      drawActor(this.images.get('/' + pair.main.path), 0, 0, width, height, dx, dy, width * scale, height * scale);
      if (pair.intrinsic.active) {
        ctx.globalCompositeOperation = 'lighter';
        drawActor(this.images.get('/' + pair.intrinsic.path), 0, 0, width, height, dx, dy, width * scale, height * scale,false);
      }
    } else {
      drawActor(this.images.get(action.sheet), frame * width, role.direction * height,
        width, height, dx, dy, width * scale, height * scale);
    }
    ctx.restore();
  }

  _appearanceRaster(image,sx,sy,width,height,scale,scan){
    // Canvas compatibility path. Production uses the batched GPU scan above;
    // retain at most eight small source poses for Canvas pixel comparisons.
    this.appearanceRasters??=new Map();
    const key=[sx,sy,width,height,scale].join(':');
    let cached=[...this.appearanceRasters.values()].find(row=>row.image===image&&row.key===key);
    if(!cached){
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(width*scale);canvas.height=Math.ceil(height*scale);
      const context=canvas.getContext('2d',{willReadFrequently:true});context.imageSmoothingEnabled=false;
      drawBattleImage(context,image,sx,sy,width,height,0,0,canvas.width,canvas.height);
      const original=context.getImageData(0,0,canvas.width,canvas.height),output=context.createImageData(canvas.width,canvas.height);
      cached={image,key,canvas,context,original,output};
      if(this.appearanceRasters.size>=8)this.appearanceRasters.delete(this.appearanceRasters.keys().next().value);
      this.appearanceRasters.set(Symbol(key),cached);
    }
    const {canvas,context,original,output}=cached;output.data.set(original.data);
    const base=scan.min_x+Math.max(0,scan.render_calls-1)*8;
    for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){
      const at=(y*canvas.width+x)*4,target=original.data[at+3],current=base-(scan.mode===5?y:x);
      if(current<target)output.data[at+3]=Math.round(Math.max(0,current)*255/256);
    }
    context.putImageData(output,0,0);return canvas;
  }

  _groundFootprint(role){
    const cached=this.groundFootprints?.get(role.id);if(cached)return cached;
    // A fixed idle reference keeps breathing, weapons and attack frames from
    // moving the ground contact. Bounds retain the original DGP frame space.
    const poses=role.idle_sequence?.segments??[role.idle],bounds=poses.flatMap(segment=>{
      const action=role.actions.find(row=>row.index===segment.action_index);
      return segment.frames.map(frame=>this.lifecyclePairs?.get(`${role.id}:${action.first_frame+frame}`)?.main.bounds).filter(Boolean);
    });
    const median=values=>{values.sort((a,b)=>a-b);const middle=Math.floor(values.length/2);return values.length%2?values[middle]:(values[middle-1]+values[middle])/2;};
    const scale=this.meta.policy.sprite_scale,groundOffset=this.content.roles[role.id]?.presentation?.ground_offset;
    const x=bounds.length?(median(bounds.map(b=>(b[0]+b[2])/2))-role.anchor.x)*scale:0;
    const y=groundOffset!==undefined?groundOffset*1.125:bounds.length?(median(bounds.map(b=>b[3]))-role.anchor.y)*scale:32*1.125;
    const radius=bounds.length?Math.max(12,Math.min(82,median(bounds.map(b=>b[2]-b[0]))*scale*.45)):82;
    const footprint={x,y,radius_x:radius,radius_y:Math.min(15,radius*.2)};
    this.groundFootprints??=new Map();this.groundFootprints.set(role.id,footprint);return footprint;
  }

  _slots(run,ground=false) {
    const policy = this.meta.policy;
    const enemies=this.roster.filter(a=>a.side==='enemy'),players=this.roster.filter(a=>a.side==='player');
    const slots=Object.fromEntries(this.roster.map(a=>[a.id,a.side==='player'?[policy.player_slot[0]+(players.indexOf(a)%2)*95,policy.player_slot[1]+Math.floor(players.indexOf(a)/2)*100+(players.indexOf(a)%2)*65]:
      [policy.enemy_slot[0]+(enemies.indexOf(a)%2)*145,policy.enemy_slot[1]+(Math.floor(enemies.indexOf(a)/2)-(enemies.length>2?.5:0))*125]]));
    if(this.stageMeta)for(const [id,[x,y]]of Object.entries(battleActorPositions(this.roster)))slots[id]=[120+x*1.125,y*1.125];
    // Interpolate one ground path, then recover each body's own source origin.
    // A target's different anchor or flight height must not stretch the gap
    // between the attacker's feet and shadow during approach and return.
    const footprints=this.stageMeta?new Map(this.roster.map(actor=>[actor.id,this._groundFootprint(this._role(actor.id))])):null;
    if(footprints)for(const [id,foot]of footprints){slots[id][0]+=foot.x;slots[id][1]+=foot.y;}
    const project=()=>{if(footprints&&!ground)for(const [id,foot]of footprints){slots[id][0]-=foot.x;slots[id][1]-=foot.y;}return slots;};
    if (!run||run.main_done||run.done) return project();
    const actingRole=this._role(run.result.actor_id),skill=(actingRole.alternate_skills??[]).find(s=>s.runtime_skill_id===run.result.skill_id)??actingRole.skill;
    const step = run.steps[run.cursor], segments = run.segments??skill.segments;
    if(run.entry){slots[run.result.actor_id][0]+=nativeEntryOffset(run.entry,run.elapsed)*(this.stageMeta?1.125:this.meta.policy.sprite_scale);return project();}
    if(step.command_raw!==undefined)return project();
    let progress = 0;
    if (this.content.roles[actingRole.id]?.presentation?.legacy_motion==='bounce'&&!run.sequence) {
      if (step.segment_index === 0) progress = 0;
      else if (step.segment_index === 1) {
        const count = segments[1].frames.length;
        progress = step.logical_frame < count / 2 ? (step.logical_frame + 1) / (count / 2) : (count - step.logical_frame) / (count / 2);
      } else progress = 0;
      const amount = Math.max(0, Math.min(1, progress));
      slots[run.result.actor_id][0] += policy.approach_distance * amount;
      return project();
    }
    // Native +0x1e's sign identifies outward/return records. Legacy metadata
    // lacks that field and retains its two previously tagged movement records.
    const signed = segments.some(s => s.movement_step_raw !== undefined);
    const tagged = segments.map((s,i) => s.movement_flag_raw ? i : -1).filter(i => i>=0);
    const outward = signed ? segments.findIndex(s => s.movement_step_raw>0) : tagged[0]??-1;
    const returning = signed ? segments.findIndex((s,i) => i>outward && s.movement_step_raw<0) : tagged.at(-1)??-1;
    if (outward<0 || returning<=outward) return project();
    // Move from the beginning of the current visited frame, not one frame
    // ahead. A one-frame return must still travel for that frame's duration.
    // Reaction channels and source-specific intervals own their local clocks;
    // reversed source frame numbers never reverse the direction of travel.
    const first=run.steps.findIndex(row=>row.command_raw===undefined&&row.segment_index===step.segment_index);
    const interval=run.frame_duration_ms??policy.frame_ms;
    const elapsed=run.sequence?run.elapsed-(run.frame_started_at??0):run.elapsed%interval;
    const phase=Math.max(0,Math.min(1,elapsed/interval));
    const fraction = Math.max(0,Math.min(1,(run.cursor-first+phase)/segments[step.segment_index].frames.length));
    if (step.segment_index===outward) progress=fraction;
    else if (step.segment_index>outward && step.segment_index<returning) progress=1;
    else if (step.segment_index===returning) progress=1-fraction;
    const amount = Math.max(0, Math.min(1, progress));
    const origin=slots[run.result.actor_id], target=slots[run.result.target_id]??origin;
    const direction = Math.sign(target[0]-origin[0]) || (this.roster.find(actor=>actor.id===run.result.actor_id)?.side==='player'?-1:1);
    const gap = policy.contact_gap ?? 110;
    origin[0] += (target[0]-direction*gap-origin[0])*amount;
    origin[1] += (target[1]+(policy.contact_y_offset??0)-origin[1])*amount;
    return project();
  }

  paintIdle(snapshot, now = performance.now()) {return this.draw(snapshot, now);}

  actorPositions(){
    if(!this.meta)return null;
    const slots=this.drawnSlots??this._slots(this.run);
    return Object.fromEntries(Object.entries(slots).map(([id,[x,y]])=>[id,this.stageMeta?[(x-120-(!this.drawnSlots?this._stageCameraOffset(y):0))/1.125-(this.cameraShake?.x??0),y/1.125-(this.cameraShake?.y??0)]:[x*640/960-(this.cameraShake?.x??0)-(this.cameraPan?.x??0),y*480/540-(this.cameraShake?.y??0)]]));
  }

  _stageCameraOffset(y){
    if(!this.stageMeta||!this.cameraPan?.x)return 0;
    const ground=this.stageMeta.layers.find(layer=>layer.id===this.stageMeta.default_composition.ground.layer_id);
    return battleStageCameraOffset(this.stageMeta,this.cameraPan.x,y/1.125-(480-ground.source.height))*1.125;
  }

  actorCursorHeight(id){return this._role(id)?.cursor_height_raw;}

  drainLifecycleCompleted(){return this.lifecycle?.drainCompleted()??[];}
  lifecycleSnapshot(){return this.lifecycle?.snapshot()??null;}
  prepareEntry(snapshot,now){
    if(!this.lifecycle||this.lifecycle.entryPrepared)return;
    const current=this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())?this.nativeControl.state:null;
    this.preparingEntry=true;
    const visible=(id,pose)=>{
      if(!pose)return false;
      const role=this._role(id),bounds=this._appearanceBounds(role.id,pose),scan=pose.appearance_scan;
      if(bounds.empty)return false;
      if(scan){
        const initial=scan.mode===5?scan.min_x-bounds.min_y:0;
        if(initial+8*(scan.render_calls-1)<=0)return false;
      }
      if(pose.offset_x===undefined)return true;
      const scale=this.meta.policy.sprite_scale,x=this._slots(null)[id][0]+pose.offset_x*(this.stageMeta?1.125:scale)-role.anchor.x*scale;
      // A running entry can be opaque while its occupied pixels are still
      // outside the viewport. Prepare those hidden frames before capture.
      return x+bounds.max_x>(this.stageMeta?120:0)&&x+bounds.min_x<(this.stageMeta?840:960);
    };
    try{return this.lifecycle.prepareEntry(current?.lifecycle_events?{...snapshot,actors:current.actors,lifecycle_events:current.lifecycle_events}:snapshot,this.roster,now,visible);}
    finally{this.preparingEntry=false;}
  }

  _particleEffect(actorId,roleId,mode,event,appearance=false){
    if(!globalThis.document?.createElement)return null; // headless timing adapter
    const role=this.meta.roles.find(r=>r.id===roleId),pose=this.lastActorPoses.get(actorId);
    const fallback=appearance?role.idle:role.reaction,action=role.actions.find(a=>a.index===(pose?.action_index??fallback.action_index));
    const frame=pose?.action_frame??(appearance?fallback.frames[0]:fallback.frames.at(-1)),pair=this.lifecyclePairs.get(`${roleId}:${action.first_frame+frame}`);
    const image=this.images.get(pair?'/'+pair.main.path:action.sheet),scale=this.meta.policy.sprite_scale;
    const source=document.createElement('canvas');source.width=Math.ceil(role.frame_width*scale);source.height=Math.ceil(role.frame_height*scale);
    const c=source.getContext('2d',{willReadFrequently:true});c.imageSmoothingEnabled=false;
    drawBattleImage(c,image,pair?0:frame*role.frame_width,pair?0:role.direction*role.frame_height,role.frame_width,role.frame_height,0,0,source.width,source.height);
    const effect=createDeathParticleSurface({rgba:c.getImageData(0,0,source.width,source.height).data,width:source.width,height:source.height,
      anchor:{x:role.anchor.x*scale,y:role.anchor.y*scale},mode,appearance,seed:`${this.lifecycle?.battleId}:${event.life_epoch}:${event.token}`});
    if(appearance)effect.pose={action_index:action.index,action_frame:frame,source_frame:action.first_frame+frame};
    return effect;
  }

  _appearanceBounds(roleId,pose){
    const role=this.meta.roles.find(r=>r.id===roleId),action=role.actions.find(a=>a.index===(pose?.action_index??role.idle.action_index));
    const frame=pose?.action_frame??role.idle.frames[0],key=`${roleId}:${action.index}:${frame}`;
    if(this.lifecycleBounds.has(key))return this.lifecycleBounds.get(key);
    const scale=this.meta.policy.sprite_scale;
    // Scan the verified source sprite, never the composed battle background.
    // Retain occupied-pixel bounds for scan appearance and viewport entry.
    const sourcePose={action_index:action.index,action_frame:frame,source_frame:action.first_frame+frame};
    if(!globalThis.document?.createElement)return {min_x:0,min_y:0,max_x:Math.floor((role.frame_width-1)*scale),max_y:Math.floor((role.frame_height-1)*scale),empty:false,pose:sourcePose};
    const pair=this.lifecyclePairs.get(`${roleId}:${action.first_frame+frame}`),image=this.images.get(pair?'/'+pair.main.path:action.sheet);
    const surface=document.createElement('canvas');surface.width=role.frame_width;surface.height=role.frame_height;
    const c=surface.getContext('2d',{willReadFrequently:true});
    drawBattleImage(c,image,pair?0:frame*role.frame_width,0,role.frame_width,role.frame_height,0,0,role.frame_width,role.frame_height);
    const rgba=c.getImageData(0,0,surface.width,surface.height).data;let minX=surface.width,minY=surface.height,maxX=-1,maxY=-1;
    for(let y=0;y<surface.height;y++)for(let x=0;x<surface.width;x++)if(rgba[(y*surface.width+x)*4+3]){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    const bounds={min_x:Math.floor(minX*scale),min_y:Math.floor(minY*scale),max_x:Math.floor(maxX*scale),max_y:Math.floor(maxY*scale),empty:maxY<0,pose:sourcePose};this.lifecycleBounds.set(key,bounds);return bounds;
  }

  _actorPresentation(snapshot,now,{entryPreview=false,run=entryPreview?null:this.playbackRuntime.currentRun}={}){
    const roots=entryPreview?[]:[...this.detachedRuns,...(this.run?[this.run]:[])],slots = this._slots(run),groundSlots=this._slots(run,true);
    if(run?.sequence)for(const c of roots.flatMap(root=>[...root.children,...(!root.main_done?[root]:[])]).filter(c=>!c.done)){slots[c.result.actor_id]=this._slots(c)[c.result.actor_id];groundSlots[c.result.actor_id]=this._slots(c,true)[c.result.actor_id];}
    // 513FC0 projects horizontal camera motion by ground depth before applying
    // altitude. Shadows, effects and HUD consume these same projected slots.
    if(!entryPreview&&this.stageMeta&&this.cameraPan?.x)for(const [id,slot]of Object.entries(slots)){
      const offset=this._stageCameraOffset(slot[1]);slot[0]-=offset;groundSlots[id][0]-=offset;
    }
    const actors = new Map((snapshot?.actors || []).map(actor => [actor.id, actor]));
    const victory=!entryPreview&&snapshot?.phase==='victory'?this.victoryPlayback:null;
    const queue=[...this.roster.filter(a=>a.side==='enemy'),...this.roster.filter(a=>a.side==='player')].map(a=>({...a,depth_y:groundSlots[a.id][1]}));
    // Ground depth follows approach/return on both stage and preview paths.
    // Native altitude moves the body only; it must not change occlusion order.
    queue.sort((a,b)=>a.depth_y-b.depth_y);
    const entries=[];
    for (const {id} of queue) {
      if(entryPreview&&!this.lifecycle?.entryPrepared&&snapshot?.lifecycle_events?.some(event=>event.actor_id===id&&event.kind==='entry'))continue;
      const role = this._role(id), actor = actors.get(id), slot = slots[id];
      const nativeZ=this.nativeControl&&(!this.nativeControlIsCurrent||this.nativeControlIsCurrent())?this.nativeControl.actor(id)?.native_z_raw:actor?.native_z_raw;
      if(Number.isFinite(nativeZ))slot[1]+=nativeZ*(this.stageMeta?1.125:this.meta.policy.sprite_scale);
      const lifePose=this.lifecycle?.pose(id);
      if((actor?.escaped||actor?.state_raw===11)&&lifePose?.offset_x===undefined)continue;
      if(lifePose?.offset_x!==undefined){const offset=lifePose.offset_x*(this.stageMeta?1.125:this.meta.policy.sprite_scale);slot[0]+=offset;groundSlots[id][0]+=offset;}
      if(this.lifecycle?.hidden(id))continue;
      const dead = actor?.alive === false || actor?.hp?.current === 0;
      let alpha = 1, segment = role.idle, frame = poseFrame(segment,now,true), pair = null;
      const idlePose=actor?.idle_pose??(role.idle_sequence?idlePoseAt(role.idle_sequence.segments,now):null);
      if(idlePose){segment={action_index:idlePose.action_index};frame=idlePose.action_frame;}
      const acting=run?.sequence?roots.flatMap(root=>[...root.children,...(!root.main_done?[root]:[])]).reverse().find(c=>!c.done&&c.result.actor_id===id):run?.result.actor_id===id?run:null;
      const impacting=run?.sequence?roots.flatMap(root=>this._sequenceChannels(root).map(channel=>({channel,at:root.started+(channel.at??0)+(channel.impact_elapsed??0)}))).filter(({channel:c})=>c.result.target_id===id&&c.impact_called&&this._damaging(c.result)).sort((a,b)=>b.at-a.at)[0]?.channel:run?.result.target_id===id&&run.impact_called&&this._damaging(run.result)?run:null;
      const victorySequence=victory?.sequences.get(id);
      const appearanceScan=victorySequence?null:lifePose?.appearance_scan??null;
      if(victorySequence){
        ({segment,frame}=victoryPoseAt(victorySequence,now-victory.started));
        const action=role.actions.find(row=>row.index===segment.action_index);
        pair=this.lifecyclePairs.get(`${role.id}:${action.first_frame+frame}`)??null;
      } else if(lifePose){segment={action_index:lifePose.action_index};frame=lifePose.action_frame;alpha=appearanceScan&&(this.context.supportsNativeAppearance||globalThis.document?.createElement)?1:lifePose.alpha??1;
        pair=this.lifecyclePairs.get(`${role.id}:${lifePose.source_frame}`)??null;
      } else if (acting) {
        const step = acting.steps[acting.cursor],visual=step.command_raw!==undefined?step.visual:step;
        if(visual){segment = {action_index: visual.action_index}; frame = visual.action_frame; pair = visual.pair;}
      } else if(actor?.native_active&&this.lastActorPoses.has(id)){
        // The controller selects the next landing/get-up source at this
        // frame's completion acknowledgement. Retain the displayed pose
        // through that handoff instead of inserting an idle frame.
        const last=this.lastActorPoses.get(id);segment={action_index:last.action_index};frame=last.action_frame;
        const action=role.actions.find(a=>a.index===segment.action_index);pair=this.lifecyclePairs.get(`${role.id}:${action.first_frame+frame}`)??null;
      } else if(actor?.defending&&role.response_skills?.some(s=>s.chr_skill_index===9)){
        segment=role.response_skills.find(s=>s.chr_skill_index===9).segments[0];
        frame=poseFrame(segment,now-(this.defendClocks.get(id)??now));
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
      if(visibility){const progress=visibility.complete?1:Math.min(1,Math.max(0,acting.elapsed-visibility.started)/(visibility.complete_ticks*visibility.clock_ms));alpha*=visibility.kind==='appear'?progress:1-progress;}
      else if(actor?.native_visibility?.complete&&actor.native_visibility.kind==='disappear')alpha=0;
      if(!lifePose)alpha*=this.lifecycle?.alpha(id)??1;
      entries.push({id,role,actor,slot,nativeZ,segment,frame,pair,alpha,acting,appearanceScan});
    }
    return {roots,slots,groundSlots,entries};
  }

  draw(snapshot, now = performance.now(), {entryPreview=false} = {}) {
    if (this.destroyed) return;
    if (!Number.isFinite(now)) throw new Error('战斗表现时钟无效');
    this.drawing=true;
    try{
    const run=entryPreview?null:this.playbackRuntime.currentRun;
    const ctx = this.context, width = this.canvas.width, height = this.canvas.height;
    ctx.beginFrame?.();
    ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,width,height);ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
    const viewport=battleViewport(width,height);
    ctx.save();ctx.beginPath();ctx.rect(viewport.x,viewport.y,viewport.width,viewport.height);ctx.clip();
    if(this.stageMeta)ctx.setTransform(viewport.scale/1.125,0,0,viewport.scale/1.125,viewport.x-120*viewport.scale/1.125,viewport.y);
    else ctx.setTransform(viewport.width/960,0,0,viewport.height/540,viewport.x,viewport.y);
    if(!entryPreview&&this.cameraShake){const scale=this.stageMeta?1.125:(this.meta?.policy.sprite_scale??1.5);ctx.translate(-this.cameraShake.x*scale,-this.cameraShake.y*scale);}
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 960, 540);
    if(this.stageMeta){ctx.fillStyle='#101719';ctx.fillRect(0,0,960,540);drawForestStageBackground(ctx,this.stageMeta,this.images,entryPreview?0:now-(this.stageStarted??now),entryPreview?null:this.colorFade,entryPreview?0:this.cameraPan?.x??0);}
    else{
      const backdrop = ctx.createLinearGradient(0, 0, 0, 540);
      backdrop.addColorStop(0, '#111f27'); backdrop.addColorStop(.68, '#273b42'); backdrop.addColorStop(1, '#142429');
      ctx.fillStyle = backdrop; ctx.fillRect(0, 0, 960, 540);
      ctx.strokeStyle = '#759a9a35'; ctx.beginPath(); ctx.moveTo(0, 384); ctx.lineTo(960, 384); ctx.stroke();
    }
    if (!this.ready){ctx.restore();return;}
    if(!entryPreview&&!this.stageMeta&&this.cameraPan)ctx.translate(-this.cameraPan.x*this.meta.policy.sprite_scale,0);
    const cached=this.presentationFrame;
    const {roots,slots,groundSlots,entries}=!entryPreview&&cached?.snapshot===snapshot&&cached.now===now
      ?cached.frame:this._actorPresentation(snapshot,now,{entryPreview,run});
    this.drawnSlots=slots;
    if (run) {
      const o=run.observations,slot=slots[run.result.actor_id];o.draws++;
      o.origin_slot??=clone(this._slots(null)[run.result.actor_id]);o.last_slot=clone(slot);
      if(run.impact_called&&!o.contact_slot)o.contact_slot=clone(slot);
      o.bounds??=[...slot,...slot];o.bounds=[Math.min(o.bounds[0],slot[0]),Math.min(o.bounds[1],slot[1]),Math.max(o.bounds[2],slot[0]),Math.max(o.bounds[3],slot[1])];
    }
    // The HUD consumes this frame's positions, including reaction-channel
    // movement and native altitude, rather than reconstructing formation slots.
    this.drawnSlots=slots;
    for (const {id,role,actor,slot,nativeZ,segment,frame,pair,alpha,acting,appearanceScan} of entries) {
      ctx.save();
      if(role.shadow){
        const s=role.shadow,sourceFrame=role.actions.find(a=>a.index===segment.action_index).first_frame+frame,scale=this.meta.policy.sprite_scale;
        ctx.globalAlpha=alpha;
        drawBattleImage(ctx,this.images.get(s.sheet),(sourceFrame%s.columns)*s.frame_width,Math.floor(sourceFrame/s.columns)*s.frame_height,s.frame_width,s.frame_height,
          slot[0]+(s.x-role.anchor.x)*scale,slot[1]+(s.y-role.anchor.y)*scale-(Number.isFinite(nativeZ)?nativeZ*(this.stageMeta?1.125:scale):0),s.frame_width*scale,s.frame_height*scale);
      }else if(!('shadow' in role)){
        ctx.globalAlpha=alpha*.4;ctx.fillStyle='#071315';ctx.beginPath();
        const shadow=this.stageMeta?groundSlots[id]:[slot[0],slot[1]+24],footprint=this.stageMeta?this._groundFootprint(role):null;
        ctx.ellipse(shadow[0],shadow[1],footprint?.radius_x??82,footprint?.radius_y??15,0,0,Math.PI*2);ctx.fill();
      }
      ctx.restore();
      if(!this.lifecycle?.drawParticles(id,ctx,slot[0],slot[1]))this._sprite(role, segment.action_index, frame, slot[0], slot[1], alpha, pair,appearanceScan);
      if(!entryPreview&&this.statusMeta)drawBattleStatuses(ctx,this.images,this.statusMeta,[{actor,role,slot,alpha}],this.meta.policy.sprite_scale);
      if(acting&&pair?.intrinsic.active&&!run.observations.intrinsic_source_frames.includes(pair.source_frame))run.observations.intrinsic_source_frames.push(pair.source_frame);
    }
    if (run) {
      for (const [channel,effect] of (run.sequence?roots.flatMap(root=>this._sequenceChannels(root)):[run]).flatMap(c=>c.effects.map(e=>[c,e]))) {
        const asset = this.meta.effects.find(item => item.id === effect.asset_id);
        const cursor = Math.floor((channel.elapsed - effect.at) / (effect.frame_ms??run.frame_ms??this.meta.policy.frame_ms));
        if (cursor < 0 || cursor >= (effect.frame_count??asset.frames.length)) continue;
        const slot = slots[effect.slot === 'actor' ? channel.result.actor_id : effect.target_id??channel.result.target_id];if(!slot&&!effect.full_screen_effect)continue;
        const scale = this.meta.policy.sprite_scale;
        const sourceFrame=(effect.source_frames??asset.frames)[cursor];
        // 52AE7F/54F68B reject a frame beyond the physical DGP pool while
        // 5074C0 continues to the original CHR end. Keep that blank visit.
        if(!Number.isInteger(sourceFrame)||sourceFrame<0||sourceFrame>=asset.frame_count)continue;
        ctx.save();
        if(effect.full_screen_effect)ctx.setTransform(1,0,0,1,0,0);
        for(const layer of asset.layer_order??[null]){
          ctx.globalCompositeOperation=layer?asset[`${layer}_blend`]:asset.blend;
          drawBattleImage(ctx,this.images.get(layer?asset[`${layer}_sheet`]:asset.sheet), sourceFrame*asset.frame_width,0,
            asset.frame_width,asset.frame_height,effect.full_screen_effect?viewport.x:slot[0]-asset.anchor.x*scale,effect.full_screen_effect?viewport.y:slot[1]-asset.anchor.y*scale,
            effect.full_screen_effect?viewport.width:asset.frame_width*scale,effect.full_screen_effect?viewport.height:asset.frame_height*scale);
        }
        ctx.restore();
        if(!run.observations.effect_ids.includes(asset.id))run.observations.effect_ids.push(asset.id);
      }
    }
    if(!entryPreview)this._drawDamageTexts(now);
    ctx.restore();
    }finally{this.drawing=false;for(const lease of this.retiredLeases.splice(0))lease.release();}
  }
}
