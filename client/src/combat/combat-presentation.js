import { COMBAT_VALUE_LIMIT } from "../../../shared/combat-formulas.js";
import { Container, Rectangle, Sprite, Texture } from "pixi.js";
import { loadVisualBundle } from "../rendering/visual-resources.js";
import { check } from "../rendering/stream-network.js";
import { EntityAnimation } from "../rendering/animation.js";
import { skillLineCount } from "../skills/skill-damage.js";
import { MOB_DOT_SKILLS, statusFamily } from "./mob-skill-status.js";
import { BALLISTIC_SKILLS } from "../skills/skill-ballistic-rules.js";

// Cold demand growth;1024 is a failure bound, not an eagerly allocated baseline.
const BASE_NUMBERS = 32;
const MAX_NUMBERS = 1024;
const MAX_DIGITS = 16;
const MAX_PROJECTILES = 128; // Shared ordinary and skill ammunition flight residency.
const MAX_MAGNET_RESULTS = 32;
const MAX_HIT_EFFECTS = 64;
const FAMILIES = ["NoRed", "NoBlue", "NoViolet", "NoCri"];
const DESTROY = Object.freeze({ children: true });

/** Original 00437d0f: 400 ms opaque, 600 ms fade, -30 px over 1000 ms. */
export class CombatPresentation {
  constructor(app, services) {
    this.app = app;
    this.services = services;
    this.scene = null;
    this.owner = null;
    this.glyphs = null;
    this.criticalTextures = [];
    this.slots = [];
    this.projectileOwner = null;
    this.projectileSlots = [];
    this.projectileHits = new Map();
    this.projectileActions = new Map();
    this.magnetSlots = [];
    this.hitEffectOwner = null;
    this.hitEffectSlots = [];
    this.hitEffectActions = new Map();
    this.next = 0;
    this.numberPlacement = { x: 0, y: 0, delay: 0, target: null };
    this.emitted = 0;
    this.overflow = 0;
    this.destroyed = false;
    this.growNumbers(BASE_NUMBERS);
  }

