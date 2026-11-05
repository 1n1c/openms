// Modern rules selected by the user: https://strategywiki.org/wiki/MapleStory/Formulas
// Asset adaptation and units are documented in docs/combat-formulas.md.
export const DAMAGE_LIMIT = 150_000_000_000;
export const DAMAGE_DISPLAY_LIMIT = 999_999_999_999;
export const COMBAT_VALUE_LIMIT = Number.MAX_SAFE_INTEGER;
const WEAPON_MULTIPLIERS = Object.freeze({
  30: 1.24,
  31: 1.2,
  32: 1.2,
  33: 1.3,
  37: 1.2,
  38: 1.2,
  40: 1.34,
  41: 1.34,
  42: 1.34,
  43: 1.49,
  44: 1.49,
  45: 1.3,
  46: 1.35,
  47: 1.75,
  48: 1.7,
  49: 1.5,
});

export function jobFamily(job = 0) {
  if (job === 2000 || Math.trunc(job / 100) === 21) return 1;
  if (job === 2001 || Math.trunc(job / 100) === 22) return 2;
  return Math.trunc((job % 1000) / 100);
}

export function weaponMultiplier(type, job = 0) {
  const hero = job >= 110 && job <= 112;
  if (hero && (type === 30 || type === 31)) return 1.34;
  if (hero && (type === 40 || type === 41)) return 1.44;
  if (Math.trunc(job / 10) === 12 && type === 32) return 1.24;
  return WEAPON_MULTIPLIERS[type] ?? 0;
}

export function combatStatValue(stats) {
  const family = jobFamily(stats.job);
  if (family === 2) return stats.int * 4 + stats.luk;
  if (family === 3 || (family === 5 && stats.weaponType === 49)) {
    return stats.dex * 4 + stats.str;
  }
  if (family === 4) {
    return (
      stats.luk * 4 + stats.dex + (stats.weaponType === 33 ? stats.str : 0)
    );
  }
  return stats.str * 4 + stats.dex;
}

export function baseMasteryPercent(stats) {
  const family = jobFamily(stats.job);
  if (family === 2) return 25;
  if (family === 3 || (family === 4 && stats.weaponType === 47)) return 15;
  if (family === 5 && stats.weaponType === 49) return 15;
  return 20;
}

/** v83 mastery is authored in five-point units; modern mastery caps at 99%. */
export function combatMasteryPercent(stats) {
  return Math.max(
    0,
    Math.min(
      99,
      stats.masteryPercent ??
        baseMasteryPercent(stats) + (stats.mastery ?? 0) * 5,
    ),
  );
}

/** Final damage stacks multiplicatively; ignore/reduction percentages stack on remainder. */
export function combineFinalDamage(current, added) {
  return ((1 + current / 100) * (1 + added / 100) - 1) * 100;
}

export function combineIgnoreDefense(current, added) {
  return 100 * (1 - (1 - current / 100) * (1 - added / 100));
}

export function actualDamageMaximum(stats, use = null) {
  const value = combatStatValue(stats);
  if (stats.weaponType === 0) {
    return jobFamily(stats.job) === 5 ? Math.round((1.43 * value) / 100) : 0;
  }
  const magicWeapon = stats.weaponType === 37 || stats.weaponType === 38;
  const attack = magicWeapon
    ? stats.mad
    : use
      ? stats.padWithoutProjectile + use.projectilePAD
      : stats.pad;
  const result = Math.round(
    (weaponMultiplier(stats.weaponType, stats.job) * value * attack) / 100,
  );
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Combat damage range exceeds safe integer bounds");
  }
  return result;
}

export function actualDamageMinimum(stats, maximum) {
  return Math.round(
    (maximum * (stats.weaponType === 0 ? 20 : combatMasteryPercent(stats))) /
      100,
  );
}

