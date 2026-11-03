import {
  actualDamageMaximum,
  actualDamageMinimum,
  cappedDamage,
  damageBonusMultiplier,
  dodgeChance,
  incomingDamageBounds,
  levelAdjustedDamage,
  monsterDefenseMultiplier,
} from "../../../shared/combat-formulas.js";

const SAMPLE_COUNT = 7;
const UINT32_SCALE = 0x100000000;
const INCOMING_SAMPLE_COUNT = 4;
const UINT32_MAX = UINT32_SCALE - 1;

/** Preserve the existing injectable unsigned random stream and its sampling grid. */
function sample(low, high, value) {
  const minimum = Math.min(low, high);
  return (
    minimum + (value % 10000000) * 0.0000001 * (Math.max(low, high) - minimum)
  );
}

export function physicalTargetError(info) {
  if (!Number.isSafeInteger(info.level) || info.level < 0) {
    return "Target level is unavailable";
  }
  return null;
}

function admitPhysicalDamage(stats, info, skillPercent) {
  if (!stats.damageSupported) {
    throw new Error("Equipped weapon metadata unavailable");
  }
  if (!Number.isSafeInteger(skillPercent) || skillPercent <= 0) {
    throw new Error("Physical skill percentage is unavailable");
  }
  const error = physicalTargetError(info);
  if (error) throw new Error(error);
}

/** Modern formulas with caller-owned scratch and server-private random input. */
export class PhysicalDamage {
  constructor(random = Math.random, nextUint32 = null) {
    if (
      typeof random !== "function" ||
      (nextUint32 !== null && typeof nextUint32 !== "function")
    ) {
      throw new Error("Invalid physical damage random source");
    }
    this.random = random;
    this.nextUint32 = nextUint32;
    this.samples = new Uint32Array(SAMPLE_COUNT);
    this.incomingSamples = new Uint32Array(INCOMING_SAMPLE_COUNT);
    this.incomingBounds = { minimum: 0, maximum: 0 };
    this.lastEvasionChance = 0;
    this.lastEvaded = false;
    this.cursor = SAMPLE_COUNT;
    this.lastGenerated = 0;
    this.lastOutcome = "none";
    this.lastCritical = false;
  }

  next() {
    let value;
    if (this.nextUint32) value = this.nextUint32();
    else {
      const uniform = this.random();
      if (!Number.isFinite(uniform) || uniform < 0 || uniform >= 1) {
        throw new Error("Physical damage RNG must return a value in [0,1)");
      }
      value = Math.floor(uniform * UINT32_SCALE);
    }
    if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
      throw new Error("Physical damage RNG must return uint32");
    }
    return value;
  }

  roll(low, high) {
    if (this.cursor === SAMPLE_COUNT) this.beginTarget();
    return sample(low, high, this.samples[this.cursor++]);
  }

  /** Refill instead of wrapping, so multi-line attacks never recycle earlier hit rolls. */
  beginTarget() {
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      this.samples[index] = this.next();
    }
    this.cursor = 0;
  }

  evades(stats, info) {
    const error = physicalTargetError(info);
    if (error) throw new Error(error);
    for (let index = 0; index < INCOMING_SAMPLE_COUNT; index++) {
      this.incomingSamples[index] = this.next();
    }
    this.lastEvasionChance = dodgeChance(stats, info);
    this.lastEvaded =
      sample(0, 100, this.incomingSamples[0]) < this.lastEvasionChance;
    return this.lastEvaded;
  }

  receive(stats, info, options) {
    if (this.evades(stats, info)) return 0;
    const attack = options.magic
      ? info.MADamage
      : (options.attackPADamage ?? info.PADamage);
    if (!Number.isSafeInteger(attack) || attack < 0) {
      throw new Error("Incoming attack statistic unavailable");
    }
    if (attack === 0) return 0;
    const bounds = incomingDamageBounds(
      stats,
      info,
      attack,
      this.incomingBounds,
    );
    let damage = sample(bounds.minimum, bounds.maximum, this.next());
    damage *= 1 - Math.min(100, stats.damageReductionPercent ?? 0) / 100;
    if (!options.magic) {
      damage *= 1 - Math.min(100, stats.invincible ?? 0) / 100;
    }
    return Math.floor(damage);
  }

  generate(stats, info, skillPercent = 100, use = null) {
    admitPhysicalDamage(stats, info, skillPercent);
    this.beginTarget();
    let damage = (this.weaponDamage(stats, use) * skillPercent) / 100;
    damage *= damageBonusMultiplier(stats, info.boss);
    damage *= monsterDefenseMultiplier(info, stats.ignoreDefensePercent);
    this.lastCritical = this.roll(0, 100) < (stats.criticalChance ?? 0);
    if (this.lastCritical) {
      damage *= 1 + (this.roll(20, 50) + (stats.criticalDamage ?? 0)) / 100;
    }
    damage = levelAdjustedDamage(damage, stats.level, info.level);
    this.lastGenerated = cappedDamage(damage);
    this.lastOutcome = this.lastGenerated > 0 ? "hit" : "nonpositive";
    return this.lastGenerated;
  }

  weaponDamage(stats, use, attackType = "physical") {
    const maximum = actualDamageMaximum(stats, use, attackType);
    return this.roll(actualDamageMinimum(stats, maximum), maximum);
  }
}
