import {
  overlaps,
  placeBody,
  rectangleState,
  sweepBody,
} from "../world/life-geometry-numeric.js";
import { knockbackChance } from "./combat-knockback.js";
import { MOB_HIT } from "./mob-hit.js";
import { mobFlipped, mobMovementMetadata } from "./mob-movement-metadata.js";
import {
  createMobFlight,
  moveMobFlightRecoil,
  resetMobFlight,
  stepMobFlight,
  stepMobFlightClock,
} from "./offline-mob-flight.js";
import {
  createMobSkillStatus,
  clearMobSkillStatus,
  stepMobSkillStatus,
  mobSkillMovementScale,
  hasMobStatus,
} from "./mob-skill-status.js";

export const MOB_POLICY = Object.freeze({
  authority: "offline-local-policy",
  walkPixelsPerSecondAtSpeedZero: 60,
  respawnMs: 10000,
  attackCooldownMs: 2400,
  recoveryMs: 5000,
  maxTransitions: 32,
  specialMovement:
    "stationary: original controller0 or unavailable ground contact",
  flightRoaming:
    "native controller3 waypoints, forces, speed and bounds; deterministic local seeds and single-player aggro admission",
  mobTime: "preserved, not interpreted as respawn seconds",
});
/** 00663070..0066313e: new-spawn mode-2 alpha0→255 over800ms.
 * Existing-enter mode-1 is opaque; death alpha belongs to the WZ die frames. */
export const MOB_APPEARANCE = Object.freeze({ spawnMs: 800 });
/** 0066bb1a/009bbdfd: ordinary hit velocity, braking force and base ability mass.
 *  Re-exported so the authority and the attacker's local prediction share one source. */
export { MOB_HIT } from "./mob-hit.js";
/** Cosmic MonsterAggroCoordinator/config.yaml, not the native 180–240s target lease. */
export const MOB_AGGRO = Object.freeze({
  updateMs: 5000,
  damageLifetimeMs: 120000,
});
/** Mob jump physics. Values mirror sdlms mob_logic_system constexprs — the mob uses
 *  its own gravity/jump speeds since it does not share the player Physics.img. */
export const MOB_JUMP = Object.freeze({
  /** Gravity in px/s². Positive accelerates downward (y grows downward). */
  gravity: 900,
  /** Jump launch velocity in px/s (negative = upward). */
  jumpSpeed: -300,
  /** Minimum foothold edge gap tolerated when landing (px). */
  landingTolerance: 8,
  /** AI decision interval random ranges (ms). */
  idleMinMs: 600,
  idleRangeMs: 1600, // 600..2200
  walkMinMs: 1200,
  walkRangeMs: 1800, // 1200..3000
  /** Probability thresholds — roll 0..99 each decision. */
  jumpChanceRoll: 18, // 0..17 jumps (18%)
  walkChanceRoll: 60, // 18..59 walks (42%) — after jump branch
});
const MAX_MOBS = 4096;
const MAX_ACTIONS = 128;
const MAX_FRAMES = 1024;

// Life geometry is shared with the browser's own presentation; the authority half of this
// module must not be the only home for a rectangle test the online graph is allowed to use.
export { overlaps, rectangleState };

/** Compile original frame delays once; unknown timing remains frozen.
 *  Mob move actions receive a ping-pong frame expansion so the authored
 *  forward-sway cycle (0→1→2→3→0) becomes a natural back-and-forth sway
 *  (0→1→2→3→2→1→0). This eliminates the hard snap at the end of a linear
 *  loop and makes per-frame origin shifts (body offset animation in Mob.wz)
 *  look like smooth walking motion rather than sprite jitter. */
export function compileActions(template) {
  const actions = Object.create(null);
  const entries = Object.entries(template.actions);
  validateMobInfo(template.info);
  if (entries.length > MAX_ACTIONS) throw new Error("Mob action limit");
  for (const [name, source] of entries) {
    if (!source.frames.length || source.frames.length > MAX_FRAMES) {
      throw new Error("Mob frame limit");
    }
    // Ping-pong expand mob move actions with known timing and ≥3 frames:
    // [f0, f1, f2, f3] → [f0, f1, f2, f3, f2, f1, f0]  (2n−1 entries)
    // Full symmetric loop so end→start wraps seamlessly at f0.
    // stand/hit/die keep their natural linear loop — they don't sway.
    const isPingPong =
      template.kind === "mob" &&
      name === "move" &&
      source.timingKnown &&
      source.frames.length > 2;
    const frames = isPingPong
      ? expandPingPong(source.frames)
      : source.frames;
    const ends = new Float64Array(frames.length);
    let duration = 0;
    for (let index = 0; index < frames.length; index++) {
      const delay = frames[index].delayMs;
      validateBody(frames[index].body);
      if (source.timingKnown && (!Number.isFinite(delay) || delay <= 0)) {
        throw new Error("Invalid mob delay");
      }
      duration += source.timingKnown ? delay : 0;
      ends[index] = duration;
    }
    actions[name] = { ends, duration, frames };
  }
  return actions;
}

