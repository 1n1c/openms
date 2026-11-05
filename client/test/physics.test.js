import { test, expect } from "bun:test";
import original from "../../docs/ghidra-physics-motion/wz-globals.json";
import {
  createSimulation,
  advanceSimulation,
  applyExternalImpulse,
  relocateSimulation,
} from "../src/physics/simulation.js";
import {
  compareRefreshRates,
  replayTrace,
} from "../tools/physics-reference.js";
import { attachGround } from "../src/physics/geometry.js";

// Synthetic isolating geometry and controlled velocities; not original-game recordings.
// Constants are the independently decoded original Map.wz:Physics.img values.
function floor(id, y, properties = {}) {
  return {
    id,
    layer: 1,
    group: 0,
    x1: -1000,
    y1: y,
    x2: 1000,
    y2: y,
    prev: 0,
    next: 0,
    properties,
  };
}
function world(footholds = [floor(1, 0)], map = {}) {
  return {
    schemaVersion: 1,
    globals: original.globals,
    footholds,
    ladders: [],
    map,
  };
}
function input(overrides = {}) {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    attack: false,
    jumpPressed: false,
    ...overrides,
  };
}

/** Explicitly seed a standing contact for isolated force tests, not map entry. */
function standing(terrain, spawn) {
  const sim = createSimulation(terrain, spawn);
  attachGround(sim, sim.geometry.byId.get(1));
  return sim;
}

test("grounded action follows intent at a blocking boundary and during a released slide", () => {
  const sim = standing(world(), { x: 970, y: 0 });
  advanceSimulation(sim, input({ right: true }), 120);
  expect(sim.x).toBe(970);
  expect(sim.speed).toBe(0);
  expect(sim.action).toBe("walk1");
  advanceSimulation(sim, input({ left: true, down: true }), 120);
  expect(sim.x).toBeLessThan(970);
  expect(sim.action).toBe("walk1");
  const movingX = sim.x;
  advanceSimulation(sim, input(), 30);
  expect(sim.x).toBeLessThan(movingX);
  expect(sim.action).toBe("stand1");
  advanceSimulation(sim, input({ down: true }), 30);
  expect(sim.action).toBe("prone");
});

test("a jump before the first real contact does not invent a standing foothold", () => {
  const sim = createSimulation(world(), { x: 0, y: 0 });
  advanceSimulation(sim, input({ jump: true, jumpPressed: true }), 30);
  expect(sim.y).toBeCloseTo(0.9, 10);
  expect(sim.vy).toBe(60);
});

test("a sub-quantum jump edge survives and holding jumps again after landing", () => {
  const sim = standing(world(), { x: 0, y: 0 });
  const held = input({ jump: true, jumpPressed: true });
  advanceSimulation(sim, held, 29);
  expect(sim.y).toBe(0);
  advanceSimulation(sim, held, 1);
  expect(sim.y).toBeCloseTo(-16.75, 10);
  expect(sim.vy).toBe(-495);
  for (let tick = 0; tick < 20; tick++) advanceSimulation(sim, held, 30);
  expect(sim.state).toBe("air");
  expect(sim.y).toBeLessThan(0);
  expect(sim.vy).toBeLessThan(0);
});

test("refresh partitions preserve actual moving and jumping outcomes", () => {
  const result = compareRefreshRates(world(), {
    spawn: { x: 0, y: 0 },
    durationMs: 3000,
    events: [
      { atMs: 17, key: "right", down: true },
      { atMs: 611, key: "jump", down: true },
      { atMs: 623, key: "jump", down: false },
      { atMs: 1811, key: "right", down: false },
    ],
  });
  expect(result.pass).toBe(true);
  expect(result.runs[0].snapshot.x).toBeGreaterThan(200);
  expect(result.runs[0].minimumY).toBeLessThan(-70);
  expect(result.runs[0].snapshot.state).toBe("ground");
});

