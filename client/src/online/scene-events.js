import { GameplayEffects } from "../audio/gameplay-effects.js";
import { CombatPresentation } from "../combat/combat-presentation.js";
import { SpeechBubbles } from "../rendering/speech-bubbles.js";

const MAX_PROJECTILE_EVENTS = 1024;
const PROJECTILE_EVENT_LIFETIME = 10000;
/** Field-owned consumers of accepted events; no damage or delivery is predicted. */
export class SceneEvents {
  constructor(owner, app) {
    this.owner = owner;
    this.app = app;
    this.combat = new CombatPresentation(app, owner.services);
    this.combat.setScene(owner.scene);
    this.speech = new Map();
    this.speechMessages = new Map();
    this.seenChat = new Set();
    this.pose = { x: 0, headY: 0 };
    this.projectiles = new Map();
    this.projectileCount = 0;
    this.enchant = new GameplayEffects(owner.services);
  }

  async prepare(signal) {
    const catalog = this.owner.catalog;
    await this.combat.prepare(
      catalog.audiovisual,
      signal,
      catalog.ui.avatar.projectiles,
    );
    await this.enchant.prepare(catalog.audiovisual, signal, [
      "Enchant/Success",
      "Enchant/Failure",
    ]);
    await this.prepareSpeech(this.owner.selfId);
  }

  async event(message) {
    const event = message.event;
    if (event.kind === "equipment.enhancement") this.enhancement(event);
    else if (event.kind === "combat.impact") this.damage(event);
    else if (event.kind === "projectile") this.projectile(event);
    else if (event.kind === "drop.pickup") this.owner.drops.pickup(event);
    else if (event.kind === "drop.explode") this.owner.drops.explode(event);
    else if (event.kind === "combat.recovery" || event.kind === "drop.effect") {
      this.recovery(event);
    } else if (event.kind === "skill.magnet") {
      const view = this.owner.views.get(event.targetId);
      if (view) this.combat.onMagnetResult(this.target(view), event.success);
    } else if (event.kind === "chat" && event.channel === "map") {
      await this.chat(event);
    } else if (event.kind === "combat.incoming-preview") {
      this.incomingPreview(event);
    }
  }

  enhancement(event) {
    const view = this.owner.views.get(event.actorId);
    if (view) {
      this.enchant.play(
        event.outcome === "success" ? "Enchant/Success" : "Enchant/Failure",
        this.owner.scene,
        this.target(view),
      );
    }
  }

  projectile(event) {
    if (this.projectileCount >= MAX_PROJECTILE_EVENTS) {
      throw new Error("Online projectile event residency limit");
    }
    if (!this.owner.localCombat?.projectiles.ammunitionEcho(event)) {
      this.combat.onProjectile({
        projectileId: event.templateId,
        facing: event.facing,
        x: event.source.x,
        y: event.source.y,
        endX: event.destination.x,
        endY: event.destination.y,
        duration: event.durationMs,
        target: null,
      });
    }
    let action = this.projectiles.get(event.actionId);
    if (!action) {
      action = new Map();
      this.projectiles.set(event.actionId, action);
    }
    if (!action.has(event.targetId)) this.projectileCount++;
    action.set(event.targetId, { event, age: 0 });
  }

  impact(event, hit) {
    const action = this.projectiles.get(event.actionId);
    const projectile = action?.get(hit.targetId);
    if (!projectile) return;
    action.delete(hit.targetId);
    this.projectileCount--;
    if (!action.size) this.projectiles.delete(event.actionId);
    if (hit.outcome === "hit") {
      this.combat.onProjectileImpact(
        projectile.event.templateId,
        projectile.event.destination,
        projectile.event.facing,
      );
    }
  }

