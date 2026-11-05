import {
  actualDamageMaximum,
  cappedDamage,
  combineIgnoreDefense,
  damageBonusMultiplier,
  DAMAGE_LIMIT,
  dotLevelMultiplier,
  elementalMultiplier,
  levelAdjustedDamage,
  monsterDefenseMultiplier,
} from "../../../shared/combat-formulas.js";
import { skillNumber } from "./skill-costs.js";
import {
  elementalEffectiveness,
  hasMobStatus,
  MOB_STATUS,
} from "../combat/mob-skill-status.js";

const AMPLIFICATION = [2110001, 2210001, 12110001, 22150000];
const FINISHER = new Set([
  1111003, 1111004, 1111005, 1111006, 11111002, 11111003,
]);
const COMBO_DAMAGE = [1, 1, 1.2, 1.54, 2, 2.5];
const BARRAGE = new Set([5121007, 15111004]);
const CHARGE_ELEMENTS = new Map([
  [1211003, "f"],
  [1211004, "f"],
  [1211005, "i"],
  [1211006, "i"],
  [1211007, "l"],
  [1211008, "l"],
  [1221003, "h"],
  [1221004, "h"],
  [11111007, "h"],
  [15101006, "l"],
  [21111005, "i"],
]);

export function learnedCombatInfo(hooks, id) {
  const rank = hooks.skillLevel?.(id);
  return rank > 0 ? hooks.skillInfo(id, rank) : null;
}

export function skillLineCount(info) {
  return Math.max(
    skillNumber(info.attackCount, 1),
    skillNumber(info.bulletCount, 1),
  );
}

/** Modern resistance ignores immunity/resistance without reducing elemental weakness. */
export function elementalDamage(damage, target, element, ignore = 0) {
  return (
    damage *
    elementalMultiplier(elementalEffectiveness(target, element), ignore)
  );
}

export function skillDamagePercent(skill, info) {
  if (skill.id === 4211006) {
    return skillNumber(info.damage, skillNumber(info.x, 100));
  }
  if (skill.id === 2301002) return skillNumber(info.hp, 100);
  return skillNumber(
    info.damage,
    skillNumber(info.mad, skillNumber(info.pad, 100)),
  );
}

/** Modern combat formulas; retained Skill.wz supplies ranks, elements and skill percentages. */
export class SkillDamage {
  constructor(generator, hooks) {
    this.generator = generator;
    this.hooks = hooks;
    this.critical = false;
  }

  /** All normal attacks, skills, and character summons use the same modern range. */
  generate(skill, info, mob, context) {
    const target = mob.skillStatus.projected;
    const magic = skillNumber(info.mad) > 0 || skill.id === 2301002;
    this.critical = false;
    if (
      target.invincible ||
      (magic ? target.magicImmune : target.physicalImmune)
    ) {
      return 0;
    }
    const fixed = this.fixedDamage(info, mob, context);
    if (fixed !== null) {
      return cappedDamage(fixed * (context.skillPercentScale ?? 1));
    }
    const percent =
      skillDamagePercent(skill, info) * (context.skillPercentScale ?? 1);
    let damage =
      (this.generator.weaponDamage(context.stats, context.use, magic ? "magic" : "physical") * percent) / 100;
    damage = this.skillModifiers(damage, skill, context, magic);
    damage *= damageBonusMultiplier(context.stats, target.boss);
    damage *= monsterDefenseMultiplier(
      target,
      context.stats.ignoreDefensePercent,
      magic,
    );
    damage = this.criticalDamage(damage, mob, context.stats);
    if (hasMobStatus(mob, "imprint")) {
      damage *= 1 + mob.skillStatus.values[MOB_STATUS.imprint] / 100;
    }
    damage = this.element(skill, damage, target, context);
    damage = levelAdjustedDamage(damage, context.stats.level, target.level);
    const limit =
      skill.id === 3101005 ? (DAMAGE_LIMIT * percent) / 100 : DAMAGE_LIMIT;
    return cappedDamage(damage, limit);
  }

