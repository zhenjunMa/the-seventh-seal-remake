// Explicit test frame driver. Production command submission never advances
// time; fixtures advance their injected clock and call the same frame API.
export const battleActive=battle=>['charging','command','action'].includes(battle.state?.phase);
export async function pumpUntil(battle,predicate,{limit=120000}={}){
  for(let tick=0;tick<limit;tick++){
    if(predicate())return battle.snapshot();
    if(!battleActive(battle))return battle.snapshot();
    await battle.waitTick();battle.advanceClock();
    if(battle.actionTask)await battle.actionTask;
  }
  throw new Error('Test frame driver exceeded bounded battle clock');
}
export async function commandReady(battle,id=battle.state.player_id){
  await pumpUntil(battle,()=>battle.canCommand(id));
  return battle.canCommand(id);
}
export async function chooseReady(battle,skillId,targetId=null){
  if(!battle.state.scheduler)return battle.choose(skillId,targetId);
  const id=battle.skills[skillId]?.actor_id??battle.state.player_id;
  if(!await commandReady(battle,id))return battle.snapshot();
  battle.selectPlayer(id);
  const result=await battle.choose(skillId,targetId);
  if(battle.state.scheduler.pending)await pumpUntil(battle,()=>!battle.state.scheduler.pending&&!battle.running);
  return battle.snapshot()??result;
}
