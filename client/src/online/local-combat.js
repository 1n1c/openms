import { LocalProjectiles } from "./local-projectiles.js";
import { LocalHits } from "./local-hits.js";
import { LocalIncoming } from "./local-incoming.js";
import { localAttackSpec } from "./local-combat-rules.js";
import {
  weaponActionDuration,
  weaponActionRelease,
  weaponActionAnimationMs,
} from "../combat/weapon-usage.js";

const MAX_ACTIONS = 32;
const RETAIN_MS = 60000;
const MAX_ATTACK_QUEUE = 1;
const ATTACK_QUEUE_MS = 2000;

/** Local action clock owns presentation only. Server echoes identify the exact request. */
export class LocalCombat {
  constructor(owner, now = () => performance.now()) {
    this.owner = owner;
    this.now = now;
    this.scene = null;
    this.records = new Map();
    this.active = null;
    this.queued = [];
    this.held = false;
    this.sequence = 0;
    this.projectiles = new LocalProjectiles(this);
    this.hits = new LocalHits(this, now);
    this.incoming = new LocalIncoming(this, now);
    this.impacts = new WeakMap();
  }
  bind() {
    const scene = this.owner.hooks.scene();
    if (scene === this.scene) return;
    this.destroy();
    this.scene = scene;
    if (scene) {
      scene.localCombat = this;
      this.incoming.bind();
    }
  }
  input(sample, inputSeq) {
    this.bind();
    const edge = sample.attack && !this.held;
    this.held = sample.attack;
    if (!edge) {
      // Player released key or held through the duration boundary.
      // If we have a stale queued entry (pressed inside suppressAttack
      // window — its wire attack was dropped by the server gate), wait
      // until current() flips false + suppressAttack lifts, then drop
      // the queue and clear held so the next real press gets a fresh
      // aligned identity. Never consume the queue directly — its identity
      // cannot match what the server actually consumed.
      if (
        this.queued.length > 0 &&
        !this.current() &&
        !this.staleActive() &&
        !this.suppressAttack()
      ) {
        this.queued.length = 0;
        this.held = false;
      }
      return;
    }
    // Edge=true — a real new press.
    if (this.staleActive()) {
      // Blocked locally by authority lag; still record the press as a
      // queue hint in case current() flips before suppressAttack lifts.
      // But queue identities are advisory only — never consumed directly.
      this.held = false;
      if (this.queued.length < MAX_ATTACK_QUEUE) {
        this.queued.push({
          identity: inputSeq,
          expires: this.now() + ATTACK_QUEUE_MS,
        });
      }
      return;
    }
    if (!this.current()) this.begin(null, inputSeq);
    else if (this.queued.length < MAX_ATTACK_QUEUE) {
      this.queued.push({
        identity: inputSeq,
        expires: this.now() + ATTACK_QUEUE_MS,
      });
    }
  }
  /** Suppress attack=true on the wire. Same release condition as
   *  staleActive() — both gates must lift together so every begin()
   *  has a matching wire attack=true. Releases when the current
   *  record is confirmed (server already acknowledged it) OR when
   *  server phase explicitly flips to idle. Transition hook clears
   *  held so a player holding the key through the block window gets
   *  a fresh edge with the correct aligned identity on the next tick. */
  suppressAttack() {
    const record = this.active;
    const entity = this.scene?.views?.get(this.scene.selfId)?.entity;
    const elapsed = record ? this.now() - record.started : 0;
    const shouldSuppress =
      record && !record.rejected && elapsed >= record.duration
        ? !(record.confirmed || entity?.combatState?.phase === "idle")
        : Boolean(record && !record.rejected);
    if (this._suppressActive && !shouldSuppress) {
      this.held = false;
    }
    this._suppressActive = shouldSuppress;
    return shouldSuppress;
  }
  /** Blocks new local predictions. Same logic as suppressAttack() —
   *  both gates must lift together so begin() and wire attack=true
   *  always share the same inputSeq identity. Releases when either:
   *    1. Server sent combat.attack event (confirmed=true), OR
   *    2. Server explicitly reported phase=idle.
   *  Also self-clears on ATTACK_QUEUE_MS timeout (network lost). */
  staleActive() {
    const record = this.active;
    if (!record || record.rejected) return false;
    const elapsed = this.now() - record.started;
    // Local still animating — let current() gate normally.
    if (elapsed < record.duration) return false;
    // Timeout safeguard — authority never replied.
    if (elapsed > record.duration + ATTACK_QUEUE_MS) {
      this.reject(record);
      return false;
    }
    // Server acknowledged this attack — safe to release. suppressAttack
    // uses the same confirmed check so both gates lift at once.
    if (record.confirmed) return false;
    const entity = this.scene?.views?.get(this.scene.selfId)?.entity;
    if (entity?.combatState?.phase === "idle") return false;
    return true;
  }
  update() {
    // Drop stale queue entries and trigger the held-clear that makes the
    // next real press produce a correctly aligned edge. Queue identities
    // are never consumed directly — they are placeholders for "the player
    // wants another attack soon", and the real begin() must happen from
    // a fresh input() edge carrying the current tick's inputSeq.
    if (this.staleActive()) return;
    const now = this.now();
    if (
      this.queued.length > 0 &&
      !this.current() &&
      !this.suppressAttack()
    ) {
      this.queued.length = 0;
      this.held = false;
    }
    while (this.queued[0] && this.queued[0].expires < now) {
      this.queued.shift();
    }
  }
  begin(skillId, identity) {
    this.bind();
    const now = this.now();
    this.prune(now);
    if (
      !identity ||
      !this.scene ||
      this.current(now) ||
      this.records.size >= MAX_ACTIONS
    ) {
      return null;
    }
    const spec = localAttackSpec(this.owner, skillId, this.sequence++);
    const action = spec && this.owner.scene.actor.actions.get(spec.action);
    if (!action) return null;
    const record = {
      ...spec,
      identity,
      skillId,
      started: now,
      duration:
        spec.speed === null
          ? action.duration
          : weaponActionDuration(action, spec.speed),
      confirmed: false,
      rejected: false,
      soundPlayed: false,
    };
    record.release = weaponActionRelease(action, record.duration);
    this.records.set(identity, record);
    this.active = record;
    this.owner.scene.actor.setAction(record.action, "once", true);
    if (record.sfx) {
      setTimeout(() => {
        if (record.rejected) return;
        this.owner.audio.onPlayerAttack(record.sfx);
      }, record.release);
      record.soundPlayed = true;
    }
    this.projectiles.begin(record);
    this.hits.begin(record);
    return record;
  }
  current(now = this.now()) {
    const record = this.active;
    return record && !record.rejected && now - record.started < record.duration
      ? record
      : null;
  }
  match(state) {
    if (!state) return null;
    return this.records.get(state.feedbackId ?? state.inputSeq) ?? null;
  }
  owns(entity) {
    return (
      entity.id === this.scene?.selfId &&
      entity.combatState?.phase !== "dead" &&
      Boolean(this.current() || this.match(entity.combatState))
    );
  }
  observe(entity) {
    const record = this.match(entity.combatState);
    if (record) record.confirmed = true;
    if (entity.combatState?.phase === "dead") {
      this.reject(this.active);
      this.queued.length = 0;
      this.incoming.motion?.clear();
      this.incoming.hitRemainingMs = 0;
    }
  }
  movementLock(message, predictedLock) {
    if (message.authoritative) return message.motion.movementLocked;
    if (predictedLock !== undefined) {
      if (message.combat?.locked && !this.match(message.combat)) return true;
      return predictedLock;
    }
    if (this.current()) return true;
    if (message.combat?.locked && this.match(message.combat)) return false;
    return Boolean(message.combat?.locked);
  }
  draw(animation) {
    const record = this.current();
    if (!record) return false;
    animation.setAction(record.action, "once");
    const elapsed = Math.max(0, this.now() - record.started);
    animation.seek(
      record.speed === null
        ? elapsed
        : weaponActionAnimationMs(animation.current, record.speed, elapsed),
    );
    return true;
  }
  soundEcho(event) {
    const record =
      event.actorId === this.scene?.selfId ? this.match(event) : null;
    if (record) record.confirmed = true;
    return Boolean(record?.soundPlayed);
  }
  /** Audio and scene publication share one decision even when their consumers run apart. */
  consumeImpact(event) {
    if (!this.impacts.has(event)) {
      this.impacts.set(
        event,
        this.hits.consume(event) || this.incoming.consume(event),
      );
    }
    return this.impacts.get(event);
  }
  reject(record) {
    if (!record) return;
    record.rejected = true;
    this.projectiles.cancel(record);
    this.hits.cancel(record);
    if (this.active === record) this.active = null;
  }
  prune(now) {
    for (const [id, record] of this.records) {
      if (
        now - record.started >= RETAIN_MS ||
        (record.confirmed && now - record.started > 5000)
      ) {
        this.reject(record);
        this.records.delete(id);
      }
    }
  }
  snapshot() {
    const entity = this.scene?.views.get(this.scene.selfId)?.entity;
    return {
      active: this.current()?.identity ?? null,
      observed: entity
        ? { ...entity.combatState, owned: this.owns(entity) }
        : null,
      projectiles: this.projectiles.flights.size,
      incoming: this.incoming.pending.size,
      incomingAt: this.incoming.presentedAt,
      hitPreview: this.incoming.motion?.sourceId ?? null,
      records: [...this.records.values()].map((record) => ({
        identity: record.identity,
        skillId: record.skillId,
        action: record.action,
        age: this.now() - record.started,
        duration: record.duration,
        confirmed: record.confirmed,
        rejected: record.rejected,
        previewCount: record.previewCount ?? 0,
        serverProjectile: record.serverProjectile ?? false,
        predicted: Boolean(record.hitScheduled),
      })),
    };
  }
  destroy() {
    for (const record of this.records.values()) this.reject(record);
    this.hits.destroy();
    this.incoming.destroy();
    if (this.scene) this.scene.localCombat = null;
    this.scene = null;
    this.records.clear();
    this.active = null;
    this.held = false;
    this.queued.length = 0;
  }
}