export function shownDamageRange(stats, output = stats) {
  const maximum = actualDamageMaximum(stats);
  const multiplier =
    (1 + (stats.damagePercent ?? 0) / 100) *
    (1 + (stats.finalDamagePercent ?? 0) / 100);
  output.damageMax = Math.min(
    DAMAGE_DISPLAY_LIMIT,
    Math.floor(maximum * multiplier),
  );
  output.damageMin =
    maximum === 0
      ? 0
      : Math.min(
          DAMAGE_DISPLAY_LIMIT,
          Math.floor(1 + actualDamageMinimum(stats, maximum) * multiplier),
        );
  return output;
}

export function damageBonusMultiplier(stats, boss) {
  const conditional = boss
    ? stats.bossDamagePercent
    : stats.normalDamagePercent;
  return (
    Math.max(0, 1 + ((stats.damagePercent ?? 0) + (conditional ?? 0)) / 100) *
    Math.max(0, 1 + (stats.finalDamagePercent ?? 0) / 100)
  );
}

/** PDRate/MDRate are percentages. Legacy flat PDDamage/MDDamage are NOT percentages. */
export function monsterDefenseMultiplier(target, ignore = 0, magic = false) {
  const defense = Math.max(
    0,
    Math.min(500, magic ? (target.MDRate ?? 0) : (target.PDRate ?? 0)),
  );
  return Math.max(
    0,
    1 - (defense / 100) * (1 - Math.max(0, Math.min(100, ignore)) / 100),
  );
}

export function elementalMultiplier(effect, ignore = 0) {
  const fraction = Math.max(0, Math.min(100, ignore)) / 100;
  if (effect === 1) return fraction;
  if (effect === 2) return 0.5 * (1 + fraction);
  return effect === 3 ? 1.5 : 1;
}

/** Truncate the level penalty amount before the additional near-level multiplier. */
export function levelAdjustedDamage(damage, playerLevel, monsterLevel) {
  const gap = playerLevel - monsterLevel;
  if (gap >= 0) return damage * (1.1 + Math.min(5, gap) * 0.02);
  if (gap <= -40) return 0;
  const reduced = damage - Math.trunc(damage * -gap * 0.025);
  return gap > -5 ? reduced * (1 + (5 + gap) * 0.02) : reduced;
}

/** DOT gains no positive level bonus and loses 2.5% per missing level. */
export function dotLevelMultiplier(playerLevel, monsterLevel) {
  return Math.max(0, 1 - Math.max(0, monsterLevel - playerLevel) * 0.025);
}

export function cappedDamage(damage, limit = DAMAGE_LIMIT) {
  if (!Number.isFinite(damage) || damage < 0) {
    throw new Error("Invalid generated damage");
  }
  return Math.min(limit, Math.floor(damage));
}

export function dodgeChance(stats, target) {
  const chance =
    Math.sqrt(Math.max(0, stats.dex + 2 * stats.luk)) -
    Math.sqrt(Math.max(0, target.acc ?? target.accuracy ?? 0)) -
    2 * (target.level - stats.level);
  return Math.max(
    0,
    Math.min(90, chance * (1 + (stats.evasionPercent ?? 0) / 100)),
  );
}

export function defenseLevelFactor(gap) {
  if (gap >= 0) return 1;
  if (gap >= -10) return 1 + gap * 0.01;
  return Math.max(0.5, 0.9 + (gap + 10) * 0.02);
}

export function incomingLevelFactor(gap) {
  if (gap >= 0) return 0.85 - Math.min(10, gap) * 0.0075;
  return 0.85 + Math.min(4, Math.max(0, Math.ceil((-gap - 15) / 5))) * 0.0075;
}

/** Modern monster ATT is linear. Same defense and dodge rules apply to magic. */
export function incomingDamageBounds(stats, target, attack, output) {
  const gap = stats.level - target.level;
  const a = incomingLevelFactor(gap);
  const defense =
    stats.defense ??
    1.5 * stats.str + 0.4 * (stats.dex + stats.luk) + (stats.pdd ?? 0);
  const reduction = defenseLevelFactor(gap) * defense;
  output.minimum = a * (0.85 * attack - Math.min(reduction, 0.68 * attack));
  output.maximum = a * (attack - Math.min(reduction, 0.8 * attack));
  return output;
}
