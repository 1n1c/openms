import {
  selectAmmunition,
  selectWeaponUse,
  createWeaponUse,
  isRangedWeapon,
  MELEE_ACTIONS,
} from "../combat/weapon-usage.js";
import { projectilePreview } from "./local-projectile-rules.js";
import { COMBAT_SKILLS } from "../skills/skill-combat-rules.js";
import { skillAttackAction } from "../skills/skill-action-rules.js";

/** Probe whether any nearby monster falls inside the ranged weapon's
 *  melee reach (≤65px from player center in facing direction, plus
 *  body height slack). Mirrors the server's offline-field probeMeleeTarget().
 *  Uses scene.views which have drawX/drawY rendering positions. */
function probeCloseTarget(owner, combat, sim) {
  if (!isRangedWeapon(combat.weaponType)) return false;
  const meleeRow = MELEE_ACTIONS[combat.equipment.attack];
  if (!meleeRow?.length) return false;
  const scene = owner.hooks.scene();
  if (!scene?.views?.size) return false;
  const facing = sim.facing > 0;
  // Server uses randomWord to pick swingT1 OR swingT3 — both WZ rectangles differ.
  // Probe ALL melee actions so ANY hitbox match returns closeTarget=true.
  // This mirrors server's selectAttackTargets(1) check exactly —
  // server's additional canStrike reactor hook only matters for edge-case geometry
  // where client render drifts from server physics; that gap is handled by
  // scene-events ranged→melee override (which cancels the projectile preview).
  for (const meleeAction of meleeRow) {
    const rect = combat.attacks?.[meleeAction]?.rectangle;
    if (!rect) continue;
    let left = sim.x + (facing ? -rect.right : rect.left);
    let right = sim.x + (facing ? -rect.left : rect.right);
    if (facing) right = Math.min(right, sim.x + 65);
    else left = Math.max(left, sim.x - 65);
    const top = sim.y + rect.top;
    const bottom = sim.y + rect.bottom;
    for (const view of scene.views.values()) {
      if (view.entity?.kind !== "mob") continue;
      const mobX = view.drawX;
      const mobY = view.drawY;
      if (mobX >= left && mobX <= right && mobY >= top && mobY <= bottom) {
        return true;
      }
    }
  }
  return false;
}

/** Presentation selection shares the authored action rules, never their damage/RNG owner. */
export function localAttackSpec(owner, skillId, variant) {
  const actor = owner.scene?.actor,
    profile = owner.store.profile;
  const sim = owner.scene?.simulation;
  if (!canPresent(actor, sim, profile)) return null;
  const combat = actor.avatar?.combat;
  const derived = owner.state?.self.entity.combatState?.modifiers ?? {};
  if (skillId) return skillSpec(owner, combat, derived, skillId);
  if (!combat) return null;
  const use = createWeaponUse();
  const closeTarget = !sim.crouching
    && isRangedWeapon(combat.weaponType)
    && probeCloseTarget(owner, combat, sim);
  selectWeaponUse(
    combat,
    {
      crouching: sim.crouching,
      job: profile.job,
      randomWord: variant,
      ammunition: selectAmmunition(
        profile,
        owner.catalog.ui.items,
        combat.weaponId,
      ),
      unlimitedAmmunition: Boolean(derived.soulArrow || derived.shadowStars),
      closeTarget,
      items: owner.catalog.ui.items,
    },
    use,
  );
  const projectile = projectilePreview(owner, combat, {}, use);
  return {
    action: use.action,
    speed: attackSpeed(combat, derived, null, null),
    sfx: combat.equipment.sfx,
    projectile,
    use,
    info: null,
    spec: null,
  };
}

function skillSpec(owner, combat, derived, skillId) {
  const skill = owner.catalog.ui.skills[skillId];
  const rank = owner.store.profile.skills[skillId]?.level ?? 0;
  const info = skill?.levels[rank];
  if (!info) return null;
  const spec = COMBAT_SKILLS.get(skillId);
  const action = spec
    ? skillAttackAction(skill, info, spec, combat)
    : skill.actions[0];
  return action
    ? {
        action,
        projectile: projectilePreview(owner, combat, {
          id: skillId,
          skill,
          info,
          spec,
        }),
        speed: spec ? attackSpeed(combat, derived, spec, skillId) : null,
        // Local hit presentation reads the authored rectangle and damage percent; the
        // server still resolves admission, HP and rewards.
        use: null,
        info,
        spec: spec ?? null,
      }
    : null;
}

function attackSpeed(combat, derived, spec, skillId) {
  const magic =
    spec && (spec.kind === "magic" || spec.magic || spec.kind === "heal");
  const base = magic
    ? 6
    : (combat?.equipment.attackSpeed ?? 6) + (skillId === 4001334 ? -2 : 0);
  return Math.max(
    2,
    Math.min(
      10,
      base +
        (derived.booster ?? 0) +
        (magic ? 0 : (derived.speedInfusion ?? 0)),
    ),
  );
}

function canPresent(actor, sim, profile) {
  return (
    actor &&
    sim &&
    profile &&
    profile.hp > 0 &&
    sim.state !== "ladder" &&
    !sim.seat
  );
}
