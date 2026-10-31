import { randomUUID, randomFillSync } from "node:crypto";
import { createMobs, stepMob } from "../../client/src/combat/offline-mobs.js";
import { mobFlipped } from "../../client/src/combat/mob-movement-metadata.js";
import {
  createCharacterStats,
  projectCharacterStats,
} from "../../client/src/character/character-stats.js";
import {
  createHitboxState,
  updateHitboxes,
} from "../../client/src/physics/hitboxes.js";
import { placeBody } from "../../client/src/world/life-geometry-numeric.js";
import { MOB_STATUS } from "../../client/src/combat/mob-skill-status.js";
import { advanceActorSkills, flushPickpocket } from "./field-skills.js";
import { protocolError } from "../../shared/schema.js";
import { PROTOCOL } from "../../shared/protocol.js";

/** The browser draws remote actors behind the server's present tick, so an outgoing attack
 *  is judged against the union of that window (the native target selection already adds its
 *  own one-tick sweep). Derived from the connection's measured round trip; an unmeasured
 *  connection gets the native single-tick sweep only. Favour-the-attacker, bounded. */
const CLIENT_PLAYOUT_MS = 160;
const MAX_REWIND_TICKS = 16;

export function attackRewindTicks(actor) {
  const roundTripMs = actor.connection?.data?.roundTripMs;
  if (!Number.isFinite(roundTripMs) || roundTripMs <= 0) return 0;
  const windowMs = roundTripMs / 2 + CLIENT_PLAYOUT_MS;
  return Math.min(
    MAX_REWIND_TICKS,
    Math.max(0, Math.ceil(windowMs / PROTOCOL.TICK_MS)),
  );
}

/** Private cryptographic stream; never seeded or selected by clients. */
export function serverRandom() {
  const words = new Uint32Array(1024);
  let cursor = words.length;
  return function next() {
    if (cursor === words.length) {
      randomFillSync(words);
      cursor = 0;
    }
    return words[cursor++];
  };
}

export function createFieldMobs(manifest, simulation) {
  const mobs = createMobs(manifest.life, simulation);
  for (const mob of mobs) {
    mob.placementId = mob.id;
    mob.id = randomUUID();
    mob.targetId = null;
    mob.damageOwnerId = null;
    mob.actionStartTick = 0;
    mob.rewardGeneration = -1;
    mob.incomingDeliveries = 0;
    mob.statusOwners = [];
  }
  return mobs;
}

export function prepareActorCombat(world, actor) {
  actor.stats = createCharacterStats();
  actor.hitboxes = createHitboxState();
  actor.hitboxContext = {};
  actor.growth = { hp: 0, mp: 0 };
  actor.attackState = {
    active: false,
    action: "stand1",
    skillId: null,
    rank: null,
  };
  actor.incoming = { standardPDD: actor.field.manifest.combat?.standardPDD };
  actor.statHooks = {
    items: world.content.items,
    skillLevel: (id) =>
      actor.skills?.level(id) ??
      ((actor.profile.skills[id]?.expiresAt ?? Infinity) > world.now
        ? (actor.profile.skills[id]?.level ?? 0)
        : 0),
    skillInfo: (id, rank) => world.content.catalog.ui.skills[id]?.levels[rank],
    derivedStats: () => actor.temporaryStats?.derived ?? null,
  };
  refreshActorCombat(world, actor);
}

export function refreshActorCombat(world, actor) {
  let weaponId = 0;
  for (const item of actor.profile.equipment) {
    if (item.slot === -11) weaponId = item.id;
  }
  actor.combat =
    world.content.catalog.ui.avatar?.entries[weaponId]?.combat ?? null;
  projectCharacterStats(actor.profile, actor.statHooks, actor.stats);
  if (actor.skillField && actor.skillField.combat !== actor.combat) {
    actor.skillField.replaceCombat(actor.combat);
  }
}

/** Native input edges are consumed by AuthorityCombat.stepActor, never repeated from held packets. */
export function beginAttack(world, actor) {
  if (
    !actor.skillField ||
    actor.state !== "active" ||
    actor.retiring ||
    actor.deliveryError ||
    actor.profile.hp <= 0 ||
    actor.tradeId ||
    actor.conversation
  ) {
    throw protocolError("NOT_ALLOWED");
  }
  actor.skillField.lagToleranceTicks = attackRewindTicks(actor);
  try {
    actor.skillField.beginAttack();
  } finally {
    actor.skillField.lagToleranceTicks = 0;
  }
  return { code: "OK" };
}

