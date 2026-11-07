/**
 * Character and bitmap-text, alpha-aware xBR-lv2. Algorithm adapted from Hyllian's
 * libretro/glsl-shaders/xbr/shaders/xbr-lv2.glsl and DynastyReforge's RGBA variant.
 * Copyright (C) 2011-2016 Hyllian - sergiogdb@gmail.com
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
function samplerChain(n) {
  const lines = ['vec4 T(vec2 uv) {'];
  for (let i = 0; i < n - 1; i += 1) lines.push(`  if (outTexId < ${i}.5) return texture2D(uMainSampler[${i}], uv);`);
  lines.push(`  return texture2D(uMainSampler[${n - 1}], uv);`, '}');
  return lines.join('\n');
}

function buildFrag(n) {
  return `
#define SHADER_NAME SEAL_XBR_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform sampler2D uMainSampler[${n}];


varying vec2 outTexCoord;
varying float outTexId;
varying float outTintEffect;
varying vec4 outTint;
varying vec4 outBounds;
varying vec3 outSource;
varying vec3 outColorEffects;

const float XBR_EQ_THRESHOLD = 15.0;
const float LV2_CF = 2.0;
const vec4 W = vec4(14.352, 28.176, 5.472, 48.0);

const vec4 Ao = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bo = vec4( 1.0,  1.0, -1.0,-1.0 );
const vec4 Co = vec4( 1.5,  0.5, -0.5, 0.5 );
const vec4 Ax = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 Bx = vec4( 0.5,  2.0, -0.5,-2.0 );
const vec4 Cx = vec4( 1.0,  1.0, -0.5, 0.0 );
const vec4 Ay = vec4( 1.0, -1.0, -1.0, 1.0 );
const vec4 By = vec4( 2.0,  0.5, -2.0,-0.5 );
const vec4 Cy = vec4( 2.0,  0.0, -1.0, 0.5 );
const vec4 Ci = vec4(0.25);

vec4 df(vec4 A, vec4 B) { return abs(A - B); }
vec4 diff(vec4 A, vec4 B) { return vec4(notEqual(A, B)); }
vec4 eq(vec4 A, vec4 B) { return step(df(A, B), vec4(XBR_EQ_THRESHOLD)); }
vec4 neq(vec4 A, vec4 B) { return vec4(1.0) - eq(A, B); }
vec4 wd(vec4 a, vec4 b, vec4 c, vec4 d, vec4 e, vec4 f, vec4 g, vec4 h) {
  return df(a,b) + df(a,c) + df(d,e) + df(d,f) + 4.0*df(g,h);
}
float c_df(vec4 c1, vec4 c2) { vec4 d = abs(c1 - c2); return d.r + d.g + d.b + d.a; }

%SAMPLER%

// Treat samples outside this animation frame as transparent, never as atlas neighbours.
vec4 S(vec2 uv) {
  // Stabilize nearest sampling at exact pixel boundaries after atlas offsets
  // and fractional scaling; normalized UV interpolation may land a few ulps low.
  uv = (floor(uv / outSource.xy + vec2(0.0005)) + 0.5) * outSource.xy;
  if (uv.x < outBounds.x || uv.y < outBounds.y || uv.x >= outBounds.z || uv.y >= outBounds.w) return vec4(0.0);
  return T(uv);
}
vec4 xbr() {
  vec2 texSize = 1.0 / outSource.xy;
  vec2 d = 1.0 / texSize;
  float dx = d.x, dy = d.y;
  vec2 tc = outTexCoord;
  // 取到所在原图像素的中心，邻格按整像素偏移
  vec2 sourcePosition = tc * texSize + vec2(0.0005);
  vec2 px0 = (floor(sourcePosition) + 0.5) * d;
  vec2 fp = fract(sourcePosition);

  // 快路：中心与上下左右四邻亮度值都相同（透明底、纯色块）时，xBR 的边缘判断全为 0，
  // 输出就是中心像素本身——先取这 5 个，相同就直接返回，省掉其余 16 次取样。结果与完整计算一致。
  vec4 E  = S(px0);
  vec4 B  = S(px0 + vec2(0.0,-dy)), D = S(px0 + vec2(-dx,0.0));
  vec4 F  = S(px0 + vec2(dx,0.0)),  H = S(px0 + vec2(0.0,dy));
  if (all(equal(E,B)) && all(equal(E,D)) && all(equal(E,F)) && all(equal(E,H))) return E;

  vec4 A1 = S(px0 + vec2(-dx,-2.0*dy)), B1 = S(px0 + vec2(0.0,-2.0*dy)), C1 = S(px0 + vec2(dx,-2.0*dy));
  vec4 A  = S(px0 + vec2(-dx,-dy)),     C  = S(px0 + vec2(dx,-dy));
  vec4 G  = S(px0 + vec2(-dx,dy)),      I  = S(px0 + vec2(dx,dy));
  vec4 G5 = S(px0 + vec2(-dx,2.0*dy)),  H5 = S(px0 + vec2(0.0,2.0*dy)),  I5 = S(px0 + vec2(dx,2.0*dy));
  vec4 A0 = S(px0 + vec2(-2.0*dx,-dy)), D0 = S(px0 + vec2(-2.0*dx,0.0)), G0 = S(px0 + vec2(-2.0*dx,dy));
  vec4 C4 = S(px0 + vec2(2.0*dx,-dy)),  F4 = S(px0 + vec2(2.0*dx,0.0)),  I4 = S(px0 + vec2(2.0*dx,dy));

  vec4 b = vec4(dot(B,W), dot(D,W), dot(H,W), dot(F,W));
  vec4 c = vec4(dot(C,W), dot(A,W), dot(G,W), dot(I,W));
  vec4 dd = b.yzwx;
  vec4 e = vec4(dot(E,W));
  vec4 f = b.wxyz;
  vec4 g = c.zwxy;
  vec4 h = b.zwxy;
  vec4 i = c.wxyz;
  vec4 i4 = vec4(dot(I4,W), dot(C1,W), dot(A0,W), dot(G5,W));
  vec4 i5 = vec4(dot(I5,W), dot(C4,W), dot(A1,W), dot(G0,W));
  vec4 h5 = vec4(dot(H5,W), dot(F4,W), dot(B1,W), dot(D0,W));
  vec4 f4 = h5.yzwx;

  float s = max(outSource.z, 1.0);
  vec4 delta = vec4(1.0 / s);
  vec4 delta_l = vec4(0.5 / s, 1.0 / s, 0.5 / s, 1.0 / s);
  vec4 delta_u = delta_l.yxwz;

  vec4 fx   = Ao*fp.y + Bo*fp.x;
  vec4 fx_l = Ax*fp.y + Bx*fp.x;
  vec4 fx_u = Ay*fp.y + By*fp.x;

  vec4 irlv0 = diff(e,f) * diff(e,h);
  vec4 irlv1 = irlv0 * (neq(f,b) * neq(f,c) + neq(h,dd) * neq(h,g)
    + eq(e,i) * (neq(f,f4) * neq(f,i4) + neq(h,h5) * neq(h,i5)) + eq(e,g) + eq(e,c));
  vec4 irlv2l = diff(e,g) * diff(dd,g);
  vec4 irlv2u = diff(e,c) * diff(b,c);

  vec4 fx45i = clamp((fx   + delta   - Co - Ci) / (2.0*delta  ), 0.0, 1.0);
  vec4 fx45  = clamp((fx   + delta   - Co     ) / (2.0*delta  ), 0.0, 1.0);
  vec4 fx30  = clamp((fx_l + delta_l - Cx     ) / (2.0*delta_l), 0.0, 1.0);
  vec4 fx60  = clamp((fx_u + delta_u - Cy     ) / (2.0*delta_u), 0.0, 1.0);

  vec4 wd1 = wd(e, c, g, i, h5, f4, h, f);
  vec4 wd2 = wd(h, dd, i5, f, i4, b, e, i);

  vec4 edri  = step(wd1, wd2) * irlv0;
  vec4 edr   = step(wd1 + vec4(0.1), wd2) * step(vec4(0.5), irlv1);
  vec4 edr_l = step(LV2_CF*df(f,g), df(h,c)) * irlv2l * edr;
  vec4 edr_u = step(LV2_CF*df(h,c), df(f,g)) * irlv2u * edr;

  fx45  = edr   * fx45;
  fx30  = edr_l * fx30;
  fx60  = edr_u * fx60;
  fx45i = edri  * fx45i;

  vec4 px = step(df(e,f), df(e,h));
  vec4 maximos = max(max(fx30, fx60), max(fx45, fx45i));

  vec4 res1 = E;
  res1 = mix(res1, mix(H, F, px.x), maximos.x);
  res1 = mix(res1, mix(B, D, px.z), maximos.z);
  vec4 res2 = E;
  res2 = mix(res2, mix(F, B, px.y), maximos.y);
  res2 = mix(res2, mix(D, H, px.w), maximos.w);
  return mix(res1, res2, step(c_df(E, res1), c_df(E, res2)));
}

void main () {
  // tintEffect ≥ 4 表示这块要 xBR（物件标记），其余与 Phaser Multi.frag 相同
  bool masked = outTintEffect > 7.5;
  float effect = masked ? outTintEffect - 8.0 : outTintEffect;
  bool useXbr = effect > 3.5;
  effect = useXbr ? effect - 4.0 : effect;
  vec4 texture;
  if (useXbr) texture = xbr();
  else texture = masked ? S(outTexCoord) : T(outTexCoord);
  if (outColorEffects.x > 0.0) {
    float mask = floor(outColorEffects.x / 512.0);
    float amount = mod(outColorEffects.x, 512.0);
    vec3 channels = vec3(mod(mask,2.0),mod(floor(mask/2.0),2.0),mod(floor(mask/4.0),2.0));
    // 52B2FD subtracts packed RGB565 channel units, clamping each at zero.
    vec3 native = max(floor(texture.rgb * vec3(31.0,63.0,31.0) + 0.5) - channels * amount, vec3(0.0));
    texture.rgb = (native * vec3(8.0,4.0,8.0) + floor(native / vec3(4.0,16.0,4.0))) / 255.0;
  }
  if (outColorEffects.y > 0.5) {
    // 551B05/552039 reveal source pixels with a vertical/horizontal scan.
    // The native per-pixel weight starts at minX-y / minX-x and adds eight
    // each render visit. It is independent of the actor's overall opacity.
    float current = max(0.0, floor(outColorEffects.z + 0.0005));
    float target = texture.a * 255.0;
    float reveal = current >= target ? 1.0 : current * 255.0 / (256.0 * max(target, 1.0));
    texture *= reveal;
  }
  vec4 texel = vec4(outTint.bgr * outTint.a, outTint.a);
  vec4 color = texture * texel;
  if (effect == 1.0) {
    color.rgb = mix(texture.rgb, outTint.bgr * outTint.a, texture.a);
  } else if (effect == 2.0) {
    color = texel;
  }
  gl_FragColor = color;
}
`.replace('%SAMPLER%', samplerChain(n));
}

const vertex=`precision highp float;
uniform mat4 uProjectionMatrix;
attribute vec2 inPosition;
attribute vec2 inTexCoord;
attribute float inTexId;
attribute float inTintEffect;
attribute vec4 inTint;
attribute vec4 inBounds;
attribute vec3 inSource;
attribute vec3 inColorEffects;
varying vec2 outTexCoord;
varying float outTexId;
varying float outTintEffect;
varying vec4 outTint;
varying vec4 outBounds;
varying vec3 outSource;
varying vec3 outColorEffects;
void main(){
  gl_Position=uProjectionMatrix*vec4(inPosition,1.0,1.0);
  outTexCoord=inTexCoord;outTexId=inTexId;outTintEffect=inTintEffect;
  outTint=inTint;outBounds=inBounds;outSource=inSource;outColorEffects=inColorEffects;
}`;

export const XBR_PIPELINE='SealCharacters';

// One multi-texture pipeline shared by the main and interface renderers.
// Smoothing metadata travels with vertices without switching pipelines.
export function characterPipeline(Phaser){
  return class CharacterPipeline extends Phaser.Renderer.WebGL.Pipelines.MultiPipeline {
    constructor(game){
      const {FLOAT,UNSIGNED_BYTE:UBYTE}=Phaser.Renderer.WebGL;
      super({game,name:XBR_PIPELINE,vertShader:vertex,fragShader:buildFrag(game.renderer.maxTextures),attributes:[
        {name:'inPosition',size:2,type:FLOAT},{name:'inTexCoord',size:2,type:FLOAT},
        {name:'inTexId',size:1,type:FLOAT},{name:'inTintEffect',size:1,type:FLOAT},
        {name:'inTint',size:4,type:UBYTE,normalized:true},
        {name:'inBounds',size:4,type:FLOAT},{name:'inSource',size:3,type:FLOAT},{name:'inColorEffects',size:3,type:FLOAT}
      ]});
      this.enabled=true;this.sampleMeta=new Float32Array(7);
    }
    // MultiPipeline's native writers assume seven components. All entry points
    // must write our seventeen-component layout, including Graphics triangles.
    // Pack color effects together to retain WebGL's minimum eight attributes.
    batchVert(x,y,u,v,unit,effect,tint,meta=null,colorSubtract=0,appearance=null){
      const f=this.vertexViewF32,b=this.vertexViewU32;
      let at=this.vertexCount*this.currentShader.vertexComponentCount;
      f[at++]=x;f[at++]=y;f[at++]=u;f[at++]=v;f[at++]=unit;f[at++]=effect;b[at++]=tint;
      for(let i=0;i<7;i++)f[at++]=meta?meta[i]:0;
      f[at++]=colorSubtract;
      f[at++]=appearance===null?0:1;f[at++]=appearance??0;
      this.vertexCount++;this.currentBatch.count=this.vertexCount-this.currentBatch.start;
    }
    batchQuad(object,x0,y0,x1,y1,x2,y2,x3,y3,u0,v0,u1,v1,tl,tr,bl,br,effect=0,texture,unit=this.currentUnit){
      const flushed=this.shouldFlush(6);if(flushed)this.flush();
      if(!this.currentBatch)unit=this.setTexture2D(texture);
      let meta=null;
      if(((this.enabled&&(object?.smoothActor||object?.smoothText))||object?.xbrBounds)&&effect!==2){
        const tex=texture??object.frame.glTexture,w=tex.width,h=tex.height;
        const scale=Math.min(Math.hypot(x3-x0,y3-y0)/Math.max(0.001,Math.abs(u1-u0)*w),
          Math.hypot(x1-x0,y1-y0)/Math.max(0.001,Math.abs(v1-v0)*h));
        if(scale>1.01&&this.enabled||object?.xbrBounds){
          const f=object.frame,r=object.xbrBounds??(object.smoothText?{x:0,y:0,width:w,height:h}
            :{x:f.cutX,y:f.cutY,width:f.cutWidth,height:f.cutHeight});
          meta=this.sampleMeta;meta[0]=r.x/w;meta[1]=r.y/h;meta[2]=(r.x+r.width)/w;meta[3]=(r.y+r.height)/h;
          meta[4]=1/w;meta[5]=1/h;meta[6]=scale;
          effect+=this.enabled&&scale>1.01&&(object?.smoothActor||object?.smoothText)?4:8;
        }
      }
      const colorSubtract=object?.nativeColorSubtract??0;
      const scan=object?.nativeAppearance;
      this.batchVert(x0,y0,u0,v0,unit,effect,tl,meta,colorSubtract,scan?.[0]??null);this.batchVert(x1,y1,u0,v1,unit,effect,bl,meta,colorSubtract,scan?.[1]??null);
      this.batchVert(x2,y2,u1,v1,unit,effect,br,meta,colorSubtract,scan?.[2]??null);this.batchVert(x0,y0,u0,v0,unit,effect,tl,meta,colorSubtract,scan?.[0]??null);
      this.batchVert(x2,y2,u1,v1,unit,effect,br,meta,colorSubtract,scan?.[2]??null);this.batchVert(x3,y3,u1,v0,unit,effect,tr,meta,colorSubtract,scan?.[3]??null);
      this.onBatch(object);return flushed;
    }
    batchTri(object,x0,y0,x1,y1,x2,y2,u0,v0,u1,v1,t0,t1,t2,effect,texture,unit=this.currentUnit){
      const flushed=this.shouldFlush(3);if(flushed)this.flush();
      if(!this.currentBatch)unit=this.setTexture2D(texture);
      this.batchVert(x0,y0,u0,v0,unit,effect,t0);this.batchVert(x1,y1,u0,v1,unit,effect,t1);
      this.batchVert(x2,y2,u1,v1,unit,effect,t2);this.onBatch(object);return flushed;
    }
  };
}
