import { weaponType, selectAmmunition } from "../combat/weapon-usage.js";
import {
  initializeCombatStats,
  projectModernCombatStats,
} from "./modern-combat-stats.js";

const VITAL_CAP = 30000;
const EQUIPMENT_FIELDS = Object.freeze([
  ["str", "incSTR"],
  ["dex", "incDEX"],
  ["int", "incINT"],
  ["luk", "incLUK"],
  ["maxHP", "incMHP"],
  ["maxMP", "incMMP"],
  ["pad", "incPAD"],
  ["mad", "incMAD"],
  ["pdd", "incPDD"],
  ["mdd", "incMDD"],
  ["acc", "incACC"],
  ["eva", "incEVA"],
  ["speed", "incSpeed"],
  ["jump", "incJump"],
]);

/** Original base-template fields only; this save model never invents equipment upgrades. */
function equipmentInfo(items, id) {
  const template = items?.[id];
  if (!template?.info) {
    throw new Error(`Original equipped-item statistics unavailable: ${id}`);
  }
  return template.info;
}

function addStat(total, value) {
  const amount = value ?? 0;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(total + amount)) {
    throw new Error("Equipped statistic exceeds safe integer bounds");
  }
  return total + amount;
}

/** Caller supplies a validated bounded profile and immutable original item metadata. */
export function equippedStat(profile, items, field) {
  let result = 0;
  for (const entry of profile.equipment) {
    const info = equipmentInfo(items, entry.id);
    result = addStat(result, entry.upgrade?.stats[field] ?? info[field]);
  }
  return result;
}

/** Reuse caller-owned output; no object/array construction in gameplay projection. */
export function equipmentBonuses(profile, items, output) {
  for (const [key] of EQUIPMENT_FIELDS) output[key] = 0;
  for (const entry of profile.equipment) {
    const info = equipmentInfo(items, entry.id);
    for (const [key, source] of EQUIPMENT_FIELDS) {
      output[key] = addStat(
        output[key],
        entry.upgrade?.stats[source] ?? info[source],
      );
    }
  }
  return output;
}

/** Cosmic Character.java7600..7669: base + equipped maxima, then30000 cap.
 * config.yaml USE_FIXED_RATIO_HPMP_UPDATE=false: raising a maximum never heals.
 * Base values remain durable; Hyper Body multiplies base+equipment, never itself. */
export function recalculateVitals(profile, items, temporary = null) {
  const hp = addStat(profile.baseMaxHP, equippedStat(profile, items, "incMHP"));
  const mp = addStat(profile.baseMaxMP, equippedStat(profile, items, "incMMP"));
  profile.maxHP = Math.max(
    1,
    Math.min(
      VITAL_CAP,
      hp + Math.trunc((hp * (temporary?.hyperBodyHP ?? 0)) / 100),
    ),
  );
  profile.maxMP = Math.max(
    0,
    Math.min(
      VITAL_CAP,
      mp + Math.trunc((mp * (temporary?.hyperBodyMP ?? 0)) / 100),
    ),
  );
  profile.hp = Math.min(profile.hp, profile.maxHP);
  profile.mp = Math.min(profile.mp, profile.maxMP);
}

const PRIMARY_STATS = ["str", "dex", "int", "luk"];
const SECONDARY_CAPS = [
  ["pdd", Number.MAX_SAFE_INTEGER],
  ["mad", 2000],
  ["mdd", Number.MAX_SAFE_INTEGER],
  ["acc", 999],
  ["eva", 999],
];
const WEAPON_MASTERY = new Map([
  [30, [1100000, 1200000, 11100000]],
  [31, [1100001]],
  [32, [1200001]],
  [33, [4200000]],
  [40, [1100000, 1200000, 11100000]],
  [41, [1100001]],
  [42, [1200001]],
  [43, [1300000]],
  [44, [1300001]],
  [45, [3100000]],
  [46, [3200000]],
  [47, [4100000]],
  [48, [5100001]],
  [49, [5200000]],
]);
const ALTERNATE_MASTERY = new Map([
  [21100000, [21100000]],
  [13100000, [13100000]],
  [14100000, [14100000]],
  [15100001, [15100001]],
]);
const NO_MASTERY = Object.freeze([]);
const ACCURACY_PASSIVES = [3000000, 4000000, 14000000, 5000000, 15000000];
const SHIELD_MASTERY = [1110001, 1210001, 4210000];
const CRITICAL_PASSIVES = [
  [3000001, 45, 46],
  [13000000, 45, 45],
  [4100001, 47, 47],
  [14100001, 47, 47],
  [15110000, 48, 48],
];