function isEligibleTarget(actor) {
  return (
    actor.profile.hp > 0 &&
    actor.skillField &&
    actor.state === "active" &&
    !actor.retiring &&
    !actor.deliveryError
  );
}

function nearestTarget(field, mob) {
  let target = null,
    distance = Infinity;
  for (const actor of field.characters.values()) {
    if (!isEligibleTarget(actor)) continue;
    const dx = actor.simulation.x - mob.x,
      dy = actor.simulation.y - mob.y;
    const squared = dx * dx + dy * dy;
    if (squared < distance) {
      target = actor;
      distance = squared;
    }
  }
  return target;
}

/** Prefer the actor who is actually hurting this mob, so aggro and kill credit
 *  stay in lockstep. When the mob has aggro and a damage record exists, chase the
 *  highest-contributor actor (falling back to damageOwnerId if damageCredit is empty).
 *  Otherwise — first encounter, aggro expired with no records, or the preferred actor
 *  became ineligible — fall back to nearest target. BOSS mobs already skip
 *  admitMobAggro so aggro.damageInstances stays 0 and they fall straight through
 *  to nearestTarget, preserving the "surround the boss" fairness. */
function selectMobTarget(field, mob) {
  if (mob.aggro?.damageInstances > 0) {
    let preferred = null;
    if (mob.damageCredit?.size > 0) {
      preferred = [...mob.damageCredit.values()].sort(
        (a, b) => b.damage - a.damage,
      )[0]?.actor;
    }
    if (!preferred && mob.damageOwnerId) {
      preferred = field.characters.get(mob.damageOwnerId);
    }
    if (preferred && isEligibleTarget(preferred)) {
      return preferred;
    }
  }
  return nearestTarget(field, mob);
}

function scheduledMobImpact(field, mob, amount, hit) {
  let ownerId = mob.damageOwnerId;
  for (const entry of mob.statusOwners ?? []) {
    if (entry?.skillId === hit.skillId && entry.generation === mob.deaths) {
      ownerId = entry.actorId;
      break;
    }
  }
  mob.scheduledDamageOwnerId = ownerId;
  const owner = field.characters.get(ownerId);
  if (
    owner?.skillField &&
    ((owner.state === "active" && !owner.retiring && !owner.deliveryError) ||
      owner.settling)
  ) {
    owner.skillField.hooks.onSkillDamageLine(mob, amount, hit);
  }
}

function actorAdvances(actor) {
  return (
    actor.skillField &&
    actor.state === "active" &&
    !actor.retiring &&
    !actor.deliveryError &&
    !actor.skillPreparing
  );
}

function scheduledOwnerActive(owner) {
  return (
    owner?.skillField &&
    ((owner.state === "active" && !owner.retiring && !owner.deliveryError) ||
      owner.settling)
  );
}

/** The field advances shared mobs once; per-character controllers never create another mob list. */
export function advanceCombat(world, field) {
  for (const mob of field.mobs) advanceSharedMob(field, mob);
  for (const actor of field.characters.values()) {
    advanceCombatActor(world, actor);
  }
  for (const mob of field.mobs) advanceMobAttack(world, field, mob);
  for (const actor of field.characters.values()) {
    if (actorAdvances(actor)) actor.skillField.finishActor(30);
  }
}

function advanceSharedMob(field, mob) {
  const target = selectMobTarget(field, mob);
  mob.targetId = target?.id ?? null;
  const prior = mob.action;
  const alive = mob.alive;
  const showdown =
    mob.skillStatus.remaining[MOB_STATUS.showdown] > 0
      ? mob.skillStatus.values[MOB_STATUS.showdown]
      : 0;
  mob.scheduledDamageOwnerId = mob.damageOwnerId;
  mob.scheduledDamage ??= (targetMob, amount, hit) =>
    scheduledMobImpact(field, targetMob, amount, hit);
  stepMob(
    mob,
    30,
    target?.skillField.targetFor(mob) ?? null,
    mob.scheduledDamage,
  );
  settleSharedMobLife(field, mob, alive, showdown);
  if (prior !== mob.action) mob.actionStartTick = field.tick;
}

