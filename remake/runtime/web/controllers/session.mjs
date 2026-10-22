// session adapters. Persistent state belongs to the shared runtime context.
import {decodeSave} from "../core/world.mjs";
import {createPartyActors} from "../core/party_attributes.mjs";
import {OpeningRunner} from "../core/opening.mjs";
import {completedOpeningWorld} from "../core/opening_state.mjs";
import {OpeningView} from "../opening_view.mjs";
import {validateSourceSkillShortcuts} from "../core/skill_shortcuts.mjs";
import {techniqueSlots,techniqueCombinations} from "../core/menu_techniques.mjs";

export function createSessionController({state, actions, $, canvas, ctx}) {
  function showTitle({allowResume=false}={}){
    if(state.saveOperation&&state.scenes.phase==='save-io')throw new Error('正在存取进度，请稍候');
    state.audio?.suspend();
    state.scenes.setPhase('menu');
    $('menuResume').hidden=!allowResume;
    state.startupView.showMenu({allowResume});
    actions.status(allowResume?'左右选择，空格确认；离开选项可继续当前游戏。':'左右选择，空格／Enter确认，Esc返回上一层。');
  }
  function resumeExploration(){
    if(state.scenes.phase!=='menu'||$('menuResume').hidden)return;
    state.startupView.hide();$('menuResume').hidden=true;state.scenes.setPhase('map');
    state.audio?.setScene({mapId:state.world.location.map_id,battle:false});actions.buildHud();actions.updateNearest();canvas.focus({preventScroll:true});actions.status('已返回当前游戏。');
  }
  async function beginOpening(seed=null){
    if(state.saveOperation&&state.saveOperation.kind!=='restore-opening')throw new Error('正在存取进度，请稍候');
    if(!['map','menu'].includes(state.scenes.phase))return;
    const previous={scene:state.scenes.current,world:state.world.snapshot(),view:state.scenes.captureView(),phase:state.scenes.phase};
    state.startupView.hide();state.audio?.suspend();state.scenes.setPhase('opening');
    try{
      const initial=seed??await actions.json('data/opening_seed.json');
      // Prepare each map at its source opcode, after the outgoing performance.
      // Persistent world replacement still waits for the whole program.
      const prepared=new Map();
      state.openingView=new OpeningView({resources:state.openingResources,prepared,clock:state.engine?.exploration.clock,
        program:state.openingProgram,
        prepare:(id,signal)=>state.loadingView.run(id,onProgress=>actions.prepareMap(id,{onProgress}),{signal}),
        staging:state.prologuePresentation.staging,effects:state.prologuePresentation.effects,nativeViewport:true,
        install:scene=>{actions.commitView(scene,initial.location);state.scenes.current=scene;state.view.follow=false;},
        camera:(x,y)=>{state.view.x=x;state.view.y=y;},say: actions.say,log: actions.log,
        shade:alpha=>{$('openingShade').style.opacity=String(alpha);}});
      $('openingShade').hidden=false;$('openingShade').style.opacity='1';
      actions.status('序章正在演出；Enter／空格或点击画面推进字幕，文字未显示完时先补全。');
      const playback=new OpeningRunner({program:state.openingProgram,hooks:state.openingView.hooks()});
      const result=await playback.run(),hero=state.openingView.getActor(0);
      const next=completedOpeningWorld(initial,result,hero.direction,state.catalog.maps.map(m=>m.id));
      actions.validateEntry(state.scenes.current,next.location);
      state.world.replace(next);state.scenes.current.npcRuntime?.adoptActors(state.openingView.actors);
      state.openingView.dispose();actions.commitView(state.scenes.current,next.location);
      $('openingShade').hidden=true;state.scenes.setPhase('map');actions.buildHud();actions.updateNearest();
      actions.log({type:'opening-complete',commands:result.executed_indices.length,source:result.source,limitations:result.limitations});
      actions.status('序章结束。去王厅寻找凯，再回住处领取装备。');canvas.focus({preventScroll:true});
    }catch(error){
      if(state.openingView)state.openingView.dispose();
      $('openingShade').hidden=true;actions.clearDialogue();
      state.world.replace(previous.world);state.scenes.current=previous.scene;state.scenes.rollbackView(previous.view);
      if(previous.phase==='menu')showTitle();else{state.scenes.setPhase('map');actions.buildHud();}
      actions.log({type:'opening-failed',error:error.message});throw error;
    }
  }
  async function restore(envelope,{operation=null}={}){
    if(!operation)return actions.withSaveOperation('load',owned=>restore(envelope,{operation:owned}));
    if(state.saveOperation!==operation)throw new Error('存档操作已失效');
    const previousPhase=operation.phase;
    const restored=await decodeSave(envelope,state.catalog.maps.map(m=>m.id));
    if(restored.party.some(actor=>!state.catalog.roles.some(role=>role.id===actor.id)))throw new Error('存档包含尚未接入的队伍角色');
    if(restored.source.kind==='native-new-game'){createPartyActors(restored,state.partyCombat,{},state.itemData);validateSourceSkillShortcuts(restored,state.partySkills);for(const role of restored.party){techniqueCombinations(restored,state.partySkills,role.id);if(restored.technique_bindings)techniqueSlots(restored,state.partySkills,role.id);}}
    if(restored.opening?.status==='pending'){
      // A legacy pending prologue must release the picker before it takes input.
      const picker=state.saveMenuContext;
      if(picker){state.saveMenu.hide();state.saveMenuContext=null;picker.resolve();operation.phase=picker.originPhase;}
      operation.kind='restore-opening';state.scenes.setPhase(operation.phase);await beginOpening(restored);return;
    }
    try{
      state.scenes.setPhase('map');
      await state.scenes.loadLocation(restored.location,{reason:'restore',restoredWorld:restored});
      state.startupView.hide();actions.buildHud();actions.updateNearest();canvas.focus();actions.status('进度已载入，可以继续探索。');
      actions.log({type:'restore',map_id:restored.location.map_id,opening:restored.opening?.status??'legacy-v1'});
    }catch(error){if(previousPhase==='menu')showTitle();throw error;}
  }
  async function openSaveCrystal(){
    return openSaveMenu({mode:'save'});
  }
  async function openSaveMenu({mode='save'}={}){
    const originPhase=state.scenes.phase;
    if(state.saveOperation||state.saveMenuContext||!['map','menu'].includes(originPhase)||mode==='save'&&originPhase!=='map')throw new Error('当前操作完成后才能打开存档页面');
    let resolve;const finished=new Promise(done=>resolve=done),context={mode,originPhase,resolve};state.saveMenuContext=context;state.scenes.setPhase('save-menu');
    state.saveMenu.show({mode,summary:{name:state.world.value.party.map(role=>role.name).join('　'),money:state.world.value.money??0}});
    await actions.refreshSaveSlots({quiet:true});
    if(state.saveMenuContext===context)state.saveMenu.setEntries(actions.saveEntries());
    actions.log({type:'save-menu-open',mode,slots:20});return finished;
  }
  function closeSaveMenu({loaded=false}={}){
    const context=state.saveMenuContext;if(!context||state.saveOperation)return false;
    state.saveMenu.hide();state.saveMenuContext=null;state.scenes.setPhase(loaded?'map':context.originPhase);context.resolve();canvas.focus({preventScroll:true});return true;
  }
  async function selectSaveSlot(row){
    const context=state.saveMenuContext;if(!context||state.saveOperation)throw new Error('存档页面已关闭或正在存取进度');
    if(context.mode==='save'){
      try{await actions.saveProgress(row.slot,{fromMenu:true,createOnly:!row.envelope,expectedSha:row.envelope?.sha256});}
      catch(error){if(error.status===412){await actions.refreshSaveSlots({quiet:true});if(state.saveMenuContext===context)state.saveMenu.setEntries(actions.saveEntries());}throw error;}
      await actions.refreshSaveSlots({quiet:true});state.saveMenu.setEntries(actions.saveEntries());state.saveMenu.setMessage(`栏位 ${row.slot} 已保存。`);
    }else{await actions.loadProgress(row.slot,{fromMenu:true});closeSaveMenu({loaded:true});}
  }
  async function presentGameOver(policy){
    state.audio?.suspend();state.scenes.setPhase('game-over');$('gameOver').hidden=false;
    const video=$('gameOverVideo');video.currentTime=0;$('gameOverSkip').focus();
    let playbackError=null;
    await new Promise(resolve=>{
      const finish=()=>{video.pause();video.onended=null;video.onerror=null;$('gameOverSkip').onclick=null;resolve();};
      video.onended=finish;video.onerror=()=>{playbackError='败北电影加载失败';finish();};$('gameOverSkip').onclick=finish;
      video.play().catch(error=>{playbackError=error.message;finish();});
    });
    $('gameOver').hidden=true;showTitle();actions.status('全队倒下。请载入已保存的进度，或开始新游戏。');
    actions.log({type:'game-over',policy,movie:'/assets/video/go02.mp4',playback_error:playbackError});
  }
  return {showTitle, resumeExploration, beginOpening, restore, openSaveCrystal,openSaveMenu,closeSaveMenu,selectSaveSlot, presentGameOver};
}
