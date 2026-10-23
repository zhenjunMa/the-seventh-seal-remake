import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';
import {NativeAssemblyOracle} from './native_assembly_oracle.mjs';

const manifest=JSON.parse(readFileSync(new URL('../web/data/battle_ui.json',import.meta.url),'utf8'));
const wheel=manifest.menus.find(menu=>menu.id==='game002d');
const keys=['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'];
const names=['top','upper left','lower left','bottom','lower right','upper right','center'];
const native=JSON.parse(readFileSync(new URL('./fixtures/battle_wheel_native.json',import.meta.url),'utf8'));

function fixture(){
  const cues=[],view=Object.create(BattleMenuView.prototype);
  Object.assign(view,{stage:'wheel',focusIndex:0,epoch:0,root:{dataset:{}},onStage(){},memory:new Map(),snapshot:{player_id:'001'},cue:name=>cues.push(name)});
  view.wheelButtons=names.map((_,index)=>{
    const {rect}=wheel.widgets.find(widget=>widget.name===String(index+1).padStart(3,'0'));
    return {hidden:false,style:{left:(490+rect.left)+'px',top:(340+rect.top)+'px',width:(rect.right-rect.left+1)+'px',height:(rect.bottom-rect.top+1)+'px'},
      focus(){view.activeSlot=index;view.focusIndex=index;view.remember();}};
  });
  return {view,cues};
}

test('battle wheel follows the original seven-slot directional map and stops at edges',()=>{
  const expected=[
    [0,6,1,5], // top
    [0,2,1,6], // upper left
    [1,3,2,3], // lower left
    [6,3,2,4], // bottom
    [5,3,3,4], // lower right
    [0,4,6,5], // upper right
    [0,3,1,5]  // center
  ];
  for(let slot=0;slot<names.length;slot++)for(let direction=0;direction<keys.length;direction++){
    const {view,cues}=fixture();view.focusIndex=slot;view.activeSlot=slot;
    assert.equal(view.key(keys[direction]),true);
    const next=expected[slot][direction],label=`${names[slot]} ${keys[direction]}`;
    assert.equal(view.focusIndex,next,label);assert.equal(view.activeSlot,next,label);
    assert.deepEqual(cues,next===slot?[]:['menuSelect'],label);
    if(next!==slot)assert.equal(view.memory.get('001').wheel,next,label);
  }
});

test('every wheel direction agrees with the retained original x86 instructions in both native menu modes',()=>{
  class WheelOracle extends NativeAssemblyOracle{
    external(target){
      if(target===0x4011e0){this.reg.EAX=0;return;} // Resolve selected party member to actor 0.
      if(target===0x401e88)return; // INFO text does not alter the selected slot.
      return super.external(target);
    }
  }
  const virtualKeys={ArrowLeft:0x25,ArrowUp:0x26,ArrowRight:0x27,ArrowDown:0x28};
  for(const mode of [1,2])for(let slot=0;slot<7;slot++)for(const key of keys){
    const oracle=new WheelOracle(native.functions,[],()=>{throw Error('Navigation must not draw RNG');});
    const bytes=Buffer.from(native.switch_table.bytes_hex,'hex');
    bytes.forEach((value,index)=>oracle.write(Number(native.switch_table.address)+index,value,1));
    oracle.write(0x2b8f970,1,1);oracle.write(0x2b8f960,mode,1);oracle.write(0x2b8f964,2);
    const selectedAddress=(mode===2?0x2b975d0:0x2b975d3)+2*0x4c5;
    oracle.write(selectedAddress,slot,1);oracle.run(0x429c10,[virtualKeys[key]]);
    const {view}=fixture();view.focusIndex=slot;view.key(key);
    assert.equal(view.focusIndex,oracle.read(selectedAddress,1),`mode ${mode}, ${names[slot]} ${key}`);
  }
});

test('holding one direction stops at the wheel edge instead of cycling through commands',()=>{
  const {view,cues}=fixture();view.focusIndex=5;
  for(let count=0;count<12;count++)view.key('ArrowLeft',count>0);
  assert.equal(view.focusIndex,1);assert.equal(cues.length,2);
});

test('moving onto the central escape command only focuses it; confirmation executes it',async()=>{
  const {view}=fixture(),commands=[];
  view.available=()=>true;view.battle={chooseEscape:()=>commands.push('escape')};
  view.commandSlots=manifest.semantic_bindings.default_commands.slots.reduce((slots,slot)=>(slots[slot.slot]=slot,slots),[]);
  view.key('ArrowDown');assert.equal(view.focusIndex,6);assert.deepEqual(commands,[]);
  view.key('Enter');await Promise.resolve();assert.deepEqual(commands,['escape']);
});

function partyFixture(){
  const {view,cues}=fixture(),selected=[];
  view.snapshot={player_id:'001',actors:[0,1,2,3].map(slot=>({id:String(slot+1).padStart(3,'0'),side:'player',party_slot_zero_based:slot}))};
  view.battle={canCommand:id=>id!=='004',selectPlayer(id){selected.push(id);view.snapshot.player_id=id;}};
  view.ready=()=>['001','002','003'];view.players=new Map(view.snapshot.actors.map(a=>[a.id,{focus(){view.focusedActor=a.id;}}]));
  view.syncWheel=view.syncList=view.syncTargets=view.setInfo=()=>{};
  return {view,cues,selected};
}

test('Esc closes the wheel; native direction slots select ready actors and Space reopens their commands',()=>{
  const {view,selected}=partyFixture();
  view.key('Escape');assert.equal(view.stage,'actors');assert.equal(view.focusedActor,'001');
  view.key('ArrowUp');assert.equal(view.stage,'actors');assert.equal(view.snapshot.player_id,'002');
  view.key('ArrowDown');assert.equal(view.snapshot.player_id,'003');view.key('ArrowLeft');assert.equal(view.snapshot.player_id,'001');
  view.key('ArrowRight');assert.equal(view.snapshot.player_id,'001','A partial gauge must not take command focus');
  assert.deepEqual(selected,['002','003','001']);view.key(' ');assert.equal(view.stage,'wheel');
});

test('A ready teammate remains selectable when the current actor is busy, including the only available teammate',()=>{
  const {view,selected}=partyFixture();view.battle.canCommand=id=>id==='002';
  view.cycleActor();assert.deepEqual(selected,['002']);
  view.snapshot.player_id='001';view.selectActor('002');assert.deepEqual(selected,['002','002']);
});
