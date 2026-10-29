import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {MovementMap,MAP_FOOTPRINT} from '../web/core/movement.mjs';
import {CollisionFeedback,nativeMapMovement} from '../web/core/map_locomotion.mjs';
import {mapPresentation} from '../web/core/map_presentation.mjs';
import {SpritePose} from '../web/phaser/components/sprite_pose.mjs';
import {drawMapSprite} from '../web/map_sprite.mjs';
import {worldMapEntry} from '../web/core/map_connections.mjs';

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

test('source armor-shop diagonal approach keeps its ray while retaining the original contact endpoint and tangent slide',()=>{
  const data=JSON.parse(readFileSync(new URL('../web/data/maps/m01063.json',import.meta.url),'utf8'));
  const raw=readFileSync(new URL('../../../Map/m01063.dat',import.meta.url)),width=raw.readUInt32LE(0x146);
  assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
  for(const [x,y,value]of [[22,14,0],[23,15,0],[22,15,1],[23,14,1]])
    assert.equal(raw[0x172+(y*width+x)*64+0x20],value);
  const map=new MovementMap(data.movement),result=map.moveAndSlide(360,232,80,80);
  near(result.x,379.99999);near(result.y,268.99999);
  assert.equal(result.segments[0].dx,result.segments[0].dy,'skin must not tilt the source diagonal approach ray');
  assert.equal(map.at(368,240).blocked,false);
});

test('real forest point contacts accept off-centre continuous diagonal input at 30/60/120Hz in both directions',()=>{
  const data=JSON.parse(readFileSync(new URL('../web/data/maps/m70060.json',import.meta.url),'utf8'));
  const raw=readFileSync(new URL('../../../Map/m70060.dat',import.meta.url)),width=raw.readUInt32LE(0x146);
  assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
  const map=new MovementMap(data.movement);
  for(const [from,to]of [[[23,16],[22,15]],[[22,15],[23,16]]]){
    assert.equal(raw[0x172+(from[1]*width+from[0])*64+0x20],0);
    assert.equal(raw[0x172+(to[1]*width+to[0])*64+0x20],0);
    for(const hz of [30,60,120])for(const offset of [[0,0],[3,-2],[-3,2],[2.7,4.1]]){
      let at={x:from[0]*16+8+offset[0],y:from[1]*16+8+offset[1]},passed=false;
      const dx=Math.sign(to[0]-from[0]),dy=Math.sign(to[1]-from[1]);
      for(let frame=0;frame<hz;frame++){
        at=map.moveAndSlide(at.x,at.y,dx*129/Math.SQRT2/hz,dy*129/Math.SQRT2/hz);
        assert.notEqual(map.at(at.x,at.y).reason,'terrain');
        if(map.at(at.x,at.y).x===to[0]&&map.at(at.x,at.y).y===to[1]){passed=true;break;}
      }
      assert.ok(passed,`${hz}Hz offset${offset}: ${from} -> ${to}`);
    }
  }
});

