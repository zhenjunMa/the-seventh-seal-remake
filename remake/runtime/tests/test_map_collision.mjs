import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MovementMap,MAP_FOOTPRINT} from '../web/core/movement.mjs';
import {CollisionFeedback,nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {mapPresentation} from '../web/core/map_presentation.mjs';
import {SpritePose} from '../web/phaser/components/sprite_pose.mjs';
import {drawMapSprite} from '../web/map_sprite.mjs';

const fixture=(rows,extra={})=>new MovementMap({schema:'seventh-seal-map-movement',version:1,
  width:rows[0].length,height:rows.length,cell_size:16,terrain_rows:rows,triggers:[],...extra});
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-4,`${actual} != ${expected}`);

test('footprint stops high speed travel on either side of a thin wall without crossing',()=>{
  const map=fixture(Array(10).fill('0001000'));
  const right=map.moveAndSlide(24,40,2000,0),left=map.moveAndSlide(88,40,-2000,0);
  near(right.x,48-MAP_FOOTPRINT.halfWidth);near(left.x,64+MAP_FOOTPRINT.halfWidth);
  assert.ok(right.blocked&&left.blocked);near(right.y,40);near(left.y,40);
});

test('a diagonal contact preserves the requested tangent displacement with no automatic acceleration',()=>{
  const map=fixture(Array(10).fill('0001000'));
  const p=map.moveAndSlide(24,40,40,30);
  near(p.x,44);near(p.y,70);assert.ok(p.moved&&p.blocked);
  assert.ok(p.segments.length>=2);assert.equal(p.hit.reason,'terrain');
});

test('sliding past adjoining tile seams stays stable and does not consume lateral travel',()=>{
  const map=fixture(Array(60).fill('0001000'));let p={x:40,y:40};
  for(let n=0;n<200;n++){
    const next=map.moveAndSlide(p.x,p.y,3,3);
    assert.ok(next.x>=p.x-1e-8&&next.x<=44);p=next;
  }
  near(p.x,44);near(p.y,640);
});

test('inside corners stop both components, stay still when held, and permit immediate departure',()=>{
  const map=fixture(['00010','00010','00010','11111','00000']);
  let p=map.moveAndSlide(24,24,80,80);near(p.x,44);near(p.y,45);
  for(let i=0;i<120;i++){
    const next=map.moveAndSlide(p.x,p.y,8,8);near(next.x,p.x);near(next.y,p.y);assert.equal(next.moved,false);p=next;
  }
  const back=map.moveAndSlide(p.x,p.y,-8,-8);assert.ok(back.moved);near(back.x,p.x-8);near(back.y,p.y-8);
});

test('source-open diagonal destinations remain connected while closed targets, NPCs and unknown gates still block',()=>{
  const map=fixture(['010','100','000']),p=map.moveAndSlide(8,8,32,32);
  near(p.x,40);near(p.y,40);assert.equal(map.at(p.x,p.y).blocked,false);
  assert.deepEqual(MAP_FOOTPRINT,{halfWidth:4,halfHeight:3});
  const closed=fixture(['011','110','000']),blocked=closed.moveAndSlide(8,8,32,32);
  assert.ok(blocked.x<16&&blocked.y<16&&blocked.blocked);
  const gated=fixture(['010','100','000'],{triggers:[{id:1,x:1,y:1,path_gate:true}]}),denied=gated.moveAndSlide(8,8,32,32);
  assert.ok(denied.x<16&&denied.y<16&&denied.blocked);
  const npc=map.moveAndSlide(8,8,32,32,{obstacles:map.actorObstacles([{id:'guard',x:16,y:16}])});
  assert.equal(npc.hit.reason,'actor');assert.ok(npc.x<16||npc.y<16);
});

test('footprint fits a one-tile corridor and bounds without blocking tangent movement',()=>{
  const map=fixture(Array(12).fill('101'));
  const p=map.moveAndSlide(24,8,0,160);near(p.x,24);near(p.y,168);assert.equal(p.blocked,false);
  const edge=map.moveAndSlide(24,168,0,1000);near(edge.y,192-MAP_FOOTPRINT.halfHeight);
});

