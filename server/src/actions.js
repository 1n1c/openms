import {
  executeInteraction,
  currentInteractionRevision,
} from "./interactions.js";
import {
  executeInventory,
  executeDrop,
  executePickup,
} from "./action-inventory.js";
import { executeCharacter } from "./action-character.js";
import { admitActor, operationFor, reject, ruleError } from "./action-rules.js";

import { actionEphemeral } from "../../shared/protocol.js";
import { COMMERCE_ACTION_ROWS } from "../../shared/commerce-protocol.js";
import { NARRATIVE_ACTION_ROWS } from "../../shared/narrative-protocol.js";
import { executeWorldAction } from "./field-world-actions.js";
import { offerReactor } from "./field-reactors.js";
import { releaseSkill } from "./field-skills.js";
import {
  awaitActionSlot,
  retainCastIntent,
  queueCastControl,
  finishCastIntent,
} from "./action-queue.js";

const DOMAIN_INTERACTIONS = new Set([
  "npc.open",
  "quest.accept",
  "quest.claim",
  "quest.abandon",
  "trade.invite",
  ...[...COMMERCE_ACTION_ROWS, ...NARRATIVE_ACTION_ROWS].map(([kind]) => kind),
]);
const MAX_EPHEMERAL_RECEIPTS = 4096;
const MAX_QUEUED_COMMANDS = 32;

/** Class-1 outcomes belong to one play session, including its reconnect grace. */
function ephemeralReceipts(actor) {
  if (!actor.operationReceipts || actor.receiptSession !== actor.playSession) {
    actor.operationReceipts = new Map();
    actor.receiptSession = actor.playSession;
  }
  return actor.operationReceipts;
}

function cachedReceipt(receipts, operation) {
  const entry = receipts.get(operation.operationId);
  if (!entry) return null;
  if (entry.digest === operation.digest) return entry.receipt;
  return {
    status: "rejected",
    code: "OPERATION_CONFLICT",
    domainRevision: entry.receipt.domainRevision,
    transactionId: null,
  };
}

function dispatchCharacter(actor, message, world, operation) {
  switch (message.action.kind) {
    case "portal.enter":
      return world.transition(
        actor,
        { portalId: message.action.portalId },
        operation,
      );
    case "content.enter":
      return enterCommunityMap(actor, message, world, operation);
    case "revive.request":
      return world.transition(
        actor,
        { revive: message.action.method },
        operation,
      );
    case "skill.cast":
      return world.cast(actor, message.action, operation);
    case "skill.door":
      return world.useSkillDoor(actor, operation);
    case "expression.use":
    case "expression.cash":
    case "seat.toggle":
      return executeWorldAction(actor, message, world);
    case "reactor.offer":
      return offerReactor(actor, message, world);
    default:
      return dispatchCharacterMutation(actor, message, world, operation);
  }
}

function enterCommunityMap(actor, message, world, operation) {
  const mapId = message.action.mapId;
  if (!world.content.catalog.communityMaps?.some((map) => map.id === mapId)) {
    reject("NOT_FOUND", "This community map is not active");
  }
  if (
    actor.profile.hp <= 0 ||
    actor.tradeId ||
    actor.conversation ||
    actor.attackState?.active ||
    actor.simulation.movementLocked
  ) {
    reject(
      "NOT_ALLOWED",
      "Finish the current activity before entering a community map",
    );
  }
  return world.transition(actor, { mapId, x: 0, y: 0, facing: 1 }, operation);
}

function dispatchCharacterMutation(actor, message, world, operation) {
  switch (message.action.kind) {
    case "buff.cancel":
    case "stats.allocate":
    case "skills.allocate":
    case "settings.save":
    case "key-bindings.save":
    case "skill-macros.save":
    case "quest.track":
    case "quest.notice":
      return executeCharacter(actor, message, world, operation);
    default:
      reject("INVALID_MESSAGE", "The action has no character handler.");
  }
}

function dispatchInventory(actor, message, world, operation) {
  switch (message.action.kind) {
    case "drop.pickup":
      return executePickup(actor, message, world, operation);
    case "item.drop":
    case "mesos.drop":
      return executeDrop(actor, message, world, operation);
    case "shop.buy":
    case "shop.sell":
    case "shop.recharge":
      return executeInteraction(actor, message, world);
    default:
      return dispatchInventoryMutation(actor, message, world, operation);
  }
}

