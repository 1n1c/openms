import { OfflineField } from "../../client/src/combat/offline-field.js";
import { overlaps, placeBody } from "../../client/src/world/life-geometry-numeric.js";
import { updateHitboxes } from "../../client/src/physics/hitboxes.js";
import { admitActor } from "./action-rules.js";
import { combatOperation, rewardKill } from "./combat-rewards.js";
import { avatarAction } from "../../client/src/rendering/animation-timing.js";
import { captureKillDropRates } from "./field-drops.js";
import { hasMobStatus } from "../../client/src/combat/mob-skill-status.js";
import { protocolError } from "../../shared/schema.js";
import { syncActorEffects } from "./action-character.js";
import { planKillCredit } from "./kill-credit.js";
import { takeAttackInput } from "./attack-input.js";

/** Shared OfflineField algorithms; only persistence, field scheduling and publication differ. */
export class AuthorityCombat extends OfflineField {
  constructor(world, actor, { scene, store, hooks }) {
    super(scene, store, hooks);
    this.world = world;
    this.actor = actor;
    this.actionId = null;
    this.paidAmmunition = false;
    this.rewardJobs = new Set();
    this.rewardTail = Promise.resolve();
    this.incoming = [];
    this.incomingTask = null;
    this.incomingFailure = null;
    actor.combatPresentation = {
      modifiers: {
        booster: 0,
        speedInfusion: 0,
        soulArrow: false,
        shadowStars: false,
        infinity: false,
        concentrate: 0,
        shadowPartner: false,
      },
    };
    this.prepared = true;
  }
  startPose(name, phase) {
    super.startPose(name, phase);
    this.feedbackId = this.actor.skills?.resources.feedbackId ?? null;
    this.feedbackInputSeq =
      this.feedbackId || this.attackSkill || phase !== "attack"
        ? null
        : (this.pendingAttackInputSeq ?? null);
    this.actionId = combatOperation(this.actor, "combat.attack").operationId;
    this.actor.actionStartTick = this.actor.field.tick;
    this.projectActor();
  }

  /** Client-authoritative target selection. The client and server legitimately pick
   *  different "closest" mobs because the client uses drawX (interpolated render)
   *  while the server uses mob.x with lag-compensation rewind ticks. When both sides
   *  pick 1 target but different ones, the player sees a number on mob-A while mob-B
   *  loses HP — which is unacceptable.
   *
   *  The client already rolls damage, renders numbers, reports { targetId, damage, critical }
   *  via reportHits. The server should TRUST the client's targetId for selection, but
   *  still validate (mob alive? in attack body overlap?) and still roll its own damage
   *  numbers for HP/death. */
  playerImpact() {
    this.attackFired = true;
    if (this.attackSkill) {
      this.skillCombat.impact();
      return;
    }
    if (this.weaponUse.ranged) {
      this.launchProjectile();
      return;
    }
    const sim = this.simulation;
    placeBody(this.attackBody, this.attack.rectangle, sim, sim.facing > 0);

    // 1. Try client-reported targets — trust the client's selection
    const identity = this.feedbackId ?? this.feedbackInputSeq ?? null;
    const report = identity !== null
      ? this.actor.hitReports?.get(String(identity))
      : null;
    if (report?.lines?.size) {
      const validTargets = [];
      const seenIds = new Set();
      for (const lineKey of report.lines.keys()) {
        const [targetId] = lineKey.split(":");
        if (seenIds.has(targetId)) continue;
        seenIds.add(targetId);
        const mob = this.mobs.find((m) => m.id === targetId);
        // Client-authoritative: trust the client's geometry check. Server only
        // validates that the mob exists and is attackable (alive, active, not faulted).
        // We deliberately skip overlaps() here — server physics may have drifted from
        // client render positions by the time playerImpact fires, causing false rejects.
        if (!mob || !this.canAttackMob(mob)) continue;
        validTargets.push(mob);
      }
      if (validTargets.length > 0) {
        validTargets.sort((a, b) => Math.abs(a.x - sim.x) - Math.abs(b.x - sim.x));
        for (let i = 0; i < validTargets.length; i++) {
          this.attackTargets[i] = validTargets[i];
          this.targetDistances[i] = Math.abs(validTargets[i].x - sim.x);
        }
        this.generateDamageLines(validTargets.length);
        this.mobHit.reportId = identity;
        for (let index = 0; index < validTargets.length; index++) {
          this.mobHit.critical = !!this.damageCritical[index];
          this.damageTarget(validTargets[index], this.damageLines[index]);
        }
        return;
      }
    }

    // 2. Fallback: original server-side selection (no client report or report invalid)
    const reactorHit = this.hooks.onStrike?.(this.attackBody, sim.facing, 0);
    const count = this.selectAttackTargets(this.attackInfo?.mobCount ?? 1);
    if (!count) {
      this.lastStatus = reactorHit
        ? "local reactor hit"
        : "local impact: no eligible original body";
      return;
    }
    this.generateDamageLines(count);
    this.mobHit.reportId = identity;
    for (let index = 0; index < count; index++) {
      this.mobHit.critical = !!this.damageCritical[index];
      this.damageTarget(this.attackTargets[index], this.damageLines[index]);
    }
  }

