// Rest writes the stored resources, before equipment-linked display bonuses.
// GAME.exe TLK mutation2: jump table0x461D0D -> 0x461861..0x4618D8.
// It visits ten active map actor slots and copies saved +0x34 to +0x30 and
// +0x3C to +0x38. It neither changes the map nor awards/replaces inventory.
import {allPartyRoles} from './party_roster.mjs';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const uint = n => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
const hex = b => Array.from(b, n => n.toString(16).padStart(2, '0')).join('');

export function restorePartyAfterRest(draft) {
  need(Array.isArray(draft?.party) && draft.party.length > 0 && draft.party.length <= 10,
    '休息队伍无效');
  const updates = draft.party.map(role => {
    need(uint(role.hp?.maximum) && uint(role.mp?.maximum), '休息角色资源上限无效');
    let header = null;
    if (role.combat_progress) {
      need(/^(?:[0-9a-f]{2}){779}$/.test(role.combat_progress.header_raw_hex), '休息角色保存头无效');
      const b = Uint8Array.from(role.combat_progress.header_raw_hex.match(/../g), n => parseInt(n, 16));
      const v = new DataView(b.buffer);
      need(v.getUint32(0x34, true) === role.hp.maximum && v.getUint32(0x3c, true) === role.mp.maximum,
        '休息角色保存头与资源上限不一致');
      v.setUint32(0x30, role.hp.maximum, true);
      v.setUint32(0x38, role.mp.maximum, true);
      header = hex(b);
    }
    return {role, header, before:{hp:role.hp.current, mp:role.mp.current},
      after:{hp:role.hp.maximum, mp:role.mp.maximum}};
  });
  for (const {role, header, after} of updates) {
    role.hp.current = after.hp;
    role.mp.current = after.mp;
    if (header !== null) role.combat_progress.header_raw_hex = header;
  }
  return updates.map(({role, before, after}) => ({role_id:role.id, before, after}));
}

// 461780 case10/11: for map actor slots0..9 with resource+0x28 !=0,
// copy respectively stored HP+34->30 or MP+3C->38, then call47CC30.
// The remake persists previously materialized players as active+reserve owned
// roles. It does not materialize all exported source templates to heal them.
// Active membership and visibility are not native recovery predicates.
export function restoreNativeStoryResources(draft,resource){
  need(['hp','mp'].includes(resource)&&Array.isArray(draft?.party)&&draft.party.length>0,'原剧情恢复资源无效');
  const roles=allPartyRoles(draft);
  need(roles.length<=10&&roles.every(role=>role&&typeof role.id==='string')
    &&new Set(roles.map(role=>role.id)).size===roles.length,'原剧情恢复角色无效');
  const maximumOffset=resource==='hp'?0x34:0x3c,currentOffset=maximumOffset-4;
  const updates=roles.map(role=>{
    need(uint(role[resource]?.maximum),'原剧情恢复资源上限无效');
    let header=null;
    if(role.combat_progress){
      need(/^(?:[0-9a-f]{2}){779}$/.test(role.combat_progress.header_raw_hex),'原剧情恢复角色保存头无效');
      const bytes=Uint8Array.from(role.combat_progress.header_raw_hex.match(/../g),part=>parseInt(part,16));
      const view=new DataView(bytes.buffer);
      need(view.getUint32(maximumOffset,true)===role[resource].maximum,'原剧情恢复保存头与资源上限不一致');
      view.setUint32(currentOffset,role[resource].maximum,true);header=hex(bytes);
    }
    return {role,header,before:{[resource]:role[resource].current},after:{[resource]:role[resource].maximum}};
  });
  // Prepare every header before any write so malformed later roles cannot
  // partially heal the earlier ones, including when called outside a store.
  for(const {role,header,after}of updates){
    role[resource].current=after[resource];if(header!==null)role.combat_progress.header_raw_hex=header;
  }
  // Equipment-linked effective values are derived from these saved resources
  // by the common party attributes path, corresponding to native47CC30.
  return updates.map(({role,before,after})=>({role_id:role.id,before,after}));
}

/** Whole-party defeat leaves exploration and opens the original load/new-game
 * menu. Forest enemies have CHR +0x20A=0. A nonzero enemy value dispatches an
 * authored defeat TLK and must be recovered before that encounter is enabled.
 * This function returns UI policy only; it does not invent a healing location,
 * deduct money, grant rewards or replace the current/previous saved world.
 */
export function planPartyDefeat({battle} = {}) {
  need(battle && (battle.phase === 'defeat' || battle.outcome === 'defeat')
    && Array.isArray(battle.actors), '当前战斗尚未全队败北');
  const players = battle.actors.filter(actor => actor.side === 'player');
  const enemies = battle.actors.filter(actor => actor.side === 'enemy');
  // 41BFB0 may request death at rawHP0 while equipment still contributes
  // positive display HP. 4FFE90 starts category5; ended id12 reaches category7
  // in 519DD0, which 4FFA30 excludes without a display-HP test. Category4/5
  // and airborne/active actors must finish their native lifecycle first.
  // Older nonnative snapshots have no category and retain their HP0 contract.
  const completedDefeat = actor => !actor.escaped && !actor.native_active
    && (actor.native_z_raw === undefined || actor.native_z_raw === 0)
    && (actor.state_raw === undefined ? actor.hp?.current === 0 : actor.state_raw === 7);
  need(players.length > 0 && enemies.length > 0 && !battle.pending_outcome
    && !battle.lifecycle_events?.length && players.every(completedDefeat),
    '败北队伍仍有可继续战斗的角色');
  for (const enemy of enemies) {
    need(/^(?:[0-9a-f]{2}){779}$/.test(enemy.header_raw_hex), '败北敌人缺少原始CHR来源');
    const b = Uint8Array.from(enemy.header_raw_hex.match(/../g), n => parseInt(n, 16));
    need(new DataView(b.buffer).getUint32(0x20a, true) === 0,
      '当前敌人有尚未恢复的专属败北剧情');
  }
  return {mode:'game-over', can_explore:false, can_save:false, can_award_rewards:false,
    choices:['load','new-game'], native_movie_path:'Animate/GO02.bik',
    native_handlers:['0x4ffa30','0x430ed0','0x445f80','0x4307a0','0x419e90'],
    evidence:['ev_0c6a5805b7e804d34d6b28d3d290dbd99623994b1bc4a0ca231123501795516d',
      'ev_cb0dced217462ac81aa764674b32ee36ff03b4902fa8c98200b53ed92f2a0285',
      'ev_64adef34e4cb82d9c19035780fcca2b9a7991122da97b2b2a8ebb7745ea0c4ce',
      'ev_2a05f4a1a3b5bae6560f396092aaa052b5dc7eea602d3c36ec48fa2c75b305f0']};
}