test("reference extrema include intermediate physics steps in batched frames", () => {
  const trace = {
    spawn: { x: 0, y: 0 },
    durationMs: 3000,
    events: [
      { atMs: 600, key: "jump", down: true },
      { atMs: 630, key: "jump", down: false },
    ],
  };
  const fine = replayTrace(world(), trace, 60);
  const batched = replayTrace(world(), trace, 5);
  expect(batched.minimumY).toBe(fine.minimumY);
  expect(batched.minimumY).toBeLessThan(-70);
  expect(batched.snapshot.y).toBe(fine.snapshot.y);
});

test("bounded catch-up retains elapsed movement rather than discarding a stalled frame", () => {
  const bulk = standing(world(), { x: 0, y: 0 });
  const regular = standing(world(), { x: 0, y: 0 });
  const held = input({ right: true });
  advanceSimulation(bulk, held, 1000);
  expect(bulk.x).toBeCloseTo(24.405, 9);
  for (let pass = 0; pass < 4; pass++) advanceSimulation(bulk, held, 0);
  for (let tick = 0; tick < 33; tick++) advanceSimulation(regular, held, 30);
  expect(bulk.x).toBe(regular.x);
  expect(bulk.vx).toBe(125);
  expect(bulk.accumulatorMs).toBe(10);
});

test("drop eligibility does not restrict landing to the queried lower candidate", () => {
  const sim = standing(world([floor(1, 0), floor(2, 100), floor(3, 300)]), {
    x: 0,
    y: 0,
  });
  const held = input({ down: true, jump: true, jumpPressed: true });
  advanceSimulation(sim, held, 30);
  held.jump = false;
  for (let tick = 0; tick < 39; tick++) advanceSimulation(sim, held, 30);
  expect({ y: sim.y, foothold: sim.footholdId }).toEqual({
    y: 100,
    foothold: 2,
  });
});

test("the300pixel first query can override a near-floor rejection, but301cannot", () => {
  for (const [distance, accepted] of [
    [300, true],
    [301, false],
  ]) {
    const sim = standing(
      world([floor(1, 0), floor(2, 4), floor(3, distance)]),
      { x: 0, y: 0 },
    );
    advanceSimulation(
      sim,
      input({ down: true, jump: true, jumpPressed: true }),
      30,
    );
    expect(sim.ignoredFootholdId === 1).toBe(accepted);
    expect(sim.groundJumpSequence).toBe(accepted ? 1 : 0);
  }
});

test("drop support excludes600pixels and rejects less than5pixels", () => {
  for (const [distance, accepted] of [
    [599, true],
    [600, false],
    [4, false],
    [5, true],
  ]) {
    const sim = standing(world([floor(1, 0), floor(2, distance)]), {
      x: 0,
      y: 0,
    });
    advanceSimulation(
      sim,
      input({ down: true, jump: true, jumpPressed: true }),
      30,
    );
    expect(sim.state === "air").toBe(accepted);
  }
});

test("accepted drop-through emits one jump event while held or refused input emits none", () => {
  for (const forbidden of [false, true]) {
    const sim = standing(
      world([floor(1, 0, { forbidFallDown: forbidden }), floor(2, 100)]),
      { x: 0, y: 0 },
    );
    const held = input({ down: true, jump: true, jumpPressed: true });
    advanceSimulation(sim, held, 30);
    expect(sim.groundJumpSequence).toBe(forbidden ? 0 : 1);
    advanceSimulation(sim, held, 120);
    expect(sim.groundJumpSequence).toBe(forbidden ? 0 : 1);
  }
});

