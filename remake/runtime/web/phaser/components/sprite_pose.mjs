// Frames are selected by the existing native action timeline. Phaser displays
// them without a second animation clock changing contact or completion times.
export class SpritePose {
  constructor(scene,container,textures){
    this.textures=textures;
    this.body=scene.add.sprite(0,0,'__WHITE').setOrigin(0);
    this.light=scene.add.sprite(0,0,'__WHITE').setOrigin(0).setBlendMode('ADD');
    container.add([this.body,this.light]);
  }
  apply({image,light,sx=0,sy=0,width=image.width,height=image.height,displayWidth=width,displayHeight=height}){
    const main=this.textures.region(image,sx,sy,width,height);
    this.body.setTexture(main.key,main.frame).setDisplaySize(displayWidth,displayHeight);
    this.light.setVisible(Boolean(light));
    if(light){const glow=this.textures.region(light,sx,sy,width,height);
      this.light.setTexture(glow.key,glow.frame).setDisplaySize(displayWidth,displayHeight);}
  }
}
