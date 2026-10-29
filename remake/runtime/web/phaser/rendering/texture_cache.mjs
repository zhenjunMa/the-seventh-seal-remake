import {battleBitmapResident,onBattleBitmapEvicted} from '../../core/battle_resources.mjs';
let serial=0;

// ImageResources and BattleResources keep ownership of decoded pixels and hashes.
// This cache only owns Phaser textures / frames referencing those same pixels.
export class TextureCache {
  constructor(scene,{idleFrames=120,budgetBytes=64*1024*1024,maxFrames=512}={}){
    Object.assign(this,{scene,idleFrames,budgetBytes,maxFrames});this.sources=new WeakMap();this.entries=new Set();this.frame=0;
    this.unsubscribe=onBattleBitmapEvicted(source=>{const entry=this.sources.get(source);if(entry)this.remove(entry);});
    this.stats={created:0,removed:0,frames_created:0};
  }
  begin(){this.frame++;}
  texture(source){
    if(!source)throw new Error('Phaser 素材尚未准备');
    let entry=this.sources.get(source);
    if(!entry){
      const key=`seal:${++serial}`;
      const texture=source.battleParticleRevision!==undefined?this.scene.textures.addCanvas(key,source):this.scene.textures.addImage(key,source);
      if(!texture)throw new Error(`Phaser 无法建立纹理：${key}`);
      texture.setFilter(1); // Phaser.Textures.FilterMode.NEAREST; preserve source pixels.
      entry={key,texture,source,used:this.frame,revision:source.battleParticleRevision,frames:new Map(),bytes:source.width*source.height*4};this.sources.set(source,entry);this.entries.add(entry);this.stats.created++;
    }
    if(source.battleParticleRevision!==undefined&&entry.revision!==source.battleParticleRevision){entry.texture.refresh();entry.revision=source.battleParticleRevision;}
    entry.used=this.frame;return entry;
  }
  region(source,x=0,y=0,width=source.width,height=source.height,name=`${x},${y},${width},${height}`){
    const entry=this.texture(source),old=entry.texture.frames[name];
    if(old&&(old.cutX!==x||old.cutY!==y||old.cutWidth!==width||old.cutHeight!==height))entry.texture.remove(name);
    if(!entry.texture.has(name)){entry.texture.add(name,0,x,y,width,height);this.stats.frames_created++;}
    entry.frames.set(name,this.frame);
    return {key:entry.key,frame:name};
  }
  prune(){
    // Atlas residency belongs to BattleResources. Dropping a texture merely
    // because its animation changed pages would undo that cache under WebGL.
    const unmanaged=[...this.entries].filter(entry=>battleBitmapResident(entry.source)===null).sort((a,b)=>a.used-b.used);
    let bytes=unmanaged.reduce((sum,entry)=>sum+entry.bytes,0);
    for(const entry of unmanaged)if(entry.used<this.frame&&(entry.source.battleParticleRevision!==undefined||this.frame-entry.used>this.idleFrames||bytes>this.budgetBytes||entry.source.width===0)){
      this.remove(entry);bytes-=entry.bytes;
    }
    for(const entry of this.entries)if(entry.frames.size>this.maxFrames)for(const [name,used]of entry.frames){
      if(entry.frames.size<=this.maxFrames)break;
      if(used===this.frame)continue;entry.texture.remove(name);entry.frames.delete(name);
    }
  }
  remove(entry){this.scene.textures.remove(entry.key);this.sources.delete(entry.source);this.entries.delete(entry);this.stats.removed++;}
  snapshot(){return {...this.stats,resident:this.entries.size,bytes:[...this.entries].reduce((sum,e)=>sum+e.bytes,0)};}
  destroy(){this.unsubscribe();for(const entry of [...this.entries])this.remove(entry);this.sources=new WeakMap();}
}
