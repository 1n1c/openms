import { applyMovementSettings } from "../../../shared/movement-settings.js";
import { PROTOCOL } from "../../../shared/protocol.js";
import {
  restoreMotion,
  stepMotion,
  createHeldInput,
  assignHeldInput,
  captureMotion,
} from "../../../shared/motion.js";
import {
  applyExternalImpulse,
  relocateSimulation,
} from "../physics/simulation.js";
import { FLASH_SKILLS } from "../skills/skill-world-rules.js";
import { constrainGroundPresentation } from "./prediction-contact.js";

const STALE_OBSERVATION_MS = 5000;
/** Explicit preview/reposition presentation only; ordinary acknowledgements never
 * create an offset. Field discontinuities still snap explicitly. */
const CORRECTION_EPSILON_PX = 0.001;
const MIN_CORRECTION_MS = 120;
const MAX_CORRECTION_MS = 600;
const ORDINARY_CORRECTION_MAX_PX = 192;
/** A server-owned reposition explains its own offset, so it may glide further before it is
 *  treated as a field replacement; the input lead plus one movement impulse fits inside. */
const AUTHORITATIVE_CORRECTION_MAX_PX = 512;
/** Removal rate for an absorbed offset. 0.125 px/ms is exactly walkSpeed, so the extra
 *  drawn travel inside one 30 ms kernel quantum stays at or below 3.75 px and the player
 *  reads a continuous trajectory rather than a rubber-band. */
const CORRECTION_PX_PER_MS = 0.125;
/** Optimistic movement skills awaiting their authoritative divert. Bounded: a cast
 *  whose event never arrives cannot grow memory, and an old entry cannot match a
 *  later cast of the same skill because it is retired by id on arrival or on reject. */
const MAX_PENDING_IMPULSES = 8;