  target(view) {
    if (!view.combatTarget) {
      view.combatTarget = {
        get x() {
          return view.drawX;
        },
        get y() {
          return view.drawY;
        },
        get presentation() {
          return view.animation;
        },
      };
    }
    return view.combatTarget;
  }
  reserveNumber() {
    const numbers = this.combat.snapshot();
    const required = numbers.active + numbers.pending + 1;
    if (required > numbers.hardCapacity) {
      throw new Error("Online confirmed damage number residency limit");
    }
    if (required > numbers.capacity) this.combat.growNumbers(required);
  }
  damage(event) {
    this.impact(event, {
      targetId: event.targetId,
      outcome: event.damage > 0 ? "hit" : "miss",
    });
    const combat = this.owner.localCombat;
    // consumeImpact returns true when a local prediction already rendered digits
    // for this event (LocalHits for outgoing, LocalIncoming for incoming).
    const consumed = combat ? combat.consumeImpact(event) : false;
    // Hard direction guard: ONLY outgoing impacts may render through the onMobHit
    // path. Incoming impacts (mob→player) must NEVER call onMobHit — that paints
    // the yellow mob-hit glyph onto the player. Incoming digits are LocalIncoming's
    // sole responsibility.
    const incomingCause = event.cause === "mob-attack" || event.cause === "contact" || event.cause === "fall";
    if (!consumed && !incomingCause && event.damage > 0) {
      const view = this.owner.views.get(event.targetId);
      if (view) {
        this.reserveNumber();
        const target = this.target(view);
        if (event.skillId > 0) {
          this.combat.onSkillDamageLine(target, event.damage, {
            line: event.line ?? 0,
            critical: event.critical,
            skillId: event.skillId,
          });
        } else {
          this.combat.onMobHit(target, event.damage, event.critical);
        }
      }
    } else if (!consumed && incomingCause && event.targetId === this.owner.scene?.selfId && event.damage > 0) {
      // Incoming impact with no matching local prediction — likely a client/server
      // overlap race (mob walking: client tick N just missed overlap, server tick N+1
      // caught it → HP deducted but no number rendered). Fall back to LocalIncoming's
      // present path so the user sees the damage they actually took.
      combat?.incoming?.fallbackPresent(event.damage, event.actorId);
    }
  }
  /** Phase 4 (RNG sync route A): store server-authoritative incoming damage
   *  previews so LocalIncoming can render using the server's RNG roll instead
   *  of its own divergent local roll. */
  incomingPreview(event) {
    const incoming = this.owner.localCombat?.incoming;
    if (!incoming) return;
    incoming.ingestPreview(event.mobId, event.attackAction, event.previews);
  }
  recovery(event) {
    if (event.hp <= 0) return;
    const view = this.owner.views.get(event.actorId);
    if (!view) return;
    this.reserveNumber();
    const geometry = view.animation.current.geometry[view.animation.frame];
    this.combat.show(
      event.hp,
      1,
      this.combat.fixedNumberPlacement(view.drawX, view.drawY + geometry.y),
    );
  }

  async chat(event) {
    const view = this.owner.views.get(event.senderId);
    if (!view?.entity.appearance) return;
    const key = `${event.senderId}:${event.messageId}`;
    if (this.seenChat.has(key)) return;
    if (this.seenChat.size >= 128) {
      this.seenChat.delete(this.seenChat.values().next().value);
    }
    this.seenChat.add(key);
    this.speechMessages.set(event.senderId, event.messageId);
    const prepared = this.speech.get(event.senderId);
    const speech = prepared?.resource
      ? prepared
      : await this.prepareSpeech(event.senderId);
    if (this.speechMessages.get(event.senderId) === event.messageId) {
      speech.show(event.text, event.senderName);
    }
  }
  async prepareSpeech(senderId) {
    let speech = this.speech.get(senderId);
    if (!speech) {
      speech = new SpeechBubbles(this.app, this.owner.services);
      speech.setScene(this.owner.scene);
      this.speech.set(senderId, speech);
      speech.pending = speech.prepare(
        this.owner.catalog,
        this.owner.controller.signal,
      );
    }
    try {
      await speech.pending;
      this.owner.controller.signal.throwIfAborted();
      return speech;
    } catch (error) {
      speech.destroy();
      if (this.speech.get(senderId) === speech) this.speech.delete(senderId);
      throw error;
    }
  }
  rejectChat(senderId, messageId) {
    if (this.speechMessages.get(senderId) !== messageId) return;
    this.speechMessages.delete(senderId);
    const speech = this.speech.get(senderId);
    if (speech) {
      speech.root.visible = false;
      speech.remainingMs = -1;
    }
  }

  draw(elapsed) {
    this.combat.update(elapsed);
    this.enchant.update(elapsed);
    this.expireProjectiles(elapsed);
    for (const [id, speech] of this.speech) {
      const animation = this.owner.views.get(id)?.animation;
      if (!animation) {
        speech.destroy();
        this.speech.delete(id);
        continue;
      }
      this.pose.x = animation.baseX;
      this.pose.headY =
        animation.baseY - animation.avatar.speechHeights[animation.action];
      speech.update(elapsed, this.pose, this.owner.scene.camera);
    }
  }

  expireProjectiles(elapsed) {
    for (const [id, action] of this.projectiles) {
      for (const [target, projectile] of action) {
        projectile.age += elapsed;
        if (projectile.age < PROJECTILE_EVENT_LIFETIME) continue;
        action.delete(target);
        this.projectileCount--;
      }
      if (!action.size) this.projectiles.delete(id);
    }
  }

  destroy() {
    this.combat.destroy();
    this.enchant.destroy();
    for (const speech of this.speech.values()) speech.destroy();
    this.speech.clear();
    this.speechMessages.clear();
    this.seenChat.clear();
    this.projectiles.clear();
  }
}