/** Allocate once per consumer, then reuse with projectCharacterStats. */
export function createCharacterStats() {
  const output = {
    level: 0,
    job: 0,
    weaponId: 0,
    weaponType: 0,
    projectileId: 0,
    projectilePAD: 0,
    padWithoutProjectile: 0,
    mastery: 0,
    criticalChance: 0,
    criticalDamage: 0,
    hands: 0,
    invincible: 0,
    damageSupported: false,
  };
  for (const [key] of EQUIPMENT_FIELDS) output[key] = 0;
  initializeCombatStats(output);
  return output;
}

function learnedInfo(hooks, id) {
  const rank = hooks.skillLevel(id);
  if (!Number.isSafeInteger(rank) || rank < 0) {
    throw new Error("Invalid learned-stat rank");
  }
  if (!rank) return null;
  const info = hooks.skillInfo(id, rank);
  if (!info) throw new Error(`Original learned-stat data unavailable: ${id}`);
  return info;
}

/** 00764795/00764afe: first nonzero authored mastery, with x as ACC bonus. */
function projectWeaponMastery(hooks, output) {
  output.mastery = 0;
  output.damageSupported = output.weaponType !== 0;
  const cygnus = Math.trunc(output.job / 1000) === 1;
  const aran = output.job === 2000 || Math.trunc(output.job / 100) === 21;
  const candidates = masteryCandidates(output, aran, cygnus);
  for (const id of candidates ?? NO_MASTERY) {
    const info = learnedInfo(hooks, id);
    if (!info?.mastery) continue;
    output.mastery = addStat(0, info.mastery);
    output.acc = addStat(output.acc, info.x);
    break;
  }
  projectAdvancedMastery(hooks, output, aran, cygnus);
}

function masteryCandidates(output, aran, cygnus) {
  if (output.weaponType === 44 && aran) return ALTERNATE_MASTERY.get(21100000);
  if (output.weaponType === 45 && cygnus) {
    return ALTERNATE_MASTERY.get(13100000);
  }
  if (output.weaponType === 47 && cygnus) {
    return ALTERNATE_MASTERY.get(14100000);
  }
  if (output.weaponType === 48 && cygnus) {
    return ALTERNATE_MASTERY.get(15100001);
  }
  return WEAPON_MASTERY.get(output.weaponType);
}

function advancedMasteryId(type, aran, cygnus) {
  if (type === 45) return cygnus ? 13110003 : 3120005;
  if (type === 46) return 3220004;
  if (type === 44 && aran) return 21120001;
  return 0;
}

/**00764795: expert replaces bow/Aran mastery; Beholder adds to spear/polearm. */
function projectAdvancedMastery(hooks, output, aran, cygnus) {
  const id = advancedMasteryId(output.weaponType, aran, cygnus);
  const info = id ? learnedInfo(hooks, id) : null;
  if (info?.mastery) {
    output.mastery = addStat(0, info.mastery);
    output.pad = addStat(output.pad, info.x);
  }
  if ((output.weaponType === 43 || output.weaponType === 44) && !aran) {
    output.mastery = addStat(
      output.mastery,
      learnedInfo(hooks, 1321007)?.mastery,
    );
  }
}

/** v83 ACC/EVA: both DEX and LUK contribute per user-corrected v83 behavior.
 * family-specific dexFactor matches cosmic getAccWeight. */
function projectBaseAccuracy(output) {
  const family = Math.trunc((output.job % 1000) / 100);
  // v83 getAccWeight: bowman/thief/pirate=0.6, warrior/mage=0.8
  const dexFactor = family === 3 || family === 4 || family === 5 ? 0.6 : 0.8;
  // lukFactor: bowman/thief/pirate=0.3, warrior/mage=0.5
  const lukFactor = dexFactor === 0.6 ? 0.3 : 0.5;
  // v83 EVA: dex/4 + luk/2 (both contribute).
  const evasion = Math.trunc(output.dex / 4) + Math.trunc(output.luk / 2);
  output.eva = addStat(output.eva, evasion);
  // v83 ACC: dex * familyFactor + luk * lukFactor (both contribute).
  output.acc = addStat(
    output.acc,
    Math.trunc(output.dex * dexFactor + output.luk * lukFactor),
  );
}

