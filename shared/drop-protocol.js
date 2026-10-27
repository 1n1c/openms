import {
  array,
  boolean,
  enumeration,
  id,
  nullable,
  number,
  optional,
  point,
  record,
  revision,
  u32,
} from "./schema.js";

const quantity = number(0, 2147483647);
const cardFields = {
  ok: enumeration(true),
  cardItemId: number(2380000, 2389999),
  previous: number(0, 5),
  count: number(1, 5),
  added: boolean,
  full: boolean,
  consumed: enumeration(true),
};
export const dropCardSchema = record(
  cardFields,
  (value) =>
    value.count === Math.min(5, value.previous + 1) &&
    value.added === value.count > value.previous &&
    value.full === !value.added,
);
const effectFields = {
  itemId: u32,
  hp: number(0, 30000),
  mp: number(0, 30000),
  effectId: nullable(id),
  duration: number(0, 2147483647),
};
export const dropEffectSchema = record(effectFields);
const identity = { eventId: id, actorId: id, dropId: id };

/** Replaces the corresponding core rows, never a second inventory action dispatcher. */
export const DROP_ACTION_ROWS = [
  [
    "item.drop",
    "inventory",
    {
      itemId: id,
      quantity: number(1, 2147483647),
      confirmedDiscard: optional(boolean),
    },
  ],
  ["mesos.drop", "inventory", { amount: number(1, 2147483647) }],
  ["drop.pickup", "inventory", { dropId: id }],
];
export const DROP_EPHEMERAL_ACTIONS = [];
export const DROP_RESULT_SCHEMAS = {
  "equipment.enhancement": record({
    kind: enumeration("equipment.enhancement"),
    outcome: enumeration("success", "failure", "curse"),
  }),
  "drop.dispatched": record({
    kind: enumeration("drop.dispatched"),
    dropId: id,
    itemId: u32,
    quantity,
    disappearing: boolean,
  }),
  "drop.collected": record({
    kind: enumeration("drop.collected"),
    pickupId: id,
    dropId: id,
    itemId: u32,
    quantity,
    card: nullable(dropCardSchema),
    effect: nullable(dropEffectSchema),
  }),
};
export const DROP_EVENT_SCHEMAS = {
  "equipment.enhancement": record({
    kind: enumeration("equipment.enhancement"),
    eventId: id,
    actorId: id,
    outcome: enumeration("success", "failure", "curse"),
  }),
  "drop.pickup": record({
    kind: enumeration("drop.pickup"),
    ...identity,
    position: point,
    impactTick: revision,
  }),
  "drop.spawn": record({
    kind: enumeration("drop.spawn"),
    ...identity,
    itemId: u32,
    quantity,
    position: point,
    impactTick: revision,
    disappearing: boolean,
    sound: boolean,
  }),
  "drop.gain": record({
    kind: enumeration("drop.gain"),
    ...identity,
    itemId: u32,
    quantity,
  }),
  "drop.card": record({
    kind: enumeration("drop.card"),
    ...identity,
    ...cardFields,
  }),
  "drop.effect": record({
    kind: enumeration("drop.effect"),
    ...identity,
    ...effectFields,
  }),
  "drop.refused": record({
    kind: enumeration("drop.refused"),
    eventId: id,
    reason: enumeration("unsupported-mob", "drop-capacity", "no-drop-ground"),
  }),
  "drop.explode": record({
    kind: enumeration("drop.explode"),
    eventId: id,
    actorId: id,
    dropIds: array(id, 32, 1, true),
    impactTick: revision,
  }),
};

/** Current state only: no item instance, entitlement key, or RNG crosses the wire. */
export const dropInfoSchema = record({
  quantity,
  ownerId: nullable(id),
  ownerPartyId: nullable(id),
  ownerUntil: revision,
  expiresAt: revision,
  questId: u32,
  disappearing: boolean,
  playerDrop: boolean,
});
export const DROP_ENTITY_FIELDS = { dropInfo: optional(dropInfoSchema) };

/** Kill-claim window (ms): only the attacker (or their party) may see and
 *  pick up drops for this duration; after that, all players on the field can.
 *  Mirrored by both server (admission gate in field-drops.js) and client
 *  (visibility guard in scene-drops.js) so the two never disagree. */
export const DROP_OWNER_MS = 120000;
