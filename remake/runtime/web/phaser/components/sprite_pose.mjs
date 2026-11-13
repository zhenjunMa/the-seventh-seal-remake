// Frames are selected by the existing native action timeline. Phaser displays
// them without a second animation clock changing contact or completion times.
import {shadowRectangle} from '../../map_sprite.mjs';
import {imageRegions} from '../../core/resources/image_regions.mjs';
import {pixelSprite} from '../rendering/pixel_sprite.mjs';

export function* poseRegions({image,light,shadow,shadow_geometry,sx=0,sy=0,width=image.width,height=image.height}){
  if(shadow){
    const rect=shadowRectangle(sx,sy,width,height,shadow_geometry);
    yield* imageRegions(shadow,rect.sx,rect.sy,rect.width,rect.height);
  }
  if(!image.pixels)yield* imageRegions(image,sx,sy,width,height);
  if(light)yield* imageRegions(light,sx,sy,width,height);
}

function place(sprite,frame,x,y,width,height,displayWidth,displayHeight){
  const scaleX=displayWidth/width,scaleY=displayHeight/height;
  sprite.setVisible(!frame.empty).setTexture(frame.key,frame.frame)
    .setPosition(x+(frame.x??0)*scaleX,y+(frame.y??0)*scaleY)
    .setDisplaySize((frame.width??width)*scaleX,(frame.height??height)*scaleY);
}

export class SpritePose {
  constructor(scene,container,textures){
    this.textures=textures;
    this.shadow=scene.add.sprite(0,0,'__WHITE').setOrigin(0);
    this.body=pixelSprite(scene);
    this.light=scene.add.sprite(0,0,'__WHITE').setOrigin(0).setBlendMode('ADD');
    container.add([this.shadow,this.body,this.light]);
  }
  apply({image,light,shadow,shadow_geometry,body_offset,sx=0,sy=0,width=image.width,height=image.height,displayWidth=width,displayHeight=height},character=false){
    this.shadow.setVisible(Boolean(shadow));
    if(shadow){const rect=shadowRectangle(sx,sy,width,height,shadow_geometry,displayWidth/width,displayHeight/height);
      const mask=this.textures.region(shadow,rect.sx,rect.sy,rect.width,rect.height);
      place(this.shadow,mask,rect.x,rect.y,rect.width,rect.height,rect.displayWidth,rect.displayHeight);}
    const x=body_offset?.x??0,y=body_offset?.y??0;
    this.body.pixelImage=image.pixels?image:null;
    this.body.smoothActor=false;
    if(image.pixels){this.body.setPosition(x,y).setVisible(true);this.body.xbrBounds=null;this.body.setTexture('__WHITE').setSize(width,height).setScale(displayWidth/width,displayHeight/height);this.body.pixelRegion={sx,sy,sw:width,sh:height};}
    else{
      const main=image.packed&&!image.pixelScale?this.textures.actorRegion(image,sx,sy,width,height):this.textures.region(image,sx,sy,width,height);
      this.body.xbrBounds=main.bounds??null;
      this.body.smoothActor=Boolean(character&&!main.pixelScale);
      place(this.body,main,x,y,width,height,displayWidth,displayHeight);
    }
    this.light.setVisible(Boolean(light));
    if(light)place(this.light,this.textures.region(light,sx,sy,width,height),x,y,width,height,displayWidth,displayHeight);
  }
}
