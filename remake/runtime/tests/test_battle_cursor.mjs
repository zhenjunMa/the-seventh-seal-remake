import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {battleActorPositions} from '../web/core/battle_layout.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

const read=path=>JSON.parse(readFileSync(new URL(path,import.meta.url),'utf8'));
const native=read('./fixtures/battle_cursor_native.json'),manifest=read('../web/data/battle_ui.json');
const meta=read('../web/data/party_battle_view.json');
function nativePoint(resource,height,position,actorIndex,queueIndex,side){
  const finished=Symbol('cursor call');let result;
  class Oracle extends NativeAssemblyOracle{
    external(target){assert.equal(target,0x5189f0);result=[this.read(this.reg.ESP),this.read(this.reg.ESP+4),this.read(this.reg.ESP+8)];throw finished;}
  }
  const oracle=new Oracle({branch:native.functions[side]},[],()=>0);
  oracle.reg.EBP=0x20000000;oracle.write(oracle.reg.EBP-8,actorIndex);oracle.write(oracle.reg.EBP-12,queueIndex);
  oracle.write(0x521a770+actorIndex*0x30274,Number(resource));
  oracle.write(0x52193fd+(Number(resource)-1)*0xeb,height);
  oracle.write(0x55f1300,0x30000000);
  oracle.write(0x30000000+queueIndex*0x1d+0xd,position[0]);oracle.write(0x30000000+queueIndex*0x1d+0x11,position[1]);
  try{oracle.run(side==='player'?0x516af5:0x516b43,[]);assert.fail('cursor call missing');}catch(error){if(error!==finished)throw error;}
  return result;
}
function drawCursor(actors,selected,positions,{targetId=null}={}){
  const calls=[],ctx={clearRect(){}};
  const view=Object.create(BattleMenuView.prototype);
  Object.assign(view,{manifest,snapshot:{actors,player_id:selected},stage:targetId?'target':'actors',targetId,ctx,glowCtx:ctx,
    menus:new Map(manifest.menus.map(m=>[m.id,m])),images:new Map(),ballCache:new Map(),
    getCursorHeight:id=>meta.roles.find(r=>r.id===(actors.find(a=>a.id===id).resource_id??id)).cursor_height_raw,
    ready:()=>actors.filter(a=>a.side==='player').map(a=>a.id),syncTargets(){},image(){},text(){},drawWheel(){},
    asset:(id,frame,x,y)=>{if(id.startsWith('fight_cursor'))calls.push({id,x,y});}});
  view.draw(0,positions);assert.equal(calls.length,1);return calls[0];
}
const player=(id,slot)=>({id,side:'player',party_slot_zero_based:slot,hp:{current:1,maximum:1},mp:{current:0,maximum:0}});

test('full-gauge actor switches use each resource height and the native cursor branch across formation gaps and party orders',()=>{
  const ids=meta.roles.filter(r=>Number(r.id)<=6).map(r=>r.id);
  for(let offset=0;offset<ids.length;offset++)for(let gap=0;gap<4;gap++){
    const actors=Array.from({length:3},(_,i)=>player(ids[(offset+i)%ids.length],(gap+i)%4)).reverse(),positions=battleActorPositions(actors);
    actors.forEach((actor,index)=>{
      const role=meta.roles.find(r=>r.id===actor.id),point=nativePoint(role.id,role.cursor_height_raw,positions[actor.id],index,7-index,'player');
      const cursor=drawCursor(actors,actor.id,positions),anchor=manifest.assets.fight_cursor1.anchor_raw;
      assert.equal(point[2],0);assert.deepEqual([cursor.x,cursor.y],[point[0]-anchor[0],point[1]-anchor[1]]);
    });
  }
});

test('target cursors resolve instance resource IDs and follow moving or airborne screen positions',()=>{
  for(const role of meta.roles.filter(r=>Number(r.id)>6)){
    const actors=[player('001',0),{id:'enemy-instance',resource_id:role.id,side:'enemy'}];
    for(const position of [[174,289],[300,160],[120,-40]]){
      const point=nativePoint(role.id,role.cursor_height_raw,position,5,2,'target');
      const cursor=drawCursor(actors,'001',{'001':[460,280],'enemy-instance':position},{targetId:'enemy-instance'}),anchor=manifest.assets.fight_cursor2.anchor_raw;
      assert.equal(point[2],1);assert.deepEqual([cursor.x,cursor.y],[point[0]-anchor[0],point[1]-anchor[1]]);
    }
  }
});
