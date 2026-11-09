import { PhysicalDamage } from "../combat/physical-damage.js";
import { MOB_HIT } from "../combat/mob-hit.js";
import { weaponHitGroup } from "../combat/weapon-usage.js";
import {
  overlaps,
  placeBody,
  rectangleState,
} from "../world/life-geometry-numeric.js";
import { actionWeapon, attackRectangle } from "../skills/skill-rectangle.js";
import { skillLineCount } from "../skills/skill-damage.js";
import { skillNumber } from "../skills/skill-costs.js";
import { animationName } from "../../../shared/motion-schema.js";
import { previewTarget } from "./local-projectile-rules.js";

const MAX_TARGETS = 30;
const MAX_LINES = 30;
const MAX_PENDING = 128;
const PREDICTION_TTL_MS = 4000;
/** One drawn frame cannot advance the predicted recoil further than this. */
const MAX_RECOIL_STEP_MS = 100;
/** A locally predicted knockback the authority never confirms is freed after this long. */
const RECOIL_RELEASE_MS = 500;
/** Presentation tolerance: below this the predicted and authoritative paths have met. */
const MAX_PRESENT_GAP_MS = 50;
const RECOIL_EPSILON_PX = 0.01;
const REACTION_ACTION = "hit1";
const BASIC_INFO = Object.freeze({ damage: 100 });
/** 009537d5/0092fb41 flight speed used by the local projectile preview. */
const FLIGHT_SCALE = 1.5;
const FLIGHT_SHOULDER = 28;
const FLIGHT_HIT_Y = 20;

/** The original client resolves its own attack feedback locally and lets the server arbitrate
 *  the durable outcome (`009581a9` damage, `0066b05e` popup, `0095931c` attack display).
 *  This owner does the same: the attacker sees the reaction and the number at its own release
 *  frame, while HP, death, drops and knockback still follow the authoritative event. */
export class LocalHits {
  constructor(combat, now = () => performance.now(), random = Math.random) {
    this.combat = combat;
    this.now = now;
    this.damage = new PhysicalDamage(random);
    this.attackBody = rectangleState();
    this.receiver = rectangleState();
    this.targets = new Array(MAX_TARGETS).fill(null);
    // One FIFO per target: each authoritative event consumes exactly one local prediction.
    this.pending = new Map();
    this.reactions = new Map();
    this.timers = new Set();
    // De-dupe hit effect spawns (both local prediction and server-driven fallback).
    // Key: targetId, value: last spawn timestamp. Window: HITFX_DEDUPE_MS.
    this.hitEffectSpawned = new Map();
  }

  /** Hit effect spawn dedupe window — same target cannot spawn twice within this. */
  static HITFX_DEDUPE_MS = 300;

  /** Check and optionally mark a targetId as having spawned hit effect recently.
   *  Returns true if this call is the first within the dedupe window (should spawn),
   *  false if a recent spawn exists (should skip). Used by both local prediction
   *  path and server fallback path to prevent double hit effects. */
  tryMarkHitEffectSpawned(targetId, now = this.now()) {
    const last = this.hitEffectSpawned.get(targetId);
    if (last !== undefined && now - last < LocalHits.HITFX_DEDUPE_MS) {
      return false;
    }
    this.hitEffectSpawned.set(targetId, now);
    return true;
  }

  /** Roll provisional lines on the input edge, as in the original chain (`009581a9`).
   *  Presentation waits for release; reports are telemetry, never authoritative damage. */
  begin(record) {
    if (record.rejected || record.hitScheduled) return;
    const rectangle = attackRectangle(
      record.info ?? BASIC_INFO,
      actionWeapon(this.avatarCombat(), record.action),
    );
    const spec = record.spec;
    if (spec?.kind === "charge") return;
    const ray = Boolean(record.projectile);
    if (!ray && !rectangle) return;
    record.hitScheduled = true;
    record.hits = this;
    record.hitRectangle = rectangle ?? null;
    record.hitRay = ray;
    this.resolve(record);
    record.hitTimer = this.schedule(record, record.release, () =>
      this.presentResolved(record),
    );
  }