  growNumbers(capacity) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < BASE_NUMBERS ||
      capacity > MAX_NUMBERS
    ) {
      throw new Error("Invalid combat number resource capacity");
    }
    for (let i = this.slots.length; i < capacity; i++) {
      const container = new Container();
      container.visible = false;
      const sprites = [];
      const critical = new Sprite();
      container.addChild(critical);
      for (let digit = 0; digit < MAX_DIGITS; digit++) {
        const sprite = new Sprite();
        container.addChild(sprite);
        sprites.push(sprite);
      }
      this.slots.push({
        container,
        sprites,
        critical,
        age: 1000,
        x: 0,
        y: 0,
        amount: 0,
        family: 0,
        target: null,
        line: 0,
        spacing: 30,
      });
    }
  }

  prepareSkillCapacity(system, maxTargets) {
    const field = numberCapacityField(this, system, maxTargets);
    const demandContext = {
      field,
      maxTargets,
      shadow: system.level(4111002) > 0 || system.level(14111000) > 0,
    };
    let player = 0,
      largestBurst = 0,
      summons = 0;
    for (const record of field.skillCombat.prepared.values()) {
      const demand = learnedNumberDemand(system, record, demandContext);
      if (!demand) continue;
      if (demand.summon) summons += demand.total;
      else {
        player = Math.max(player, demand.total);
        largestBurst = Math.max(largestBurst, demand.burst);
      }
    }
    const required =
      BASE_NUMBERS +
      player +
      largestBurst +
      summons +
      dotNumberCapacity(system, maxTargets);
    if (!Number.isSafeInteger(required) || required > MAX_NUMBERS) {
      throw new Error(
        `Combat number resource budget requires ${required} slots; hard limit is ${MAX_NUMBERS}`,
      );
    }
    this.growNumbers(required);
    return this.slots.length;
  }
  async prepare(catalog, signal, projectiles, hitEffects) {
    if (this.destroyed || this.owner) {
      throw new Error("Combat presentation is not a fresh owner");
    }
    if (!catalog?.combat?.digits) {
      throw new Error("Missing original combat digit catalog");
    }
    const owner = await loadVisualBundle(
      catalog.combat.digits,
      this.services,
      signal,
    );
    try {
      check(signal);
      if (this.destroyed) throw new Error("Combat presentation was destroyed");
      this.glyphs = readGlyphs(owner);
      this.prepareCritical(owner);
      this.prepareMagnet(owner);
      if (!projectiles) {
        throw new Error("Missing original ammunition visual catalog");
      }
      this.projectileOwner = await loadVisualBundle(
        projectiles,
        this.services,
        signal,
      );
      check(signal);
      if (this.destroyed) throw new Error("Combat presentation was destroyed");
      this.prepareProjectiles();
      if (hitEffects) {
        this.hitEffectOwner = await loadVisualBundle(
          hitEffects,
          this.services,
          signal,
        );
        check(signal);
        if (this.destroyed) throw new Error("Combat presentation was destroyed");
        this.prepareHitEffects();
      }
      this.owner = owner;
    } catch (error) {
      this.releaseCritical();
      this.clearMagnet();
      owner.destroy();
      for (const slot of this.projectileSlots) {
        slot.animation.container.destroy(DESTROY);
      }
      this.projectileSlots.length = 0;
      this.clearHitEffects();
      this.glyphs = null;
      this.projectileOwner?.destroy();
      this.projectileOwner = null;
      throw error;
    }
  }

  prepareCritical(owner) {
    const glyph = readGlyph(
      owner.manifest.entities[0].actions,
      owner.textures,
      "NoCri1/effect",
    );
    const texture = glyph.texture;
    if (texture.width > 512 || texture.height > 128) {
      throw new Error("Original critical marker exceeds canvas bound");
    }
    // 00438225 copies at(0,0) into the computed number canvas, clipping its right edge.
    for (let width = 1; width <= texture.width; width++) {
      this.criticalTextures[width] = new Texture({
        source: texture.source,
        frame: new Rectangle(
          texture.frame.x,
          texture.frame.y,
          width,
          texture.height,
        ),
      });
    }
  }

  releaseCritical() {
    for (const texture of this.criticalTextures) texture?.destroy();
    this.criticalTextures.length = 0;
  }
  prepareProjectiles() {
    const actions = Object.create(null);
    for (const entity of this.projectileOwner.manifest.entities) {
      actions[entity.id] = entity.actions.bullet;
      this.projectileActions.set(Number(entity.id), entity.id);
      if (entity.actions.hit) {
        const name = `${entity.id}:hit`;
        actions[name] = entity.actions.hit;
        this.projectileHits.set(Number(entity.id), name);
      }
    }
    const ids = Object.keys(actions);
    if (!ids.length || ids.length > 4096) {
      throw new Error("Invalid projectile animation bound");
    }
    const entity = {
      id: "ordinary-projectile",
      order: 0,
      kind: "effect",
      x: 0,
      y: 0,
      z: 0,
      visible: false,
      opacity: 1,
      flip: false,
      action: ids[0],
      actions,
    };
    for (let index = 0; index < MAX_PROJECTILES; index++) {
      const animation = new EntityAnimation(
        entity,
        this.projectileOwner.textures,
      );
      this.projectileSlots.push({
        animation,
        active: false,
        flying: false,
        previewId: null,
        hitAction: null,
        age: 0,
        delay: 0,
        duration: 0,
        x: 0,
        y: 0,
        dx: 0,
        dy: 0,
      });
    }
  }

  projectileAdmissionError(needed) {
    let free = 0;
    for (const slot of this.projectileSlots) if (!slot.active) free++;
    return free < needed
      ? "Original ammunition projectile slots are busy"
      : null;
  }

  /** One-time copy from the fixed-tick owner; no retained mutable combat/inventory reference. */
  onProjectile(shot) {
    //00942831: throwing-star repeated bullets use120ms launch spacing.
    const count = Math.max(1, shot.info?.bulletCount ?? 1);
    const spacing = Math.trunc(shot.projectileId / 10000) === 207 ? 120 : 0;
    for (let index = 0; index < count; index++) {
      this.projectile(shot, index * spacing, 7 * (2 * index + 1 - count));
    }
  }

  projectile(shot, delay, spreadY) {
    if (!this.scene) return;
    const slot = this.acquireProjectile();
    const action = this.projectileActions.get(shot.projectileId);
    if (!action) {
      throw new Error("Original ammunition projectile artwork unavailable");
    }
    slot.animation.setAction(action, "loop", true);
    slot.animation.container.scale.x = shot.facing;
    slot.animation.container.visible = delay === 0;
    slot.animation.setPosition(shot.x, shot.y);
    slot.active = true;
    slot.flying = true;
    slot.previewId = shot.previewId ?? null;
    slot.hitAction = shot.target
      ? (this.projectileHits.get(shot.projectileId) ?? null)
      : null;
    slot.age = 0;
    slot.delay = delay;
    slot.duration = shot.duration;
    slot.x = shot.x;
    slot.y = shot.y;
    slot.dx = shot.endX - shot.x;
    slot.dy = shot.endY - shot.y + spreadY;
    this.scene.addWorldContainer(slot.animation.container, 500000);
  }

  cancelProjectilePreview(identity) {
    for (const slot of this.projectileSlots) {
      if (!slot.active || slot.previewId !== identity) continue;
      slot.active = false;
      slot.animation.container.visible = false;
      this.scene?.removeWorldContainer(slot.animation.container);
    }
  }

  acquireProjectile() {
    for (const slot of this.projectileSlots) {
      if (!slot.active) return slot;
    }
    throw new Error("Projectile presentation pool exhausted");
  }

  /** A confirmed impact may arrive independently of its field projectile flight. */
  onProjectileImpact(projectileId, position, facing) {
    if (!this.scene) return;
    const hitAction = this.projectileHits.get(projectileId);
    if (!hitAction) return;
    const slot = this.acquireProjectile();
    slot.hitAction = hitAction;
    slot.active = true;
    slot.delay = 0;
    slot.animation.container.scale.x = facing;
    slot.animation.container.visible = true;
    slot.animation.setPosition(position.x, position.y);
    this.activateProjectileImpact(slot);
    this.scene.addWorldContainer(slot.animation.container, 500000);
  }

  activateProjectileImpact(slot) {
    slot.flying = false;
    slot.previewId = null;
    slot.animation.setAction(slot.hitAction, "once");
    slot.age = 0;
    slot.duration = slot.animation.current.duration;
  }

  updateProjectiles(ms) {
    for (const slot of this.projectileSlots) {
      if (!slot.active) continue;
      if (slot.delay > 0) {
        const waiting = Math.min(ms, slot.delay);
        slot.delay -= waiting;
        if (slot.delay > 0) continue;
        slot.age = -waiting;
        slot.animation.container.visible = true;
      }
      slot.age = Math.min(slot.duration, slot.age + ms);
      if (slot.flying) {
        slot.animation.setPosition(
          slot.x + (slot.dx * slot.age) / slot.duration,
          slot.y + (slot.dy * slot.age) / slot.duration,
        );
      }
      slot.animation.advance(ms);
      if (slot.age < slot.duration) continue;
      if (slot.flying && slot.hitAction) {
        this.activateProjectileImpact(slot);
        continue;
      }
      slot.active = false;
      slot.animation.container.visible = false;
      this.scene?.removeWorldContainer(slot.animation.container);
    }
  }

  prepareMagnet(owner) {
    const authored = owner.manifest.entities[0].actions;
    const actions = {
      success: authored["Catch/Success"],
      fail: authored["Catch/Fail"],
    };
    if (!actions.success?.length || !actions.fail?.length) {
      throw new Error("Missing original Magnet result artwork");
    }
    const entity = {
      id: "magnet-result",
      kind: "effect",
      order: 0,
      x: 0,
      y: 0,
      z: 0,
      visible: false,
      flip: false,
      opacity: 1,
      action: "success",
      actions,
    };
    for (let index = 0; index < MAX_MAGNET_RESULTS; index++) {
      const animation = new EntityAnimation(entity, owner.textures);
      this.magnetSlots.push({ animation, active: false, age: 0, duration: 0 });
    }
  }

  onMagnetResult(mob, success) {
    if (!this.scene || !this.owner) return;
    const slot = this.magnetSlot();
    if (slot.active) this.overflow++;
    const entity = mob.presentation;
    const geometry = entity?.actions.get(entity.action)?.geometry[entity.frame];
    slot.animation.setAction(success ? "success" : "fail", "once");
    slot.animation.seek(0);
    slot.animation.setPosition(mob.x, mob.y + (geometry?.y ?? 0) - 15);
    slot.animation.container.visible = true;
    slot.active = true;
    slot.age = 0;
    slot.duration = slot.animation.current.duration;
    this.scene.addWorldContainer(slot.animation.container, 398500);
  }

  magnetSlot() {
    let slot = null;
    for (const candidate of this.magnetSlots) {
      if (!candidate.active) return candidate;
      if (!slot || candidate.age > slot.age) slot = candidate;
    }
    return slot;
  }

  updateMagnet(ms) {
    for (const slot of this.magnetSlots) {
      if (!slot.active) continue;
      slot.age += ms;
      slot.animation.advance(ms);
      if (slot.age < slot.duration) continue;
      slot.active = false;
      slot.animation.container.visible = false;
      this.scene?.removeWorldContainer(slot.animation.container);
    }
  }

  clearMagnet() {
    for (const slot of this.magnetSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.animation.container.destroy(DESTROY);
    }
    this.magnetSlots.length = 0;
  }

  prepareHitEffects() {
    const entity = this.hitEffectOwner.manifest.entities[0];
    for (const actionName of Object.keys(entity.actions)) {
      this.hitEffectActions.set(actionName, actionName);
    }
    for (let i = 0; i < MAX_HIT_EFFECTS; i++) {
      const clone = { ...entity, actions: entity.actions };
      const animation = new EntityAnimation(clone, this.hitEffectOwner.textures);
      this.hitEffectSlots.push({ animation, active: false, age: 0, duration: 0 });
    }
  }

  clearHitEffects() {
    for (const slot of this.hitEffectSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.animation.container.destroy(DESTROY);
    }
    this.hitEffectSlots.length = 0;
    this.hitEffectActions.clear();
    this.hitEffectOwner?.destroy();
    this.hitEffectOwner = null;
  }

  acquireHitEffect() {
    for (const slot of this.hitEffectSlots) {
      if (!slot.active) return slot;
    }
    // Pool exhausted — reuse oldest
    let oldest = null;
    for (const slot of this.hitEffectSlots) {
      if (!oldest || slot.age > oldest.age) oldest = slot;
    }
    return oldest;
  }

  /** Spawn a weapon hit spark at (x,y). variant is "sword1"/"sword2"/"mace1"/"mace2".
   *  facing = 1 for right, -1 for left (mirrors the sprite on facing-left). */
  onHitEffect(x, y, facing, variant) {
    if (!this.scene || !this.hitEffectOwner) return;
    const action = this.hitEffectActions.get(variant);
    if (!action) return;
    const slot = this.acquireHitEffect();
    slot.animation.setAction(action, "once");
    slot.animation.seek(0);
    slot.animation.setPosition(x, y);
    slot.animation.container.scale.x = facing > 0 ? 1 : -1;
    slot.animation.container.visible = true;
    slot.active = true;
    slot.age = 0;
    slot.duration = slot.animation.current.duration;
    this.scene.addWorldContainer(slot.animation.container, 450000);
  }

  updateHitEffects(ms) {
    for (const slot of this.hitEffectSlots) {
      if (!slot.active) continue;
      slot.age += ms;
      slot.animation.advance(ms);
      if (slot.age < slot.duration) continue;
      slot.active = false;
      slot.animation.container.visible = false;
      this.scene?.removeWorldContainer(slot.animation.container);
    }
  }

  setScene(scene) {
    for (const slot of this.slots) {
      this.scene?.removeWorldContainer(slot.container);
      slot.age = 1000;
      slot.target = null;
      slot.container.visible = false;
    }
    for (const slot of this.projectileSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.active = false;
      slot.animation.container.visible = false;
    }
    for (const slot of this.magnetSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.active = false;
      slot.animation.container.visible = false;
    }
    for (const slot of this.hitEffectSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.active = false;
      slot.animation.container.visible = false;
    }
    this.scene = scene;
  }
  onPlayerHit(hit, simulation) {
    if (hit.amount < 0) return;
    // 00959320..b9 subtracts damage before the signed vital-number consumer.
    this.onVitalNumber(-(hit.hpDamage ?? hit.amount), simulation);
  }

  onRecovery(amount, simulation) {
    this.onVitalNumber(amount, simulation);
  }

  onVitalNumber(amount, simulation) {
    const actor = this.scene?.actor;
    const geometry = actor?.actions.get(actor.action)?.geometry[actor.frame];
    // Browser binding-extent approximation; native 004519aa queries two layers.
    const y = simulation.y + (geometry?.y ?? 0);
    const placement = this.fixedNumberPlacement(simulation.x, y);
    this.show(Math.abs(amount), amount > 0 ? 1 : 2, placement);
  }
  onMobHit(mob, damage, critical = false) {
    const entity = mob.presentation;
    const geometry = entity?.actions.get(entity.action)?.geometry[entity.frame];
    const y = mob.y + (geometry?.y ?? 0) - 15;
    const placement = this.fixedNumberPlacement(mob.x, y);
    this.show(Math.abs(damage), damage < 0 ? 1 : critical ? 3 : 0, placement);
  }

  onSkillDamageLine(mob, amount, presentation) {
    const { line, critical, skillId } = presentation;
    //00668ddf..df2: these native controllers deliberately draw no ordinary digits.
    if (hiddenSkillNumbers(skillId)) return;
    if (!Number.isInteger(line) || line < 0 || line >= 30) {
      throw new Error("Original damage-line ordinal exceeds30-line bound");
    }
    const family = skillNumberFamily(amount, critical, skillId);
    const placement = this.numberPlacement;
    placement.x = 0;
    placement.y = 0;
    placement.delay = skillNumberDelay(skillId, line);
    placement.target = mob;
    const slot = this.show(Math.abs(amount), family, placement);
    if (!slot) return;
    slot.line = line;
    slot.spacing = skillId === 5121004 ? 15 : 30;
    if (slot.age === 0) this.activateNumber(slot);
  }
  fixedNumberPlacement(x, y) {
    const placement = this.numberPlacement;
    placement.x = x;
    placement.y = y;
    placement.delay = 0;
    placement.target = null;
    return placement;
  }

  /** Coordinates are fixed world anchors, not reattached to a moving target. */
  show(amount, family, placement) {
    if (
      !this.owner ||
      !this.scene ||
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > COMBAT_VALUE_LIMIT
    ) {
      return null;
    }
    const slot = this.numberSlot();
    slot.age = -placement.delay;
    slot.x = placement.x;
    slot.y = placement.y;
    slot.target = placement.target;
    slot.amount = amount;
    slot.family = family;
    slot.container.visible = false;
    if (!slot.target) this.activateNumber(slot);
    this.emitted++;
    return slot;
  }

  numberSlot() {
    for (let index = 0; index < this.slots.length; index++) {
      const slot = this.slots[this.next];
      this.next = (this.next + 1) % this.slots.length;
      if (slot.age >= 1000) return slot;
    }
    this.overflow++;
    throw new Error(
      `Combat number presentation exhausted its prepared ${this.slots.length}-slot budget`,
    );
  }

  activateNumber(slot) {
    if (slot.target) {
      const mob = slot.target,
        entity = mob.presentation;
      const geometry = entity?.actions.get(entity.action)?.geometry[
        entity.frame
      ];
      slot.x = mob.x;
      slot.y = mob.y + (geometry?.y ?? 0) - 15 - slot.spacing * slot.line;
      slot.target = null;
    }
    slot.container.visible = true;
    slot.container.alpha = 1;
    this.layoutDigits(slot, slot.amount, slot.family);
    // 0043849c/0043dee8: one native root per accepted number.
    this.scene.addWorldContainer(slot.container, 398500);
  }
  layoutDigits(slot, amount, family) {
    if (amount === 0) {
      this.layoutMiss(slot, family);
      return;
    }
    let divisor = 1;
    while (divisor <= amount / 10) divisor *= 10;
    let width = family === 3 ? 30 : 0,
      overlap = 0,
      count = 0;
    do {
      const digit = Math.trunc(amount / divisor) % 10;
      const glyph = this.glyphs[family][count === 0 ? 1 : 0][digit];
      const sprite = slot.sprites[count];
      sprite.texture = glyph.texture;
      sprite.visible = true;
      sprite.x = width - overlap;
      //00438341..75: authored canvas height, alternating baseline and rand()%2.
      sprite.y =
        57 -
        (count % 2 === 0 ? 4 : 1) -
        Math.trunc(Math.random() * 2) -
        glyph.height;
      width = sprite.x + glyph.width;
      overlap = Math.trunc(((glyph.width + glyph.x) * 3) / 5);
      divisor = Math.trunc(divisor / 10);
      count++;
    } while (divisor > 0 && count < MAX_DIGITS);
    for (let i = count; i < MAX_DIGITS; i++) slot.sprites[i].visible = false;
    slot.critical.visible = family === 3;
    if (family === 3) {
      slot.critical.texture =
        this.criticalTextures[
          Math.min(width, this.criticalTextures.length - 1)
        ];
    }
    slot.x -= Math.trunc(width / 2);
    slot.y -= 47;
    slot.container.position.set(slot.x, slot.y);
  }

  layoutMiss(slot, family) {
    const glyph = this.glyphs[family][0][10],
      sprite = slot.sprites[0];
    sprite.texture = glyph.texture;
    sprite.position.set(0, 0);
    sprite.visible = true;
    for (let index = 1; index < MAX_DIGITS; index++) {
      slot.sprites[index].visible = false;
    }
    slot.critical.visible = false;
    slot.x -= Math.trunc(glyph.width / 2);
    slot.y -= glyph.height;
    slot.container.position.set(slot.x, slot.y);
  }
  update(ms) {
    this.updateProjectiles(ms);
    this.updateMagnet(ms);
    this.updateHitEffects(ms);
    for (const slot of this.slots) {
      if (slot.age >= 1000) continue;
      const pending = slot.age < 0;
      slot.age = Math.min(1000, slot.age + ms);
      if (slot.age < 0) continue;
      if (pending && slot.age < 1000) this.activateNumber(slot);
      slot.container.visible = slot.age < 1000;
      if (slot.age === 1000) this.scene?.removeWorldContainer(slot.container);
      slot.container.y = slot.y - (30 * slot.age) / 1000;
      slot.container.alpha = slot.age <= 400 ? 1 : (1000 - slot.age) / 600;
    }
  }
  snapshot() {
    let active = 0,
      pending = 0;
    for (const slot of this.slots) {
      if (slot.age < 0) pending++;
      else if (slot.age < 1000) active++;
    }
    return {
      active,
      pending,
      emitted: this.emitted,
      overflow: this.overflow,
      capacity: this.slots.length,
      hardCapacity: MAX_NUMBERS,
    };
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const slot of this.slots) {
      this.scene?.removeWorldContainer(slot.container);
      slot.container.destroy(DESTROY);
    }
    for (const slot of this.projectileSlots) {
      this.scene?.removeWorldContainer(slot.animation.container);
      slot.animation.container.destroy(DESTROY);
    }
    this.releaseCritical();
    this.clearMagnet();
    this.clearHitEffects();
    this.projectileOwner?.destroy();
    this.projectileOwner = null;
    this.scene = null;
    this.owner?.destroy();
    this.owner = null;
    this.glyphs = null;
  }
}

