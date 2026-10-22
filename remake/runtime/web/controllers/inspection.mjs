// inspection adapters. Persistent state belongs to the shared runtime context.

export function createInspectionController({state, actions, $, canvas, ctx}) {
  async function showLayers(){
    if(state.scenes.phase!=='map')return;
    state.scenes.setPhase('inspect');actions.status('正在准备燕突图层…');
    try {
      const data=state.layerData??await actions.json('data/yantu_layers.json');
      await Promise.all(data.frames.flatMap(frame=>[actions.image(frame.main.path, 'inspection'),actions.image(frame.intrinsic.path, 'inspection')]));
      state.layerData=data;state.layerIndex=0;
      $('layerSelect').replaceChildren(...data.frames.map((frame,index)=>{const option=document.createElement('option');option.value=index;option.textContent=`${index+1} · 源帧 ${frame.source_frame}${frame.intrinsic.active?' · 本体层活动':''}`;return option;}));
      $('layerPanel').hidden=false;$('layerClose').focus();await drawLayer();actions.status('燕突图层已就绪。');
    } catch(error) {$('layerPanel').hidden=true;state.scenes.setPhase('map');throw error;}
  }
  async function drawLayer(){
    if(!state.layerData)return;const frame=state.layerData.frames[state.layerIndex],main=await actions.image(frame.main.path, 'inspection'),intrinsic=await actions.image(frame.intrinsic.path, 'inspection'),c=$('layerCanvas'),g=c.getContext('2d');
    g.clearRect(0,0,c.width,c.height);g.fillStyle='#17272a';g.fillRect(0,0,c.width,c.height);
    g.strokeStyle='#304345';g.beginPath();for(let x=0;x<c.width;x+=32){g.moveTo(x,0);g.lineTo(x,c.height);}for(let y=0;y<c.height;y+=32){g.moveTo(0,y);g.lineTo(c.width,y);}g.stroke();
    const scale=Math.min((c.width-60)/main.width,(c.height-30)/main.height),x=(c.width-main.width*scale)/2,y=(c.height-main.height*scale)/2;g.imageSmoothingEnabled=false;
    if($('mainLayer').checked)g.drawImage(main,x,y,main.width*scale,main.height*scale);
    if($('intrinsicLayer').checked){g.save();g.globalCompositeOperation='lighter';g.drawImage(intrinsic,x,y,main.width*scale,main.height*scale);g.restore();}
    $('layerFrame').textContent=`${state.layerIndex+1} / ${state.layerData.frames.length} · 组${frame.action_index} / 帧${frame.action_frame} · 源帧${frame.source_frame}${frame.intrinsic.active?' · 本体层活动':' · 本体层空白'}`;
    $('layerSelect').value=String(state.layerIndex);
    $('layerPrevious').disabled=state.layerIndex===0;$('layerNext').disabled=state.layerIndex===state.layerData.frames.length-1;
  }
  return {showLayers, drawLayer};
}