test('legacy positions at tile edges may move out of initial foot overlap, never deeper into it',()=>{
  const map=fixture(Array(5).fill('1000'));
  const blocked=map.moveAndSlide(16,32,-10,0);near(blocked.x,16);assert.ok(blocked.blocked);
  const tangent=map.moveAndSlide(16,32,0,16);near(tangent.y,48);
  const away=map.moveAndSlide(16,32,16,0);near(away.x,32);assert.equal(away.blocked,false);
});

test('native terrain landing can escape its one source tile but cannot re-enter or traverse another wall',()=>{
  const map=fixture(['00000','01100','00000'],{native_entry_cells:[{x:1,y:1}]});
  const out=map.moveAndSlide(24,24,-20,0);assert.ok(out.x<16);assert.equal(map.at(out.x,out.y).blocked,false);
  const back=map.moveAndSlide(out.x,out.y,24,0);assert.ok(back.x<12.001&&back.blocked);
  const other=map.moveAndSlide(24,24,60,0);assert.ok(other.x<32&&other.blocked);
});

test('unimplemented transition gate stops the logical centre and preserves its descriptor',()=>{
  const map=fixture(['00000']);map.triggers.set(2,{x:2,y:0,id:3,path_gate:true});
  const p=map.moveAndSlide(8,8,60,0);near(p.x,32);assert.equal(p.hit.reason,'transition');assert.equal(p.hit.trigger.id,3);
});

test('NPC collision is swept, allows sliding, and leaves the obstacle position intact',()=>{
  const map=fixture(Array(20).fill('0'.repeat(20))),npc={id:'npc',x:80,y:80};
  const obstacles=map.actorObstacles([npc]);
  const p=map.moveAndSlide(40,80,1000,0,{obstacles});near(p.x,72);assert.equal(p.hit.reason,'actor');
  const side=map.moveAndSlide(p.x,p.y,20,20,{obstacles});assert.ok(side.y>p.y);assert.deepEqual(npc,{id:'npc',x:80,y:80});
});

test('real sweeps preserve logical terrain and bound foot overlap to actual source diagonal contact corners',()=>{
  const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
  const catalog=read('catalog');let sweeps=0,ordinaryFeet=0,contactFeet=0;
  function sourceContact(map,x,y){
    const cell=map.at(x,y),cx=cell.x,cy=cell.y,size=map.cellSize,limit=MAP_FOOTPRINT.halfWidth+MAP_FOOTPRINT.halfHeight+1e-4;
    for(const [sx,sy]of [[-1,-1],[1,-1],[1,1],[-1,1]]){
      const px=(cx+Number(sx>0))*size,py=(cy+Number(sy>0))*size;
      if(Math.abs(x-px)>limit||Math.abs(y-py)>limit)continue;
      if(map.rows[cy+sy]?.[cx+sx]!=='1'||map.cell(cx+sx,cy).blocked||map.cell(cx,cy+sy).blocked)continue;
      return true;
    }
    return false;
  }
  for(const entry of catalog.maps){
    const map=new MovementMap(read('maps/'+entry.id.toLowerCase()).movement),starts=[];
    // Spread probes through the source grid instead of checking only a spawn.
    const open=[];for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++)if(!map.cell(x,y).blocked)open.push({x:x*16+8,y:y*16+8});
    for(let i=0;i<24&&i<open.length;i++)starts.push(open[Math.floor(i*open.length/24)]);
    for(const from of starts)for(const [dx,dy] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const result=map.moveAndSlide(from.x,from.y,dx*80,dy*80);sweeps++;
      for(const segment of result.segments){
        const count=Math.ceil(Math.hypot(segment.dx,segment.dy)/2);
        for(let k=0;k<=count;k++){
          const px=segment.x+segment.dx*k/count,py=segment.y+segment.dy*k/count;
          assert.notEqual(map.at(px,py).reason,'terrain',`${entry.id} logical centre ${px},${py}`);
          for(const fx of [-4,4])for(const fy of [-3,3]){
            const x=px+fx,y=py+fy,hit=map.at(x,y);
            if(hit.reason==='terrain'){assert.ok(sourceContact(map,x,y),`${entry.id} non-contact foot overlap ${x},${y}`);contactFeet++;}
            else ordinaryFeet++;
            assert.notEqual(hit.reason,'bounds',entry.id);
          }
        }
      }
    }
  }
  assert.ok(sweeps>5000);assert.ok(ordinaryFeet>10000);assert.ok(contactFeet>0);
});

