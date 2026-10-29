import { PROTOCOL } from "../../shared/protocol.js";
import {
  assignHeldInput,
  captureMotion,
  stepMotion,
} from "../../shared/motion.js";
import { applyExternalImpulse } from "../../client/src/physics/simulation.js";

const NEUTRAL = Object.freeze({
  horizontal: 0,
  vertical: 0,
  jump: false,
  attack: false,
});

/** Reconnecting cannot erase unreported elapsed time to freeze an airborne actor.
 * Lost input is neutral, never fabricated direction. This is a recovery boundary. */
export function settleDisconnectedMovement(actor, stream) {
  if (
    !stream?.connection ||
    stream.connection === actor.connection ||
    stream.field !== actor.field ||
    stream.owned
  ) {
    return;
  }
  for (const grant of stream.grants) {
    applyExternalImpulse(actor.simulation, grant.vx, grant.vy, null, grant.source === "hit");
  }
  const debt = Math.min(
    PROTOCOL.INPUT_HISTORY,
    actor.field.tick - stream.startedTick - stream.steps,
  );
  assignHeldInput(actor.input, NEUTRAL);
  for (let step = 0; step < debt; step++) {
    stepMotion(actor.simulation, actor.input);
  }
}

/** During reconnect grace the shared world still simulates gravity and inertia. */
export function advanceDisconnectedMovement(actor) {
  const stream = actor.movementStream;
  assignHeldInput(actor.input, NEUTRAL);
  stepMotion(actor.simulation, actor.input);
  stream.tick++;
  stream.steps++;
  stream.checkpoint = captureMotion(actor.simulation);
}
