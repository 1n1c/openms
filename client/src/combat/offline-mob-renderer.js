import { Graphics, Text } from "pixi.js";
import { EntityAnimation } from "../rendering/animation.js";
import { VisualTextures } from "../rendering/visual-resources.js";
import { entities } from "../rendering/stream-validation.js";
import { check } from "../rendering/stream-network.js";
import { mobFlipped } from "./mob-movement-metadata.js";

const MAX_PENDING_TEMPLATES = 2;
const PREFETCH_VIEWPORTS = 0.5;

/** Debug mob HP bar — mirrors sdlMS gauge_render_system layout:
 *  fixed 50×8 outer frame, 44×4 inner fill inset by 3px on each side.
 *  Two-layer fill: red = lerp-delayed (slow drain), green = actual hp (instant).
 *  The gap between red and green fills gives the "slowly draining after hit" effect.
 *  Hidden when full or dead. */
const GAUGE_OUTER_W = 50;
const GAUGE_OUTER_H = 8;
const GAUGE_INSET = 3;
const GAUGE_INNER_H = GAUGE_OUTER_H - GAUGE_INSET * 2; // 4
const GAUGE_LERP_RATE = 0.06; // SDLMS uses 0.03 per frame; we lerp per draw call

export function createMobHpBar() {
  const bar = new Graphics();
  bar.eventMode = "none";
  bar.hitArea = null;
  bar.width = GAUGE_OUTER_W;
  bar.height = GAUGE_OUTER_H;
  bar._percentDisplayed = 1; // lerp target; starts full
  return bar;
}

/** Draw with sdlMS slow-drain: green = actual hp, red = lerp-delayed hp.
 *  All rects drawn centered at x=0 so position.x=0 aligns with mob center. */
export function drawMobHpBar(bar, hp, maxHP) {
  bar.clear();
  if (!maxHP || !hp || hp <= 0 || hp >= maxHP) {
    // Full or dead — reset lerp state and hide
    bar._percentDisplayed = hp && maxHP ? hp / maxHP : 1;
    bar.visible = false;
    return;
  }
  bar.visible = true;
  const actual = hp / maxHP;
  // Lerp delayed percent toward actual (sdlMS style slow drain)
  bar._percentDisplayed = actual + (bar._percentDisplayed - actual) * (1 - GAUGE_LERP_RATE);
  if (Math.abs(bar._percentDisplayed - actual) < 0.002) bar._percentDisplayed = actual;

  const innerW = GAUGE_OUTER_W - GAUGE_INSET * 2; // 44
  const cx = -GAUGE_OUTER_W / 2; // center the gauge at x=0 of its parent

  // Outer frame
  bar.roundRect(cx, 0, GAUGE_OUTER_W, GAUGE_OUTER_H, 1.5).fill({ color: 0x1a1a1a, alpha: 0.85 });
  // Red delayed fill (behind) — width shrinks slowly after hit
  const delayedW = Math.round(innerW * bar._percentDisplayed);
  if (delayedW > 0) {
    bar.rect(cx + GAUGE_INSET, GAUGE_INSET, delayedW, GAUGE_INNER_H).fill(0xff3333);
  }
  // Green actual fill (front) — instant
  const actualW = Math.round(innerW * actual);
  if (actualW > 0) {
    const fillColor = actual > 0.5 ? 0x4dd24d : actual > 0.25 ? 0xffaa33 : 0xff4444;
    bar.rect(cx + GAUGE_INSET, GAUGE_INSET, actualW, GAUGE_INNER_H).fill(fillColor);
  }
  // Border
  bar.roundRect(cx, 0, GAUGE_OUTER_W, GAUGE_OUTER_H, 1.5).stroke({ color: 0x000000, width: 1 });
}

export function createMobNameLabel(name) {
  const label = new Text({
    text: name ?? "",
    style: {
      fontFamily: "sans-serif",
      fontSize: 12,
      fill: 0xffffa0,
      align: "center",
      stroke: { color: 0x15202b, width: 3 },
    },
  });
  label.anchor.set(0.5, 0);
  label.eventMode = "none";
  return label;
}

/** Gameplay lives in mobs; this owner may discard/reacquire only presentation. */
export class OfflineMobRenderer {
  constructor(scene, mobs) {
    this.scene = scene;
    this.mobs = mobs;
    this.templates = new Map();
    this.destroyed = false;
    this.pending = 0;
    this.error = null;
    for (const mob of mobs) {
      this.registerTemplate(mob, scene.manifest);
    }
  }

