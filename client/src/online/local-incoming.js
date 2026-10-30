import { PLAYER_HIT } from "../../../shared/combat-protocol.js";
import { PhysicalDamage } from "../combat/physical-damage.js";
import {
  overlaps,
  placeBody,
  rectangleState,
} from "../world/life-geometry-numeric.js";
import { animationName } from "../../../shared/motion-schema.js";
import { LocalHitMotion } from "./local-hit-motion.js";

/** 00af14b8/00af14c8 ordinary and prone receiver rectangles, the same body the authority
 *  tests an incoming authored area against. */
const ORDINARY_BODY = { left: -22, top: -65, right: 22, bottom: 0 };
const PRONE_BODY = { left: -46, top: -31, right: 0, bottom: 0 };
const PREDICTION_TTL_MS = 4000;
/** `PLAYER_HIT.timerMs` in offline-field.js; the flinch face and the shared hit window
 *  (`rejectsHit` refuses another incoming outcome while `hitTimerMs !== 0`). */
const HIT_EXPRESSION_MS = PLAYER_HIT.timerMs;
const BLINK_TICK_MS = PLAYER_HIT.tickMs;
const BLINK_PHASE_MS = PLAYER_HIT.tickMs * PLAYER_HIT.ticksPerPhase;
const BLINK_NORMAL = PLAYER_HIT.normalTint;
const BLINK_HIT = PLAYER_HIT.hitTint;
const MAX_PENDING = 32;
const MAX_ARMS = 256;

/** The attacking client resolves its own outgoing feedback locally. Incoming feedback has
 *  the same problem in reverse: the mob's authored swing is already drawn from a published
 *  action, so the defender can resolve the number at that frame instead of waiting for the
 *  authoritative impact. Digits, flinch, sound and disposable recoil start locally;
 *  HP, death and status remain authoritative. Confirmation consumes the preview once. */
export class LocalIncoming {
  constructor(combat, now = () => performance.now(), random = Math.random) {
    this.combat = combat;
    this.now = now;
    this.damage = new PhysicalDamage(random);
    this.attackBody = rectangleState();
    this.receiver = rectangleState();
    this.clocks = new Map();
    this.armed = new Set();
    this.pending = new Map();
    this.contactCooldownMs = 0;
    this.hitRemainingMs = 0;
    this.presentedAt = null;
    /** Fixed-tick blink phase, driven by BLINK_TICK_MS accumulator. Mirrors
     *  OfflineField.blinkCounter exactly — the same 4-phase [GRAY, WHITE, WHITE, GRAY]
     *  cycle, reset when the hit window actually opens. */
    this.blinkPhase = 0;
    this.blinkAccumulator = 0;
  }

  bind() {
    const prediction = this.combat.owner.hooks.prediction;
    if (prediction) {
      this.motion = new LocalHitMotion(prediction, this.stage.manifest.physics);
    }
  }

  /** Advance the shared protection window once per field frame, regardless of mob count. */
  advance(elapsed) {
    this.contactCooldownMs = Math.max(0, this.contactCooldownMs - elapsed);
    this.hitRemainingMs = Math.max(0, this.hitRemainingMs - elapsed);
    // Fixed-tick blink phase mirrors the authority: one phase per BLINK_PHASE_MS quantum,
    // regardless of render-frame jitter.
    if (this.hitRemainingMs > 0) {
      this.blinkAccumulator += elapsed;
      while (this.blinkAccumulator >= BLINK_PHASE_MS) {
        this.blinkAccumulator -= BLINK_PHASE_MS;
        this.blinkPhase = (this.blinkPhase + 1) & 3;
      }
    } else {
      this.blinkAccumulator = 0;
    }
    this.prune();
  }

  /** Sets the final actor tint for this render frame. MUST run every frame because
   *  drawSelfPose → updateActor → setTint(0xffffff) zeroes the tint before us.
   *  Uses the identical 2-phase cycle as OfflineField so every hit's blink is
   *  consistent: GRAY → WHITE → GRAY → WHITE (alternate), 30ms per phase, 1500ms total. */
  drawSelf(view) {
    let tint = BLINK_NORMAL;
    if (this.hitRemainingMs > 0 && (this.blinkPhase & 1) === 0) {
      tint = BLINK_HIT;
    }
    view.animation.setTint(tint);
  }

  /** The online scene owns the entity views. */
  get scene() {
    return this.combat.scene;
  }

