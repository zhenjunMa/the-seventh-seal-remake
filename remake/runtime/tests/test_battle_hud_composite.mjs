import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BattleMenuView} from '../web/battle_menu_view.mjs';

test('battle skill and item lists share exported text masks and the INFO widget keeps its native font and placement',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../web/data/battle_ui.json',import.meta.url),'utf8'));
  const painted=[],draws=[],view=Object.create(BattleMenuView.prototype);
  Object.assign(view,{ctx:{clearRect(){},drawImage:(...args)=>draws.push(args)},glowCtx:{clearRect(){}},
    doc:{createElement:()=>({})},fontOptions:new WeakMap(),textCache:new Map(),
    textRenderer:{paint(canvas,value,options){painted.push({value,options});return {offsetX:-1,offsetY:-2};},measure:value=>String(value).length*7},
    snapshot:{actors:[],player_id:'001'},menus:new Map(manifest.menus.map(m=>[m.id,m])),
    stage:'items',message:'回复生命',entries:[{name:'小回复剂',quantity:12,available:true}],listButtons:[{}],listIndex:0,listOffset:0,
    image(){},syncTargets(){},drawWheel(){},ready:()=>[]});
  view.draw(0);
  assert.deepEqual(painted.map(row=>row.options.font),['requested_black14_mnu','simsun12_text','arial11_text']);
  assert.equal(painted[0].options.maxWidth,436);assert.equal(painted[0].options.maxLines,1);
  assert.equal(painted[1].options.foreground,'#ffff44');assert.equal(painted[2].options.align,'right');
  assert.deepEqual(draws.map(row=>row.slice(1)),[[1,452],[482,330],[592,330]]);
  view.draw(1);assert.equal(painted.length,3,'unchanged text reuses its rendered mask');
  view.stage='skills';view.skillCategory=1;view.entries=[{name:'炎体．百里',available:false}];view.draw(2);
  assert.equal(painted.at(-1).options.font,'simsun12_text');assert.equal(painted.at(-1).options.foreground,'#777');
});

test('HUD normal and additive pixels composite over the battle at the same 4:3 fit',()=>{
  const calls=[],normal={},glow={},root={dataset:{}},context={
    save(){calls.push('save');},restore(){calls.push('restore');},setTransform(...v){calls.push(['transform',...v]);},
    drawImage(image,...rect){calls.push({image,blend:this.globalCompositeOperation,rect});}
  };
  BattleMenuView.prototype.paintTo.call({canvas:normal,glowCanvas:glow,root},{width:960,height:540,getContext:()=>context});
  const draws=calls.filter(c=>c?.image);
  assert.deepEqual(draws,[{image:normal,blend:'source-over',rect:[120,0,720,540]},{image:glow,blend:'lighter',rect:[120,0,720,540]}]);
  assert.deepEqual(calls[1],['transform',1,0,0,1,0,0]);
  assert.equal(calls.at(-1),'restore');
  assert.equal(root.dataset.compositeMode,'webgl-source-over-lighter');
});

test('live chain uses native HIT pixels, refreshes through two digits, fades on the battle clock and clears on recovery',()=>{
  const manifest=JSON.parse(readFileSync(new URL('../web/data/battle_ui.json',import.meta.url),'utf8'));
  const calls=[],view=Object.create(BattleMenuView.prototype),context=()=>({clearRect(){},save(){},restore(){}});
  Object.assign(view,{manifest,ctx:context(),glowCtx:context(),snapshot:{actors:[],chain:null},
    menus:new Map(manifest.menus.map(m=>[m.id,m])),stage:'waiting',message:'',
    image(){},text(){},syncTargets(){},drawWheel(){},ready:()=>[],
    asset(...args){calls.push({args,alpha:this.ctx.globalAlpha});}});
  view.draw(0);assert.deepEqual(calls,[]);
  view.snapshot.chain={target_id:'enemy-0',attacker_side:1,count:2};view.draw(100);
  assert.deepEqual(calls.map(c=>c.args),[['hit',0,145,-87],['h2',0,75,-87]]);
  calls.length=0;view.draw(280);assert.deepEqual(calls.map(c=>c.args[1]),[6,6]);
  view.snapshot.chain.count=12;calls.length=0;view.draw(300);
  assert.deepEqual(calls.map(c=>c.args),[['hit',6,145,-87],['h2',6,75,-87],['h1',6,35,-87]]);
  calls.length=0;view.draw(300);assert.equal(calls[0].alpha,1,'paused battle time retains the same pose');
  calls.length=0;view.draw(900);assert.equal(calls[0].alpha,1-40/255);
  calls.length=0;view.draw(1200);assert.deepEqual(calls,[],'finished hold hides even before recovery');
  view.snapshot.chain={target_id:'001',attacker_side:0,count:2};view.draw(1300);
  assert.deepEqual(calls.map(c=>c.args),[['hit',0,145,-87],['h2',0,75,-87]],'enemy chains also display');
  view.snapshot.chain.count=0;calls.length=0;view.draw(1310);assert.deepEqual(calls,[]);assert.equal(view.chainDisplay,null);
});

test('Waiting for a command shows the original seven-cover wheel without skill icons or disable crosses',()=>{
  const calls=[],view={
    menus:new Map([['game002d',{images:[{image:'source-wheel'}]}]]),
    image:(...args)=>calls.push(['background',...args]),asset:(...args)=>calls.push(['asset',...args]),
    available:()=>false,slots(){throw Error('Closed wheel must not render command slots');},
    wheelButtons:Array.from({length:7},()=>({style:{left:'540px',top:'345px'},getAttribute:()=> 'true'}))
  };
  for(const stage of ['waiting','wheel','skills','target']){
    calls.length=0;view.stage=stage;BattleMenuView.prototype.drawWheel.call(view,0);
    assert.deepEqual(calls,[['background','source-wheel',490,340],['asset','fight_board_mask',0,490,340]]);
  }
});

test('A ready actor opens the wheel; an individually unavailable slot still retains its disable cross',()=>{
  const calls=[],view={menus:new Map([['game002d',{images:[{image:'source-wheel'}]}]]),
    image(){},asset:(...args)=>calls.push(args),available:()=>true,stage:'wheel',focusIndex:0,
    commandSlots:Array.from({length:7},(_,i)=>({type:2,icon:i%4})),
    wheelButtons:Array.from({length:7},(_,i)=>({style:{left:(490+i)+'px',top:'345px'},getAttribute:()=>String(i===2)}))
  };
  BattleMenuView.prototype.drawWheel.call(view,0);
  assert.equal(calls.filter(([id])=>id==='other_ball').length,7);
  assert.equal(calls.filter(([id])=>id==='board_bright').length,1);
  assert.deepEqual(calls.filter(([id])=>id==='fight_board_disable'),[['fight_board_disable',0,492,345]]);
  assert.equal(calls.some(([id])=>id==='fight_board_mask'),false);
});
