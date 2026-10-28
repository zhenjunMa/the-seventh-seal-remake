import {BattleView} from '../battle_view.mjs';
import {BattleSurface} from '../phaser/rendering/battle_surface.mjs';
const result=document.querySelector('#result'),actors=[{id:'001',resource_id:'001',side:'player'},{id:'enemy',resource_id:'012',side:'enemy'}];
let view,mode=1,at=0,playing=false,start=0,serial=0,completed=[];
const snapshot={id:'death-particles-browser',actors:actors.map(a=>({...a,life_epoch:0,hp:{current:100}})),lifecycle_events:[]};
function begin(){
  view.lifecycle.reset();view.lastActorPoses.clear();completed=[];at=0;
  snapshot.lifecycle_events=[];view.draw(snapshot,0);
  snapshot.lifecycle_events=[{token:`death-${++serial}`,actor_id:'enemy',life_epoch:0,kind:'death',source_skill_index:null,fade_mode_raw:mode,fade_clock_raw:220}];
  view.draw(snapshot,0);
}
function paint(){view.draw(snapshot,at);completed.push(...view.drainLifecycleCompleted());result.textContent=JSON.stringify({mode,at_ms:Math.round(at),completed,playback:view.lifecycleSnapshot()},null,2);}
for(let i=1;i<=7;i++){
  const b=document.createElement('button');b.textContent=`模式${i}`;b.onclick=()=>{mode=i;playing=false;begin();paint();};document.querySelector('#modes').append(b);
}
for(const ms of [0,250,450,1000]){
  const b=document.createElement('button');b.textContent=`${ms}ms`;b.onclick=()=>{playing=false;begin();at=ms;paint();};document.querySelector('#times').append(b);
}
const play=document.createElement('button');play.textContent='播放';play.onclick=()=>{begin();playing=true;start=performance.now();};document.querySelector('#times').append(play);
new Phaser.Game({type:Phaser.WEBGL,width:640,height:480,parent:'screen',backgroundColor:'#000000',banner:false,
  scene:{async create(){
    const surface=new BattleSurface(this);view=new BattleView({canvas:surface.canvas,metadataPath:'/data/party_battle_view.json',lifecycleMetadataPath:'/data/battle_lifecycle.json'});
    await view.prepare({actors});view.setRoster(actors,{yantu:{id:'yantu',actor_id:'001'},enemy:{id:'enemy',actor_id:'enemy'}});begin();paint();
  },update(){if(playing){at=performance.now()-start;paint();if(at>=1000)playing=false;}}},audio:{noAudio:true}});