test('continuous small steps traverse the forest/lake routes and armor-shop entry to its diagonal passage without altering source terrain',()=>{
  const read=name=>JSON.parse(readFileSync(new URL('../web/data/'+name+'.json',import.meta.url),'utf8'));
  const resources=read('chapter_map_resources'),story=read('chapter_story'),definition=read('runtime_content'),worldMap=read('world_map');
  const physical=(id,target)=>resources.exits_by_map[id].find(row=>row.target_map===target);
  const lakeEntry=worldMapEntry({},worldMap.areas[0].destinations[2],story);
  const firstLake=worldMapEntry({},{map_id:'M71011',entry_marker:1,sort_code:0},story);
  const links=[
    {id:'M70060',start:physical('M70040','M70060').entry,trigger:2},
    {id:'M71014',start:lakeEntry,trigger:2},
    {id:'M71011',start:firstLake,trigger:physical('M71011','M71012').id},
    {id:'M71012',start:physical('M71011','M71012').entry,trigger:physical('M71012','M71012-1').id},
    {id:'M71012-1',start:physical('M71012','M71012-1').entry,trigger:physical('M71012-1','M71012-2').id},
    {id:'M71012-2',start:physical('M71012-1','M71012-2').entry,trigger:physical('M71012-2','M71013').id},
    {id:'M71013',start:physical('M71012-2','M71013').entry,trigger:1},
    {id:'M01063',start:physical('M01060','M01063').entry,target_cell:{x:22,y:14}}
  ];
  for(const link of links){
    const data=read('maps/'+link.id.toLowerCase()),raw=readFileSync(new URL(`../../../Map/${link.id.toLowerCase()}.dat`,import.meta.url));
    assert.equal(createHash('sha256').update(raw).digest('hex'),data.movement.source_sha256);
    const sourceRows=[...data.movement.terrain_rows],ready=new Set([...(resources.exits_by_map[link.id]??[]).map(row=>row.id),...(definition.maps[link.id]?.triggers??[])]);
    const movement={...nativeMapMovement(data.movement,story.maps[link.id]),triggers:data.movement.triggers.map(row=>({...row,path_gate:!ready.has(row.id)}))};
    const map=new MovementMap(movement),npcs=(resources.npcs_by_map[link.id]??[]).filter(row=>!row.hidden),obstacles=map.actorObstacles(npcs);
    const goal=new Set(link.target_cell?[`${link.target_cell.x},${link.target_cell.y}`]:data.movement.triggers.filter(row=>row.id===link.trigger).map(row=>`${row.x},${row.y}`));
    const origin={x:Math.floor(link.start.x/16),y:Math.floor(link.start.y/16)},queue=[origin],previous=new Map([[`${origin.x},${origin.y}`,null]]);let found;
    for(let cursor=0;cursor<queue.length;cursor++){
      const at=queue[cursor];if(goal.has(`${at.x},${at.y}`)){found=at;break;}
      for(const [dx,dy]of [[0,-1],[1,0],[0,1],[-1,0],[-1,-1],[1,-1],[1,1],[-1,1]]){
        const x=at.x+dx,y=at.y+dy,key=`${x},${y}`,cell=map.cell(x,y);
        if(previous.has(key)||cell.blocked||cell.trigger&&cell.trigger.id!==link.trigger&&!(definition.maps[link.id]?.triggers??[]).includes(cell.trigger.id))continue;
        if(npcs.some(npc=>Math.abs(npc.x-(x*16+8))<14&&Math.abs(npc.y-(y*16+8))<12))continue;
        previous.set(key,at);queue.push({x,y});
      }
    }
    assert.ok(found,`${link.id} original target has no source path`);const path=[];
    while(found){path.push(found);found=previous.get(`${found.x},${found.y}`);}path.reverse();
    // Advance only through continuous keyboard-sized vectors. No teleport,
    // tile-centre snap or world/terrain mutation is used between waypoints.
    for(const hz of [30,60,120])for(const speed of [129,250]){
      let at={x:link.start.x,y:link.start.y},frames=0;
      for(const target of path.slice(1)){
        let attempts=0;
        while(map.at(at.x,at.y).x!==target.x||map.at(at.x,at.y).y!==target.y){
          assert.ok(++attempts<hz*3,`${link.id} ${hz}Hz speed${speed} stuck at${at.x},${at.y} toward${target.x},${target.y}`);
          const dx=Math.sign(target.x*16+8-at.x),dy=Math.sign(target.y*16+8-at.y),length=Math.hypot(dx,dy);
          at=map.moveAndSlide(at.x,at.y,dx/length*speed/hz,dy/length*speed/hz,{obstacles});frames++;
          assert.notEqual(map.at(at.x,at.y).reason,'terrain',link.id);
        }
      }
      if(link.target_cell)assert.deepEqual({x:map.at(at.x,at.y).x,y:map.at(at.x,at.y).y},link.target_cell,`${link.id} target at ${hz}Hz`);
      else assert.equal(map.at(at.x,at.y).trigger?.id,link.trigger,`${link.id} target at ${hz}Hz`);
      assert.ok(frames>0);
    }
    assert.deepEqual(data.movement.terrain_rows,sourceRows);
    for(let y=0;y<map.height;y++)for(let x=0;x<map.width;x++)assert.equal(Number(sourceRows[y][x]),raw[0x172+(y*map.width+x)*64+0x20],link.id);
  }
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