  damageTarget(
    target,
    generated,
    hit = this.mobHit,
    facing = this.simulation.facing,
  ) {
    target.damageOwnerId = this.actor.id;
    const line = Number.isSafeInteger(hit.line) ? hit.line : 0;
    // Client previews are telemetry only. Even a report for a real admitted attack
    // cannot select its damage or critical roll.
    const reported =
      hit.reportId === null || hit.reportId === undefined
        ? null
        : this.world.takeReportedDamage(this.actor, hit.reportId, target.id, {
            skillId: hit.skillId ?? 0,
            line,
          });
    if (reported) {
      this.world.damageWatchdog?.observe(
        this.actor.id,
        hit.skillId ?? 0,
        this.actor.field.tick,
        { reported: reported.damage, reference: generated },
      );
    }
    super.damageTarget(target, generated, hit, facing);
  }
  get hasPendingIncoming() {
    return this.incoming.length > 0;
  }

  captureIncomingSource(mob) {
    const status = mob.skillStatus;
    return {
      ...mob,
      incomingOrigin: mob,
      incomingGeneration: mob.deaths,
      incomingField: this.actor.field,
      body: { ...mob.body },
      sweptBody: { ...mob.sweptBody },
      attackBody: { ...mob.attackBody },
      aggro: { ...mob.aggro },
      skillStatus: {
        ...status,
        remaining: status.remaining.slice(),
        values: status.values.slice(),
        sources: status.sources.slice(),
        projected: { ...status.projected },
      },
    };
  }

  resolveIncomingSource(source) {
    const mob = source.incomingOrigin ?? source;
    if (source.incomingField && source.incomingField !== this.actor.field) {
      return null;
    }
    if (
      source.incomingGeneration !== undefined &&
      mob.deaths !== source.incomingGeneration
    ) {
      return null;
    }
    return mob.alive && mob.active && this.mobs.includes(mob) ? mob : null;
  }

  localHitBlocked() {
    return (
      this.destroyed ||
      this.actor.state !== "active" ||
      this.actor.retiring ||
      this.actor.deliveryError ||
      this.hasPendingIncoming ||
      this.actor.pending ||
      this.actor.skillTask
    );
  }

  proposeMobHit(mob, magic, action = null) {
    if (this.localHitBlocked()) return false;
    if (hasMobStatus(mob, "inert")) {
      if (mob.controllerOwnerId !== this.actor.id) return false;
      return super.proposeMobHit(mob, magic, action);
    }
    if (
      this.rejectsHit({ ...this.localHit, source: mob, attackAction: action })
    ) {
      return false;
    }
    const source = this.captureIncomingSource(mob);
    const admission = this.prepareMobHitAdmission(source, magic, action);
    // Rejected and MISS contacts have no private debit. Preserve the original scan,
    // including puppet/Guardian interception, rather than starving later contacts.
    if (!admission.admitted) return this.commitHitOutcome(admission);
    if (admission.hit.amount <= 0) {
      return this.commitHitOutcome(
        this.prepareHitOutcome(admission.hit, this.store.profile, admission),
      );
    }
    admission.impulse = this.prepareHitImpulse(admission.hit);
    this.incoming.push({ source, admission, field: this.actor.field });
    this.startIncoming();
    return true;
  }

