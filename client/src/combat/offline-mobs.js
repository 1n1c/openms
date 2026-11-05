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
const MAX_MOBS = 4096;
const MAX_ACTIONS = 128;
const MAX_FRAMES = 1024;

// Life geometry is shared with the browser's own presentation; the authority half of this
// module must not be the only home for a rectangle test the online graph is allowed to use.
export { overlaps, rectangleState };

/** Compile original frame delays once; unknown timing remains frozen. */
export function compileActions(template) {
  const actions = Object.create(null);
  const entries = Object.entries(template.actions);
  validateMobInfo(template.info);
  if (entries.length > MAX_ACTIONS) throw new Error("Mob action limit");
  for (const [name, source] of entries) {
    if (!source.frames.length || source.frames.length > MAX_FRAMES) {
      throw new Error("Mob frame limit");
    }
    const ends = new Float64Array(source.frames.length);
    let duration = 0;
    for (let index = 0; index < source.frames.length; index++) {
      const delay = source.frames[index].delayMs;
      validateBody(source.frames[index].body);
      if (source.timingKnown && (!Number.isFinite(delay) || delay <= 0)) {
        throw new Error("Invalid mob delay");
      }
      duration += source.timingKnown ? delay : 0;
      ends[index] = duration;
    }
    actions[name] = { ends, duration, frames: source.frames };
  }
  return actions;
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
    // Jump-physics state (MapleNecrocer Mob.cs JumperSprite).
    // Only meaningful when movementType === 2 (WZ has a "jump" action).
    jumpState: "none", // "none" | "jumping" | "falling"
    vy: 0, // vertical velocity; negative = up, positive = down (MapleNecrocer px/frame)
    jumpAccumulatorMs: 0, // tracks fractional 17ms frames inside openms 30ms ticks
    doJumpQueued: false, // AI layer sets this; physics layer consumes it
    // Patrol random-decision timer (MapleNecrocer Mob.cs Random.Next(200) per frame).
    // movementType === 1 ground-patrol only: fires a decision every ~500ms.
    patrolDecisionMs: 0,
    patrolNextDecisionMs: 400, // first decision fires after 400ms
    patrolDecision: "walk", // "walk" | "stand"
    fleeMs: 0, // remaining flee time (ms); temporary reverse when low-HP gets hit
    // Hover mode (condition 1): reachable same level → ping-pong target.x ±80px
    hoverActive: false,
    hoverLeftX: 0,
    hoverRightX: 0,
    hoverFootholdId: -1,
    // Roam mode (condition 2): cannot reach target → search radius target.x ±300px
    roamLeftX: 0,
    roamRightX: 0,
    roamActive: false,
    roamFootholdId: -1, // FH id of roam boundary; recalc boundaries + reachability on FH change
    // Jump charge system: 3s per charge restore, max 2 stacked
    jumpCharges: 2,
    jumpCooldownMs: 0,
    // 1s cooldown after landing on new FH (blocks all jumps)
    jumpLandedCooldownMs: 0,
    // "guaranteed flip next" flag for the 50% stand + 50% flip boundary randomization
    _boundaryFlipNext: false,
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
    geometry: simulation.geometry, // needed for FindBelow / wall scan (jump physics)
    ladders: simulation.ladders ?? [], // needed for ladder-base jump detection
  };
  updateMobBody(mob);
  return mob;
}

function groundY(segment, x) {
  return segment.y1 + ((x - segment.x1) * segment.dy) / segment.dx;
}

/** MapleNecrocer FH.IsWall(): X1==X2. openms equivalent: dx<=0. */
function segmentIsWall(segment) {
  return !segment || segment.dx <= 0;
}

/** MapleNecrocer FootholdTree.FindBelow (Footholds.cs L72-119).
 *  Only picks non-wall segments with groundY >= mob.y (Y-down convention:
 *  ground is at or below the mob), then returns the one with the smallest groundY —
 *  i.e. the closest ground below the mob. Returns null if none exists
 *  (original returns (99999, 99999) meaning fell out of map).
 *
 *  Critical constraint: NEVER pick an upper-platform segment with groundY < mob.y,
 *  or the mob would "jump" onto an unreachable airborne platform. */
