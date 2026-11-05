import { expect, test } from "bun:test";
import { PhysicalDamage } from "../src/combat/physical-damage.js";
import { SkillDamage, elementalDamage } from "../src/skills/skill-damage.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../src/character/character-stats.js";
import {
  actualDamageMaximum,
  actualDamageMinimum,
  shownDamageRange,
  weaponMultiplier,
  combatStatValue,
  combineFinalDamage,
  combineIgnoreDefense,
  monsterDefenseMultiplier,
  levelAdjustedDamage,
  incomingDamageBounds,
  defenseLevelFactor,
  incomingLevelFactor,
  dodgeChance,
  DAMAGE_LIMIT,
} from "../../shared/combat-formulas.js";
import {
  createMobSkillStatus,
  setMobStatus,
} from "../src/combat/mob-skill-status.js";

function stats(overrides = {}) {
  return {
    level: 50,
    job: 100,
    str: 100,
    dex: 20,
    int: 4,
    luk: 4,
    pad: 100,
    mad: 100,
    padWithoutProjectile: 100,
    mastery: 0,
    weaponType: 30,
    criticalChance: 0,
    criticalDamage: 0,
    damageSupported: true,
    ...overrides,
  };
}
function generator(word = 0) {
  return new PhysicalDamage(Math.random, () => word);
}
function target(overrides = {}) {
  const info = { level: 50, acc: 100, eva: 999, PDDamage: 999, ...overrides };
  return {
    hp: 10000,
    maxHP: 10000,
    template: { info },
    skillStatus: createMobSkillStatus(info),
  };
}
function context(overrides = {}) {
  return {
    stats: stats(),
    use: null,
    temporary: {},
    kind: "player",
    hp: 100,
    maxHP: 100,
    combo: 0,
    line: 0,
    chargeMs: -1,
    ...overrides,
  };
}
const HOOKS = { skillLevel: () => 0, skillInfo: () => null };
const BASIC = { id: 0, properties: {} };

test("modern weapon multipliers retain Hero and Paladin overrides", () => {
  expect(
    [30, 31, 32, 33, 37, 38, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49].map(
      (type) => weaponMultiplier(type),
    ),
  ).toEqual([
    1.24, 1.2, 1.2, 1.3, 1.2, 1.2, 1.34, 1.34, 1.34, 1.49, 1.49, 1.3, 1.35,
    1.75, 1.7, 1.5,
  ]);
  expect(weaponMultiplier(30, 112)).toBe(1.34);
  expect(weaponMultiplier(40, 112)).toBe(1.44);
  expect(weaponMultiplier(32, 122)).toBe(1.24);
});

test("job primary and secondary stats distinguish magic, claw, dagger and guns", () => {
  const input = stats({ str: 10, dex: 20, int: 30, luk: 40 });
  const jobs = [
    [100, 30, 60],
    [200, 37, 160],
    [300, 45, 90],
    [410, 47, 180],
    [420, 33, 190],
    [520, 49, 90],
    [510, 48, 60],
    [1200, 38, 160],
    [2110, 44, 60],
    [2200, 38, 160],
  ];
  for (const [job, weaponType, value] of jobs) {
    expect(combatStatValue({ ...input, job, weaponType })).toBe(value);
  }
});

test("display rounds the actual range before damage and final damage bonuses", () => {
  const input = stats({ damagePercent: 20, finalDamagePercent: 50 });
  expect(actualDamageMaximum(input)).toBe(521);
  expect(actualDamageMinimum(input, 521)).toBe(104);
  const output = {};
  shownDamageRange(input, output);
  expect(output).toEqual({ damageMin: 188, damageMax: 937 });
  expect(actualDamageMinimum(stats({ mastery: 100 }), 1000)).toBe(990);
  expect(
    actualDamageMaximum(
      stats({ job: 200, weaponType: 37, int: 100, luk: 20, pad: 9999 }),
    ),
  ).toBe(504);
});

test("unarmed range is zero except for pirates", () => {
  expect(actualDamageMaximum(stats({ weaponType: 0 }))).toBe(0);
  expect(actualDamageMaximum(stats({ job: 500, weaponType: 0 }))).toBe(6);
});

test("normal hits use percentage DEF, no obsolete accuracy roll or flat DEF subtraction", () => {
  const input = stats();
  expect(generator().generate(input, target().skillStatus.projected)).toBe(114);
  expect(
    generator().generate(input, target({ PDRate: 50 }).skillStatus.projected),
  ).toBe(57);
  expect(generator().generate(input, target().skillStatus.projected, 200)).toBe(
    228,
  );
  expect(
    generator(9999999).generate(input, target().skillStatus.projected),
  ).toBe(573);
});

