// Frames are selected by the existing native action timeline. Phaser displays
// them without a second animation clock changing contact or completion times.
import {shadowRectangle} from '../../map_sprite.mjs';
export class SpritePose {
  constructor(scene,container,textures){
    this.textures=textures;
    this.shadow=scene.add.sprite(0,0,'__WHITE').setOrigin(0);
    this.body=scene.add.sprite(0,0,'__WHITE').setOrigin(0);
    this.light=scene.add.sprite(0,0,'__WHITE').setOrigin(0).setBlendMode('ADD');
    container.add([this.shadow,this.body,this.light]);
  }
  apply({image,light,shadow,shadow_geometry,sx=0,sy=0,width=image.width,height=image.height,displayWidth=width,displayHeight=height}){
    this.shadow.setVisible(Boolean(shadow));
    if(shadow){const rect=shadowRectangle(sx,sy,width,height,shadow_geometry,displayWidth/width,displayHeight/height);
      const mask=this.textures.region(shadow,rect.sx,rect.sy,rect.width,rect.height);
      this.shadow.setPosition(rect.x,rect.y).setTexture(mask.key,mask.frame).setDisplaySize(rect.displayWidth,rect.displayHeight);}
    const main=this.textures.region(image,sx,sy,width,height);
    this.body.setTexture(main.key,main.frame).setDisplaySize(displayWidth,displayHeight);
    this.light.setVisible(Boolean(light));
    if(light){const glow=this.textures.region(light,sx,sy,width,height);
      this.light.setTexture(glow.key,glow.frame).setDisplaySize(displayWidth,displayHeight);}
  }
}
