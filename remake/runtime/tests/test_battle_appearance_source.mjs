// Original CHR bytes and retained native instructions; synthetic occupied-pixel
// scanner only. These checks require source inputs and do not use runtime cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {AppearanceParticles} from '../web/appearance_particles.mjs';
import {deathVisualRandom} from '../web/death_particles.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

test('018 source entry5 retains its exact command7 mode2 CHR record',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../web/data/battle_lifecycle.json',import.meta.url)));
  const role=manifest.roles.find(row=>row.id==='018'),selected=role.skills.find(row=>row.chr_skill_index===5);
  assert.deepEqual(role.entry_skill_indices,[5]);assert.equal(selected.timeline.length,1);
  const step=selected.timeline[0],source=await readFile(new URL('../../../'+step.source.path,import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'),step.source.sha256);
  assert.equal(source.subarray(step.source.offset,step.source.offset+step.source.bytes).toString('hex'),step.raw_hex);
  assert.equal(step.command_raw,7);assert.equal(step.mode_raw_0x47,2);assert.equal(Buffer.from(step.raw_hex,'hex')[0x47],2);
});

test('appearance2 column initialization, every particle step and completion match original550A28 instructions',async()=>{
  const proof=JSON.parse(await readFile(new URL('./fixtures/battle_appearance2_native.json',import.meta.url)));
  assert.equal(createHash('sha256').update(await readFile(new URL('../../../GAME.exe',import.meta.url))).digest('hex'),proof.game_sha256);
  const header=0x30000000,records=0x31000000,columns=0x32000000,screenWidth=8;
  const source=[{x:0,y:20,rgb:[255,255,255]},{x:1,y:0,rgb:[80,120,160]},{x:7,y:15,rgb:[255,0,0]}];
  // Only the occupied-pixel scanner550270/initializer550975 is a boundary
  // fixture. The retained550A28 assembly owns columns, motion and return0.
  class AppearanceOracle extends NativeAssemblyOracle{
    external(target){
      if(target!==0x550270)return super.external(target);
      this.write(header+0xc9,source.length);
      source.forEach((p,index)=>{
        const at=records+index*0x21;for(let byte=0;byte<0x21;byte++)this.write(at+byte,0,1);
        this.write(at,p.x);this.write(at+4,p.y);this.write(at+0x19,this.rng()%30+5);this.write(at+0x14,0xffff);
      });
    }
  }
  for(const seed of ['even-odd','long-life','short-life']){
    const oracle=new AppearanceOracle({[proof.entry]:proof.assembly},[],deathVisualRandom(seed));
    for(const [at,value,bytes]of [[0x5659104,1,4],[0x5658ff8,columns,4],[0x67c3a0,screenWidth,2],[0x67c3a2,480,2],
      [header+0x47,64,2],[header+0x49,64,2],[header+0x4b,1,4],[header+0xdd,records,4]])oracle.write(at,value,bytes);
    const effect=new AppearanceParticles({mode:2,pixels:source,screenWidth,random:deathVisualRandom(seed)});
    let calls=0,active=true;
    for(;active&&calls<100;calls++){
      const elapsed=Math.floor(calls*(1000/60)/60+1e-7);if(calls&&elapsed===0)effect.reset();
      const result=oracle.run(Number(proof.entry),[header,0,256,64,64,0,elapsed]);active=effect.step();
      assert.equal(active,Boolean(result.eax),`${seed} render${calls}`);
      effect.particles.forEach((p,index)=>{
        const at=records+index*0x21;
        assert.deepEqual({x:p.x,y:p.y,speed:p.speed,life:p.life,age:p.age},
          {x:oracle.read(at),y:oracle.read(at+4),speed:oracle.read(at+0x10),life:oracle.read(at+0x19),age:oracle.read(at+0x1d)},`${seed} render${calls} pixel${index}`);
      });
    }
    assert.ok(calls<100);assert.ok(effect.particles.every(p=>p.y===0));
  }
});
