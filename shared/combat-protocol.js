import { COMBAT_VALUE_LIMIT } from "./combat-formulas.js";
import {
  array,
  boolean,
  coordinate,
  enumeration,
  hash,
  id,
  nullable,
  number,
  optional,
  point,
  record,
  string,
  u32,
} from "./schema.js";

const actionName = string(/^[A-Za-z0-9_/-]{1,128}$/, 128);
const duration = number(0, 2147483647, false);
const bundle = record({
  url: string(/^\/generated\/bundles\/[a-f0-9]{64}\.json$/, 128),
  bytes: number(1, 67108864),
  sha256: hash,
});
const skillVisual = record({
  id,
  feedbackId: optional(id),
  sourceId: string(/^[\s\S]{1,256}$/, 256),
  entityId: string(/^[\s\S]{1,256}$/, 256),
  bundle,
  sourceFrame: nullable(number(0, 4095)),
  replacesActor: boolean,
  riding: nullable(
    record({ mount: bundle, saddle: nullable(bundle), anchor: point }),
  ),
  position: point,
  action: actionName,
  elapsedMs: duration,
  playback: enumeration("loop", "once"),
  playbackId: u32,
  scaleX: number(-100, 100, false),
  scaleY: number(-100, 100, false),
  rotation: number(-1000000, 1000000, false),
  opacity: number(0, 1, false),
  tint: number(0, 16777215),
  depth: number(-2147483648, 2147483647),
  // Authored projectile flight plan. An observer that only sampled `position` saw the ball
  // move in acknowledged-snapshot steps; with the plan it integrates the same straight-line
  // path the thrower's local preview and the authority's flight slot both use.
  flight: optional(
    nullable(
      record({
        startX: coordinate,
        startY: coordinate,
        endX: coordinate,
        endY: coordinate,
        durationMs: u32,
        delayMs: u32,
      }),
    ),
  ),
});
const combatState = record({
  modifiers: optional(
    record({
      booster: number(-100, 100),
      speedInfusion: number(-100, 100),
      soulArrow: boolean,
      shadowStars: boolean,
      infinity: optional(boolean),
      concentrate: optional(number(0, 100)),
      shadowPartner: optional(boolean),
    }),
  ),
  feedbackId: optional(nullable(id)),
  inputSeq: optional(nullable(u32)),
  phase: enumeration("idle", "attack", "cast", "hold", "dead"),
  elapsedMs: duration,
  protectionMs: number(-1500, 1500),
  tint: number(0, 16777215),
  braceMs: duration,
  phaseMs: duration,
  attackSpeed: nullable(number(2, 10)),
  recoil: enumeration(
    "none",
    "nonpositive-damage",
    "stance",
    "no-direction",
    "offline-recoil-resistance",
    "ordinary",
  ),
  expression: string(/^[A-Za-z0-9_]{1,32}$/, 32),
  expressionMs: duration,
  movementLocked: boolean,
  actorVisible: boolean,
  opacity: number(0, 1, false),
});
const statusNames = enumeration(
  "stun",
  "freeze",
  "seal",
  "speed",
  "watk",
  "wdef",
  "mdef",
  "accuracy",
  "poison",
  "web",
  "showdown",
  "doom",
  "inert",
  "imprint",
  "venom",
  "sealSkill",
  "ambush",
  "demon",
);