function dispatchInventoryMutation(actor, message, world, operation) {
  switch (message.action.kind) {
    case "inventory.move":
    case "inventory.gather":
    case "equipment.equip":
    case "equipment.unequip":
    case "item.use":
    case "equipment.scroll":
      return executeInventory(actor, message, world, operation);
    default:
      reject("INVALID_MESSAGE", "The action has no inventory handler.");
  }
}

/** Actions the server rejects while the player is in alert (post-attack/hit
 *  combat posture). Mirror native MapleStory where the ~5s recovery stance
 *  freezes inventory/character-mutation affordances so the player cannot
 *  discard gear, trade items, reassign stats or unequip mid-fight. */
const ALERT_BLOCKED_ACTIONS = new Set([
  "equipment.equip",
  "equipment.unequip",
  "equipment.scroll",
  "item.drop",
  "mesos.drop",
  "stats.allocate",
  "skills.allocate",
  "seat.toggle",
  "expression.use",
  "expression.cash",
]);
const ALERT_BLOCKED_DOMAINS = new Set(["trade"]);

function blockedByAlert(actor, actionKind, domain) {
  const field = actor.skillField;
  if (!field || field.alertTimerMs <= 0) return false;
  if (ALERT_BLOCKED_ACTIONS.has(actionKind)) return true;
  if (ALERT_BLOCKED_DOMAINS.has(domain)) return true;
  return false;
}

function dispatch(actor, message, world, operation) {
  // Alert posture blocks inventory/character mutations — see ALERT_BLOCKED_ACTIONS.
  if (blockedByAlert(actor, message.action.kind, operation.domain)) {
    reject(
      "NOT_ALLOWED",
      "Cannot change equipment, discard items, trade, reassign stats, emote or sit while recovering from combat.",
    );
  }
  if (DOMAIN_INTERACTIONS.has(message.action.kind)) {
    return executeInteraction(actor, message, world);
  }
  switch (operation.domain) {
    case "character":
      return dispatchCharacter(actor, message, world, operation);
    case "inventory":
      return dispatchInventory(actor, message, world, operation);
    case "conversation":
    case "trade":
    case "invitation":
    case "social":
      return executeInteraction(actor, message, world);
    default:
      reject("INVALID_MESSAGE", "The action has no protocol handler.");
  }
}

/** Receipt lookups must finish before reserving the actor or checking session capacity. */
function admitOperationSlot(actor, world, entry) {
  if (actor.retiring || actor.deliveryError || world.participants.busy(actor)) {
    reject("SERVER_BUSY", "Another character operation is in flight.");
  }
  if (entry.ephemeral && entry.receipts.size >= MAX_EPHEMERAL_RECEIPTS) {
    reject("SERVER_BUSY", "The play-session receipt capacity is exhausted.");
  }
  actor.pending = true;
  actor.pendingOperation = entry.operation.operationId;
  actor.pendingOwner = actor.id;
}

function physicalSkillControl(action) {
  return action.kind === "skill.release" || action.kind === "skill.cancel";
}

function admitSkillControl(actor, message, world, entry) {
  admitActor(actor, world, message.fieldEpoch);
  if (entry.receipts.size >= MAX_EPHEMERAL_RECEIPTS) {
    releaseSkill(world, actor, { ...message.action, kind: "skill.cancel" });
    reject("SERVER_BUSY", "The play-session receipt capacity is exhausted.");
  }
  const result = queueCastControl(actor, message.action)
    ? { code: "OK" }
    : releaseSkill(world, actor, message.action);
  const receipt = {
    status: "committed",
    code: result.code,
    domainRevision: actor.revision,
    transactionId: null,
  };
  entry.receipts.set(entry.operation.operationId, {
    digest: entry.operation.digest,
    receipt,
  });
  return { receipt, replayed: false };
}

