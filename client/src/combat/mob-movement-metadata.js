/** 0067d430..0067d548: fly takes precedence, then move+jump, move, stationary.
 * The canvas/action family selects the controller; flySpeed=0 still flies.
 * Pure-jump (no move) mobs are treated as stationary but retain `canJump`. */
export function mobMovementType(actions) {
  if (actions.fly) return 3;
  if (actions.move) return actions.jump ? 2 : 1;
  return 0; // stationary, with optional jump-only capability
}

/** 0067dc1c/006823f0 stores max(0,100+flySpeed); active abilities clamp after buffs. */
export function mobFlightSpeedPercent(info) {
  const speed = info.flySpeed ?? 0;
  if (!Number.isSafeInteger(speed) || Math.abs(speed) > 1000000) {
    throw new Error("Invalid original mob flying speed");
  }
  return Math.max(0, 100 + speed);
}

/** Original controller provenance is independent of offline roaming/target choice. */
export function mobMovementMetadata(info, actions) {
  const type = mobMovementType(actions);
  return {
    type,
    action: type === 3 ? "fly" : type > 0 ? "move" : null,
    flySpeedPercent: type === 3 ? mobFlightSpeedPercent(info) : null,
    canJump: Boolean(actions.jump),
  };
}
/** noFlip locks artwork/body mirroring, not the grounded controller's heading. */
export function mobFlipped(mob) {
  return mob.facing > 0 && !mob.template.info.noFlip;
}
