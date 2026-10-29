import {
  createSimulation,
  applyExternalImpulse,
} from "../physics/simulation.js";
import {
  captureMotion,
  restoreMotion,
  stepMotion,
} from "../../../shared/motion.js";

const LIFETIME_MS = 4000;

/** A disposable copy of local movement shows recoil immediately without reporting an
 * unconfirmed hit as gameplay motion. On confirmation the copy becomes the local path;
 * on refusal/expiry the existing renderer eases back to the untouched movement owner. */
export class LocalHitMotion {
  constructor(prediction, physics) {
    this.prediction = prediction;
    this.simulation = createSimulation(physics, { x: 0, y: 0 });
    this.sourceId = null;
    prediction.hitPreview = this;
  }
  begin(sourceId, direction) {
    const prediction = this.prediction;
    if (this.sourceId || !prediction.ready || prediction.paused) return false;
    restoreMotion(this.simulation, captureMotion(prediction.simulation));
    // Original 009581a9/007a6353 hit impulse; shared kernel handles slopes and landing.
    // preserveLadder=true: mob contact on a ladder deals damage but does not dismount.
    // The copy simulation carries ladder state through step(); confirm() restoreMotion
    // copies it back to the real sim without clobbering ladderId.
    applyExternalImpulse(this.simulation, direction * 270, -270, null, true);
    this.vx = direction * 270;
    this.sourceId = sourceId;
    this.age = 0;
    return true;
  }
  step(held) {
    if (!this.sourceId) return;
    this.simulation.movementLocked = this.prediction.simulation.movementLocked;
    stepMotion(this.simulation, held);
    this.age += this.simulation.effectiveSettings.quantumMs;
    if (this.age >= LIFETIME_MS) this.reject(this.sourceId);
  }
  confirm(divert) {
    if (!this.sourceId || divert.sourceId !== this.sourceId) return false;
    if (divert.vx !== this.vx || divert.vy !== -270) {
      this.reject(this.sourceId);
      return false;
    }
    restoreMotion(this.prediction.simulation, captureMotion(this.simulation));
    this.sourceId = null;
    return true;
  }
  reject(sourceId) {
    if (!this.sourceId || sourceId !== this.sourceId) return;
    this.sourceId = null;
    const sim = this.prediction.simulation;
    this.prediction.reconcilePresentation(sim.x, sim.y, true);
  }
  clear() {
    this.sourceId = null;
  }
  destroy() {
    this.clear();
    if (this.prediction.hitPreview === this) this.prediction.hitPreview = null;
  }
}