test("conveyor neutral, aligned and opposing branches use integer magnitude", () => {
  for (const [held, velocity] of [
    [{ left: true }, -84],
    [{}, -75.6],
    [{ right: true }, 8.4],
  ]) {
    const sim = standing(world([floor(1, 0, { force: -180 })]), { x: 0, y: 0 });
    advanceSimulation(sim, input(held), 30);
    expect(sim.vx).toBeCloseTo(velocity, 10);
    expect(sim.x).toBeCloseTo(velocity * 0.015, 10);
  }
  const unsupported = standing(world([floor(1, 0, { force: -50 })]), {
    x: 0,
    y: 0,
  });
  advanceSimulation(unsupported, input({ right: true }), 30);
  expect(unsupported.diagnostics.fault).toBe(
    "original-conveyor-division-by-zero",
  );
  expect(Number.isFinite(unsupported.x)).toBe(true);
});

test("friction clamps preserve the original below-one half multiplier", () => {
  for (const [fs, expectedVelocity] of [
    [0.001, 99.4],
    [10, 52],
  ]) {
    const sim = standing(world(undefined, { fs }), { x: 0, y: 0 });
    sim.speed = sim.vx = 100;
    advanceSimulation(sim, input(), 30);
    expect(sim.vx).toBeCloseTo(expectedVelocity, 10);
  }
});

test("steep natural slip reaches its own limit and uphill input halves it", () => {
  const slope = { ...floor(1, 0), x1: 0, x2: 280, y2: 960 };
  for (const [held, limit] of [
    [{}, 115.2],
    [{ left: true }, 57.6],
  ]) {
    const sim = standing(world([slope, floor(2, 2000)]), { x: 140, y: 480 });
    const keys = input(held);
    for (let tick = 0; tick < 10; tick++) advanceSimulation(sim, keys, 30);
    expect(sim.vx).toBeCloseTo(limit * 0.28, 10);
    expect(sim.vy).toBeCloseTo(limit * 0.96, 10);
  }
});

test("physical clipping stops horizontal and ceiling motion without inventing a bottom floor", () => {
  const grounded = standing(world(), { x: 969, y: 0 });
  grounded.speed = grounded.vx = 125;
  advanceSimulation(grounded, input({ right: true }), 30);
  expect({ x: grounded.x, vx: grounded.vx }).toEqual({ x: 970, vx: 0 });
  const rising = createSimulation(world(), { x: 0, y: -299 });
  rising.vy = -1000;
  advanceSimulation(rising, input(), 30);
  expect({ y: rising.y, vy: rising.vy }).toEqual({ y: -300, vy: 0 });
  const below = createSimulation(world(), { x: 1000, y: 9999 });
  expect({ x: below.x, y: below.y }).toEqual({ x: 970, y: 10 });
  advanceSimulation(below, input(), 30);
  expect(below.y).toBeGreaterThan(10);
  expect(below.state).toBe("air");
});

test("VRLimit gates viewport restrictions and zero edges remain unspecified", () => {
  const map = { VRLeft: -500, VRRight: 500, VRTop: -200, VRBottom: 100 };
  const unrestricted = createSimulation(world(undefined, map), {
    x: 600,
    y: -199,
  });
  expect({ x: unrestricted.x, y: unrestricted.y }).toEqual({ x: 600, y: -199 });
  const restricted = createSimulation(
    world(undefined, { ...map, VRLimit: 1 }),
    { x: 600, y: -199 },
  );
  expect({ x: restricted.x, y: restricted.y }).toEqual({ x: 480, y: -135 });
  const zeroLeft = createSimulation(
    world(undefined, { ...map, VRLeft: 0, VRLimit: 1 }),
    { x: -500, y: 0 },
  );
  expect(zeroLeft.x).toBe(-500);
});

test("authored inverted ladder endpoints preserve directional capture and idle position", () => {
  const terrain = world([floor(1, 375)]);
  terrain.ladders = [
    { id: 6, x: 0, y1: 374, y2: 372, ladder: 1, uf: 0, page: 3 },
  ];
  const sim = standing(terrain, { x: 0, y: 375 });
  advanceSimulation(sim, input({ up: true }), 30);
  expect({ state: sim.state, y: sim.y }).toEqual({ state: "ladder", y: 372 });
  advanceSimulation(sim, input(), 30);
  expect({ state: sim.state, y: sim.y }).toEqual({ state: "ladder", y: 372 });
  advanceSimulation(sim, input({ down: true }), 30);
  expect({ state: sim.state, y: sim.y }).toEqual({ state: "air", y: 373 });
});

