import { PROTOCOL } from "../../shared/protocol.js";

const MAX_EDGES = 1;
const MAX_AGE_TICKS = Math.ceil(2000 / PROTOCOL.TICK_MS);

export function resetAttackInput(actor) {
  actor.attackEdges = [];
  actor.receivedAttack = false;
  actor.combatInputSeq = null;
  actor.attackAdmission = null;
  actor.hitReports?.clear();
}

/** Zero queue — only one pending attack survives at a time, never more.
 *  Movement admission is fully decoupled: a dropped attack never throws.
 *  If authority is already in an action phase, new presses are dropped
 *  entirely — no server-side event fires, avoiding phantom audio on the
 *  client when local prediction intentionally suppressed it. */
export function retainAttackInput(actor, sample) {
  const pressed = sample.attack && !actor.receivedAttack;
  actor.receivedAttack = sample.attack;
  if (!pressed) return false;
  // Authority still running an action — don't queue anything; the client
  // already suppressed local prediction so the server must match that.
  if (actor.skillField?.phase && actor.skillField.phase !== "idle") {
    actor.attackAdmission = "BUSY";
    return false;
  }
  const tick = actor.field.tick;
  if (
    sample.targetTick < tick - MAX_AGE_TICKS ||
    sample.targetTick > tick + PROTOCOL.INPUT_LEAD_TICKS
  ) {
    return false;
  }
  // Expire stale entries first so a legitimate late press can still land.
  expireAttackInput(actor);
  if (actor.attackEdges.length >= MAX_EDGES) {
    actor.attackAdmission = "BUSY";
    return false;
  }
  actor.attackEdges.push({
    inputSeq: sample.inputSeq,
    tick: Math.max(tick + 1, sample.targetTick),
    expires: sample.targetTick + MAX_AGE_TICKS,
  });
  actor.attackAdmission = null;
  return true;
}

function expireAttackInput(actor) {
  while (
    actor.attackEdges[0] &&
    actor.attackEdges[0].expires < actor.field.tick
  ) {
    actor.attackEdges.shift();
  }
}

/** Consume each press once, even when its release arrived in the same network burst. */
export function takeAttackInput(actor, ready = true) {
  actor.combatInputSeq = null;
  for (let count = 0; count < MAX_EDGES; count++) {
    if (
      !actor.attackEdges[0] ||
      actor.attackEdges[0].expires >= actor.field.tick
    ) {
      break;
    }
    actor.attackEdges.shift();
  }
  if (!ready) return false;
  const edge = actor.attackEdges[0];
  if (!edge || edge.tick > actor.field.tick) return false;
  actor.attackEdges.shift();
  if (edge.expires < actor.field.tick) return false;
  actor.combatInputSeq = edge.inputSeq;
  return true;
}
