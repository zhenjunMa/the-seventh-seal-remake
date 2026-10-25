// Native ANM 60/62/63 adapted to browser media. The source selects each file
// and lifecycle operation; browser decoding and wall-clock timing are adapters.
import {playbackTask} from './core/story_playback.mjs';
const need=(ok,message)=>{if(!ok)throw new Error(`剧情媒体：${message}`);};
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export function validateStoryMedia(data){
  need(data?.schema==='seventh-seal-story-media'&&data.version===1&&data.videos&&data.sounds,'清单版本无效');
  for(const [table,directory,extension]of [['videos','video','bik'],['sounds','audio','wav|mp3']])
    for(const [name,row]of Object.entries(data[table])){
      need(new RegExp(`^[a-z0-9_-]+\\.(?:${extension})$`).test(name)&&digest(row.sha256)&&digest(row.source?.sha256),'资源来源无效');
      need(new RegExp(`^/assets/${directory}/story/[a-z0-9_-]+\\.(?:mp4|wav|mp3)$`).test(row.path),'资源路径无效');
      need(row.source.path?.toLowerCase()===`${table==='videos'?'animate':'sound'}/${name}`,'原文件名不匹配');
      if(row.audio?.playback_gain!==undefined)need(Number.isFinite(row.audio.playback_gain)&&row.audio.playback_gain>0&&row.audio.playback_gain<=16,'播放补偿增益无效');
    }
  return data;
}
export class StoryMediaView{
  constructor({manifest,root,audio,playback,createMedia=kind=>document.createElement(kind),
    setTimer=(callback,delay)=>globalThis.setInterval(callback,delay),clearTimer=handle=>globalThis.clearInterval(handle),createAudioContext=()=>{
      const Context=globalThis.AudioContext??globalThis.webkitAudioContext;need(Context,'浏览器不支持剧情音频增益');return new Context();
    }}){
    validateStoryMedia(manifest);need(typeof audio?.setStoryMusicSuppressed==='function','地图音乐接口缺失');
    Object.assign(this,{manifest,root,audio,playback,createMedia,setTimer,clearTimer,createAudioContext});
    this.entries=new Set();this.persistent=null;this.deferredRelease=false;this.disposed=false;this.timer=null;
  }
  check(){need(!this.disposed,'播放器已关闭');if(this.error)throw this.error;this.playback?.check();}
  suppressMusic(value){this.audio.setStoryMusicSuppressed(value);}
  fail(error){this.error??=error;this.playback?.fail(error);}
  retire(entry){
    if(!this.entries.delete(entry))return;
    entry.clean();try{entry.media.pause();entry.media.removeAttribute?.('src');entry.media.load?.();entry.media.remove?.();}catch{}
    entry.sourceNode?.disconnect();entry.gainNode?.disconnect();
    if(!this.entries.size&&this.timer!==null){this.clearTimer(this.timer);this.timer=null;}
  }
  releaseSounds(){
    for(const entry of [...this.entries])if(entry.kind==='audio')this.retire(entry);
    this.persistent=null;this.deferredRelease=false;
  }
  sync(){
    if(this.disposed)return;
    const channels=this.audio.snapshot?.().channels;
    for(const entry of this.entries){
      if(channels){
        const master=channels.master,channel=entry.kind==='audio'?channels.effects:null;
        entry.media.muted=Boolean(master.muted||channel?.muted);
        entry.media.volume=channel?Math.max(1,Math.min(127,Math.floor(2*Math.round(master.volume*64)*Math.round(channel.volume*64)/64)))/127:master.volume;
      }
      if(entry.ended)continue;
      if(this.playback?.paused)entry.media.pause();
      else if(entry.media.paused&&!entry.pending)this.start(entry);
    }
  }
  start(entry){
    if(entry.pending)return entry.startPromise;
    if(entry.ended||!this.entries.has(entry)||this.playback?.paused)return Promise.resolve();
    entry.pending=true;
    let result;try{
      result=entry.sourceNode?Promise.resolve(this.audioContext.resume?.()).then(()=>{
        if(this.entries.has(entry)&&!this.disposed&&!this.playback?.paused)return entry.media.play();
      }):entry.media.play();
    }catch(error){result=Promise.reject(error);}
    const promise=Promise.resolve(result).then(()=>{
      entry.pending=false;
      if(!this.entries.has(entry)||this.disposed||this.playback?.paused)entry.media.pause();
    },error=>{entry.pending=false;if(this.entries.has(entry)){entry.reject(error);this.fail(error);}throw error;});
    entry.startPromise=promise;promise.catch(()=>{});return promise;
  }
  make(kind,filename,signal){
    this.check();signal?.throwIfAborted();
    const row=this.manifest[kind==='video'?'videos':'sounds'][filename.toLowerCase()];need(row,`原资源尚未准备：${filename}`);
    const media=this.createMedia(kind),entry={kind,media,ended:false,pending:false};
    entry.finished=new Promise((resolve,reject)=>Object.assign(entry,{resolve,reject}));entry.finished.catch(()=>{});
    const ended=()=>{
      if(!this.entries.has(entry))return;
      entry.ended=true;entry.resolve();
      if(entry===this.persistent&&this.deferredRelease)this.releaseSounds();
    };
    const failed=()=>{if(this.entries.has(entry)){const error=media.error??new Error(`无法播放原剧情资源 ${filename}`);entry.reject(error);this.fail(error);}};
    const abort=()=>{entry.reject(signal.reason);this.retire(entry);};
    media.addEventListener('ended',ended);media.addEventListener('error',failed);signal?.addEventListener('abort',abort,{once:true});
    entry.clean=()=>{media.removeEventListener('ended',ended);media.removeEventListener('error',failed);signal?.removeEventListener('abort',abort);};
    media.preload='auto';media.loop=false;media.src=row.path;
    if(kind==='video'){
      media.playsInline=true;media.setAttribute?.('aria-label','剧情动画');
      if(media.style)Object.assign(media.style,{position:'absolute',inset:'0',width:'100%',height:'100%',objectFit:'contain',background:'#000',zIndex:'85',pointerEvents:'none'});
      this.root?.appendChild(media);
    }
    this.entries.add(entry);
    try{
      const gain=row.audio?.playback_gain??1;
      if(gain!==1){
        // Browser element.volume cannot exceed one. An owned Web Audio graph
        // restores the export's documented headroom compensation before mix.
        this.audioContext??=this.createAudioContext();
        entry.sourceNode=this.audioContext.createMediaElementSource(media);entry.gainNode=this.audioContext.createGain();
        entry.gainNode.gain.value=gain;entry.sourceNode.connect(entry.gainNode);entry.gainNode.connect(this.audioContext.destination);
      }
      if(this.timer===null)this.timer=this.setTimer(()=>this.sync(),16);this.sync();return entry;
    }catch(error){this.retire(entry);throw error;}
  }
  hooks(){return {
    media:async({filename,signal})=>{
      const previous=this.audio.snapshot?.().story_music_suppressed??false;
      this.suppressMusic(true);let entry;
      try{
        entry=this.make('video',filename,signal);
        await playbackTask(entry.finished,signal);
        if(this.playback?.paused)await this.playback.ready();this.check();
      }finally{if(entry)this.retire(entry);this.suppressMusic(previous);}
    },
    sound:async({kind,filename,persistent,modeRaw,signal})=>{
      this.check();signal?.throwIfAborted();
      if(kind==='restore-music'){this.suppressMusic(false);return;}
      if(kind==='release'){
        // Native 432CE0 polls completion after 63 sets the deferred flag.
        // A persistent handle makes every mode take this branch.
        if(this.persistent){this.deferredRelease=true;if(this.persistent.ended)this.releaseSounds();}
        else if(modeRaw===0)this.releaseSounds();
        else this.suppressMusic(true);
        return;
      }
      need(kind==='play','声音操作未恢复');const entry=this.make('audio',filename,signal);
      if(persistent)this.persistent=entry;
      await this.start(entry);this.check();
    }
  };}
  dispose(){
    if(this.disposed)return;this.disposed=true;
    for(const entry of [...this.entries]){entry.reject(new Error('剧情媒体已关闭'));this.retire(entry);}
    this.persistent=null;this.suppressMusic(false);
    const closing=this.audioContext?.close?.();closing?.catch?.(()=>{});this.audioContext=null;
  }
}