test("grounded downward ladder entry is restricted to its top endpoint", () => {
  const terrain = world([floor(1, 50)]);
  terrain.ladders = [
    { id: 1, x: 0, y1: 0, y2: 100, ladder: 1, uf: 1, page: 0 },
  ];
  const sim = standing(terrain, { x: 0, y: 50 });
  advanceSimulation(sim, input({ down: true }), 30);
  expect(sim.state).toBe("ground");
  advanceSimulation(sim, input({ up: true }), 30);
  expect({ state: sim.state, y: sim.y }).toEqual({ state: "ladder", y: 50 });
});

test("external hits detach moving ground contact before applying the ordinary impulse", () => {
  const sim = standing(world(), { x: 0, y: 0 });
  sim.speed = sim.vx = 125;
  applyExternalImpulse(sim, -200, -200);
  advanceSimulation(sim, input({ right: true }), 30);
  expect(sim.x).toBeLessThan(-5);
  expect(sim.y).toBeCloseTo(-5.1, 10);
  expect(sim.state).toBe("air");
  expect(sim.footholdId).toBe(0);
});

test("the pre-impulse hook sees the simulation and vector before the merge", () => {
  const sim = createSimulation(world(), { x: 0, y: -100 });
  sim.vx = -350;
  sim.vy = 80;
  let seen = null;
  applyExternalImpulse(sim, -200, -200, (target, vx, vy) => {
    seen = {
      same: target === sim,
      x: target.x,
      y: target.y,
      vx: target.vx,
      vy: target.vy,
      mergedVx: vx,
      mergedVy: vy,
    };
  });
  expect(seen).toEqual({
    same: true,
    x: 0,
    y: -100,
    vx: -350,
    vy: 80,
    mergedVx: -200,
    mergedVy: -200,
  });
  expect({ vx: sim.vx, vy: sim.vy }).toEqual({ vx: -350, vy: -120 });
});

test("airborne hit components retain stronger aligned motion and combine opposing motion", () => {
  const sim = createSimulation(world(), { x: 0, y: -100 });
  sim.vx = -350;
  sim.vy = 80;
  applyExternalImpulse(sim, -200, -200);
  expect({ vx: sim.vx, vy: sim.vy }).toEqual({ vx: -350, vy: -120 });
  applyExternalImpulse(sim, 200, 200);
  expect({ vx: sim.vx, vy: sim.vy }).toEqual({ vx: -150, vy: 80 });
  applyExternalImpulse(sim, 0, 0);
  expect({ vx: sim.vx, vy: sim.vy }).toEqual({ vx: -150, vy: 80 });
});

test("a ladder hit with held up/down input keeps climbing (original behaviour)", () => {
  const terrain = world([floor(1, 50)]);
  terrain.ladders = [
    { id: 1, x: 0, y1: 0, y2: 100, ladder: 1, uf: 1, page: 0 },
  ];
  const sim = standing(terrain, { x: 0, y: 50 });
  advanceSimulation(sim, input({ up: true }), 30);
  expect(sim.state).toBe("ladder");
  // Holding up → verticalInput !== 0 → ladder preserved; climb() next tick
  // zeroes vx/vy so the knockback impulse is swallowed.
  applyExternalImpulse(sim, 200, -200);
  advanceSimulation(sim, input({ up: true }), 30);
  expect(sim.state).toBe("ladder");
  expect(sim.ladderId).toBe(1);
});