  /** The stream scene exposes the local observed simulation (crouch/prone receiver). */
  get stage() {
    return this.combat.scene?.scene ?? null;
  }

  /** Observe one drawn mob frame. Authored attacks resolve at their release; a `bodyAttack`
   *  mob resolves contact damage on the frame it first overlaps the player. */
  observe(view, elapsed) {
    const entity = view.entity;
    if (!entity || entity.kind !== "mob") return;
    if (!entity.mobState?.hp || entity.mobState.phase === "spawning") return;
    this.resolveContact(view);
    const attacks = view.life?.combat?.attacks;
    if (!this.tracking(entity, attacks)) return;
    const clock = this.advanceClock(entity, elapsed);
    const attack = this.releasedAttack(attacks, clock);
    if (!attack || !this.arm(entity)) return;
    this.resolve(view, attack);
  }

  /** `009581a9`/`bodyAttack`: the defender resolves a contact hit on the frame it touches
   *  the mob, instead of one round trip after the authority's own `contactDamage` tick. */
  resolveContact(view) {
    const info = view.life?.info;
    if (!this.contactEligible(info)) return;
    const self = this.localTarget();
    const stats = this.combat.owner.state?.presentation.stats;
    if (!self || !stats) return;
    if (!this.contactOverlaps(view, self)) return;
    const amount = this.roll(info, stats, null);
    if (amount === null) return;
    this.contactCooldownMs = HIT_EXPRESSION_MS;
    this.remember(view.entity.id, amount);
    this.present(self, amount, view, null);
  }

  contactEligible(info) {
    if (!info || this.contactCooldownMs > 0) return false;
    return info.bodyAttack === 1 && info.notAttack !== 1;
  }

  contactOverlaps(view, self) {
    const body = this.combat.hits?.mobBody(view, this.attackBody);
    if (!body) return false;
    this.placeReceiver(self);
    return overlaps(this.attackBody, this.receiver);
  }

  tracking(entity, attacks) {
    if (entity.mobState?.phase === "attack" && attacks?.length) return true;
    this.clocks.delete(entity.id);
    this.armed.delete(entity.id);
    return false;
  }

  advanceClock(entity, elapsed) {
    const action = animationName(entity.action);
    let clock = this.clocks.get(entity.id);
    if (
      !clock ||
      clock.action !== action ||
      clock.tick !== entity.actionStartTick
    ) {
      clock = { action, tick: entity.actionStartTick, elapsed: 0 };
      this.clocks.set(entity.id, clock);
    }
    const step = Number.isFinite(elapsed) ? elapsed : 0;
    clock.elapsed = Math.max(
      clock.elapsed + step,
      entity.mobState?.elapsedMs ?? 0,
    );
    return clock;
  }

  releasedAttack(attacks, clock) {
    const attack = attacks.find(
      (entry) =>
        entry.action === clock.action && entry.supported && entry.rectangle,
    );
    if (!attack) return null;
    const after = Number(attack.properties?.attackAfter);
    return clock.elapsed >= (Number.isFinite(after) ? after : 0)
      ? attack
      : null;
  }

  arm(entity) {
    const key = `${entity.id}:${entity.actionStartTick}`;
    if (this.armed.has(key)) return false;
    if (this.armed.size >= MAX_ARMS) this.armed.clear();
    this.armed.add(key);
    return true;
  }

  resolve(view, attack) {
    if (this.contactCooldownMs > 0) return;
    const self = this.localTarget();
    const info = view.life?.info;
    const stats = this.combat.owner.state?.presentation.stats;
    if (!self || !info || !stats) return;
    if (!this.overlapsPlayer(view, attack, self, info)) return;
    const amount = this.roll(info, stats, attack);
    if (amount === null) return;
    this.contactCooldownMs = HIT_EXPRESSION_MS;
    this.remember(view.entity.id, amount);
    this.present(self, amount, view, attack.action);
  }

  localTarget() {
    const scene = this.scene;
    const self = scene?.views.get(scene.selfId);
    if (!self || self.entity.combatState?.phase === "dead") return null;
    const protection = Math.abs(self.entity.combatState?.protectionMs ?? 0);
    if (protection > (self.observedAge ?? 0)) return null;
    return self;
  }

