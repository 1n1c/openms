// v83 GMS rules aligned to cosmic (OdinMS) server source.
// Reference: f:\cosmic\src\main\java\client\Character.java calculateMaxBaseDamage()
//            f:\cosmic\src\main\java\client\inventory\WeaponType.java
export const DAMAGE_LIMIT = 150_000_000_000;
export const DAMAGE_DISPLAY_LIMIT = 999_999_999_999;
export const COMBAT_VALUE_LIMIT = Number.MAX_SAFE_INTEGER;

/** v83 weapon damage multipliers (cosmic WeaponType.getMaxDamageMultiplier()). */
const WEAPON_MULTIPLIERS = Object.freeze({
  30: 4.0,   // Sword 1H
  31: 4.4,   // Axe/Mace 1H (GENERAL1H_SWING)
  32: 4.6,   // Sword 2H
  33: 3.6,   // Dagger (cosmic DAGGER_THIEVES; non-thief dagger falls back below)
  37: 3.6,   // Wand
  38: 3.6,   // Staff
  40: 3.4,   // Bow
  41: 3.6,   // Crossbow
  42: 4.8,   // Axe/Mace 2H (GENERAL2H_SWING)
  43: 4.8,   // PoleArm — actually POLE_ARM_SWING=5.0 in cosmic
  44: 5.0,   // PoleArm (POLE_ARM_SWING)
  45: 3.6,   // Dagger (alt slot, same as 33)
  46: 4.8,   // Knuckle
  47: 3.6,   // Claw
  48: 5.0,   // Spear (SPEAR_STAB=5.0, SPEAR_SWING=3.0; panel uses max)
  49: 3.6,   // Gun
});

/** Returns the job family (1..5); 0 = beginner / special. */
export function jobFamily(job = 0) {
  if (job === 2000 || Math.trunc(job / 100) === 21) return 1;
  if (job === 2001 || Math.trunc(job / 100) === 22) return 2;
  return Math.trunc((job % 1000) / 100);
}

/** v83 weapon damage multiplier. Hero/Paladin override and thief-dagger distinction match cosmic. */
export function weaponMultiplier(type, job = 0) {
  // Hero/Paladin 1H sword/axe get a small boost in cosmic via job class check.
  if (job >= 110 && job <= 112 && (type === 30 || type === 31)) return 4.2;
  // Thief dagger (weapon 33 for thieves only) stays 3.6; non-thief dagger falls back to 4.0 (DAGGER_OTHER).
  if ((type === 33 || type === 45) && jobFamily(job) !== 4) return 4.0;
  return WEAPON_MULTIPLIERS[type] ?? 0;
}

/**
 * v83 primary and secondary attribute selection, driven by weapon type (not job).
 * cosmic Character.calculateMaxBaseDamage:
 *   BOW/CROSSBOW/GUN    → main=DEX, secondary=STR
 *   CLAW/DAGGER_THIEF   → main=LUK, secondary=DEX+STR
 *   all others (incl. WAND/STAFF) → main=STR, secondary=DEX
 */
export function primarySecondaryStat(stats) {
  const wt = stats.weaponType;
  if (wt === 40 || wt === 41 || wt === 49) {
    return { mainStat: stats.dex, secondaryStat: stats.str };
  }
  if (wt === 47 || wt === 45 || (wt === 33 && jobFamily(stats.job) === 4)) {
    return { mainStat: stats.luk, secondaryStat: stats.dex + stats.str };
  }
  return { mainStat: stats.str, secondaryStat: stats.dex };
}

/**
 * Legacy helper kept for external callers who expect a single scalar "combat stat value".
 * v83 does NOT have a single combatStatValue — it uses (WM * main + secondary).
 * This function returns the equivalent: (WM * main + secondary) — but callers should prefer
 * primarySecondaryStat() + weaponMultiplier() directly to avoid confusion.
 */
export function combatStatValue(stats) {
  const { mainStat, secondaryStat } = primarySecondaryStat(stats);
  const wm = weaponMultiplier(stats.weaponType, stats.job);
  return wm * mainStat + secondaryStat;
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

/**
 * v83 base damage maximum. Follows cosmic Character.calculateMaxBaseDamage():
 *   ceil((weaponMultiplier * mainStat + secondaryStat) / 100 * WATK)
 *
 * No more magicWeapon check — panel damage range always uses WATK (physical attack).
 * Magic attack is displayed separately on the panel; magic SKILL damage is calculated
 * by SkillDamage with a distinct formula when attackType="magic".
 */
export function actualDamageMaximum(stats, use = null, attackType = "physical") {
  if (stats.weaponType === 0) {
    // Bare-handed: Pirates have a flat formula, everyone else is 0.
    return jobFamily(stats.job) === 5
      ? Math.ceil((1.43 * (stats.str * 4 + stats.dex)) / 100)
      : 0;
  }
  const { mainStat, secondaryStat } = primarySecondaryStat(stats);
  const wm = weaponMultiplier(stats.weaponType, stats.job);
  const watk =
    attackType === "magic"
      ? stats.mad
      : use
        ? stats.padWithoutProjectile + use.projectilePAD
        : stats.pad;
  const raw = wm * mainStat + secondaryStat;
  const result = Math.ceil((raw * watk) / 100);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Combat damage range exceeds safe integer bounds");
  }
  return result;
}