/** 0077fc..8044f: learned passive fields, never job-based grants. */
function projectPassiveStats(profile, hooks, output) {
  for (const id of ACCURACY_PASSIVES) {
    const info = learnedInfo(hooks, id);
    if (!info) continue;
    output.acc = addStat(output.acc, info.x);
    if (id !== 3000000) output.eva = addStat(output.eva, info.y);
  }
  const root =
    Math.trunc(profile.job / 100) === 22 || profile.job === 2001
      ? 2001
      : Math.trunc(profile.job / 1000) * 1000;
  const blessing = learnedInfo(hooks, root * 10000 + 12);
  if (blessing) {
    output.pad = addStat(output.pad, blessing.x);
    output.mad = addStat(output.mad, blessing.y);
    output.acc = addStat(output.acc, blessing.z);
    output.eva = addStat(output.eva, blessing.z);
  }
  const magic = learnedInfo(hooks, 22000000);
  if (magic) output.mad = addStat(output.mad, magic.mad);
  const magicMastery = learnedInfo(hooks, 22170001);
  if (magicMastery?.mastery) output.mad = addStat(output.mad, magicMastery.x);
  projectWeaponMastery(hooks, output);
}

/** Skill.wz shield x is total shield-defense percent (105..200), not all armor. */
function projectShieldMastery(profile, hooks, output) {
  let multiplier = 100;
  for (const id of SHIELD_MASTERY) {
    multiplier = Math.max(multiplier, learnedInfo(hooks, id)?.x ?? 100);
  }
  if (multiplier === 100) return;
  for (const entry of profile.equipment) {
    if (entry.slot !== -10 || Math.trunc(entry.id / 10000) !== 109) continue;
    const info = equipmentInfo(hooks.items, entry.id);
    const defense = entry.upgrade?.stats.incPDD ?? info.incPDD ?? 0;
    output.pdd += Math.trunc((defense * (multiplier - 100)) / 100);
  }
}

/** Adapt authored total critical percent to a modern bonus over the base 20..50% roll. */
function projectCritical(hooks, output, temporary) {
  output.criticalChance = 0;
  output.criticalDamage = 0;
  for (const [id, minimum, maximum] of CRITICAL_PASSIVES) {
    if (output.weaponType < minimum || output.weaponType > maximum) continue;
    const info = learnedInfo(hooks, id);
    if (!info) continue;
    output.criticalChance = Math.max(output.criticalChance, Number(info.prop));
    output.criticalDamage = Math.max(output.criticalDamage, info.damage - 100);
  }
  const sharpEyes = temporary?.sharpEyes ?? 0;
  output.criticalChance = Math.min(
    100,
    output.criticalChance + (sharpEyes >>> 8),
  );
  output.criticalDamage += sharpEyes & 255;
}

/** Original Echo x is an attack percentage; StatEffect publishes ECHO_OF_HERO separately from PAD/MAD. */
function projectEcho(output, temporary) {
  const percent = temporary?.echo ?? 0;
  output.pad = Math.min(
    Number.MAX_SAFE_INTEGER,
    output.pad + Math.trunc((output.pad * percent) / 100),
  );
  output.padWithoutProjectile = Math.min(
    Number.MAX_SAFE_INTEGER,
    output.padWithoutProjectile +
      Math.trunc((output.padWithoutProjectile * percent) / 100),
  );
  output.mad = Math.min(
    Number.MAX_SAFE_INTEGER,
    output.mad + Math.trunc((output.mad * percent) / 100),
  );
}

/** 00765c5e: Thrust is learned, not inherent movement granted by a job. */
function projectPassiveSpeed(hooks, output) {
  let id = 0;
  if (output.job === 311 || output.job === 312) id = 3110000;
  else if (output.job === 321 || output.job === 322) id = 3210000;
  else if (output.job === 1310 || output.job === 1311 || output.job === 1312) {
    id = 13100004;
  }
  if (id) output.speed = addStat(output.speed, learnedInfo(hooks, id)?.speed);
}