function findBelowGround(mob) {
  const mobX = mob.x;
  const mobY = mob.y;
  const mobLayer = mob.foothold?.layer;
  let best = null;
  let bestY = Infinity;
  for (const segment of mob.geometry.segments) {
    if (segmentIsWall(segment)) continue;
    if (segment.layer !== mobLayer) continue;
    const minX = Math.min(segment.x1, segment.x2);
    const maxX = Math.max(segment.x1, segment.x2);
    if (mobX < minX || mobX > maxX) continue;
    const gy = groundY(segment, mobX);
    // Original core condition: only consider segments with groundY >= mobY
    // (ground at/below mob, Y-down: larger Y = lower position)
    if (gy >= mobY) {
      // Among all qualifying, pick the smallest groundY (closest to mob)
      if (gy < bestY) {
        bestY = gy;
        best = segment;
      }
    }
  }
  return best;
}

/** Step 5d: find upper platform ahead of mob (groundY < mob.y, same layer).
 *  Used in chase mode to actively jump up and path to target.
 *  Returns { segment, groundY } or null.
 *  Extra constraint: upper platform height diff ≤ max jumpable height (~63px). */

/** Check if mob is directly below a ladder and can jump up to grab it.
 *  Condition: mob.x within ladder.x ± CAPTURE_WIDTH(10), mob.y near ladder bottom. */
function findLadderBelow(mob) {
  const ladders = mob.ladders;
  if (!ladders || ladders.length === 0) return null;
  const CAPTURE_WIDTH = 15; // slightly wider than player's 10px (mob alignment is less strict)
  for (const ladder of ladders) {
    if (Math.abs(mob.x - ladder.x) > CAPTURE_WIDTH) continue;
    // ladder.y1 = top (smaller y), ladder.y2 = bottom (larger y)
    // mob should be near or below ladder bottom (mob.y >= ladder.y2 - 10)
    // and at least part of ladder should be above mob (jumpable)
    if (ladder.y2 <= mob.y + 5 && ladder.y1 < mob.y - 5) {
      return ladder;
    }
  }
  return null;
}

function findAboveGroundAhead(mob, targetX) {
  const mobY = mob.y;
  const mobLayer = mob.foothold?.layer;
  // MapleNecrocer JumperSprite max jump rise ≈ 63px (vy=-9, gravity=0.6, peaks at frame 15)
  const MAX_JUMP_HEIGHT_PX = 63;
  let best = null;
  let bestY = -Infinity;
  for (const segment of mob.geometry.segments) {
    if (segmentIsWall(segment)) continue;
    if (segment.layer !== mobLayer) continue;
    const minX = Math.min(segment.x1, segment.x2);
    const maxX = Math.max(segment.x1, segment.x2);
    // target must be within the upper platform's X range
    if (targetX < minX || targetX > maxX) continue;
    const gy = groundY(segment, Math.max(minX, Math.min(maxX, targetX)));
    // upper platform: groundY < mobY (Y-down: smaller groundY = higher position)
    const heightDiff = mobY - gy;
    if (heightDiff > 0 && heightDiff <= MAX_JUMP_HEIGHT_PX) {
      if (gy > bestY) {
        bestY = gy;
        best = { segment, groundY: gy };
      }
    }
  }
  return best;
}

/** MapleNecrocer FootholdTree.FindWallL / FindWallR: scan same-layer walls
 *  within `range` pixels of mob.x in the given direction, covering mob height.
 *  Returns the nearest matching wall segment, or null. */
function findWallNearby(mob, direction, range) {
  const mobX = mob.x;
  const mobY = mob.y;
  const mobLayer = mob.foothold?.layer;
  let best = null;
  let bestDist = Infinity;
  for (const segment of mob.geometry.segments) {
    if (!segmentIsWall(segment)) continue;
    if (segment.layer !== mobLayer) continue;
    // X axis: wall X1 is the wall's plane.
    const wallX = segment.x1;
    if (direction > 0) {
      if (wallX < mobX) continue; // must be ahead
      if (wallX > mobX + range) continue;
    } else {
      if (wallX > mobX) continue; // must be behind
      if (wallX < mobX - range) continue;
    }
    // Y axis: wall must cover current height.
    const minY = Math.min(segment.y1, segment.y2);
    const maxY = Math.max(segment.y1, segment.y2);
    if (mobY < minY || mobY > maxY) continue;
    const dist = Math.abs(wallX - mobX);
    if (dist < bestDist) {
      bestDist = dist;
      best = segment;
    }
  }
  return best;
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
  if (mob.flight) {
    stepMobFlight(mob, ms, target, movementScale);
    setMobAction(mob, "fly");
    return;
  }
  stepGroundMob(mob, ms, target, movementScale);
}

