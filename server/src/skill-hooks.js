import { combatOperation } from "./combat-rewards.js";
import { recordMotionDivert } from "./field-diverts.js";
import { familyRate } from "./social-family.js";
import { MOB_STATUS } from "../../client/src/combat/mob-skill-status.js";
import { incomingElementCode } from "../../client/src/skills/skill-defenses.js";
import { syncSkillDiseases } from "./skill-durable-state.js";
import { recordKillDamage } from "./kill-credit.js";

export function emitCombat(world, actor, event, privateEvent = false) {
  const message = { type: "event", fieldEpoch: actor.field.epoch, event };
  if (privateEvent) world.publish(actor, message);
  else world.broadcast(actor.field, message);
}

function impact(context, target, amount, hit = null) {
  const { world, actor } = context;
  const skillId = hit?.skillId ?? 0;
  emitCombat(world, actor, {
    kind: "combat.impact",
    actorId: actor.id,
    targetId: target.id,
    actionId: actor.skillField.actionId ?? actor.id,
    cause: skillId ? "skill" : "basic",
    skillId,
    rank: skillId ? actor.skills.level(skillId) : 0,
    damage: Math.max(0, Math.trunc(amount)),
    hpDamage: impactHpDamage(hit, amount),
    mpDamage: 0,
    mesoDamage: 0,
    line: hit?.line ?? 0,
    critical: hit?.critical ?? false,
    lethal: !target.alive,
    attackAction: null,
    element: 0,
    position: { x: target.x, y: target.y },
  });
}

function impactHpDamage(hit, amount) {
  return Math.max(0, Math.trunc(hit?.hpDamage ?? amount));
}

export function createCombatHooks(world, actor) {
  const context = { world, actor };
  return {
    rebind(next) {
      context.actor = next;
    },
    ...combatAdmissionHooks(context),
    ...skillControllerHooks(context),
    ...combatPublicationHooks(context),
  };
}

function combatAdmissionHooks(context) {
  const { world, actor } = context;
  const skill = () => context.actor.skills;
  return {
    onMobDamage: (mob, amount) => recordKillDamage(context.actor, mob, amount),
    onMobStatus: (mob, id) => claimMobController(context.actor, mob, id),
    // A server-owned knockback is published as a divert so the client merges the exact
    // vector into its own kernel; the browser owns the resulting trajectory.
    onExternalImpulse: (simulation, vx, vy, hit) =>
      recordMotionDivert(context.actor, simulation, {
        vx,
        vy,
        source: "hit",
        skillId: 0,
        sourceId: hit.source?.id,
      }),
    mobs: actor.field.mobs,
    authoritativePartyHealing: true,
    renderer: null,
    random: world.random,
    nextUint32: world.nextUint32,
    items: world.content.items,
    mobSkills: world.content.catalog.ui.skillCombat.mobSkills,
    skillLevel: (id) => skill().level(id),
    skillInfo: (id, rank) => skill().info(id, rank),
    // Phase 5 (contact RNG sync): OfflineField.admitIncomingHit calls this before
    // rolling its own RNG for bodyAttack contact. Returns the client-reported damage
    // (validated by world.recordContact) or undefined to fall through to local roll.
    checkContactReport: (mobId) => {
      const cache = context.actor.contactReports;
      if (!cache) return undefined;
      const entry = cache.get(String(mobId));
      if (!entry) return undefined;
      // Expire entries older than one field tick — contact damage must be tight.
      if (context.actor.field.tick - entry.tick > 1) {
        cache.delete(String(mobId));
        return undefined;
      }
      cache.delete(String(mobId));
      return entry.damage;
    },
    activateSkill: (id) => activateCombatSkill(context, id),
    growth: () => skill().growth(),
    derivedStats: () => skill().derived(),
    experienceRate: () => familyRate(context.actor.profile, "exp", world.now),
    resolveIncomingSource: (source) =>
      context.actor.skillField.resolveIncomingSource(source),
    drops: () => context.actor.skillDrops,
    canStrike: (rectangle, facing, skillId) =>
      world.canStrikeReactor(context.actor, { rectangle, facing, skillId }),
    onStrike: (rectangle, facing, skillId) =>
      world.strikeReactor(context.actor, { rectangle, facing, skillId }),
    projectileAdmissionError: (count) =>
      count <= 120 ? null : "Projectile capacity exceeded",
  };
}

async function activateCombatSkill(context, id) {
  try {
    const receipt = await context.world.cast(
      context.actor,
      { skillId: id },
      combatOperation(context.actor, "skill.cast"),
    );
    return { ok: receipt.status === "committed" };
  } catch (error) {
    context.actor.admission = error.code ?? error.message;
    return { ok: false };
  }
}

function skillControllerHooks(context) {
  const skill = () => context.actor.skills;
  return {
    setSkillStateValue: (id, key, value) =>
      skill().stateController.setValue(id, key, value),
    cancelSkillFamily: (family) => skill().stateController.cancelFamily(family),
    transformed: () => Boolean(skill().worldController.forms.current),
    worldSkillActive: (id) => skill().worldController.active(id),
    onSkillHit: (id, target) => skill().hit(id, target),
    onSkillProjectile: (shot) => skill().combatController.projectile(shot),
    skillTargetController: () => skill().combatController.targets,
    resolveSkillId: (id) => skill().activationId(id),
    eventSkillError: (entry) => skill().utilityController.events.error(entry),
    consumeEventSkill: (entry) =>
      skill().utilityController.events.consume(entry),
    onEventAttack: (entry, target, sequence) =>
      skill().utilityController.events.onAttack(entry, target, sequence),
    onEventDamage: () => skill().utilityController.events.onDamage(),
    chakraDamagePercent: () => skill().utilityController.chakraDamagePercent(),
    interruptChakra: () => skill().utilityController.interruptChakra(),
    targetFor: (mob, target) => skill().worldController.targetFor(mob, target),
    interceptContact: (mob, action, outcome) =>
      skill().worldController.interceptContact(mob, action, outcome),
    protects: (x, y) => skill().worldController.protects(x, y),
    damageForm: (amount) => skill().worldController.damageForm(amount),
    absorbDamage: (amount, profile, outcome) =>
      skill().absorbDamage(amount, profile, outcome),
  };
}

