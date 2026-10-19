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
const HIT_EXPRESSION_MS = 1500;
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
    // Phase 4 (RNG sync route A): server-authoritative pre-computed incoming
    // damages, keyed by mobId → actionKey → {damage, critical, admitted}.
    // resolve() consumes entries here before falling back to local RNG roll.
    this.previewed = new Map();
    this.contactCooldownMs = 0;
    this.hitRemainingMs = 0;
    this.presentedAt = null;
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
    this.prune();
  }

  drawSelf(view) {
    const blinking =
      this.hitRemainingMs > 0 &&
      Math.floor((HIT_EXPRESSION_MS - this.hitRemainingMs) / 30) % 4 < 2;
    view.animation.setTint(
      blinking ? 0x808080 : (view.entity.combatState?.tint ?? 0xffffff),
    );
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
    this.remember(view.entity.id, amount, "contact");
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

  /** Phase 4 (RNG sync route A): absorb the server's authoritative pre-roll
   *  incoming damage for a mob's authored swing. resolve() will consume these
   *  entries before falling back to its own local RNG, eliminating the
   *  "client rolled crit but server rolled non-crit" divergence. */
  ingestPreview(mobId, attackAction, previews) {
    const actionKey = attackAction ?? "contact";
    let bucket = this.previewed.get(mobId);
    if (!bucket) {
      bucket = new Map();
      this.previewed.set(mobId, bucket);
    }
    bucket.set(actionKey, { previews, at: this.now() });
    // Cap the previewed map to the last 8 mobs (memory guard).
    if (this.previewed.size > 8) {
      const firstKey = this.previewed.keys().next().value;
      this.previewed.delete(firstKey);
    }
  }

  /** Consume the server preview for (mobId, actionKey) if one exists.
   *  Returns { damage, admitted } or null if no preview available. */
  consumePreview(mobId, actionKey, selfId) {
    const bucket = this.previewed.get(mobId);
    if (!bucket) return null;
    const actionKeyFinal = actionKey ?? "contact";
    const entry = bucket.get(actionKeyFinal);
    if (!entry) return null;
    // Expire previews older than PREDICTION_TTL_MS — same window as pending.
    if (this.now() - entry.at > PREDICTION_TTL_MS) {
      bucket.delete(actionKeyFinal);
      return null;
    }
    // Find the preview that targets this local player.
    const hit = entry.previews.find((p) => p.targetId === selfId);
    bucket.delete(actionKeyFinal);
    if (!bucket.size) this.previewed.delete(mobId);
    if (!hit) return null;
    return { damage: hit.damage, admitted: hit.admitted };
  }

  resolve(view, attack) {
    if (this.contactCooldownMs > 0) return;
    const self = this.localTarget();
    const info = view.life?.info;
    const stats = this.combat.owner.state?.presentation.stats;
    if (!self || !info || !stats) return;
    if (!this.overlapsPlayer(view, attack, self, info)) return;

    // Phase 4 (RNG sync route A): prefer server's authoritative pre-rolled
    // damage over local Math.random(). This is the core fix for "client rolled
    // crit but server rolled non-crit" divergence. Contact damage (action=null
    // from bodyAttack mobs) has no server preview — fall through to local roll.
    let amount;
    const preview = attack?.action
      ? this.consumePreview(view.entity.id, attack.action, this.scene?.selfId)
      : null;
    if (preview) {
      if (!preview.admitted) return; // server says miss/dodge — skip render
      amount = preview.damage;
    } else {
      amount = this.roll(info, stats, attack);
      if (amount === null) return;
      // Phase 5 (contact RNG sync): for bodyAttack contact (attack=null), the
      // client rolled this damage locally. Report it to the server so the server
      // validates it's within [min, max] and reuses it instead of rolling its own
      // RNG — one roll = one truth, no contact RNG split.
      if (!attack?.action) {
        this.combat.owner?.reportContact?.(view.entity.id, amount);
      }
    }

    this.contactCooldownMs = HIT_EXPRESSION_MS;
    this.remember(view.entity.id, amount, attack?.action ?? "contact");
    this.present(self, amount, view, attack?.action ?? null);
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

  remember(sourceId, amount, actionKey = null) {
    this.prune();
    let queue = this.pending.get(sourceId);
    if (!queue) {
      queue = [];
      this.pending.set(sourceId, queue);
    }
    if (queue.length >= MAX_PENDING) queue.shift();
    queue.push({ at: this.now(), damage: amount, actionKey });
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
    this.hitRemainingMs = HIT_EXPRESSION_MS;
    // Client-authoritative: knockback for incoming attacks comes ONLY from the server's
    // motionDivert → applyDiverts → mergeImpulse path. LocalHitMotion creates an
    // independent hitPreview simulation that step()s for N frames, its position diverges
    // from the server's authoritative path, and the subsequent reject/confirm either
    // causes a visible position jump OR triggers server motion.fault (kick). Disabling
    // local prediction here eliminates the divergence entirely.
    // this.motion?.begin(source.entity.id, view.drawX >= source.drawX ? 1 : -1);
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

  /** True when one local prediction already presented this authoritative incoming event.
   *  Phase 2 (root cause C): prefer exact actionKey match over blind FIFO so that
   *  consecutive same-mob attacks cannot cross-consume each other's predictions.
   *  Falls back to FIFO when no actionKey matches, for contact-damage entries
   *  (actionKey = "contact" vs server attackAction = null) and legacy entries. */
  consume(event) {
    if (event.cause !== "mob-attack" && event.cause !== "contact") return false;
    if (event.targetId !== this.combat.scene?.selfId) return false;
    const queue = this.pending.get(event.actorId);
    if (!queue?.length) {
      this.contactCooldownMs = HIT_EXPRESSION_MS;
      return false;
    }
    const wantKey = event.attackAction ?? "contact";
    let index = queue.findIndex((p) => p.actionKey === wantKey);
    if (index < 0) index = 0; // fallback FIFO head
    const prediction = queue.splice(index, 1)[0];
    if (!queue.length) this.pending.delete(event.actorId);
    if (event.damage <= 0 || event.knockback === false) {
      this.motion?.reject(event.actorId);
    }
    return this.now() - prediction.at <= PREDICTION_TTL_MS;
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
    this.clocks.clear();
    this.armed.clear();
    this.pending.clear();
  }
}
