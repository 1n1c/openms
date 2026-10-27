import { centerDrop } from "../world/drop-artwork.js";
import { collectDrop, dropDrawY, DROP_MOTION } from "../world/drop-motion.js";
import { DROP_POLICY } from "../world/drop-rules.js";

const MAX_PICKUP_PRESENTATIONS = 4096;

/** Native keyboard proposal uses grounded packet coordinates; the server reruns every admission. */
export function nearestPickupDrop(entities, position, identity, now) {
  let nearest = null;
  let distance = Infinity;
  for (const entity of entities) {
    const info = entity.dropInfo;
    const motion = entity.dropMotion;
    if (
      entity.kind !== "drop" ||
      !info ||
      motion?.state !== "grounded" ||
      info.disappearing ||
      info.expiresAt <= now
    ) {
      continue;
    }
    if (!pickupOwnerAllows(info, identity, now)) continue;
    const dx = motion.groundX - position.x;
    const dy = motion.groundY - position.y;
    if (
      Math.abs(dx) > DROP_POLICY.pickupX ||
      Math.abs(dy) > DROP_POLICY.pickupY
    ) {
      continue;
    }
    const next = dx * dx + dy * dy;
    if (next < distance) {
      distance = next;
      nearest = entity;
    }
  }
  return nearest;
}

function pickupOwnerAllows(info, identity, now) {
  return !(
    info.ownerId &&
    info.ownerId !== identity.id &&
    info.ownerUntil > now &&
    (!identity.partyId || info.ownerPartyId !== identity.partyId) &&
    !identity.partyMembers?.includes(info.ownerId)
  );
}

/** Returns true if this drop should render for the current client.
 *  Uses the same ownership guard as pickup — drops outside the pickup window
 *  (another player claimed it and the claim hasn't expired) are hidden. */
function dropVisibleTo(info, selfId, now) {
  // Party info not wired through OnlineScene yet — simplified identity means
  // party members' drops in the claim window also hide. Revisit if needed.
  const identity = { id: selfId, partyId: null, partyMembers: [] };
  return pickupOwnerAllows(info, identity, now);
}

/** Retains display ownership after a server-confirmed pickup, never inventory ownership. */
export class SceneDrops {
  constructor(owner) {
    this.owner = owner;
    this.pickups = new Map();
  }

  observe(view) {
    const info = view.entity.dropInfo;
    const motion = view.motion;
    const baseVisible = motion.visible && dropVisibleTo(info, this.owner.selfId, Date.now());
    const animation = view.animation;
    animation.container.visible = baseVisible;
    animation.container.rotation = motion.rotation;
    animation.container.alpha = motion.alpha;
    animation.container.eventMode = info.disappearing
      ? "none"
      : "static";
    animation.setPosition(motion.x, motion.renderY(centerDrop(animation)));
  }

  pickup(event) {
    if (this.pickups.has(event.dropId)) return;
    const view = this.owner.views.get(event.dropId);
    const target = this.owner.views.get(event.actorId);
    if (!view || !target || view.entity.kind !== "drop") return;
    if (this.pickups.size >= MAX_PICKUP_PRESENTATIONS) {
      throw new Error("Online pickup presentation residency limit");
    }
    this.owner.views.delete(event.dropId);
    view.animation.gameplayOwned = true;
    view.animation.container.eventMode = "none";
    view.animation.container.rotation = 0;
    this.pickups.set(event.dropId, {
      view,
      actorId: event.actorId,
      state: "collecting",
      phaseAge: 0,
      sourceX: event.position.x,
      sourceY: event.position.y,
      target: { x: target.drawX, y: target.drawY },
      targetHeight:
        target.animation.current.geometry[target.animation.frame].height,
      x: event.position.x,
      y: event.position.y,
      alpha: 1,
    });
  }

  explode(event) {
    for (const id of event.dropIds) this.owner.remove(id);
  }

  draw(elapsed) {
    for (const [id, slot] of this.pickups) {
      const target = this.owner.views.get(slot.actorId);
      slot.phaseAge += elapsed;
      if (!target || slot.phaseAge >= DROP_MOTION.pickupMs) {
        this.release(id, slot);
        continue;
      }
      slot.target.x = target.drawX;
      slot.target.y = target.drawY;
      slot.targetHeight =
        target.animation.current.geometry[target.animation.frame].height;
      collectDrop(slot);
      const animation = slot.view.animation;
      animation.advance(elapsed);
      animation.setPosition(slot.x, dropDrawY(slot, centerDrop(animation)));
      animation.container.alpha = slot.alpha;
    }
  }

  release(id, slot) {
    this.owner.scene.removeDynamicEntity(id);
    slot.view.owner.destroy();
    this.pickups.delete(id);
  }

  destroy() {
    for (const [id, slot] of this.pickups) this.release(id, slot);
  }
}