function expandPingPong(frames) {
  const n = frames.length;
  const out = new Array(2 * n - 1);
  for (let i = 0; i < n; i++) out[i] = frames[i];
  for (let i = 1; i < n; i++) out[n + i - 1] = frames[n - 1 - i];
  return out;
}

function validateBody(body) {
  if (!body) return;
  if (
    ![body.left, body.top, body.right, body.bottom].every(Number.isFinite) ||
    body.left > body.right ||
    body.top > body.bottom
  ) {
    throw new Error("Invalid original mob body");
  }
}

function validateMobInfo(info) {
  for (const key of [
    "maxHP",
    "maxMP",
    "PADamage",
    "PDDamage",
    "PDRate",
    "MDRate",
    "MADamage",
    "level",
    "acc",
    "eva",
    "exp",
    "pushed",
    "hpRecovery",
    "mpRecovery",
  ]) {
    if (
      info[key] !== undefined &&
      (!Number.isSafeInteger(info[key]) || info[key] < 0)
    ) {
      throw new Error("Invalid original mob statistic");
    }
  }
  if (
    info.speed !== undefined &&
    (!Number.isSafeInteger(info.speed) || Math.abs(info.speed) > 1000000)
  ) {
    throw new Error("Invalid original mob speed");
  }
}

/** Stable state exists for every authored mob, including explicitly inactive records. */
export function createMobs(life, simulation) {
  if (
    !life ||
    !Array.isArray(life.placements) ||
    life.placements.length > MAX_MOBS
  ) {
    throw new Error("Invalid offline mob placements");
  }
  const definitions = new Map();
  const mobs = [];
  const ids = new Set();
  for (const record of life.placements) {
    if (record.kind !== "mob") continue;
    if (![record.authored.x, record.authored.y].every(Number.isSafeInteger)) {
      throw new Error("Invalid mob origin");
    }
    if (ids.has(record.id)) throw new Error("Duplicate local mob identity");
    ids.add(record.id);
    const template = life.templates[record.template];
    if (!template || template.kind !== "mob") {
      throw new Error("Missing mob template");
    }
    if (!definitions.has(record.template)) {
      definitions.set(
        record.template,
        normalizeMobTemplate(template, compileActions(template)),
      );
    }
    mobs.push(
      createMob(record, template, definitions.get(record.template), simulation),
    );
  }
  return mobs;
}

/** Normalize inputs already checked by compileActions/validateMobInfo, before play. */
function normalizeMobTemplate(template, actions) {
  const info = template.info;
  const maxHP = info.maxHP ?? 0;
  const maxMP = info.maxMP ?? 0;
  const movement = mobMovementMetadata(info, actions);
  return {
    actions,
    movementType: movement.type,
    flySpeedPercent: movement.flySpeedPercent,
    canJump: movement.canJump,
    maxHP,
    maxMP,
    defaultAction:
      movement.type === 3
        ? "fly"
        : (template.defaultAction ?? Object.keys(actions)[0] ?? null),
    selectedSkills: template.combat?.allowedSkills ?? [],
    attacks: template.combat?.attacks ?? [],
    speed:
      (MOB_POLICY.walkPixelsPerSecondAtSpeedZero *
        Math.max(0, 100 + (info.speed ?? 0))) /
      100,
  };
}

/** Controller3 is airborne even when its authored placement names a foothold. */
function mobContact(authored, definition, geometry) {
  const foothold = geometry.byId.get(authored.fh) ?? null;
  if (definition.movementType === 3) {
    return { foothold: null, movement: "flying-patrol" };
  }
  const ground =
    foothold &&
    foothold.dx > 0 &&
    Number.isFinite(authored.rx0) &&
    Number.isFinite(authored.rx1) &&
    authored.rx0 <= authored.rx1;
  const movement =
    ground && definition.movementType > 0
      ? "ground-patrol"
      : "stationary-special";
  return { foothold, movement };
}