export const COMBAT_ACTION_ROWS = [
  ["skill.release", "character", { skillId: u32 }],
  ["skill.cancel", "character", { skillId: u32 }],
  ["skill.door", "character", {}],
];
export const COMBAT_EPHEMERAL_ACTIONS = new Set([
  "skill.release",
  "skill.cancel",
  "skill.door",
]);
export const COMBAT_ENTITY_FIELDS = {
  combatState: optional(combatState),
  skillVisuals: optional(array(skillVisual, 512)),
  diseases: optional(
    array(record({ id: number(0, 255), remainingMs: duration }), 16),
  ),
  skillVoices: optional(
    array(
      record({
        voiceId: id,
        skillId: u32,
        leaf: string(/^[A-Za-z0-9_/-]{1,128}$/, 128),
      }),
      64,
    ),
  ),
  skillDoor: optional(
    nullable(
      record({ position: point, remainingMs: duration, ready: boolean }),
    ),
  ),
  mobState: optional(
    record({
      hp: u32,
      maxHP: u32,
      opacity: number(0, 1, false),
      level: number(1, 200),
      generation: u32,
      movementType: number(0, 3),
      phase: string(/^[a-z-]{1,64}$/, 64),
      elapsedMs: duration,
      nameRemainingMs: duration,
      nameVisible: boolean,
      bodyVisible: boolean,
      statuses: array(record({ name: statusNames, remainingMs: duration }), 18),
    }),
  ),
};
export const COMBAT_EVENT_SCHEMAS = {
  "combat.impact": record({
    knockback: optional(boolean),
    kind: enumeration("combat.impact"),
    actorId: id,
    targetId: id,
    actionId: id,
    cause: enumeration("basic", "skill", "mob-attack", "contact", "fall"),
    skillId: u32,
    rank: number(0, 32767),
    damage: number(0, COMBAT_VALUE_LIMIT),
    hpDamage: u32,
    mpDamage: u32,
    mesoDamage: u32,
    line: number(0, 120),
    critical: boolean,
    lethal: boolean,
    attackAction: nullable(actionName),
    element: u32,
    position: point,
  }),
  "combat.attack": record({
    feedbackId: optional(nullable(id)),
    inputSeq: optional(nullable(u32)),
    kind: enumeration("combat.attack"),
    actorId: id,
    templateId: nullable(u32),
    action: nullable(actionName),
    weaponSfx: nullable(string(/^[A-Za-z0-9_/-]{1,128}$/, 128)),
  }),
  "combat.reward": record({
    kind: enumeration("combat.reward"),
    actorId: id,
    amount: u32,
    levels: number(0, 200),
  }),
  "combat.level-up": record({
    kind: enumeration("combat.level-up"),
    actorId: id,
  }),
  "combat.recovery": record({
    kind: enumeration("combat.recovery"),
    actorId: id,
    hp: u32,
    mp: u32,
  }),
  "combat.death": record({ kind: enumeration("combat.death"), actorId: id }),
  "combat.disease": record({
    kind: enumeration("combat.disease"),
    actorId: id,
    diseaseId: number(0, 255),
    durationMs: duration,
  }),
  "skill.cast": record({
    kind: enumeration("skill.cast"),
    actorId: id,
    actionId: id,
    skillId: u32,
    rank: number(1, 32767),
    position: point,
  }),
  "skill.visual": record({
    kind: enumeration("skill.visual"),
    actorId: id,
    visual: skillVisual,
  }),
  "skill.sound": record({
    kind: enumeration("skill.sound"),
    feedbackId: optional(id),
    actorId: id,
    voiceId: id,
    skillId: u32,
    leaf: string(/^[A-Za-z0-9_]{1,64}$/, 64),
    loop: boolean,
    stopped: boolean,
  }),
  "skill.magnet": record({
    kind: enumeration("skill.magnet"),
    actorId: id,
    targetId: id,
    success: boolean,
  }),
  "skill.utility": record({
    kind: enumeration("skill.utility"),
    actorId: id,
    window: enumeration("EnchantSkill"),
  }),
};
export const COMBAT_RESULT_SCHEMAS = {
  "skill.cast": record({
    kind: enumeration("skill.cast"),
    skillId: u32,
    rank: number(1, 32767),
    deferred: boolean,
    debitId: optional(id),
    dropPlanId: nullable(id),
    partyEffects: optional(array(record({ actorId: id, hp: u32 }), 128)),
  }),
  "combat.reward": record({
    kind: enumeration("combat.reward"),
    amount: u32,
    levels: number(0, 200),
    dropPlanId: id,
    pickpocketPlanId: nullable(id),
    rewards: optional(
      array(
        record({
          actorId: id,
          amount: u32,
          levels: number(0, 200),
          newlyReady: array(u32, 16384),
        }),
        128,
      ),
    ),
  }),
  "combat.debit": record({ kind: enumeration("combat.debit"), debitId: id }),
  "combat.pickpocket": record({
    kind: enumeration("combat.pickpocket"),
    pickpocketPlanId: id,
  }),
  "combat.incoming": record({
    kind: enumeration("combat.incoming"),
    incomingId: id,
  }),
};
