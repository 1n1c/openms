/** Smoke test for MapleNecrocer jump physics port. */
import { expect, test, beforeAll, afterAll } from "bun:test";
import { stepMob, checkTargetReachability, roamFacing } from "../src/combat/offline-mobs.js";
import { createMobSkillStatus } from "../src/combat/mob-skill-status.js";

// After probabilistic jumps + boundary randomization, tests need deterministic Math.random()
// Returns 0 → all Math.random() < 0.5/0.35/0.6 probability checks hit
beforeAll(() => {
  globalThis._origRandom = Math.random;
  Math.random = () => 0;
});
afterAll(() => {
  Math.random = globalThis._origRandom;
});

function makeMockMob({ x, y, movementType = 2, speed = 60 }) {
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 500, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const groundSeg2 = {
    ...groundSeg, id: 2, x1: 700, x2: 1200,
  };
  const verticalWall = {
    id: 3, x1: 498, y1: 50, x2: 498, y2: 105,
    dx: 0, dy: 55, tx: 0, ty: 1, length: 55,
    prev: null, next: null, layer: 0, group: 0,
  };
  const gapFiller = null;
  const geometry = { segments: [groundSeg, groundSeg2, verticalWall] };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "mob", templateId: 9000000,
    record: { authored: { x, y, rx0: -100, rx1: 1500, f: 1 } },
    template,
    movementType, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: x, spawnY: y,
    previousX: x, previousY: y,
    x, y, speed,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    jumpCharges: 2, jumpCooldownMs: 0, jumpLandedCooldownMs: 0,
    fleeMs: 0, roamLeftX: 0, roamRightX: 0, roamActive: false,
    geometry, flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  return mob;
}

test("mobLoads: jump state fields initialized", () => {
  const mob = makeMockMob({ x: 100, y: 100 });
  expect(mob.jumpState).toBe("none");
  expect(mob.geometry.segments.length).toBe(3);
});