test("normal and boss bonuses add to damage while final damage and IED multiply", () => {
  expect(combineFinalDamage(20, 30)).toBeCloseTo(56);
  expect(combineIgnoreDefense(30, 40)).toBeCloseTo(58);
  expect(monsterDefenseMultiplier({ PDRate: 300 }, 70)).toBeCloseTo(0.1);
  expect(monsterDefenseMultiplier({ PDRate: 900 }, 90)).toBeCloseTo(0.5);
  expect(monsterDefenseMultiplier({ PDRate: 300 }, 50)).toBe(0);
  const input = stats({
    damagePercent: 20,
    bossDamagePercent: 50,
    normalDamagePercent: 10,
    finalDamagePercent: 50,
  });
  expect(generator().generate(input, target().skillStatus.projected)).toBe(223);
  expect(
    generator().generate(input, target({ boss: 1 }).skillStatus.projected),
  ).toBe(291);
});

test("level advantage follows all boundary bands and truncates only the penalty amount", () => {
  const rows = [
    [10, 1200],
    [5, 1200],
    [0, 1100],
    [-1, 1053],
    [-2, 1007],
    [-3, 962],
    [-4, 918],
    [-5, 875],
    [-39, 25],
    [-40, 0],
    [-60, 0],
  ];
  for (const [gap, damage] of rows) {
    expect(levelAdjustedDamage(1000, 100 + gap, 100)).toBeCloseTo(damage);
  }
  expect(levelAdjustedDamage(19, 99, 100)).toBeCloseTo(20.52);
});

test("skill attacks, magic and summons share the standard range and per-hit critical multiplier", () => {
  const damage = new SkillDamage(generator(), HOOKS);
  const ctx = context();
  expect(damage.generate(BASIC, { damage: 200 }, target(), ctx)).toBe(228);
  ctx.kind = "summon";
  expect(damage.generate(BASIC, { pad: 200 }, target(), ctx)).toBe(228);
  ctx.kind = "player";
  ctx.stats = stats({
    job: 200,
    weaponType: 37,
    int: 100,
    luk: 20,
    criticalChance: 100,
    criticalDamage: 30,
  });
  // 504 upper *25% mastery =126; 200% skill *150% critical *110% level.
  expect(damage.generate(BASIC, { mad: 200 }, target(), ctx)).toBe(415);
  expect(damage.critical).toBe(true);
});

test("native Lucky Seven and Snipe formulas no longer bypass the modern range", () => {
  const damage = new SkillDamage(generator(), HOOKS);
  const ctx = context({ stats: stats({ job: 410, weaponType: 47, luk: 100 }) });
  const ordinary = damage.generate(BASIC, { damage: 150 }, target(), ctx);
  expect(
    damage.generate(
      { id: 4001344, properties: {} },
      { damage: 150 },
      target(),
      ctx,
    ),
  ).toBe(ordinary);
  expect(
    damage.generate(
      { id: 3221007, properties: {} },
      { damage: 150 },
      target(),
      ctx,
    ),
  ).toBe(ordinary);
});

test("elemental resistance and immunity honor ignore resistance; weakness remains 150%", () => {
  for (const [element, expected] of [
    ["f", 50],
    ["i", 75],
    ["l", 150],
    ["s", 100],
  ]) {
    expect(elementalDamage(100, { elemAttr: "F1I2L3" }, element, 50)).toBe(
      expected,
    );
  }
  expect(elementalDamage(1000000, { elemAttr: "F3" }, "f", 100)).toBe(1500000);
});

test("DOT uses upper actual damage and excludes mastery, crit, DEF and damage boosts", () => {
  const damage = new SkillDamage(generator(), HOOKS);
  const ctx = context({
    stats: stats({
      damagePercent: 500,
      finalDamagePercent: 500,
      masteryPercent: 99,
      criticalChance: 100,
    }),
  });
  expect(
    damage.dot(
      BASIC,
      { dot: 200 },
      target({ PDRate: 500 }).skillStatus.projected,
      ctx,
    ),
  ).toBe(1042);
  const immune = { id: 1, properties: { elemAttr: "f" } };
  expect(
    damage.dot(
      immune,
      { dot: 200 },
      target({ elemAttr: "F1" }).skillStatus.projected,
      ctx,
    ),
  ).toBe(0);
});

test("fixed and proportional skill damage bypass ordinary range bonuses", () => {
  const damage = new SkillDamage(generator(), HOOKS);
  expect(damage.generate(BASIC, { fixdamage: 7 }, target(), context())).toBe(7);
  expect(damage.generate(BASIC, { damagepc: 10 }, target(), context())).toBe(
    1000,
  );
});

