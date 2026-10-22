// Native role-board text: 0x449590. Keep the formatted current and maximum
// fields separate: the original does not center an entire HP/MP fraction.
export function operationSummaryFields(status) {
  // 0x449590 clamps effective resources before applying %5d/ and %d.
  const hp=value=>Math.max(0,Math.min(9999,value));
  const mp=value=>Math.max(0,Math.min(999,value));
  return [
    ['等级', String(status.level).padStart(2, ' '), 'level'],
    ['当前HP', String(hp(status.hp.current)).padStart(5, ' ') + '/', 'hp-current'],
    ['最大HP', String(hp(status.hp.maximum)), 'hp-maximum'],
    ['当前MP', String(mp(status.mp.current)).padStart(5, ' ') + '/', 'mp-current'],
    ['最大MP', String(mp(status.mp.maximum)), 'mp-maximum'],
    ['EXP', String(status.experience), 'exp'],
    ['NEXT', String(status.nextLevelExperience), 'next'],
  ];
}

// MNU stores Windows COLORREF (0x00BBGGRR), not CSS RGB.
export function operationColorRef(value) {
  return '#'+[value&255,(value>>>8)&255,(value>>>16)&255].map(channel=>channel.toString(16).padStart(2,'0')).join('');
}

export function operationMnuTextOptions(widget) {
  if(widget?.type_raw!==7||typeof widget.raw_hex!=='string'||widget.raw_hex.length!==946)throw new Error('Invalid source MNU text widget');
  const bytes=Uint8Array.from(widget.raw_hex.match(/../g),value=>parseInt(value,16)),view=new DataView(bytes.buffer);
  const declared=bytes[0x1bb]||16,height=declared-1,flags=bytes[0x1bc];
  // Connected type7 widgets use weight400 without italic/underline/strikeout
  // or the extra +2 highlight pass. Other requests need their own export.
  if(flags&0x3d)throw new Error('Source MNU font style has no exported profile');
  const font=widget.font_raw==='Arial'?`arial${height}_mnu`:widget.font_raw==='全真特黑體'?`requested_black${height}_mnu`:null;
  if(!font)throw new Error('Source MNU font face has no exported profile');
  const foreground=view.getUint32(0x1c2,true),shadow=view.getUint32(0x1c6,true),r=widget.rect;
  return {font,foreground:operationColorRef(foreground),shadow:flags&2&&shadow!==0xffffffff?operationColorRef(shadow):null,
    layout:'mnu',lineHeight:declared,advanceOverride:declared,maxWidth:r.right-r.left,boxHeight:r.bottom-r.top,
    align:['center','left','right'][bytes[0x1b9]],verticalAlign:['center','top','bottom'][bytes[0x1ba]]};
}

// Generated interval_ms follows the shared battle role idle definition;
// menu DGP action data still owns its source frame sequence and loop mode.
// The browser starts a fresh phase on actor/page change; the original global
// animation phase is not preserved by this UI adapter.
export function operationStandingFrame(standing, elapsedMs) {
  const frames = standing?.frames ?? [];
  if (!frames.length) return null;
  const interval = Math.max(1, standing.interval_ms ?? 120);
  const step = Math.floor(Math.max(0, elapsedMs) / interval);
  const action = standing.actions?.find(row => row.index === standing.action);
  const index = action?.loop_raw === 0 ? Math.min(step, frames.length - 1) : step % frames.length;
  return frames[index]?.image ?? frames[index];
}
