import { randomUUID } from "node:crypto";
import { protocolError } from "../../shared/protocol.js";
import { DROP_OWNER_MS } from "../../shared/drop-protocol.js";
import {
  DROP_MOTION,
  launchDrop,
  stepDropFlight,
  hoverDrop,
  fadeDisappearingDrop,
} from "../../client/src/world/drop-motion.js";
import {
  DROP_POLICY,
  rollDropRows,
  placeDrop,
} from "../../client/src/world/drop-rules.js";
import { validateDropRow } from "../../client/src/world/drop-system.js";
import { familyRate } from "../../client/src/social/local-social-family.js";
import { refreshPickupConditions } from "./drop-conditions.js";

export const MAX_FIELD_DROPS = DROP_POLICY.capacity;

/** Shared authored floor selection; batch fanout falls back to its first supported floor. */
export function dropGround(field, source, index = 0, first = null) {
  const point = { x: 0, y: 0, foothold: null };
  if (
    !placeDrop(
      point,
      source,
      { footholds: field.geometry.segments, first },
      index,
    )
  ) {
    throw protocolError("REQUIREMENTS_NOT_MET");
  }
  return point;
}

/** Payload construction cannot publish or reserve an entitlement. */
function createDropContents(request) {
  const disappearing = request.disappearing === true;
  return {
    id: request.id ?? randomUUID(),
    item: request.item ?? null,
    mesos: request.mesos ?? 0,
    quantity: request.item?.count ?? request.mesos ?? 0,
    questId: request.questId ?? 0,
    itemId: request.item?.id ?? 0,
    durableEntitlement: request.durableEntitlement === true && !disappearing,
    disappearing,
    playerDrop: request.playerDrop === true,
  };
}

/** Complete motion preparation precedes every durable debit/grant. */
export function prepareFieldDrop(world, actor, request) {
  const source = request.source ?? actor.simulation;
  const point = request.ground ?? dropGround(actor.field, source);
  const createdAt = request.createdAt ?? world.now;
  const drop = createDropContents(request);
  drop.active = true;
  drop.ownerId = request.ownerId ?? actor.id;
  drop.ownerPartyId = actor.profile.social?.party?.id ?? null;
  drop.ownerUntil = createdAt + (drop.playerDrop ? 0 : DROP_OWNER_MS);
  drop.createdAt = createdAt;
  drop.expiresAt =
    createdAt +
    (drop.disappearing
      ? DROP_MOTION.disappearLifetimeMs
      : DROP_POLICY.lifetimeMs);
  drop.reservation = null;
  drop.position = { x: source.x, y: source.y };
  drop.foothold = point.foothold;
  launchDrop(drop, source, point);
  return drop;
}

/** Capacity was reserved and state prepared before commit; no fallible placement remains. */
export function publishFieldDrop(field, drop, now) {
  if (field.drops.has(drop.id)) return field.drops.get(drop.id);
  drop.createdAt = now;
  drop.ownerUntil = now + (drop.playerDrop ? 0 : DROP_OWNER_MS);
  drop.expiresAt =
    now +
    (drop.disappearing
      ? DROP_MOTION.disappearLifetimeMs
      : DROP_POLICY.lifetimeMs);
  field.drops.set(drop.id, drop);
  return drop;
}

/** Existing world port, for callers that already own an admitted debit/grant. */
export function createFieldDrop(world, actor, request) {
  if (request.id && actor.field.drops.has(request.id)) {
    return actor.field.drops.get(request.id);
  }
  if (actor.field.drops.size >= MAX_FIELD_DROPS) {
    throw protocolError("SERVER_BUSY");
  }
  return publishFieldDrop(
    actor.field,
    prepareFieldDrop(world, actor, request),
    world.now,
  );
}

function launchObservation(world, field, drop) {
  const sound =
    !drop.disappearing &&
    world.now - (field.lastDropSoundAt ?? -Infinity) > 300;
  if (sound) field.lastDropSoundAt = world.now;
  world.broadcast(field, {
    type: "event",
    fieldEpoch: field.epoch,
    event: {
      kind: "drop.spawn",
      eventId: drop.id,
      dropId: drop.id,
      actorId: drop.ownerId,
      itemId: drop.itemId,
      quantity: drop.item?.count ?? drop.mesos,
      position: { ...drop.position },
      impactTick: field.tick,
      disappearing: drop.disappearing,
      sound,
    },
  });
}

