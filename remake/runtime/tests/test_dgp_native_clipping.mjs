// Complete original software RLE blitter, with its native geometry height.
// The source DGP struct, pointer tables, locked16-bit framebuffer and zeroE1
// color-update branch are explicit inputs; no original OS/window is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';
const proof=JSON.parse(await readFile(new URL('./fixtures/dgp_geometry_blit_native.json',import.meta.url),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const root=new URL('../../../',import.meta.url),source=await readFile(new URL(proof.source_dgp.path,root));
assert.equal(hash(source),proof.source_dgp.sha256);
const geometry=67+source[2]*172,width=source.readUInt16LE(geometry),height=source.readUInt16LE(geometry+2),count=source.readUInt32LE(geometry+4);
const frameTable=geometry+42+48+source[geometry+13]*18,payload=source.readUInt32LE(geometry+32),payloadBytes=source.readUInt32LE(geometry+36);
class BlitOracle extends NativeAssemblyOracle{
  constructor(){super({'0x52ae7f':proof.blit.normalized_result.trim().split(/\r?\n/)},[],()=>assert.fail('blitting does not draw RNG'));this.coverage=new Set();this.sourceReads=[];}
  read(address,n=4){if(this.observe&&address>=this.sourceBase&&address<this.sourceBase+payloadBytes)this.sourceReads.push({address,n});return super.read(address,n);}
  write(address,value,n=4){if(this.observe&&address>=this.destination&&address<this.destination+width*height*2)for(let offset=0;offset<n;offset++)this.coverage.add(address+offset);super.write(address,value,n);}
  external(target){if(target===0x55c83b){assert.equal(this.read(this.read(this.reg.ESP)+0xe1,1),0,'the actual loader starts this color-update gate at0');return;}return super.external(target);}
}
function raster(frame){
  const oracle=new BlitOracle();oracle.destination=0x40000000;oracle.sourceBase=0x30010000;
  const pointers=0x30000000,struct=Buffer.alloc(0xec);source.copy(struct,0,0,67);source.copy(struct,0x47,geometry,geometry+42);source.copy(struct,0x71,geometry+42,geometry+42+48);
  struct.writeUInt32LE(pointers,0xb1);assert.equal(struct[0xe1],0);assert.equal(struct[5],0);
  oracle.write(0x56590fc,oracle.destination);oracle.write(0x5659104,1);oracle.write(0x5659070,width);oracle.write(0x5659078,height);oracle.write(0x5659108,width*2);
  for(let y=0;y<height;y++)oracle.write(0x5656e80+y*4,y*width*2);
  for(let f=0;f<count;f++)oracle.write(pointers+f*4,oracle.sourceBase+source.readUInt32LE(frameTable+f*20+12));
  for(let i=0;i<payloadBytes;i++)oracle.write(oracle.sourceBase+i,source[payload+i],1);
  oracle.observe=true;
  const result=oracle.run(0x52ae7f,[0,...Array.from({length:struct.length/4},(_,index)=>struct.readInt32LE(index*4)),0,0,frame]);
  assert.equal(result.eax&255,1);assert.deepEqual(result.rng_calls,[]);
  const rgba=Buffer.alloc(width*height*4);let occupied=0;
  for(let pixel=0;pixel<width*height;pixel++)if(oracle.coverage.has(oracle.destination+pixel*2)){
    assert.ok(oracle.coverage.has(oracle.destination+pixel*2+1));const value=oracle.read(oracle.destination+pixel*2,2),r=value>>>11,g=(value>>>5)&63,b=value&31;
    rgba.set([(r<<3)|(r>>>2),(g<<2)|(g>>>4),(b<<3)|(b>>>2),255],pixel*4);occupied++;
  }
  const frameOffset=source.readUInt32LE(frameTable+frame*20+12),readEnd=Math.max(...oracle.sourceReads.map(row=>row.address+row.n))-oracle.sourceBase-frameOffset;
  return {frame,width,height,occupied,readEnd,rgba_sha256:hash(rgba),rgba_base64:rgba.toString('base64'),steps:result.steps};
}

test('native52AE7F paints only175 source geometry rows of M01050 object004, without reading its25 retained rows',async()=>{
  assert.equal(hash(await readFile(new URL('GAME.exe',root))),proof.game_sha256);assert.deepEqual([width,height,count],[173,175,2]);
  const frames=[0,1].map(raster);assert.deepEqual(frames.map(frame=>frame.readEnd),[22460,40718]);
  assert.equal(frames[0].readEnd+5576,source.readUInt32LE(frameTable+16));
  if(process.env.SEVENTH_SEAL_DGP_PIXEL_OUTPUT)await writeFile(process.env.SEVENTH_SEAL_DGP_PIXEL_OUTPUT,JSON.stringify(frames));
});
