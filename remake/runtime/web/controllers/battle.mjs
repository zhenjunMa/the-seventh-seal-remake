// Combat owns its transient sessions. Cross-system effects use the host ports.
import {effectiveBattleSkillRoles} from "../core/battle/battle_skill_access.mjs";
import {BattleController} from "../core/battle/battle_controller.mjs";
import {resolveAction, applyNativeDamage, createNativeRng} from "../core/battle/combat_rules.mjs";
import {createBattleSample, resourcesForWorld, consumeBattleMp} from "../combat_sample.mjs";
import {BattleView} from "../battle_view.mjs";
import {BattleMenuView,battleHudPaths} from "../battle_menu_view.mjs";
import {createForestSample, assembleForestSample} from "../forest_sample.mjs";
import {createPartySample} from "../party_sample.mjs";
import {partyResourcesForWorld, consumePartyMp} from "../core/party/party_attributes.mjs";
import {battleStage} from "../core/content/content_registry.mjs";
import {planPartyDefeat} from "../core/party/recovery.mjs";
import {techniqueSlots,techniqueSlotName} from "../core/ui/menu_techniques.mjs";
import {battleTechniqueId} from "../core/battle/battle_techniques.mjs";
import {WorldStore} from "../core/world/world.mjs";
import {createSkillTestSample} from "../skill_test_sample.mjs";
import {commitSkillTestResources} from "../core/battle/skill_test_commit.mjs";
import {battleResources} from "../core/battle/battle_resources.mjs";
import {beginScriptedBattle,commitScriptedBattle} from '../core/battle/scripted_battle.mjs';
import {playbackTask} from '../core/story/story_playback.mjs';
import {createBattleSessions} from './battle_sessions.mjs';