function readGlyphs(owner) {
  const families = [];
  const actions = owner.manifest.entities[0].actions;
  for (const family of FAMILIES) {
    const variants = [];
    for (let variant = 0; variant < 2; variant++) {
      variants.push(readVariant(actions, owner.textures, family, variant));
    }
    families.push(variants);
  }
  return families;
}

function readVariant(actions, textures, family, variant) {
  const glyphs = [];
  const requiresMiss =
    variant === 0 && (family === "NoRed" || family === "NoViolet");
  for (let digit = 0; digit <= 10; digit++) {
    const key = `${family}${variant}/${digit === 10 ? "Miss" : digit}`;
    const frame = actions[key]?.[0];
    if (!frame) {
      if (digit < 10 || requiresMiss) {
        throw new Error(`Missing original combat glyph: ${key}`);
      }
      glyphs.push(null);
      continue;
    }
    glyphs.push(readGlyph(actions, textures, key));
  }
  return glyphs;
}

function readGlyph(actions, textures, key) {
  const frame = actions[key]?.[0];
  if (frame?.parts.length !== 1) {
    throw new Error(`Missing original combat canvas: ${key}`);
  }
  const part = frame.parts[0],
    texture = textures.get(part.texture);
  if (!texture) throw new Error(`Missing original combat texture: ${key}`);
  return {
    texture,
    x: part.x,
    y: part.y,
    width: texture.width,
    height: texture.height,
  };
}