/** MapleNecrocer frame time; physics sub-stepped into openms 30ms ticks. */
const MN_FRAME_MS = 17;
/** MapleNecrocer JumperSphere gravity per frame (0.6 px/frame²). */
const MN_GRAVITY_PER_FRAME = 0.6;
/** MapleNecrocer jump initial velocity (-9 px/frame, negative = upward). */
const MN_JUMP_INITIAL_VY = -9;
/** MapleNecrocer max fall velocity (8 px/frame). */
const MN_MAX_FALL_VY = 8;

// Hover mode (condition 1): reachable same level → ping-pong target.x ± HOVER_HALF_RANGE (clamped to FH)
const HOVER_HALF_RANGE = 80;
// Roam mode (condition 2): cannot reach target → aggro search radius target.x ± ROAM_HALF_RANGE (clamped to FH)
const ROAM_HALF_RANGE = 300;

// Max reachable height diff for jump mobs (MapleNecrocer JumperSprite peak ≈ 63px)
const JUMP_MAX_HEIGHT_DIFF = 63;

// Min interval between landing and next jump (ms): 1 second
const JUMP_LANDED_COOLDOWN_MS = 1000;

// --- Jump trigger probabilities ---
// Gap Jump: gap ahead past FH edge, mob within 40px of edge → 35%
const GAP_JUMP_PROBABILITY = 0.35;
// Wall Jump: wall within 30px ahead, walkable ground on other side → 60%
const WALL_JUMP_PROBABILITY = 0.60;
// UpperPlatform Jump: upper platform within 20px ahead, height diff ≤ 63px → 50%
const UPPER_PLATFORM_JUMP_PROBABILITY = 0.50;
// Rope Jump: ladder base within 15px below → 50%
const ROPE_JUMP_PROBABILITY = 0.50;

/** Check whether target height is reachable for mob.
 *  ground mob (movementType=1): reachable only if same level AND target is on connected FH chain
 *  jump mob  (movementType=2): reachable if target above with height diff ≤ 63px (can jump up),
 *                              or same level (can chase directly),
 *                              or below (will fall down to target level)
 *  Returns { reachable: bool, upperPlatform?: segment } */
export function checkTargetReachability(mob, target) {
  const targetX = target.x;
  const targetY = target.y ?? mob.y;
  const mobY = mob.y;

  // target below (Y-down: targetY > mobY means lower position)
  if (targetY > mobY + 5) {
    return { reachable: true };
  }

  // target same level or above
  const heightDiff = mobY - targetY; // positive = target is above mob
  if (heightDiff <= 5) {
    // ground mob: target must be on connected FH chain (max 5 hops)
    if (mob.movementType === 1) {
      if (!isTargetOnConnectedFH(mob, targetX, 5)) {
        return { reachable: false };
      }
    }
    return { reachable: true };
  }

  // target above
  if (mob.movementType === 2) {
    if (heightDiff <= JUMP_MAX_HEIGHT_DIFF) {
      const probe = findAboveGroundAhead(mob, targetX);
      if (probe) return { reachable: true, upperPlatform: probe.segment };
    }
  }

  return { reachable: false };
}

/** Check whether targetX falls on the connected FH chain of mob's current FH (max maxHops hops). */
function isTargetOnConnectedFH(mob, targetX, maxHops = 5) {
  const seg = mob.foothold;
  // Walk left (prev)
  let hops = 0;
  let cur = seg;
  while (cur && hops <= maxHops) {
    if (targetX >= cur.x1 - 5 && targetX <= cur.x2 + 5) return true;
    cur = cur.prev;
    hops++;
  }
  // Walk right (next)
  hops = 0;
  cur = seg;
  while (cur && hops <= maxHops) {
    if (targetX >= cur.x1 - 5 && targetX <= cur.x2 + 5) return true;
    cur = cur.next;
    hops++;
  }
  return false;
}

/** Compute roam mode search bounds: target.x ±ROAM_HALF_RANGE, clamped to current FH edges.
 *  If target.x is completely outside this FH (clamp produces inverted left≥right),
 *  falls back to full FH range. */
function updateRoamRange(mob, targetX) {
  const seg = mob.foothold;
  let left  = Math.max(targetX - ROAM_HALF_RANGE, seg.x1);
  let right = Math.min(targetX + ROAM_HALF_RANGE, seg.x2);
  if (left >= right) { left = seg.x1; right = seg.x2; }
  mob.roamLeftX = left;
  mob.roamRightX = right;
  mob.roamFootholdId = seg.id;
}