test("large hits reach modern cap and successive attack lines refill random words", () => {
  const damage = new SkillDamage(generator(9999999), HOOKS);
  expect(
    damage.generate(
      BASIC,
      { damage: 1000 },
      target(),
      context({ stats: stats({ str: 10000000, pad: 10000000 }) }),
    ),
  ).toBe(DAMAGE_LIMIT);
  let draws = 0;
  const random = new PhysicalDamage(Math.random, () => ++draws);
  random.beginTarget();
  const rolls = [];
  for (let i = 0; i < 14; i++) rolls.push(random.roll(0, 10000000));
  expect(rolls[0]).toBe(1);
  expect(rolls[7]).toBe(8);
  expect(draws).toBe(14);
});

test("monster attack is linear and defense reductions have separate 68% and 80% caps", () => {
  const input = stats({ str: 0, dex: 0, luk: 0, pdd: 0 });
  const mob = target().skillStatus.projected;
  const bounds = {};
  incomingDamageBounds(input, mob, 1000, bounds);
  expect(bounds.minimum).toBeCloseTo(722.5);
  expect(bounds.maximum).toBeCloseTo(850);
  input.pdd = 1000;
  incomingDamageBounds(input, mob, 1000, bounds);
  expect(bounds.minimum).toBeCloseTo(144.5);
  expect(bounds.maximum).toBeCloseTo(170);
  input.level += 10;
  incomingDamageBounds(input, mob, 1000, bounds);
  expect(bounds.maximum).toBeCloseTo(155);
});

test("incoming level factors match table boundaries", () => {
  for (const [gap, a, b] of [
    [10, 0.775, 1],
    [0, 0.85, 1],
    [-10, 0.85, 0.9],
    [-11, 0.85, 0.88],
    [-15, 0.85, 0.8],
    [-16, 0.8575, 0.78],
    [-20, 0.8575, 0.7],
    [-21, 0.865, 0.68],
    [-30, 0.8725, 0.5],
    [-31, 0.88, 0.5],
  ]) {
    expect(incomingLevelFactor(gap)).toBeCloseTo(a);
    expect(defenseLevelFactor(gap)).toBeCloseTo(b);
  }
});

test("physical and magic dodge use DEX, LUK, accuracy and level with a 90% cap", () => {
  expect(dodgeChance(stats({ dex: 100, luk: 0 }), { level: 50, acc: 0 })).toBe(
    10,
  );
  expect(dodgeChance(stats({ dex: 100, luk: 0 }), { level: 51, acc: 0 })).toBe(
    8,
  );
  expect(
    dodgeChance(stats({ dex: 100000, luk: 0 }), { level: 50, acc: 0 }),
  ).toBe(90);
  expect(dodgeChance(stats({ dex: 0, luk: 0 }), { level: 50, acc: 100 })).toBe(
    0,
  );
  expect(
    generator().evades(stats({ dex: 100, luk: 0 }), { level: 50, acc: 0 }),
  ).toBe(true);
});

test("incoming magic shares defense and damage reduction; Invincible stays physical", () => {
  const input = stats({ str: 0, dex: 0, luk: 0, pdd: 0, invincible: 20 });
  const mob = { level: 50, acc: 100, PADamage: 1000, MADamage: 1000 };
  expect(generator().receive(input, mob, { magic: false })).toBe(578);
  expect(generator().receive(input, mob, { magic: true })).toBe(722);
  input.damageReductionPercent = 50;
  expect(generator().receive(input, mob, { magic: true })).toBe(361);
});

function projectionFixture() {
  const profile = {
    level: 50,
    job: 200,
    str: 4,
    dex: 4,
    int: 100,
    luk: 20,
    maxHP: 50,
    maxMP: 50,
    skills: { 2001004: { level: 1 } },
    inventory: [],
    equipment: [
      { id: 1372000, slot: -11 },
      { id: 1002000, slot: -1 },
    ],
  };
  const items = {
    1372000: {
      info: {
        incMAD: 2000,
        incPDD: 10,
        finalDamagePercent: 20,
        ignoreDefensePercent: 30,
      },
    },
    1002000: {
      info: {
        incMAD: 10,
        incPDD: 20,
        finalDamagePercent: 30,
        ignoreDefensePercent: 40,
      },
    },
  };
  const hooks = {
    items,
    skillLevel: (id) => (id === 2001004 ? 1 : 0),
    skillInfo: () => ({ mastery: 10 }),
  };
  return { profile, hooks };
}

