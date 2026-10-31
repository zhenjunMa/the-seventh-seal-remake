// 5130D0 case1 / 510F10: source command1's non-waiting X/Y shake.
// Random-axis and actor-wait variants remain outside sequence admission.
export function beginNativeCameraShake(control, at, previous=null) {
  const position=previous?advanceNativeCameraShake(previous,at):{x:0,y:0};
  return {x:position.x,y:position.y,origin_x:position.x,origin_y:position.y,
    axis:control.mode_raw===0?'x':'y',remaining:(control.step_i32_raw<<1)||2,
    // The dispatcher does not reset510F10's global last-update field. An
    // old inactive clock permits the first visit immediately; it creates
    // no update debt from before this command existed.
    step:control.amount_i32_raw||10,last_at:Math.max(previous?.last_at??0,at-20),active:true};
}

export function advanceNativeCameraShake(previous, now) {
  const state={...previous};
  // Slow remake draws replay each original20ms update in order. A final
  // empty update restores the origin after the last signed displacement.
  while(state.active&&now-state.last_at>=20){
    state.last_at+=20;
    if(state.remaining===0){state.active=false;state.x=state.origin_x;state.y=state.origin_y;break;}
    state[state.axis]=(state[state.axis]+((state.remaining&2)?state.step:-state.step))|0;
    if(state.axis==='y'&&state.y<0)state.y=0;
    state.remaining=(state.remaining-1)|0;
  }
  return state;
}

// 5130D0 case0 / 511300: background channel subtraction, not camera zoom.
// The source clock leaves the attained amount in place until a reverse command.
export function beginNativeColorFade(control,at,previous=null){
  const state=previous?advanceNativeColorFade(previous,at):{value:0,count:0,target:20,mask:0,last_at:0};
  state.active=true;state.last_at=Math.max(state.last_at,at-20);
  if(control.mode_raw===0){state.value=0;state.count=0;state.target=control.step_i32_raw||20;state.step=control.amount_i32_raw||2;state.mask=control.color_mask_raw;}
  else state.step=-Math.abs(control.amount_i32_raw||2);
  return state;
}

export function advanceNativeColorFade(previous,now){
  const state={...previous};
  while(state.active&&now-state.last_at>=20){
    state.last_at+=20;
    if(state.step===0){state.active=false;break;}
    state.value=Math.max(0,Math.min(128,state.value+state.step));
    state.count+=state.step>0?1:-1;
    if(state.value===0||state.value===128||state.count>=state.target)state.active=false;
  }
  return state;
}