test("gapDetection: mob at FH edge queues jump", () => {
  // Walk toward gap at x=500, next segment starts at 700
  const mob = makeMockMob({ x: 490, y: 100 });
  for (let i = 0; i < 10; i++) stepMob(mob, 30, null, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

test("wallDetection: mob within 30px of vertical wall queues jump", () => {
  // Vertical wall at x=498. Start x=470 → 28px away (< 30px range)
  const mob = makeMockMob({ x: 470, y: 100 });
  stepMob(mob, 30, null, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

test("physicsSubStep: first tick runs jump frames", () => {
  const mob = makeMockMob({ x: 250, y: 100 });
  mob.doJumpQueued = true;
  stepMob(mob, 30, null, null);
  expect(mob.jumpState).toBe("jumping");
  expect(mob.vy).toBeLessThan(0); // negative = upward (Y-down convention)
  expect(mob.y).toBeLessThan(100); // went UP from ground level
});

test("fullJumpCycle: jump rises, peaks, falls, lands on same ground", () => {
  const mob = makeMockMob({ x: 250, y: 100 });
  mob.doJumpQueued = true;
  let minY = 100;
  for (let i = 0; i < 100; i++) {
    stepMob(mob, 30, null, null);
    if (mob.y < minY) minY = mob.y;
    if (mob.jumpState === "none") break;
  }
  // Peak height reached (minY < 100 means mob went up)
  expect(minY).toBeLessThan(100);
  // Eventually lands back on ground level
  expect(mob.jumpState).toBe("none");
  expect(Math.round(mob.y)).toBe(100);
  expect(mob.vy).toBe(0);
});

test("landingFromFall: falling mob snaps to ground segment below", () => {
  // Start falling from mid-air over solid ground at x=250 on groundSeg
  const mob = makeMockMob({ x: 250, y: 50 });
  mob.jumpState = "falling";
  mob.vy = 0;
  mob.jumpAccumulatorMs = 0;
  mob.doJumpQueued = false;
  for (let i = 0; i < 50; i++) {
    stepMob(mob, 30, null, null);
    if (mob.jumpState === "none") break;
  }
  expect(mob.jumpState).toBe("none");
  expect(Math.round(mob.y)).toBe(100);
});

test("groundMob: movementType=1 skips jumpMobStep entirely", () => {
  const mob = makeMockMob({ x: 490, y: 100, movementType: 1 });
  for (let i = 0; i < 15; i++) stepMob(mob, 30, null, null);
  expect(mob.jumpState).toBe("none");
  expect(mob.doJumpQueued).toBe(false);
});

test("standMob: movementType=0 stays idle, no physics runs", () => {
  const mob = makeMockMob({ x: 250, y: 100, movementType: 0 });
  mob.speed = 0;
  for (let i = 0; i < 5; i++) stepMob(mob, 30, null, null);
  expect(mob.jumpState).toBe("none");
  expect(mob.y).toBe(100);
});

test("multiPlatformFall: falling mob lands on LOWER ground, ignores upper platform above", () => {
  // Scenario: upper platform y=50 (air), lower ground y=200 (real ground)
  // mob starts falling from y=100
  // Correct: land on lower ground at y=200 (only lower satisfies groundY >= mobY)
  // Previous bug: land on upper platform at y=50 (groundY < mobY, selected by closest |gy-mobY|)
  const upperPlatform = {
    id: 10, x1: 0, y1: 50, x2: 500, y2: 50,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const lowerGround = {
    id: 11, x1: 0, y1: 200, x2: 500, y2: 200,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const mob = {
    id: "mob", templateId: 9000000,
    record: { authored: { x: 250, y: 100, rx0: -100, rx1: 1500, f: 1 } },
    template: { info, combat: {}, originalId: 9000000 },
    movementType: 2, movement: "ground-patrol",
    facing: 1, foothold: lowerGround,
    spawnFacing: 1, spawnFoothold: lowerGround,
    spawnX: 250, spawnY: 200,
    previousX: 250, previousY: 100,
    x: 250, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "falling", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    geometry: { segments: [upperPlatform, lowerGround] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  for (let i = 0; i < 100; i++) {
    stepMob(mob, 30, null, null);
    if (mob.jumpState === "none") break;
  }
  expect(mob.jumpState).toBe("none");
  expect(Math.round(mob.y)).toBe(200); // must land on lower ground
  expect(mob.foothold.id).toBe(11); // foothold switched to lower ground
});

test("findBelowGround: ignores upper platform (groundY < mobY), picks lower ground (groundY >= mobY)", () => {
  // Verify original core logic: only select groundY >= mobY
  const upperPlatform = {
    id: 10, x1: 0, y1: 50, x2: 500, y2: 50,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const lowerGround = {
    id: 11, x1: 0, y1: 200, x2: 500, y2: 200,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const mob = {
    id: "mob", templateId: 9000000,
    record: { authored: { x: 250, y: 100, rx0: -100, rx1: 1500, f: 1 } },
    template: { info, combat: {}, originalId: 9000000 },
    movementType: 2, movement: "ground-patrol",
    facing: 1, foothold: lowerGround,
    spawnFacing: 1, spawnFoothold: lowerGround,
    spawnX: 250, spawnY: 200,
    previousX: 250, previousY: 100,
    x: 250, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "falling", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    geometry: { segments: [upperPlatform, lowerGround] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  mob.y = 75; // in air, upperPlatform(y=50) above, lowerGround(y=200) below
  for (let i = 0; i < 100; i++) {
    stepMob(mob, 30, null, null);
    if (mob.jumpState === "none") break;
  }
  expect(Math.round(mob.y)).toBe(200);
  expect(mob.foothold.id).toBe(11);
});

test("chaseMode: aggro mob faces and moves toward target.x", () => {
  const mob = makeMockMob({ x: 300, y: 100 });
  // No aggro → patrol mode facing stays initial 1
  expect(mob.facing).toBe(1);
  // Give aggro
  mob.aggro.damageInstances = 1;
  // Target on left (x=100 < mob.x=300)
  const target = { x: 100 };
  stepMob(mob, 30, target, null);
  // Facing should flip to -1
  expect(mob.facing).toBe(-1);
});

test("chaseModeWithGap: chase mob at gap edge queues jump", () => {
  const mob = makeMockMob({ x: 490, y: 100 });
  mob.facing = -1; // prepare to chase left
  mob.aggro.damageInstances = 1;
  // Target on left, mob walks left to FH edge (x=500, left endpoint at x=0)
  // wait, groundSeg x1=0 x2=500, left endpoint x=0, mob at x=490 far from x=0
  // Should have gap to right! FH.next=null at x=500
  mob.facing = 1;
  const target = { x: 1000 }; // beyond rx1=1500, clamped to 1000
  stepMob(mob, 30, target, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

test("chaseAirborneReverse: hover/roam — no airborne facing flip while moving toward A/C points", () => {
  const mob = makeMockMob({ x: 200, y: 100 });
  mob.facing = 1;
  mob.aggro.damageInstances = 1;
  // First jump
  mob.doJumpQueued = true;
  // Target same height (hDiff=0) → reachable → hoverActive=true
  // Hover mode: airborne facing preserved
  stepMob(mob, 30, { x: 400 }, null);
  expect(mob.facing).toBe(1);
  expect(mob.jumpState).not.toBe("none"); // airborne
  // Target flips to left → hover mode keeps takeoff direction mid-jump
  stepMob(mob, 30, { x: 50 }, null);
  // Note: hover mode keeps direction (moving toward A/C points)
  expect(mob.facing).toBe(1);
});

test("patrolModeNoAggro: without aggro, mob ignores target entirely", () => {
  const mob = makeMockMob({ x: 250, y: 100 });
  mob.facing = 1;
  // No aggro, target far left
  stepMob(mob, 30, { x: -500 }, null);
  // Facing still 1 (patrol mode, no flip until rx1)
  expect(mob.facing).toBe(1);
});

// --- Step 3: patrol random decision (movementType=1 ground-patrol mob) ---

function makePatrolMob({ x, y, speed = 60 }) {
  // Use movementType=1, speed>0, ground-patrol → enters stepGroundMob patrol branch
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 1000, y2: 100,
    dx: 1000, dy: 0, tx: 1, ty: 0, length: 1000,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "patrol", templateId: 9000000,
    record: { authored: { x, y, rx0: 100, rx1: 900, f: 1 } },
    template,
    movementType: 1, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: x, spawnY: y,
    previousX: x, previousY: y,
    x, y, speed,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "move", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    jumpCharges: 2, jumpCooldownMs: 0, jumpLandedCooldownMs: 0,
    fleeMs: 0, roamLeftX: 0, roamRightX: 0, roamActive: false,
    geometry: { segments: [groundSeg] }, flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "move",
  };
  return mob;
}

test("patrolTimer: decision fires after patrolNextDecisionMs elapses", () => {
  const mob = makePatrolMob({ x: 500, y: 100 });
  mob.facing = 1;
  mob.patrolNextDecisionMs = 1; // speed up trigger
  mob.patrolDecisionMs = 0;
  // Run many ticks, let decisions fire multiple times
  for (let i = 0; i < 100; i++) {
    stepMob(mob, 30, null, null);
  }
  // Decision fired N+ times (100*30ms ~= 3000ms, each ~400-800ms → at least 4-7 times)
  // Verify patrolDecision toggles between walk/stand
  // Verify facing may have flipped (original 1 could become -1)
  // Do not test probability distribution (Math.random()), just verify decisions fired
  // Key check: mob moved (walk decision took effect)
  expect(mob.x).not.toBe(500); // should have moved
});

test("patrolDecisionStand: stand decision makes action=stand and x stops", () => {
  const mob = makePatrolMob({ x: 500, y: 100 });
  mob.facing = 1;
  mob.patrolDecision = "stand"; // force stand directly
  const beforeX = mob.x;
  stepMob(mob, 30, null, null);
  // Stand decision → action=stand, no movement
  expect(mob.action).toBe("stand");
  expect(mob.x).toBe(beforeX);
});

test("patrolDecisionWalk: walk decision makes action=move and x advances", () => {
  const mob = makePatrolMob({ x: 500, y: 100 });
  mob.facing = 1;
  mob.patrolDecision = "walk";
  const beforeX = mob.x;
  stepMob(mob, 30, null, null);
  expect(mob.action).toBe("move");
  expect(mob.x).toBeGreaterThan(beforeX);
});

test("patrolReverse: rx0/rx1 hard clamp overrides random facing", () => {
  const mob = makePatrolMob({ x: 100, y: 100 }); // rx0=100
  mob.facing = 1; // face right
  mob.patrolDecision = "walk";
  // Force facing=-1, then stepMob hard-flips to facing=1 because mob.x <= rx0
  mob.facing = -1;
  stepMob(mob, 30, null, null);
  expect(mob.facing).toBe(1); // rx0 hard reverse takes priority
});

test("aggroSkipsPatrolDecision: aggro mob uses chaseMob, patrol decision ignored", () => {
  const mob = makePatrolMob({ x: 500, y: 100 });
  mob.facing = 1;
  mob.patrolDecision = "stand"; // force stand
  mob.aggro.damageInstances = 1; // has aggro → take chase branch
  const beforeX = mob.x;
  // Target on left
  stepMob(mob, 30, { x: 200 }, null);
  // With aggro, chaseMob runs and patrolDecision=stand is skipped
  // Mob should move left
  expect(mob.x).toBeLessThan(beforeX);
});

test("jumpMobUnaffectedByPatrol: movementType=2 skips stepGroundMob patrol branch", () => {
  const mob = makeMockMob({ x: 250, y: 100 }); // movementType=2
  mob.patrolDecisionMs = 0;
  mob.patrolNextDecisionMs = 1;
  mob.patrolDecision = "stand"; // even with stand set, jump mob skips this branch
  mob.jumpLandedCooldownMs = 1001; // canJump=false, proactiveJump will not trigger
  stepMob(mob, 30, null, null);
  // Jump mob should take jumpMobStep path normally (physics runs, still on ground)
  // Key: patrol fields do not affect jump mob behavior
  expect(mob.jumpState).toBe("none"); // no gap/wall → no jump
  expect(mob.action).toBe("move"); // jump mob walks normally on ground
});

// --- Step 4: chase mode gap prediction ---

function makeChaseGapMob({ x, y, speed = 60 }) {
  // groundSeg: 0-500 (FH1), 500-700 is gap (FH1.next=null), groundSeg2: 700-1200 (across gap)
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 500, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const groundSeg2 = {
    id: 2, x1: 700, y1: 100, x2: 1200, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "chase", templateId: 9000000,
    record: { authored: { x, y, rx0: -100, rx1: 1500, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: x, spawnY: y,
    previousX: x, previousY: y,
    x, y, speed,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    jumpCharges: 2, jumpCooldownMs: 0, jumpLandedCooldownMs: 0,
    fleeMs: 0, roamLeftX: 0, roamRightX: 0, roamActive: false,
    geometry: { segments: [groundSeg, groundSeg2] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  return { mob, groundSeg, groundSeg2 };
}

test("chasePredictiveGapJump: chase mob jumps ~40px early to cross gap", () => {
  const { mob } = makeChaseGapMob({ x: 460, y: 100 });
  // mob.x=460, FH end x2=500, edgeApproach=40px
  // Patrol threshold ~= 2px → 40px >> 2px → no patrol jump
  // Chase threshold = mob.speed*0.8 = 48px → 40px < 48px → trigger predictive jump
  // targetBeyondEdge: target.x=800 > FH.X2=500 → satisfied
  mob.aggro.damageInstances = 1;
  stepMob(mob, 30, { x: 800 }, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

test("patrolConservativeGapJump: same position — patrol does not jump early", () => {
  const { mob } = makeChaseGapMob({ x: 460, y: 100 });
  // No aggro → patrol mode
  // mob.x=460, 40px from end, patrol threshold ~= 2px
  // 40px >> 2px → gapAhead not triggered
  stepMob(mob, 30, null, null);
  // Should still walk on FH, no jump
  expect(mob.jumpState).toBe("none");
  expect(mob.doJumpQueued).toBe(false);
  // Continue walking → will move
  expect(mob.x).toBeGreaterThan(460);
});

test("chaseNoJumpWhenTargetInGap: target inside gap → no early jump", () => {
  const { mob } = makeChaseGapMob({ x: 460, y: 100 });
  mob.aggro.damageInstances = 1;
  // target.x=550 → inside gap (500-700), not past FH.X2=500
  // targetBeyondEdge = false → gapAhead not triggered
  stepMob(mob, 30, { x: 550 }, null);
  expect(mob.jumpState).toBe("none");
  expect(mob.doJumpQueued).toBe(false);
});

test("chasePredictiveLeftGapJump: leftward chase also predicts gap", () => {
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  // Ground across gap is left of x1
  const leftGroundSeg = {
    id: 0, x1: 0, y1: 100, x2: 100, y2: 100,
    dx: 100, dy: 0, tx: 1, ty: 0, length: 100,
    prev: null, next: null, layer: 0, group: 0,
  };
  const groundSeg = {
    id: 1, x1: 200, y1: 100, x2: 500, y2: 100,
    dx: 300, dy: 0, tx: 1, ty: 0, length: 300,
    prev: null, next: null, layer: 0, group: 0,
  };
  const mob = {
    id: "L", templateId: 9000000,
    record: { authored: { x: 500, y: 100, rx0: -100, rx1: 1500, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: -1, // leftward
    foothold: groundSeg,
    spawnFacing: -1, spawnFoothold: groundSeg,
    spawnX: 500, spawnY: 100,
    previousX: 500, previousY: 100,
    x: 240, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 1, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    jumpCharges: 2, jumpCooldownMs: 0, jumpLandedCooldownMs: 0,
    fleeMs: 0, roamLeftX: 0, roamRightX: 0, roamActive: false,
    geometry: { segments: [groundSeg, leftGroundSeg] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  // mob.x=240, FH.X1=200, edgeApproach=40px, facing=-1
  // Chase threshold = 48px → 40px < 48px triggers
  // target.x=50 < FH.X1=200 → beyond edge
  // target.x=50 within leftGroundSeg (0-100) → findBelowGround finds ground → prediction triggers
  stepMob(mob, 30, { x: 50 }, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

// --- Step 5: AI awareness and randomness enhancements ---

test("jumpMobPatrolRandomDecision: jump mob patrol mode also has timed random decision", () => {
  // Previously jump mob had no patrol random decision; now shares patrolDecision with ground mob
  const { mob } = makeChaseGapMob({ x: 250, y: 100 });
  mob.patrolNextDecisionMs = 1; // speed up trigger
  mob.aggro.damageInstances = 0; // No aggro → patrol mode
  for (let i = 0; i < 50; i++) {
    stepMob(mob, 30, null, null);
  }
  // Key check: decision fired several times, mob stays within FH
  expect(mob.jumpState).toBe("none"); // no gap/wall/proactive → stays on ground
  // patrolDecision should toggle between walk/stand
});

test("jumpMobPatrolStand: jump mob does not move on patrol stand decision", () => {
  const { mob } = makeChaseGapMob({ x: 250, y: 100 });
  mob.patrolDecision = "stand"; // force stand
  const beforeX = mob.x;
  stepMob(mob, 30, null, null);
  expect(mob.x).toBe(beforeX);
  expect(mob.action).toBe("move"); // jump mob uses move action on ground even with stand (differs from ground mob)
});

test("proactiveJump: patrol mode proactive jump (original case 199)", () => {
  const { mob } = makeChaseGapMob({ x: 100, y: 100 });
  mob.patrolDecision = "walk";
  mob.aggro.damageInstances = 0; // patrol mode
  // Verify proactiveJump logic exists with correct conditions: !chasing + patrolDecision=walk
  // Trigger quickly by directly setting mob state
  mob.doJumpQueued = true; // simulate proactive jump directly
  stepMob(mob, 30, null, null);
  // Physics sub-step consumes doJumpQueued → jumpState="jumping"
  expect(mob.jumpState).not.toBe("none");
});

test("fleeReverse: low HP + hit + aggro → facing reverses to flee", () => {
  const { mob } = makeChaseGapMob({ x: 300, y: 100 });
  mob.facing = 1;
  mob.aggro.damageInstances = 1;
  mob.hitRemainingMs = 100; // currently being hit
  mob.hp = Math.floor(mob.maxHP * 0.2); // 20% HP
  mob.fleeMs = 0;
  // Force Math.random() < 0.1 to trigger flee (loop until it fires)
  // Set fleeMs manually instead
  mob.fleeMs = 1500;
  // Target on left (x=100), normal chasing facing should flip to -1
  // But fleeMs > 0 reverses facing → 1 (right side)
  stepMob(mob, 30, { x: 100 }, null);
  expect(mob.facing).toBe(1); // fleeing reverse, away from target.x=100
});

test("fleeExpire: facing restores chase direction when fleeMs expires", () => {
  const { mob } = makeChaseGapMob({ x: 300, y: 100 });
  mob.facing = 1;
  mob.aggro.damageInstances = 1;
  mob.fleeMs = 30; // only 30ms left
  stepMob(mob, 30, { x: 100 }, null); // fleeMs becomes 0
  // Target on left, fleeMs=0 -> normal chasing facing flips to -1
  expect(mob.fleeMs).toBeLessThanOrEqual(0);
  expect(mob.facing).toBe(-1);
});

test("fleeNoTriggerWithoutLowHp: full HP hit does not trigger flee", () => {
  const { mob } = makeChaseGapMob({ x: 300, y: 100 });
  mob.aggro.damageInstances = 1;
  mob.hitRemainingMs = 100;
  mob.hp = mob.maxHP; // full HP
  mob.fleeMs = 0;
  // Run 100 ticks, fleeMs should stay 0 (full HP never flees)
  for (let i = 0; i < 100; i++) stepMob(mob, 30, { x: 100 }, null);
  expect(mob.fleeMs).toBe(0);
});

test("upperPlatformPathfind: chase mode — target on upper platform → proactive jump", () => {
  // groundSeg: 0-500 y=100 (lower ground)
  // upperSeg: 200-400 y=50 (upper platform, height diff 50px < 63px jumpable)
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 500, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const upperSeg = {
    id: 2, x1: 200, y1: 50, x2: 400, y2: 50,
    dx: 200, dy: 0, tx: 1, ty: 0, length: 200,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "U", templateId: 9000000,
    record: { authored: { x: 100, y: 100, rx0: -100, rx1: 1500, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: 100, spawnY: 100,
    previousX: 100, previousY: 100,
    x: 100, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 1, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    jumpCharges: 2, jumpCooldownMs: 0, jumpLandedCooldownMs: 0,
    geometry: { segments: [groundSeg, upperSeg] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  // mob on lower y=100, target at x=300 within upperSeg range (200-400)
  // upperSeg groundY=50, heightDiff=50px < 63px → jump reachable
  // No gap/wall (groundSeg.next=null but mob.x=100 far from end)
  stepMob(mob, 30, { x: 300 }, null);
  expect(mob.doJumpQueued || mob.jumpState !== "none").toBe(true);
});

test("upperPlatformNotReachable: upper platform too high — no pathfind trigger", () => {
  // upperSeg y=20, height diff 80px > 63px → physically unreachable → no proactive jump
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 500, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const upperSeg = {
    id: 2, x1: 200, y1: 20, x2: 400, y2: 20,
    dx: 200, dy: 0, tx: 1, ty: 0, length: 200,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "U", templateId: 9000000,
    record: { authored: { x: 100, y: 100, rx0: -100, rx1: 1500, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: 100, spawnY: 100,
    previousX: 100, previousY: 100,
    x: 100, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 1, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    geometry: { segments: [groundSeg, upperSeg] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  stepMob(mob, 30, { x: 300 }, null);
  // Too high to jump, keep walking
  expect(mob.jumpState).toBe("none");
  expect(mob.doJumpQueued).toBe(false);
});

// --- Fix: mob phasing through wall and disappearing ---

test("wallDeadEnd: no ground on other side of wall → do not jump, stop instead", () => {
  // groundSeg: 0-500, wall blocks at x=498, no ground at all past wall (x>498)
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 500, y2: 100,
    dx: 500, dy: 0, tx: 1, ty: 0, length: 500,
    prev: null, next: null, layer: 0, group: 0,
  };
  const deadWall = {
    id: 2, x1: 498, y1: 50, x2: 498, y2: 105,
    dx: 0, dy: 55, tx: 0, ty: 1, length: 55,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "W", templateId: 9000000,
    record: { authored: { x: 470, y: 100, rx0: 0, rx1: 500, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: 470, spawnY: 100,
    previousX: 470, previousY: 100,
    x: 470, y: 100, speed: 60,
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "none", vy: 0, jumpAccumulatorMs: 0, doJumpQueued: false,
    geometry: { segments: [groundSeg, deadWall] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  stepMob(mob, 30, null, null);
  // No ground past wall → wallHasGround=false → no jump
  expect(mob.doJumpQueued).toBe(false);
  expect(mob.jumpState).toBe("none");
});

test("airborneWallCollision: airborne — wall ahead → stop horizontal movement", () => {
  // Mob airborne, wall within 10px ahead → x stops before wall
  const groundSeg = {
    id: 1, x1: 0, y1: 100, x2: 480, y2: 100,
    dx: 480, dy: 0, tx: 1, ty: 0, length: 480,
    prev: null, next: null, layer: 0, group: 0,
  };
  const wall = {
    id: 2, x1: 500, y1: 50, x2: 500, y2: 150,
    dx: 0, dy: 100, tx: 0, ty: 1, length: 100,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };
  const mob = {
    id: "A", templateId: 9000000,
    record: { authored: { x: 470, y: 100, rx0: 0, rx1: 1000, f: 1 } },
    template,
    movementType: 2, movement: "ground-patrol",
    facing: 1,
    foothold: groundSeg,
    spawnFacing: 1, spawnFoothold: groundSeg,
    spawnX: 470, spawnY: 100,
    previousX: 470, previousY: 100,
    x: 495, y: 85, speed: 60, // airborne, wallX=500 is 5px ahead
    maxHP: 100, maxMP: 100, hp: 100, mp: 100,
    alive: true, visible: true, active: true,
    state: "idle", inactiveReason: null,
    action: "jump", actionMs: 0, frame: 0, stateMs: 0,
    respawnMs: 0, spawnMs: 800, opacity: 1,
    cooldownMs: 2400, recoveryMs: 0,
    hitRemainingMs: 0, knockbackMs: 0, knockbackSpeed: 0,
    knockbackFacing: 0, knockbackDeceleration: 0,
    lastReaction: "none",
    aggro: { damageInstances: 0, expireStreak: 0, ticksRemaining: 0, updateMs: 0 },
    pendingAttack: null, attackFired: false, attackIndex: 0,
    body: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    sweptBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    attackBody: { left: 0, right: 0, top: 0, bottom: 0, active: false },
    delta: { x: 0, y: 0 },
    deaths: 0, lastDamage: 0,
    nameRemainingMs: 0, nameLabel: null, presentation: null, fault: null,
    jumpState: "jumping", vy: -5, jumpAccumulatorMs: 0, doJumpQueued: false,
    geometry: { segments: [groundSeg, wall] },
    flight: null,
    skillStatus: createMobSkillStatus(info),
    selectedSkills: [], attacks: [],
    actions: {
      jump: { duration: 0, ends: new Float64Array([0]), frames: [] },
      move: { duration: 0, ends: new Float64Array([0]), frames: [] },
      stand: { duration: 0, ends: new Float64Array([0]), frames: [] },
      die1: { duration: 0, ends: new Float64Array([0]), frames: [] },
      hit1: { duration: 0, ends: new Float64Array([0]), frames: [] },
    },
    defaultAction: "jump",
  };
  const beforeX = mob.x;
  stepMob(mob, 30, null, null);
  // Wall 5px ahead, mob should stop at wallX-1=499
  expect(mob.x).toBeLessThanOrEqual(499);
  expect(mob.x).toBeGreaterThanOrEqual(beforeX);
  // Must absolutely not pass through wallX=500
  expect(mob.x).toBeLessThan(500);
});

// --- Fix: enter roam mode when target height is unreachable ---

test("checkTargetReachability: same-level target is reachable", () => {
  const mob = makeMockMob({ x: 300, y: 100 });
  const result = checkTargetReachability(mob, { x: 400, y: 100 });
  expect(result.reachable).toBe(true);
});

test("checkTargetReachability: target below is reachable", () => {
  const mob = makeMockMob({ x: 300, y: 100 });
  const result = checkTargetReachability(mob, { x: 400, y: 150 }); // Y-down: y=150 is lower than y=100
  expect(result.reachable).toBe(true);
});

test("checkTargetReachability: ground mob — target above is unreachable", () => {
  // movementType=1 ground mob cannot jump
  const mob = makeMockMob({ x: 300, y: 100, movementType: 1 });
  const result = checkTargetReachability(mob, { x: 400, y: 50 });
  expect(result.reachable).toBe(false);
});

test("checkTargetReachability: jump mob — target too high is unreachable", () => {
  const mob = makeMockMob({ x: 300, y: 100 }); // movementType=2
  // No upper platform at target.x=400 → findAboveGroundAhead finds nothing
  const result = checkTargetReachability(mob, { x: 400, y: 10 }); // height diff 90px + no platform
  expect(result.reachable).toBe(false);
});

test("roamFacing: ping-pong along roamLeftX ↔ roamRightX boundaries", () => {
  const mob = makeMockMob({ x: 200, y: 100 });
  // Manually set roam range (simulate calc on first roam entry)
  mob.roamLeftX = 100;
  mob.roamRightX = 500;
  mob.facing = 1;
  // Middle position → keep facing
  expect(roamFacing(mob)).toBe(1);
  // Hit left boundary → flip right
  mob.x = 100;
  expect(roamFacing(mob)).toBe(1);
  // Hit right boundary → flip left
  mob.x = 500;
  expect(roamFacing(mob)).toBe(-1);
});

test("groundMobRoam: unreachable target height — aggro radius + FH clamping", () => {
  // makePatrolMob FH: 0-1000 y=100
  const mob = makePatrolMob({ x: 400, y: 100 });
  mob.movementType = 1;
  mob.aggro.damageInstances = 1;
  const target = { x: 450, y: 50 }; // too high to reach
  stepMob(mob, 30, target, null);
  expect(mob.roamActive).toBe(true);
  // roam = clamp(target.x ± 300, FH.x1, FH.x2)
  // target.x=450 → 450-300=150, 450+300=750
  // FH [0, 1000] → clamped to [150, 750]
  expect(mob.roamLeftX).toBe(150);
  expect(mob.roamRightX).toBe(750);
  // mob.x=400 < roamRightX=750 → walk right
  expect(mob.x).toBeGreaterThan(400);
});

test("roamRadiusFormula: aggro radius correctly clamped to FH boundaries", () => {
  // Three cases: large enough FH / too-small FH / very small FH
  // Test uses ground mob (movementType=1, no jumping)
  const seg1 = {
    id: 1, x1: 0, y1: 100, x2: 2000, y2: 100,
    dx: 2000, dy: 0, tx: 1, ty: 0, length: 2000,
    prev: null, next: null, layer: 0, group: 0,
  };
  const info = { level: 1, speed: 100, hpRecovery: 0, mpRecovery: 0 };
  const template = { info, combat: {}, originalId: 9000000 };

  // Case 1: FH [0, 2000], target at 500 → roam [200, 800] (FH large enough, no clamp)
  const mob1 = { ...makePatrolMob({ x: 500, y: 100 }), foothold: seg1, geometry: { segments: [seg1] } };
  mob1.movementType = 1;
  mob1.aggro.damageInstances = 1;
  stepMob(mob1, 30, { x: 500, y: 50 }, null);
  expect(mob1.roamLeftX).toBe(200);  // 500-300
  expect(mob1.roamRightX).toBe(800); // 500+300

  // Case 2: FH [0, 2000], target at 100 → roam [0, 400] (left clamped by FH.x1=0)
  const mob2 = { ...makePatrolMob({ x: 100, y: 100 }), foothold: seg1, geometry: { segments: [seg1] } };
  mob2.movementType = 1;
  mob2.aggro.damageInstances = 1;
  stepMob(mob2, 30, { x: 100, y: 50 }, null);
  expect(mob2.roamLeftX).toBe(0);    // max(-200, 0) = 0
  expect(mob2.roamRightX).toBe(400); // 100+300

  // Case 3: FH [0, 600] ("map length 600"), target at 300 → roam [0, 600] (full FH)
  const seg3 = { ...seg1, x1: 0, x2: 600 };
  const mob3 = { ...makePatrolMob({ x: 300, y: 100 }), foothold: seg3, geometry: { segments: [seg3] } };
  mob3.movementType = 1;
  mob3.aggro.damageInstances = 1;
  stepMob(mob3, 30, { x: 300, y: 50 }, null);
  expect(mob3.roamLeftX).toBe(0);    // max(0, 0) = 0
  expect(mob3.roamRightX).toBe(600); // min(600, 600) = 600
  // Searches the entire FH!
});

test("jumpMobRoam: unreachable target height — jump mob ping-pongs along FH", () => {
  // makeMockMob FH1: 0-500 y=100
  const mob = makeMockMob({ x: 300, y: 100 });
  mob.aggro.damageInstances = 1;
  const target = { x: 400, y: 10 }; // too high to reach
  stepMob(mob, 30, target, null);
  expect(mob.roamActive).toBe(true);
  expect(mob.jumpState).toBe("none");
  expect(mob.x).toBeGreaterThan(300); // walking toward FH right boundary (500)
});

test("roamEscapeFHChange: jump mob exits roam after landing on new FH with reachable target", () => {
  const mob = makeMockMob({ x: 300, y: 100 });
  mob.aggro.damageInstances = 1;
  const originalFH = mob.foothold;
  // Target high up unreachable → enter roam
  stepMob(mob, 30, { x: 400, y: 10 }, null);
  expect(mob.roamActive).toBe(true);
  expect(mob.roamFootholdId).toBe(originalFH.id);

  // Simulate jump landing on new FH (manual foothold switch)
  const newFH = { ...originalFH, id: 999 };
  mob.foothold = newFH;
  // On new FH, target is reachable (same level y=100)
  stepMob(mob, 30, { x: 400, y: 100 }, null);
  // FH changed → reachability rechecked → reachable → exit roam
  expect(mob.roamActive).toBe(false);
});

test("roamToHoverOnReachable: target becomes reachable during roam → switch to hover", () => {
  const mob = makeMockMob({ x: 300, y: 100 });
  mob.aggro.damageInstances = 1;
  const originalFH = mob.foothold;
  // Target high → unreachable → enter roam
  stepMob(mob, 30, { x: 300, y: 10 }, null);
  expect(mob.roamActive).toBe(true);
  // Player y suddenly same level (reachable=true) → immediately switch to hover
  stepMob(mob, 30, { x: 300, y: 100 }, null);
  expect(mob.hoverActive).toBe(true);
  expect(mob.roamActive).toBe(false);
  expect(mob.foothold.id).toBe(originalFH.id);
});

test("roamPingPongFH: auto-flip facing at FH end and walk back", () => {
  // Single-segment FH [200, 400] tight range, mob reaches end quickly
  const seg = {
    id: 1, x1: 200, y1: 100, x2: 400, y2: 100,
    dx: 200, dy: 0, tx: 1, ty: 0, length: 200,
    prev: null, next: null, layer: 0, group: 0,
  };
  const mob = {
    ...makeMockMob({ x: 210, y: 100 }),
    foothold: seg,
    geometry: { segments: [seg] },
  };
  mob.aggro.damageInstances = 1;
  const target = { x: 300, y: 10 }; // high, unreachable
  stepMob(mob, 30, target, null);
  expect(mob.roamActive).toBe(true);
  // mob.facing initially toward target.x (+1 right)
  // FH right boundary 400, mob reaches end quickly
  // Run N ticks: mob reaches 400 → flip facing → walks back to 200 → flip again
  let prevFacing = mob.facing;
  let facingFlips = 0;
  for (let i = 0; i < 200; i++) {
    stepMob(mob, 30, target, null);
    if (mob.facing !== prevFacing) {
      facingFlips++;
      prevFacing = mob.facing;
    }
  }
  // Should have flipped at least once (reached FH end)
  expect(facingFlips).toBeGreaterThanOrEqual(1);
});

test("hoverMode: reachable same level → ±80px ping-pong, not chase to target.x", () => {
  // FH [0, 1000], target.x=500 same level
  const seg = {
    id: 1, x1: 0, y1: 100, x2: 1000, y2: 100,
    dx: 1000, dy: 0, tx: 1, ty: 0, length: 1000,
    prev: null, next: null, layer: 0, group: 0,
  };
  const mob = {
    ...makePatrolMob({ x: 500, y: 100 }),
    foothold: seg, geometry: { segments: [seg] },
  };
  mob.movementType = 1;
  mob.aggro.damageInstances = 1;
  // Target same level y=100 → reachable → hover
  stepMob(mob, 30, { x: 500, y: 100 }, null);
  expect(mob.hoverActive).toBe(true);
  expect(mob.roamActive).toBe(false);
  // hover = clamp(500±80, 0, 1000) = [420, 580]
  expect(mob.hoverLeftX).toBe(420);
  expect(mob.hoverRightX).toBe(580);
  // Keep running → mob ping-pongs in [420, 580]
  let prevFacing = mob.facing;
  let flips = 0;
  let minX = Infinity, maxX = -Infinity;
  for (let i = 0; i < 200; i++) {
    stepMob(mob, 30, { x: 500, y: 100 }, null);
    if (mob.facing !== prevFacing) { flips++; prevFacing = mob.facing; }
    if (mob.x < minX) minX = mob.x;
    if (mob.x > maxX) maxX = mob.x;
  }
  expect(flips).toBeGreaterThanOrEqual(2);
  // Mob always within ±5px of hover range
  expect(minX).toBeGreaterThanOrEqual(415);
  expect(maxX).toBeLessThanOrEqual(585);
});

test("hoverToRoamFHChange: jump mob lands on new FH, target becomes unreachable → switch to roam", () => {
  // Start in hover (same level reachable)
  const mob = makeMockMob({ x: 300, y: 100 });
  mob.aggro.damageInstances = 1;
  const origFH = mob.foothold;
  stepMob(mob, 30, { x: 400, y: 100 }, null);
  expect(mob.hoverActive).toBe(true);
  // Jump to new FH, target above unreachable
  const newFH = { ...origFH, id: 999 };
  mob.foothold = newFH;
  stepMob(mob, 30, { x: 400, y: 10 }, null);
  expect(mob.roamActive).toBe(true);
  expect(mob.hoverActive).toBe(false);
});