test('real white-forest terrain marker remains escapable with the new footprint',()=>{
  const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
  const table=read('chapter_story').maps.M70010,data=read('maps/m70010').movement;
  const map=new MovementMap(nativeMapMovement(data,table));assert.equal(map.at(288,288).reason,'terrain');
  const exits=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]
    .map(([dx,dy])=>map.moveAndSlide(288,288,dx*24,dy*24));
  assert.ok(exits.some(p=>p.moved&&!map.at(p.x,p.y).blocked),'source marker must have an escape');
});

test('collision recoil triggers once per normal, blends new walls, and finishes after release',()=>{
  const feedback=new CollisionFeedback(),contact={contacts:[{nx:-1,ny:0}]};
  assert.ok(feedback.advance(contact,{dx:1,running:true,elapsedMs:16}).x<0,'short taps get an immediate response');
  const peak=feedback.advance(contact,{dx:1,running:true,elapsedMs:64});near(peak.x,-2.5);
  assert.ok(feedback.advance(null,{elapsedMs:16}).x<0,'release lets the envelope finish');
  feedback.advance(contact,{dx:1,running:true,elapsedMs:16});
  const corner=feedback.advance({contacts:[{nx:-1,ny:0},{nx:0,ny:-1}]},{dx:1,dy:1,running:true,elapsedMs:16});
  assert.ok(corner.x<0&&corner.y<0,'a newly blocked direction responds while the first contact is held');
  for(let i=0;i<120;i++)feedback.advance(contact,{dx:1,running:true,elapsedMs:16});
  near(feedback.advance(contact,{dx:1,running:true,elapsedMs:16}).x,0);
  feedback.advance(null,{elapsedMs:16});feedback.advance(contact,{dx:1,running:true,elapsedMs:16});
  assert.ok(feedback.advance(contact,{dx:1,running:true,elapsedMs:40}).x<0);
  feedback.reset();near(feedback.advance(null,{elapsedMs:16}).x,0);
});

test('Canvas and Phaser apply recoil to body/light only, keeping shadow and world anchor fixed',()=>{
  const calls=[],ctx={drawImage(...a){calls.push(a);},save(){},restore(){}};
  drawMapSprite(ctx,'body','light',0,0,16,16,100,200,'shadow',null,{x:-2,y:1});
  assert.deepEqual(calls.map(a=>[a[0],a[5],a[6]]),[['shadow',100,200],['body',98,201],['light',98,201]]);
  const sprites=[],scene={add:{sprite(){const s={};for(const method of ['setOrigin','setBlendMode','setVisible','setPosition','setTexture','setDisplaySize'])
    s[method]=(...args)=>{s[method+'Args']=args;return s;};sprites.push(s);return s;}}};
  const pose=new SpritePose(scene,{add(){}},{region:()=>({key:'sheet',frame:0})});
  pose.apply({image:{width:16,height:16},light:{},shadow:{},body_offset:{x:-2,y:1}});
  assert.deepEqual(sprites.map(s=>s.setPositionArgs),[[0,0],[-2,1],[-2,1]]);
  pose.apply({image:{width:16,height:16}});assert.deepEqual(pose.body.setPositionArgs,[0,0]);
  const world={location:{x:10,y:20,direction:0},object_states:{}},before=structuredClone(world);
  const entry=mapPresentation({scene:{data:{id:'map'},objects:[],npcs:[]},world,
    role:{frame_width:16,frame_height:16,map_draw_offset:{x:0,y:0}},action:{bitmap:{}},view:{collisionFeedback:{x:-2,y:1}}})[0];
  assert.deepEqual(entry.pose.body_offset,{x:-2,y:1});assert.equal(entry.sort_y,52);assert.deepEqual(world,before);
});
