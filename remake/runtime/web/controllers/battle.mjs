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
import {techniqueSlots,techniqueSlotName,techniqueCombinations} from "../core/menu_techniques.mjs";
import {WorldStore} from "../core/world.mjs";
import {createSkillTestSample} from "../skill_test_sample.mjs";
import {commitSkillTestResources} from "../core/skill_test_commit.mjs";
import {battleResources} from "../core/battle_resources.mjs";

export function createBattleController({state, actions, $, canvas, ctx}) {
  function updateBattle(snapshot){
    if(!snapshot||snapshot.phase==='closed')return;
    if(!state.battleEntryPending)state.scenes.setPhase(snapshot.phase==='command'?'battle-command':snapshot.phase==='charging'?'battle-charging':snapshot.phase==='action'?'battle-action':snapshot.phase==='interrupted'?'battle-interrupted':'battle-result');
    const node=$('battleCommands');node.dataset.phase=snapshot.phase;node.dataset.round=snapshot.round;
    node.dataset.mode=state.skillTestSession?'skill-test':'battle';
    const impacted=snapshot.history.findLast(entry=>entry.impact);
    node.dataset.impactFrame=impacted?.presentation?.source_frame??'';
    node.dataset.impactActor=impacted?.actor_id??'';
    node.dataset.impactCount=snapshot.history.filter(entry=>entry.impact).length;
    $('battleMessage').textContent=snapshot.phase==='victory'?'战斗胜利':snapshot.phase==='defeat'?'队伍已经倒下':snapshot.phase==='escaped'?'已经逃离战斗':snapshot.phase==='interrupted'?snapshot.error:snapshot.phase==='action'?'正在行动':snapshot.phase==='command'?'选择行动':'行动槽充能中';
    state.battleMenu?.update(snapshot);
    if(state.skillTestSession){
      if(snapshot.phase==='escaped'&&!state.skillTestSession.returnPending){state.skillTestSession.returnPending=true;queueMicrotask(actions.guarded(returnFromBattle));}
    }else if(snapshot.phase==='defeat'&&state.world.value.source.kind==='native-new-game')queueMicrotask(actions.guarded(returnFromBattle));
  }
  function battleKey(key,repeat=false){return state.battleMenu?.key(key,repeat)??false;}
  function battleKeyUp(key){state.battleMenu?.keyup(key);}
  function drawBattleInterface(now){if(state.battleMenu){state.battleMenu.draw(now,state.battleView?.actorPositions());state.battleMenu.paintTo($('battleCanvas'));
    $('battleCommands').dataset.lifecycle=JSON.stringify(state.battleView?.lifecycleSnapshot());
    const battle=state.battle,completed=state.battleView?.drainLifecycleCompleted()??[];
    if(completed.length)queueMicrotask(()=>{if(state.battle===battle)for(const event of completed)battle.ackLifecycle(event);});
  }}
  async function prepareView({mode,newParty,stagePath=null,lifecycle=false,actors,onProgress}){
    mode=`${mode}:${stagePath??''}`;
    if(!state.battleViews.has(mode))state.battleViews.set(mode,new BattleView({canvas:$('battleCanvas'),
      metadataPath:newParty?'/'+state.catalog.party_battle_view:stagePath?'/'+state.catalog.forest_battle_view:'/data/battle_view.json',
      itemMetadataPath:newParty?'/data/item_presentation.json':null,stageMetadataPath:stagePath,lifecycleMetadataPath:lifecycle?'/data/battle_lifecycle.json':null}));
    const view=state.battleViews.get(mode);await view.prepare({actors,onProgress});return view;
  }
  function createCombat(world,newParty,view){
    let battle;
    const actionSound=(result,step)=>state.audio?.playAction({...step,sound_inhibited:Boolean(battle.actor(step.actor_id).immune_raw)},`${result.action_id}:${step.channel_id}:${step.plan_record_index}:${step.logical_frame}`);
    const present=method=>async(result,options)=>{const played=await view[method](result,{...options,onFrame:step=>actionSound(result,step)});actions.log({type:'battle-presentation',action_id:result.action_id,actor_id:result.actor_id,skill_id:result.skill_id,observations:played.observations});return played;};
    battle=new BattleController({world,resolveAction,applyDamage:applyNativeDamage,playAction:present('playAction'),playSequence:present('playSequence'),
      resourcesForWorld:newParty?partyResourcesForWorld:resourcesForWorld,consumeResources:newParty?consumePartyMp:consumeBattleMp,notify:updateBattle,log:actions.log,itemData:newParty?state.itemData:null,
      playItem:async(event,hooks)=>{actions.status(`${event.name} → ${battle.actor(event.target_id).name}`);const played=await view.playItem(event,{...hooks,onFrame:step=>actionSound(event,step),onEffectFrame:step=>state.audio?.playItemEffect(event.item_id,`${event.action_id}:effect:${step.logical_frame}`,step.logical_frame)});actions.log({type:'battle-item-presentation',action_id:event.action_id,item_id:event.item_id,observations:played.observations});}});
    return battle;
  }
  async function prepareHud(newParty,{returnLabel=null,onProgress}={}){
    state.battleMenu?.dispose();
    const [uiManifest,resultManifest]=await Promise.all([battleResources.json('data/battle_ui.json'),returnLabel?null:battleResources.json('data/battle_result.json')]);
    const bindingSource=newParty?effectiveSkillSource(state.partySkills,state.world.value):null;
    state.battleMenu=new BattleMenuView({root:$('battleHud'),manifest:uiManifest,battle:state.battle,returnLabel,
      getSettings:()=>state.menuSettings?.snapshot()??{},getBindings:newParty?id=>techniqueSlots(state.world.value,bindingSource,id).map(slot=>({...slot,name:slot.type===1?techniqueCombinations(state.world.value,bindingSource,id)[slot.index_one_based-1]?.name:techniqueSlotName(bindingSource,id,slot)})):null,
      playCue:(...args)=>state.audio?.playCue(...args),onReturn:actions.guarded(returnFromBattle),onStage:stage=>state.battle.setCommandStage?.(stage),textRenderer:state.operationMenu?.textRenderer,memory:state.battleCursorMemory,resultManifest,onResultEvent:actions.log});
    await state.battleMenu.prepare({onProgress});
  }
  function showBattle(){
    for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=false;
    canvas.hidden=true;$('dialogue').hidden=true;actions.resize();state.battleMenu.fit();
  }
  async function prepareWithLoading(mode,work){
    const started=performance.now();
    if(state.loadingView)$('loading').hidden=true;
    const run=state.loadingView?state.loadingView.run(mode,work,{kind:'battle',minimumDisplayMs:0}):work(()=>{});
    const result=await run;
    actions.log({type:'battle-resources-ready',mode,elapsed_ms:performance.now()-started,cache:battleResources.snapshot()});
    return result;
  }
  async function revealBattle(before,sample,start){
    state.battleEntryPending=true;
    try{
      start();
      if(state.battleTransition&&before)await state.battleTransition.run(before,()=>{
        showBattle();const snapshot=state.battle.presentationSnapshot();state.battleView.draw(snapshot,0);
        state.battleMenu.draw(0,state.battleView.actorPositions());state.battleMenu.paintTo($('battleCanvas'));
        const after=state.battleTransition.capture($('battleCanvas'));
        // The captured entry pose must not start lifecycle clocks during the transition.
        state.battleView.setRoster(sample.actors,sample.skills);return after;
      });
      else showBattle();
    }finally{state.battleEntryPending=false;}
    updateBattle(state.battle.presentationSnapshot());
  }
  async function startBattle(group=null,encounterState=null){
    if(state.scenes.phase!=='map')return;
    const revision=state.world.value.revision,before=state.battleTransition?.capture(canvas);state.battlePresentationError=null;
    state.battleCheckpoint={...state.view};state.scenes.setPhase('battle-loading');$('loading').querySelector('p').textContent='正在准备战斗…';actions.status('正在准备战斗资源…');
    try{
      let sample,newParty;
      await prepareWithLoading('battle',async progress=>{
      state.battleData??=await actions.json(state.catalog.combat_sample??'data/combat_sample.json');
      newParty=state.world.value.source.kind==='native-new-game';
      if(newParty&&!group)throw new Error('新游戏请在白木森林中行走遇敌。');
      const configured=await actions.readConfiguredData();state.itemData=configured.items;
      progress({completed:10,total:100});
      const newScheduler={...configured.scheduler,policy:{...configured.scheduler.policy,commands:'Frame-driven charging and queued ready-player commands; menu selection and other actors animations continue charging.'},...(newParty?{idle_skills:{...configured.scheduler.idle_skills,...state.partySkills.idle_skills}}:{})};
      sample=newParty?assembleForestSample(createPartySample(state.world.snapshot(),state.partyCombat,state.partySkills,configured,state.itemData),configured.forest,group,newScheduler,configured.ai,configured.rewards,state.partyReactions,state.statusData):group?createForestSample(state.world.snapshot(),configured.combat,configured.forest,group,null,newScheduler,configured.ai,configured.rewards,state.reactionData,state.statusData):createBattleSample(state.world.snapshot(),configured.combat);
      if(sample.actors.filter(actor=>actor.side==='player').every(actor=>actor.hp.current===0))throw new Error('队伍已经倒下，请载入进度后继续。');
      const mode=newParty?'party':group?'forest':'sample';state.battleView=await prepareView({mode,newParty,stagePath:group?'/'+battleStage(group.stage).path:null,lifecycle:Boolean(group),actors:sample.actors,onProgress:p=>progress({completed:10+75*p.completed/p.total,total:100})});state.battleView.setRoster(sample.actors,sample.skills);
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
      actions.status('行动槽随时间推进；满槽后选择招式和目标。Tab / X / Z 切换满槽人物，Esc 返回上一层。');
    }catch(error){state.battleMenu?.dispose();state.battleMenu=null;canvas.hidden=false;for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;Object.assign(state.view,state.battleCheckpoint);state.scenes.setPhase('map');throw error;}
    finally{$('loading').querySelector('p').textContent='正在进入场景…';}
  }
  async function startTechniqueTest(){
    if(state.skillTestSession||state.scenes.phase!=='party-menu'||!state.menuContext||state.menuContext.combat)return;
    const before=state.battleTransition?.capture(canvas),ticket=actions.beginTechniqueTestMenu();
    const session={ticket,mapWorld:state.world,revision:state.world.value.revision,viewState:{...state.view},mapName:$('mapName').textContent,
      previous:{battle:state.battle,battleView:state.battleView,battleMenu:state.battleMenu,battleRng:state.battleRng,battleNatural:state.battleNatural,battleCursorMemory:state.battleCursorMemory,sidePriority:state.sidePriority,battlePresentationError:state.battlePresentationError,itemData:state.itemData},
      visibility:{canvas:canvas.hidden,dialogue:$('dialogue').hidden},view:null,battle:null,returnPending:false};
    state.skillTestSession=session;state.battlePresentationError=null;state.battleNatural=false;state.battleCursorMemory=new Map(state.battleCursorMemory);
    state.scenes.setPhase('battle-loading');$('loading').querySelector('p').textContent='正在准备技巧测试…';actions.status('正在准备技巧测试…');
    try{
      let sample,rules;
      await prepareWithLoading('skill-test',async progress=>{
      state.battleData??=await actions.json(state.catalog.combat_sample??'data/combat_sample.json');
      const [configured,loadedRules]=await Promise.all([actions.readConfiguredData(),actions.json('data/skill_test.json')]);rules=loadedRules;
      state.itemData=configured.items;
      progress({completed:10,total:100});
      const world=new WorldStore(session.mapWorld.snapshot(),session.mapWorld.mapIds);
      sample=createSkillTestSample(world.snapshot(),state.partyCombat,state.partySkills,configured,state.itemData,rules,state.partyReactions,state.statusData);
      session.view=state.battleView=await prepareView({mode:'skill-test',newParty:true,stagePath:rules.stage.path,lifecycle:true,actors:sample.actors,onProgress:p=>progress({completed:10+75*p.completed/p.total,total:100})});
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
    finally{$('loading').querySelector('p').textContent='正在进入场景…';}
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
    if(state.battleMenu?.resultView?.active&&!state.battleMenu.resultView.complete)return;
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
  return {updateBattle, startBattle, startTechniqueTest, returnFromBattle, battleKey, battleKeyUp, drawBattleInterface};
}