  fixedDamage(info, mob, context) {
    if (skillNumber(info.fixdamage) > 0) return skillNumber(info.fixdamage);
    if (skillNumber(info.damagepc) > 0) {
      return (mob.maxHP * skillNumber(info.damagepc)) / 100;
    }
    return context.kind === "area" ? 0 : null;
  }

  skillModifiers(damage, skill, context, magic) {
    damage = this.stateModifiers(damage, skill, context);
    if (magic) {
      for (const id of AMPLIFICATION) {
        const amp = learnedCombatInfo(this.hooks, id);
        if (amp) {
          damage *= skillNumber(amp.y, 100) / 100;
          break;
        }
      }
    }
    if (BARRAGE.has(skill.id) && context.line > 3) {
      damage *= 2 ** (context.line - 3);
    }
    if (context.chargeMs >= 0) {
      damage *=
        (10 +
          Math.trunc(Math.min(1, context.chargeMs / context.chargeMax) * 90)) /
        100;
    }
    if (context.temporary.berserkFury) {
      damage *= context.temporary.berserkFury / 100;
    }
    return damage;
  }

  /** DOT bypasses mastery, critical, damage bonuses, final damage and monster DEF. */
  dot(skill, info, target, context) {
    if (target.invincible || target.magicImmune) return 0;
    const percent = skillNumber(info.dot, skillDamagePercent(skill, info));
    let damage =
      (actualDamageMaximum(context.stats, context.use) * percent) / 100;
    const ignore = combineIgnoreDefense(
      context.stats.ignoreResistancePercent ?? 0,
      context.temporary?.elementalReset ?? 0,
    );
    damage = elementalDamage(damage, target, skill.properties.elemAttr, ignore);
    damage *= dotLevelMultiplier(context.stats.level, target.level);
    return cappedDamage(damage);
  }

  stateModifiers(damage, skill, context) {
    const temporary = context.temporary;
    const berserk = learnedCombatInfo(this.hooks, 1320006);
    if (berserk && context.hp * 100 <= context.maxHP * skillNumber(berserk.x)) {
      damage *= 1 + skillNumber(berserk.damage) / 100;
    }
    if (FINISHER.has(skill.id)) {
      damage *= COMBO_DAMAGE[Math.min(5, Math.max(0, context.combo - 1))];
    }
    if (temporary.windWalk) damage *= temporary.windWalk / 100;
    const vanish = learnedCombatInfo(this.hooks, 14100005);
    if (temporary.darkSight && vanish) {
      damage *= skillNumber(vanish.damage) / 100;
    }
    return damage;
  }

  criticalDamage(damage, mob, stats) {
    let chance = stats.criticalChance ?? 0;
    let bonus = stats.criticalDamage ?? 0;
    const stun = learnedCombatInfo(this.hooks, 5110000);
    if (stun && hasMobStatus(mob, "stun")) {
      chance += skillNumber(stun.prop);
      bonus += skillNumber(stun.damage) - 100;
    }
    if (chance > 0 && this.generator.roll(0, 100) < chance) {
      this.critical = true;
      damage *= 1 + (this.generator.roll(20, 50) + bonus) / 100;
    }
    return damage;
  }

  element(skill, damage, target, context) {
    const temporary = context.temporary;
    const reset = combineIgnoreDefense(
      context.stats.ignoreResistancePercent ?? 0,
      temporary.elementalReset ?? 0,
    );
    if (skill.id === 2111006) {
      return (
        elementalDamage(damage / 2, target, "f", reset) +
        elementalDamage(damage / 2, target, "s", reset)
      );
    }
    if (skill.id === 2211006) {
      return (
        elementalDamage(damage / 2, target, "i", reset) +
        elementalDamage(damage / 2, target, "l", reset)
      );
    }
    damage = elementalDamage(damage, target, skill.properties.elemAttr, reset);
    const charge = temporary.charge;
    if (!charge) return damage;
    const info = learnedCombatInfo(this.hooks, charge);
    if (!info) return damage;
    return elementalDamage(
      (damage * skillNumber(info.damage, 100)) / 100,
      target,
      CHARGE_ELEMENTS.get(charge),
      reset,
    );
  }
}