/** Preserve admission precedence: artwork, positive HP, then authored gates. */
function mobInactiveReason(record, template, definition) {
  if (!definition.defaultAction) return "unavailable-original-artwork";
  if (!definition.maxHP) return "unavailable-positive-original-maxHP";
  const authored = record.authored;
  if (
    authored.hide === 1 ||
    !!authored.limitedname ||
    template.info.inactive === 1
  ) {
    return "inactive-authored-gate";
  }
  return null;
}

/** Ground patrol starts on its original segment; special movement stays authored. */
function mobSpawn(authored, contact) {
  const { foothold, movement } = contact;
  let x = authored.x;
  let y = authored.y;
  if (movement === "ground-patrol") {
    x = Math.max(foothold.x1, Math.min(foothold.x2, x));
    y = groundY(foothold, x);
  }
  const facing = authored.f === 0 ? 1 : -1;
  return {
    x,
    y,
    previousX: x,
    previousY: y,
    facing,
    spawnFacing: facing,
    foothold,
    spawnFoothold: foothold,
    spawnX: x,
    spawnY: y,
    movement,
  };
}

/** Allocate every mutable timer and geometry scratch record before play. */
function mobInitialState(definition, inactiveReason) {
  const active = !inactiveReason;
  return {
    hp: definition.maxHP,
    mp: definition.maxMP,
    alive: active,
    visible: active,
    active,
    state: inactiveReason ?? "idle",
    inactiveReason,
    action: definition.defaultAction,
    actionMs: 0,
    frame: 0,
    stateMs: 0,
    respawnMs: 0,
    spawnMs: MOB_APPEARANCE.spawnMs,
    opacity: 1,
    cooldownMs: MOB_POLICY.attackCooldownMs,
    recoveryMs: 0,
    hitRemainingMs: 0,
    knockbackMs: 0,
    knockbackSpeed: 0,
    knockbackFacing: 0,
    knockbackDeceleration: MOB_HIT.deceleration,
    lastReaction: "none",
    aggro: {
      damageInstances: 0,
      expireStreak: 0,
      ticksRemaining: 0,
      updateMs: 0,
    },
    pendingAttack: null,
    attackFired: false,
    attackIndex: 0,
    body: rectangleState(),
    sweptBody: rectangleState(),
    attackBody: rectangleState(),
    delta: { x: 0, y: 0 },
    deaths: 0,
    lastDamage: 0,
    // Local-player attack timestamp: 0066b05e; expiry gate 006675a8/006689e3.
    nameRemainingMs: 0,
    nameLabel: null,
    presentation: null,
    fault: null,
    // Jump / airborne physics fields. All ground mobs start on the ground;
    // gravity and landing only activate when `onGround` flips false.
    vy: 0,
    onGround: true,
    /** Countdown until next idle AI decision (ms). 0 = decide now. */
    jumpDecisionMs: 0,
  };
}

function createMob(record, template, definition, simulation) {
  const contact = mobContact(record.authored, definition, simulation.geometry);
  const inactiveReason = mobInactiveReason(record, template, definition);
  const mob = {
    id: record.id,
    templateId: Number(template.originalId),
    record,
    template,
    ...definition,
    ...mobSpawn(record.authored, contact),
    ...mobInitialState(definition, inactiveReason),
    skillStatus: createMobSkillStatus(template.info),
    flight: createMobFlight(record, definition, simulation),
  };
  updateMobBody(mob);
  return mob;
}

function groundY(segment, x) {
  return segment.y1 + ((x - segment.x1) * segment.dy) / segment.dx;
}

export function setMobAction(mob, name) {
  if (!mob.actions[name]) name = mob.defaultAction;
  if (mob.action === name) return;
  mob.action = name;
  mob.actionMs = 0;
  mob.frame = 0;
}

function advanceMobAction(mob, ms) {
  const action = mob.actions[mob.action];
  mob.actionMs += ms;
  if (!action.duration) {
    mob.frame = 0;
    return;
  }
  const once =
    !mob.alive ||
    mob.state === "spawning" ||
    mob.state === "hit" ||
    mob.state === "attack";
  const elapsed = once
    ? Math.min(action.duration - 0.001, mob.actionMs)
    : mob.actionMs % action.duration;
  for (let index = 0; index < action.ends.length; index++) {
    if (elapsed < action.ends[index]) {
      mob.frame = index;
      return;
    }
  }
}

export function updateMobBody(mob) {
  const local = mob.alive
    ? mob.actions[mob.action]?.frames[mob.frame]?.body
    : null;
  placeBody(mob.body, local, mob, mobFlipped(mob));
  mob.delta.x = mob.previousX - mob.x;
  mob.delta.y = mob.previousY - mob.y;
  sweepBody(mob.sweptBody, mob.body, mob.delta);
}

