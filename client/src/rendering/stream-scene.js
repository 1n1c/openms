import { Container } from "pixi.js";
import { EntityAnimation } from "./animation.js";
import { createSimulation } from "../physics/simulation.js";
import { check, aborted } from "./stream-network.js";
import { entities, LIMITS } from "./stream-validation.js";
import { VisualTextures } from "./visual-resources.js";
import { avatarAction } from "./animation-timing.js";

/** Viewport intersection and one-half viewport near-prefetch are browser policies. */
function intersects(bounds, camera, viewport, margin) {
  return (
    bounds.right >= camera.x - margin * viewport.width &&
    bounds.left <= camera.x + (1 + margin) * viewport.width &&
    bounds.bottom >= camera.y - margin * viewport.height &&
    bounds.top <= camera.y + (1 + margin) * viewport.height
  );
}

/** Region owns subtextures/display objects; atlas sources are shared/refcounted. */
class Region {
  constructor(scene, descriptor) {
    this.scene = scene;
    this.descriptor = descriptor;
    this.controller = new AbortController();
    this.resources = new VisualTextures(scene.manifest, scene.atlases);
    this.textures = this.resources.textures;
    this.entities = [];
    this.ready = false;
    this.destroyed = false;
    this.promise = null;
    this.spriteCount = 0;
  }
  async load(values) {
    const signal = this.controller.signal;
    try {
      if (!values) {
        const data = await this.scene.network.json(this.descriptor, signal);
        if (data.schemaVersion !== 2 || data.id !== this.descriptor.id) {
          throw new Error("Region version/identity mismatch");
        }
        values = entities(data.entities, this.scene.manifest);
      }
      // OfflineField owns mob residency and clocks, including legacy region payloads.
      const hasMobs = values.some((entity) => entity.kind === "mob");
      if (hasMobs) values = values.filter((entity) => entity.kind !== "mob");
      await this.resources.load(
        values,
        signal,
        hasMobs ? undefined : this.descriptor?.atlases,
      );
      check(signal);
      this.instantiate(values);
      check(signal);
      this.ready = true;
      this.scene.refreshEntities();
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  instantiate(values) {
    if (this.scene.entities.length + values.length > LIMITS.entities) {
      throw new Error("Resident entity backpressure");
    }
    for (let index = 0; index < values.length; index++) {
      if (this.scene.byId.has(values[index].id)) {
        throw new Error("Duplicate resident entity identity");
      }
      const entity = new EntityAnimation(values[index], this.textures);
      this.entities.push(entity);
      const available =
        LIMITS.sprites - this.scene.spriteCount - this.spriteCount;
      if (entity.background) {
        entity.prepareBackground({ width: 2560, height: 1440 }, available);
      }
      if (entity.sprites.length > available) {
        throw new Error("Resident sprite backpressure");
      }
      this.spriteCount += entity.sprites.length;
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.controller.abort();
    this.ready = false;
    for (const entity of this.entities) {
      entity.container.destroy({ children: true });
    }
    this.resources.destroy();
    this.entities.length = 0;
  }
}

/** One live world plus an isolated transition candidate. No all-artwork preload path. */
export class StreamScene {
  constructor(manifest, services, viewport) {
    this.manifest = manifest;
    this.network = services.network;
    this.atlases = services.atlases;
    this.viewport = viewport;
    this.camera = { ...manifest.camera };
    this.container = new Container({ sortableChildren: true });
    // Diagnostic hit targets/geometry are not native world layers.
    this.overlays = new Container({ zIndex: Number.MAX_SAFE_INTEGER });
    this.regions = new Map();
    this.entities = [];
    this.backgrounds = [];
    this.byId = new Map();
    this.dynamicEntities = new Map();
    this.worldContainers = new Set();
    this.presentationContainers = new Set();
    this.presentationVisible = true;
    this.depthSerial = 1000000;
    this.offlineField = null;
    this.actorRegion = new Region(this, null);
    this.simulation = null;
    this.actor = null;
    this.avatarOwner = null;
    this.destroyed = false;
    this.lastError = null;
    this.pendingLoads = 0;
    this.nearLimit = 2;
    this.failures = new Set();
    this.spriteCount = 0;
    this.cameraPath = null;
    // Region ownership changes let a non-owning scene rebind references (online NPCs).
    this.onEntitiesChanged = null;
  }
  async prepare(signal, arrival = null, avatar = null) {
    const cancel = () => this.destroy();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      this.avatarOwner = avatar;
      if (avatar) {
        await this.actorRegion.load(
          this.manifest.actors.filter((entity) => entity.kind !== "character"),
        );
        check(signal);
        this.actorRegion.entities.push(avatar.animation);
        this.refreshEntities();
      } else await this.actorRegion.load(this.manifest.actors);
      check(signal);
      this.actor = this.actorRegion.entities.find(
        (entity) => entity.kind === "character",
      );
      if (!this.actor) throw new Error("Map has no original character actor");
      const spawn = arrival ?? { x: this.actor.baseX, y: this.actor.baseY };
      this.camera.x += spawn.x - this.actor.baseX;
      this.camera.y += spawn.y - this.actor.baseY;
      this.simulation = createSimulation(this.manifest.physics, spawn);
      this.updateActor(this.simulation);
      for (let index = 0; index < this.manifest.regions.length; index++) {
        const region = this.manifest.regions[index];
        if (
          region.always ||
          intersects(region.bounds, this.camera, this.viewport, 0)
        ) {
          await this.loadRegion(region);
        }
        check(signal);
      }
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  /** Online presentation: no spawn selection, simulation, or authored live actors. */
  async preparePresentation(signal, position) {
    check(signal);
    this.camera.x = position.x - this.viewport.width / 2;
    this.camera.y = position.y - this.viewport.height / 2;
    try {
      await this.actorRegion.load(
        this.manifest.actors.filter(
          (entity) =>
            !["character", "mob", "npc", "drop"].includes(entity.kind),
        ),
      );
      for (const descriptor of this.manifest.regions) {
        if (
          descriptor.always ||
          intersects(descriptor.bounds, this.camera, this.viewport, 0)
        ) {
          await this.loadRegion(descriptor);
          check(signal);
        }
      }
      return this;
    } catch (error) {
      this.destroy();
      throw error;
    }
  }
  async loadRegion(descriptor) {
    if (this.destroyed) throw aborted();
    const old = this.regions.get(descriptor.id);
    if (old) return old.promise;
    const region = new Region(this, descriptor);
    this.regions.set(descriptor.id, region);
    this.pendingLoads++;
    region.promise = region.load(null);
    try {
      return await region.promise;
    } catch (error) {
      if (error.name !== "AbortError") {
        this.lastError = error.message;
        this.failures.add(descriptor.id);
      }
      if (this.regions.get(descriptor.id) === region) {
        this.regions.delete(descriptor.id);
      }
      throw error;
    } finally {
      this.pendingLoads--;
    }
  }
  refreshEntities() {
    if (this.destroyed) return;
    this.entities.length = 0;
    this.backgrounds.length = 0;
    this.byId.clear();
    this.spriteCount = 0;
    this.collect(this.actorRegion);
    for (const region of this.regions.values()) this.collect(region);
    for (const entity of this.dynamicEntities.values()) {
      this.collectEntity(entity);
    }
    this.entities.sort(
      (left, right) =>
        left.container.zIndex - right.container.zIndex ||
        left.container.depthOrder - right.container.depthOrder,
    );
    this.container.removeChildren();
    for (const entity of this.entities) {
      this.container.addChild(entity.container);
    }
    this.container.addChild(this.overlays);
    for (const container of this.worldContainers) {
      this.container.addChild(container);
    }
    this.container.sortChildren();
    this.fieldSystems?.refresh();
    this.onEntitiesChanged?.();
  }
  /** Initialize and update the same pose contract, including paused map entry. */
  updateActor(pose) {
    const actor = this.actor;
    let action = avatarAction(actor, pose.action ?? this.simulation.action);
    if (!actor.actions.has(action))
      action = actor.avatar?.standAction ?? "stand1";
    actor.setPosition(pose.x, pose.y);
    // Original extracted artwork faces left; positive direction mirrors it.
    // actor.container.scale.x = pose.facing > 0 ? -1 : 1;
    // Climbing poses use authored back-facing art — never mirror those.
    const climbAction = action === "ladder" || action === "rope" || action === "ladder2" || action === "rope2";
    actor.container.scale.x = climbAction ? 1 : (pose.facing > 0 ? -1 : 1);
    // 00930b27 modulates actor artwork, not independent name/effect layers.
    actor.setTint(pose.tint ?? 0xffffff);
    const playback =
      pose.playback ?? (actor.action === action ? actor.playback : "loop");
    actor.setAction(action, playback);
    // 004522a6 compares consecutive vertical positions for ladder/rope hold,
    // including a held key at a closed endpoint; it does not replace the action.
    actor.holdFrame =
      action === this.simulation.action &&
      this.simulation.state === "ladder" &&
      this.simulation.y === this.simulation.previousY;
    this.updateActorDepth();
  }
  /** Dynamic systems own artwork/textures; this scene owns only display membership. */
  addDynamicEntity(entity) {
    if (this.destroyed) throw aborted();
    if (this.byId.has(entity.id) || this.dynamicEntities.has(entity.id)) {
      throw new Error(`Duplicate resident entity: ${entity.id}`);
    }
    if (
      this.entities.length >= LIMITS.entities ||
      this.spriteCount + entity.sprites.length > LIMITS.sprites
    ) {
      throw new Error("Dynamic entity residency backpressure");
    }
    this.dynamicEntities.set(entity.id, entity);
    entity.container.depthOrder = ++this.depthSerial;
    this.refreshEntities();
  }
  removeDynamicEntity(id) {
    const entity = this.dynamicEntities.get(id);
    if (!entity) return;
    this.dynamicEntities.delete(id);
    entity.container.removeFromParent();
    this.refreshEntities();
  }
  /** Gate presentation independently from each owner's authored/timed visibility. */
  setPresentationVisible(value) {
    this.presentationVisible = value;
    this.overlays.visible = value;
    for (const container of this.presentationContainers) {
      container.renderable = value;
    }
  }

  /** Registration borrows the container; its subsystem retains teardown ownership. */
  registerPresentationContainer(container) {
    this.presentationContainers.add(container);
    container.renderable = this.presentationVisible;
  }

  unregisterPresentationContainer(container) {
    this.presentationContainers.delete(container);
    if (!container.destroyed) container.renderable = true;
  }

  /** Independent native world layers (names/numbers), retained across region refresh. */
  addWorldContainer(container, z) {
    container.zIndex = z;
    container.depthOrder = ++this.depthSerial;
    this.worldContainers.delete(container);
    this.worldContainers.add(container);
    this.registerPresentationContainer(container);
    this.container.addChild(container);
    this.container.sortChildren();
  }
  removeWorldContainer(container) {
    this.worldContainers.delete(container);
    this.unregisterPresentationContainer(container);
    container.removeFromParent();
  }
  /** 0092fd16 local-user depth; update sorted ownership only when its plane changes. */
  updateActorDepth() {
    const sim = this.simulation;
    // 0092fd37..46: active local controller adds five, independently of ground contact.
    const z = 29997 + (sim.contactLayer * 3000 - sim.contactGroup) * 10;
    this.setEntityDepth(this.actor, z);
  }
  /** 50403a4b/50409efd: equal world z uses latest depth mutation serial, not y.
   * Update both owned entity order and the flattened display list without allocation. */
  setEntityDepth(actor, z) {
    const previous = actor.container.zIndex;
    if (z === previous) return;
    actor.container.zIndex = z;
    actor.container.depthOrder = ++this.depthSerial;
    const oldIndex = this.entities.indexOf(actor);
    // Initial pose/deferred dynamic preparation can precede scene registration.
    if (oldIndex < 0) return;
    let index = oldIndex;
    const direction = z > previous ? 1 : -1;
    for (let count = 0; count < this.entities.length; count++) {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= this.entities.length) break;
      const next = this.entities[nextIndex];
      const comparison =
        z - next.container.zIndex ||
        actor.container.depthOrder - next.container.depthOrder;
      if (comparison * direction <= 0) break;
      this.entities[index] = next;
      index = nextIndex;
    }
    this.entities[index] = actor;
    this.reorderDisplayChild(actor.container, direction);
  }

  /** Move the flattened display child across peers, including independent world layers. */
  reorderDisplayChild(container, direction) {
    const children = this.container.children;
    let childIndex = this.container.getChildIndex(container);
    for (let count = 0; count < children.length; count++) {
      const nextIndex = childIndex + direction;
      if (nextIndex < 0 || nextIndex >= children.length) break;
      const next = children[nextIndex];
      const comparison =
        container.zIndex - next.zIndex ||
        container.depthOrder - next.depthOrder;
      if (comparison * direction <= 0) break;
      childIndex = nextIndex;
    }
    this.container.setChildIndex(container, childIndex);
    this.container.sortDirty = false;
  }

  collect(region) {
    if (!region.ready) return;
    for (const entity of region.entities) this.collectEntity(entity);
  }
  collectEntity(entity) {
    if (this.byId.has(entity.id)) {
      throw new Error(`Duplicate resident entity: ${entity.id}`);
    }
    this.spriteCount += entity.sprites.length;
    this.entities.push(entity);
    this.byId.set(entity.id, entity);
    if (entity.background) this.backgrounds.push(entity);
  }
  /** Stage the swept viewport before publishing a discontinuous player position.
   * The original filter retains history, so artwork along the path is critical too. */
  async prepareCameraPath(destination, signal) {
    check(signal);
    const path = {
      x: Math.min(this.camera.x, destination.x),
      y: Math.min(this.camera.y, destination.y),
      width: Math.abs(destination.x - this.camera.x) + this.viewport.width,
      height: Math.abs(destination.y - this.camera.y) + this.viewport.height,
      destinationX: destination.x,
      destinationY: destination.y,
      committed: false,
    };
    this.cameraPath = path;
    try {
      // Drain already admitted demand before serial staging: never exceed two loads.
      for (const region of this.regions.values()) {
        if (!region.ready) await region.promise;
        check(signal);
      }
      for (const descriptor of this.manifest.regions) {
        if (
          !descriptor.always &&
          !intersects(descriptor.bounds, path, path, 0)
        ) {
          continue;
        }
        if (this.failures.has(descriptor.id)) {
          throw new Error(
            `Camera path requires failed region ${descriptor.id}; reload to retry`,
          );
        }
        await this.loadRegion(descriptor);
        check(signal);
        if (this.destroyed) throw aborted();
      }
      return path;
    } catch (error) {
      if (this.cameraPath === path) this.cameraPath = null;
      throw error;
    }
  }

  /** Retain the sweep until normal near-demand covers the remaining filtered travel. */
  updateCameraPath() {
    const path = this.cameraPath;
    if (
      path?.committed &&
      Math.abs(this.camera.x - path.destinationX) <= this.viewport.width / 2 &&
      Math.abs(this.camera.y - path.destinationY) <= this.viewport.height / 2
    ) {
      this.cameraPath = null;
    }
  }
  /** Timer-driven demand, bounded by validated region count and two concurrent regions. */
  updateDemand() {
    if (this.destroyed) return;
    this.updateCameraPath();
    let changed = false;
    for (const [id, region] of this.regions) {
      if (
        region.descriptor.always ||
        (this.cameraPath &&
          intersects(
            region.descriptor.bounds,
            this.cameraPath,
            this.cameraPath,
            0,
          )) ||
        intersects(region.descriptor.bounds, this.camera, this.viewport, 0.5)
      ) {
        continue;
      }
      region.destroy();
      this.regions.delete(id);
      changed = true;
    }
    if (changed) this.refreshEntities();
    if (!this.cameraPath || this.cameraPath.committed) {
      this.scheduleRegions(0);
      this.scheduleRegions(0.5);
    }
    this.offlineField?.updateDemand();
  }
  scheduleRegions(margin) {
    for (
      let index = 0;
      index < this.manifest.regions.length &&
      this.pendingLoads < this.nearLimit;
      index++
    ) {
      const descriptor = this.manifest.regions[index];
      if (this.regions.has(descriptor.id) || this.failures.has(descriptor.id)) {
        continue;
      }
      if (
        !descriptor.always &&
        !intersects(descriptor.bounds, this.camera, this.viewport, margin)
      ) {
        continue;
      }
      this.loadRegion(descriptor).catch((error) => {
        if (error.name !== "AbortError") {
          this.lastError = error.message;
          this.failures.add(descriptor.id);
        }
      });
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.fieldSystems?.destroy();
    this.offlineField?.destroy();
    this.dynamicEntities.clear();
    this.actorRegion.destroy();
    this.avatarOwner?.destroy();
    this.avatarOwner = null;
    for (const region of this.regions.values()) region.destroy();
    this.regions.clear();
    // External presentation systems retain their own containers/textures.
    for (const container of this.worldContainers) container.removeFromParent();
    this.worldContainers.clear();
    this.presentationContainers.clear();
    this.container.destroy({ children: true });
    this.entities.length = 0;
    this.backgrounds.length = 0;
    this.byId.clear();
  }
}