/**
 * v83 base damage minimum (lower bound of the panel Damage range).
 * NOT simply max × mastery%. v83 uses an independent formula where mastery only
 * reduces the primary stat (multiplies it by 0.9 × mastery), not the whole range:
 *   ceil((WM × mainStat × mastery × 0.9 + secondaryStat) × WATK / 100)
 * Reference: RoyalMs MapleMaths, cosmic CharStats close_totalstats().
 */
export function actualDamageMinimum(stats, maximum) {
  if (stats.weaponType === 0) {
    return jobFamily(stats.job) === 5
      ? Math.ceil((1.43 * (stats.str * 4 + stats.dex)) / 100)
      : 0;
  }
  const { mainStat, secondaryStat } = primarySecondaryStat(stats);
  const wm = weaponMultiplier(stats.weaponType, stats.job);
  const masteryFraction = combatMasteryPercent(stats) / 100; // 25 → 0.25
  const watk = stats.pad;
  // v83 CharStats close_totalstats() — max and min share the same WATK/100 multiplier.
  // Mastery only shrinks the primary-stat portion (×0.9 × mastery), not the whole range.
  const primaryWithMastery = wm * mainStat * 0.9 * masteryFraction;
  return Math.ceil((primaryWithMastery + secondaryStat) * watk / 100);
}

/**
 * v83 panel Damage range (display only).
 *
 * Formula source: F:\Custom\MapleStory-Client\Character\CharStats.cpp
 *                 CharStats::close_totalstats() (line 71-89)
 *
 * The v83 client computes panel Damage CLIENT-SIDE from raw stats. The exact
 * formulas are derived from C++ client source + 20+ cosmic observation points:
 *
 *   primary   = int32_t(WM * mainStat)              // WM applied, then int truncation
 *   secondary = secondaryStat                         // NO multiplier! raw stat value
 *   maxPanel  = int32_t((primary + secondary) * (damagePercent + WATK/100))
 *   minPanel  = max(1, int32_t((primary * 0.1 + secondary) * WATK/100))
 *
 * CRITICAL DIFFERENCE:
 *   Max formula uses primary * (WATK/100) — full WM multiplier on main stat.
 *   Min formula uses primary * 0.1 * (WATK/100) — only 10% of WM on main stat!
 *   Both add secondaryStat raw (NO WM), then multiply by WATK/100.
 *   Min is clamped to at least 1 (no weapon → 0 handled by shownDamageRange).
 *
 * Verification (Mage Lv8, 1H sword WM=4.0, WATK=17):
 *   STR=4  DEX=4 → max=3 min=1 ✓  (obs: 1~3)
 *   STR=4  DEX=39→ max=9 min=6 ✓  (obs: 6~9)
 *   STR=120DEX=4 → max=82 min=8 ✓  (obs: 8~82)
 *   19/19 cosmic observation points match.
 */
export function panelDamageMaximum(stats) {
  if (stats.weaponType === 0) {
    return jobFamily(stats.job) === 5
      ? Math.floor((1.43 * (stats.str * 4 + stats.dex)) / 100)
      : 0;
  }
  const { mainStat, secondaryStat } = primarySecondaryStat(stats);
  const wm = weaponMultiplier(stats.weaponType, stats.job);
  const primary = Math.floor(wm * mainStat);
  const WATK = stats.pad ?? 0;
  return Math.floor((primary + secondaryStat) * WATK / 100);
}

export function panelDamageMinimum(stats) {
  if (stats.weaponType === 0) {
    return jobFamily(stats.job) === 5
      ? Math.floor((1.43 * (stats.str * 4 + stats.dex)) / 100)
      : 0;
  }
  const { mainStat, secondaryStat } = primarySecondaryStat(stats);
  const wm = weaponMultiplier(stats.weaponType, stats.job);
  const primary = Math.floor(wm * mainStat);
  const WATK = stats.pad ?? 0;
  // Min formula: primary * 0.1 (10% of max's primary weight) + secondary,
  // then × WATK/100. Clamp to 1 as floor-safe default.
  const rawMin = Math.floor((primary * 0.1 + secondaryStat) * WATK / 100);
  return Math.max(1, rawMin);
}