/** Shared 30ms ordinary flight/hover and native mode-3 discard fade, bounded by field capacity. */
export function advanceDrops(world, field) {
  for (const drop of field.drops.values()) {
    if (drop.reservation) continue;
    if (world.now >= drop.expiresAt) {
      field.drops.delete(drop.id);
      continue;
    }
    drop.age += DROP_MOTION.quantumMs;
    drop.phaseAge += DROP_MOTION.quantumMs;
    if (drop.state === "waiting") {
      drop.state = "launching";
      drop.phaseAge = 0;
      launchObservation(world, field, drop);
    } else if (drop.state === "grounded") hoverDrop(drop);
    else stepDropFlight(drop);
    drop.position.x = drop.x;
    drop.position.y = drop.y;
    if (drop.disappearing && fadeDisappearingDrop(drop)) {
      field.drops.delete(drop.id);
    }
  }
}

function admittedRows(world, mob) {
  const rows = world.content.catalog.drops?.mobs?.[mob.templateId]?.rows;
  if (!rows) return null;
  if (!Array.isArray(rows) || rows.length > DROP_POLICY.maximumRows) {
    throw protocolError("CONTENT_MISMATCH");
  }
  const admitted = [];
  for (const row of rows) {
    if (row.status === "unavailable") continue;
    if (row.status !== "supported") throw protocolError("CONTENT_MISMATCH");
    validateDropRow(row, world.content.items);
    admitted.push(row);
  }
  return admitted;
}

/** Authored windows are epoch-ms: inclusive start, exclusive end. */
function conditionApplies(condition, job, level, now) {
  const window = condition.window;
  if (window && !(now >= window.start && now < window.end)) return false;
  const jobs = condition.jobs;
  if (jobs && !jobs.includes(job)) return false;
  if (condition.minLevel !== undefined && level < condition.minLevel) {
    return false;
  }
  if (condition.maxLevel !== undefined && level > condition.maxLevel) {
    return false;
  }
  return true;
}

/** Failing conditions leave the captured set in place at accepted impact. */
function applyDropConditions(rows, actor, now) {
  if (!rows) return rows;
  const { job, level } = actor.profile;
  let kept = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (row.condition && !conditionApplies(row.condition, job, level, now)) {
      continue;
    }
    rows[kept++] = row;
  }
  rows.length = kept;
  return rows;
}

/** Capture accepted-impact rates before a queued durable reward can outlive its temporary sources. */
export function captureKillDropRates(world, actor, mob) {
  refreshPickupConditions(actor);
  const effects = actor.skills?.effects ?? actor.temporaryStats;
  const cardDropRates = Object.create(null);
  const killDropRows = applyDropConditions(
    admittedRows(world, mob),
    actor,
    world.now,
  );
  for (const row of killDropRows ?? []) {
    cardDropRates[row.itemId] = effects?.cardRate(row.itemId) ?? 1;
  }
  return {
    familyDropRate: familyRate(actor.profile, "drop", world.now),
    mesoUp: effects?.derived.mesoUp ?? 0,
    cardDropRates,
    killDropRows,
  };
}

function rollKillDrops(world, actor, mob, rows) {
  const effects = actor.skills?.effects ?? actor.temporaryStats;
  const context = {
    profile: actor.profile,
    items: world.content.items,
    random: world.random,
    rates: {
      cardRate: (itemId) =>
        mob.cardDropRates
          ? mob.cardDropRates[itemId]
          : (effects?.cardRate(itemId) ?? 1),
      familyRate: () =>
        mob.familyDropRate ?? familyRate(actor.profile, "drop", world.now),
      mesoUp: () => mob.mesoUp ?? effects?.derived.mesoUp ?? 0,
    },
  };
  const output = {
    rolls: new Array(DROP_POLICY.maximumRows),
    quantities: new Uint32Array(DROP_POLICY.maximumRows),
    count: 0,
  };
  const count = rollDropRows(rows, context, output, mob.killDropRate ?? 1);
  return { ...output, count };
}

function createLootItem(id, count) {
  return {
    uid: randomUUID(),
    id,
    count,
    slot: 1,
    owner: "",
    flags: 0,
    expiresAt: null,
  };
}

