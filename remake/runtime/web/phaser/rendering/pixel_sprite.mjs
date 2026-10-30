// Sparse source pixels use one 12-byte instance record each. The GPU expands
// each record to a pixel quad, preserving fractional scales and camera motion.
// Phaser owns the pipeline and restorable buffers; there is no texture upload.
const KEY='SealPixels';
export function preparePixelPipeline(renderer){return pixelPipeline(renderer);}
function pixelPipeline(renderer){
  let pipeline=renderer.pipelines.get(KEY);if(pipeline)return pipeline;
  const Phaser=globalThis.Phaser;
  class PixelPipeline extends Phaser.Renderer.WebGL.WebGLPipeline{
    constructor(){super({game:renderer.game,name:KEY,batchSize:1,
      vertShader:`precision highp float;
        uniform mat4 uProjectionMatrix;
        uniform mat3 uTransform;
        attribute vec2 inCorner;
        attribute vec2 inPosition;
        attribute vec4 inTint;
        varying vec4 outTint;
        void main(){vec3 p=uTransform*vec3(inPosition+inCorner,1.0);
          gl_Position=uProjectionMatrix*vec4(p.xy,0.0,1.0);outTint=inTint;}`,
      fragShader:`precision mediump float;varying vec4 outTint;
        void main(){gl_FragColor=vec4(outTint.bgr*outTint.a,outTint.a);}`,
      attributes:[{name:'inCorner',size:2},{name:'inPosition',size:2},{name:'inTint',size:4,type:Phaser.Renderer.WebGL.UNSIGNED_BYTE,normalized:true}]});
      this.instances=renderer.createVertexBuffer(12,renderer.gl.DYNAMIC_DRAW);
      this.corners=renderer.createVertexBuffer(new Float32Array([0,0,0,1,1,1,0,0,1,1,1,0]),renderer.gl.STATIC_DRAW);
      this.transform=new Float32Array(9);this.capacity=0;this.stats={draws:0,pixels:0,uploaded_bytes:0};
    }
    drawPixels(source,region,matrix,alpha){
      const gl=this.gl,program=this.currentShader.program.webGLProgram;
      if(this.locationsProgram!==program){this.locationsProgram=program;this.extension=gl.getExtension('ANGLE_instanced_arrays');this.locations=['inCorner','inPosition','inTint'].map(name=>gl.getAttribLocation(program,name));}
      const extension=this.extension;if(!extension)return false;
      const pixels=source.pixels();if(!pixels.length)return true;
      if(this.capacity<pixels.length){this.capacity=2**Math.ceil(Math.log2(pixels.length));this.data=new ArrayBuffer(this.capacity*12);this.f32=new Float32Array(this.data);this.u32=new Uint32Array(this.data);}
      const {sx=0,sy=0,sw=source.width,sh=source.height}=region??{},tint=Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha;let count=0;
      for(const value of pixels){const p=source.original?value.original:value;if(!p)continue;
        const x=p.x-(source.offsetX??0),y=p.y-(source.offsetY??0);if(x<sx||y<sy||x>=sx+sw||y>=sy+sh)continue;
        const at=count++*3;this.f32[at]=x-sx;this.f32[at+1]=y-sy;this.u32[at+2]=tint((p.rgb[0]<<16)|(p.rgb[1]<<8)|p.rgb[2],alpha*(p.alpha??1));}
      if(!count)return true;
      const [corner,position,color]=this.locations;
      this.transform.set([matrix.a,matrix.b,0,matrix.c,matrix.d,0,matrix.e,matrix.f,1]);this.setMatrix3fv('uTransform',false,this.transform);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.corners.webGLBuffer);gl.enableVertexAttribArray(corner);gl.vertexAttribPointer(corner,2,gl.FLOAT,false,8,0);
      gl.bindBuffer(gl.ARRAY_BUFFER,this.instances.webGLBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.f32.subarray(0,count*3),gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,12,0);
      gl.enableVertexAttribArray(color);gl.vertexAttribPointer(color,4,gl.UNSIGNED_BYTE,true,12,8);
      extension.vertexAttribDivisorANGLE(position,1);extension.vertexAttribDivisorANGLE(color,1);
      extension.drawArraysInstancedANGLE(gl.TRIANGLES,0,6,count);
      extension.vertexAttribDivisorANGLE(position,0);extension.vertexAttribDivisorANGLE(color,0);
      this.stats.draws++;this.stats.pixels+=count;this.stats.uploaded_bytes+=count*12;return true;
    }
    destroy(){this.renderer.deleteBuffer(this.instances);this.renderer.deleteBuffer(this.corners);super.destroy();}
  }
  return renderer.pipelines.add(KEY,new PixelPipeline());
}
export function pixelSprite(scene){
  const Phaser=globalThis.Phaser,sprite=scene.add.sprite(0,0,'__WHITE').setOrigin(0),nativeRender=sprite.renderWebGL;
  sprite.renderWebGL=function(renderer,src,camera,parentMatrix){
    if(!src.pixelImage)return nativeRender.call(this,renderer,src,camera,parentMatrix);
    camera.addToRenderList(src);
    const matrix=Phaser.GameObjects.GetCalcMatrix(src,camera,parentMatrix).calc,alpha=camera.alpha*src.alpha;
    const pipeline=renderer.pipelines.set(pixelPipeline(renderer));
    if(pipeline.drawPixels(src.pixelImage,src.pixelRegion,matrix,alpha)){renderer.pipelines.setMulti();return;}
    // WebGL devices without instancing still use GPU geometry, never Canvas 2D.
    const multi=renderer.pipelines.setMulti(),tint=Phaser.Renderer.WebGL.Utils.getTintAppendFloatAlpha;
    const {sx=0,sy=0,sw=src.pixelImage.width,sh=src.pixelImage.height}=src.pixelRegion??{},white=src.frame;
    for(const value of src.pixelImage.pixels()){
      const p=src.pixelImage.original?value.original:value;if(!p)continue;
      const px=p.x-(src.pixelImage.offsetX??0),py=p.y-(src.pixelImage.offsetY??0);if(px<sx||py<sy||px>=sx+sw||py>=sy+sh)continue;
      const x=px-sx,y=py-sy,q=matrix.setQuad(x,y,x+1,y+1),color=tint((p.rgb[0]<<16)|(p.rgb[1]<<8)|p.rgb[2],alpha*(p.alpha??1));
      multi.batchQuad(src,...q,white.u0,white.v0,white.u1,white.v1,color,color,color,color,0,white.glTexture);
    }
  };return sprite;
}