function smoothCorrection(value) {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

function normalizeZero(value) {
  return Object.is(value, -0) ? 0 : value;
}

function historyEntry() {
  return {
    inputSeq: 0,
    targetTick: 0,
    horizontal: 0,
    vertical: 0,
    jump: false,
    attack: false,
    movementLocked: false,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
  };
}

/** Local movement owns its clock and trajectory. Ordinary server frames acknowledge
 * validated steps; only a new movement epoch or explicit server control replaces it. */
export class OnlinePrediction {
  constructor({ onInput, onResync, onGroundJump, onMovementLock } = {}) {
    this.onInput = onInput;
    this.onResync = onResync;
    this.onGroundJump = onGroundJump;
    this.onMovementLock = onMovementLock;
    this.controlFrame = null;
    this.simulation = null;
    this.held = createHeldInput();
    this.history = Array.from({ length: PROTOCOL.INPUT_HISTORY }, historyEntry);
    this.sample = {
      targetTick: 0,
      motionEpoch: 0,
      motionConfig: 0,
      movementLocked: false,
      impulses: [],
      horizontal: 0,
      vertical: 0,
      jump: false,
      attack: false,
      motion: { x: 0, y: 0, vx: 0, vy: 0 },
    };
    this.head = 0;
    this.count = 0;
    this.ready = false;
    this.paused = false;
    this.serverTick = 0;
    this.predictedTick = 0;
    this.lastObservedAt = 0;
    this.connectionEpoch = null;
    this.fieldEpoch = null;
    this.ackInputSeq = 0;
    this.motionEpoch = null;
    this.motionConfig = null;
    this.corrections = 0;
    this.maximumPositionError = 0;
    this.lastPositionError = 0;
    this.lastVelocityError = 0;
    this.replayedTicks = 0;
    this.overflows = 0;
    this.catchUpDebt = 0;
    this.timingState = null;
    this.filledTicks = 0;
    this.arrivalTick = 0;
    this.lastStepAt = 0;
    this.pendingImpulses = [];
    this.flashUsed = false;
    this.impulseUntilTick = 0;
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionUntil = 0;
    this.correctionSpan = MIN_CORRECTION_MS;
    this.drawnX = Number.NaN;
    this.drawnY = Number.NaN;
    this.correctionPose = { x: 0, y: 0 };
    this.diverts = 0;
    this.hitPreview = null;
  }

  /** Simulation must be built only from the authoritative field's immutable physics. */
  install(sim, serverTick) {
    if (!sim || !Number.isSafeInteger(serverTick) || serverTick < 0) {
      throw new Error("Invalid prediction installation");
    }
    this.clear();
    this.simulation = sim;
    this.serverTick = serverTick;
    this.predictedTick = serverTick;
  }

  /** Adopt the transport's filtered authenticated clock; simulation installation preserves timing. */
  timing(value) {
    this.timingState = value;
    if (
      this.connectionEpoch &&
      (this.connectionEpoch !== value.connectionEpoch ||
        this.fieldEpoch !== value.fieldEpoch)
    ) {
      this.ready = false;
    }
  }

  /** Ordinary acknowledgements never restore, replay or offset the local trajectory. */
  observe(message) {
    if (!this.simulation || !this.acceptObserved(message)) return;
    this.measure(message);
    const reset = !this.ready || this.motionEpoch !== message.motionEpoch;
    this.connectionEpoch = message.connectionEpoch;
    this.fieldEpoch = message.fieldEpoch;
    this.serverTick = message.serverTick;
    this.lastObservedAt = performance.now();
    this.ackInputSeq = message.ackInputSeq ?? this.ackInputSeq;
    if (this.paused && !message.paused) this.lastStepAt = this.lastObservedAt;
    this.paused = message.paused;
    this.controlFrame = message;
    if (reset || message.authoritative) this.resetMovement(message);
    else {
      this.retireHistory();
      this.applyDiverts(message.diverts);
      if (message.motionConfig !== this.motionConfig) {
        applyMovementSettings(this.simulation, message.motion);
        this.motionConfig = message.motionConfig;
      }
    }
    this.ready = true;
  }

  /** A field/connection reset or a real server-owned action establishes a new path. */
  resetMovement(message) {
    this.hitPreview?.clear();
    this.pendingImpulses.length = 0;
    this.sample.impulses.length = 0;
    restoreMotion(this.simulation, message.motion);
    assignHeldInput(this.held, message.motion.held);
    this.held.jumpPressed = false;
    this.held.attackPressed = false;
    this.motionEpoch = message.motionEpoch;
    this.motionConfig = message.motionConfig;
    this.predictedTick = message.motionTick;
    this.head = this.count = 0;
    this.lastStepAt = this.lastObservedAt;
    this.clearCorrection();
  }

  /** Reject a checkpoint from a retired connection or field, or an old tick. */
  acceptObserved(message) {
    if (
      this.connectionEpoch &&
      (message.connectionEpoch !== this.connectionEpoch ||
        message.fieldEpoch !== this.fieldEpoch)
    ) {
      this.requestResync();
      return false;
    }
    if (message.serverTick < this.serverTick) return false;
    if (
      message.ackInputSeq !== null &&
      message.ackInputSeq < this.ackInputSeq
    ) {
      throw new Error("Input acknowledgement regressed");
    }
    return true;
  }

  /** Merge every announced impulse into the client's own current kernel state. A skill
   *  the client already predicted optimistically is retired by id and not merged twice. */
  applyDiverts(diverts) {
    if (!Array.isArray(diverts) || diverts.length === 0) return 0;
    let applied = 0;
    for (const divert of diverts) {
      if (!Number.isFinite(divert.vx) || !Number.isFinite(divert.vy)) continue;
      if (divert.id === null) continue;
      if (divert.source === "hit") this.hitPreview?.reject(divert.sourceId);
      if (
        divert.source === "skill" &&
        this.retireOptimisticSkill(divert.skillId)
      ) {
        continue;
      }
      this.queueImpulse(divert);
      this.mergeImpulse(divert.vx, divert.vy, divert.source === "hit");
      applied++;
    }
    this.diverts += applied;
    return applied;
  }

  queueImpulse(divert) {
    if (this.sample.impulses.length >= 2) {
      this.requestResync();
      return;
    }
    this.sample.impulses.push({
      id: divert.id,
      source: divert.source,
      skillId: divert.skillId,
    });
  }

  /** Keep a disposable hit path aligned with additional admitted movement impulses. */
  mergeImpulse(vx, vy, preserveLadder = false) {
    applyExternalImpulse(this.simulation, vx, vy, null, preserveLadder);
    if (this.hitPreview?.sourceId) {
      applyExternalImpulse(this.hitPreview.simulation, vx, vy, null, preserveLadder);
    }
  }

  /** Apply one movement-skill impulse immediately and remember it so the authoritative
   *  divert for the same skill is not merged a second time. Returns a token the cast
   *  path can roll back if the server refuses the cast. */
  beginOptimistic(action, skillId = 0) {
    if (!action || action.kind !== "impulse" || !this.simulation) return null;
    if (!this.canPredictSkill(skillId)) return null;
    const token = {
      skillId,
      vx: action.vx,
      vy: action.vy,
      motion: captureMotion(this.simulation),
      flashUsed: this.flashUsed,
      impulseUntilTick: this.impulseUntilTick,
      tick: this.predictedTick,
    };
    this.queueImpulse({ id: null, source: "skill", skillId });
    this.mergeImpulse(action.vx, action.vy);
    this.pendingImpulses.push(token);
    if (FLASH_SKILLS.has(skillId)) this.flashUsed = true;
    // Original recovery: SkillWorldController.impulse; same 1000/1500-ms durations.
    const recoveryMs =
      skillId === 11101005 ? 1500 : skillId === 21001001 ? 1000 : 0;
    this.impulseUntilTick =
      this.predictedTick + Math.ceil(recoveryMs / PROTOCOL.TICK_MS);
    return token;
  }

  canPredictSkill(skillId) {
    return (
      this.pendingImpulses.length < MAX_PENDING_IMPULSES &&
      !(FLASH_SKILLS.has(skillId) && this.flashUsed) &&
      this.predictedTick >= this.impulseUntilTick
    );
  }

  /** A refused cast restores the exact pre-cast kernel checkpoint, so an unadmitted
   *  movement impulse cannot survive as free position the authority never granted. */
  rejectOptimistic(token) {
    if (!token || !this.simulation) return;
    const index = this.pendingImpulses.indexOf(token);
    // An accepted echo or a field replacement retires the token permanently.
    if (index < 0) return;
    this.pendingImpulses.splice(index, 1);
    const visibleX = this.simulation.x;
    const visibleY = this.simulation.y;
    restoreMotion(this.simulation, token.motion);
    this.reconcilePresentation(visibleX, visibleY);
    if (this.hitPreview?.sourceId) {
      this.hitPreview.reject(this.hitPreview.sourceId);
    }
    this.flashUsed = token.flashUsed;
    this.impulseUntilTick = token.impulseUntilTick;
    this.requestResync();
  }

  retireOptimisticSkill(skillId) {
    for (let index = 0; index < this.pendingImpulses.length; index++) {
      if (this.pendingImpulses[index].skillId === skillId) {
        this.pendingImpulses.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /** Absorb a server-owned reposition in presentation space: the drawn pose stays where
   *  the player saw it and glides onto the authoritative state over one short interval.
   *  A disagreement beyond the tolerance is a real desync and snaps immediately. */
  reconcilePresentation(visibleX, visibleY, explained = false) {
    this.seedCorrection(visibleX, visibleY, explained);
  }
  /** Absorb the difference between what the player currently sees and the authoritative
   *  state. The offset is re-seeded from the drawn pose rather than stacked, so a second
   *  checkpoint mid-glide retargets the same correction instead of adding another. An
   *  error below numeric tolerance is left alone; an error beyond the band is a real
   *  discontinuity (field replacement) and presents the new state outright. */
  seedCorrection(visibleX, visibleY, explained = false) {
    const now = performance.now();
    const originX = Number.isFinite(this.drawnX) ? this.drawnX : visibleX;
    const originY = Number.isFinite(this.drawnY) ? this.drawnY : visibleY;
    const base = this.interpolateKernel(now, this.correctionPose);
    const dx = originX - base.x;
    const dy = originY - base.y;
    const distance = Math.hypot(dx, dy);
    const limit = explained
      ? AUTHORITATIVE_CORRECTION_MAX_PX
      : ORDINARY_CORRECTION_MAX_PX;
    if (
      !Number.isFinite(distance) ||
      distance < CORRECTION_EPSILON_PX ||
      distance > limit
    ) {
      this.clearCorrection();
      return;
    }
    this.correctionX = dx;
    this.correctionY = dy;
    // Smoothstep's peak derivative is 1.5. Bound ordinary correction speed so a
    // recovering walk cannot reverse direction just to repay a presentation offset.
    const span = Math.max(
      MIN_CORRECTION_MS,
      (1.5 * distance) / CORRECTION_PX_PER_MS,
    );
    this.correctionSpan = explained ? Math.min(MAX_CORRECTION_MS, span) : span;
    this.correctionUntil = now + this.correctionSpan;
  }
  clearCorrection() {
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionUntil = 0;
    this.correctionSpan = MIN_CORRECTION_MS;
  }

  /** Compare the checkpoint with the prediction recorded for that same tick. */
  measure(message) {
    for (let index = 0; index < this.count; index++) {
      const entry = this.history[(this.head + index) % this.history.length];
      if (entry.inputSeq !== message.ackInputSeq) continue;
      this.lastPositionError = Math.hypot(
        entry.x - message.motion.x,
        entry.y - message.motion.y,
      );
      this.lastVelocityError = Math.hypot(
        entry.vx - message.motion.vx,
        entry.vy - message.motion.vy,
      );
      this.maximumPositionError = Math.max(
        this.maximumPositionError,
        this.lastPositionError,
      );
      break;
    }
  }

  /** A forced relocation replaces the kernel and retires pre-transition prediction. */
  relocate(x, y) {
    const sim = this.simulation;
    if (!sim || !Number.isFinite(x) || !Number.isFinite(y)) return;
    this.hitPreview?.clear();
    relocateSimulation(sim, { x, y });
    this.head = 0;
    this.count = 0;
    this.clearCorrection();
    // The next presentation step draws the relocation directly instead of gliding to it.
    this.drawnX = Number.NaN;
    this.drawnY = Number.NaN;
    this.lastStepAt = performance.now();
  }

  retireHistory() {
    for (let count = 0; count < this.history.length && this.count; count++) {
      if (this.history[this.head].inputSeq > this.ackInputSeq) break;
      this.head = (this.head + 1) % this.history.length;
      this.count--;
    }
  }

  /** Admit scheduler work only while the installed simulation has fresh authenticated timing. */
  canAdvance(now) {
    const timing = this.timingState;
    if (
      !this.ready ||
      !this.simulation ||
      this.paused ||
      !timing?.ready ||
      timing.paused ||
      timing.connectionEpoch !== this.connectionEpoch ||
      timing.fieldEpoch !== this.fieldEpoch
    ) {
      return false;
    }
    if (!Number.isFinite(now) || now < this.lastObservedAt) {
      throw new Error("Invalid prediction scheduler clock");
    }
    if (now - timing.receivedAt > STALE_OBSERVATION_MS) {
      this.requestResync();
      return false;
    }
    return true;
  }

  /** now is the local monotonic clock pacing completed 30 ms movement reports. */
  advance(now, held) {
    if (!this.canAdvance(now)) return 0;
    const due = Math.floor((now - this.lastStepAt) / PROTOCOL.TICK_MS);
    let steps = 0;
    for (; steps < Math.min(PROTOCOL.MAX_CATCH_UP, due); steps++) {
      if (this.count >= this.history.length) {
        this.requestResync();
        break;
      }
      if (!this.predict(held, true)) break;
      this.lastStepAt += PROTOCOL.TICK_MS;
    }
    this.catchUpDebt = Math.max(0, due - steps);
    return steps;
  }

  /** Browser presentation of the newest two locally integrated 30 ms kernel states.
   * The scheduled boundary is the interpolation anchor, preserving the sub-tick
   * remainder across timer wake-ups. Ordinary acknowledgements never move that anchor.
   * @param {number} now Local scheduler time in milliseconds.
   * @param {{x:number,y:number}} target Reused pose scratch; never allocated per frame.
   */
  interpolateKernel(now, target) {
    const sim = this.hitPreview?.sourceId
      ? this.hitPreview.simulation
      : this.simulation;
    if (!sim) return target;
    let alpha = 1;
    if (this.ready && this.lastStepAt > 0 && Number.isFinite(now)) {
      alpha = (now - this.lastStepAt) / sim.effectiveSettings.quantumMs;
      alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    }
    target.x = sim.previousX + (sim.x - sim.previousX) * alpha;
    target.y = sim.previousY + (sim.y - sim.previousY) * alpha;
    return target;
  }

  interpolate(now, target) {
    if (!this.simulation) return target;
    this.interpolateKernel(now, target);
    const baseX = target.x;
    const baseY = target.y;
    const remaining = this.correctionUntil - now;
    if (remaining > 0) {
      // Smoothstep removes the velocity discontinuity a linear ramp leaves at both ends,
      // so a correction bends the trajectory instead of nudging it.
      const fraction = smoothCorrection(remaining / this.correctionSpan);
      target.x += this.correctionX * fraction;
      target.y += this.correctionY * fraction;
    }
    this.constrainPresentation(target, baseX, baseY);
    this.drawnX = target.x;
    this.drawnY = target.y;
    return target;
  }

  /** Ground contact wins over an old airborne offset, including predicted hit recoil. */
  constrainPresentation(target, baseX, baseY) {
    const sim = this.hitPreview?.sourceId
      ? this.hitPreview.simulation
      : this.simulation;
    if (sim.state !== "ground" || sim.seat) return;
    this.correctionY = 0;
    if (!constrainGroundPresentation(sim, target, baseX, baseY)) {
      this.correctionX = 0;
    }
  }

  predict(held, transmit) {
    const sample = this.sample;
    sample.targetTick = this.predictedTick + 1;
    this.copyInput(sample, transmit ? held : this.held);
    sample.motionEpoch = this.motionEpoch;
    sample.motionConfig = this.motionConfig;
    this.applyLocalControls(transmit);
    sample.movementLocked = this.simulation.movementLocked;
    const entry = this.history[(this.head + this.count) % this.history.length];
    entry.targetTick = sample.targetTick;
    entry.horizontal = sample.horizontal;
    entry.vertical = sample.vertical;
    entry.jump = sample.jump;
    entry.attack = sample.attack;
    entry.movementLocked = this.simulation.movementLocked;
    assignHeldInput(this.held, sample);
    const previousJump = this.simulation.groundJumpSequence;
    stepMotion(this.simulation, this.held);
    // Native 009b1d3d cues Jump on local acceptance. Checkpoint replay is silent.
    if (this.simulation.groundJumpSequence !== previousJump) {
      this.onGroundJump?.();
    }
    this.hitPreview?.step(this.held);
    this.copyMotion(sample.motion);
    const inputSeq = this.onInput?.(sample) ?? 0;
    if (!Number.isSafeInteger(inputSeq) || inputSeq < 0) {
      throw new Error("Input sender must return admitted sequence");
    }
    entry.inputSeq = inputSeq;
    sample.impulses.length = 0;
    this.recordPose(entry);
    if (this.simulation.state === "ground") this.flashUsed = false;
    this.count++;
    if (!transmit) this.filledTicks++;
    this.predictedTick++;
    return true;
  }

  applyLocalControls(transmit) {
    if (transmit && this.controlFrame && this.onMovementLock) {
      this.simulation.movementLocked = this.onMovementLock(this.controlFrame);
    }
  }

  copyInput(target, held) {
    target.horizontal =
      Number(Boolean(held.right)) - Number(Boolean(held.left));
    target.vertical = Number(Boolean(held.down)) - Number(Boolean(held.up));
    // 0094c383 latches a jump request until the next movement step. Keyup must
    // not erase a physical press that happened entirely between two quanta.
    target.jump = Boolean(held.jump || held.jumpPressed);
    target.attack = Boolean(held.attack);
  }

  copyHeld(target) {
    this.copyInput(target, this.held);
  }

  /** Diagnostic resume hint; the next server checkpoint restores trusted motion. */
  resumeMotion() {
    if (!this.simulation) return null;
    const motion = { x: 0, y: 0, vx: 0, vy: 0 };
    this.copyMotion(motion);
    return motion;
  }

  /** Completed local endpoint; server reproduction validates it before world admission. */
  copyMotion(target) {
    const sim = this.simulation;
    target.x = normalizeZero(sim.x);
    target.y = normalizeZero(sim.y);
    target.vx = normalizeZero(sim.vx);
    target.vy = normalizeZero(sim.vy);
  }

  recordPose(entry) {
    entry.x = this.simulation.x;
    entry.y = this.simulation.y;
    entry.vx = this.simulation.vx;
    entry.vy = this.simulation.vy;
  }

  requestResync() {
    if (!this.ready) return;
    this.ready = false;
    this.overflows++;
    this.onResync?.("prediction-overflow");
  }

  clear() {
    this.hitPreview?.clear();
    this.controlFrame = null;
    this.ready = false;
    this.paused = false;
    this.simulation = null;
    this.head = 0;
    this.count = 0;
    this.connectionEpoch = null;
    this.fieldEpoch = null;
    this.ackInputSeq = 0;
    this.motionEpoch = null;
    this.catchUpDebt = 0;
    this.lastStepAt = 0;
    this.pendingImpulses.length = 0;
    this.flashUsed = false;
    this.impulseUntilTick = 0;
    this.correctionX = 0;
    this.correctionY = 0;
    this.correctionUntil = 0;
    this.correctionSpan = MIN_CORRECTION_MS;
    this.drawnX = Number.NaN;
    this.drawnY = Number.NaN;
  }

  snapshot() {
    return Object.freeze({
      motionEpoch: this.motionEpoch,
      ready: this.ready,
      paused: this.paused,
      serverTick: this.serverTick,
      predictedTick: this.predictedTick,
      history: this.count,
      ackInputSeq: this.ackInputSeq,
      corrections: this.corrections,
      maximumPositionError: this.maximumPositionError,
      lastPositionError: this.lastPositionError,
      lastVelocityError: this.lastVelocityError,
      replayedTicks: this.replayedTicks,
      timing: this.timingState,
      arrivalTick: this.arrivalTick,
      filledTicks: this.filledTicks,
      overflows: this.overflows,
      catchUpDebt: this.catchUpDebt,
      diverts: this.diverts,
      pendingImpulses: this.pendingImpulses.length,
    });
  }
}
