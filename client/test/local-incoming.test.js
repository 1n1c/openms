import { expect, test } from "bun:test";
import { LocalIncoming } from "../src/online/local-incoming.js";
import { animationId } from "../../shared/motion-schema.js";
import { PLAYER_HIT } from "../../shared/combat-protocol.js";

const MOB_BODY = { left: -90, top: -60, right: 90, bottom: 0 };

function mobLife(overrides = {}) {
  return {
    info: {
      level: 10,
      PADamage: 120,
      MADamage: 0,
      acc: 40,
      noFlip: 0,
      ...overrides.info,
    },
    combat: {
      attacks: overrides.attacks ?? [
        {
          action: "attack1",
          supported: true,
          rectangle: MOB_BODY,
          properties: { type: 0, attackAfter: 600, PADamage: 120 },
        },
      ],
    },
  };
}

function mobView(options = {}) {
  const x = options.x ?? 60;
  const y = options.y ?? 0;
  return {
    entity: {
      id: options.id ?? "mob-a",
      kind: "mob",
      position: { x, y },
      facing: options.facing ?? -1,
      action: animationId(options.action ?? "attack1"),
      actionStartTick: options.actionStartTick ?? 3,
      mobState: {
        hp: 400,
        phase: options.phase ?? "attack",
        elapsedMs: options.elapsedMs ?? 0,
        generation: 0,
      },
    },
    animation: {
      action: options.action ?? "attack1",
      frame: 0,
      current: { geometry: [{ y: -20 }] },
    },
    drawX: x,
    drawY: y,
    life: options.life ?? mobLife(),
  };
}

function selfView(x = 20) {
  const expressions = new Set(["hit", "default"]);
  const faces = [];
  return {
    entity: {
      id: "self",
      kind: "player",
      position: { x, y: 0 },
      facing: 1,
      combatState: { phase: "idle" },
    },
    animation: {
      current: { geometry: [{ y: -20 }] },
      frame: 0,
      expressions,
      setExpression: (name, duration) => faces.push({ name, duration }),
    },
    faces,
    drawX: x,
    drawY: 0,
  };
}

function stats(overrides = {}) {
  return {
    level: 10,
    str: 100,
    dex: 40,
    luk: 10,
    pdd: 40,
    evasionPercent: 0,
    ...overrides,
  };
}

function fixture(options = {}) {
  const shown = [];
  const views = new Map();
  const self = options.self ?? selfView();
  views.set("self", self);
  const view = options.view ?? mobView();
  views.set(view.entity.id, view);
  const scene = {
    selfId: "self",
    views,
    scene: { simulation: { state: "ground", crouching: false } },
    events: {
      reserveNumber: () => {},
      combat: {
        snapshot: () => ({ active: 0, pending: 0, hardCapacity: 200 }),
        fixedNumberPlacement: (x, y) => ({ x, y }),
        show: (amount, family, placement) =>
          shown.push({ amount, family, placement }),
      },
    },
  };
  const host = {
    scene,
    owner: { state: { presentation: { stats: options.stats ?? stats() } } },
    // The real owner is the local hit resolver; contact prediction reuses its authored
    // frame receiver, so the double mirrors that one method.
    hits: {
      mobBody: (subject, slot) => {
        slot.active = true;
        slot.left = subject.drawX - 90;
        slot.top = subject.drawY - 60;
        slot.right = subject.drawX + 90;
        slot.bottom = subject.drawY;
        return slot;
      },
    },
  };
  let now = 1000;
  const incoming = new LocalIncoming(
    host,
    () => now,
    options.random ?? (() => 0.5),
  );
  return {
    incoming,
    view,
    self,
    shown,
    time: (ms) => {
      now = ms;
    },
  };
}

test("a released mob swing against the local player shows its digit at the authored frame", () => {
  const f = fixture();
  f.incoming.observe(f.view, 500);
  expect(f.shown.length).toBe(0);
  f.incoming.observe(f.view, 200);
  expect(f.shown.length).toBe(1);
  expect(f.shown[0].family).toBe(2);
  expect(f.shown[0].amount).toBeGreaterThan(0);
  // The authored flinch face starts on the same frame.
  expect(f.self.faces).toEqual([{ name: "hit", duration: PLAYER_HIT.timerMs }]);
  // The same attack instance cannot be resolved twice.
  f.incoming.observe(f.view, 100);
  expect(f.shown.length).toBe(1);
});