test("a ladder hit with no held input throws the actor off (original behaviour)", () => {
  const terrain = world([floor(1, 50)]);
  terrain.ladders = [
    { id: 1, x: 0, y1: 0, y2: 100, ladder: 1, uf: 1, page: 0 },
  ];
  const sim = standing(terrain, { x: 0, y: 50 });
  advanceSimulation(sim, input({ up: true }), 30);
  expect(sim.state).toBe("ladder");
  // No held input → verticalInput === 0 → normal detach and knockback.
  advanceSimulation(sim, input({}), 30);
  applyExternalImpulse(sim, 200, -200);
  advanceSimulation(sim, input({}), 30);
  expect(sim.state).toBe("air");
  expect(sim.ladderId).toBe(0);
  expect(sim.x).toBeGreaterThan(5);
});

/** A distant upper ledge admits tall spawns without bypassing native map bounds. */
function fallWorld(map = {}) {
  const ledge = floor(2, -600);
  ledge.x1 = 800;
  ledge.x2 = 900;
  return world([floor(1, 0), ledge], map);
}

test("fall damage begins after thirty terminal-speed quanta, not after an ordinary jump", () => {
  const shortFall = createSimulation(fallWorld(), { x: 0, y: -575 });
  const highFall = createSimulation(fallWorld(), { x: 0, y: -595 });
  shortFall.vy = 670;
  highFall.vy = 670;
  for (let tick = 0; tick < 30; tick++) {
    advanceSimulation(shortFall, input(), 30);
    advanceSimulation(highFall, input(), 30);
  }
  expect(shortFall.landing.sequence).toBe(0);
  expect(highFall.state).toBe("ground");
  expect(highFall.landing.amount).toBe(8);
  expect(highFall.landing.sequence).toBe(1);
  advanceSimulation(highFall, input(), 30);
  expect(highFall.landing.amount).toBe(0);
  expect(highFall.landing.sequence).toBe(1);
  const jump = standing(world(), { x: 0, y: 0 });
  advanceSimulation(jump, input({ jumpPressed: true }), 30);
  for (let tick = 0; tick < 30; tick++) advanceSimulation(jump, input(), 30);
  expect(jump.state).toBe("ground");
  expect(jump.landing.sequence).toBe(0);
});

test("relocation clears fall history while field protection suppresses real high falls", () => {
  const moved = createSimulation(fallWorld(), { x: 0, y: -795 });
  moved.vy = 670;
  for (let tick = 0; tick < 30; tick++) advanceSimulation(moved, input(), 30);
  expect(moved.landing.terminalTicks).toBe(30);
  relocateSimulation(moved, { x: 0, y: -5 });
  for (let tick = 0; tick < 5; tick++) advanceSimulation(moved, input(), 30);
  expect(moved.state).toBe("ground");
  expect(moved.landing.sequence).toBe(0);
  const protectedFall = createSimulation(fallWorld({ fieldLimit: 0x100000 }), {
    x: 0,
    y: -595,
  });
  protectedFall.vy = 670;
  for (let tick = 0; tick < 30; tick++) {
    advanceSimulation(protectedFall, input(), 30);
  }
  expect(protectedFall.state).toBe("ground");
  expect(protectedFall.landing.sequence).toBe(0);
});

test("ordinary down-jump and buoyant landings do not acquire fall damage", () => {
  const drop = standing(world([floor(1, 0), floor(2, 500)]), { x: 0, y: 0 });
  advanceSimulation(drop, input({ down: true, jumpPressed: true }), 30);
  for (let tick = 0; tick < 70; tick++) advanceSimulation(drop, input(), 30);
  expect(drop.footholdId).toBe(2);
  expect(drop.landing.sequence).toBe(0);
  for (const mode of ["swim", "fly"]) {
    const buoyant = createSimulation(world(undefined, { [mode]: 1 }), {
      x: 0,
      y: -5,
    });
    // Isolate landing admission from slow buoyant integration: even a preexisting
    // qualifying counter cannot admit a hit when the landing is not freefall.
    buoyant.landing.terminalTicks = 30;
    buoyant.vy = 670;
    advanceSimulation(buoyant, input(), 30);
    expect(buoyant.footholdId).toBe(1);
    expect(buoyant.landing.sequence).toBe(0);
  }
});