function prepareKillBatch(world, actor, mob, output) {
  const requests = [];
  const source = { x: mob.x, y: mob.y };
  let first = null;
  for (let index = 0; index < output.count; index++) {
    const row = output.rolls[index];
    const count = output.quantities[index];
    const ground = dropGround(actor.field, source, index, first);
    first ??= ground;
    requests.push(
      prepareFieldDrop(world, actor, {
        item: row.itemId ? createLootItem(row.itemId, count) : null,
        mesos: row.itemId ? 0 : count,
        source,
        ground,
        questId: row.questId,
        durableEntitlement: true,
      }),
    );
  }
  return requests;
}

/** Lethal owner includes grantEntitlements and value.dropPlanId in its one reward transaction. */
export function prepareKillDrops(world, actor, mob) {
  refreshPickupConditions(actor);
  const rows =
    mob.killDropRows === undefined
      ? admittedRows(world, mob)
      : mob.killDropRows;
  const output = rows ? rollKillDrops(world, actor, mob, rows) : null;
  return prepareDropPlan(world, actor, mob, output);
}

/** Shared bounded escrow for admitted monster or reactor rolls, before anything reaches the field. */
export function prepareDropPlan(world, actor, source, output) {
  const field = actor.field;
  const plan = {
    id: randomUUID(),
    field,
    actorId: actor.id,
    requests: [],
    grantEntitlements: [],
    state: "reserved",
    reserved: 0,
    refusal: null,
  };
  if (!output) {
    plan.refusal = "unsupported-mob";
    return plan;
  }
  if (
    output.count < 0 ||
    output.count > MAX_FIELD_DROPS - field.drops.size - field.dropReservations
  ) {
    plan.refusal = "drop-capacity";
    return plan;
  }
  try {
    plan.requests = prepareKillBatch(world, actor, source, output);
  } catch (error) {
    if (error.code !== "REQUIREMENTS_NOT_MET") throw error;
    plan.refusal = "no-drop-ground";
    return plan;
  }
  plan.grantEntitlements = plan.requests.map((drop) => ({
    id: drop.id,
    kind: "drop",
  }));
  plan.reserved = plan.requests.length;
  field.dropReservations += plan.reserved;
  return plan;
}

/** A durable duplicate cannot publish a newly rolled plan; the receipt fences this exact grant. */
export function commitKillDrops(world, actor, plan, receipt) {
  if (
    plan.state !== "reserved" ||
    receipt.status !== "committed" ||
    receipt.value?.dropPlanId !== plan.id
  ) {
    return false;
  }
  if (plan.actorId !== actor.id || plan.field !== actor.field) {
    throw protocolError("STALE_FIELD");
  }
  for (const drop of plan.requests) {
    publishFieldDrop(plan.field, drop, world.now);
  }
  plan.state = "committed";
  if (plan.refusal) {
    world.publish(actor, {
      type: "event",
      fieldEpoch: plan.field.epoch,
      event: { kind: "drop.refused", eventId: plan.id, reason: plan.refusal },
    });
  }
  return true;
}

/** Caller owns finally; releasing twice is harmless and never removes a committed drop. */
export function releaseKillDrops(field, plan) {
  if (!plan || plan.field !== field || plan.state === "released") return;
  field.dropReservations -= plan.reserved;
  plan.reserved = 0;
  plan.state = "released";
}

/** Server-private ownership admission; durable mirrored party records establish shared ownership. */
export function ownsDrop(actor, drop, now) {
  if (drop.ownerUntil <= now || !drop.ownerId || drop.ownerId === actor.id) {
    return true;
  }
  if (drop.ownerMemberIds) return drop.ownerMemberIds.includes(actor.id);
  const party = actor.profile.social?.party;
  if (!party) return false;
  return party.id === drop.ownerPartyId || party.members.includes(drop.ownerId);
}

/** Public reconnect-required drop state; instance UID/flags and entitlements remain private. */
export function dropInfo(drop) {
  return {
    quantity: drop.quantity,
    ownerId: drop.ownerId,
    ownerPartyId: drop.ownerPartyId,
    ownerUntil: drop.ownerUntil,
    expiresAt: drop.expiresAt,
    questId: drop.questId,
    disappearing: drop.disappearing,
    playerDrop: !!drop.playerDrop,
  };
}
