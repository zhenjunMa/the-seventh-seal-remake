"""Small, source-backed combat subrules; not a complete attack simulator.

HP commit follows GAME.exe 0x5005C0, with 0x500350/0x5003F0 and
0x4FFD40. Arithmetic probes follow assembly of 0x41D990. Effective
attributes, skill selection, hit exemptions, random call order, animation,
and world state are intentionally outside this module's contract.
All functions are pure and never read or write an original save.
"""
from dataclasses import dataclass, replace


def i32(value: int) -> int:
    """Low 32 bits interpreted as signed, as in x86 register arithmetic."""
    if type(value) is not int:
        raise ValueError("Expected an integer")
    value &= 0xFFFFFFFF
    return value - 0x100000000 if value & 0x80000000 else value


def idiv(numerator: int, denominator: int) -> int:
    """Signed division truncates toward zero, unlike Python // for negatives."""
    if denominator == 0:
        raise ValueError("Division by zero")
    quotient = abs(numerator) // abs(denominator)
    quotient = -quotient if (numerator < 0) != (denominator < 0) else quotient
    if not -0x80000000 <= quotient <= 0x7FFFFFFF:
        raise ValueError("x86 IDIV quotient overflow")
    return quotient


@dataclass(frozen=True)
class HpState:
    raw_hp: int
    side_raw: int = 0
    role_link_raw: int = 0
    linked_hp_bonus: int = 0
    status_hp_raw: int = 0
    state_raw: int = 0

    @property
    def active_bonus(self) -> int:
        return self.linked_hp_bonus if self.side_raw and self.role_link_raw else 0

    @property
    def effective_hp(self) -> int:
        # 0x500350 uses the linked bonus but not status_hp_raw (0x521F551).
        return i32(self.raw_hp + self.active_bonus)


@dataclass(frozen=True)
class HpGate:
    global_00679c6c: int = 0
    global_055ee004: int = 0
    global_055edfec: int = 0


def commit_known_damage(target: HpState, damage: int, attacker_index: int = -1,
                        gate: HpGate = HpGate()) -> dict:
    """Apply an already-resolved damage value, never compute attack damage.

    Result's native_return is the assembly EAX death result, not a generic
    'applied' flag. 'death-handler' means a call to 0x4FFD40; it is not a
    claim about completed death animation or battle victory.
    Negative damage and invalid inputs are rejected by this research API;
    this is a contract restriction, not a claim that native code rejects them.
    """
    for value in (target.raw_hp, target.linked_hp_bonus, target.status_hp_raw,
                  target.role_link_raw, damage, attacker_index,
                  gate.global_00679c6c, gate.global_055ee004, gate.global_055edfec):
        if type(value) is not int or not -0x80000000 <= value <= 0x7FFFFFFF:
            raise ValueError("Expected signed 32-bit integer")
    for value in (target.side_raw, target.state_raw):
        if type(value) is not int or not 0 <= value <= 255:
            raise ValueError("Expected byte field")
    if damage < 0 or attacker_index < -1:
        raise ValueError("Research contract requires nonnegative damage and attacker >= -1")
    blocked = bool(gate.global_00679c6c or gate.global_055ee004 or
                   (gate.global_055edfec and target.side_raw) or target.state_raw >= 4)
    if blocked:
        return {"target": target, "applied": False, "native_return": 0,
                "effective_hp": target.effective_hp, "events": []}
    if target.effective_hp < damage:
        updated = replace(target, raw_hp=i32(-target.active_bonus), status_hp_raw=0)
    else:
        updated = replace(target, raw_hp=i32(target.raw_hp - damage))
    dead = updated.effective_hp <= 0
    events = []
    if dead:
        if attacker_index != -1:
            events.append({"kind": "attacker-byte-write", "index": attacker_index,
                           "base": "0x0521F5F9", "stride": "0x30274", "value": 2})
        events.append({"kind": "death-handler", "function": "0x4FFD40",
                       "attacker_index": attacker_index})
        updated = replace(updated, state_raw=4)
    return {"target": updated, "applied": True, "native_return": int(dead),
            "effective_hp": updated.effective_hp, "events": events}


def threshold_from_terms(attack_term: int, avoid_term: int) -> int:
    """0x41DD53..0x41DD83; terms are caller-supplied native intermediates."""
    threshold = min(100, max(20, i32(attack_term - avoid_term)))
    return 0 if avoid_term >= 100 else threshold


def raw_roll_passes(roll: int, threshold: int) -> bool:
    """The observed comparison is roll <= threshold, not roll < threshold.

    Native has bypass conditions; this helper only evaluates that comparison.
    """
    if type(roll) is not int or not 0 <= roll < 100:
        raise ValueError("Expected RNG()%100 result")
    return roll <= threshold


def raw_action_class_rejected(action_mask_raw: int, target_class_raw: int,
                              target_skill_gate_raw: int = 0,
                              effect_token_raw: int = 0) -> bool:
    """0x41D9E5..0x41DB21: one early rejection gate, before damage RNG.

    Direct settlement (token == 0) reads current action byte +0x78 and
    target byte 0x0524A633 + actor*0x30274. Bits 1/2/4 reject target
    classes 1/2/3, respectively. A nonzero target skill byte +0x3A also
    rejects. The native branch displays via 0x5042F0 and returns -1.

    The class-to-upper/middle/lower mapping and multi-zone representation
    are NOT established. This must not be used as a guessed zone matcher.
    Other earlier/later gates remain outside this helper's contract.
    """
    for value in (action_mask_raw, target_class_raw, target_skill_gate_raw):
        if type(value) is not int or not 0 <= value <= 255:
            raise ValueError("Expected raw byte field")
    if type(effect_token_raw) is not int or not 0 <= effect_token_raw <= 0x7FFFFFFF:
        raise ValueError("Research contract requires nonnegative signed token")
    if effect_token_raw != 0:
        return False
    if target_skill_gate_raw:
        return True
    class_bit = {1: 1, 2: 2, 3: 4}.get(target_class_raw, 0)
    return bool(action_mask_raw & class_bit)


def physical_component(effective_attack: int, effective_defense: int,
                       multiplier: int) -> int:
    """0x41E02F..0x41E170; excludes elemental addition and final guard.

    Inputs are already resolved by 0x41C610/0x501930, not raw CHR attributes.
    Defense exactly zero becomes one; negative defense is not clamped here.
    Multiplier must already include native selection/randomization.
    """
    for value in (effective_attack, effective_defense, multiplier):
        if type(value) is not int or not -0x80000000 <= value <= 0x7FFFFFFF:
            raise ValueError("Expected signed 32-bit integer")
    defense = effective_defense if effective_defense != 0 else 1
    difference = i32(i32(effective_attack * 5000) - i32(defense * 4500))
    base = idiv(difference, 999)
    return max(0, idiv(i32(base * multiplier), 100))
