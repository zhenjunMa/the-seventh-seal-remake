// Active membership drives menus, combat and TLK condition10. Ownership also
// includes departed characters so their saved items and commands stay valid.
export function allPartyRoles(world){
  return [...(world.party??[]),...(world.reserve_party??[]).map(entry=>entry.role)];
}