  /** When the server sends the authoritative projectile targetId, reconcile any local
   *  prediction that picked a different mob (common when two monsters overlap).
   *  Swaps the resolved view + migrates pending queue entries so presentResolved()
   *  and server consumeImpact() both hit the same authoritative target. */
  overrideProjectileTarget(record, serverTargetId) {
    if (!record.projectile) return false;
    const oldView = record.resolved?.[0]?.view;
    if (oldView && oldView.entity.id === serverTargetId) {
      // resolve() already ran and picked the server's target — nothing to do
      return false;
    }
    const scene = this.combat.scene;
    if (!scene) return false;
    const newView = scene.views?.get(serverTargetId);
    if (!newView) return false;
    // Case A: resolve() already ran but picked a different mob — swap now
    if (oldView) {
      this._swapResolvedView(record, oldView, newView, serverTargetId);
      return true;
    }
    // Case B (RACE): projectile event arrived BEFORE resolve() — stash serverTargetId
    // on the record so resolve() applies it when it runs next. This happens because
    // server input → projectile event → RTT is faster than client input → arm() → resolve()
    // when the connection is very fast (or server processes ranged attacks with minimal delay).
    record._pendingProjectileTarget = serverTargetId;
    return true;
  }

  _swapResolvedView(record, oldView, newView, serverTargetId) {
    // Migrate pending queue: old targetId → new targetId
    const oldQueue = this.pending.get(oldView.entity.id);
    const newQueue = this.pending.get(serverTargetId);
    if (oldQueue?.length) {
      if (newQueue) {
        for (const entry of oldQueue) {
          if (!entry.hitEffectPlayed && !newQueue.some(e => e.line === entry.line)) {
            newQueue.push(entry);
          }
        }
      } else {
        this.pending.set(serverTargetId, oldQueue);
      }
      this.pending.delete(oldView.entity.id);
    }
    record.resolved[0].view = newView;
  }

  avatarCombat() {
    return this.stage?.actor?.avatar?.combat ?? null;
  }

  /** The online scene owns the entity views; its stream scene owns the local actor pose. */
  get stage() {
    return this.combat.scene?.scene ?? null;
  }