/**0066b105..13c: display-queue offsets, not a second gameplay damage clock. */
export function skillNumberDelay(skillId, line) {
  switch (skillId) {
    case 5101004:
    case 15101003:
    case 5121007:
    case 15111004:
      return 0;
    case 3111006:
    case 3211006:
    case 13111001:
      return line * 60;
    default:
      return line * 120;
  }
}

function skillNumberFamily(amount, critical, skillId) {
  if (amount < 0) return 1;
  return amount > 0 && (critical || skillId === 3221007) ? 3 : 0;
}

function hiddenSkillNumbers(skillId) {
  return skillId === 1221011 || skillId === 5221009 || skillId === 21120006;
}

function playerNumberPeriod(system, field, record, info) {
  if (record.spec?.kind === "continuous") return 120;
  const action = system.scene.actor?.actions.get(record.action);
  const duration = fastestNumberActionDuration(field, record, action);
  const cooldown = (info.cooltime ?? 0) * 1000;
  return duration > 0 || cooldown > 0 ? Math.max(30, duration, cooldown) : 0;
}

function fastestNumberActionDuration(field, record, action) {
  if (!action || !field.combat?.attacks?.[record.action]) {
    return action?.duration ?? record.duration ?? 0;
  }
  //00453ad1: project already speed-scaled frames to fastest native speed2.
  const numerator =
    Math.max(2, Math.min(10, field.combat.equipment.attackSpeed)) + 10;
  let duration = 0;
  for (const frame of action.frames) {
    duration += Math.trunc((frame.delay * 12) / numerator);
  }
  return duration;
}

