import {WorldStore,decodeSave} from '../core/world.mjs';
import {createBattleController} from '../controllers/battle.mjs';
import {loadRuntimeConfiguration,compileRuntimeConfiguration} from '../core/runtime_config.mjs';
import {LoadingView} from '../loading_view.mjs';
import {BattleTransitionView} from '../battle_transition_view.mjs';
import {battleResources,drawBattleImage} from '../core/battle_resources.mjs';
const $=id=>document.getElementById(id),json=async p=>{const r=await fetch('/'+p.replace(/^\//,''),{cache:'no-store'});if(!r.ok)throw Error(p);return r.json();};
const names={battleData:'combat_sample',forestData:'forest_combat',schedulerData:'battle_scheduler',aiData:'forest_ai',partyRewards:'party_rewards',partySkills:'party_skills',partyCombat:'party_combat',partyReactions:'party_reactions',statusData:'forest_status',sourceItemData:'items'};
const state={...Object.fromEntries(await Promise.all(Object.entries(names).map(async([k,v])=>[k,await json('data/'+v+'.json')]))),catalog:{party_battle_view:'data/party_battle_view.json'},
  view:{x:0,y:0},battleViews:new Map(),battleHistory:[],battleCursorMemory:new Map(),selectedRole:'001',sidePriority:0,
  scenes:{phase:'map',setPhase(phase){this.phase=phase;$('phase').textContent=phase;}}};
const seed=await decodeSave(await json('tests/fixtures/battle_loading_save.json')),logs=[],runs=[],checks=[],entryFrames=[];
const storageBefore=Object.entries(localStorage),canvas=$('stage');let locked=false;
const report=()=>{$('report').textContent=JSON.stringify({scope:'Controlled entry; simulation paused after entry for observation. Main-page movement/attack checked separately.',runs,checks,cache:battleResources.snapshot(),storage_unchanged:JSON.stringify(storageBefore)===JSON.stringify(Object.entries(localStorage)),last_events:logs.slice(-8)},null,2);};
const log=e=>{const {type,kind,elapsed_ms,mode,cache,frames,actor_id,action_id,error}=e;logs.push({type,kind,elapsed_ms,mode,cache,frames,actor_id,action_id,error,at:performance.now()});if(e.type==='battle-transition-complete')report();};
state.loadingView=await LoadingView.create({root:$('sceneLoading'),manifest:(await json('data/prologue_presentation.json')).loading,image:async p=>{const i=new Image();i.src=p;await i.decode();return i;},log});
state.battleTransition=new BattleTransitionView({loadingView:state.loadingView,log});
const actions={json,log,status:message=>{$('phase').textContent=message;},guarded:fn=>async()=>{try{await fn();}catch(e){checks.push({error:e.message});report();}},resize(){},buildHud(){},updateNearest(){},refreshPartyMenu(){},
  readConfiguredData:async()=>compileRuntimeConfiguration({combat:state.battleData,forest:state.forestData,scheduler:state.schedulerData,ai:state.aiData,rewards:state.partyRewards,party_skills:state.partySkills,items:state.sourceItemData},await loadRuntimeConfiguration(json)),
  beginTechniqueTestMenu(){state.menuContext=null;return {};},resumeTechniqueTestMenu(){state.menuContext={combat:false,page:'skills'};state.scenes.setPhase('party-menu');}};
Object.assign(actions,createBattleController({state,actions,$,canvas,ctx:canvas.getContext('2d')}));
function reset(){state.battleView?.stop('QA reset');state.battleMenu?.dispose();state.battle=null;state.battleMenu=null;state.skillTestSession=null;state.battlePresentationError=null;state.world=new WorldStore(structuredClone(seed));state.scenes.setPhase('map');canvas.hidden=false;
  for(const id of ['battleCanvas','battleHud','battleCommands'])$(id).hidden=true;
  const c=canvas.getContext('2d');for(let y=0;y<540;y+=30)for(let x=0;x<960;x+=30){c.fillStyle=(x/30+y/30)%2?'#3a5b68':'#172837';c.fillRect(x,y,30,30);}c.fillStyle='#fff';c.font='40px sans-serif';c.fillText('进入战斗前的画面',230,270);}
async function run(kind){reset();const before=state.world.snapshot(),start=performance.now(),from=logs.length,frameFrom=entryFrames.length;
  if(kind==='training'){state.scenes.setPhase('party-menu');state.menuContext={combat:false,page:'skills'};await actions.startTechniqueTest();}
  else await actions.startBattle({map_id:'M70010',stage:'stage13.scn',members:[{id:'012'},{id:'013'}]},structuredClone(state.world.value.encounters));
  const frames=entryFrames.slice(frameFrom),ready=logs.slice(from).find(e=>e.type==='battle-resources-ready');
  runs.push({kind,total_entry_ms:performance.now()-start,resource_ms:ready?.elapsed_ms,cache:ready?.cache,phase:state.scenes.phase,
    clock_frozen_during_entry:frames.every(f=>f.phase==='battle-loading'&&f.ticks===0),entry_observations:frames.length,
    no_loading_page:frames.every(f=>!f.generic_loading_visible&&(!f.scene_loading_visible||f.kind==='battle-transition')),
    entry_kinds:[...new Set(frames.map(f=>f.kind??'retained-map'))],
    world_revision_before:before.revision,world_revision_after:state.world.value.revision});report();}
async function pixels(){
  reset();
  const data=await battleResources.catalog();
  const paths=[Object.keys(data.images).find(p=>p.includes('party_roles/001')),Object.keys(data.images).find(p=>p.includes('party_layers/001')&&p.endsWith('_main.png')),
    Object.keys(data.images).find(p=>p.includes('party_effects/')),Object.keys(data.images).find(p=>p.includes('forest_stage/')),
    Object.keys(data.images).find(p=>p.includes('battle_ui/')&&data.images[p].width>20),Object.keys(data.images).find(p=>p.includes('battle_result/'))].filter(Boolean);
  const images=await battleResources.preparePaths(paths,{scope:'qa-pixel-check'});
  for(const path of paths){const row=data.images[path],region=row.regions[0];if(!region)continue;const [x,y,w,h]=region;
    const original=new Image();original.src=path;await original.decode();
    for(const blend of ['source-over','lighter','destination-in']){const a=document.createElement('canvas'),b=document.createElement('canvas');a.width=b.width=Math.min(w,640);a.height=b.height=Math.min(h,480);
      for(const surface of [a,b]){const c=surface.getContext('2d');c.imageSmoothingEnabled=false;c.fillStyle='#35405a';c.fillRect(0,0,a.width,a.height);c.globalCompositeOperation=blend;}
      a.getContext('2d').drawImage(original,x,y,a.width,a.height,0,0,a.width,a.height);drawBattleImage(b.getContext('2d'),images.get(path),x,y,b.width,b.height,0,0,b.width,b.height);
      const aa=a.getContext('2d').getImageData(0,0,a.width,a.height).data,bb=b.getContext('2d').getImageData(0,0,b.width,b.height).data;let differences=0;for(let i=0;i<aa.length;i++)if(aa[i]!==bb[i])differences++;
      checks.push({pixel_path:path,blend,channels:aa.length,differences,passed:differences===0});
    }original.src='';
  }battleResources.release('qa-pixel-check');report();}
async function transitions(){reset();const before=state.battleTransition.capture(canvas),after=document.createElement('canvas');after.width=640;after.height=480;const c=after.getContext('2d');c.fillStyle='#54245c';c.fillRect(0,0,640,480);c.fillStyle='#fff';c.font='38px sans-serif';c.fillText('战场已准备好',160,240);
  for(let kind=0;kind<7;kind++){await state.battleTransition.run(before,()=>after,{kind});checks.push({transition:kind,completed:true,overlay_hidden:$('sceneLoading').hidden});report();}}
async function guarded(fn){if(locked)return;locked=true;document.querySelectorAll('header button:not(#download)').forEach(b=>b.disabled=true);try{await fn();}catch(e){checks.push({error:e.stack});report();}finally{locked=false;document.querySelectorAll('header button').forEach(b=>b.disabled=false);}}
$('normal').onclick=()=>guarded(()=>run('normal'));$('training').onclick=()=>guarded(()=>run('training'));$('reset').onclick=()=>guarded(async()=>{if(state.skillTestSession&&state.battle){state.battle.interrupt('QA return');await actions.returnFromBattle();checks.push({training_returned:state.skillTestSession===null,phase:state.scenes.phase});}else reset();report();});
$('pixels').onclick=()=>guarded(pixels);$('transitions').onclick=()=>guarded(transitions);
$('download').onclick=()=>{const value={scope:'Independent controlled browser fixture; no natural encounter RNG or original execution claimed',runs,checks,logs,entryFrames,cache:battleResources.snapshot(),storage_unchanged:JSON.stringify(storageBefore)===JSON.stringify(Object.entries(localStorage))};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='battle_loading_browser_observation.json';a.click();URL.revokeObjectURL(a.href);};
document.addEventListener('keydown',e=>{if(state.scenes.phase.startsWith('battle-')&&state.scenes.phase!=='battle-loading'){if(actions.battleKey(e.key,e.repeat))e.preventDefault();}});
function frame(now){try{if(state.scenes.phase==='battle-loading')entryFrames.push({phase:state.scenes.phase,ticks:state.battle?.presentationSnapshot()?.scheduler?.ticks??0,kind:$('sceneLoading').dataset.kind,
    generic_loading_visible:!$('loading').hidden,scene_loading_visible:!$('sceneLoading').hidden});
  else if(state.scenes.phase.startsWith('battle-')&&state.battle){state.battleView.draw(state.battle.presentationSnapshot(),now);actions.drawBattleInterface(now);}}
  catch(e){checks.push({render_error:e.message});state.scenes.setPhase('error');report();}requestAnimationFrame(frame);}
reset();requestAnimationFrame(frame);document.querySelectorAll('header button').forEach(b=>b.disabled=false);report();
