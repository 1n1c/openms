// Original00460aa0,00766031/00766272,0094e256 and00949b5d.
// Retained source/WZ table: docs/ghidra-client-corrections/reported-r3-weapon-coverage.json.
export const MELEE_ACTIONS = Object.freeze([
  [],
  ["swingO1", "swingO2", "swingO3", "stabO1", "stabO2"],
  ["swingT2", "swingP1", "swingP2", "stabT1", "stabT2"],
  ["swingT1", "swingT3"],
  ["swingT1", "stabT1"],
  ["swingT1", "swingT2", "swingT3", "stabO1", "stabO2"],
  ["swingO2"],
  ["stabO1", "stabO2"],
  ["stabO1", "stabO2"],
  ["swingT1", "swingT2", "swingT2"],
]);
export const RANGED_ACTIONS = Object.freeze({
  3: ["shoot1"],
  4: ["shoot2"],
  // Action codes24..26 deliberately reuse the swingO1..3 canvases (004a3edf).
  7: ["swingO1", "swingO2", "swingO3"],
  9: ["shot"],
});
for (const row of MELEE_ACTIONS) Object.freeze(row);
for (const row of Object.values(RANGED_ACTIONS)) Object.freeze(row);
const POLEARM_SWINGS = Object.freeze(["swingT2", "swingP1", "swingP2"]);

export function weaponActionNames(combat) {
  const category = combat.equipment.attack;
  const names = new Set([
    ...MELEE_ACTIONS[category],
    ...(RANGED_ACTIONS[category] ?? []),
    "proneStab",
  ]);
  if (combat.weaponType === 44) {
    for (const name of POLEARM_SWINGS) names.add(`${name}PoleArm`);
  }
  return names;
}

export function weaponType(id) {
  const type = Math.trunc(id / 10000) % 100;
  return Math.trunc(id / 1000000) === 1 &&
    ((type >= 30 && type <= 33) || (type >= 37 && type <= 49))
    ? type
    : 0;
}

export function isRangedWeapon(type) {
  return type === 45 || type === 46 || type === 47 || type === 49;
}

/** Native008c7f3c: Magical Mitten uses bow arrows, not throwing stars. */
export function compatibleAmmunition(weaponId, itemId) {
  const type = weaponType(weaponId);
  if (type === 45 || weaponId === 1472063) {
    return Math.trunc(itemId / 1000) === 2060;
  }
  if (type === 46) return Math.trunc(itemId / 1000) === 2061;
  if (type === 47) return Math.trunc(itemId / 10000) === 207;
  return type === 49 && Math.trunc(itemId / 10000) === 233;
}

/** Ordinary rounds exclude exhausted stacks and skill-only capsules. */
function availableRound(item, weaponId) {
  const group = Math.trunc(item.id / 1000);
  return (
    item.count > 0 &&
    group !== 2331 &&
    group !== 2332 &&
    compatibleAmmunition(weaponId, item.id)
  );
}

/** Validated profile/catalog; native ascending USE-slot selection for the required rounds.
 * Capsules2331/2332 are skill-only (00949e62), even though Cosmic admits them.
 * Native005daf30 applies authored reqLevel and optional map restrictions. */
export function selectAmmunition(profile, items, weaponId, quantity = 1) {
  if (!isRangedWeapon(weaponType(weaponId))) return null;
  let selected = null;
  for (const item of profile.inventory) {
    if (!availableRound(item, weaponId) || item.count < quantity) continue;
    const info = items[item.id]?.info;
    if (!info) {
      throw new Error(`Original ammunition metadata unavailable: ${item.id}`);
    }
    if (profile.level < (info.reqLevel ?? 0)) continue;
    if (selected === null || item.slot < selected.slot) selected = item;
  }
  return selected;
}

/** Caller-owned state, populated once per admitted action; not a second inventory authority. */
export function createWeaponUse() {
  return {
    action: null,
    ranged: false,
    ammunition: null,
    projectileId: 0,
    projectilePAD: 0,
  };
}