function combatPublicationHooks(context) {
  const { world } = context;
  return {
    onSkillDamageLine: (target, amount, hit) =>
      impact(context, target, amount, hit),
    onMobHit: (target, amount, hit) => impact(context, target, amount, hit),
    onMagnetResult: (target, success) =>
      emitCombat(world, context.actor, {
        kind: "skill.magnet",
        actorId: context.actor.id,
        targetId: target.id,
        success,
      }),
    onAttack: (sfx) =>
      emitCombat(world, context.actor, {
        kind: "combat.attack",
        actorId: context.actor.id,
        feedbackId: context.actor.skillField.feedbackId ?? null,
        inputSeq: context.actor.skillField.feedbackInputSeq ?? null,
        templateId: null,
        action: context.actor.skillField.attackName,
        weaponSfx: sfx ?? null,
      }),
    onMobAttack: (mob) =>
      emitCombat(world, context.actor, {
        kind: "combat.attack",
        actorId: mob.id,
        templateId: mob.templateId,
        action: mob.action,
        weaponSfx: null,
      }),
    onProjectile: (shot) => projectile(world, context.actor, shot),
    onPlayerHit: (hit) => playerHit(world, context.actor, hit),
    onPlayerDeath: () => death(world, context.actor),
    onRecovery: (amount) =>
      emitCombat(
        world,
        context.actor,
        {
          kind: "combat.recovery",
          actorId: context.actor.id,
          hp: amount,
          mp: 0,
        },
        true,
      ),
    onDisease: (id, duration) => {
      syncSkillDiseases(context.actor, world.now);
      emitCombat(world, context.actor, {
        kind: "combat.disease",
        actorId: context.actor.id,
        diseaseId: id,
        durationMs: duration,
      });
    },
  };
}

function claimMobController(actor, mob, id) {
  mob.statusOwners ??= [];
  for (const index of Object.values(MOB_STATUS)) {
    if (
      mob.skillStatus.remaining[index] > 0 &&
      mob.skillStatus.sources[index] === id
    ) {
      mob.statusOwners[index] = {
        actorId: actor.id,
        skillId: id,
        generation: mob.deaths,
      };
    }
  }
  if (id !== 2311005 && id !== 5221009) return;
  const previous = actor.field.characters.get(mob.controllerOwnerId);
  if (previous && previous !== actor && mob.controllerState?.body) {
    previous.skills.combatController.targets.endForm(mob.controllerState);
  }
  mob.controllerOwnerId = actor.id;
}

function playerHit(world, actor, hit) {
  emitCombat(world, actor, {
    kind: "combat.impact",
    actorId: hit.source?.id ?? actor.id,
    targetId: actor.id,
    actionId:
      hit.incomingId ?? combatOperation(actor, "combat.hit").operationId,
    cause: hit.source ? (hit.attackAction ? "mob-attack" : "contact") : "fall",
    skillId: 0,
    rank: 0,
    damage: Math.max(0, hit.amount),
    hpDamage: hit.hpDamage,
    mpDamage: hit.mpDamage ?? 0,
    mesoDamage: hit.mesoDamage ?? 0,
    line: 0,
    critical: false,
    knockback: actor.skillField.lastKnockback === "ordinary",
    lethal: actor.profile.hp === 0,
    attackAction: hit.attackAction,
    element: incomingElementCode(hit.element),
    position: { x: actor.simulation.x, y: actor.simulation.y },
  });
}

function projectile(world, actor, shot) {
  emitCombat(world, actor, {
    kind: "projectile",
    feedbackId:
      shot.feedbackId === undefined
        ? (actor.skillField.feedbackId ?? null)
        : shot.feedbackId,
    inputSeq:
      shot.inputSeq === undefined
        ? (actor.skillField.feedbackInputSeq ?? null)
        : shot.inputSeq,
    actorId: actor.id,
    actionId: actor.skillField.actionId ?? actor.id,
    skillId: shot.skill?.id ?? null,
    rank: shot.skill ? shot.rank : null,
    templateId: shot.projectileId,
    targetId: shot.target?.id ?? actor.id,
    launchTick: actor.field.tick,
    source: { x: shot.x, y: shot.y },
    destination: { x: shot.endX, y: shot.endY },
    durationMs: shot.duration,
    facing: shot.facing,
  });
}

export function death(world, actor) {
  actor.skills.onDeath();
  actor.skillRelease = null;
  actor.profile.onlineState.effects.length = 0;
  actor.skillGeneration++;
  actor.skillField.diseases.clear();
  actor.skillField.phase = "dead";
  actor.attackState.active = false;
  actor.castUntil = 0;
  world.clearActorSeat?.(actor);
  emitCombat(world, actor, { kind: "combat.death", actorId: actor.id });
}