  /** One authored proposal per shared mob plus the current fall/contact head.
   *  When preComputedOutcome is provided (Phase 4 RNG sync route A), it is used
   *  directly as the prepared outcome — one RNG roll = one truth, no re-roll. */
  acceptIncoming(source, magic, action, release = null, preComputedOutcome = null) {
    if (this.incoming.length >= this.mobs.length + 1) {
      throw protocolError("SERVER_BUSY");
    }
    const prepared = preComputedOutcome
      ? preComputedOutcome
      : hasMobStatus(source, "inert")
        ? this.prepareHypnotizedImpact(source, action)
        : null;
    this.incoming.push({
      source,
      magic,
      action,
      prepared,
      release,
      field: this.actor.field,
    });
    this.startIncoming();
    return true;
  }

  tryReceiveHit(hit) {
    if (this.hasPendingIncoming || this.rejectsHit(hit)) return false;
    this.incoming.push({ hit: { ...hit }, field: this.actor.field });
    this.startIncoming();
    return true;
  }

  startIncoming() {
    if (this.incomingTask) return;
    this.incomingTask = this.drainIncoming().finally(() => {
      this.incomingTask = null;
      this.world.participants.signalIdle();
    });
  }

  async drainIncoming() {
    while (this.incoming.length) {
      const proposal = this.incoming[0];
      let receipt = null;
      try {
        // A skill debit may release its SQL reservation before publishing its paid phase.
        if (this.actor.skillTask) {
          await Promise.allSettled([this.actor.skillTask]);
        }
        const operation = combatOperation(this.actor, "combat.incoming");
        let outcome = null;
        receipt = await this.world.participants.commitProduced(
          this.actor,
          operation,
          () => [this.actor.id],
          (drafts) => {
            outcome = this.prepareIncoming(proposal, drafts.get(this.actor.id));
            if (outcome.hit) outcome.hit.incomingId = operation.operationId;
            return {
              value: {
                kind: "combat.incoming",
                incomingId: operation.operationId,
              },
            };
          },
        );
        if (receipt.status !== "committed") {
          throw protocolError(receipt.code ?? "NOT_ALLOWED");
        }
        if (outcome && receipt.value?.incomingId === operation.operationId) {
          this.commitHitOutcome(outcome);
          syncActorEffects(this.actor, this.world);
          this.projectActor();
          this.actor.runtimeDirty = true;
        }
      } catch (error) {
        this.reportIncomingFailure(error, receipt);
      } finally {
        proposal.release?.();
        this.incoming.shift();
        this.world.participants.signalIdle();
      }
    }
  }

  reportIncomingFailure(error, receipt) {
    this.incomingFailure ??= error;
    this.actor.admission = error.code ?? error.message;
    if (receipt?.status === "committed") {
      this.world.deliveryFailed(this.actor, error);
    } else this.world.publish(this.actor, { type: "snapshot-request" });
  }
  prepareIncoming(proposal, profile) {
    if (
      this.destroyed ||
      this.actor.field !== proposal.field ||
      proposal.field.characters.get(this.actor.id) !== this.actor ||
      this.world.actors.get(this.actor.id) !== this.actor
    ) {
      throw protocolError("STALE_FIELD");
    }
    if (proposal.admission) {
      proposal.admission.profile = profile;
      return this.prepareHitOutcome(
        proposal.admission.hit,
        profile,
        proposal.admission,
      );
    }
    if (proposal.prepared) return proposal.prepared;
    return proposal.source
      ? this.prepareMobHit(
          proposal.source,
          proposal.magic,
          proposal.action,
          profile,
        )
      : this.prepareHitOutcome(proposal.hit, profile);
  }

  attackBlocked() {
    return (
      this.actor.state !== "active" ||
      this.actor.retiring ||
      this.actor.deliveryError ||
      this.hasPendingIncoming ||
      this.actor.skillTask ||
      this.store.profileTransactionPending ||
      this.phase !== "idle" ||
      this.dead
    );
  }