export function createBattleController({host, sessions = createBattleSessions()}) {
  const actions = host.services, $ = host.element;
  const current = () => sessions.current;
  const captureTransition = kind => host.presentation.capture(kind);
  let sharedView,sharedWarm,lookahead,skillTestRules;
  const rulesForTest=()=>skillTestRules??=actions.json('data/skill_test.json').catch(error=>{skillTestRules=null;throw error;});
  function disposeMenu(menu){
    if(menu?.root===$('battleHud')&&current().battleMenu!==menu){
      const detached=menu.root.ownerDocument.createElement('div');
      if(menu.frame.parentNode===menu.root)detached.append(menu.frame);
      menu.root=detached;
    }
    menu?.dispose();
  }
  function updateBattle(snapshot){
    if(!snapshot||snapshot.phase==='closed')return;
    const entering=['command','charging'].includes(snapshot.phase)&&snapshot.lifecycle_events?.some(event=>event.kind==='entry');
    const phase=entering?'battle-entry':snapshot.phase==='command'?'battle-command':snapshot.phase==='charging'?'battle-charging':snapshot.phase==='action'?'battle-action':snapshot.phase==='interrupted'?'battle-interrupted':'battle-result';
    if(!current().battleEntryPending&&host.phase!==phase)host.setPhase(phase);
    const node=$('battleCommands');node.dataset.phase=snapshot.phase;node.dataset.round=snapshot.round;
    node.dataset.mode=current().skillTestSession?'skill-test':'battle';
    const impacted=snapshot.last_impact;
    node.dataset.impactFrame=impacted?.source_frame??'';
    node.dataset.impactActor=impacted?.actor_id??'';
    node.dataset.impactCount=snapshot.impact_count;
    $('battleMessage').textContent=entering?'正在入场':snapshot.phase==='victory'?'战斗胜利':snapshot.phase==='defeat'?'队伍已经倒下':snapshot.phase==='escaped'?'已经逃离战斗':snapshot.phase==='interrupted'?snapshot.error:snapshot.phase==='action'?'正在行动':snapshot.phase==='command'?'选择行动':'行动槽充能中';
    current().battleMenu?.update(snapshot);
    if(snapshot.phase==='escaped'){
      const frame=current(),battle=frame.battle;
      queueMicrotask(actions.guarded(()=>{
        if(current()===frame&&current().battle===battle)return returnFromBattle();
      }));
    }else if(current().scriptedBattleSession){
      if(snapshot.phase==='defeat'&&!current().scriptedBattleSession.returnPending)queueMicrotask(actions.guarded(returnFromBattle));
    }else if(!current().skillTestSession&&snapshot.phase==='defeat'&&!current().battleSampleMode)queueMicrotask(actions.guarded(returnFromBattle));
  }
  function battleKey(key,repeat=false){if(current().battleEntryPending||host.phase==='battle-entry')return true;return current().battleMenu?.key(key,repeat)??false;}
  function battleKeyUp(key){current().battleMenu?.keyup(key);}
  function updateBattleFrame(now){
    if(current().battleEntryPending||current().battlePresentationError||current().battleResourceWaits?.size)return;
    try{
      now=current().battleView?.resourceTime?.()??now;
      current().battle?.advanceClock(now);
      const snapshot=current().battle?.presentationSnapshot();
      advanceBattlePresentation(now,snapshot);
      current().battleView?.draw(snapshot,now);drawBattleInterface(now);
    }catch(error){
      current().battlePresentationError=error.message;current().battleView?.stop(error.message);
      current().battle?.interrupt(error);actions.status(error.message,true);
    }
  }
  function advanceBattlePresentation(now,snapshot=current().battle?.presentationSnapshot()){
    const battle=current().battle;
    current().battleView?.advance(snapshot,now);
    const completed=current().battleView?.drainLifecycleCompleted()??[];
    if(completed.length)queueMicrotask(()=>{
      if(current().battle===battle)for(const event of completed)battle.ackLifecycle(event);
    });
  }
  function drawBattleInterface(now){if(current().battleMenu){current().battleMenu.draw(now,current().battleView?.actorPositions());current().battleMenu.paintTo(host.engine?.battle.surface.canvas??$('battleCanvas'));
    $('battleCommands').dataset.lifecycle=JSON.stringify(current().battleView?.lifecycleSnapshot());
  }host.engine?.battle.surface.endFrame();}
  function pruneViews(activeView){
    const frame=current(),held=new Set([activeView,frame.battleView,
      frame.scriptedBattleSession?.previous?.battleView,frame.skillTestSession?.previous?.battleView]);
    for(const [key,view]of sessions.views){
      if(sessions.views.size<=4)break;
      if(held.has(view))continue;
      view.destroy();sessions.views.delete(key);
    }
  }
  function createView({newParty,stagePath=null,lifecycle}){
    return new BattleView({canvas:host.engine?.battle.surface.canvas??$('battleCanvas'),
      metadataPath:newParty?'/'+host.catalog.party_battle_view:stagePath?'/'+host.catalog.forest_battle_view:'/data/battle_view.json',
      itemMetadataPath:newParty?'/data/item_presentation.json':null,stageMetadataPath:stagePath,lifecycleMetadataPath:lifecycle?'/data/battle_lifecycle.json':null,statusMetadataPath:'/data/battle_status_view.json'});
  }
  function warmBattleShared(){
    if(sharedWarm)return sharedWarm.ready;
    const signal=new AbortController(),scope=battleResources.createScope('battle-hud-warm');
    const warm=sharedWarm={signal,scope,ready:null};
    const view=sharedView??=createView({newParty:true,lifecycle:true});
    const hud=battleResources.json('data/battle_ui.json').then(async manifest=>{
      const images=await scope.preparePaths(battleHudPaths(manifest));
      await prepareEntryImages(images,signal.signal);
    });
    warm.ready=Promise.all([view.loadDefinition(),hud,rulesForTest()]).catch(error=>{
      signal.abort(error);scope.release();
      if(sharedWarm===warm){sharedWarm=null;actions.log({type:'battle-resource-prefetch-failed',error:error.message});}
    });
    return warm.ready;
  }
  function warmBattleEntry({pool=null,testing=false}={}){
    const roles=host.world.value.party.map(role=>role.id);
    const key=JSON.stringify([testing,pool?.stage,roles,pool?.members.map(member=>member.id)]);
    if(lookahead?.key===key)return lookahead.ready;
    lookahead?.controller.abort();lookahead?.scope.release();lookahead=null;
    if(!testing&&!pool)return;
    const controller=new AbortController(),scope=battleResources.createScope('battle-entry-warm');
    const signal=controller.signal,warm=lookahead={key,controller,scope,ready:null};
    warm.ready=(async()=>{
      await waitForEntryFrame(signal);
      void warmBattleShared();
      const rules=testing?await rulesForTest():null;
      const stagePath=rules?.stage.path??'/'+battleStage(pool.stage).path;
      const enemyIds=rules?.enemy_resources??pool.members.map(member=>member.id);
      const paths=await sharedView.entryPaths([...new Set([...roles,...enemyIds])],stagePath);
      signal.throwIfAborted();
      const selected=await battleResources.pathsWithinBudget(paths,battleResources.budgetBytes*0.75);
      signal.throwIfAborted();
      const images=await scope.preparePaths(selected);
      await prepareEntryImages(images,signal);
    })().catch(error=>{
      scope.release();
      if(lookahead===warm){lookahead=null;actions.log({type:'battle-resource-prefetch-failed',error:error.message});}
    });
    return warm.ready;
  }
  async function prepareView({mode,newParty,stagePath=null,lifecycle=false,actors,skills,inventory,onProgress,signal}){
    await waitForEntryFrame(signal);
    signal?.throwIfAborted();
    mode=`${mode}:${stagePath??''}`;
    if(!sessions.views.has(mode))sessions.views.set(mode,createView({newParty,stagePath,lifecycle}));
    const view=sessions.views.get(mode);sessions.views.delete(mode);sessions.views.set(mode,view);
    view.onResourcesPrepared=images=>host.engine?.battle.surface.prepareImages?.(images);
    view.onResourceError=error=>actions.log({type:'battle-resource-prefetch-failed',error:error.message});
    const cancel=()=>view.cancelPreparation?.('战斗准备已取消');signal?.throwIfAborted();signal?.addEventListener('abort',cancel,{once:true});
    try{
      await view.prepare({actors,skills,inventory,staged:true,onProgress});
      // The first draw uploads the pages it uses. Offscreen poses and effects
      // stay decoded until needed, or are uploaded by exploration lookahead.
      signal?.throwIfAborted();return view;
    }finally{signal?.removeEventListener('abort',cancel);pruneViews(view);}
  }
  function waitForEntryFrame(signal){
    const clock=host.engine?.clock;
    return clock&&new Promise((resolve,reject)=>clock.requestFrame(resolve,{signal,onCancel:reject}));
  }
  async function prepareEntryImages(images,signal){
    const surface=host.engine?.battle.surface;
    if(surface?.prepareEntryImages)await surface.prepareEntryImages(images,{signal,clock:host.engine.clock});
    else surface?.prepareImages?.(images);
    signal?.throwIfAborted();
  }
  function createCombat(world,newParty,view){
    let battle,waits=0,waitStarted=0,waitTotal=0;
    const log=event=>{
      if(current().battle!==battle||!battle.state)return;
      if(host.lastBattle?.battle!==battle.state){
        if(battle.state?.phase==='closed')return;
        // Cached views can still reference an older controller. Drop its
        // detailed history as well as the old event log when a new fight starts.
        if(host.lastBattle?.battle?.history)host.lastBattle.battle.history.length=0;
        host.lastBattle={result:null,battle:battle.state};host.clearBattleLog();
      }
      actions.log(event);
    };
    const now=()=>host.engine?.battle.clock.time??performance.now()-waitTotal-(waits?performance.now()-waitStarted:0);
    const withResources=async(work,wait=true)=>{
      const reason=Symbol('battle-resources'),generation=view.generation,started=performance.now(),resourceWaits=current().battleResourceWaits;
      if(wait){if(!waits++)waitStarted=performance.now();resourceWaits.add(reason);host.engine?.pause(reason);}
      const signal=view.resourceController?.signal;
      try{const result=await playbackTask(work(),signal);if(current().battle!==battle||view.destroyed||view.generation!==generation){result?.release?.();throw new Error('战斗资源会话已失效');}if(wait)log({type:'battle-resource-wait-complete',elapsed_ms:performance.now()-started,cache:battleResources.snapshot()});return result;}
      finally{if(wait){if(!--waits)waitTotal+=performance.now()-waitStarted;resourceWaits.delete(reason);host.engine?.resume(reason);}}
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
    const actionSound=(result,step)=>host.audio?.playAction({...step,sound_inhibited:step.sound_inhibited??Boolean(battle.actor(step.actor_id).immune_raw)},`${result.action_id}:${step.channel_id}:${step.plan_record_index}:${step.logical_frame}`);
    const effectSound=(result,step)=>host.audio?.playEffect(step.asset_id,`${result.action_id}:${step.channel_id}:${step.effect_index}`,step.logical_frame);
    const present=method=>async(result,options)=>{const played=await play(method,result,{...options,onFrame:step=>actionSound(result,step),onEffectFrame:step=>effectSound(result,step)});log({type:'battle-presentation',action_id:result.action_id,actor_id:result.actor_id,skill_id:result.skill_id,observations:played.observations});return played;};
    battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,playAction:present('playAction'),playSequence:present('playSequence'),
      now,playTime:()=>actions.currentPlayTime(),
      resourcesForWorld:newParty?partyResourcesForWorld:resourcesForWorld,consumeResources:newParty?consumePartyMp:consumeBattleMp,
      notify:snapshot=>{if(current().battle===battle)updateBattle(snapshot);},log,itemData:newParty?current().itemData:null,
      playItem:async(event,hooks)=>{actions.status(`${event.name} → ${battle.actor(event.target_id).name}`);const played=await play('playItem',event,{...hooks,onFrame:step=>actionSound(event,step),onEffectFrame:step=>effectSound(event,step)});log({type:'battle-item-presentation',action_id:event.action_id,item_id:event.item_id,observations:played.observations});}});
    view.nativeControl=battle;
    view.nativeControlIsCurrent=()=>current().battle===battle;
    view.onLifecycleFrame=step=>{if(current().battle===battle)actionSound({action_id:`${step.battle_id}:${step.lifecycle_token}`},{...step,channel_id:'lifecycle'});};
    return battle;
  }
  async function prepareHud(newParty,{returnLabel=null,onProgress,world=host.world,battle=current().battle,owner=null,signal}={}){
    const frame=current();
    const check=()=>{signal?.throwIfAborted();if(current()!==frame||owner&&!sessions.owns(owner))throw new Error('战斗界面会话已失效');};
    if(!owner)current().battleMenu?.dispose();
    const [uiManifest,resultManifest]=await playbackTask(Promise.all([battleResources.json('data/battle_ui.json'),returnLabel?null:battleResources.json('data/battle_result.json')]),signal);check();
    const bindingSource=newParty?effectiveBattleSkillRoles(host.partySkills,world.value):null;
    const hud=$('battleHud'),root=owner?hud.ownerDocument.createElement('div'):hud,view=current().battleView;
    const menu=new BattleMenuView({root,manifest:uiManifest,battle,returnLabel,autoReturnOnDefeat:Boolean(owner)||!current().skillTestSession&&!current().battleSampleMode,reuseReturnButton:!owner,
      getCursorHeight:id=>view.actorCursorHeight(id),
      getSettings:()=>host.menu.settings(),getBindings:newParty?id=>techniqueSlots(world.value,bindingSource,id).map(slot=>({...slot,name:slot.type===1?battle.skills[battleTechniqueId(id,slot.index_one_based)]?.name:techniqueSlotName(bindingSource,id,slot)})):null,
      playCue:(...args)=>host.audio?.playCue(...args),onReturn:actions.guarded(returnFromBattle),onStage:stage=>{if(current().battle===battle)battle.setCommandStage?.(stage);},textRenderer:host.menu.textRenderer,memory:current().battleCursorMemory,resultManifest,onResultEvent:actions.log,
      now:view.resourceTime??(()=>host.engine?.battle.clock.time??performance.now()),deferResult:true,
      prepareResources:work=>view.withResources(work),onResourcesPrepared:()=>{},
      prefetchCommand:command=>{void view.prefetchCommand?.(command);},
      onResourceError:error=>{if(current().battle===battle){battle.interrupt(error);actions.status(error.message,true);}}});
    if(owner)owner.menu=menu;else current().battleMenu=menu;
    try{
      await playbackTask(menu.prepare({onProgress}),signal);check();menu.onResourcesPrepared=view.onResourcesPrepared;
      if(owner){
        owner.hudChildren=[...hud.childNodes];owner.hudDataset={...hud.dataset};hud.replaceChildren(...root.childNodes);menu.root=hud;
        menu.resizeObserver.unobserve?.(root);menu.resizeObserver.observe(hud);menu.fit();current().battleMenu=menu;
      }
      await waitForEntryFrame(signal);check();return menu;
    }catch(error){disposeMenu(menu);throw error;}
  }
  function showBattle(){
    host.presentation.show({scripted: Boolean(current().scriptedBattleSession)});
    current().battleMenu.fit();
  }
  async function prepareBattleResources(mode,work){
    const started=performance.now();
    // Battle preparation never exposes the generic map loading artwork.
    const stages={};
    const measure=async(name,prepare)=>{
      const begin=performance.now();
      try{return await prepare();}
      finally{stages[name]=(stages[name]??0)+performance.now()-begin;}
    };
    const result=await work(()=>{},measure);
    actions.log({type:'battle-resources-ready',mode,elapsed_ms:performance.now()-started,stages_ms:stages,cache:battleResources.snapshot()});
    return result;
  }
  async function revealBattle(before,start,transitionOptions={},isCurrent=()=>true){
    current().battleEntryPending=true;
    try{
      const paintBattle=async signal=>{
        signal?.throwIfAborted();if(!isCurrent())throw new Error('剧情战斗入场会话已失效');
        await start(signal);signal?.throwIfAborted();
        if(!isCurrent())throw new Error('剧情战斗入场会话已失效');
        showBattle();const snapshot=current().battle.presentationSnapshot(),now=current().battleView.resourceTime?.()??0;
        current().battleView.prepareEntry?.(snapshot,now);
        current().battleView.draw(snapshot,now,{entryPreview:true});
        current().battleMenu.draw(now,current().battleView.actorPositions());current().battleMenu.paintTo(host.engine?.battle.surface.canvas??$('battleCanvas'));
        host.engine?.battle.surface.endFrame();
        // Capture prepared entry poses; source motion and queued audio resume
        // once the covering transition releases the battlefield.
        return captureTransition('battle');
      };
      if(host.battleTransition&&before)await host.battleTransition.run(before,paintBattle,transitionOptions);
      else{transitionOptions.signal?.throwIfAborted();if(!isCurrent())throw new Error('战斗入场会话已失效');transitionOptions.onCovered?.();await start(transitionOptions.signal);if(isCurrent()){showBattle();current().battleView.prepareEntry?.(current().battle.presentationSnapshot(),current().battleView.resourceTime?.()??0);}}
    }finally{if(isCurrent())current().battleEntryPending=false;}
    if(isCurrent())updateBattle(current().battle.presentationSnapshot());
  }
  // Field encounters and technique tests share resource preparation, transition,
  // HUD creation and entry. Only sample rules and the owning world differ.
  async function enterBattle({before,startedAt,group=null,encounterState=null,sampleMode=false,testSession=null}){
    const frame=current(),testing=Boolean(testSession),mapWorld=host.world,revision=mapWorld.value.revision;
    const isCurrent=()=>current()===frame&&host.world===mapWorld&&(!testing||current().skillTestSession===testSession);
    current().battlePresentationError=null;host.setPhase('battle-loading');
    await revealBattle(before,async signal=>{
      let sample,rules,world=mapWorld;
      if(host.engine?.clock)void warmBattleShared();
      const newParty=!sampleMode;
      await prepareBattleResources(testing?'skill-test':'battle',async(progress,measure)=>{
        const combatData=host.loadCombatData(signal);if(combatData)await measure('combat_input',()=>combatData);
        const [configured,loadedRules]=await measure('configuration',()=>playbackTask(Promise.all([
          actions.readConfiguredData({sample:sampleMode,shared:true}),testing?rulesForTest():null]),signal));
        signal?.throwIfAborted();rules=loadedRules;current().itemData=configured.items;
        if(!isCurrent()||mapWorld.value.revision!==revision)throw new Error('资源加载期间世界状态已变化');
        if(testing)world=new WorldStore(mapWorld.snapshot(),mapWorld.mapIds);
        else{current().battleSampleMode=sampleMode;if(newParty&&!group)throw new Error('请在野外行走遇敌。');}
        progress({completed:10,total:100});
        const scheduler={...configured.scheduler,policy:{...configured.scheduler.policy,commands:'Frame-driven charging with per-player buffered commands; input continues during charging and hit reactions, confirmation locks until action completion, and dispatch waits for execution readiness.'},...(newParty?{idle_skills:{...configured.scheduler.idle_skills,...host.partySkills.idle_skills}}:{})};
        // Factories read the world synchronously and build isolated combat data.
        sample=await measure('assembly',()=>testing?createSkillTestSample(world.value,host.partyCombat,host.partySkills,configured,current().itemData,rules,host.partyReactions,host.statusData,host.menu.nameCharset)
          :newParty?assembleForestSample(createPartySample(world.value,host.partyCombat,host.partySkills,configured,current().itemData,host.menu.nameCharset),configured.forest,group,scheduler,configured.ai,configured.rewards,host.partyReactions,host.statusData)
          :group?createForestSample(world.value,configured.combat,configured.forest,group,null,scheduler,configured.ai,configured.rewards,host.reactionData,host.statusData):createBattleSample(world.value,configured.combat));
        if(!testing&&sample.actors.filter(actor=>actor.side==='player').every(actor=>actor.hp.current===0))throw new Error('队伍已经倒下，请载入进度后继续。');
        const mode=testing?'skill-test':newParty?'party':group?'forest':'sample',stagePath=testing?rules.stage.path:group?'/'+battleStage(group.stage).path:null;
        const view=await measure('view_assets',()=>playbackTask(prepareView({mode,newParty,stagePath,lifecycle:testing||Boolean(group),actors:sample.actors,skills:sample.skills,inventory:world.value.inventory,signal,
          onProgress:p=>progress({completed:10+75*p.completed/p.total,total:100})}),signal));
        signal?.throwIfAborted();
        if(!isCurrent())throw new Error('战斗准备会话已失效');
        current().battleView=view;if(testing)testSession.view=view;
        view.setRoster(sample.actors,sample.skills);current().battle=createCombat(world,newParty,view);
        if(testing)testSession.battle=current().battle;
        host.audio?.setScene({mapId:mapWorld.location.map_id,battle:true,stageId:testing?rules.stage.music_stage_id??'stage13.scn':group?.stage??null});
        await measure('hud_assets',()=>prepareHud(newParty,{world,signal,returnLabel:testing?'返回技巧测试':null,
          onProgress:p=>progress({completed:(p.stage==='result'?95:85)+5*p.completed/p.total,total:100})}));
        signal?.throwIfAborted();progress({completed:100,total:100});
      });
      signal?.throwIfAborted();
      if(!isCurrent()||mapWorld.value.revision!==revision)throw new Error('资源加载期间世界状态已变化');
      if(!testing&&group)mapWorld.setEncounterState(encounterState);
      const rngSeed=testing?world.value.encounters?.rng_state??0x20261020:group?encounterState.rng_state:0x20261011;
      current().battleRng=createNativeRng(rngSeed);current().battleNatural=!testing&&Boolean(group);
      current().battle.start({...sample,lifecycle_enabled:Boolean(current().battleView.lifecycle),side_priority:host.sidePriority,rng:current().battleRng,
        source:{...sample.source,rng_seed:rngSeed,rng_seed_policy:testing?'separate-technique-test-stream':group?'persistent-development-global-stream':'controlled-development-seed'}});
      if(testing)testSession.rules=rules;
    },{startedAt,onCovered:testing?()=>host.menu.cover(testSession.ticket):undefined},isCurrent);
  }
  async function startBattle(group=null,encounterState=null,{sample:sampleMode=false}={}){
    if(host.phase!=='map')return;
    const startedAt=performance.now(),before=(host.battleTransition?captureTransition():null);
    const session=sessions.enter('field',{returnView:host.presentation.captureReturn()});
    current().returnView=session.returnView;
    try{
      await enterBattle({before,startedAt,group,encounterState,sampleMode});
      if(group)actions.log({type:'field-encounter',group,location:host.world.location,counter_after:host.world.value.encounters.counters[host.selectedRole]});
      actions.status('先选中人物，按空格进入该人物的战斗轮盘；蓄力时即可选择招式和目标，确认后等待满槽行动。行动结束可输入下一轮，受击不打断选择；Esc 从轮盘退回选人并保留开放样式，方向键或 Tab / X / Z 切换人物。');
    }catch(error){
      before?.destroy?.();
      if(sessions.owns(session)){
        current().battleView?.stop('战斗启动失败');current().battleMenu?.dispose();
        host.presentation.hide();sessions.leave(session);session.returnView.restore();
      }
      throw error;
    }
  }
  async function startScriptedBattle({group,draft,playback,signal=playback?.signal}){
    if(current().scriptedBattleSession||current().skillTestSession||host.phase!=='event')throw new Error('剧情战斗入口状态无效');
    const simulation=beginScriptedBattle(draft,host.world.mapIds),revision=host.world.value.revision;
    const session=sessions.enter('scripted',{
      simulation,returnPending:false,returnView:host.presentation.captureReturn(),
      previousPriority:host.sidePriority,
    });
    const finished=new Promise((resolve,reject)=>Object.assign(session,{resolve,reject}));finished.catch(()=>{});
    const abort=()=>session.reject(signal.reason??new Error('剧情战斗已取消'));
    signal?.addEventListener('abort',abort,{once:true});
    const isCurrent=()=>current().scriptedBattleSession===session&&!signal?.aborted;
    const check=()=>{signal?.throwIfAborted();playback?.check();if(current().scriptedBattleSession!==session)throw new Error('剧情战斗会话已失效');if(host.world.value.revision!==revision)throw new Error('战斗期间世界状态已变化');};
    let before;
    try{
      before=host.battleTransition?captureTransition():null;
      host.setPhase('battle-loading');
      await playbackTask(revealBattle(before,async transitionSignal=>{
        const entrySignal=transitionSignal??signal,entryCheck=()=>{entrySignal?.throwIfAborted();check();};
        entryCheck();await host.loadCombatData(entrySignal);entryCheck();
        const configured=await playbackTask(actions.readConfiguredData({shared:true}),entrySignal);entryCheck();current().itemData=configured.items;
        const scheduler={...configured.scheduler,idle_skills:{...configured.scheduler.idle_skills,...host.partySkills.idle_skills}};
        const sample=assembleForestSample(createPartySample(simulation.world.value,host.partyCombat,host.partySkills,configured,current().itemData,host.menu.nameCharset),
          configured.forest,group,scheduler,configured.ai,configured.rewards,host.partyReactions,host.statusData);
        if(sample.actors.filter(actor=>actor.side==='player').every(actor=>actor.hp.current===0))throw new Error('队伍已经倒下，无法进入剧情战斗');
        const preparedView=await playbackTask(prepareView({mode:'scripted',newParty:true,stagePath:'/'+battleStage(group.stage).path,lifecycle:true,actors:sample.actors,skills:sample.skills,inventory:simulation.world.value.inventory,signal:entrySignal}),entrySignal);entryCheck();
        session.view=current().battleView=preparedView;
        session.view.setRoster(sample.actors,sample.skills);
        session.battle=current().battle=createCombat(simulation.world,true,session.view);current().battleRng=simulation.rng;
        host.audio?.setScene({mapId:draft.location.map_id,battle:true,stageId:group.stage});
        await prepareHud(true,{world:simulation.world,battle:session.battle,owner:session,signal:entrySignal});entryCheck();
        current().battle.start({...sample,lifecycle_enabled:true,rng:simulation.rng,side_priority:host.sidePriority,
          source:{...sample.source,scripted_battle:true,record:group.source,rng_seed:simulation.encounters.rng_state,
            rng_seed_policy:'persistent-development-global-stream',transition_draw:simulation.transitionRaw,
            transition_visual_rng_policy:'Source kind uses CRT; existing pixel-transition adapter uses its separate presentation random source.'}});
      },{kind:simulation.transitionKind,signal},isCurrent),signal);check();
      actions.log({type:'scripted-battle-enter',group,revision,party:draft.party.map(role=>role.id)});
      actions.status('剧情战斗：选择招式和目标，战斗结束后继续剧情。');
      const result=await finished;check();
      commitScriptedBattle(draft,simulation,result);
      session.committed=true;
      actions.log({type:'scripted-battle-return',source:group.source,outcome:result.outcome,world_committed:false});
      return result;
    }finally{
      before?.destroy?.();signal?.removeEventListener('abort',abort);
      const ownsState=current().scriptedBattleSession===session;if(ownsState)host.battleTransition?.cancel();
      if(session.battle?.state&&session.battle.state.phase!=='closed')session.battle.interrupt(new Error('剧情战斗会话结束'));
      if(ownsState||current().battleView!==session.view)session.view?.stop('已返回剧情');
      disposeMenu(session.menu);
      if(ownsState){
        host.presentation.hide();
        sessions.leave(session);
        host.sidePriority=session.committed&&session.sidePriority!==undefined?session.sidePriority:session.previousPriority;
        if(session.hudChildren){
          const hud=$('battleHud');hud.replaceChildren(...session.hudChildren);
          for(const key of Object.keys(hud.dataset))delete hud.dataset[key];Object.assign(hud.dataset,session.hudDataset);
        }
        session.returnView.restore();
      }
    }
  }
  async function startTechniqueTest(){
    if(current().skillTestSession||!host.menu.canTest())return;
    const startedAt=performance.now();
    const before=host.battleTransition?(host.presentation.captureMenu()??captureTransition()):null;
    let ticket;
    try{ticket=host.menu.begin();}catch(error){before?.destroy?.();throw error;}
    const session=sessions.enter('skill-test',{
      ticket,mapWorld:host.world,revision:host.world.value.revision,
      returnView:host.presentation.captureReturn(),view:null,battle:null,returnPending:false,
    });
    try{
      await enterBattle({before,startedAt,testSession:session});
      host.presentation.label('技巧测试');
      actions.status('技巧测试：目标不主动攻击，技能不消耗HP／MP；道具照常消耗。选择逃跑返回技巧页面。');
      const rules=session.rules;
      actions.log({type:'technique-test-opened',battle_id:current().battle.state.id,stage_id:rules.stage.stage_id,enemy_resources:rules.enemy_resources,world_revision:session.revision});
    }catch(error){before?.destroy?.();restoreTechniqueTest(session,'测试启动失败');throw error;}
  }
  function restoreTechniqueTest(session,reason){
    if(current().skillTestSession!==session)return;
    if(session.view)session.view.stop(reason);
    if(current().battleMenu!==session.previous.battleMenu)current().battleMenu?.dispose();
    host.presentation.hide();sessions.leave(session);session.returnView.restore();
    host.menu.resume(session.ticket);
  }
  // Retain one completed fight; a new fight replaces it without cloning
  // or appending to a multi-battle archive.
  async function returnFromBattle(){
    if(!host.phase.startsWith('battle-')||!current().battle)return;
    if(current().battleMenu?.resultPreparing||current().battleMenu?.resultView?.active&&!current().battleMenu.resultView.complete)return;
    if(current().scriptedBattleSession){
      const session=current().scriptedBattleSession;if(session.returnPending)return;session.returnPending=true;
      try{
        const result=current().battle.finish(),snapshot=current().battle.state;
        host.lastBattle={result,battle:snapshot};
        if(result.outcome==='defeat'){
          const error=new Error('剧情战斗全队败北');error.gameOverPolicy=planPartyDefeat({battle:snapshot});throw error;
        }
        if(!['victory','escaped'].includes(result.outcome))throw new Error('剧情战斗已中止，进度未提交');
        session.sidePriority=snapshot.scheduler?.side_priority;
        session.resolve(result);
      }catch(error){session.reject(error);}
      return;
    }
    if(current().skillTestSession){
      const session=current().skillTestSession;
      if(current().battle.state?.phase==='interrupted'){restoreTechniqueTest(session,'测试已中止');actions.status('测试已中止，未提交测试中的变化。');return;}
      try{
        if(host.world!==session.mapWorld||host.world.value.revision!==session.revision)throw new Error('测试期间地图进度已变化，测试结果未覆盖新进度');
        const result=current().battle.finish(),snapshot=current().battle.state,commit=commitSkillTestResources(host.world,snapshot,result,session.revision);
        host.lastBattle={result,battle:snapshot};
        actions.log({type:'technique-test-returned',battle_id:result.battle_id,outcome:result.outcome,...commit});
        restoreTechniqueTest(session,'已返回技巧测试');
        if(commit.changed){host.presentation.refreshExploration();actions.refreshPartyMenu();}
        actions.status(commit.changed?'已返回技巧测试，道具消耗和恢复效果已保存。':'已返回技巧测试，地图进度保持原样。');return;
      }catch(error){restoreTechniqueTest(session,'测试已结束');throw error;}
    }
    const result=current().battle.finish(),snapshot=current().battle.state;
    const defeatPolicy=result.outcome==='defeat'&&!current().battleSampleMode?planPartyDefeat({battle:snapshot}):null;
    if(snapshot.scheduler)host.sidePriority=snapshot.scheduler.side_priority;
    if(current().battleNatural){
      const encounterState=structuredClone(host.world.value.encounters);
      encounterState.rng_state=current().battleRng.state;
      host.world.setEncounterState(encounterState);
    }
    host.lastBattle={result,battle:snapshot};current().battleView.stop('已返回地图');current().battleMenu?.dispose();current().battleMenu=null;
    host.presentation.hide();
    current().returnView.restore({refresh:true});
    if(defeatPolicy){await actions.presentGameOver(defeatPolicy);return;}
    actions.status(result.outcome==='victory'?`战斗胜利，队伍HP / MP${result.rewards_applied?'和奖励':''}已保存到当前进度；可以保存存档。`:result.outcome==='defeat'?'队伍倒下，结果已保留；可载入存档。':'已经返回地图，队伍HP / MP变化已保留。');
  }
  function battleMenuState({inventory=false}={}){
    const {battle,itemData}=current();
    return battle?{
      canCommand:battle.canCommand(),actorId:battle.state?.player_id,
      actors:battle.players().map(({id,name,level,hp,mp})=>({id,name,level,hp:{...hp},mp:{...mp}})),
      ...(inventory?{inventory:structuredClone(battle.state?.inventory??[])}:{}),items:itemData,
    }:null;
  }
  function chooseBattleItem(instanceId,targetId){
    const battle=current().battle;
    if(!battle)throw new Error('当前没有可操作的战斗');
    return battle.chooseItem(instanceId,targetId);
  }
  function focusBattleMenu(){current().battleMenu?.frame.focus();}
  function disposeBattles(){
    const frame=current(),reason=new Error('战斗会话已结束');
    frame.scriptedBattleSession?.reject(reason);
    frame.battle?.interrupt(reason);frame.battleMenu?.dispose();
    sessions.reset();host.battleTransition?.cancel();
    for(const view of sessions.views.values())view.destroy();
    sessions.views.clear();
    lookahead?.controller.abort();lookahead?.scope.release();lookahead=null;
    sharedWarm?.signal.abort();sharedWarm?.scope.release();sharedWarm=null;
    sharedView?.destroy();sharedView=null;skillTestRules=null;
  }
  return {warmBattleShared,warmBattleEntry,updateBattle,startBattle,startScriptedBattle,startTechniqueTest,returnFromBattle,battleKey,battleKeyUp,drawBattleInterface,advanceBattlePresentation,updateBattleFrame,disposeBattles,battleMenuState,chooseBattleItem,focusBattleMenu};
}
