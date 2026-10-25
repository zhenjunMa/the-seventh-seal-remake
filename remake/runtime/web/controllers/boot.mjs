// boot adapters. Persistent state belongs to the shared runtime context.
import {WorldStore} from "../core/world.mjs";
import {SceneController} from "../core/scenes.mjs";
import {WorldMapController} from "../core/world_map.mjs";
import {validateEncounterData} from "../core/encounters.mjs";
import {createPartyActors} from "../core/party_attributes.mjs";
import {validateScheduler} from "../core/battle_scheduler.mjs";
import {validateForestAIData} from "../core/forest_ai.mjs";
import {validateForestRewards} from "../core/battle_rewards.mjs";
import {validateForestReactionsData} from "../core/battle_reactions.mjs";
import {validateForestStatusData} from "../core/battle_status.mjs";
import {ChapterRunner} from "../core/chapter.mjs";
import {validateItemData} from "../core/items.mjs";
import {createAudioController} from "../core/audio.mjs";
import {createMenuFeedback,operationFeedbackState} from "../core/menu_feedback.mjs";
import {OperationMenuView} from "../operation_menu_view.mjs";
import {createMenuTextRenderer} from "../core/menu_text.mjs";
import {createMenuSettings} from "../core/menu_settings.mjs";
import {StartupView} from "../startup_view.mjs";
import {CaptionView} from "../caption_view.mjs";
import {LoadingView} from "../loading_view.mjs";
import {BattleTransitionView} from "../battle_transition_view.mjs";
import {DialogueView} from "../dialogue_view.mjs";
import {WorldMapView} from "../world_map_view.mjs";
import {runtimeContent,runtimeContentDefinition,validateContentRegistration} from "../core/content_registry.mjs";
import {StoryRepository} from "../core/story_repository.mjs";
import {worldMapEntry} from "../core/map_connections.mjs";
import {createSaveStorage} from "../core/save_storage.mjs";
import {SaveMenuView} from "../save_menu_view.mjs";