/** Original action row selection, including Aran's distinct polearm poses. */
function weaponAction(combat, context, ranged) {
  const row = (ranged ? RANGED_ACTIONS : MELEE_ACTIONS)[
    combat.equipment.attack
  ];
  if (!row?.length) {
    throw new Error("Original basic weapon action row unavailable");
  }
  let action = context.crouching
    ? "proneStab"
    : row[context.randomWord % row.length];
  if (
    combat.weaponType === 44 &&
    (context.job === 2000 || Math.trunc(context.job / 100) === 21) &&
    POLEARM_SWINGS.includes(action)
  ) {
    action += "PoleArm";
  }
  return action;
}

/**0094e256 probes the selected melee rectangle before a ranged shot; crouching
 * and empty ammunition always take the actual weapon's melee row. */
export function selectWeaponUse(combat, context, output) {
  const ranged =
    isRangedWeapon(combat.weaponType) &&
    !context.crouching &&
    (context.ammunition !== null || context.unlimitedAmmunition === true) &&
    !context.closeTarget;
  output.action = weaponAction(combat, context, ranged);
  output.ranged = ranged;
  output.ammunition = ranged ? context.ammunition : null;
  output.projectileId = projectileId(output, combat.weaponType);
  output.projectilePAD = output.ammunition
    ? (context.items[output.projectileId].info.incPAD ?? 0)
    : 0;
  return output;
}

function projectileId(use, type) {
  if (use.ammunition) return use.ammunition.id;
  if (!use.ranged) return 0;
  if (type === 45) return 2060000;
  return type === 46 ? 2061000 : 0;
}

/**00761845: original base projectile reach plus learned Eye range only. */
export function projectileRange(type, job, hooks) {
  if (type === 49) return 200;
  const cygnus = Math.trunc(job / 1000) === 1;
  const id =
    type === 47 ? (cygnus ? 14000001 : 4000001) : cygnus ? 13000001 : 3000002;
  const rank = hooks.skillLevel(id);
  return (
    (type === 47 ? 200 : 300) +
    (rank ? (hooks.skillInfo(id, rank)?.range ?? 0) : 0)
  );
}

/**006789ed,00953fca/00955e6b:20px search strips widen by distance/4.
 * Return the first intersecting strip distance; field order breaks ties offline. */
export function projectileTargetDistance(body, origin, range, start = 0) {
  const near = origin.facing > 0 ? body.left - origin.x : origin.x - body.right;
  const far = origin.facing > 0 ? body.right - origin.x : origin.x - body.left;
  if (!body.active || far <= start || near >= range) return Infinity;
  const first = Math.max(start, start + Math.floor((near - start) / 20) * 20);
  for (
    let distance = first;
    distance < range && distance < far;
    distance += 20
  ) {
    const height = Math.trunc(distance / 4);
    if (
      body.top < origin.y - 28 + height &&
      body.bottom > origin.y - 28 - height
    ) {
      return distance;
    }
  }
  return Infinity;
}

/** Shared extraction/preparation/admission boundary; never defer malformed art until durable equip. */
export function validateWeaponCombat(combat) {
  if (combat === null) return combat;
  if (combat?.schemaVersion !== 2 && combat?.schemaVersion !== 3) {
    throw new Error("Invalid original equipped combat metadata");
  }
  validateCombatEquipment(combat.equipment);
  const type = weaponType(combat.weaponId);
  if (
    !type ||
    combat.weaponType !== type ||
    !MELEE_ACTIONS[combat.equipment.attack]?.length
  ) {
    throw new Error("Invalid original equipped combat metadata");
  }
  validateCombatAttacks(combat);
  return combat;
}