  schedule(record, delay, run) {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        if (!record.rejected) run();
      },
      Math.max(0, Number(delay) || 0),
    );
    this.timers.add(timer);
    return timer;
  }

  /** Roll one attack against the mob poses the player is seeing, at the input edge. */
  resolve(record) {
    if (record.rejected || !record.hits) return;
    const scene = this.combat.scene;
    const origin = this.stage?.presentation;
    const stats = this.combat.owner.state?.presentation.stats;
    if (!scene || !origin || !stats) return;
    record.hitFacing = origin.facing > 0 ? 1 : -1;
    const count = this.select(record, origin);
    const resolved = [];
    const hits = [];
    for (let index = 0; index < count; index++) {
      const view = this.targets[index];
      this.targets[index] = null;
      const rolls = this.roll(record, view, stats);
      if (!rolls) continue;
      resolved.push({ view, rolls });
      for (let line = 0; line < rolls.length; line++) {
        hits.push({
          targetId: view.entity.id,
          line,
          damage: rolls[line].amount,
          critical: rolls[line].critical,
        });
        // Populate pending queue ENTIRELY at input edge time, NOT in presentResolved().
        // This must happen BEFORE any server impact can race in and call consume().
        // Previously remember() ran inside presentResolved() → pending queue was empty
        // when server impact arrived before release frame → takePrediction returned null
        // → server spawned hit effect + local present() also spawned → double hit effect.
        this.prune();
        const targetId = view.entity.id;
        let queue = this.pending.get(targetId);
        if (!queue) { queue = []; this.pending.set(targetId, queue); }
        if (queue.length >= MAX_PENDING) queue.shift();
        queue.push({
          at: this.now(),  // Will be updated by remember() in presentResolved; only for dedupe matching here
          damage: rolls[line].amount,
          line,
          skillId: record.skillId ?? 0,
          record,
          soundPlayed: false,
          hitEffectPlayed: false,
        });
      }
    }
    record.resolved = resolved;
    // If a server projectile event raced ahead of resolve() (common with fast
    // connections or minimal ranged-attack delay), apply the stashed authoritative
    // targetId now so presentResolved() and consumeImpact() both hit the same mob.
    if (record._pendingProjectileTarget && resolved.length) {
      const newView = scene.views?.get(record._pendingProjectileTarget);
      const oldView = resolved[0].view;
      if (newView && oldView && oldView.entity.id !== newView.entity.id) {
        this._swapResolvedView(record, oldView, newView, record._pendingProjectileTarget);
      }
      record._pendingProjectileTarget = null;
    }
    this.report(record, hits);
  }

  /** Publish the rolled lines once; the authority key is the attack's own identity. */
  report(record, hits) {
    if (!hits.length) return;
    const feedbackId = record.skillId ? String(record.identity) : null;
    const inputSeq = record.skillId ? null : Number(record.identity);
    if (feedbackId === null && !Number.isSafeInteger(inputSeq)) return;
    this.combat.owner.reportHits?.({
      feedbackId,
      inputSeq,
      skillId: Number(record.skillId) || 0,
      hits,
    });
  }

  /** Draw the lines already rolled at the input edge, after the authored release/flight. */
  presentResolved(record) {
    if (record.rejected) return;
    const origin = this.stage?.presentation;
    let index = 0;
    for (const entry of record.resolved ?? []) {
      // Capture index so the closure reads the LATEST view from record.resolved
      // instead of a stale local variable. overrideProjectileTarget() swaps
      // record.resolved[index].view when the server says we picked the wrong
      // mob (common with overlapping monsters and fast connections), and the
      // scheduled present() must reflect that swap.
      const entryIndex = index;
      const delay = record.hitRay
        ? origin
          ? flightMs(origin, entry.view, record.projectile)
          : 0
        : 0;
      for (let line = 0; line < entry.rolls.length; line++) {
        this.remember(entry.view, entry.rolls[line].amount, delay, {
          record,
          line,
        });
      }
      if (delay > 0) {
        this.schedule(record, delay, () => {
          const latestView = record.resolved?.[entryIndex]?.view;
          if (latestView) this.present(record, latestView, entry.rolls);
        });
      } else this.present(record, entry.view, entry.rolls);
      index++;
    }
  }

  select(record, origin) {
    const scene = this.combat.scene;
    if (record.hitRay) {
      const view = previewTarget(scene, origin, record.projectile?.range ?? 0);
      if (view && this.eligible(view)) {
        this.targets[0] = view;
        return 1;
      }
      return 0;
    }
    placeBody(this.attackBody, record.hitRectangle, origin, origin.facing > 0);
    const limit = Math.min(
      MAX_TARGETS,
      Math.max(1, skillNumber(record.info?.mobCount, 1)),
    );
    const found = [];
    for (const view of scene.views.values()) {
      if (!this.eligible(view)) continue;
      const body = this.mobBody(view, this.receiver);
      if (!body || !overlaps(this.attackBody, body)) continue;
      found.push(view);
    }
    found.sort(
      (left, right) =>
        Math.abs(left.drawX - origin.x) - Math.abs(right.drawX - origin.x),
    );
    const count = Math.min(limit, found.length);
    for (let index = 0; index < count; index++) {
      this.targets[index] = found[index];
    }
    return count;
  }

  eligible(view) {
    const entity = view.entity;
    if (entity.kind !== "mob" || !entity.mobState?.hp) return false;
    if (entity.mobState.phase === "spawning") return false;
    return !view.life?.info?.invincible;
  }

  /** The authored receiver of the frame the mob is drawn with, at its drawn position. */
  mobBody(view, slot) {
    const action =
      view.life?.actions?.[view.animation.action] ??
      view.life?.actions?.[animationName(view.entity.action)];
    const frames = action?.frames;
    if (!frames?.length) return null;
    const index = Math.max(
      0,
      Math.min(view.animation.frame, frames.length - 1),
    );
    const body = frames[index].body;
    if (!body) return null;
    placeBody(
      slot,
      body,
      { x: view.drawX, y: view.drawY },
      view.entity.facing > 0,
    );
    return slot;
  }

  roll(record, view, stats) {
    const info = view.life?.info;
    if (!info) return null;
    const lines = this.lines(record);
    const rolls = [];
    for (let line = 0; line < lines; line++) {
      let amount;
      try {
        amount = this.damage.generate(
          stats,
          info,
          this.percent(record),
          record.use,
        );
      } catch {
        return null;
      }
      if (!Number.isSafeInteger(amount) || amount < 0) return null;
      rolls.push({ amount, critical: this.damage.lastCritical });
    }
    return rolls;
  }

  lines(record) {
    if (!record.skillId) return 1;
    return Math.max(
      1,
      Math.min(MAX_LINES, skillLineCount(record.info ?? BASIC_INFO)),
    );
  }

  percent(record) {
    const percent = Number(record.info?.damage);
    return Number.isSafeInteger(percent) && percent > 0 ? percent : 100;
  }

  remember(view, amount, delay, details = {}) {
    this.prune();
    const id = view.entity.id;
    let queue = this.pending.get(id);
    if (!queue) {
      queue = [];
      this.pending.set(id, queue);
    }
    const line = details.line ?? 0;
    const skillId = details.record?.skillId ?? 0;
    // Update existing entry already pre-populated by resolve() at input edge time.
    // Don't push a duplicate — resolve() created this entry eagerly to win the
    // race against early server impacts.
    const existingIdx = queue.findIndex(
      (e) => e.line === line && e.skillId === skillId && e.record === details.record,
    );
    if (existingIdx >= 0) {
      queue[existingIdx].at = this.now() + delay;
      queue[existingIdx].damage = amount;
      return;
    }
    if (queue.length >= MAX_PENDING) queue.shift();
    queue.push({
      at: this.now() + delay,
      damage: amount,
      line,
      skillId,
      record: details.record,
    });
  }

  /** Reserve one display slot, or give up instead of throwing out of a timer callback. */
  reserve() {
    const numbers = this.combat.scene?.events?.combat?.snapshot?.();
    if (
      numbers &&
      numbers.active + numbers.pending + 1 > numbers.hardCapacity
    ) {
      return false;
    }
    this.combat.scene.events.reserveNumber();
    return true;
  }

  /** Local prediction for reaction, recoil, sound AND hit.img spark effect.
   *  All four now run at the authored release frame, so hit effect stays
   *  frame-aligned with the attacker's own animation instead of drifting behind
   *  server round-trip. */
  present(record, view, rolls) {
    if (record.rejected) return;
    const scene = this.combat.scene;
    // A mob that died while a ray was in flight must not receive a corpse number.
    if (!view.entity.mobState?.hp) return;
    if (!scene?.views.has(view.entity.id)) return;
    this.react(view, rolls[0].amount);
    this.recoil(view, rolls[0].amount, record.hitFacing ?? 1);
    this.playSound(view, rolls[0].amount, record);
    this.playHitEffect(view, record);
  }

  /** Spawn hit.img spark effect locally at the release frame — same timing as react/recoil.
   *  melee basic attacks only; ranged/magic have their own Skill.wz visuals.
   *  De-duped against server-driven spawn via tryMarkHitEffectSpawned (shared Map). */
  playHitEffect(view, record) {
    const targetId = view.entity.id;
    // Mark all pending entries from this record for this targetId.
    const queue = this.pending.get(targetId);
    if (queue?.length) {
      for (const entry of queue) {
        if (entry.record === record) entry.hitEffectPlayed = true;
      }
    }
    // Only basic melee attacks spawn hit.img sparks
    if (record.skillId) return;
    const weaponType = this.avatarCombat()?.weaponType;
    if (!weaponType) return;
    const group = weaponHitGroup(weaponType);
    if (!group) return;
    // Shared dedupe: server fallback spawn may race here and already spawned.
    if (!this.tryMarkHitEffectSpawned(targetId)) return;
    const variant = `${group}${Math.random() < 0.5 ? "1" : "2"}`;
    const combatPresentation = this.combat.scene?.events?.combat;
    if (!combatPresentation?.onHitEffect) return;
    const facing = record.hitFacing ?? 1;
    combatPresentation.onHitEffect(view.drawX, view.drawY, facing, variant);
  }

  playSound(view, amount, record) {
    if (amount > 0) {
      // Mark ALL pending entries from this record for this targetId. One present()
      // call = one local sound regardless of how many damage lines the skill has.
      // takePrediction splices entries one at a time by line+skillId, so EVERY entry
      // matching this record must have soundPlayed=true to avoid N audio replays from
      // N incoming authoritative impact events.
      const queue = this.pending.get(view.entity.id);
      if (queue?.length) {
        for (const entry of queue) {
          if (entry.record === record) entry.soundPlayed = true;
        }
      }
      this.combat.owner.audio?.onMobHit?.(
        {
          x: view.drawX,
          y: view.drawY,
          templateId: view.entity.templateId,
          alive: true,
        },
        amount,
        this.stage.presentation,
      );
    }
  }

  /** `0066b6fc`/`009bbdfd`: the attacker resolves the mob's recoil locally, so the knockback
   *  starts on the same frame as the number and the hit pose instead of one round trip later.
   *  The displacement is expressed against the authority's own progress at draw time, so the
   *  server's later identical trajectory is not added twice. */
  recoil(view, amount, facing) {
    const info = view.life?.info;
    const state = view.entity.mobState;
    const action = view.animation.actions.get(REACTION_ACTION);
    if (!this.recoilAdmitted(info, state, amount, action)) return;
    const duration = Math.max(1, action.duration);
    const motion = view.motion;
    view.recoil = {
      facing: facing > 0 ? 1 : -1,
      speed: MOB_HIT.velocity,
      deceleration: MOB_HIT.deceleration,
      ms: duration,
      distance: 0,
      originX: motion && Number.isFinite(motion.x) ? motion.x : view.drawX,
      age: 0,
      confirmed: false,
      generation: state.generation,
      releaseAfterMs: duration + RECOIL_RELEASE_MS,
    };
  }

  recoilAdmitted(info, state, amount, action) {
    // Flying recoil uses its own flight controller and is not predicted here.
    if (!info || !state || state.phase === "attack") return false;
    if (state.movementType === 3) return false;
    if (amount < (info.pushed ?? 1)) return false;
    return Boolean(action && action.duration >= MOB_HIT.minimumMotionMs);
  }

  /** Current presentation offset for a locally predicted mob knockback, or null. */
  recoilOffset(view, elapsed) {
    const state = view.recoil;
    if (!state) return null;
    if (state.generation !== view.entity.mobState?.generation) {
      view.recoil = null;
      return null;
    }
    const dt = Math.min(Math.max(0, Number(elapsed) || 0), MAX_RECOIL_STEP_MS);
    this.advanceRecoil(state, dt);
    const applied = this.appliedRecoil(view, state, dt);
    // A sub-pixel residue is not a displacement; the same path must settle, not jitter.
    if (applied < RECOIL_EPSILON_PX) {
      if (state.ms === 0 && state.distance === 0) view.recoil = null;
      return null;
    }
    return { x: state.facing * applied, y: 0 };
  }

  /** Integrate the authored knockback profile: trapezoidal distance at a fixed braking rate. */
  advanceRecoil(state, dt) {
    state.age += dt;
    if (state.ms <= 0) return;
    const seconds = Math.min(dt, state.ms) / 1000;
    const before = state.speed;
    state.speed = Math.max(0, before - state.deceleration * seconds);
    state.distance += ((before + state.speed) / 2) * seconds;
    state.ms = Math.max(0, state.ms - dt);
  }

  /** The authority owns the durable displacement; show only the part it has not applied.
   *  A refused or missed hit must not leave the mob permanently displaced, so after the
   *  reaction window an unconfirmed prediction is retired at the same braking rate. */
  appliedRecoil(view, state, dt) {
    const motionX =
      view.motion && Number.isFinite(view.motion.x)
        ? view.motion.x
        : view.drawX;
    const server = (motionX - state.originX) * state.facing;
    if (!state.confirmed && state.age > state.releaseAfterMs) {
      state.distance = Math.max(
        0,
        state.distance - (MOB_HIT.velocity * dt) / 1000,
      );
    }
    const applied = state.distance - server;
    if (applied < 0) return 0;
    return applied > state.distance ? state.distance : applied;
  }

  /** `0066b98b`: the hit pose persists for its authored duration and only then yields. */
  react(view, amount) {
    const info = view.life?.info;
    if (!info || amount < (info.pushed ?? 1)) return;
    if (view.entity.mobState?.phase === "attack") return;
    const action = view.animation.actions.get(REACTION_ACTION);
    if (!action) return;
    const observed = animationName(view.entity.action);
    // A mob already inside its own hit window keeps the reaction it has.
    if (observed === REACTION_ACTION) return;
    this.reactions.set(view.entity.id, {
      until: this.now() + Math.max(1, action.duration),
      observed,
    });
  }

  /** The pose the mob should present, or null while the observed action still owns it. */
  reaction(view) {
    const entry = this.reactions.get(view.entity.id);
    if (!entry) return null;
    // Any change in the observed action (the confirmed hit, a death, a fresh attack) means
    // authority has something newer to present, so the local pose yields at once.
    if (
      this.now() >= entry.until ||
      animationName(view.entity.action) !== entry.observed
    ) {
      this.reactions.delete(view.entity.id);
      return null;
    }
    return view.animation.actions.has(REACTION_ACTION) ? REACTION_ACTION : null;
  }

  /** Outgoing impacts: take the matching local prediction (side effects: recoil.confirmed,
   *  pending splice) and return a flags object { soundPlayed, hitEffectPlayed } so the
   *  authoritative caller knows which local side effects already fired. */
  consume(event) {
    if (event.actorId !== this.combat.scene?.selfId) return { soundPlayed: false, hitEffectPlayed: false };
    const prediction = this.takePrediction(event);
    if (!prediction) return { soundPlayed: false, hitEffectPlayed: false };
    // Side effect: mark local knockback as confirmed by authority
    const view = this.combat.scene?.views?.get(event.targetId);
    if (view?.recoil && event.damage > 0) view.recoil.confirmed = true;
    // Mark hitEffectPlayed early so server path knows local present may still spawn.
    if (!prediction.hitEffectPlayed) prediction.hitEffectPlayed = true;
    return {
      soundPlayed: Boolean(prediction.soundPlayed),
      hitEffectPlayed: true,
    };
  }

  takePrediction(event) {
    const queue = this.pending.get(event.targetId);
    if (!queue?.length) return null;
    const index = queue.findIndex(
      (entry) =>
        entry.line === (event.line ?? 0) &&
        entry.skillId === (event.skillId ?? 0),
    );
    if (index < 0) return null;
    const [prediction] = queue.splice(index, 1);
    if (!queue.length) this.pending.delete(event.targetId);
    return prediction;
  }

  prune() {
    const now = this.now();
    for (const [targetId, queue] of this.pending) {
      while (queue.length && now - queue[0].at > PREDICTION_TTL_MS) {
        queue.shift();
      }
      if (!queue.length) this.pending.delete(targetId);
    }
  }

  cancel(record) {
    record.hits = null;
    record.resolved = null;
    for (const [id, queue] of this.pending) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].record === record) queue.splice(i, 1);
      }
      if (!queue.length) this.pending.delete(id);
    }
    if (!record.hitTimer) return;
    clearTimeout(record.hitTimer);
    this.timers.delete(record.hitTimer);
    record.hitTimer = null;
  }

  destroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.reactions.clear();
  }
}

function flightMs(origin, view, projectile) {
  const dx = view.drawX - (origin.x + origin.facing * (projectile.start ?? 0));
  const dy = view.drawY - FLIGHT_HIT_Y - (origin.y - FLIGHT_SHOULDER);
  return Math.max(1, Math.trunc(Math.hypot(dx, dy) * FLIGHT_SCALE));
}