test("projection separates INT from magic attack and publishes the modern range inputs", () => {
  const { profile, hooks } = projectionFixture();
  const output = projectCharacterStats(profile, hooks, createCharacterStats());
  expect(output.mad).toBe(2010);
  expect(output.defense).toBe(45);
  expect(output.mdd).toBe(output.pdd);
  expect(output.masteryPercent).toBe(75);
  expect(output.criticalChance).toBe(0);
  expect(output.criticalDamage).toBe(0);
  expect(output.finalDamagePercent).toBeCloseTo(56);
  expect(output.ignoreDefensePercent).toBeCloseTo(58);
  projectCharacterStats(profile, hooks, output);
  expect(output.defense).toBe(45);
  expect(output.finalDamagePercent).toBeCloseTo(56);
});

test("critical chance requires a learned weapon-compatible passive or active Sharp Eyes", () => {
  const { profile, hooks } = projectionFixture();
  const output = createCharacterStats();
  expect(output.criticalChance).toBe(0);
  profile.job = 300;
  profile.equipment[0].id = 1452000;
  hooks.items[1452000] = { info: { incPAD: 20 } };
  let learned = false;
  hooks.skillLevel = (id) => (learned && id === 3000001 ? 1 : 0);
  hooks.skillInfo = () => ({ prop: 40, damage: 200 });
  projectCharacterStats(profile, hooks, output);
  expect(output.criticalChance).toBe(0);
  learned = true;
  projectCharacterStats(profile, hooks, output);
  expect(output.criticalChance).toBe(40);
  profile.equipment[0].id = 1372000;
  projectCharacterStats(profile, hooks, output);
  expect(output.criticalChance).toBe(0);
  hooks.derivedStats = () => ({ sharpEyes: (15 << 8) | 20 });
  projectCharacterStats(profile, hooks, output);
  expect(output.criticalChance).toBe(15);
  hooks.derivedStats = () => null;
  projectCharacterStats(profile, hooks, output);
  expect(output.criticalChance).toBe(0);
});

test("missing critical stats never grant implicit criticals, even on a zero RNG roll", () => {
  const player = stats();
  delete player.criticalChance;
  const physical = generator();
  physical.generate(player, target().skillStatus.projected);
  expect(physical.lastCritical).toBe(false);
  const skills = new SkillDamage(generator(), HOOKS);
  skills.generate(BASIC, { damage: 100 }, target(), context({ stats: player }));
  expect(skills.critical).toBe(false);
});

test("Stun Mastery only grants critical chance while the learned skill's target is stunned", () => {
  let learned = false;
  const damage = new SkillDamage(generator(), {
    skillLevel: (id) => (learned && id === 5110000 ? 1 : 0),
    skillInfo: () => ({ prop: 100, damage: 200 }),
  });
  const mob = target();
  damage.generate(BASIC, { damage: 100 }, mob, context());
  expect(damage.critical).toBe(false);
  learned = true;
  damage.generate(BASIC, { damage: 100 }, mob, context());
  expect(damage.critical).toBe(false);
  setMobStatus(mob, "stun", 1, { source: 1, duration: 1000 });
  damage.generate(BASIC, { damage: 100 }, mob, context());
  expect(damage.critical).toBe(true);
  learned = false;
  damage.generate(BASIC, { damage: 100 }, mob, context());
  expect(damage.critical).toBe(false);
});

test("shadow skill percentage applies before the damage cap and Arrow Bomb scales its own cap", () => {
  const damage = new SkillDamage(generator(9999999), HOOKS);
  const ctx = context({
    stats: stats({ str: 10000000, pad: 10000000 }),
    skillPercentScale: 0.5,
  });
  expect(damage.generate(BASIC, { damage: 1000 }, target(), ctx)).toBe(
    DAMAGE_LIMIT,
  );
  ctx.skillPercentScale = 1;
  expect(
    damage.generate(
      { id: 3101005, properties: {} },
      { damage: 525 },
      target(),
      ctx,
    ),
  ).toBe(DAMAGE_LIMIT * 5.25);
  const meso = damage.generate(
    { id: 4211006, properties: {} },
    { x: 200 },
    target(),
    context(),
  );
  expect(meso).toBe(1146);
});

test("percentage defense debuffs preserve fractional rates", () => {
  const mob = target({ PDRate: 33, MDRate: 27 });
  mob.template = { info: { ...mob.skillStatus.projected } };
  setMobStatus(mob, "wdef", -50, { source: 1, duration: 1000 });
  expect(mob.skillStatus.projected.PDRate).toBe(16.5);
  expect(mob.skillStatus.projected.MDRate).toBe(27);
});
