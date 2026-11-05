import { PROTOCOL } from "../../shared/protocol.js";
import { applyExternalImpulse } from "../../client/src/physics/simulation.js";

const MAX_GRANTS = 8;

/** The validated cast/hit supplies the vector; a movement report can only consume it.
 *  Returns the grant id or null when the grant cannot be recorded (stream not ready,
 *  server-owned motion, or bounded queue is full — in which case the knockback
 *  impulse is silently skipped for this tick rather than crashing the caller). */
export function grantMovementImpulse(actor, divert) {
  const stream = actor.movementStream;
  if (!stream || stream.owned) return null;
  if (stream.grants.length >= MAX_GRANTS) return null;
  const grant = {
    ...divert,
    skillId: divert.skillId ?? 0,
    id: ++stream.impulseSequence,
    expires: actor.field.tick + PROTOCOL.INPUT_HISTORY,
  };
  stream.grants.push(grant);
  stream.restoreImpulse = true;
  return grant.id;
}

function matchesGrant(grant, reference) {
  if (
    grant.source !== reference.source ||
    grant.skillId !== reference.skillId
  ) {
    return false;
  }
  // A locally predicted cast precedes its reply, but only one admitted, unused
  // cast of that skill can authorize the requested impulse. Hits require the id.
  return reference.id === null
    ? reference.source === "skill"
    : reference.id === grant.id;
}

/** A locally queued cast may follow its movement report on the socket. Wait within
 * the same bounded history horizon; it has no world position until admission. */
export function awaitingMovementImpulse(actor, sample) {
  if (actor.field.tick - sample.receivedTick >= PROTOCOL.INPUT_HISTORY) {
    return false;
  }
  for (const reference of sample.impulses) {
    if (reference.source !== "skill" || reference.id !== null) continue;
    if (
      !actor.movementStream.grants.some((grant) =>
        matchesGrant(grant, reference),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Bounded one-use grants; omitted hit reactions expire instead of granting immunity. */
export function applyMovementImpulses(actor, references) {
  const stream = actor.movementStream;
  for (const grant of stream.grants) {
    if (grant.expires < actor.field.tick) return false;
  }
  for (const reference of references) {
    const index = stream.grants.findIndex((grant) =>
      matchesGrant(grant, reference),
    );
    if (index < 0) return false;
    const grant = stream.grants[index];
    applyExternalImpulse(actor.simulation, grant.vx, grant.vy);
    stream.grants.splice(index, 1);
  }
  return true;
}