function settleSharedMobLife(field, mob, wasAlive, showdown) {
  const owner = field.characters.get(mob.scheduledDamageOwnerId);
  if (wasAlive && !mob.alive && scheduledOwnerActive(owner)) {
    owner.skillField.onKill(mob, showdown);
  }
  if (!wasAlive && mob.alive) {
    mob.damageOwnerId = null;
    mob.controllerOwnerId = null;
    if (mob.statusOwners) mob.statusOwners.length = 0;
  }
}

function advanceCombatActor(world, actor) {
  if (!actorAdvances(actor)) return;
  updateHitboxes(actor.hitboxes, actor.simulation, actor.hitboxContext);
  advanceActorSkills(world, actor);
  // Outgoing target selection during this actor's step is judged against the window the
  // actor's own client was rendering. Sequential per-actor stepping keeps this unambiguous.
  actor.skillField.lagToleranceTicks = attackRewindTicks(actor);
  try {
    actor.skillField.stepActor(30, actor.input);
  } finally {
    actor.skillField.lagToleranceTicks = 0;
  }
  if (
    actor.skillDrops.pickpocketPlan &&
    !actor.skillTask &&
    !actor.pending &&
    !actor.skillField.hasPendingIncoming &&
    !actor.skillField.rewardJobs.size
  ) {
    actor.skillTask = flushPickpocket(world, actor)
      .catch((error) => {
        actor.admission = error.code ?? error.message;
      })
      .finally(() => {
        actor.skillTask = null;
      });
  }
}

export function advanceMobAttack(world, field, mob) {
  if (mob.incomingDeliveries) return;
  const selected = selectMobTarget(field, mob);
  if (!selected || !selected.skillField.mobAttackAllowed(mob)) return;
  if (mob.state !== "attack") {
    beginSharedMobAttack(world, field, mob);
    return;
  }
  releaseSharedMobAttack(world, field, mob);
}

function beginSharedMobAttack(world, field, mob) {
  const previous = mob.action;
  for (const actor of field.characters.values()) {
    if (
      !actorAdvances(actor) ||
      actor.pending ||
      actor.skillTask ||
      actor.skillField.hasPendingIncoming ||
      actor.profile.hp <= 0
    ) {
      continue;
    }
    actor.skillField.stepMobAttack(mob);
    if (mob.state === "attack") break;
  }
  if (mob.action !== previous) mob.actionStartTick = field.tick;
}

function authoredRecipient(actor, mob) {
  if (!actorAdvances(actor) || actor.skillField.dead) return false;
  if (
    mob.skillStatus.remaining[MOB_STATUS.inert] > 0 &&
    mob.controllerOwnerId !== actor.skillField.actor.id
  ) {
    return false;
  }
  return true;
}

function releaseSharedMobAttack(world, field, mob) {
  const attack = mob.pendingAttack;
  if (
    !attack ||
    mob.attackFired ||
    mob.stateMs < attack.properties.attackAfter
  ) {
    return;
  }
  placeBody(mob.attackBody, attack.rectangle, mob, mobFlipped(mob));
  const recipients = [];
  for (const actor of field.characters.values()) {
    const runtime = actor.skillField;
    if (!authoredRecipient(actor, mob)) continue;
    if (runtime.targetOverlap(mob.attackBody, runtime.targetFor(mob))) {
      recipients.push(runtime);
    }
  }
  // The preceding generation cannot author another area until every recipient settles.
  // Each actor can therefore retain at most one area per field mob, plus its local hit.
  for (const runtime of recipients) {
    if (runtime.incoming.length >= field.mobs.length + 1) {
      throw protocolError("SERVER_BUSY");
    }
  }
  mob.attackFired = true;
  if (!recipients.length) return;
  const source = recipients[0].captureIncomingSource(mob);
  mob.incomingDeliveries = recipients.length;

  // Phase 4 (RNG sync, route A): pre-compute incoming damage for every recipient
  // synchronously here and broadcast the preview to all clients. Each client can
  // then render the incoming damage number using the server's authoritative RNG
  // roll instead of its own divergent local roll, eliminating "client saw crit
  // but server rolled non-crit" discrepancies.
  //
  // The pre-computed outcome is reused as acceptIncoming's `prepared` slot so
  // prepareIncoming returns it directly — ONE roll = one truth, no mismatch.
  const magic = attack.properties.magic === 1;
  const outcomes = recipients.map((runtime) =>
    runtime.prepareMobHit(
      runtime.captureIncomingSource(mob),
      magic,
      attack.action,
      runtime.actor.profile,
    ),
  );
  world.broadcast(field, {
    type: "event",
    fieldEpoch: field.epoch,
    event: {
      kind: "combat.incoming-preview",
      mobId: mob.id,
      attackAction: attack.action,
      previews: outcomes.map((o, i) => ({
        targetId: recipients[i].actor.id,
        damage: o.hit?.amount ?? 0,
        critical: o.hit?.critical ?? false,
        admitted: !!o.admitted,
      })),
    },
  });

  for (let i = 0; i < recipients.length; i++) {
    const runtime = recipients[i];
    runtime.acceptIncoming(
      source,
      magic,
      attack.action,
      () => {
        mob.incomingDeliveries--;
      },
      outcomes[i].admitted ? outcomes[i] : null,
    );
  }
}