function summonNumberPeriod(skill, attack) {
  return Math.max(
    skill.visuals?.["summon/attack1"]?.durationMs ?? 0,
    attack.attackAfter ?? 0,
    attack.effectAfter ?? 0,
  );
}

function numberCapacityField(presentation, system, maxTargets) {
  if (presentation.destroyed || !presentation.owner) {
    throw new Error("Combat number owner is not prepared");
  }
  if (!Number.isSafeInteger(maxTargets) || maxTargets < 0) {
    throw new Error("Invalid combat target capacity");
  }
  const field = system.hooks.gameplay();
  if (!field?.skillCombat?.prepared) {
    throw new Error("Combat skills must be prepared before number capacity");
  }
  return field;
}

function learnedNumberDemand(system, record, context) {
  if (!hasLearnedNumbers(system, record)) return null;
  const { field, maxTargets, shadow } = context;
  const info = system.info(record.skill.id);
  const summon = record.skill.properties.summon?.attack1?.info;
  const lines = numberLineCount(info, record.spec, shadow && !summon);
  const targets = Math.min(
    maxTargets,
    summon ? 15 : 30,
    summon?.mobCount ?? info.mobCount ?? 1,
  );
  const burst = lines * targets;
  const period = summon
    ? summonNumberPeriod(record.skill, summon)
    : playerNumberPeriod(system, field, record, info);
  // One30ms quantum covers allocation before retirement at an equal tick deadline.
  const window = 1030 + skillNumberDelay(record.skill.id, lines - 1);
  // Unknown repeat metadata gets six overlapping bursts, not a fabricated native cadence.
  return {
    summon: !!summon,
    burst,
    total: burst * (period > 0 ? Math.ceil(window / period) : 6),
  };
}

function hasLearnedNumbers(system, record) {
  if (
    system.level(record.skill.id) <= 0 ||
    hiddenSkillNumbers(record.skill.id)
  ) {
    return false;
  }
  if (record.spec?.kind === "status" || record.spec?.kind === "magnet") {
    return false;
  }
  return Boolean(
    record.spec ||
    record.skill.properties.summon?.attack1?.info ||
    BALLISTIC_SKILLS.has(record.skill.id),
  );
}

function numberLineCount(info, spec, shadow) {
  const duplicate = shadow && !spec?.magic && spec?.kind !== "magic";
  return skillLineCount(info) * (duplicate ? 2 : 1);
}

function dotNumberCapacity(system, maxTargets) {
  let poison = false,
    ambush = false;
  for (const id of MOB_DOT_SKILLS) {
    if (system.level(id) <= 0) continue;
    if (statusFamily(id) === "ambush") ambush = true;
    else poison = true;
  }
  //1000ms poison/ambush pulses share a1000ms visible lifetime; retain boundary overlap.
  return 2 * maxTargets * (Number(poison) + Number(ambush));
}