  /** Foreign templates keep only their own validated texture metadata, not a map. */
  registerTemplate(mob, manifest) {
    const key = mob.record.template;
    if (this.templates.has(key)) return this.templates.get(key);
    const descriptor = manifest.life.renderables?.[key];
    if (!descriptor && !mob.defaultAction) return null;
    if (!descriptor) {
      throw new Error("Dynamic mob artwork missing from package");
    }
    entities([descriptor.entity], manifest);
    const textures = Object.create(null);
    const atlases = Object.create(null);
    for (const frames of Object.values(descriptor.entity.actions)) {
      for (const frame of frames) {
        for (const part of frame.parts) {
          const texture = manifest.textures[part.texture];
          textures[part.texture] = texture;
          atlases[texture.atlas] = manifest.atlases[texture.atlas];
        }
      }
    }
    const slot = {
      descriptor,
      manifest: { textures, atlases },
      values: [descriptor.entity],
      wanted: 0,
      reserved: 0,
      resources: null,
      controller: null,
      promise: null,
      ready: false,
      failed: false,
    };
    this.templates.set(key, slot);
    return slot;
  }

  /** Preparation holds demand until the caller publishes or rejects the new mob. */
  async prepareSpawn(mob, manifest, signal) {
    check(signal);
    const slot = this.registerTemplate(mob, manifest);
    if (!slot) throw new Error("Monster has no original artwork");
    slot.reserved++;
    try {
      if (slot.promise) await slot.promise;
      else if (!slot.ready) await this.load(slot);
      check(signal);
      if (this.destroyed || !slot.ready) {
        throw new Error("Monster artwork preparation was cancelled");
      }
      return slot;
    } catch (error) {
      slot.reserved--;
      throw error;
    }
  }

  wanted(mob) {
    if (!mob.active || !mob.visible) return false;
    const scene = this.scene;
    const bounds = this.templates.get(mob.record.template).descriptor.bounds;
    const marginX = scene.viewport.width * PREFETCH_VIEWPORTS;
    const marginY = scene.viewport.height * PREFETCH_VIEWPORTS;
    const radius = Math.max(Math.abs(bounds.left), Math.abs(bounds.right));
    return (
      mob.x + radius >= scene.camera.x - marginX &&
      mob.x - radius <= scene.camera.x + scene.viewport.width + marginX &&
      mob.y + bounds.bottom >= scene.camera.y - marginY &&
      mob.y + bounds.top <= scene.camera.y + scene.viewport.height + marginY
    );
  }

  countDemand() {
    for (const slot of this.templates.values()) slot.wanted = 0;
    for (const mob of this.mobs) {
      if (this.wanted(mob)) this.templates.get(mob.record.template).wanted++;
      else this.remove(mob);
    }
    for (const slot of this.templates.values()) {
      if (!slot.wanted && !slot.reserved) this.release(slot);
    }
  }

