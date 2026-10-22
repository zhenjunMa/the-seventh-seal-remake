// Browser fullscreen owns Escape unless keyboard lock is granted.
export function createFullscreenController({$, canvas, document=globalThis.document, keyboard=globalThis.navigator?.keyboard}) {
  let disposed=false,session=0;
  const active=()=>document.fullscreenElement===$('screen');
  function changed(){
    const full=active();
    $('fullscreen').textContent=full?'退出全屏':'全屏';
    $('fullscreenControls').hidden=!full;
    if(!full){session++;keyboard?.unlock?.();$('fullscreenHint').textContent='';}
  }
  async function toggle(){
    if(disposed)return;
    if(document.fullscreenElement){await document.exitFullscreen();return;}
    await $('screen').requestFullscreen();
    if(disposed||!active())return;
    const current=++session;
    changed();canvas.focus();
    if(typeof keyboard?.lock!=='function'){
      $('fullscreenHint').textContent='此浏览器不支持接管 Esc；请使用 Chrome / Edge，或退出此全屏后按 F11。';
      return;
    }
    $('fullscreenHint').textContent='请允许浏览器使用 Esc，以便在游戏内返回。';
    try{
      // Only capture Escape. Keep browser and OS shortcuts available.
      await keyboard.lock(['Escape']);
      if(disposed||!active()){keyboard.unlock();return;}
      if(current===session)$('fullscreenHint').textContent='Esc 返回游戏上一级 · 长按 Esc 退出全屏';
    }catch{
      if(!disposed&&active()&&current===session)$('fullscreenHint').textContent='未获准使用 Esc；请允许键盘锁定后重新进入全屏，或退出后按 F11。';
    }
  }
  function dispose(){disposed=true;session++;keyboard?.unlock?.();}
  return {toggle,changed,dispose};
}
