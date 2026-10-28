let serial=0;

// ImageResources and BattleResources keep ownership of decoded pixels and hashes.
// This cache only owns Phaser textures / frames referencing those same pixels.
export class TextureCache {
  constructor(scene){this.scene=scene;this.sources=new WeakMap();this.entries=new Set();this.frame=0;}
  begin(){this.frame++;}
  texture(source){
    if(!source)throw new Error('Phaser 素材尚未准备');
    let entry=this.sources.get(source);
    if(!entry){
      const key=`seal:${++serial}`;
      const texture=source.battleParticleRevision!==undefined?this.scene.textures.addCanvas(key,source):this.scene.textures.addImage(key,source);
      if(!texture)throw new Error(`Phaser 无法建立纹理：${key}`);
      texture.setFilter(1); // Phaser.Textures.FilterMode.NEAREST; preserve source pixels.
      entry={key,texture,source,used:this.frame,revision:source.battleParticleRevision};this.sources.set(source,entry);this.entries.add(entry);
    }
    if(source.battleParticleRevision!==undefined&&entry.revision!==source.battleParticleRevision){entry.texture.refresh();entry.revision=source.battleParticleRevision;}
    entry.used=this.frame;return entry;
  }
  region(source,x=0,y=0,width=source.width,height=source.height,name=`${x},${y},${width},${height}`){
    const entry=this.texture(source),old=entry.texture.frames[name];
    if(old&&(old.cutX!==x||old.cutY!==y||old.cutWidth!==width||old.cutHeight!==height))entry.texture.remove(name);
    if(!entry.texture.has(name))entry.texture.add(name,0,x,y,width,height);
    return {key:entry.key,frame:name};
  }
  prune(){
    for(const entry of this.entries)if(entry.used<this.frame){
      this.scene.textures.remove(entry.key);this.sources.delete(entry.source);this.entries.delete(entry);
    }
  }
  destroy(){for(const entry of this.entries)this.scene.textures.remove(entry.key);this.entries.clear();this.sources=new WeakMap();}
}