  /** The local player's receiver as the authority computes it for an incoming area. */
  overlapsPlayer(view, attack, self, info) {
    const flipped = view.entity.facing > 0 && !info.noFlip;
    placeBody(
      this.attackBody,
      attack.rectangle,
      { x: view.drawX, y: view.drawY },
      flipped,
    );
    this.placeReceiver(self);
    return overlaps(this.attackBody, this.receiver);
  }

  placeReceiver(view) {
    const simulation = this.stage?.simulation;
    const prone =
      simulation?.crouching === true && simulation?.state === "ground";
    placeBody(
      this.receiver,
      prone ? PRONE_BODY : ORDINARY_BODY,
      { x: view.drawX, y: view.drawY },
      view.entity.facing > 0,
    );
  }

  roll(info, stats, attack = null) {
    const magic = attack?.properties?.magic === 1;
    const authored = attack?.properties?.PADamage;
    let amount;
    try {
      amount = this.damage.receive(stats, info, {
        magic,
        attackPADamage:
          Number.isSafeInteger(authored) && authored >= 0 ? authored : null,
      });
    } catch {
      return null;
    }
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
  }

  remember(sourceId, amount) {
    this.prune();
    let queue = this.pending.get(sourceId);
    if (!queue) {
      queue = [];
      this.pending.set(sourceId, queue);
    }
    if (queue.length >= MAX_PENDING) queue.shift();
    queue.push({ at: this.now(), damage: amount });
  }

  /** Draw the predicted digit over the local player at the frame the swing lands, and start
   *  the authored flinch face on the same clock (`PLAYER_HIT.timerMs`, `00959321`). */
  present(view, amount, source, attackAction) {
    const events = this.scene?.events;
    if (!events || !this.reserve(events)) return;
    this.presentedAt = this.now();
    const animation = view.animation;
    if (amount > 0 && animation.expressions?.has("hit")) {
      animation.setExpression("hit", HIT_EXPRESSION_MS);
    }
    if (amount > 0) this.feedback(view, source, amount, attackAction);
    const geometry = animation.current?.geometry?.[animation.frame] ?? { y: 0 };
    events.combat.show(
      amount,
      2,
      events.combat.fixedNumberPlacement(view.drawX, view.drawY + geometry.y),
    );
  }

  feedback(view, source, amount, attackAction) {
    const prevRemaining = this.hitRemainingMs;
    this.hitRemainingMs = HIT_EXPRESSION_MS;
    if (prevRemaining <= 0) {
      this.blinkPhase = 0;
      this.blinkAccumulator = 0;
    }
    this.motion?.begin(source.entity.id, view.drawX >= source.drawX ? 1 : -1);
    this.combat.owner.audio?.onPlayerHit(
      {
        amount,
        attackAction,
        source: {
          x: source.drawX,
          y: source.drawY,
          templateId: source.entity.templateId,
        },
      },
      this.stage.presentation,
    );
  }

  reserve(events) {
    const numbers = events.combat?.snapshot?.();
    if (
      numbers &&
      numbers.active + numbers.pending + 1 > numbers.hardCapacity
    ) {
      return false;
    }
    events.reserveNumber();
    return true;
  }

  /** True when one local prediction already presented this authoritative incoming event. */
  consume(event) {
    if (event.cause !== "mob-attack" && event.cause !== "contact") return false;
    if (event.targetId !== this.combat.scene?.selfId) return false;
    // Any admitted incoming outcome, including a miss, starts the shared hit window.
    const queue = this.pending.get(event.actorId);
    if (!queue?.length) {
      this.contactCooldownMs = HIT_EXPRESSION_MS;
      return false;
    }
    const prediction = queue.shift();
    if (!queue.length) this.pending.delete(event.actorId);
    if (event.damage <= 0 || event.knockback === false) {
      this.motion?.reject(event.actorId);
    }
    return (
      this.now() - prediction.at <= PREDICTION_TTL_MS &&
      event.damage > 0 === prediction.damage > 0
    );
  }

  prune() {
    const now = this.now();
    for (const [sourceId, queue] of this.pending) {
      while (queue.length && now - queue[0].at > PREDICTION_TTL_MS) {
        queue.shift();
      }
      if (!queue.length) this.pending.delete(sourceId);
    }
  }

  destroy() {
    this.motion?.destroy();
    this.motion = null;
    this.contactCooldownMs = this.hitRemainingMs = 0;
    this.blinkPhase = 0;
    this.blinkAccumulator = 0;
    this.clocks.clear();
    this.armed.clear();
    this.pending.clear();
  }
}