  async prepare(signal) {
    check(signal);
    this.countDemand();
    const cancel = this.destroy.bind(this);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      for (const slot of this.templates.values()) {
        if (slot.wanted) await this.load(slot);
        check(signal);
      }
      this.instantiateDemand();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  /** Called by scene demand scheduling, never by fixed-step simulation. */
  updateDemand() {
    if (this.destroyed) return;
    this.countDemand();
    this.instantiateDemand();
    for (const slot of this.templates.values()) {
      if (this.pending >= MAX_PENDING_TEMPLATES) break;
      if (!slot.wanted || slot.resources || slot.promise || slot.failed) {
        continue;
      }
      this.load(slot)
        .then(this.loaded.bind(this))
        .catch(this.failed.bind(this, slot));
    }
  }

  loaded() {
    if (!this.destroyed) this.instantiateDemand();
  }

  failed(slot, error) {
    if (error.name === "AbortError" || this.destroyed) return;
    slot.failed = true;
    this.error = error.message;
    this.scene.lastError = error.message;
  }

  async load(slot) {
    if (this.destroyed) return;
    const controller = new AbortController();
    const resources = new VisualTextures(slot.manifest, this.scene.atlases);
    slot.controller = controller;
    slot.resources = resources;
    slot.promise = resources.load(
      slot.values,
      controller.signal,
      slot.descriptor.atlases,
    );
    this.pending++;
    try {
      await slot.promise;
      check(controller.signal);
      if (!this.destroyed && slot.resources === resources) slot.ready = true;
    } catch (error) {
      resources.destroy();
      if (slot.resources === resources) {
        slot.resources = null;
        slot.ready = false;
      }
      throw error;
    } finally {
      if (slot.controller === controller) slot.promise = null;
      this.pending--;
    }
  }

  instantiateDemand() {
    for (const mob of this.mobs) {
      if (mob.presentation || !this.wanted(mob)) continue;
      const slot = this.templates.get(mob.record.template);
      if (!slot.ready) continue;
      const source = {
        ...slot.descriptor.entity,
        id: mob.id,
        order: 100000 + Number(mob.id.slice(5)),
        x: mob.x,
        y: mob.y,
        z: 239991, // Native uncontacted plane7/group0; synchronize applies live contact.
      };
      const presentation = new EntityAnimation(source, slot.resources.textures);
      presentation.gameplayOwned = true;
      mob.presentation = presentation;
      const label = createMobNameLabel(mob.template.name);
      presentation.container.addChild(label);
      mob.nameLabel = label;
      // HP bar: only show if template doesn't suppress it
      if (!mob.template.info.HPgaugeHide) {
        const hpBar = createMobHpBar();
        hpBar.position.set(0, 0); // real position set in synchronizeMob
        presentation.container.addChild(hpBar);
        mob.hpBar = hpBar;
      }
      this.synchronizeMob(mob);
      try {
        this.scene.addDynamicEntity(presentation);
        this.scene.registerPresentationContainer(label);
        if (mob.hpBar) this.scene.registerPresentationContainer(mob.hpBar);
      } catch (error) {
        this.scene.unregisterPresentationContainer(label);
        if (mob.hpBar) this.scene.unregisterPresentationContainer(mob.hpBar);
        mob.presentation = null;
        presentation.container.destroy({ children: true });
        label.destroy();
        if (mob.hpBar) { mob.hpBar.destroy(); mob.hpBar = null; }
        mob.nameLabel = null;
        throw error;
      }
    }
  }

  /** Original frame selection is projected from simulation, never RAF time. */
  synchronizeMob(mob) {
    const entity = mob.presentation;
    if (!entity) return;
    entity.setPosition(mob.x, mob.y);
    entity.container.scale.x = mobFlipped(mob) ? -1 : 1;
    entity.container.visible =
      mob.visible &&
      !this.scene.offlineField?.hooks.skillTargetController?.()?.hidesBody(mob);
    entity.container.alpha = mob.opacity;
    this.synchronizeDepth(mob, entity);
    // Update HP bar: position atop mob head, centered horizontally, flip reversal, animated fill
    if (mob.hpBar) {
      const slot = this.templates.get(mob.record.template);
      const b = slot?.descriptor?.bounds;
      // bounds is {left, right, top, bottom} where top<0 (head above feet anchor=0)
      const height = b?.top ?? -30; // e.g. -40 means head is 40px above the foot anchor
      mob.hpBar.position.set(0, height - 10);
      // Flip reversal: container.scale.x=-1 flips the bar; undo with same scale
      mob.hpBar.scale.x = entity.container.scale.x; // -1 × -1 = +1
      drawMobHpBar(mob.hpBar, mob.hp, mob.maxHP);
    }
    const once =
      !mob.alive ||
      mob.state === "spawning" ||
      mob.state === "hit" ||
      mob.state === "attack";
    entity.setAction(mob.action, once ? "once" : "loop");
    entity.seek(mob.actionMs);
    this.synchronizeName(mob);
  }

  /** 00664e35: controller3 uses its own aerial plane, not an authored floor. */
  synchronizeDepth(mob, entity) {
    const foothold = mob.foothold;
    const depth =
      mob.movementType === 3
        ? 270100
        : foothold
          ? 29991 + (foothold.layer * 3000 - foothold.group) * 10
          : 239991;
    this.scene.setEntityDepth(entity, depth);
  }

  /** Nameplates counter the body's flip and obey authored suppression flags. */
  synchronizeName(mob) {
    const label = mob.nameLabel;
    if (label) {
      label.position.set(0, 4);
      label.scale.x = mob.presentation.container.scale.x;
      label.visible =
        mob.visible &&
        mob.nameRemainingMs > 0 &&
        !mob.template.info.hideName &&
        !mob.template.info.HPgaugeHide &&
        !mob.template.info.damagedByMob &&
        Boolean(mob.template.name);
    }
  }

  synchronize() {
    for (const mob of this.mobs) this.synchronizeMob(mob);
  }

  remove(mob) {
    if (!mob.presentation) return;
    if (mob.nameLabel) {
      this.scene.unregisterPresentationContainer(mob.nameLabel);
    }
    mob.nameLabel?.destroy();
    mob.nameLabel = null;
    if (mob.hpBar) {
      this.scene.unregisterPresentationContainer(mob.hpBar);
      mob.hpBar.destroy();
      mob.hpBar = null;
    }
    this.scene.removeDynamicEntity(mob.id);
    mob.presentation.container.destroy({ children: true });
    mob.presentation = null;
  }

  release(slot) {
    slot.controller?.abort();
    slot.resources?.destroy();
    slot.resources = null;
    slot.ready = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const mob of this.mobs) this.remove(mob);
    for (const slot of this.templates.values()) this.release(slot);
  }
}