/** Preserve state offscreen; artwork residency never gates simulation. */
export function stepMob(mob, ms, target = null, onDamage = null) {
  mob.previousX = mob.x;
  mob.previousY = mob.y;
  if (!mob.active || mob.fault) return;
  mob.stateMs += ms;
  mob.nameRemainingMs = Math.max(0, mob.nameRemainingMs - ms);
  if (mob.spawnMs < MOB_APPEARANCE.spawnMs) {
    mob.spawnMs = Math.min(MOB_APPEARANCE.spawnMs, mob.spawnMs + ms);
    mob.opacity =
      Math.trunc((255 * mob.spawnMs) / MOB_APPEARANCE.spawnMs) / 255;
  }
  if (!mob.alive) {
    stepDeadMob(mob, ms);
    return;
  }
  stepMobSkillStatus(mob, ms, onDamage);
  mob.hitRemainingMs = Math.max(0, mob.hitRemainingMs - ms);
  stepMobAggro(mob, ms, target);
  mob.cooldownMs = Math.max(0, mob.cooldownMs - ms);
  finishMobPose(mob);
  stepMobMotion(mob, ms, target);
  if (mob.flight) stepMobFlightClock(mob.flight, ms);
  recoverMob(mob, ms);
  advanceMobAction(mob, ms);
  updateMobBody(mob);
}

function finishMobPose(mob) {
  if (
    mob.state === "spawning" &&
    mob.actions[mob.action].duration > 0 &&
    mob.stateMs >= mob.actions[mob.action].duration
  ) {
    mob.state = "idle";
  }
  if (mob.state === "hit" && mob.stateMs >= mob.actions[mob.action].duration) {
    mob.state = "idle";
  }
  if (
    mob.state === "attack" &&
    mob.stateMs >=
      Math.max(
        mob.actions[mob.action].duration,
        mob.pendingAttack.properties.attackAfter + 30,
      )
  ) {
    mob.state = "idle";
    mob.pendingAttack = null;
  }
}

/** Forced skill motion follows the admitted ground/free-flight controller. */
export function displaceMobSkill(mob, distance) {
  if (
    !mob.alive ||
    mob.movement === "stationary-special" ||
    mob.template.info.boss ||
    !Number.isFinite(distance)
  ) {
    return false;
  }
  moveMobRecoil(mob, distance);
  mob.pendingAttack = null;
  mob.attackFired = true;
  mob.state = "idle";
  setMobAction(mob, mob.flight ? "fly" : "stand");
  updateMobBody(mob);
  return true;
}

// ── Idle AI decision + jump physics (mirrors sdlms mob_logic_system) ────────────

/** Kick off a mob jump from the ground. Records the current horizontal
 *  patrol velocity so airborne flight can preserve it without touching aggro. */
function startMobJump(mob) {
  mob.vy = MOB_JUMP.jumpSpeed;
  mob.onGround = false;
  if (mob.actions.jump) setMobAction(mob, "jump");
  // Schedule immediate re-decision on landing — sdlms sets next_action_time = 0.
  mob.jumpDecisionMs = 0;
}

/** Advance airborne physics: gravity integrates vy, optional horizontal glide
 *  from the pre-jump patrol velocity, and landing detection on descent.
 *  Horizontal glide is clamped to the current foothold's x1..x2 so the mob
 *  never glides past its landing surface and falls forever. */
