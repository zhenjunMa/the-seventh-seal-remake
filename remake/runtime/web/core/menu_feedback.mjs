// Native562EF0 owns cancel/decide/select/open/close. This adapter gives a
// gesture one owner so keyboard confirmation's synthetic click cannot double it.
export function operationFeedbackState(view){
  const doc=view.root.ownerDocument,active=doc.activeElement,tech=view.techniques,equipment=view.equipmentView,weapon=view.weaponView;
  return JSON.stringify([view.current,view.mode,active?.id,active?.dataset?.techniqueKey,active?.dataset?.instanceId,active?.dataset?.roleId,active?.dataset?.slotId,active?.getAttribute?.('aria-label'),
    view.actorId,view.itemSelectedId,view.itemFilterIndex,view.itemOffset,view.node('menuItemTargets').hidden,
    equipment.slotId,equipment.pickerOpen,equipment.selectedIndex,equipment.offset,equipment.detailsIndex,
    weapon.socketIndex,weapon.pickerOpen,weapon.selectedIndex,weapon.offset,weapon.detailsIndex,
    tech.stage,tech.section,tech.roleId,tech.category,tech.listOffset,tech.preview?.index,tech.slotIndex,tech.composition.length,tech.nameCursor,tech.nameCharacterIndex,tech.nameFocusZone,tech.iconFocus,
    view.formation.focusIndex,view.formation.firstIndex,view.system.navIndex,view.system.index,view.system.state]);
}

export function createMenuFeedback({playCue,getState,schedule=fn=>setTimeout(fn,0)}){
  let enabled=false,active=null,sequence=0,keyboardDepth=0;
  const emit=(name,gesture)=>playCue(name,`operation-menu:${gesture?.id??++sequence}`);
  function flush(g){
    if(g.done||!g.ended||g.pending)return;
    g.done=true;
    if(!g.handled||g.silent||g.kind==='ignore')return;
    const changed=g.before!==g.after;
    const name=g.failure?'menuError':g.kind==='cancel'?'menuCancel':g.kind==='select'?(changed?'menuSelect':null):(g.success||changed?'menuConfirm':'menuError');
    if(name)emit(name,g);
  }
  function queue(g){if(!g.queued){g.queued=true;schedule(()=>{g.queued=false;flush(g);});}}
  function begin(kind,owner='keyboard',silent=false){
    if(active?.ended&&!active.pending)flush(active);
    const g={id:++sequence,kind,owner,before:getState(),after:null,pending:0,ended:false,handled:true,silent,done:false,failure:false,success:false};active=g;return g;
  }
  function end(g,handled=true){g.after=getState();g.handled=handled!==false;g.ended=true;queue(g);}
  function run(kind,fn,{repeat=false}={}){
    if(!enabled)return fn();
    const g=begin(kind,'keyboard',repeat&&['confirm','cancel'].includes(kind));keyboardDepth++;
    try{const result=fn();end(g,result);return result;}catch(error){g.failure=true;end(g);throw error;}finally{keyboardDepth--;}
  }
  function transaction(fn){
    if(!enabled&&(!active||active.done))return fn();
    const g=active&&!active.done?active:begin('confirm','transaction');g.pending++;
    const complete=(success,value)=>{g.pending--;if(success)g.success=true;else g.failure=true;if(g.owner==='transaction')end(g);else queue(g);return value;};
    let result;try{result=fn();}catch(error){complete(false);throw error;}
    if(result?.then)return Promise.resolve(result).then(value=>complete(true,value),error=>{complete(false);throw error;});
    return complete(true,result);
  }
  function reject(){if(active){if(!active.done){active.failure=true;queue(active);}return;}if(enabled)emit('menuError');}
  function attach(root){
    const target=event=>event.target?.closest?.('button');
    const kind=button=>/scroll|(?:^|\s)item-filter(?:\s|$)/i.test(button?.className??'')||button?.dataset?.techniqueKey?.startsWith('scroll-')?'select':'confirm';
    const down=event=>{if(!enabled||keyboardDepth)return;const button=target(event);if(!button)return;const g=begin(kind(button),'pointer');if(button.disabled||button.dataset.available==='false')g.failure=true;};
    const click=event=>{if(!enabled||keyboardDepth)return;const button=target(event);if(!button)return;if(!active||active.done||active.owner!=='pointer'||active.ended)begin(kind(button),'pointer');};
    const clicked=()=>{if(enabled&&!keyboardDepth&&active?.owner==='pointer'&&!active.ended)end(active);};
    const up=()=>{const g=active;if(g?.owner==='pointer'&&!g.ended)schedule(()=>{if(!g.ended){g.kind=g.failure?'confirm':'select';end(g);}});};
    const wheel=()=>{if(enabled&&!keyboardDepth)begin('select','wheel');};
    const wheeled=()=>{if(enabled&&active?.owner==='wheel'&&!active.ended)end(active);};
    const bindings=[['pointerdown',down,true],['click',click,true],['click',clicked,false],['pointerup',up,false],['wheel',wheel,true],['wheel',wheeled,false]];
    for(const [name,listener,capture]of bindings)root.addEventListener(name,listener,capture);
    return ()=>{for(const [name,listener,capture]of bindings)root.removeEventListener(name,listener,capture);};
  }
  return {run,transaction,reject,attach,activate(){enabled=true;active=null;},closing(){if(!active||active.done)emit('menuCancel');enabled=false;}};
}
