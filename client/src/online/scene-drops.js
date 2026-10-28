import { centerDrop } from "../world/drop-artwork.js";
import { collectDrop, dropDrawY, DROP_MOTION } from "../world/drop-motion.js";
import { DROP_POLICY } from "../world/drop-rules.js";
import { DROP_OWNER_MS } from "../../../shared/drop-protocol.js";

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
 *  Unlike pickupOwnerAllows (which compares server-side ownerUntil with the
 *  caller's wall clock), this uses a motionNow-based countdown so that two
 *  clients with drifting wall-clocks always agree with the server's pickup
 *  permission window — they each start their local countdown from the moment
 *  they first observe the drop, using DROP_OWNER_MS from shared constants. */
function dropVisibleTo(info, dropId, selfId, motionNow, clientOwnerExpires) {
  // Party info not wired through OnlineScene yet — simplified identity means
  // party members' drops in the claim window also hide. Revisit if needed.
  // playerDrop = true means the item was thrown by a player (not from a mob
  // kill or reactor), and the server grants zero protection — all players on
  // the field see it immediately.
  if (!info.ownerId || info.ownerId === selfId || info.playerDrop) return true;
  // No client-side expiry recorded yet: drop is freshly observed — start
  // the countdown from the current motionNow.
  let expiresAt = clientOwnerExpires.get(dropId);
  if (expiresAt === undefined) {
    expiresAt = motionNow + DROP_OWNER_MS;
    clientOwnerExpires.set(dropId, expiresAt);
  }
  return motionNow >= expiresAt;
}

/** Retains display ownership after a server-confirmed pickup, never inventory ownership. */
export class SceneDrops {
  constructor(owner) {
    this.owner = owner;
    this.pickups = new Map();
    this._ownerExpires = new Map(); // dropId → motionNow-based expiry timestamp
  }

  remove(dropId) {
    this._ownerExpires.delete(dropId);
  }

  observe(view) {
    const info = view.entity.dropInfo;
    const motion = view.motion;
    const motionNow = this.owner.motionNow;
    const baseVisible =
      motion.visible && dropVisibleTo(info, view.entity.id, this.owner.selfId, motionNow, this._ownerExpires);
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