export function createBootController({state, actions, $, canvas, ctx}) {
  async function boot(){
    actions.busy('boot');
    let legacyStorage;try{legacyStorage=localStorage;}catch{}
    state.saveStorage=createSaveStorage({legacyStorage,legacyKey:state.saveKey});
    state.catalog=await actions.json('data/catalog.json');if(state.catalog.schema!=='seventh-seal-runtime-catalog'||state.catalog.version!==1)throw new Error('运行清单版本不兼容');
    const registration=await actions.json(state.catalog.runtime_content??'data/runtime_content.json');
    validateContentRegistration(runtimeContent);
    if(JSON.stringify(registration)!==JSON.stringify(runtimeContentDefinition))throw new Error('内容登记已变化，请执行 build_runtime.py --target content --run 并刷新页面');
    state.world=new WorldStore(await actions.json(state.catalog.seed),state.catalog.maps.map(m=>m.id));
    const [openingResources,storyIndex]=await Promise.all([actions.json(state.catalog.opening_resources),actions.json(state.catalog.story??'data/story/index.json')]);
    state.storyRepository=await StoryRepository.create({read:actions.json,index:storyIndex,content:runtimeContent,definition:runtimeContentDefinition,currentMap:()=>state.scenes?.current?.data.id});
    state.openingResources=openingResources;state.chapterResources=state.storyRepository.resources;state.chapterStory=state.storyRepository.story;
    state.events=state.storyRepository.events;state.routeEvents=state.storyRepository.routes;
    state.openingResources.roles={...state.openingResources.roles,...state.chapterResources.roles};
    state.mapEffects=await actions.json(state.catalog.map_effects);
    if(state.mapEffects.schema!=='seventh-seal-map-effects'||state.mapEffects.version!==1)throw new Error('地图光效清单版本不兼容');
    for(const [id,resource] of Object.entries(state.mapEffects.roles)){
      const role=state.openingResources.roles[id];
      for(const source of resource.actions){const action=role?.actions.find(action=>action.index===source.index);
        if(!action)throw new Error('地图光效动作未准备');action.intrinsic_sheet=source.intrinsic_sheet;}
    }
    const shadows=await actions.json(state.catalog.map_shadows??'data/map_shadows.json');
    if(shadows.schema!=='seventh-seal-map-shadows'||shadows.version!==1)throw new Error('地图阴影清单版本不兼容');
    state.mapShadows=shadows;
    for(const [id,resource] of Object.entries(shadows.roles)){
      const role=state.openingResources.roles[id],catalogRole=state.catalog.roles.find(role=>role.id===id);
      if(!role&&!resource.event_only)throw new Error('地图阴影人物未准备');
      for(const target of [role,catalogRole].filter(Boolean)){
        if(target.frame_width!==resource.frame_width||target.frame_height!==resource.frame_height)throw new Error('地图阴影尺寸不匹配');
        for(const source of resource.actions){
          const action=target.actions.find(action=>action.index===source.index);
          if(!action){if(target===catalogRole)continue;throw new Error('地图阴影动作未准备');}
          if((action.frame_count??action.frames_per_direction)!==source.frame_count||action.directions!==source.directions||action.first_frame!==source.first_frame)throw new Error('地图阴影帧分组不匹配');
          action.shadow_sheet=source.shadow_sheet;action.shadow_geometry=source.shadow_geometry;
        }
      }
    }
    state.battleData=await actions.json(state.catalog.combat_sample??'data/combat_sample.json');
    const [worldMapData,loadedEncounters,loadedForest]=await Promise.all([actions.json(state.catalog.world_map),actions.json(state.catalog.encounters),actions.json(state.catalog.forest_combat)]);
    state.encounterData=validateEncounterData(loadedEncounters);state.forestData=loadedForest;
    state.schedulerData=validateScheduler(await actions.json('data/battle_scheduler.json'));
    [state.aiData,state.rewardData,state.reactionData,state.statusData]=await Promise.all([actions.json('data/forest_ai.json').then(validateForestAIData),actions.json('data/forest_rewards.json').then(validateForestRewards),actions.json('data/enemy_reactions.json').then(validateForestReactionsData),actions.json('data/forest_status.json').then(validateForestStatusData)]);
    [state.partyCombat,state.partySkills,state.partyRewards,state.partyReactions]=await Promise.all([actions.json(state.catalog.party_combat),actions.json(state.catalog.party_skills),actions.json(state.catalog.party_rewards).then(validateForestRewards),actions.json(state.catalog.party_reactions).then(validateForestReactionsData)]);
    state.sourceItemData=validateItemData(await actions.json('data/items.json'));
    if(state.catalog.source_skills)state.sourceSkills=await actions.json(state.catalog.source_skills);
    if(state.catalog.source_magic)state.sourceMagic=await actions.json(state.catalog.source_magic);
    state.itemData=(await actions.readConfiguredData()).items;
    const operationManifest=await actions.json('data/operation_menu.json');
    state.saveMenu=await SaveMenuView.create({manifest:await actions.json('data/save_menu.json'),root:$('saveMenu'),image:actions.image,getPreview:actions.loadSavePreview,onConfirm:actions.selectSaveSlot,onClose:actions.closeSaveMenu,log:actions.log});
    await Promise.all(['assets/menu/main.png','assets/menu/actor_bar.png',...['game001d','game001a','game001a_2','game002a','game002_1','game003a','game003_1','game005'].map(id=>operationManifest.menus.find(menu=>menu.id===id).composed)].map(actions.image));
    const textRenderer=await createMenuTextRenderer(await actions.json('data/menu_fonts.json'));
    state.prologuePresentation=await actions.json('data/prologue_presentation.json');
    state.captionView=await CaptionView.create({manifest:state.prologuePresentation,
      fonts:await actions.json(state.prologuePresentation.font_manifest),image:actions.image,
      root:$('storyCaption'),clock:state.engine?.exploration.clock,onAdvance:()=>actions.advanceDialogue(),log:actions.log});
    state.loadingView=await LoadingView.create({manifest:state.prologuePresentation.loading,
      image:actions.image,root:$('sceneLoading'),clock:state.engine?.clock,log:actions.log});
    state.battleTransition=new BattleTransitionView({loadingView:state.loadingView,log:actions.log,clock:state.engine?.clock});
    const dialogueManifest=await actions.json('data/dialogue_ui.json');state.dialogueManifest=dialogueManifest;
    state.dialogueView=await DialogueView.create({manifest:dialogueManifest,fonts:await actions.json(dialogueManifest.font_manifest),
      image:actions.image,root:$('dialogue'),clock:state.engine?.exploration.clock,onAdvance:actions.advanceDialogue,onChoose:actions.chooseDialogue,log:actions.log});
    state.menuSettings=createMenuSettings({storage:localStorage});
    const menuTransaction=fn=>state.menuFeedback?state.menuFeedback.transaction(fn):fn();
    state.operationMenu=new OperationMenuView({manifest:operationManifest,textRenderer,techniquesSupplement:await actions.json('data/operation_techniques.json'),root:$('partyMenu'),onPage:actions.showOperationPage,
      onTechniqueActor:(roleId,confirmed)=>{if(!state.menuContext)return;$('menuActor').value=roleId;if(confirmed)actions.refreshPartyMenu();},
      onTechniqueSlot:request=>menuTransaction(()=>actions.setTechniqueSlot(request)),onTechniqueCast:request=>menuTransaction(()=>actions.useFieldTechnique(request)),
      onTechniqueTest:request=>menuTransaction(()=>actions.startTechniqueTest(request)),
      onTechniqueCreate:request=>menuTransaction(()=>actions.editTechniqueCombination('create',request)),onTechniqueRename:request=>menuTransaction(()=>actions.editTechniqueCombination('rename',request)),onTechniqueDelete:request=>menuTransaction(()=>actions.editTechniqueCombination('delete',request)),
      onTechniqueMessage:(message,error=false)=>{$('menuMessage').textContent=message;$('menuMessage').classList.toggle('error',error);if(error)state.menuFeedback?.reject();},
      onEquipmentSelect:instanceId=>{$('menuEquipment').value=instanceId;},
      onEquipmentConfirm:async(instanceId)=>{$('menuEquipment').value=instanceId;await $('menuEquip').onclick();},
      onEquipmentUnequip:async()=>{await $('menuUnequip').onclick();},
      onWeaponSocket:(index,confirmed)=>{if(!state.menuContext)return;state.menuContext.socketIndex=index;if(confirmed)state.operationMenu.weaponView.openPicker();},
      onWeaponSelect:instanceId=>{if(state.menuContext)state.menuContext.crystalInstanceId=instanceId;},
      onWeaponConfirm:(instanceId,index)=>actions.changeWeaponSocket(index,instanceId),
      onWeaponUnequip:index=>actions.changeWeaponSocket(index,null),
      onWeaponActorChange:direction=>{if(!state.menuContext)return;const roles=state.world.value.party,index=roles.findIndex(role=>role.id===$('menuActor').value);$('menuActor').value=roles[(index+direction+roles.length)%roles.length].id;state.menuContext.socketIndex=0;state.menuContext.crystalInstanceId=null;actions.refreshPartyMenu();state.operationMenu.weaponView.focused=true;state.operationMenu.weaponView.paintSockets();state.operationMenu.weaponView.infoSocket();state.operationMenu.focusGroup('content');},
      onFormationExchange:(first,second)=>menuTransaction(()=>actions.changePartyFormation(first,second)),
      onSystemSetting:(kind,channel,value)=>{if(kind==='cursor')state.menuSettings.setBattleCursor(value);else if(kind==='volume')state.audio.setChannelVolume(channel,value);else state.audio.setChannelMuted(channel,value);$('audioMuted').checked=state.audio.snapshot().muted;$('audioVolume').value=String(Math.round(state.audio.snapshot().volume*100));state.operationMenu.system.render(state.audio.snapshot().channels,state.menuSettings.snapshot().battleCursor);},
      onSystemExit:()=>{actions.closePartyMenu();actions.showTitle({allowResume:true});actions.log({type:'operation-exit-to-title'});},
      onActor:(roleId,confirm)=>{if(!state.menuContext)return;$('menuActor').value=roleId;state.operationMenu.mainCommitted=true;state.operationMenu.subCommitted=true;if(!confirm&&state.menuContext.page==='roster'&&!state.menuContext.selectionPage)actions.showOperationPage('choose-status');else actions.refreshPartyMenu();if(confirm){const page=state.menuContext.selectionPage??'status';actions.showOperationPage(page);state.operationMenu.frame.focus();state.operationMenu.mode='content';if(['equipment','weapon'].includes(page))state.operationMenu.focusGroup('content');}},
      onItemSelect:instanceId=>{if(!state.menuContext)return;$('menuItem').value=instanceId;actions.refreshPartyMenu();$('menuMessage').textContent=$('menuItemHint').textContent;},
      onItemConfirm:()=>{if(!state.menuContext)return;if($('menuUseItem').disabled){$('menuMessage').textContent='此物品当前无法使用。';state.menuFeedback?.reject();return;}const actors=state.menuContext.combat?state.battle.players():createPartyActors(state.world.snapshot(),state.partyCombat,{},state.itemData);state.operationMenu.itemTargets(actors,$('menuActor').value);},
      onItemTarget:async roleId=>{
        if(!state.menuContext)return;const context=state.menuContext;
        $('menuActor').value=roleId;actions.refreshPartyMenu();await $('menuUseItem').onclick();
        if(state.menuContext!==context)return;
        if(!context.combat&&!$('menuUseItem').disabled){
          state.operationMenu.itemTargets(createPartyActors(state.world.snapshot(),state.partyCombat,{},state.itemData),roleId);
        }else{$('menuItemTargets').hidden=true;state.operationMenu.focusGroup('content');}
      },
      onSlot:(slotId,confirm)=>{$('menuSlot').value=slotId;actions.refreshPartyMenu();$('menuMessage').textContent=$('menuEquipmentHint').textContent;if(confirm)state.operationMenu.equipmentPicker();},
      onItemFilter:(type,subtype)=>{state.menuContext.itemFilter=[type,subtype];$('menuMessage').textContent='';actions.refreshPartyMenu();}});
    state.menuFeedback=createMenuFeedback({playCue:(name,key)=>state.audio.playCue(name,key),getState:()=>operationFeedbackState(state.operationMenu)});
    state.menuFeedback.attach($('partyMenu'));
    const [audioManifest,startupManifest,startupMedia]=await Promise.all([actions.json('data/audio.json'),actions.json('data/startup_menu.json'),actions.json('data/startup_media.json')]);
    state.audio=createAudioController({...audioManifest,clips:{...audioManifest.clips,...startupManifest.audio.clips}},{storage:localStorage});state.audio.attachUnlock(document);
    $('audioMuted').checked=state.audio.snapshot().muted;$('audioVolume').value=String(Math.round(state.audio.snapshot().volume*100));
    $('audioMuted').onchange=()=>state.audio.setMuted($('audioMuted').checked);$('audioVolume').oninput=()=>state.audio.setVolume(Number($('audioVolume').value)/100);
    state.selectedRole=state.world.value.leader_id;
    await Promise.all(state.catalog.roles.flatMap(r=>r.actions.filter(a=>a.index<=2).flatMap(a=>[
      actions.image(a.sheet).then(image=>{a.bitmap=image;}),
      ...(a.shadow_sheet?[actions.image(a.shadow_sheet).then(image=>{a.shadow_bitmap=image;})]:[])])));
    state.scenes=new SceneController({world: state.world,prepare:actions.prepareMap,validateEntry: actions.validateEntry,commitView: actions.commitView,enter:actions.enterMap,onPhase:actions.busy,
      afterCommit:()=>actions.finishStoryCompletion?.(),
      captureView:()=>({view:{...state.view},name:$('mapName').textContent,probes:Array.from($('probe').children,child=>child.cloneNode(true)),nearest: state.nearest,resetHidden:$('resetEventSample').hidden}),
      rollbackView:checkpoint=>{Object.assign(state.view,checkpoint.view);$('mapName').textContent=checkpoint.name;$('probe').replaceChildren(...checkpoint.probes);$('resetEventSample').hidden=checkpoint.resetHidden;state.nearest=checkpoint.nearest;state.audio?.setScene({mapId:state.world.location.map_id,battle:false});}});
    state.chapterRunner=new ChapterRunner({world: state.world,data:state.chapterStory,objectData:state.chapterResources.interactive_objects,
      worldMapState:()=>state.worldMap.initialState(),
      choose:actions.chooseChapter,
      say:({mapId,record,signal})=>actions.say(actions.chapterSpeaker(mapId,record),record.text_raw,record.style,{mapId,record,signal}),
      animate:actions.animateChapter,transfer:actions.transferChapter,battle:actions.startScriptedBattle,objectAnimation:actions.animateChapterObject,log: actions.log,setPhase:phase=>state.scenes.setPhase(phase)});
    state.worldMap=new WorldMapController({world: state.world,data:worldMapData,
      prepare:async destination=>{const scene=await actions.prepareMap(destination.map_id),location=worldMapEntry(scene,destination,state.chapterStory);
        actions.validateEntry(scene,location);return {scene,location};},
      load:(prepared,location)=>{actions.commitView(prepared.scene,location);state.scenes.current=prepared.scene;},
      enter:async(prepared,draft,reason)=>{const played=await actions.enterMap(prepared.scene,draft,reason);if(played)prepared.scene=state.scenes.current;return played;},
      captureView:()=>({scene:state.scenes.current,view:state.scenes.captureView()}),rollbackView:checkpoint=>{state.scenes.current=checkpoint.scene;state.scenes.rollbackView(checkpoint.view);},
      onPhase:phase=>state.scenes.setPhase(phase==='open'?'world-map':phase==='loading'?'loading':'map'),notify:actions.renderWorldMap});
    state.worldMapView=await WorldMapView.create({manifest:await actions.json('data/world_map_ui.json'),
      root:$('worldMapPanel'),image:actions.image,select:actions.selectWorldMapDestination,
      close:actions.closeWorldMap,status:actions.status,cue:name=>state.audio?.playCue(name)});
    $('boundaries').textContent=state.catalog.boundaries;$('scopeText').textContent=state.catalog.introduction;
    state.startupView=await StartupView.create({manifest:startupManifest,media:startupMedia,$,image:actions.image,audio:state.audio,
      onStage:stage=>{state.scenes.setPhase(stage==='menu'?'menu':'startup');},
      onNew:()=>actions.beginOpening(),onLoad:(_save,slot)=>actions.loadProgress(slot),onResume:()=>actions.resumeExploration(),
      getPreview:save=>actions.loadSavePreview(save),
      getSaves:()=>actions.saveEntries().filter(row=>row.envelope),
      refreshSaves:()=>actions.refreshSaveSlots(),isBusy:()=>Boolean(state.saveOperation),status:actions.status,log:actions.log});
    actions.wire();actions.resize();await state.scenes.loadLocation(state.world.location,{reason:'boot'});actions.buildHud();
    await actions.refreshSaveSlots({quiet:true});
    actions.log({type:'boot',map_id:state.world.location.map_id,source:state.world.value.source,engine:'Phaser 3.90.0'});
    state.engine.start({phase:state.scenes.phase,interface:actions.updateInterface,
      exploration:actions.updateExploration,battle:actions.updateBattleFrame,suspend:actions.releaseInput});
    actions.status('片头按Esc跳过；提示画面按任意键进入主菜单。首次交互启用声音。');state.startupView.start();
  }
  return {boot};
}