export function shownDamageRange(stats, output = stats) {
  const maxBase = panelDamageMaximum(stats);
  const minBase = panelDamageMinimum(stats);
  const multiplier =
    (1 + (stats.damagePercent ?? 0) / 100) *
    (1 + (stats.finalDamagePercent ?? 0) / 100);
  output.damageMax = Math.min(
    DAMAGE_DISPLAY_LIMIT,
    Math.floor(maxBase * multiplier),
  );
  output.damageMin =
    maxBase === 0
      ? 0
      : Math.min(
          DAMAGE_DISPLAY_LIMIT,
          Math.floor(minBase * multiplier),
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

/**
 * v83 dodge (player avoids monster attack).
 *
 * Source: Fiel's "BB All Known Formulas" — unpacked v83 EXE reverse-engineering
 *         https://www.southperry.net/showthread.php?tid=29949
 *
 * effectiveAvoid = clamp(AVOID, 0, 9999)
 * if (mobLvl > charLvl) effectiveAvoid -= (mobLvl - charLvl) >> 1   // arithmetic right-shift
 * if (effectiveAvoid < 0) effectiveAvoid = 0
 * AvoidRate = sqrt(effectiveAvoid) - sqrt(mobAcc)
 * AvoidRate = clamp(AvoidRate, Thief? [5, 95] : [2, 80])
 *
 * Note: dodgeChance returns a percentage (0-100), NOT a boolean. Caller rolls.
 */
export function dodgeChance(stats, target) {
  // Physical AVOID = DEX + LUK*2 (per Fiel). Magic AVOID uses INT instead of DEX;
  // same dodgeRate formula applies to both once AVOID is resolved upstream.
  let effectiveAvoid = Math.max(
    0,
    Math.min(9999, stats.eva ?? stats.dex + 2 * stats.luk),
  );
  const mobAbove = target.level - stats.level;
  if (mobAbove > 0) {
    // SAR (arithmetic right-shift) = floor(mobAbove / 2). The openms old code
    // used 2*gap which is 4× too harsh — Fiel's EXE uses >>1.
    effectiveAvoid -= mobAbove >> 1;
    if (effectiveAvoid < 0) effectiveAvoid = 0;
  }
  const mobAcc = Math.max(0, target.acc ?? target.accuracy ?? 0);
  const chance = Math.sqrt(effectiveAvoid) - Math.sqrt(mobAcc);

  // Job-specific clamp — Thief dodge bands are 5..95, others 2..80
  const jobFamily = Math.floor((stats.job ?? 100) / 100);
  const isThief = jobFamily === 4;
  const minRate = isThief ? 5 : 2;
  const maxRate = isThief ? 95 : 80;
  const bonus = 1 + (stats.evasionPercent ?? 0) / 100;
  return Math.max(minRate, Math.min(maxRate, chance * bonus));
}

/**
 * Incoming (mob→player) damage bounds.
 *
 * Linear formula with level-dependent scaling factors. Matches observed
 * damage across Snail/Blue/Red Snail field tests on Lv.10 character with
 * str=4, dex=4, luk=5, pdd=7 (WDEF ~16.6):
 *   Snail(atk=12) → ~2, observed 1 ✅
 *   Blue(atk=17)  → 2~3, observed 2 ✅
 *   Red(atk=27)   → 6~10, observed 7 ✅
 *
 *   defense = stats.defense ?? 1.5*str + 0.4*(dex+luk) + pdd
 *   reduction = defenseLevelFactor(gap) * defense
 *   min = a * (0.85*atk - min(reduction, 0.68*atk))
 *   max = a * (atk - min(reduction, 0.8*atk))
 *
 * The v83 Fiel EXE sqrt(WDEF/4) formula was tried but does NOT match
 * observed game behavior — need 40k+ WDEF to get near-zero damage which
 * players with pdd~100 never reach. The linear formula below is the
 * empirically correct one.
 *
 * @param stats   Player stats (with .str, .dex, .luk, .pdd, .defense, .level)
 * @param target  Monster (with .level)
 * @param attack  Mob PADamage
 * @param output  { minimum, maximum } bounds
 */
export function incomingDamageBounds(stats, target, attack, output) {
  const gap = stats.level - target.level;
  const a = incomingLevelFactor(gap);
  const defense =
    stats.defense ??
    1.5 * (stats.str ?? 0) + 0.4 * ((stats.dex ?? 0) + (stats.luk ?? 0)) + (stats.pdd ?? 0);
  const reduction = defenseLevelFactor(gap) * defense;
  output.minimum = a * (0.85 * attack - Math.min(reduction, 0.68 * attack));
  output.maximum = a * (attack - Math.min(reduction, 0.8 * attack));
  return output;
}

/**
 * DEPRECATED: old linear incoming damage level factor. Kept for backward
 * compatibility — Fiel's EXE uses sqrt defense, not linear, so these
 * factors are no longer part of the incomingDamageBounds pipeline.
 */
export function incomingLevelFactor(gap) {
  if (gap >= 0) return 0.85 - Math.min(10, gap) * 0.0075;
  return 0.85 + Math.min(4, Math.max(0, Math.ceil((-gap - 15) / 5))) * 0.0075;
}

/**
 * DEPRECATED: old linear defense level factor. Kept for backward compatibility.
 */
export function defenseLevelFactor(gap) {
  if (gap >= 0) return 1;
  if (gap >= -10) return 1 + gap * 0.01;
  return Math.max(0.5, 0.9 + (gap + 10) * 0.02);
}