test("a swing whose authored area misses the local player predicts nothing", () => {
  const view = mobView();
  view.drawX = 400;
  view.drawY = -400;
  const f = fixture({ view });
  f.incoming.observe(f.view, 800);
  expect(f.shown.length).toBe(0);
});

test("the authoritative incoming impact consumes exactly one local prediction", () => {
  const f = fixture();
  f.incoming.observe(f.view, 700);
  expect(f.shown.length).toBe(1);
  expect(
    f.incoming.consume({
      cause: "mob-attack",
      actorId: "mob-a",
      targetId: "self",
      damage: 55,
    }),
  ).toBe(true);
  expect(
    f.incoming.consume({
      cause: "mob-attack",
      actorId: "mob-a",
      targetId: "self",
      damage: 55,
    }),
  ).toBe(false);
  // Another actor's impact and a missed authoritative outcome are never consumed.
  expect(
    f.incoming.consume({
      cause: "mob-attack",
      actorId: "mob-b",
      targetId: "self",
      damage: 55,
    }),
  ).toBe(false);
  expect(
    f.incoming.consume({
      cause: "mob-attack",
      actorId: "mob-a",
      targetId: "self",
      damage: 0,
    }),
  ).toBe(false);
});

test("an expired prediction is no longer consumed by a late confirmation", () => {
  const f = fixture();
  f.incoming.observe(f.view, 700);
  f.time(9000);
  expect(
    f.incoming.consume({
      cause: "mob-attack",
      actorId: "mob-a",
      targetId: "self",
      damage: 12,
    }),
  ).toBe(false);
});

/** A mob whose authored controller deals damage by touching the player (`bodyAttack`). */
function contactLife() {
  return mobLife({ info: { bodyAttack: 1 }, attacks: [] });
}

test("a body-attack mob resolves contact damage on the first overlapping frame", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(1);
  expect(f.shown[0].family).toBe(2);
  expect(f.shown[0].amount).toBeGreaterThan(0);
  expect(f.self.faces).toEqual([{ name: "hit", duration: PLAYER_HIT.timerMs }]);
});

test("contact damage shares the hit window instead of ticking every frame", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(1);
  // Still inside the 1500 ms window the authority uses for every incoming outcome.
  for (let frame = 0; frame < 10; frame++) {
    f.incoming.advance(30);
    f.incoming.observe(f.view, 30);
  }
  expect(f.shown.length).toBe(1);
  // Past the window the next overlapping frame resolves again.
  f.incoming.advance(1200);
  f.incoming.observe(f.view, 1200);
  expect(f.shown.length).toBe(2);
});

test("a mob without the authored body attack deals no contact damage", () => {
  const view = mobView({ life: mobLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(0);
});

test("a body-attack mob out of reach deals no contact damage", () => {
  const view = mobView({ life: contactLife(), phase: "idle", x: 900 });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(0);
});

test("the authoritative contact impact consumes one local prediction", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(1);
  expect(
    f.incoming.consume({
      cause: "contact",
      actorId: "mob-a",
      targetId: "self",
      damage: 7,
    }),
  ).toBe(true);
  expect(
    f.incoming.consume({
      cause: "contact",
      actorId: "mob-a",
      targetId: "self",
      damage: 7,
    }),
  ).toBe(false);
});

test("many nearby mobs share one frame clock and cannot shorten hit protection", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(view, 16);
  for (let frame = 0; frame < 20; frame++) {
    f.incoming.advance(30);
    for (let mob = 0; mob < 30; mob++) f.incoming.observe(view, 30);
  }
  expect(f.shown).toHaveLength(1);
  expect(f.incoming.contactCooldownMs).toBe(PLAYER_HIT.timerMs - 600);
});

test("dead or spawning mobs cannot predict contact and field teardown clears protection", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  view.entity.mobState.hp = 0;
  f.incoming.observe(view, 16);
  view.entity.mobState.hp = 400;
  view.entity.mobState.phase = "spawning";
  f.incoming.observe(view, 16);
  expect(f.shown).toHaveLength(0);
  view.entity.mobState.phase = "idle";
  f.incoming.observe(view, 16);
  expect(f.shown).toHaveLength(1);
  f.incoming.destroy();
  expect(f.incoming.contactCooldownMs).toBe(0);
});
