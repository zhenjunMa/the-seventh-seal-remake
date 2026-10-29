// battle adapters. Persistent state belongs to the shared runtime context.
import {effectiveSkillSource} from "../core/battle_skill_access.mjs";
import {BattleController} from "../core/combat.mjs";
import {resolveAction, applyNativeDamage, createNativeRng} from "../core/combat_rules.mjs";
import {createBattleSample, resourcesForWorld, consumeBattleMp} from "../combat_sample.mjs";
import {BattleView} from "../battle_view.mjs";
import {BattleMenuView} from "../battle_menu_view.mjs";
import {createForestSample, assembleForestSample} from "../forest_sample.mjs";
import {createPartySample} from "../party_sample.mjs";
import {partyResourcesForWorld, consumePartyMp} from "../core/party_attributes.mjs";
import {battleStage} from "../core/content_registry.mjs";
import {planPartyDefeat} from "../core/recovery.mjs";
import {techniqueSlots,techniqueSlotName} from "../core/menu_techniques.mjs";
import {battleTechniqueId} from "../core/battle_techniques.mjs";
import {WorldStore} from "../core/world.mjs";
import {createSkillTestSample} from "../skill_test_sample.mjs";
import {commitSkillTestResources} from "../core/skill_test_commit.mjs";
import {battleResources} from "../core/battle_resources.mjs";
import {beginScriptedBattle,commitScriptedBattle} from '../core/scripted_battle.mjs';
import {playbackTask} from '../core/story_playback.mjs';