/** 008c457c/45e8 normal, unmounted totals; speed debuffs may fall below100. */
function projectMovementStats(output, temporary) {
  const speed = Math.max(100, Math.min(140, 100 + output.speed));
  const jump = Math.max(100, Math.min(123, 100 + output.jump));
  output.speed = Math.max(
    80,
    Math.min(
      140,
      addStat(speed, temporary?.speed) + (temporary?.darkSightSpeed ?? 0),
    ),
  );
  output.jump = Math.min(123, addStat(jump, Math.max(0, temporary?.jump ?? 0)));
}

/** Select current base weapon and eligible ammunition without copying inventory. */
function projectEquippedWeapon(profile, hooks, output) {
  output.weaponId = 0;
  for (const entry of profile.equipment) {
    if (entry.slot === -11) output.weaponId = entry.id;
  }
  output.weaponType = weaponType(output.weaponId);
  const ammunition = selectAmmunition(profile, hooks.items, output.weaponId);
  output.projectileId = ammunition?.id ?? 0;
  output.projectilePAD = ammunition
    ? (hooks.items[ammunition.id].info.incPAD ?? 0)
    : 0;
}

function projectPrimaryStats(profile, output, temporary) {
  for (const key of PRIMARY_STATS) {
    output[key] =
      addStat(profile[key], output[key]) +
      Math.trunc((profile[key] * (temporary?.mapleWarrior ?? 0)) / 100);
  }
  output.str = addStat(output.str, temporary?.morphSTR);
}

/** v83 panel attribute formulas (user-corrected v83 behavior):
 *   INT → MAGIC (MAD), MAGIC DEF. (MDD), HANDS
 *   LUK → ACC, EVA, HANDS
 *   DEX → ACC, EVA, HANDS, Damage (secondary)
 *   STR → Damage Max only
 * PDD/MDD: pure equipment + INT (no STR/DEX/LUK weights on PDD). */
function projectPanelAttributes(output) {
  // MAD: equipment incMAD already added by equipmentBonuses(). Add INT only (cosmic localmagic = totalINT).
  output.mad = addStat(output.mad, output.int);
  // MDD: equipment incMDD already added. Add INT (MAGIC DEF. follows INT).
  output.mdd = addStat(output.mdd, output.int);
}

/** Project retained equipment/skills with modern damage, mastery, critical and defense rules.
 * Server and offline combat share this function; no durable profile mutation. */
export function projectCharacterStats(
  profile,
  hooks,
  output,
  temporary = hooks.derivedStats?.(),
) {
  if (
    typeof hooks.skillLevel !== "function" ||
    typeof hooks.skillInfo !== "function"
  ) {
    throw new Error("Original learned-stat rank source unavailable");
  }
  equipmentBonuses(profile, hooks.items, output);
  projectPrimaryStats(profile, output, temporary);
  projectPanelAttributes(output);
  output.level = profile.level;
  output.job = profile.job;
  output.invincible = temporary?.invincible ?? 0;
  projectEquippedWeapon(profile, hooks, output);
  output.hands = output.dex + output.int + output.luk;
  projectBaseAccuracy(output);
  projectPassiveStats(profile, hooks, output);
  projectShieldMastery(profile, hooks, output);
  projectCritical(hooks, output, temporary);
  projectPassiveSpeed(hooks, output);
  // Modern ATT includes temporary and projectile contributions without the v83 1999 cap.
  const equipmentPAD = Math.max(0, output.pad);
  output.padWithoutProjectile = addStat(equipmentPAD, temporary?.pad);
  output.pad = Math.max(
    0,
    addStat(output.padWithoutProjectile, output.projectilePAD),
  );
  for (const [key, cap] of SECONDARY_CAPS) {
    const base = Math.max(0, Math.min(cap, output[key]));
    output[key] = Math.max(0, Math.min(cap, addStat(base, temporary?.[key])));
  }
  projectEcho(output, temporary);
  projectModernCombatStats(profile, hooks, temporary, output);
  projectMovementStats(output, temporary);
  output.maxHP = profile.maxHP;
  output.maxMP = profile.maxMP;
  return output;
}
