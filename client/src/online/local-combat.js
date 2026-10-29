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
const MAX_ATTACK_QUEUE = 8;
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
    if (!edge) return;
    if (!this.current()) this.begin(null, inputSeq);
    else if (this.queued.length < MAX_ATTACK_QUEUE) {
      this.queued.push({
        identity: inputSeq,
        expires: this.now() + ATTACK_QUEUE_MS,
      });
    }
  }
  update() {
    const now = this.now();
    for (let count = 0; count < MAX_ATTACK_QUEUE; count++) {
      const next = this.queued[0];
      if (!next) return;
      if (next.expires < now) this.queued.shift();
      else if (this.current(now)) return;
      else {
        this.queued.shift();
        this.begin(null, next.identity);
        return;
      }
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
      // Delay sound to beat/release time — matches sdlMS load_sfx() which
      // delays audio by afterimage_game_instance::load_beat_time().
      // This syncs sound with afterimage visually appearing.
      setTimeout(() => {
        if (record.rejected) return; // Only skip on server rejection — play on confirmation (soundEcho blocks server echo)
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