  beginAttack(prepared = false) {
    if (this.attackBlocked()) return;
    if (this.basicAttackError()) return;
    this.pendingAttackInputSeq =
      this.actor.combatInputSeq ?? this.actor.currentInputSeq ?? null;
    if (!prepared) {
      this.prepareWeaponUse(this.store.profile);
      if (this.weaponUse.ranged) this.probeMeleeTarget();
    }
    const ammunition = this.weaponUse.ammunition;
    const derived = this.actor.skills.derived();
    if (!ammunition || derived.soulArrow || derived.shadowStars) {
      super.beginAttack(true);
      return;
    }
    this.debitAmmunition(ammunition, derived);
  }

  debitAmmunition(ammunition, derived) {
    const operation = combatOperation(this.actor, "combat.ammunition");
    const field = this.actor.field;
    const uid = ammunition.uid;
    this.actor.skillTask = this.world.participants
      .commit(this.actor, operation, [this.actor.id], (drafts) => {
        admitActor(this.actor, this.world, field.epoch);
        const draft = drafts.get(this.actor.id);
        const item = draft.inventory.find((entry) => entry.uid === uid);
        if (!item || item.count < (derived.shadowPartner ? 2 : 1)) {
          throw new Error("Ammunition is no longer available");
        }
        this.store.draft = draft;
        this.weaponUse.ammunition = item;
        try {
          super.consumeAmmunition();
        } finally {
          this.store.draft = null;
        }
        return {
          value: { kind: "combat.debit", debitId: operation.operationId },
        };
      })
      .then((receipt) => {
        if (
          receipt.status !== "committed" ||
          receipt.value?.debitId !== operation.operationId
        ) {
          return;
        }
        if (this.actor.field !== field || this.dead || this.destroyed) return;
        this.paidAmmunition = true;
        super.beginAttack(true);
      })
      .catch((error) => {
        this.actor.admission = error.code ?? error.message;
      })
      .finally(() => {
        this.actor.skillTask = null;
      });
  }
  consumeAmmunition() {
    if (this.paidAmmunition) {
      this.paidAmmunition = false;
      return;
    }
    if (
      this.weaponUse.ammunition &&
      !this.actor.skills.derived().soulArrow &&
      !this.actor.skills.derived().shadowStars
    ) {
      throw new Error("Ammunition impact requires a committed debit");
    }
    super.consumeAmmunition();
  }
  onKill(mob, showdown = 0) {
    if (mob.rewardGeneration === mob.deaths) return;
    const defeated = {
      ...mob,
      ...captureKillDropRates(this.world, this.actor, mob),
      expAmount: this.killExperience(mob, showdown),
      showdown,
    };
    defeated.creditPlan = planKillCredit(this.world, this.actor, defeated);
    mob.rewardGeneration = mob.deaths;
    const task = this.rewardTail.then(() =>
      rewardKill(this.world, this.actor, defeated, showdown),
    );
    this.rewardTail = task.catch((error) => {
      this.actor.admission = error.code ?? error.message;
    });
    this.rewardJobs.add(task);
    task
      .catch((error) => {
        this.actor.admission = error.code ?? error.message;
        this.world.publish(this.actor, { type: "snapshot-request" });
      })
      .finally(() => this.rewardJobs.delete(task));
  }
  stepActor(ms, input) {
    if (
      this.destroyed ||
      this.actor.state !== "active" ||
      this.actor.retiring ||
      this.actor.deliveryError ||
      this.hasPendingIncoming ||
      this.store.profileTransactionPending ||
      this.actor.skillTask
    ) {
      return;
    }
    const edge = takeAttackInput(this.actor, this.phase === "idle");
    this.wasAttack = Boolean(input.attack);
    this.phaseMs += ms;
    updateHitboxes(this.hitboxes, this.simulation, this.receiverContext);
    this.stepProjectiles(ms);
    this.skillCombat.step(ms);
    this.diseases.step(ms);
    this.receiveFallLanding();
    if (this.hasPendingIncoming) return;
    this.stepPlayer(edge, input);
  }

