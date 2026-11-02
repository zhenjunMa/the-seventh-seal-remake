import {PhaserRuntime} from '../phaser/runtime.mjs';
import {createHandoffFixture} from './battle_handoff_fixture.mjs';

const $=id=>document.getElementById(id),definitions=new Map(),images=new Map();
const load=async path=>{
  if(!definitions.has(path))definitions.set(path,fetch(path).then(response=>{if(!response.ok)throw new Error(`定义读取失败：${path}`);return response.json();}));
  return structuredClone(await definitions.get(path));
};
function placeholder(asset){
  const role=asset.path.match(/(?:roles|layers|lifecycle)\/(\d+)/)?.[1],color=({'001':'#f29a71','002':'#e8c56e','003':'#94c98b','004':'#9fb5eb'})[role]??'#79b9c5';
  const key=`${asset.width}:${asset.height}:${color}`;
  if(!images.has(key)){
    const image=document.createElement('canvas');image.width=asset.width;image.height=asset.height;
    const c=image.getContext('2d'),w=Math.min(48,image.width*.4),h=Math.min(85,image.height*.65),x=image.width/2,y=image.height*.8;
    c.fillStyle=color;c.fillRect(x-w/2,y-h*.7,w,h*.7);c.fillRect(x-w*.3,y-h,w*.6,h*.25);
    images.set(key,image);
  }
  return images.get(key);
}
let fixture=null,origin=null,advancing=false,running=false,manualPause=false;
const runtime=await PhaserRuntime.create({parent:$('stage'),focusTarget:$('stage'),renderScale:1,actorSmoothing:false,onError:fail});
function fail(error){running=false;document.body.dataset.result='failed';$('status').textContent=error.stack??String(error);}
function report(){
  if(!fixture)return;
  const {battle,events,config}=fixture,chain=battle.state.reward_ledger.chain;
  const scheduled=events.filter(e=>e.type==='battle-scheduled'),enemyTurns=scheduled.filter(e=>e.actor_id==='enemy-0');
  $('status').textContent=`${running?'正在运行':'已结束'} · 最大连击 ${chain.maximum} · 敌人主动行动 ${enemyTurns.length} 次${manualPause?' · 已暂停':''}`;
  const rows=battle.players().map(actor=>{
    const body=events.find(e=>e.type==='battle-attack-completed'&&e.actor_id===actor.id),end=events.find(e=>e.type==='battle-source-completed'&&e.actor_id===actor.id);
    const state=battle.activeActions.has(actor.id)?battle.state.scheduler.active_actor_id===actor.id?'攻击阶段':'归位／收尾':actor.native_active?'受击／起身':'待机';
    return [actor.name,state,body?`${(body.presentation_time_ms/1000).toFixed(3)} 秒`:'—',end?`${(end.at/1000).toFixed(3)} 秒`:'—'];
  });
  $('actors').replaceChildren(...rows.map(values=>{const row=document.createElement('tr');for(const value of values){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}return row;}));
  const hits=events.filter(e=>e.type==='battle-impact'&&e.hit&&e.actor_id!=='enemy-0');
  $('result').textContent=JSON.stringify({scenario:document.body.dataset.scenario,ordered:config.ordered,maximum_combo:chain.maximum,
    effective_hits:hits.length,order:scheduled.map(e=>battle.actor(e.actor_id).name),
    enemy_action_seconds:enemyTurns.map(e=>+(e.at/1000).toFixed(3)),
    active_actions:battle.activeActions.size,pending_presentations:battle.pendingPresentations.size},null,2);
}
async function start(scenario){
  if(advancing)return;
  runtime.pause('preparation');running=false;fixture?.dispose();fixture=null;origin=null;manualPause=false;runtime.resume('manual');$('pause').textContent='暂停';
  document.body.dataset.result='preparing';document.body.dataset.scenario=scenario;$('status').textContent='正在准备场景…';
  document.querySelectorAll('[data-case]').forEach(button=>button.disabled=true);
  try{
    fixture=await createHandoffFixture({load,canvas:runtime.battle.surface.canvas,assetLoader:placeholder,scenario,
      onImages:loaded=>runtime.battle.surface.prepareImages(loaded)});
    running=true;document.body.dataset.result='running';report();
  }catch(error){fail(error);}
  finally{document.querySelectorAll('[data-case]').forEach(button=>button.disabled=false);runtime.resume('preparation');}
}
runtime.start({phase:'battle-action',battle:now=>{
  if(!fixture||!running||advancing)return;
  origin??=now;advancing=true;const current=fixture;
  current.advance(now-origin).then(()=>{
    runtime.battle.surface.endFrame();
    if(current!==fixture)return;
    if(current.finished){running=false;document.body.dataset.result='passed';}
    report();
  }).catch(fail).finally(()=>advancing=false);
}});
for(const button of document.querySelectorAll('[data-case]'))button.onclick=()=>start(button.dataset.case);
$('pause').onclick=()=>{
  manualPause=!manualPause;if(manualPause)runtime.pause('manual');else runtime.resume('manual');
  $('pause').textContent=manualPause?'继续':'暂停';report();
};
$('status').textContent='已就绪，请选择验证场景。';
window.addEventListener('pagehide',()=>{fixture?.dispose();runtime.destroy();},{once:true});