/** Compute hover mode ping-pong bounds: target.x ±HOVER_HALF_RANGE, clamped to current FH edges.
 *  If target.x is completely outside this FH (clamp produces inverted left≥right),
 *  falls back to full FH range. */
function updateHoverRange(mob, targetX) {
  const seg = mob.foothold;
  let left  = Math.max(targetX - HOVER_HALF_RANGE, seg.x1);
  let right = Math.min(targetX + HOVER_HALF_RANGE, seg.x2);
  if (left >= right) { left = seg.x1; right = seg.x2; }
  mob.hoverLeftX = left;
  mob.hoverRightX = right;
  mob.hoverFootholdId = seg.id;
}

/** Boundary facing decision: 50% stand + 50% flip, stand sets guaranteed-next-flip flag. */
function boundaryFacingDecision(mob, boundaryFacing) {
  // boundaryFacing = +1 (hit left edge, want to go right) or -1 (hit right edge, want to go left)
  if (mob._boundaryFlipNext) {
    mob._boundaryFlipNext = false;
    return boundaryFacing; // last tick stood at boundary → guaranteed flip this tick
  }
  if (Math.random() < 0.5) {
    // 50% flip
    return boundaryFacing;
  } else {
    // 50% stand: keep facing (toward boundary), mark guaranteed flip next tick
    mob._boundaryFlipNext = true;
    return mob.facing || boundaryFacing;
  }
}

/** hover mode facing decision (reachable same level, ±80px ping-pong), boundary randomization. */
function hoverFacing(mob) {
  let f;
  if (mob.x <= mob.hoverLeftX) f = boundaryFacingDecision(mob, 1);
  else if (mob.x >= mob.hoverRightX) f = boundaryFacingDecision(mob, -1);
  else { mob._boundaryFlipNext = false; f = mob.facing || 1; }
  return mob.fleeMs > 0 ? -f : f;
}

/** roam mode facing decision (unreachable different level, ±300px ping-pong), boundary randomization. */
export function roamFacing(mob) {
  let f;
  if (mob.x <= mob.roamLeftX) f = boundaryFacingDecision(mob, 1);
  else if (mob.x >= mob.roamRightX) f = boundaryFacingDecision(mob, -1);
  else { mob._boundaryFlipNext = false; f = mob.facing || 1; }
  return mob.fleeMs > 0 ? -f : f;
}

function stepGroundMob(mob, ms, target, movementScale) {
  if (mob.movementType === 2) {
    jumpMobStep(mob, ms, target, movementScale);
    return;
  }
  if (mob.movement === "ground-patrol" && mob.speed > 0) {
    if (mob.aggro.damageInstances > 0 || hasMobStatus(mob, "inert")) {
      // --- Condition 1 vs 2: hover (same level ±80px) vs roam (diff level ±300px) ---
      let reachable = { reachable: true };
      if (target) {
        reachable = checkTargetReachability(mob, target);
      }

      if (reachable.reachable) {
        // Condition 1: reachable same level → hover
        if (!mob.hoverActive) {
          mob.hoverActive = true;
          mob.roamActive = false;
          updateHoverRange(mob, target.x);
        }
        // FH changed → recompute hover bounds
        if (mob.foothold.id !== mob.hoverFootholdId) {
          updateHoverRange(mob, target.x);
        }
        mob.facing = hoverFacing(mob);
        moveMob(mob, (mob.facing * mob.speed * ms * movementScale) / 1000, {
          rx0: -Infinity, rx1: Infinity,
        });
        setMobAction(mob, "move");
        return;
      }

      // Condition 2: unreachable diff level → roam
      if (!mob.roamActive) {
        mob.roamActive = true;
        mob.hoverActive = false;
        updateRoamRange(mob, target.x);
      }
      // FH changed → recompute roam bounds
      if (mob.foothold.id !== mob.roamFootholdId) {
        updateRoamRange(mob, target.x);
      }
      mob.facing = roamFacing(mob);
      moveMob(mob, (mob.facing * mob.speed * ms * movementScale) / 1000, {
        rx0: -Infinity, rx1: Infinity,
      });
      setMobAction(mob, "move");
      return;
    }
    mob.hoverActive = false;
    mob.hoverFootholdId = -1;
    mob.roamActive = false;
    mob.roamFootholdId = -1;
    // --- Timed random decision (MapleNecrocer Mob.cs Random.Next(200) per frame ---
    // changed to 400-800ms timer, probabilities: 25% flip, 25% stand, 50% walk ---
    mob.patrolDecisionMs += ms;
    if (mob.patrolDecisionMs >= mob.patrolNextDecisionMs) {
      mob.patrolDecisionMs = 0;
      mob.patrolNextDecisionMs = 400 + Math.random() * 400; // next decision in 400-800ms
      const roll = Math.random();
      if (roll < 0.25) {
        mob.facing = -mob.facing;
        mob.patrolDecision = "walk";
      } else if (roll < 0.5) {
        mob.patrolDecision = "stand";
      } else {
        mob.patrolDecision = "walk";
      }
    }

    const authored = mob.record.authored;
    if (mob.x <= authored.rx0) mob.facing = boundaryFacingDecision(mob, 1);
    else if (mob.x >= authored.rx1) mob.facing = boundaryFacingDecision(mob, -1);

    if (mob.patrolDecision === "stand") {
      setMobAction(mob, "stand");
    } else {
      moveMob(mob, (mob.facing * mob.speed * ms * movementScale) / 1000);
      setMobAction(mob, "move");
    }
  } else setMobAction(mob, "stand");
}