async function prepareAction(actor, message, world, queuedAt) {
  const operation = operationFor(message);
  if (["conversation", "trade", "invitation"].includes(operation.domain)) {
    operation.domainRevision = currentInteractionRevision(
      actor,
      message.action,
      world,
    );
  }
  const receipts = ephemeralReceipts(actor);
  const cached = cachedReceipt(receipts, operation);
  if (cached) return { receipt: cached, replayed: true };
  const previous = physicalSkillControl(message.action)
    ? null
    : await world.database.receipt(actor, operation);
  if (previous) return { receipt: previous, replayed: true };
  // Routine persistence is not a reason to reject an NPC button. Wait before
  // rechecking the connection and reserving the actor; never replay a paid turn.
  if (message.action.kind.startsWith("npc.") && actor.checkpointTask) {
    await actor.checkpointTask;
  }
  if (
    !actor.connection ||
    actor.connection.data.closed ||
    actor.connection.data.epoch !== message.connectionEpoch
  ) {
    reject(
      "STALE_CONNECTION",
      "The original command connection is no longer current.",
    );
  }
  if (!actor.connection.data.ready) {
    reject("NOT_ALLOWED", "The field is not ready.");
  }
  const entry = {
    operation,
    receipts,
    ephemeral: actionEphemeral(message.action),
  };
  if (physicalSkillControl(message.action)) {
    return admitSkillControl(actor, message, world, entry);
  }
  await awaitActionSlot(world, actor, message, queuedAt);
  admitOperationSlot(actor, world, entry);
  return entry;
}

/** Preserve wire edge order, but release the admission queue before any durable debit waits. */
function queueAdmission(actor, work, control) {
  if (control) return work();
  actor.queuedCommands ??= 0;
  if (actor.queuedCommands >= MAX_QUEUED_COMMANDS) {
    reject("SERVER_BUSY", "The action queue is full.");
  }
  actor.queuedCommands++;
  actor.commandAdmission ??= Promise.resolve();
  const admission = actor.commandAdmission.then(work, work).finally(() => {
    actor.queuedCommands--;
  });
  actor.commandAdmission = admission.then(
    () => {},
    () => {},
  );
  return admission;
}

/** One authority entry: durable duplicate lookup precedes all transient domain admission. */
export async function executeAction(actor, message, world) {
  const intent = retainCastIntent(actor, message);
  let receipt;
  try {
    receipt = await executeQueuedAction(actor, message, world);
    return receipt;
  } finally {
    finishCastIntent(actor, message.operationId, intent, receipt);
  }
}

/** Revision before any wait; null when the client did not observe the current state. */
function commandArrival(actor, message, world) {
  const revision = currentInteractionRevision(actor, message.action, world);
  if (message.expectedRevision !== revision) return null;
  return { revision, produced: actor.producedCommits ?? 0 };
}

/** Server-produced commits (incoming hits, kill rewards) can land while a command waits
 * for its slot after arrival. The client could not have observed them, so rebase over
 * exactly those increments; any other intervening commit still refuses it as stale.
 * Runs with the actor reserved, so no further commit can interleave before admission. */
function rebaseProducedCommits(actor, operation, arrival) {
  if (!arrival || !["character", "inventory"].includes(operation.domain)) {
    return;
  }
  const current =
    operation.domain === "inventory" ? actor.inventoryRevision : actor.revision;
  const produced = (actor.producedCommits ?? 0) - arrival.produced;
  if (current - arrival.revision === produced) {
    operation.expectedRevision = current;
  }
}

async function executeQueuedAction(actor, message, world) {
  const queuedAt = performance.now();
  const arrival = commandArrival(actor, message, world);
  const entry = await queueAdmission(
    actor,
    () => prepareAction(actor, message, world, queuedAt),
    physicalSkillControl(message.action),
  );
  if (entry.receipt) {
    return world.participants.reconcile(actor, entry.receipt, entry.replayed);
  }
  const { operation, receipts, ephemeral } = entry;
  rebaseProducedCommits(actor, operation, arrival);
  // Domain checks record their specific refusal on actor.admission; scope it to this action for the log below.
  actor.admission = undefined;
  try {
    admitActor(actor, world, message.fieldEpoch);
    const receipt = await dispatch(actor, message, world, operation);
    if (ephemeral && receipt.transactionId === null) {
      receipts.set(operation.operationId, {
        digest: operation.digest,
        receipt,
      });
    }
    return await world.participants.reconcile(actor, receipt);
  } catch (error) {
    const failure = ruleError(error);
    world.log?.("action.refused", {
      action: message.action.kind,
      operation: message.operationId,
      character: actor.id,
      code: error.errno ?? error.code ?? error.name,
      reason: failure.code,
      admission:
        actor.admission === undefined ? undefined : String(actor.admission),
      skillId: message.action.skillId,
    });
    // Rejections are receipts too; no mutated draft is ever installed on this path.
    const receipt = await world.database.commit(actor, operation, () => ({
      code: failure.code,
    }));
    return await world.participants.reconcile(actor, receipt);
  } finally {
    actor.pending = false;
    actor.pendingOperation = null;
    actor.pendingOwner = null;
    world.participants.signalIdle();
  }
}
