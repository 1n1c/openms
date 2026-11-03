import { movementStreamView } from "../src/movement-stream.js";
import { createSimulation } from "../../client/src/physics/simulation.js";
import {
  createHeldInput,
  assignHeldInput,
  stepMotion,
  captureMotion,
  restoreMotion,
} from "../../shared/motion.js";
import { afterEach, expect, test } from "bun:test";
import { loadContent } from "../src/content.js";
import { OnlineWorld } from "../src/world.js";
import {
  prepareActorCombat,
  refreshActorCombat,
  attackRewindTicks,
} from "../src/field-combat.js";
import { prepareActorSkills, disposeActorSkills } from "../src/field-skills.js";
import { createProfile } from "../../client/src/profile/profile-validation.js";
import { PhysicalDamage } from "../../client/src/combat/physical-damage.js";
import { createWeaponUse } from "../../client/src/combat/weapon-usage.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../../client/src/character/character-stats.js";
import {
  DAMAGE_LIMIT,
  shownDamageRange,
} from "../../shared/combat-formulas.js";
import { domainEventSchema } from "../../shared/protocol.js";
import { validate } from "../../shared/schema.js";

const content = await loadContent();
const probes = [];
afterEach(() => {
  for (const probe of probes) disposeActorSkills(probe.actor, true);
  probes.length = 0;
});

/** Current production authority runtime and real WZ metadata; persistence is outside this calculation test. */
async function fixture() {
  const publications = [];
  const world = new OnlineWorld({
    content,
    database: {},
    log() {},
    publish(actor, message) {
      publications.push(message);
    },
  });
  world.now = 0;
  world.nextUint32 = () => 9999999;
  const field = await world.fieldFor(100010000);
  const mob = field.mobs.find(
    (entry) => entry.active && entry.templateId === 130101,
  );
  if (!mob) {
    throw new Error("Formula fixture requires an authored active monster");
  }
  field.mobs = [mob];
  const profile = createProfile({
    mapId: field.manifest.id,
    x: mob.x,
    y: mob.y,
    facing: 1,
  });
  profile.level = 50;
  profile.str = 100;
  profile.dex = 20;
  profile.onlineState = { effects: [], cooldowns: {} };
  const actor = {
    id: "formula-player",
    profile,
    revision: 0,
    session: { expiresAt: Date.now() + 60000 },
  };
  world.prepareEntry(actor, field);
  prepareActorCombat(world, actor);
  await prepareActorSkills(world, actor);
  actor.state = "active";
  field.characters.set(actor.id, actor);
  world.actors.set(actor.id, actor);
  const probe = { world, field, actor, mob, publications };
  probes.push(probe);
  return probe;
}

test("server and client project the same modern stats and ordinary hit", async () => {
  const { actor, mob } = await fixture();
  const offline = projectCharacterStats(
    actor.profile,
    actor.statHooks,
    createCharacterStats(),
  );
  expect(offline).toEqual(actor.stats);
  const shown = {};
  shownDamageRange(offline, shown);
  // Panel display v83: max=floor((floor(WM*main)+secondary)*WATK/100)=floor((400+20)*17/100)=71
  // min=floor((floor(WM*main)*0.1+secondary)*WATK/100)=floor((40+20)*17/100)=10
  expect(shown).toEqual({ damageMin: 10, damageMax: 71 });
  const use = createWeaponUse();
  use.projectilePAD = 0;
  const server = actor.skillField.skillCombat.basicDamage(
    actor.stats,
    mob,
    use,
  );
  const client = new PhysicalDamage(Math.random, () => 9999999).generate(
    offline,
    mob.skillStatus.projected,
    100,
    use,
  );
  expect(server).toBe(client);
  expect(server).toBe(86);
});

test("late attack input is admitted once with its original identity and fresh combat presentation", async () => {
  const { world, actor, field } = await fixture();
  field.tick = 80;
  world.moveActor(actor);
  const client = createSimulation(field.physics, {
    x: actor.simulation.x,
    y: actor.simulation.y,
  });
  restoreMotion(client, captureMotion(actor.simulation));
  const held = createHeldInput();
  field.tick = 100;
  for (let sequence = 1; sequence <= 2; sequence++) {
    const input = {
      fieldEpoch: field.epoch,
      ...movementStreamView(actor),
      inputSeq: sequence,
      targetTick: 80 + sequence,
      horizontal: 0,
      vertical: 0,
      attack: sequence === 1,
      jump: false,
      movementLocked: false,
      impulses: [],
    };
    assignHeldInput(held, input);
    stepMotion(client, held);
    const { x, y, vx, vy } = client;
    world.input(actor, { ...input, motion: { x, y, vx, vy } });
  }
  expect(actor.inputQueue.size).toBe(2);
  world.tickField(field);
  world.tickField(field);
  expect(actor.skillField.phase).toBe("attack");
  expect(actor.combatPresentation.inputSeq).toBe(1);
  expect(actor.combatPresentation.phase).toBe("attack");
  expect(actor.attackEdges).toHaveLength(0);
  const actionId = actor.skillField.actionId;
  world.tickField(field);
  expect(actor.skillField.actionId).toBe(actionId);
  actor.skills.resources.feedbackId = "new-skill";
  actor.skillField.startPose("swingO1", "attack");
  actor.skills.resources.feedbackId = null;
  expect(actor.combatPresentation.feedbackId).toBe("new-skill");
  expect(actor.combatPresentation.phaseMs).toBe(0);
});

