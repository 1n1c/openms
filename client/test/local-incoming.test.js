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

/** A mob whose authored controller deals damage by touching the player (`bodyAttack`).
 *  BodyAttack contact is fully server-authoritative — the client no longer rolls
 *  RNG or predicts contact damage locally. All HIT/MISS, knockback, and blink
 *  come from server impact events (via fallbackPresent on the client). */
function contactLife() {
  return mobLife({ info: { bodyAttack: 1 }, attacks: [] });
}

test("a body-attack mob does NOT predict contact damage locally", () => {
  // Server-authoritative model: observe() no longer produces local float/blink.
  // Contact damage rendering is driven entirely by server impact events.
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(0);
  expect(f.self.faces).toEqual([]);
});

test("a body-attack mob out of reach also predicts nothing (no-op in both models)", () => {
  const view = mobView({ life: contactLife(), phase: "idle", x: 900 });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(0);
});

test("a mob without the authored body attack deals no contact damage", () => {
  const view = mobView({ life: mobLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.observe(f.view, 16);
  expect(f.shown.length).toBe(0);
});

test("server hit(amount>0) on bodyAttack renders via fallbackPresent with blink", () => {
  // No local prediction — server impact arrives first → fallbackPresent handles it.
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  f.incoming.fallbackPresent(500, "mob-a");
  expect(f.shown.length).toBe(1);
  expect(f.shown[0].amount).toBe(500);
  expect(f.self.faces).toEqual([{ name: "hit", duration: 1500 }]);
});

test("server MISS(amount=0) on bodyAttack renders MISS glyph — no blink, no hit face", () => {
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  // scene-events.damage no longer guards amount>0 — MISS also calls fallbackPresent
  f.incoming.fallbackPresent(0, "mob-a");
  // CombatPresentation.show(0) renders blue "MISS" glyph
  expect(f.shown.length).toBe(1);
  expect(f.shown[0].amount).toBe(0);
  // But present() skips hit face + feedback for amount<=0 → no blink, no face
  expect(f.self.faces).toEqual([]);
});

test("authoritative contact impact with no local prediction always lets fallbackPresent run", () => {
  // Server-authoritative: consume() always returns false for contact impacts
  // (resolveContact is empty → no pending ever written). Each authoritative
  // impact → scene-events.damage → fallbackPresent → correct glyph rendered.
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  // No observe() → no local prediction made
  const consumed = f.incoming.consume({
    cause: "contact",
    actorId: "mob-a",
    targetId: "self",
    damage: 7,
  });
  expect(consumed).toBe(false); // no pending entry → always false
  // Then scene-events calls fallbackPresent
  f.incoming.fallbackPresent(7, "mob-a");
  expect(f.shown.length).toBe(1);
  // Second same-mob impact (e.g. consecutive ticks on same body) also returns false
  // and also renders — fallbackPresent handles multiple impacts per mob correctly.
  const consumed2 = f.incoming.consume({
    cause: "contact",
    actorId: "mob-a",
    targetId: "self",
    damage: 0, // MISS this tick
  });
  expect(consumed2).toBe(false); // always false — no fallbackRendered dedup
  f.incoming.fallbackPresent(0, "mob-a");
  expect(f.shown.length).toBe(2); // hit + MISS both rendered on queue
});

test("fallbackPresent renders even when protectionMs is already synced from server", () => {
  // Simulate the race where character state (with protectionMs=+1500ms) arrives
  // BEFORE the impact event. localTarget() would return null because protectionMs
  // has not yet expired, but fallbackPresent skips that guard — the server has
  // already admitted this hit, so the invulnerability window does not apply.
  const view = mobView({ life: contactLife(), phase: "idle" });
  const f = fixture({ view });
  // Simulate server-synced protection window still active on the client
  f.self.entity.combatState.protectionMs = 1500;
  // Verify localTarget() would actually reject here (sanity check)
  expect(f.incoming.localTarget()).toBeNull();
  // But fallbackPresent should still render — it skips the protectionMs guard
  f.incoming.fallbackPresent(500, "mob-a");
  expect(f.shown.length).toBe(1);
  expect(f.shown[0].amount).toBe(500);
  expect(f.self.faces).toEqual([{ name: "hit", duration: 1500 }]);
});