/** Original equipment statistics are admitted before inventory publication. */
function validateCombatEquipment(equipment) {
  if (
    !equipment ||
    !Number.isSafeInteger(equipment.incPAD ?? 0) ||
    (equipment.incPAD ?? 0) < 0 ||
    !Number.isSafeInteger(equipment.attackSpeed) ||
    typeof equipment.sfx !== "string"
  ) {
    throw new Error("Invalid original equipped combat metadata");
  }
}

function validateCombatAttacks(combat) {
  const entries = Object.keys(combat.attacks ?? {});
  if (!entries.length || entries.length > 128) {
    throw new Error("Invalid equipped attack inventory");
  }
  for (const name of entries) validateCombatRectangle(combat, name);
  for (const name of weaponActionNames(combat)) {
    validateAttackTiming(combat.attacks[name]?.timing, name);
  }
}

function validateCombatRectangle(combat, name) {
  const rectangle = combat.attacks[name].rectangle;
  if (
    rectangle === null &&
    RANGED_ACTIONS[combat.equipment.attack]?.includes(name)
  ) {
    return;
  }
  validateAttackRectangle(rectangle);
}

function validateAttackTiming(timing, name) {
  if (
    !timing ||
    !Number.isSafeInteger(timing.duration) ||
    timing.duration <= 0 ||
    !Number.isSafeInteger(timing.release) ||
    timing.release < 0 ||
    timing.release > timing.duration
  ) {
    throw new Error(`Invalid equipped attack timing: ${name}`);
  }
}

function validateAttackRectangle(rectangle) {
  if (
    !rectangle ||
    ![rectangle.left, rectangle.top, rectangle.right, rectangle.bottom].every(
      Number.isFinite,
    ) ||
    rectangle.left >= rectangle.right ||
    rectangle.top >= rectangle.bottom
  ) {
    throw new Error("Invalid equipped attack rectangle");
  }
}

/**00453ad1/453d: original frame delay * (clamped speed +10)/16, truncated per frame. */
export function applyWeaponAttackSpeed(actions, combat) {
  validateWeaponCombat(combat);
  if (!combat) return;
  for (const name of weaponActionNames(combat)) {
    if (!actions[name]?.length) {
      throw new Error(`Missing equipped attack artwork: ${name}`);
    }
  }
  const numerator =
    Math.max(2, Math.min(10, combat.equipment.attackSpeed)) + 10;
  for (const name of Object.keys(combat.attacks)) {
    const frames = actions[name];
    if (!frames) continue;
    for (const frame of frames) {
      frame.attackDelay ??= frame.delay;
      frame.delay = Math.trunc((frame.attackDelay * numerator) / 16);
    }
  }
}

/** Native00453ad1: always derive from original delays, never already-scaled frames. */
export function weaponActionDuration(action, speed) {
  let duration = 0;
  for (const frame of action.frames) {
    duration += Math.trunc(
      ((frame.attackDelay ?? frame.delay) * (speed + 10)) / 16,
    );
  }
  return duration;
}

/** Map the admitted wall clock back onto the immutable actor's compiled frame clock. */
export function weaponActionAnimationMs(action, speed, elapsed) {
  let sourceMs = 0;
  for (const frame of action.frames) {
    const delay = Math.trunc(
      ((frame.attackDelay ?? frame.delay) * (speed + 10)) / 16,
    );
    if (elapsed < delay) return sourceMs + (elapsed * frame.delay) / delay;
    elapsed -= delay;
    sourceMs += frame.delay;
  }
  return action.duration;
}

/** Native00406abd/009517: release ratio uses original action timing before speed scaling. */
export function weaponActionRelease(action, duration) {
  let originalDuration = 0;
  let originalRelease = 0;
  let alias = false;
  let last = 0;
  for (const frame of action.frames) {
    last = frame.attackDelay ?? frame.delay;
    originalDuration += last;
    if (frame.preAction) originalRelease += last;
    alias ||= Boolean(frame.alias);
  }
  if (!alias) originalRelease = originalDuration - last;
  return Math.trunc((duration * originalRelease) / originalDuration);
}