test("server incoming admission uses modern defense without StandardPDD", async () => {
  const { world, actor, mob } = await fixture();
  actor.profile.level = mob.template.info.level;
  refreshActorCombat(world, actor);
  actor.skillField.incomingOptions.standardPDD = null;
  const admitted = actor.skillField.prepareMobHitAdmission(mob, false);
  expect(admitted.admitted).toBe(true);
  const client = new PhysicalDamage(Math.random, () => 9999999);
  expect(admitted.hit.amount).toBe(
    client.receive(actor.stats, mob.skillStatus.projected, { magic: false }),
  );
  expect(admitted.hit.amount).toBeGreaterThan(0);
});

test("modern dodge still records MISS without moving or debiting the player", async () => {
  const { world, actor, mob } = await fixture();
  actor.profile.luk = 1000;
  refreshActorCombat(world, actor);
  actor.skillField.damageGenerator.nextUint32 = () => 0;
  const before = [actor.profile.hp, actor.simulation.x, actor.simulation.y];
  const admitted = actor.skillField.prepareMobHitAdmission(mob, false);
  expect(admitted.admitted).toBe(true);
  expect(admitted.hit.amount).toBe(0);
  expect([actor.profile.hp, actor.simulation.x, actor.simulation.y]).toEqual(
    before,
  );
});

test("large generated damage survives publication while hpDamage is only HP actually removed", async () => {
  const { actor, mob, publications } = await fixture();
  // Isolate calculation/publication from the separate durable reward transaction.
  actor.skillField.onKill = () => {};
  const hp = mob.hp;
  const hit = {
    skillId: 0,
    skillLine: true,
    line: 0,
    critical: true,
    knockbackChance: 0,
    roll: 0,
  };
  actor.skillField.damageTarget(mob, DAMAGE_LIMIT, hit, 1);
  const event = publications.find(
    (message) => message.event?.kind === "combat.impact",
  ).event;
  expect(event.damage).toBe(DAMAGE_LIMIT);
  expect(event.hpDamage).toBe(hp);
  expect(event.critical).toBe(true);
  expect(event.lethal).toBe(true);
  expect(() => validate(event, domainEventSchema)).not.toThrow();
});

test("an admitted attack ignores forged damage and critical reports even without a watchdog", async () => {
  const { world, actor, mob, publications } = await fixture();
  world.damageWatchdog = null;
  world.recordHits(actor, {
    feedbackId: "prediction",
    skillId: 0,
    hits: [{ targetId: mob.id, line: 0, damage: DAMAGE_LIMIT, critical: true }],
  });
  const hp = mob.hp;
  actor.skillField.damageTarget(
    mob,
    1,
    {
      reportId: "prediction",
      skillId: 0,
      skillLine: true,
      line: 0,
      critical: false,
      knockbackChance: 0,
      roll: 0,
    },
    1,
  );
  const event = publications.find(
    (entry) => entry.event?.kind === "combat.impact",
  ).event;
  expect(event.damage).toBe(1);
  expect(event.critical).toBe(false);
  expect(mob.hp).toBe(hp - 1);
  expect(actor.hitReports.size).toBe(0);
});

test("a reserved projectile owns its action identity after the field starts another action", async () => {
  const { actor } = await fixture();
  actor.skillField.feedbackId = "first";
  const shot = actor.skillField.skillCombat.reserveShot(
    {
      skill: { id: 2001004 },
      info: {},
      rank: 1,
      projectile: true,
      spec: { kind: "magic" },
    },
    null,
    { x: 0, y: 0, facing: 1 },
  );
  actor.skillField.feedbackId = "second";
  expect(shot.feedbackId).toBe("first");
});

test("attack rewind covers the measured view window and stays bounded", () => {
  expect(attackRewindTicks({})).toBe(0);
  expect(
    attackRewindTicks({ connection: { data: { roundTripMs: null } } }),
  ).toBe(0);
  // 100 ms round trip: 50 ms one way plus the client's 160 ms playout allowance.
  expect(
    attackRewindTicks({ connection: { data: { roundTripMs: 100 } } }),
  ).toBe(7);
  // 500 ms round trip: 250 ms one way plus the 160 ms playout allowance, bounded.
  expect(
    attackRewindTicks({ connection: { data: { roundTripMs: 500 } } }),
  ).toBe(14);
  // A pathological round trip saturates the bound instead of sweeping unbounded.
  expect(
    attackRewindTicks({ connection: { data: { roundTripMs: 5000 } } }),
  ).toBe(16);
});

test("outgoing selection sweeps a mob body across the compensation window without mutating it", async () => {
  const { actor, mob } = await fixture();
  const runtime = actor.skillField.skillCombat;
  mob.body = { active: true, left: 0, right: 10, top: -10, bottom: 0 };
  mob.sweptBody = { active: true, left: 0, right: 10, top: -10, bottom: 0 };
  mob.delta = { x: 40, y: 0 };
  runtime.rewindTicks = 0;
  expect(runtime.targetBody(mob)).toBe(mob.sweptBody);
  runtime.rewindTicks = 3;
  const swept = runtime.targetBody(mob);
  expect(swept.right).toBe(130);
  expect(swept.left).toBe(0);
  expect(mob.sweptBody.right).toBe(10);
  runtime.rewindTicks = 0;
});