function stepAirborneMob(mob, ms) {
  const seconds = ms / 1000;
  mob.vy += MOB_JUMP.gravity * seconds;
  const previousY = mob.y;

  const fh = mob.foothold;
  const authored = mob.record.authored;

  // Horizontal glide: preserve facing while airborne for patrol-type mobs;
  // stationary-special and aggro-chasing mobs freeze horizontal motion mid-jump.
  let glideVx = 0;
  if (mob.movement === "ground-patrol" && mob.aggro.damageInstances === 0) {
    glideVx = mob.facing * mob.speed;
  }
  let nx = mob.x + glideVx * seconds;
  // Hard-clamp to both authored range AND current foothold bounds. The authored
  // range is the overall patrol box; the foothold clamp guarantees the mob
  // always lands on a surface it can actually touch.
  if (fh && fh.dx > 0) {
    nx = Math.max(Math.max(authored.rx0, fh.x1), Math.min(Math.min(authored.rx1, fh.x2), nx));
  } else {
    nx = Math.max(authored.rx0, Math.min(authored.rx1, nx));
  }

  mob.x = nx;
  mob.y = mob.y + mob.vy * seconds;

  // Landing: only detect on descent, matching sdlms "ny >= feet_prev" guard
  // so the launch frame can't accidentally snap back into the foothold.
  if (mob.vy >= 0 && mob.y >= previousY && fh && fh.dx > 0) {
    // Already clamped nx to fh.x1..fh.x2 above, so any y below groundY(fh, nx)
    // means the mob has descended to or past the foothold surface.
    const gy = groundY(fh, nx);
    if (mob.y >= gy - MOB_JUMP.landingTolerance) {
      mob.x = Math.max(fh.x1, Math.min(fh.x2, nx));
      mob.y = gy;
      mob.foothold = fh;
      mob.onGround = true;
      mob.vy = 0;
      // Landing action: stand unless we were mid-patrol and have a move action.
      if (mob.actions.move && glideVx !== 0) setMobAction(mob, "move");
      else setMobAction(mob, mob.actions.stand ? "stand" : mob.defaultAction);
      return;
    }
  }
  // Still airborne — action stays as whatever startMobJump set (typically "jump").
}

/** Roll one idle AI decision for a ground mob with no aggro.
 *  Mirrors sdlms run_ai_decide: 18% jump, 42% patrol, 40% stand. */
function decideIdleMobAction(mob) {
  const roll = Math.floor(Math.random() * 100);
  const authored = mob.record.authored;

  // Jump branch — 18%, requires canJump (has jump action).
  if (mob.canJump && mob.actions.jump && roll < MOB_JUMP.jumpChanceRoll) {
    startMobJump(mob);
    mob.jumpDecisionMs = 900; // sdlms 900 ms minimum air time before re-decision.
    return;
  }

  // Patrol (walk) branch — 42%, requires ground-patrol movement + speed > 0.
  if (
    mob.movement === "ground-patrol" &&
    mob.speed > 0 &&
    mob.actions.move &&
    roll < MOB_JUMP.jumpChanceRoll + MOB_JUMP.walkChanceRoll
  ) {
    // Direction choice: favour turning around at range edges, else 50/50.
    let goRight;
    const margin = 6;
    if (mob.x <= authored.rx0 + margin) goRight = true;
    else if (mob.x >= authored.rx1 - margin) goRight = false;
    else goRight = Math.random() < 0.5;
    mob.facing = goRight ? 1 : -1;
    setMobAction(mob, "move");
    mob.jumpDecisionMs =
      MOB_JUMP.walkMinMs + Math.random() * MOB_JUMP.walkRangeMs;
    return;
  }

  // Stand (idle) fallback.
  if (mob.actions.stand) setMobAction(mob, "stand");
  else if (mob.defaultAction) setMobAction(mob, mob.defaultAction);
  mob.jumpDecisionMs =
    MOB_JUMP.idleMinMs + Math.random() * MOB_JUMP.idleRangeMs;
}

function stepMobMotion(mob, ms, target) {
  const movementScale = mobSkillMovementScale(mob);
  if (movementScale === 0) {
    if (hasMobStatus(mob, "freeze")) return;
    setMobAction(mob, mob.flight ? "fly" : "stand");
    return;
  }
  if (mob.knockbackMs > 0) {
    const seconds = Math.min(ms, mob.knockbackMs) / 1000;
    const before = mob.knockbackSpeed;
    mob.knockbackSpeed = Math.max(
      0,
      before - mob.knockbackDeceleration * seconds,
    );
    moveMobRecoil(
      mob,
      mob.knockbackFacing * ((before + mob.knockbackSpeed) / 2) * seconds,
    );
    mob.knockbackMs = Math.max(0, mob.knockbackMs - ms);
    return;
  }
  if (mob.state !== "idle") return;
  // Jump / airborne branch — runs before flight and ground-patrol so a mob
  // that leapt mid-patrol keeps its gravity until landing.
  if (!mob.flight && !mob.onGround) {
    stepAirborneMob(mob, ms);
    return;
  }
  if (mob.flight) {
    stepMobFlight(mob, ms, target, movementScale);
    setMobAction(mob, "fly");
    return;
  }
  stepGroundMob(mob, ms, target, movementScale);
}

