import {
  baseMasteryPercent,
  combineFinalDamage,
  combineIgnoreDefense,
  jobFamily,
} from "../../../shared/combat-formulas.js";

const BONUS_FIELDS = Object.freeze([
  "damagePercent",
  "bossDamagePercent",
  "normalDamagePercent",
  "finalDamagePercent",
  "ignoreDefensePercent",
  "ignoreResistancePercent",
  "evasionPercent",
  "damageReductionPercent",
  "defensePercent",
]);

export function initializeCombatStats(output) {
  for (const key of BONUS_FIELDS) output[key] = 0;
  output.masteryPercent = 20;
  output.defense = 0;
}

function addBonus(output, key, value) {
  if (!Number.isFinite(value) || value < 0 || value > 10000) {
    throw new Error(`Invalid authored combat percentage: ${key}`);
  }
  if (key === "finalDamagePercent") {
    output[key] = combineFinalDamage(output[key], value);
  } else if (
    key === "ignoreDefensePercent" ||
    key === "ignoreResistancePercent" ||
    key === "damageReductionPercent"
  ) {
    output[key] = combineIgnoreDefense(output[key], Math.min(100, value));
  } else output[key] += value;
  if (!Number.isFinite(output[key]) || output[key] > Number.MAX_SAFE_INTEGER) {
    throw new Error("Combat percentage exceeds safe numeric bounds");
  }
}

/** Optional modern percentages are authored content, never client movement values. */
function projectBonuses(profile, hooks, temporary, output) {
  for (const key of BONUS_FIELDS) output[key] = 0;
  for (const entry of profile.equipment) {
    const info = hooks.items[entry.id].info;
    for (const key of BONUS_FIELDS) {
      if (info[key] !== undefined) addBonus(output, key, info[key]);
    }
  }
  for (const key of BONUS_FIELDS) {
    if (temporary?.[key] !== undefined) addBonus(output, key, temporary[key]);
  }
}

/** v83 stores spell mastery per learned attack; use the strongest owned value. */
function magicMastery(profile, hooks) {
  let mastery = 0;
  for (const id in profile.skills) {
    const rank = hooks.skillLevel(Number(id));
    if (!rank) continue;
    const info = hooks.skillInfo(Number(id), rank);
    if (!info) throw new Error(`Learned spell metadata unavailable: ${id}`);
    const value = Number(info.mastery ?? 0);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error("Invalid spell mastery");
    }
    mastery = Math.max(mastery, value);
  }
  return mastery;
}

/** Bounded validated profile; identical server/offline stat projection. */
export function projectModernCombatStats(profile, hooks, temporary, output) {
  projectBonuses(profile, hooks, temporary, output);
  const raw =
    jobFamily(profile.job) === 2
      ? magicMastery(profile, hooks)
      : output.mastery;
  output.masteryPercent = Math.min(99, baseMasteryPercent(output) + raw * 5);

  // v83: PDD = pure equipment + buffs, no attribute weights.
  // Output already has equipment incPDD added by equipmentBonuses(); shield mastery adds to it.
  // No STR×1.5 + DEX/LUK×0.4 formula (removed — that was modern ruleset).
  // PDD/MDD are independent; MDD gets INT/LUK weights per original panel formula.
}