export function createBattleController({state, actions, $, canvas, ctx}) {
  const captureScene=kind=>actions.captureScene?.(kind)??(kind==='battle'?$('battleCanvas'):canvas);
  function updateBattle(snapshot){
    if(!snapshot||snapshot.phase==='closed')return;
    const phase=snapshot.phase==='command'?'battle-command':snapshot.phase==='charging'?'battle-charging':snapshot.phase==='action'?'battle-action':snapshot.phase==='interrupted'?'battle-interrupted':'battle-result';
    if(!state.battleEntryPending&&state.scenes.phase!==phase)state.scenes.setPhase(phase);
    const node=$('battleCommands');node.dataset.phase=snapshot.phase;node.dataset.round=snapshot.round;
    node.dataset.mode=state.skillTestSession?'skill-test':'battle';
    const impacted=snapshot.last_impact;
    node.dataset.impactFrame=impacted?.source_frame??'';
    node.dataset.impactActor=impacted?.actor_id??'';
    node.dataset.impactCount=snapshot.impact_count;
    $('battleMessage').textContent=snapshot.phase==='victory'?'战斗胜利':snapshot.phase==='defeat'?'队伍已经倒下':snapshot.phase==='escaped'?'已经逃离战斗':snapshot.phase==='interrupted'?snapshot.error:snapshot.phase==='action'?'正在行动':snapshot.phase==='command'?'选择行动':'行动槽充能中';
    state.battleMenu?.update(snapshot);
    if(state.scriptedBattleSession){
      if(snapshot.phase==='defeat'&&!state.scriptedBattleSession.returnPending)queueMicrotask(actions.guarded(returnFromBattle));
    }else if(state.skillTestSession){
      if(snapshot.phase==='escaped'&&!state.skillTestSession.returnPending){state.skillTestSession.returnPending=true;queueMicrotask(actions.guarded(returnFromBattle));}
    }else if(snapshot.phase==='defeat'&&state.world.value.source.kind==='native-new-game')queueMicrotask(actions.guarded(returnFromBattle));
  }
  function battleKey(key,repeat=false){return state.battleMenu?.key(key,repeat)??false;}
  function battleKeyUp(key){state.battleMenu?.keyup(key);}
  function updateBattleFrame(now){
    if(state.battleEntryPending||state.battlePresentationError||state.battleResourceWaits?.size)return;
    try{
      now=state.battleView?.resourceTime?.()??now;
      state.battle?.advanceClock(now);
      state.battleView?.draw(state.battle?.presentationSnapshot(),now);drawBattleInterface(now);
    }catch(error){
      state.battlePresentationError=error.message;state.battleView?.stop(error.message);
      state.battle?.interrupt(error);actions.status(error.message,true);
    }
  }
  function drawBattleInterface(now){if(state.battleMenu){state.battleMenu.draw(now,state.battleView?.actorPositions());state.battleMenu.paintTo(state.engine?.battle.surface.canvas??$('battleCanvas'));
    $('battleCommands').dataset.lifecycle=JSON.stringify(state.battleView?.lifecycleSnapshot());
    const battle=state.battle,completed=state.battleView?.drainLifecycleCompleted()??[];
    if(completed.length)queueMicrotask(()=>{if(state.battle===battle)for(const event of completed)battle.ackLifecycle(event);});
  }state.engine?.battle.surface.endFrame();}
  async function prepareView({mode,newParty,stagePath=null,lifecycle=false,actors,skills,inventory,onProgress,signal}){
    mode=`${mode}:${stagePath??''}`;
    if(!state.battleViews.has(mode))state.battleViews.set(mode,new BattleView({canvas:state.engine?.battle.surface.canvas??$('battleCanvas'),
      metadataPath:newParty?'/'+state.catalog.party_battle_view:stagePath?'/'+state.catalog.forest_battle_view:'/data/battle_view.json',
      itemMetadataPath:newParty?'/data/item_presentation.json':null,stageMetadataPath:stagePath,lifecycleMetadataPath:lifecycle?'/data/battle_lifecycle.json':null}));
    const view=state.battleViews.get(mode);
    view.onResourcesPrepared=images=>state.engine?.battle.surface.prepareImages?.(images);
    view.onResourceError=error=>actions.log({type:'battle-resource-prefetch-failed',error:error.message});
    const cancel=()=>view.cancelPreparation?.('战斗准备已取消');signal?.throwIfAborted();signal?.addEventListener('abort',cancel,{once:true});
    try{await view.prepare({actors,skills,inventory,staged:true,onProgress});}finally{signal?.removeEventListener('abort',cancel);}
    if(view.images)view.onResourcesPrepared(view.entryLease?.images??view.images);return view;
  }
  function createCombat(world,newParty,view){
    let battle,waits=0,waitStarted=0,waitTotal=0;
    const now=()=>state.engine?.battle.clock.time??performance.now()-waitTotal-(waits?performance.now()-waitStarted:0);
    const withResources=async(work,wait=true)=>{
      const reason=Symbol('battle-resources'),generation=view.generation,started=performance.now();
      if(wait){if(!waits++)waitStarted=performance.now();(state.battleResourceWaits??=new Set()).add(reason);state.engine?.pause(reason);}
      const signal=view.resourceController?.signal;
      try{const result=await playbackTask(work(),signal);if(state.battle!==battle||view.destroyed||view.generation!==generation){result?.release?.();throw new Error('战斗资源会话已失效');}if(wait)actions.log({type:'battle-resource-wait-complete',elapsed_ms:performance.now()-started,cache:battleResources.snapshot()});return result;}
      finally{if(wait){if(!--waits)waitTotal+=performance.now()-waitStarted;state.battleResourceWaits.delete(reason);state.engine?.resume(reason);}}
    };
    view.withResources=withResources;view.resourceTime=now;
    const play=async(method,result,options)=>{
      let lease;
      try{
        if(view.prepareAction){lease=await withResources(()=>view.prepareAction(result),!view.actionResourcesReady(result));if(lease)view.onResourcesPrepared?.(lease.images);}
        const playback=view[method](result,options);
        if(view.run)view.run.resourceLease=lease;else lease?.release();
        return await playback;
      }catch(error){lease?.release();throw error;}
    };
    const actionSound=(result,step)=>state.audio?.playAction({...step,sound_inhibited:Boolean(battle.actor(step.actor_id).immune_raw)},`${result.action_id}:${step.channel_id}:${step.plan_record_index}:${step.logical_frame}`);
    const effectSound=(result,step)=>state.audio?.playEffect(step.asset_id,`${result.action_id}:${step.channel_id}:${step.effect_index}`,step.logical_frame);
    const present=method=>async(result,options)=>{const played=await play(method,result,{...options,onFrame:step=>actionSound(result,step),onEffectFrame:step=>effectSound(result,step)});actions.log({type:'battle-presentation',action_id:result.action_id,actor_id:result.actor_id,skill_id:result.skill_id,observations:played.observations});return played;};
    battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,playAction:present('playAction'),playSequence:present('playSequence'),
      now,
      resourcesForWorld:newParty?partyResourcesForWorld:resourcesForWorld,consumeResources:newParty?consumePartyMp:consumeBattleMp,
      notify:snapshot=>{if(state.battle===battle)updateBattle(snapshot);},log:actions.log,itemData:newParty?state.itemData:null,
      playItem:async(event,hooks)=>{actions.status(`${event.name} → ${battle.actor(event.target_id).name}`);const played=await play('playItem',event,{...hooks,onFrame:step=>actionSound(event,step),onEffectFrame:step=>effectSound(event,step)});actions.log({type:'battle-item-presentation',action_id:event.action_id,item_id:event.item_id,observations:played.observations});}});
    view.nativeControl=battle;
    view.nativeControlIsCurrent=()=>state.battle===battle;
    view.onLifecycleFrame=step=>{if(state.battle===battle)actionSound({action_id:`${step.battle_id}:${step.lifecycle_token}`},{...step,channel_id:'lifecycle'});};
    return battle;
  }
  async function prepareHud(newParty,{returnLabel=null,onProgress,world=state.world,battle=state.battle,owner=null,signal}={}){
    const check=()=>{signal?.throwIfAborted();if(owner&&state.scriptedBattleSession!==owner)throw new Error('剧情战斗界面会话已失效');};
    if(!owner)state.battleMenu?.dispose();
    const [uiManifest,resultManifest]=await playbackTask(Promise.all([battleResources.json('data/battle_ui.json'),returnLabel?null:battleResources.json('data/battle_result.json')]),signal);check();
    const bindingSource=newParty?effectiveSkillSource(state.partySkills,world.value):null;
    const host=$('battleHud'),root=owner?host.ownerDocument.createElement('div'):host,view=state.battleView;
    const menu=new BattleMenuView({root,manifest:uiManifest,battle,returnLabel,reuseReturnButton:!owner,
      getCursorHeight:id=>view.actorCursorHeight(id),
      getSettings:()=>state.menuSettings?.snapshot()??{},getBindings:newParty?id=>techniqueSlots(world.value,bindingSource,id).map(slot=>({...slot,name:slot.type===1?battle.skills[battleTechniqueId(id,slot.index_one_based)]?.name:techniqueSlotName(bindingSource,id,slot)})):null,
      playCue:(...args)=>state.audio?.playCue(...args),onReturn:actions.guarded(returnFromBattle),onStage:stage=>{if(state.battle===battle)battle.setCommandStage?.(stage);},textRenderer:state.operationMenu?.textRenderer,memory:state.battleCursorMemory,resultManifest,onResultEvent:actions.log,
      now:view.resourceTime??(()=>state.engine?.battle.clock.time??performance.now()),deferResult:true,
      prepareResources:work=>view.withResources(work),onResourcesPrepared:view.onResourcesPrepared,
      prefetchCommand:command=>{void view.prefetchCommand?.(command);},
      onResourceError:error=>{if(state.battle===battle){battle.interrupt(error);actions.status(error.message,true);}}});
    if(owner)owner.menu=menu;else state.battleMenu=menu;
    try{
      await playbackTask(menu.prepare({onProgress}),signal);check();
      if(owner){
        owner.hudChildren=[...host.childNodes];owner.hudDataset={...host.dataset};host.replaceChildren(...root.childNodes);menu.root=host;
        menu.resizeObserver.unobserve?.(root);menu.resizeObserver.observe(host);menu.fit();state.battleMenu=menu;
      }
      return menu;
    }catch(error){menu.dispose();throw error;}
  }
  function showBattle(){
    state.engine?.setMode('battle');
    for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=false;
    canvas.hidden=true;$('dialogue').hidden=true;actions.resize();state.battleMenu.fit();
    if(state.scriptedBattleSession)$('openingShade').hidden=true;
  }
  async function prepareBattleResources(mode,work){
    const started=performance.now();
    // Keep the exploration/menu image visible until the battle can be drawn.
    // LoadingView is shared with map changes; its progress artwork is not an
    // entry animation and must never be exposed by battle preparation.
    const result=await work(()=>{});
    actions.log({type:'battle-resources-ready',mode,elapsed_ms:performance.now()-started,cache:battleResources.snapshot()});
    return result;
  }
  async function revealBattle(before,sample,start,transitionOptions={},isCurrent=()=>true){
    state.battleEntryPending=true;
    try{
      start();
      if(state.battleTransition&&before)await state.battleTransition.run(before,()=>{
        if(!isCurrent())throw new Error('剧情战斗入场会话已失效');
        showBattle();const snapshot=state.battle.presentationSnapshot();state.battleView.draw(snapshot,0);
        state.battleMenu.draw(0,state.battleView.actorPositions());state.battleMenu.paintTo(state.engine?.battle.surface.canvas??$('battleCanvas'));
        state.engine?.battle.surface.endFrame();
        const after=state.battleTransition.capture(captureScene('battle'));
        // The captured entry pose must not start lifecycle clocks during the transition.
        state.battleView.setRoster(sample.actors,sample.skills);return after;
      },transitionOptions);
      else showBattle();
    }finally{if(isCurrent())state.battleEntryPending=false;}
    if(isCurrent())updateBattle(state.battle.presentationSnapshot());
  }
  async function startBattle(group=null,encounterState=null){
    if(state.scenes.phase!=='map')return;
    const revision=state.world.value.revision,before=state.battleTransition?.capture(captureScene());state.battlePresentationError=null;
    state.battleCheckpoint={...state.view};state.scenes.setPhase('battle-loading');
    try{
      let sample,newParty;
      await prepareBattleResources('battle',async progress=>{
      state.battleData??=await actions.json(state.catalog.combat_sample??'data/combat_sample.json');
      newParty=state.world.value.source.kind==='native-new-game';
      if(newParty&&!group)throw new Error('新游戏请在白木森林中行走遇敌。');
      const configured=await actions.readConfiguredData();state.itemData=configured.items;
      progress({completed:10,total:100});
      const newScheduler={...configured.scheduler,policy:{...configured.scheduler.policy,commands:'Frame-driven charging and queued ready-player commands; menu selection and other actors animations continue charging.'},...(newParty?{idle_skills:{...configured.scheduler.idle_skills,...state.partySkills.idle_skills}}:{})};
      sample=newParty?assembleForestSample(createPartySample(state.world.snapshot(),state.partyCombat,state.partySkills,configured,state.itemData,state.operationMenu?.techniques?.supplement?.name_charset),configured.forest,group,newScheduler,configured.ai,configured.rewards,state.partyReactions,state.statusData):group?createForestSample(state.world.snapshot(),configured.combat,configured.forest,group,null,newScheduler,configured.ai,configured.rewards,state.reactionData,state.statusData):createBattleSample(state.world.snapshot(),configured.combat);
      if(sample.actors.filter(actor=>actor.side==='player').every(actor=>actor.hp.current===0))throw new Error('队伍已经倒下，请载入进度后继续。');
      const mode=newParty?'party':group?'forest':'sample';state.battleView=await prepareView({mode,newParty,stagePath:group?'/'+battleStage(group.stage).path:null,lifecycle:Boolean(group),actors:sample.actors,skills:sample.skills,inventory:state.world.value.inventory,onProgress:p=>progress({completed:10+75*p.completed/p.total,total:100})});state.battleView.setRoster(sample.actors,sample.skills);
      state.battle=createCombat(state.world,newParty,state.battleView);
      await prepareHud(newParty,{onProgress:p=>progress({completed:(p.stage==='result'?95:85)+5*p.completed/p.total,total:100})});
      progress({completed:100,total:100});
      });
      if(state.world.value.revision!==revision)throw new Error('资源加载期间世界状态已变化');
      if(group)state.world.setEncounterState(encounterState);
      // Native LCG with an explicit reproducible development seed. This is not
      // the unknown original game's starting seed or global RNG scheduling.
      const rngSeed=group?encounterState.rng_state:0x20261011;
      state.battleRng=createNativeRng(rngSeed);state.battleNatural=Boolean(group);
      await revealBattle(before,sample,()=>state.battle.start({...sample,lifecycle_enabled:Boolean(state.battleView.lifecycle),side_priority:state.sidePriority,rng:state.battleRng,source:{...sample.source,rng_seed:rngSeed,rng_seed_policy:group?'persistent-development-global-stream':'controlled-development-seed'}}));
      state.audio?.setScene({mapId:state.world.location.map_id,battle:true,stageId:group?.stage??null});
      if(group)actions.log({type:'field-encounter',group,location:state.world.location,counter_after:state.world.value.encounters.counters[state.selectedRole]});
      actions.status('满槽后选择招式和目标。Esc 收起轮盘，方向键切换人物，空格打开轮盘；也可用 Tab / X / Z 切换满槽人物。');
    }catch(error){state.battleView?.stop('战斗启动失败');state.battleMenu?.dispose();state.battleMenu=null;canvas.hidden=false;for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;Object.assign(state.view,state.battleCheckpoint);state.scenes.setPhase('map');throw error;}
  }
  async function startScriptedBattle({group,draft,playback,signal=playback?.signal}){
    if(state.scriptedBattleSession||state.skillTestSession||state.scenes.phase!=='event')throw new Error('剧情战斗入口状态无效');
    const simulation=beginScriptedBattle(draft,state.world.mapIds),revision=state.world.value.revision;
    const session={simulation,returnPending:false,previousPhase:state.scenes.phase,
      viewState:{...state.view},mapName:$('mapName').textContent,
      visibility:{canvas:canvas.hidden,dialogue:$('dialogue').hidden,shadeHidden:$('openingShade').hidden,shadeOpacity:$('openingShade').style.opacity},
      previous:{battle:state.battle,battleView:state.battleView,battleMenu:state.battleMenu,battleRng:state.battleRng,
        battleNatural:state.battleNatural,battleCursorMemory:state.battleCursorMemory,sidePriority:state.sidePriority,
        battlePresentationError:state.battlePresentationError,battleEntryPending:state.battleEntryPending,itemData:state.itemData}};
    const finished=new Promise((resolve,reject)=>Object.assign(session,{resolve,reject}));finished.catch(()=>{});
    const abort=()=>session.reject(signal.reason??new Error('剧情战斗已取消'));
    signal?.addEventListener('abort',abort,{once:true});
    const isCurrent=()=>state.scriptedBattleSession===session&&!signal?.aborted;
    const check=()=>{signal?.throwIfAborted();playback?.check();if(state.scriptedBattleSession!==session)throw new Error('剧情战斗会话已失效');if(state.world.value.revision!==revision)throw new Error('战斗期间世界状态已变化');};
    const before=state.battleTransition?.capture(captureScene());
    state.scriptedBattleSession=session;state.battlePresentationError=null;state.battleNatural=false;
    state.battleCursorMemory=new Map(state.battleCursorMemory);state.scenes.setPhase('battle-loading');
    try{
      check();if(!state.battleData){const data=await playbackTask(actions.json(state.catalog.combat_sample??'data/combat_sample.json'),signal);check();state.battleData=data;}
      const configured=await playbackTask(actions.readConfiguredData(),signal);check();state.itemData=configured.items;
      const scheduler={...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...state.partySkills.idle_skills}};
      const sample=assembleForestSample(createPartySample(simulation.world.snapshot(),state.partyCombat,state.partySkills,configured,state.itemData,state.operationMenu?.techniques?.supplement?.name_charset),
        configured.forest,group,scheduler,configured.ai,configured.rewards,state.partyReactions,state.statusData);
      if(sample.actors.filter(actor=>actor.side==='player').every(actor=>actor.hp.current===0))throw new Error('队伍已经倒下，无法进入剧情战斗');
      const preparedView=await playbackTask(prepareView({mode:'scripted',newParty:true,stagePath:'/'+battleStage(group.stage).path,lifecycle:true,actors:sample.actors,skills:sample.skills,inventory:simulation.world.value.inventory,signal}),signal);check();
      session.view=state.battleView=preparedView;
      session.view.setRoster(sample.actors,sample.skills);
      session.battle=state.battle=createCombat(simulation.world,true,session.view);state.battleRng=simulation.rng;
      await prepareHud(true,{world:simulation.world,battle:session.battle,owner:session,signal});check();
      await playbackTask(revealBattle(before,sample,()=>state.battle.start({...sample,lifecycle_enabled:true,rng:simulation.rng,side_priority:state.sidePriority,
        source:{...sample.source,scripted_battle:true,record:group.source,rng_seed:simulation.encounters.rng_state,
          rng_seed_policy:'persistent-development-global-stream',transition_draw:simulation.transitionRaw,
          transition_visual_rng_policy:'Source kind uses CRT; existing pixel-transition adapter uses its separate presentation random source.'}}),
        {kind:simulation.transitionKind,signal},isCurrent),signal);check();
      state.audio?.setScene({mapId:draft.location.map_id,battle:true,stageId:group.stage});
      actions.log({type:'scripted-battle-enter',group,revision,party:draft.party.map(role=>role.id)});
      actions.status('剧情战斗：选择招式和目标，战斗结束后继续剧情。');
      const result=await finished;check();
      commitScriptedBattle(draft,simulation,result);
      session.committed=true;
      actions.log({type:'scripted-battle-return',source:group.source,outcome:result.outcome,world_committed:false});
      return result;
    }finally{
      signal?.removeEventListener('abort',abort);
      const ownsState=state.scriptedBattleSession===session;if(ownsState)state.battleTransition?.cancel();
      if(session.battle?.state&&session.battle.state.phase!=='closed')session.battle.interrupt(new Error('剧情战斗会话结束'));
      if(ownsState||state.battleView!==session.view)session.view?.stop('已返回剧情');
      if(!ownsState&&session.menu?.root===$('battleHud')){
        const detached=session.menu.root.ownerDocument.createElement('div');
        if(session.menu.frame.parentNode===session.menu.root)detached.append(session.menu.frame);
        session.menu.root=detached;
      }
      session.menu?.dispose();
      if(ownsState){
        for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;
        Object.assign(state,session.previous);Object.assign(state.view,session.viewState);state.scriptedBattleSession=null;
        if(session.committed&&session.sidePriority!==undefined)state.sidePriority=session.sidePriority;
        if(session.hudChildren){
          const host=$('battleHud');host.replaceChildren(...session.hudChildren);
          for(const key of Object.keys(host.dataset))delete host.dataset[key];Object.assign(host.dataset,session.hudDataset);
        }
        canvas.hidden=session.visibility.canvas;$('dialogue').hidden=session.visibility.dialogue;$('mapName').textContent=session.mapName;
        $('openingShade').hidden=session.visibility.shadeHidden;$('openingShade').style.opacity=session.visibility.shadeOpacity;
        state.scenes.setPhase(session.previousPhase);state.audio?.setScene({mapId:draft.location.map_id,battle:false});actions.resize();
      }
    }
  }
  async function startTechniqueTest(){
    if(state.skillTestSession||state.scenes.phase!=='party-menu'||!state.menuContext||state.menuContext.combat)return;
    const before=state.battleTransition?.capture(captureScene()),ticket=actions.beginTechniqueTestMenu();
    const session={ticket,mapWorld:state.world,revision:state.world.value.revision,viewState:{...state.view},mapName:$('mapName').textContent,
      previous:{battle:state.battle,battleView:state.battleView,battleMenu:state.battleMenu,battleRng:state.battleRng,battleNatural:state.battleNatural,battleCursorMemory:state.battleCursorMemory,sidePriority:state.sidePriority,battlePresentationError:state.battlePresentationError,itemData:state.itemData},
      visibility:{canvas:canvas.hidden,dialogue:$('dialogue').hidden},view:null,battle:null,returnPending:false};
    state.skillTestSession=session;state.battlePresentationError=null;state.battleNatural=false;state.battleCursorMemory=new Map(state.battleCursorMemory);
    state.scenes.setPhase('battle-loading');
    try{
      let sample,rules;
      await prepareBattleResources('skill-test',async progress=>{
      state.battleData??=await actions.json(state.catalog.combat_sample??'data/combat_sample.json');
      const [configured,loadedRules]=await Promise.all([actions.readConfiguredData(),actions.json('data/skill_test.json')]);rules=loadedRules;
      state.itemData=configured.items;
      progress({completed:10,total:100});
      const world=new WorldStore(session.mapWorld.snapshot(),session.mapWorld.mapIds);
      sample=createSkillTestSample(world.snapshot(),state.partyCombat,state.partySkills,configured,state.itemData,rules,state.partyReactions,state.statusData,state.operationMenu?.techniques?.supplement?.name_charset);
      session.view=state.battleView=await prepareView({mode:'skill-test',newParty:true,stagePath:rules.stage.path,lifecycle:true,actors:sample.actors,skills:sample.skills,inventory:world.value.inventory,onProgress:p=>progress({completed:10+75*p.completed/p.total,total:100})});
      session.view.setRoster(sample.actors,sample.skills);
      if(state.world!==session.mapWorld||state.world.value.revision!==session.revision)throw new Error('资源加载期间世界状态已变化');
      session.battle=state.battle=createCombat(world,true,session.view);
      const rngSeed=world.value.encounters?.rng_state??0x20261020;state.battleRng=createNativeRng(rngSeed);
      await prepareHud(true,{returnLabel:'返回技巧测试',onProgress:p=>progress({completed:85+15*p.completed/p.total,total:100})});
      progress({completed:100,total:100});
      });
      await revealBattle(before,sample,()=>state.battle.start({...sample,lifecycle_enabled:true,rng:state.battleRng,side_priority:state.sidePriority,
        source:{...sample.source,rng_seed:state.battleRng.state,rng_seed_policy:'separate-technique-test-stream'}}));
      $('mapName').textContent='技巧测试';
      state.audio?.setScene({mapId:state.world.location.map_id,battle:true,stageId:rules.stage.music_stage_id??'stage13.scn'});
      actions.status('技巧测试：目标不主动攻击，技能不消耗HP／MP；道具照常消耗。选择逃跑返回技巧页面。');
      actions.log({type:'technique-test-opened',battle_id:state.battle.state.id,stage_id:rules.stage.stage_id,enemy_resources:rules.enemy_resources,world_revision:session.revision});
    }catch(error){restoreTechniqueTest(session,'测试启动失败');throw error;}
  }
  function restoreTechniqueTest(session,reason){
    if(state.skillTestSession!==session)return;
    if(session.view)session.view.stop(reason);
    if(state.battleMenu!==session.previous.battleMenu)state.battleMenu?.dispose();
    for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;
    Object.assign(state,session.previous);Object.assign(state.view,session.viewState);state.skillTestSession=null;
    canvas.hidden=session.visibility.canvas;$('dialogue').hidden=session.visibility.dialogue;$('mapName').textContent=session.mapName;
    state.audio?.setScene({mapId:state.world.location.map_id,battle:false});
    actions.resize();actions.resumeTechniqueTestMenu(session.ticket);
  }
  async function returnFromBattle(){
    if(!state.scenes.phase.startsWith('battle-')||!state.battle)return;
    if(state.battleMenu?.resultPreparing||state.battleMenu?.resultView?.active&&!state.battleMenu.resultView.complete)return;
    if(state.scriptedBattleSession){
      const session=state.scriptedBattleSession;if(session.returnPending)return;session.returnPending=true;
      try{
        const result=state.battle.finish(),snapshot=state.battle.snapshot();
        state.battleHistory.push({result,battle:snapshot});
        if(result.outcome==='defeat'){
          const error=new Error('剧情战斗全队败北');error.gameOverPolicy=planPartyDefeat({battle:snapshot});throw error;
        }
        if(!['victory','escaped'].includes(result.outcome))throw new Error('剧情战斗已中止，进度未提交');
        session.sidePriority=snapshot.scheduler?.side_priority;
        session.resolve(result);
      }catch(error){session.reject(error);}
      return;
    }
    if(state.skillTestSession){
      const session=state.skillTestSession;
      if(state.battle.state?.phase==='interrupted'){restoreTechniqueTest(session,'测试已中止');actions.status('测试已中止，未提交测试中的变化。');return;}
      try{
        if(state.world!==session.mapWorld||state.world.value.revision!==session.revision)throw new Error('测试期间地图进度已变化，测试结果未覆盖新进度');
        const result=state.battle.finish(),snapshot=state.battle.snapshot(),commit=commitSkillTestResources(state.world,snapshot,result,session.revision);
        state.battleHistory.push({result,battle:snapshot});
        actions.log({type:'technique-test-returned',battle_id:result.battle_id,outcome:result.outcome,...commit});
        restoreTechniqueTest(session,'已返回技巧测试');
        if(commit.changed){actions.buildHud();actions.refreshPartyMenu();}
        actions.status(commit.changed?'已返回技巧测试，道具消耗和恢复效果已保存。':'已返回技巧测试，地图进度保持原样。');return;
      }catch(error){restoreTechniqueTest(session,'测试已结束');throw error;}
    }
    const result=state.battle.finish();
    const defeatPolicy=result.outcome==='defeat'&&state.world.value.source.kind==='native-new-game'?planPartyDefeat({battle:state.battle.snapshot()}):null;
    if(state.battle.snapshot().scheduler)state.sidePriority=state.battle.snapshot().scheduler.side_priority;
    if(state.battleNatural){
      const encounterState=structuredClone(state.world.value.encounters);
      encounterState.rng_state=state.battleRng.state;
      state.world.setEncounterState(encounterState);
    }
    state.battleHistory.push({result,battle:state.battle.snapshot()});state.battleView.stop('已返回地图');state.battleMenu?.dispose();state.battleMenu=null;
    for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;canvas.hidden=false;
    state.scenes.setPhase('map');Object.assign(state.view,state.battleCheckpoint);actions.buildHud();actions.updateNearest();actions.resize();canvas.focus({preventScroll:true});
    state.audio?.setScene({mapId:state.world.location.map_id,battle:false});
    if(defeatPolicy){await actions.presentGameOver(defeatPolicy);return;}
    actions.status(result.outcome==='victory'?`战斗胜利，队伍HP / MP${result.rewards_applied?'和奖励':''}已保存到当前进度；可以保存存档。`:result.outcome==='defeat'?'队伍倒下，结果已保留；可载入存档。':'已经返回地图，队伍HP / MP变化已保留。');
  }
  function disposeBattles(){
    state.battleMenu?.dispose();state.battleMenu=null;
    for(const view of state.battleViews.values())view.destroy();
    state.battleViews.clear();
  }
  return {updateBattle, startBattle, startScriptedBattle, startTechniqueTest, returnFromBattle, battleKey, battleKeyUp, drawBattleInterface,updateBattleFrame,disposeBattles};
}