function stepGroundMob(mob, ms, target, movementScale) {
  // Aggro path — completely untouched by idle AI. Chase takes precedence
  // over patrol/jump/stand whenever the mob has active aggro or is inert.
  if (mob.movement === "ground-patrol" && mob.speed > 0) {
    if (mob.aggro.damageInstances > 0 || hasMobStatus(mob, "inert")) {
      chaseMob(mob, ms * movementScale, target);
      return;
    }
  }

  // Idle AI scheduler: only runs when the mob is free of aggro/inert.
  mob.jumpDecisionMs = Math.max(0, mob.jumpDecisionMs - ms);
  if (mob.jumpDecisionMs === 0) {
    decideIdleMobAction(mob);
    // decideIdleMobAction schedules the next decision AND may launch a jump.
    // If it did jump, onGround is now false and stepMobMotion will take the
    // airborne branch next tick. Either way we're done here this tick.
    return;
  }

  // Physics execution between decisions — RESPECT the current action, don't
  // blindly overwrite a stand decision with patrol motion every tick.
  // Only the patrol ("move") action should execute horizontal movement.
  // Anything else (stand, jump, hit) stays put until the next decision.
  if (
    mob.action === "move" &&
    mob.movement === "ground-patrol" &&
    mob.speed > 0
  ) {
    const authored = mob.record.authored;
    if (mob.x <= authored.rx0) mob.facing = 1;
    else if (mob.x >= authored.rx1) mob.facing = -1;
    moveMob(mob, (mob.facing * mob.speed * ms * movementScale) / 1000);
  }
}

/** A single local attacker needs expiry counts, not multiplayer damage rankings. */
function admitMobAggro(mob, amount) {
  if (
    mob.movement === "stationary-special" ||
    (!mob.flight && mob.speed <= 0) ||
    mob.template.info.boss
  ) {
    return;
  }
  const aggro = mob.aggro;
  if (amount === 0 && aggro.damageInstances > 0) return;
  aggro.expireStreak = 0;
  aggro.ticksRemaining = aggroExpiryTicks(aggro);
  aggro.damageInstances++;
}

function aggroExpiryTicks(aggro) {
  return Math.ceil(
    MOB_AGGRO.damageLifetimeMs /
      MOB_AGGRO.updateMs /
      2 ** (aggro.expireStreak + aggro.damageInstances),
  );
}

function clearMobAggro(mob) {
  const aggro = mob.aggro;
  aggro.damageInstances = 0;
  aggro.expireStreak = 0;
  aggro.ticksRemaining = 0;
  aggro.updateMs = 0;
}

/** Null means the local controller died/left. Residency never affects this clock. */
function stepMobAggro(mob, ms, target) {
  if (!target) {
    clearMobAggro(mob);
    return;
  }
  const aggro = mob.aggro;
  aggro.updateMs += ms;
  const updates = Math.floor(aggro.updateMs / MOB_AGGRO.updateMs);
  aggro.updateMs %= MOB_AGGRO.updateMs;
  // The coordinator has a field clock, not a new timer per successful hit.
  for (let count = 0; count < updates; count++) {
    if (count >= MOB_POLICY.maxTransitions) {
      mob.fault = "aggro update budget exhausted";
      return;
    }
    if (aggro.damageInstances === 0) return;
    aggro.ticksRemaining--;
    if (aggro.ticksRemaining > 0) continue;
    aggro.expireStreak++;
    aggro.ticksRemaining = aggroExpiryTicks(aggro);
    aggro.damageInstances--;
  }
}

/** Native target steering, restricted to the already admitted connected walk path. */
function chaseMob(mob, ms, target) {
  const authored = mob.record.authored;
  const goal = Math.max(authored.rx0, Math.min(authored.rx1, target.x));
  const direction = Math.sign(goal - mob.x);
  const distance = Math.min(Math.abs(goal - mob.x), (mob.speed * ms) / 1000);
  const before = mob.x;
  if (direction !== 0) {
    mob.facing = direction;
    moveMob(mob, direction * distance);
    // An unreachable target does not turn the hunter back into a bouncing patrol.
    mob.facing = direction;
  }
  setMobAction(mob, mob.x === before ? "stand" : "move");
}

/** 009bc2bb..392 integrates the grounded scalar speed along the foothold.
 *  009b1646 reconstructs world XY from its tangent and that distance. The
 *  separate airborne mode-3 branch in 009bbdfd must not define ground travel. */