/** MapleNecrocer Mob.cs movement + gap/wall detection + JumperSprite physics.
 *  Only movementType === 2 enters this branch.
 *  Step 2: aggro → track target.x (chase mode); no aggro → rx0↔rx1 patrol.
 *  Both modes can jump on gap/wall encounter. */
function jumpMobStep(mob, ms, target, movementScale) {
  const speed = (mob.speed * ms * movementScale) / 1000;
  const authored = mob.record.authored;

  // --- Jump charge restore: 3s per charge, max 2 stacked ---
  if (mob.jumpCharges < 2) {
    mob.jumpCooldownMs -= ms;
    if (mob.jumpCooldownMs <= 0) {
      mob.jumpCharges++;
      if (mob.jumpCharges < 2) {
        mob.jumpCooldownMs = 3000; // keep cooling for next charge
      } else {
        mob.jumpCooldownMs = 0;
      }
    }
  }
  // --- Decrement landed cooldown after landing ---
  if (mob.jumpLandedCooldownMs > 0) {
    mob.jumpLandedCooldownMs = Math.max(0, mob.jumpLandedCooldownMs - ms);
  }
  const chasing = mob.aggro.damageInstances > 0 && target;

  // --- Flee trigger: low HP + hit → temporary reverse flee for 1.5s ---
  // Original MapleNecrocer mobs do not flee; openms-specific AI awareness
  // fleeMs decays naturally; facing reverses away from target during chase
  if (mob.fleeMs > 0) {
    mob.fleeMs -= ms;
  } else if (
    chasing &&
    mob.hitRemainingMs > 0 && // currently being hit (hit animation)
    mob.hp < mob.maxHP * 0.3 && // HP < 30%
    Math.random() < 0.1 // 10% trigger chance (not every hit)
  ) {
    mob.fleeMs = 1500; // flee for 1.5s
  }

  if (mob.jumpState === "none") {
    // --- Facing decision: hover (same level ±80px) vs roam (diff level ±300px) vs patrol ---
    let reachable = { reachable: true };
    if (chasing) {
      reachable = checkTargetReachability(mob, target);
    }

    if (chasing && reachable.reachable) {
      // Condition 1: reachable same level → hover ±80px
      if (!mob.hoverActive) {
        mob.hoverActive = true;
        mob.roamActive = false;
        updateHoverRange(mob, target.x);
      }
      if (mob.foothold.id !== mob.hoverFootholdId) {
        updateHoverRange(mob, target.x);
      }
      mob.facing = hoverFacing(mob);
    } else if (chasing) {
      // Condition 2: unreachable diff level → roam ±300px
      if (!mob.roamActive) {
        mob.roamActive = true;
        mob.hoverActive = false;
        updateRoamRange(mob, target.x);
      }
      if (mob.foothold.id !== mob.roamFootholdId) {
        updateRoamRange(mob, target.x);
      }
      mob.facing = roamFacing(mob);
    } else {
      mob.hoverActive = false;
      mob.hoverFootholdId = -1;
      mob.roamActive = false;
      mob.roamFootholdId = -1;
      // --- Patrol timed random decision ---
      mob.patrolDecisionMs += ms;
      if (mob.patrolDecisionMs >= mob.patrolNextDecisionMs) {
        mob.patrolDecisionMs = 0;
        mob.patrolNextDecisionMs = 400 + Math.random() * 400;
        const roll = Math.random();
        if (roll < 0.25) {
          mob.facing = -mob.facing;
          mob.patrolDecision = "walk";
        } else if (roll < 0.5) {
          mob.patrolDecision = "stand";
        } else {
          mob.patrolDecision = "walk";
        }
      }

      if (mob.x <= authored.rx0) mob.facing = 1;
      else if (mob.x >= authored.rx1) mob.facing = -1;
    }

    // --- Proactive jump (original case 199: Random.Next(200) == 199, ~0.5%/frame) ---
    // Only patrol mode + jumpCharges > 0 triggers (cooldown gates it)
    const proactiveJump =
      !chasing &&
      mob.patrolDecision === "walk" &&
      Math.random() < 0.01 * (ms / 16);
    // Note: proactiveJump uses direct Math.random(), not patrolDecision timer,
    // because original is per-frame independent random; timer would change rhythm

    const direction = mob.facing;

    // --- Gap detection: is there a connectedSegment past current FH endpoint? ---
    // MapleNecrocer Mob.cs L586-602 (walk left) / L662-679 (walk right).
    // Patrol conservative: edgeApproach < speed*1.2 → jump only at FH edge
    // Chase  predictive: edgeApproach < mob.speed*0.8 → jump ~48px before edge
    //                  + target.x must be past FH end (ensure chasing across gap)
    // Early jump lets mob travel ~30px more horizontally in air, crossing wider gaps
    const segment = mob.foothold;
    const edge = direction > 0 ? segment.x2 : segment.x1;
    const edgeApproach = Math.abs(edge - mob.x);
    const baseGapThreshold = Math.abs(speed) * 1.2; // patrol: ≈2px (30ms tick)
    const chaseGapThreshold = mob.speed * 0.8;      // chase: ≈48px (speed=60)
    const gapThreshold = chasing ? chaseGapThreshold : baseGapThreshold;

    // Chase extra condition: target.x past FH end AND target lands on ground
    // (no ground in gap → findBelowGround returns null → no predictive jump)
    const targetBeyondEdge = chasing && !mob.doJumpQueued
      ? (() => {
          const dir = Math.sign(target.x - mob.x);
          if (dir !== direction) return false; // target not in mob travel direction
          const edge = dir > 0 ? segment.x2 : segment.x1;
          if (!(dir > 0 ? target.x > edge : target.x < edge)) return false;
          // Build a temp mob (geometry + foothold.layer only) to check ground at target point
          // null foothold makes findBelowGround do layer-agnostic scan → OK
          const probeMob = {
            x: target.x, y: mob.y,
            geometry: mob.geometry,
            foothold: mob.foothold,
          };
          return findBelowGround(probeMob) !== null;
        })()
      : true;

    const gapAhead =
      edgeApproach < gapThreshold &&
      !connectedSegment(segment, direction) &&
      targetBeyondEdge;

    // --- Wall detection: is there a same-layer wall within 30px ahead? ---
    // MapleNecrocer Mob.cs L603-617 / L681-695.
    const wallAhead = findWallNearby(mob, direction, 30);

    // Wall jump safety check: must have ground segment on other side of wall (past wallX)
    // Otherwise dead-end wall with no landing spot → cannot jump, stop instead
    let wallHasGround = true;
    if (wallAhead) {
      const wallX = wallAhead.x1;
      const mobY = mob.y;
      const mobLayer = mob.foothold?.layer;
      const dir = direction;
      wallHasGround = false;
      // Scan all segments past wall for same-layer, non-wall ground with groundY ≥ mobY
      for (const seg of mob.geometry.segments) {
        if (segmentIsWall(seg)) continue;
        if (seg.layer !== mobLayer) continue;
        const segMinX = Math.min(seg.x1, seg.x2);
        const segMaxX = Math.max(seg.x1, seg.x2);
        // Segment must be on opposite side of wall (dir>0: minX>wallX, dir<0: maxX<wallX)
        const segIsBeyondWall = dir > 0 ? segMinX > wallX : segMaxX < wallX;
        if (!segIsBeyondWall) continue;
        const gy = groundY(seg, dir > 0 ? segMinX : segMaxX);
        if (gy >= mobY - 5 && gy <= mobY + 200) {
          // Found a walkable ground
          wallHasGround = true;
          break;
        }
      }
    }

    // --- Upper platform pathfind ---
    // Normal chase: scan target.x (upper platform directly above target)
    // Roam mode: scan 20px ahead of mob.x (pathfind upper platform, probabilistic jump)
    let upperPlatformPath = null;
    if (chasing && !mob.doJumpQueued) {
      if (mob.roamActive) {
        // roam: scan 20px ahead of mob for upper platform
        const probeX = mob.x + direction * 20;
        upperPlatformPath = findAboveGroundAhead(mob, probeX);
        if (!upperPlatformPath) {
          // Also scan target.x location
          upperPlatformPath = findAboveGroundAhead(mob, target.x);
        }
      } else {
        upperPlatformPath = findAboveGroundAhead(
          mob, Math.max(authored.rx0, Math.min(authored.rx1, target.x))
        );
      }
    }

    // Jump prerequisites: has charges + landed cooldown expired
    const canJump = mob.jumpCharges > 0 && mob.jumpLandedCooldownMs <= 0;

    // --- Ladder-below detection: debounced, only one roll per ladder ---
    const ladderHere = findLadderBelow(mob);
    if (!ladderHere) mob._ropeJumpRolledId = -1;
    const wasRolled = mob._ropeJumpRolledId === ladderHere?.id;
    const ropeJumpHit = chasing && ladderHere && !wasRolled && (() => {
      mob._ropeJumpRolledId = ladderHere.id;
      return Math.random() < ROPE_JUMP_PROBABILITY;
    })();

    // --- All jump triggers (probabilistic, unified charge + landed cooldown cost) ---
    const gapJumpHit = gapAhead && Math.random() < GAP_JUMP_PROBABILITY;
    const wallJumpHit = (wallAhead && wallHasGround) && Math.random() < WALL_JUMP_PROBABILITY;
    const upperPlatformJumpHit = upperPlatformPath && Math.random() < UPPER_PLATFORM_JUMP_PROBABILITY;

    if (canJump && (proactiveJump || gapJumpHit || wallJumpHit || upperPlatformJumpHit || ropeJumpHit)) {
      mob.jumpCharges--;
      if (mob.jumpCharges < 2 && mob.jumpCooldownMs === 0) {
        mob.jumpCooldownMs = 3000;
      }
      // Record takeoff FH; compare on landing: same FH = no platform landed → refund charge
      mob._jumpFromFhId = mob.foothold?.id ?? -1;
      mob.doJumpQueued = true;
      mob.x += mob.facing * speed;
    } else if (!chasing && mob.patrolDecision === "stand") {
      // Patrol stand decision → no movement
    } else if (mob.hoverActive || mob.roamActive) {
      // hover/roam: skip rx0/rx1 clamp, but still flip facing at FH edge
      moveMob(mob, mob.facing * speed, {
        rx0: -Infinity, rx1: Infinity,
      });
    } else {
      // Normal patrol/chase: walk along FH
      moveMob(mob, mob.facing * speed);
    }
  } else {
    // --- Airborne: horizontal not FH-constrained, but wall collision as safety net ---
    // Chase: target could flip behind; airborne can freely reverse facing
    // But hover/roam (moving toward A/C points): keep takeoff direction mid-jump
    if (chasing && !mob.hoverActive && !mob.roamActive) {
      const goal = Math.max(authored.rx0, Math.min(authored.rx1, target.x));
      const newFacing = Math.sign(goal - mob.x);
      if (newFacing !== 0) mob.facing = newFacing;
    }
    // Airborne wall collision: wall within 10px ahead → stop horizontal movement
    // Prevents mob from phasing through wall and falling into gap behind
    const dir = mob.facing;
    const wallAheadAir = findWallNearby(mob, dir, 10);
    if (wallAheadAir) {
      // Snap to wallX, no further advance
      mob.x = wallAheadAir.x1 - dir * 1;
    } else {
      mob.x += dir * speed;
    }
    // rx0/rx1 clamp (target in chase is also clamped here, so this is a safety net)
    if (mob.x <= authored.rx0) mob.facing = 1;
    else if (mob.x >= authored.rx1) mob.facing = -1;
  }

  // --- Physics (consume doJumpQueued, run gravity, detect landing) ---
  jumpMobPhysics(mob, ms);

  // --- Action selection ---
  if (mob.jumpState !== "none" || mob.doJumpQueued) {
    setMobAction(mob, "jump");
  } else {
    setMobAction(mob, "move");
  }
}

