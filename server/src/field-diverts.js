import { synchronizeMovementStream } from "./movement-stream.js";
import { grantMovementImpulse } from "./movement-impulses.js";

/** At most this many external impulses are described in one motion checkpoint.
 *  A tick can carry a mob hit and a movement skill; more than that is a fault. */
const MAX_DIVERTS_PER_TICK = 2;
/** A pending divert is dropped when it was not published within this many ticks:
 *  the actor left the active set or the field changed under it. */
const MAX_DIVERT_AGE_TICKS = 1;

/** Record one authoritative external impulse so the client can merge the same vector
 *  into its own kernel at receipt. The browser owns the trajectory, so only the event
 *  (vector, source and skill id) crosses the wire — never a pre-impulse checkpoint.
 *  `simulation` must be the actor's own field simulation. */
export function recordMotionDivert(actor, simulation, divert) {
  const pending = actor.motionDiverts;
  if (!pending || !actor.field || simulation !== actor.simulation) return;
  if (!Number.isFinite(divert.vx) || !Number.isFinite(divert.vy)) return;
  if (pending.entries.length >= MAX_DIVERTS_PER_TICK) return;
  synchronizeMovementStream(actor);
  const id = grantMovementImpulse(actor, divert);
  if (id === null) return;
  pending.entries.push({
    id,
    vx: divert.vx,
    vy: divert.vy,
    source: divert.source,
    skillId: Number.isSafeInteger(divert.skillId) ? divert.skillId : 0,
    tick: actor.field.tick,
    ...(divert.sourceId ? { sourceId: divert.sourceId } : {}),
  });
}

/** Allocate the buffer once per field entry, never per tick. */
export function prepareMotionDiverts(actor, field) {
  actor.motionDiverts = { field, entries: [] };
}

/** Stamp the diverts this tick's published checkpoint first reflects. An impulse is only
 *  ever merged after its own tick's kernel step (combat and skills run after `moveActor`)
 *  or between ticks, so it is always integrated by the step of `entry.tick + 1`; an entry
 *  recorded during the tick that has not stepped past it yet is retained for the next
 *  publication rather than mislabelled. Entries the client can no longer place are dropped. */
export function takeMotionDiverts(actor, field) {
  const pending = actor.motionDiverts;
  if (!pending || pending.field !== field) return [];
  const published = [];
  let keep = 0;
  for (const entry of pending.entries) {
    if (field.tick - entry.tick > MAX_DIVERT_AGE_TICKS) continue;
    if (field.tick < entry.tick + 1) {
      pending.entries[keep++] = entry;
      continue;
    }
    published.push({
      id: entry.id,
      tick: entry.tick + 1,
      vx: entry.vx,
      vy: entry.vy,
      source: entry.source,
      skillId: entry.skillId,
      ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
    });
  }
  pending.entries.length = keep;
  return published;
}

/** Drop any unpublishable divert when the actor leaves its field. */
export function releaseMotionDiverts(actor) {
  actor.motionDiverts = null;
}