function moveMobRecoil(mob, distance) {
  if (mob.flight) {
    moveMobFlightRecoil(mob, distance);
    return;
  }
  const direction = Math.sign(distance);
  let remaining = Math.abs(distance);
  for (let count = 0; count < MOB_POLICY.maxTransitions; count++) {
    const segment = mob.foothold;
    const edge = direction > 0 ? segment.x2 : segment.x1;
    const available = segment.tx > 0 ? Math.abs(edge - mob.x) / segment.tx : 0;
    if (remaining <= available) {
      mob.x += direction * remaining * segment.tx;
      if (segment.dx > 0) mob.y = groundY(segment, mob.x);
      return;
    }
    mob.x = edge;
    mob.y = direction > 0 ? segment.y2 : segment.y1;
    remaining -= available;
    const next = connectedSegment(segment, direction);
    if (!next) {
      mob.knockbackSpeed = 0;
      return;
    }
    mob.foothold = next;
  }
  mob.fault = "recoil foothold traversal budget exhausted";
}

function connectedSegment(segment, direction) {
  const next = direction > 0 ? segment.next : segment.prev;
  if (
    !next ||
    next.dx <= 0 ||
    next.layer !== segment.layer ||
    next.group !== segment.group
  ) {
    return null;
  }
  const connected =
    direction > 0
      ? next.x1 === segment.x2 && next.y1 === segment.y2
      : next.x2 === segment.x1 && next.y2 === segment.y1;
  return connected ? next : null;
}

/** Local patrol only follows contiguous original floor links; no invented gap jumping. */
function moveMob(mob, distance) {
  if (mob.movement !== "ground-patrol") return;
  const authored = mob.record.authored;
  const target = Math.max(
    Math.min(authored.rx0, mob.x),
    Math.min(Math.max(authored.rx1, mob.x), mob.x + distance),
  );
  const direction = Math.sign(distance);
  if (target !== mob.x + distance) mob.facing = -direction;
  for (let count = 0; count < MOB_POLICY.maxTransitions; count++) {
    const segment = mob.foothold;
    if (target >= segment.x1 && target <= segment.x2) {
      mob.x = target;
      mob.y = groundY(segment, target);
      return;
    }
    const next = connectedSegment(segment, direction);
    if (!next) {
      mob.x = direction > 0 ? segment.x2 : segment.x1;
      mob.y = direction > 0 ? segment.y2 : segment.y1;
      mob.facing = -direction;
      return;
    }
    mob.foothold = next;
  }
  mob.fault = "local foothold traversal budget exhausted";
}

function recoverMob(mob, ms) {
  mob.recoveryMs += ms;
  if (mob.recoveryMs < MOB_POLICY.recoveryMs) return;
  mob.recoveryMs -= MOB_POLICY.recoveryMs;
  mob.hp = Math.min(
    mob.maxHP,
    mob.hp + Math.max(0, mob.template.info.hpRecovery ?? 0),
  );
  mob.mp = Math.min(
    mob.maxMP,
    mob.mp + Math.max(0, mob.template.info.mpRecovery ?? 0),
  );
}

function stepDeadMob(mob, ms) {
  mob.respawnMs += ms;
  advanceMobAction(mob, ms);
  const duration = mob.actions[mob.action].duration;
  if (mob.stateMs >= duration) {
    mob.visible = false;
    mob.state = "dead";
  }
  if (mob.developmentSpawn && mob.state === "dead") {
    mob.active = false;
    return;
  }
  if (mob.respawnMs < Math.max(MOB_POLICY.respawnMs, duration)) return;
  mob.x = mob.spawnX;
  mob.y = mob.spawnY;
  mob.previousX = mob.x;
  mob.previousY = mob.y;
  mob.facing = mob.spawnFacing;
  mob.foothold = mob.spawnFoothold;
  resetMobFlight(mob);
  mob.vy = 0;
  mob.onGround = true;
  mob.jumpDecisionMs = 0;
  mob.hp = mob.maxHP;
  mob.mp = mob.maxMP;
  mob.alive = true;
  mob.visible = true;
  mob.state = mob.actions.regen ? "spawning" : "idle";
  mob.stateMs = 0;
  mob.respawnMs = 0;
  mob.spawnMs = mob.actions.regen ? MOB_APPEARANCE.spawnMs : 0;
  mob.opacity = mob.actions.regen ? 1 : 0;
  mob.actionMs = 0;
  mob.frame = 0;
  mob.nameRemainingMs = 0;
  clearMobAggro(mob);
  clearMobSkillStatus(mob);
  mob.cooldownMs = MOB_POLICY.attackCooldownMs;
  mob.recoveryMs = 0;
  mob.knockbackMs = 0;
  mob.hitRemainingMs = 0;
  mob.lastReaction = "none";
  mob.knockbackSpeed = 0;
  mob.pendingAttack = null;
  setMobAction(mob, mob.actions.regen ? "regen" : mob.defaultAction);
  updateMobBody(mob);
}