export async function prepareActorPoses(world, actor) {
  const skin =
    world.content.catalog.ui.avatar.skins[actor.profile.appearance.skin];
  const entry = world.content.catalog.ui.avatar.entries[skin?.body];
  if (!entry) throw protocolError("CONTENT_MISMATCH");
  const bundle = await world.content.json(entry.descriptor);
  const poses = bundle.metadata?.avatar?.poses;
  if (!poses || Object.keys(poses).length > 512) {
    throw protocolError("CONTENT_MISMATCH");
  }
  actor.actionPoses = poses;
}

export function actorCombatFields(actor) {
  // Logout destroys skills before the asynchronous checkpoint/release removes
  // the actor from its field. Peers can still observe its avatar during that gap.
  if (!actor.skillField || !actor.skills) return {};
  const diseases = [];
  for (let id = 0; id < 256; id++) {
    const remainingMs = actor.skillField.diseases.remaining[id];
    if (remainingMs > 0) diseases.push({ id, remainingMs });
  }
  const skillVoices = [];
  for (const voice of actor.skills.resources.voices) {
    skillVoices.push({
      voiceId: voice.id,
      skillId: voice.skillId,
      leaf: voice.leaf,
    });
  }
  const door = actor.skills.worldController.door;
  const endpoint = door.endpoint();
  return {
    combatState: actor.combatPresentation,
    skillVisuals: actor.skills.resources.views(),
    skillVoices,
    diseases,
    skillDoor: endpoint
      ? {
          position: { x: endpoint.x, y: endpoint.y },
          remainingMs: door.remainingMs,
          ready: door.elapsedMs >= 3000,
        }
      : null,
  };
}

export function mobCombatFields(mob) {
  const statuses = [];
  for (const [name, index] of Object.entries(MOB_STATUS)) {
    const remainingMs = mob.skillStatus.remaining[index];
    if (remainingMs > 0) statuses.push({ name, remainingMs });
  }
  return {
    mobState: {
      hp: mob.hp,
      maxHP: mob.maxHP,
      opacity: mob.opacity,
      level: mob.template.info.level ?? 1,
      nameRemainingMs: mob.nameRemainingMs,
      nameVisible: Boolean(
        mob.visible &&
        mob.nameRemainingMs > 0 &&
        !mob.template.info.hideName &&
        !mob.template.info.HPgaugeHide &&
        !mob.template.info.damagedByMob &&
        mob.template.name,
      ),
      bodyVisible: Boolean(
        mob.visible &&
        !(
          mob.controllerState?.body &&
          mob.skillStatus.remaining[MOB_STATUS.doom] > 0
        ),
      ),
      generation: mob.deaths,
      movementType: mob.movementType,
      phase: mob.state,
      elapsedMs: mob.actionMs,
      statuses,
    },
    velocity: {
      x: (mob.x - mob.previousX) / 0.03,
      y: (mob.y - mob.previousY) / 0.03,
    },
  };
}