  /** Shared authored areas run after outgoing impacts and before ordinary contact, as offline. */
  finishActor(ms) {
    if (
      this.destroyed ||
      this.actor.state !== "active" ||
      this.actor.retiring ||
      this.actor.deliveryError ||
      this.hasPendingIncoming ||
      this.store.profileTransactionPending ||
      this.actor.skillTask
    ) {
      return;
    }
    if (!this.dead) this.contactDamage();
    if (this.hasPendingIncoming) return;
    this.advanceAlert();
    this.advanceHitPresentation();
    if (this.recovery.step(ms, this.action ?? this.simulation.action)) {
      this.changed();
    }
    this.simulation.movementLocked = this.blocksMovement;
    this.presentActor(ms);
    this.actor.skills.present(ms);
    this.projectActor();
  }
  presentActor(ms) {
    const action = avatarAction(
      this.scene.actor,
      this.action ?? this.simulation.action,
    );
    this.scene.actor.setAction(action, this.playback);
    this.scene.actor.holdFrame =
      this.phase === "idle" &&
      this.simulation.state === "ladder" &&
      this.simulation.y === this.simulation.previousY;
    this.scene.actor.advance(ms);
    if (this.phase !== "idle") {
      this.scene.actor.seek(
        this.phase === "attack" ? this.attackAnimationMs : this.phaseMs,
      );
    }
    this.scene.actor.setPosition(this.simulation.x, this.simulation.y);
    const pose = this.scene.presentation;
    this.scene.actor.container.scale.x = this.simulation.facing > 0 ? -1 : 1;
    this.scene.actor.container.alpha = this.actor.skills.derived().darkSight
      ? 128 / 255
      : 1;
    this.scene.actor.container.zIndex =
      29997 +
      (this.simulation.contactLayer * 3000 - this.simulation.contactGroup) * 10;
    pose.x = this.simulation.x;
    pose.y = this.simulation.y;
    pose.facing = this.simulation.facing;
    pose.action = action;
    pose.playback = this.playback;
  }
  projectActor() {
    const actor = this.actor;
    actor.attackState.active = this.phase === "attack" || this.phase === "hold";
    actor.attackState.action = this.action ?? actor.simulation.action;
    actor.attackState.skillId = this.attackSkill?.id ?? null;
    actor.attackState.rank = this.attackSkill
      ? actor.skills.level(this.attackSkill.id)
      : null;
    actor.castAction = this.phase === "cast" ? this.action : null;
    actor.castUntil =
      this.phase === "cast"
        ? this.world.now + Math.max(0, this.attackDurationMs - this.phaseMs)
        : 0;
    const state = actor.combatPresentation;
    this.projectModifiers(state.modifiers);
    state.feedbackId = this.feedbackId ?? null;
    state.inputSeq = this.feedbackInputSeq ?? null;
    state.phase = this.phase;
    state.elapsedMs =
      this.phase === "attack" ? this.attackAnimationMs : this.phaseMs;
    state.phaseMs = this.phaseMs;
    state.attackSpeed = this.attackSpeed;
    state.protectionMs = this.hitTimerMs;
    state.tint = this.blinkTint;
    state.braceMs = this.alertTimerMs;
    state.recoil = this.lastKnockback;
    state.expression = this.scene.actor.expressionMs
      ? this.scene.actor.expression
      : "default";
    state.expressionMs = this.scene.actor.expressionMs;
    state.movementLocked = this.blocksMovement;
    state.opacity = this.scene.actor.container.alpha;
    state.actorVisible = this.scene.actor.container.renderable;
    actor.alertUntil = this.world.now + this.alertTimerMs;
  }
  destroy() {
    this.destroyed = true;
    this.aranInput.clear();
    this.skillCombat.clear();
    this.diseases.clear();
    this.simulation.movementLocked = false;
  }
  projectModifiers(target) {
    const derived = this.actor.skills.derived();
    target.booster = derived.booster ?? 0;
    target.speedInfusion = derived.speedInfusion ?? 0;
    target.soulArrow = Boolean(derived.soulArrow);
    target.shadowStars = Boolean(derived.shadowStars);
    target.infinity = Boolean(derived.infinity);
    target.concentrate = derived.concentrate ?? 0;
    target.shadowPartner = Boolean(derived.shadowPartner);
  }
}