/** Returns true exactly for the lethal transition, never for repeated dead hits. */
export function damageMob(mob, amount, facing, attack = null) {
  const skillId = attack?.skillId ?? 0;
  validateMobHit(amount, facing, skillId);
  validateReaction(attack);
  if (
    !mob.alive ||
    !mob.active ||
    (mob.selectedSkills.length && !mob.selectedSkills.includes(skillId)) ||
    mob.template.info.invincible
  ) {
    return false;
  }
  mob.nameRemainingMs = 5000;
  mob.lastDamage = amount;
  admitMobAggro(mob, amount);
  if (amount === 0) {
    mob.lastReaction = "nonpositive";
    return false;
  }
  mob.hp = Math.max(0, mob.hp - amount);
  if (mob.hp === 0) {
    clearMobAggro(mob);
    clearMobSkillStatus(mob);
    mob.stateMs = 0;
    mob.actionMs = 0;
    mob.frame = 0;
    // Death cancels the entry transition; its WZ frame a0/a1 owns disappearance.
    mob.spawnMs = MOB_APPEARANCE.spawnMs;
    mob.opacity = 1;
    mob.pendingAttack = null;
    mob.knockbackMs = 0;
    mob.hitRemainingMs = 0;
    mob.lastReaction = "lethal";
    mob.knockbackSpeed = 0;
    resetMobFlight(mob);
    mob.alive = false;
    mob.state = "dying";
    mob.deaths++;
    mob.respawnMs = 0;
    setMobAction(mob, "die1");
    mob.body.active = false;
    mob.sweptBody.active = false;
    return true;
  }
  receiveMobReaction(mob, amount, facing, attack);
  return false;
}

function validateMobHit(amount, facing, skillId) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Mob damage must be a nonnegative safe integer");
  }
  if ((facing !== -1 && facing !== 1) || !Number.isSafeInteger(skillId)) {
    throw new Error("Invalid mob hit direction or skill");
  }
}

/** The owner supplies one native-modulo roll, never a guessed admission chance. */
function validateReaction(attack) {
  if (attack === null) return;
  knockbackChance(attack.knockbackChance);
  if (!Number.isInteger(attack.roll) || attack.roll < 0 || attack.roll > 99) {
    throw new Error("Invalid mob knockback roll");
  }
}

function receiveMobReaction(mob, amount, facing, attack) {
  mob.lastReaction = "below-threshold";
  if (amount < (mob.template.info.pushed ?? 1)) return;
  mob.lastReaction = "hit-deadline";
  if (mob.hitRemainingMs > 0) return;
  mob.lastReaction = "missing-hit-artwork";
  if (!mob.actions.hit1) return;
  const strong =
    attack !== null && attack.roll < knockbackChance(attack.knockbackChance);
  beginMobHit(mob, facing, strong);
}

/** 0066b7c6..822 preserves an attack pose; 00668d51 gates repeat hit reactions. */
function beginMobHit(mob, facing, strong) {
  const attacking = mob.state === "attack";
  if (!attacking) {
    mob.state = "hit";
    mob.stateMs = 0;
    mob.actionMs = 0;
    mob.frame = 0;
    mob.facing = -facing;
    setMobAction(mob, "hit1");
  }
  // Reset airborne velocity so a mid-jump hit doesn't leave stale upward
  // momentum that would relaunch the mob once the hit state expires. Keep
  // onGround untouched — gravity resumes normally if the mob is still aloft.
  mob.vy = 0;
  const duration = mob.actions.hit1.duration;
  // 0066b98b..9c8 installs the full motion-adjusted duration, replacing the
  // earlier max(1000,duration) provisional deadline; it is never min(1000,...).
  mob.hitRemainingMs = duration;
  mob.lastReaction = strong ? "strong" : "ordinary";
  const moving =
    mob.movement !== "stationary-special" &&
    duration >= MOB_HIT.minimumMotionMs;
  mob.knockbackMs = moving ? duration : 0;
  const velocity = strong ? MOB_HIT.strongVelocity : MOB_HIT.velocity;
  mob.knockbackSpeed = moving ? velocity : 0;
  mob.knockbackDeceleration = strong
    ? MOB_HIT.strongDeceleration
    : MOB_HIT.deceleration;
  mob.knockbackFacing = facing;
  if (moving && mob.flight) {
    mob.flight.vx = facing * velocity;
    mob.flight.vy = 0;
  }
  updateMobBody(mob);
}
