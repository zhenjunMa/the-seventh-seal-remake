import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {operationSummaryFields, operationStandingFrame,operationColorRef,operationMnuTextOptions} from '../web/core/menu_presentation.mjs';

test('role board preserves native padded current fields and separate maximum fields', () => {
  const status={level:10,hp:{current:900,maximum:900},mp:{current:0,maximum:40},experience:5318,nextLevelExperience:632};
  const values=Object.fromEntries(operationSummaryFields(status).map(([,value,key])=>[key,value]));
  assert.equal(values['hp-current'],'  900/');
  assert.equal(values['mp-current'],'    0/');
  assert.equal(values['mp-maximum'],'40');
  assert.equal(values.next,'632');
});

test('standing pose advances at its playback interval and loops only inside the selected action', () => {
  const standing={frames:['a','b','c'],interval_ms:120,action:0,actions:[{index:0,loop_raw:1}]};
  assert.equal(operationStandingFrame(standing,119),'a');
  assert.equal(operationStandingFrame(standing,120),'b');
  assert.equal(operationStandingFrame(standing,360),'a');
  assert.equal(operationStandingFrame({...standing,actions:[{index:0,loop_raw:0}]},500),'c');
});

test('Every registered menu standing pose shares its role battle-idle interval while retaining the menu source interval',()=>{
  const menu=JSON.parse(fs.readFileSync(new URL('../web/data/operation_menu.json',import.meta.url),'utf8'));
  const battle=JSON.parse(fs.readFileSync(new URL('../web/data/party_battle_view.json',import.meta.url),'utf8'));
  for(const [id,standing]of Object.entries(menu.standing_actors)){
    const idle=battle.roles.find(role=>role.id===id).idle;
    assert.equal(standing.interval_ms,idle.interval_raw,`${id}: menu and battle idle speed differ`);
    assert.deepEqual(standing.timing_source,{path:'data/party_battle_view.json',role_id:id,pose:'idle'});
    assert.equal(standing.actions.find(action=>action.index===standing.action).interval_raw,120,'Original menu interval is still retained');
    assert.equal(operationStandingFrame(standing,idle.interval_raw-1),standing.frames[0]);
    assert.equal(operationStandingFrame(standing,idle.interval_raw),standing.frames[1]);
    assert.equal(operationStandingFrame(standing,idle.interval_raw*standing.frames.length),standing.frames[0]);
  }
});

test('native roster display clamps effective HP and MP without constraining level or EXP',()=>{
  const status={level:100,hp:{current:-5,maximum:15000},mp:{current:1500,maximum:-2},experience:123456,nextLevelExperience:-1};
  const values=Object.fromEntries(operationSummaryFields(status).map(([,value,key])=>[key,value]));
  assert.equal(values.level,'100');
  assert.equal(values['hp-current'],'    0/');
  assert.equal(values['hp-maximum'],'9999');
  assert.equal(values['mp-current'],'  999/');
  assert.equal(values['mp-maximum'],'0');
  assert.equal(values.exp,'123456');
  assert.equal(values.next,'-1');
  assert.equal(status.hp.current,-5,'display clamp does not mutate the world');
});

test('MNU requests retain per-widget colors, font sizes and alignment from raw bytes',()=>{
  const source=JSON.parse(fs.readFileSync(new URL('../web/data/operation_menu.json',import.meta.url),'utf8'));
  const widget=(id,name)=>source.menus.find(menu=>menu.id===id).widgets.find(row=>row.name===name);
  assert.equal(operationColorRef(0x003e3e),'#3e3e00');
  const gold=operationMnuTextOptions(widget('game001','GOLD'));
  assert.equal(gold.font,'requested_black19_mnu');
  assert.equal(gold.foreground,'#ffff00');assert.equal(gold.shadow,'#3e3e00');
  assert.equal(gold.align,'left');assert.equal(gold.verticalAlign,'center');
  assert.equal(gold.lineHeight,20);assert.equal(gold.layout,'mnu');
  const info=operationMnuTextOptions(widget('game001','INFO'));
  assert.equal(info.shadow,null);assert.equal(info.boxHeight,41);assert.equal(info.maxWidth,623);
  const stat=operationMnuTextOptions(widget('game001a_2','text04'));
  assert.equal(stat.font,'arial23_mnu');assert.equal(stat.shadow,'#414141');
  const weapon=operationMnuTextOptions(widget('game001c','T2'));
  assert.equal(weapon.font,'requested_black19_mnu');assert.equal(weapon.shadow,'#2a2a2a');
  const name=operationMnuTextOptions(widget('game001c','NAME2'));
  assert.equal(name.font,'requested_black23_mnu');assert.equal(name.shadow,'#2e2e2e');assert.equal(name.align,'center');
});