/** MapleNecrocer JumperSprite.DoMove sub-step implementation.
 *  An openms tick may contain multiple 17ms physics frames. */
function jumpMobPhysics(mob, ms) {
  mob.jumpAccumulatorMs += ms;
  while (mob.jumpAccumulatorMs >= MN_FRAME_MS) {
    mob.jumpAccumulatorMs -= MN_FRAME_MS;

    // AI layer queues jump
    if (mob.doJumpQueued && mob.jumpState === "none") {
      mob.jumpState = "jumping";
      mob.vy = MN_JUMP_INITIAL_VY;
      mob.doJumpQueued = false;
    }

    switch (mob.jumpState) {
      case "jumping":
        mob.vy += MN_GRAVITY_PER_FRAME;
        mob.y += mob.vy; // MapleNecrocer: Y += VelocityY (Y-down convention)
        if (mob.vy >= 0) mob.jumpState = "falling";
        break;
      case "falling": {
        // Original Mob.cs L539-541: FindBelow called with predicted pos before physics update
        // Predicted pos ≈ current mob.y (physics not updated yet, equiv to original Y - VelocityY - 2)
        const below = findBelowGround(mob);
        mob.vy += MN_GRAVITY_PER_FRAME;
        if (mob.vy > MN_MAX_FALL_VY) mob.vy = MN_MAX_FALL_VY;
        mob.y += mob.vy; // positive vy → Y increases → downward
        // Original L542: if (Y >= Below.Y - 3) → landed
        if (below && mob.y >= groundY(below, mob.x) - 3) {
          mob.y = groundY(below, mob.x);
          mob.foothold = below;
          mob.jumpState = "none";
          mob.vy = 0;
          mob.jumpAccumulatorMs = 0;
          // Jump missed platform (same FH) → refund charge, no landed cooldown
          const landedOnNewFh = mob._jumpFromFhId !== undefined && mob._jumpFromFhId !== below.id;
          if (!landedOnNewFh) {
            // stationary jump / no gap crossed / no platform landed → refund
            if (mob.jumpCharges < 2) mob.jumpCharges++;
            if (mob.jumpCharges >= 2) mob.jumpCooldownMs = 0;
            mob.jumpLandedCooldownMs = 0; // no cooldown
          } else {
            mob.jumpLandedCooldownMs = JUMP_LANDED_COOLDOWN_MS;
          }
          mob._jumpFromFhId = undefined;
          mob._ropeJump = false;
          mob._ropeJumpLanding = false;
        }
        break;
      }
      default:
        break;
    }
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
function moveMob(mob, distance, opts = {}) {
  if (mob.movement !== "ground-patrol") return;
  // roam mode call: { rx0: -Infinity, rx1: Infinity, facingFlipOnEdge: false }
  const { rx0, rx1, facingFlipOnEdge } = opts;
  const effectiveRx0 = rx0 ?? mob.record.authored.rx0;
  const effectiveRx1 = rx1 ?? mob.record.authored.rx1;
  const target = Math.max(effectiveRx0, Math.min(effectiveRx1, mob.x + distance));
  const direction = Math.sign(distance);
  if ((facingFlipOnEdge !== false) && target !== mob.x + distance) mob.facing = -direction;
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
      if (facingFlipOnEdge !== false) mob.facing = -direction;
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
  mob.jumpState = "none";
  mob.vy = 0;
  mob.jumpAccumulatorMs = 0;
  mob.doJumpQueued = false;
  mob.patrolDecisionMs = 0;
  mob.patrolNextDecisionMs = 400;
  mob.patrolDecision = "walk";
  mob.fleeMs = 0;
  mob.hoverActive = false;
  mob.hoverLeftX = 0;
  mob.hoverRightX = 0;
  mob.hoverFootholdId = -1;
  mob.roamLeftX = 0;
  mob.roamRightX = 0;
  mob.roamActive = false;
  mob.roamFootholdId = -1;
  mob.jumpCharges = 2;
  mob.jumpCooldownMs = 0;
  mob.jumpLandedCooldownMs = 0;
  mob._ropeJumpRolledId = -1;
  mob._boundaryFlipNext = false;
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
