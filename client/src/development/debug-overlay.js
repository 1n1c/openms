import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { createHitboxState, updateHitboxes } from "../physics/hitboxes.js";

// Inspection policies, not original physics constants.
const READOUT_INTERVAL_MS = 200;
const VELOCITY_SCALE = 0.2;
const SHAPE_NAMES = ["body", "attack", "damage"];
const SHAPE_COLORS = [0x00ffff, 0xffbb00, 0xff55aa];

/** Extra overlay rectangles: mob body + real-time self attack body. */
const MOB_COLOR = 0x00ff88;  // green for mob bodies
const MAX_MOB_RECTS = 32;

/** @param {Container} parent @param {number} color */
function lineSprite(parent, color) {
  const sprite = new Sprite(Texture.WHITE);
  sprite.tint = color;
  parent.addChild(sprite);
  return sprite;
}

/** @param {Container} parent @param {number} color */
function rectangleSprites(parent, color) {
  const edges = [];
  for (let index = 0; index < 4; index++) edges.push(lineSprite(parent, color));
  return edges;
}

/** @param {Sprite[]} edges @param {object} shape */
function placeRectangle(edges, shape) {
  const active = shape.active === true;
  for (let index = 0; index < edges.length; index++) {
    edges[index].visible = active;
  }
  if (!active) return;
  const width = shape.right - shape.left;
  const height = shape.bottom - shape.top;
  edges[0].position.set(shape.left, shape.top);
  edges[0].width = width;
  edges[0].height = 1;
  edges[1].position.set(shape.left, shape.bottom);
  edges[1].width = width;
  edges[1].height = 1;
  edges[2].position.set(shape.left, shape.top);
  edges[2].width = 1;
  edges[2].height = height;
  edges[3].position.set(shape.right, shape.top);
  edges[3].width = 1;
  edges[3].height = height;
}

/** Place a rectangle from authored left-facing coords into world space.
 *  Matches placeBody() from life-geometry-numeric.js which the server uses. */
function placeAuthoredRectangle(edges, rect, x, y, facing) {
  if (!rect) {
    for (let i = 0; i < 4; i++) edges[i].visible = false;
    return;
  }
  const left = rect.left;
  const right = rect.right;
  // Flip for facing-right: negate and swap x ends.
  const worldLeft = x + (facing > 0 ? -right : left);
  const worldRight = x + (facing > 0 ? -left : right);
  const worldTop = rect.top + y;
  const worldBottom = rect.bottom + y;
  placeRectangle(edges, {
    active: worldLeft < worldRight && worldTop < worldBottom,
    left: worldLeft, right: worldRight,
    top: worldTop, bottom: worldBottom,
  });
}

/** @param {object} overlay @param {object} scene */
function drawFootholds(overlay, scene) {
  const geometry = scene.manifest.physics;
  overlay.lines.clear();
  for (const foothold of geometry.footholds) {
    overlay.lines.moveTo(foothold.x1, foothold.y1);
    overlay.lines.lineTo(foothold.x2, foothold.y2);
  }
  overlay.lines.stroke({ color: 0x55ff66, width: 1 });
  for (const ladder of geometry.ladders) {
    overlay.lines.moveTo(ladder.x, ladder.y1);
    overlay.lines.lineTo(ladder.x, ladder.y2);
  }
  overlay.lines.stroke({ color: 0xffff99, width: 1 });
  drawBounds(overlay.lines, scene);
  overlay.simulation = scene.simulation;
  overlay.manifest = scene.manifest;
}

/** Static field geometry is rebuilt on field/simulation replacement, never per frame. */
function drawBounds(lines, scene) {
  const render = scene.manifest.bounds;
  lines.rect(
    render.left,
    render.top,
    render.right - render.left,
    render.bottom - render.top,
  );
  lines.stroke({ color: 0x6699ff, width: 1 });
  const map = scene.manifest.physics.map;
  if (
    Number.isFinite(map.VRLeft) &&
    Number.isFinite(map.VRRight) &&
    Number.isFinite(map.VRTop) &&
    Number.isFinite(map.VRBottom)
  ) {
    lines.rect(
      map.VRLeft,
      map.VRTop,
      map.VRRight - map.VRLeft,
      map.VRBottom - map.VRTop,
    );
    lines.stroke({ color: 0xcc88ff, width: 1 });
  }
  const bounds = scene.simulation.bounds;
  lines.moveTo(bounds.left, bounds.bottom);
  lines.lineTo(bounds.left, bounds.top);
  lines.lineTo(bounds.right, bounds.top);
  lines.lineTo(bounds.right, bounds.bottom);
  lines.stroke({ color: 0xff8844, width: 2 });
  // Bottom participates in initialization only. At most 256 dashes per field.
  const step = Math.max(12, (bounds.right - bounds.left) / 256);
  for (let x = bounds.left; x < bounds.right; x += step) {
    lines.moveTo(x, bounds.bottom);
    lines.lineTo(Math.min(bounds.right, x + step * 0.5), bounds.bottom);
  }
  lines.stroke({ color: 0xff8844, width: 1, alpha: 0.5 });
}

/** Formatting occurs only on the throttled inspection sampler. */
function boundsReadout(streamScene) {
  const physical = streamScene.simulation.bounds;
  const render = streamScene.manifest.bounds;
  const map = streamScene.manifest.physics.map;
  return [
    `physical clip domain L=${physical.left} R=${physical.right} T=${physical.top} B=${physical.bottom}`,
    `render bounds L=${render.left} R=${render.right} T=${render.top} B=${render.bottom}`,
    `authored VR L=${map.VRLeft ?? "absent"} R=${map.VRRight ?? "absent"} T=${map.VRTop ?? "absent"} B=${map.VRBottom ?? "absent"} VRLimit=${map.VRLimit ?? "absent"}`,
    "orange=physical X/top clip; dashed bottom=initialization only, NOT an air floor",
    "blue=render bounds; purple=authored VR (zero edges do not restrict physics)",
  ].join("\n");
}

/** @param {object} overlay @param {object} streamScene @param {object} onlineScene */
function updateReadout(overlay, streamScene, onlineScene) {
  const sim = streamScene.simulation;
  const mobCount = overlay._activeMobCount ?? 0;
  overlay.readout.textContent = [
    `state=${sim.state} action=${sim.action} foothold=${sim.footholdId} prev=${sim.foothold?.prevId ?? "none"} next=${sim.foothold?.nextId ?? "none"} ladder=${sim.ladderId}`,
    `position=${sim.x.toFixed(3)},${sim.y.toFixed(3)} velocity=${sim.vx.toFixed(3)},${sim.vy.toFixed(3)} px/s`,
    `contact plane=${sim.contactLayer} group=${sim.contactGroup}; space group=${sim.spaceGroup}`,
    boundsReadout(streamScene),
    `body=cyan attack=amber damage=pink mob.body=green; white cross=feet`,
    `active mob rects=${mobCount}/${MAX_MOB_RECTS}; self.views.size=${onlineScene.views?.size ?? 0}`,
    `blocked=${JSON.stringify(sim.blocked)} original attack activation=unverified; geometry unresolved=${overlay.shapes.unknown}`,
  ].join("\n");
}

/** Look up the authored attack rectangle from catalog for a given weapon + action. */
function getAttackRectangle(catalog, weaponType, actionName) {
  if (!catalog?.ui?.avatar?.entries) return null;
  for (const entry of Object.values(catalog.ui.avatar.entries)) {
    if (entry.combat?.weaponType !== weaponType) continue;
    const action = entry.combat.attacks?.[actionName];
    if (action?.rectangle) return action.rectangle;
  }
  return null;
}

/** @param {object} overlay @param {object} streamScene @param {object} onlineScene */
function updateShapes(overlay, streamScene, onlineScene) {
  const context = overlay.context;
  const sim = streamScene.simulation;
  context.action = sim.action;
  context.attacking = sim.diagnostics.unsupportedAttack === true;
  for (const entity of streamScene.entities) {
    if (entity.id !== "character") continue;
    context.frame = entity.frame;
    context.elapsedMs = entity.actionTimeMs;
    break;
  }
  const pose = streamScene.presentation ?? sim;
  applyPreview(context, streamScene.hitboxPreview, pose);
  updateHitboxes(overlay.shapes, pose, context);
  for (let index = 0; index < SHAPE_NAMES.length; index++) {
    placeRectangle(
      overlay.rectangles[index],
      overlay.shapes[SHAPE_NAMES[index]],
    );
  }
  overlay.velocity.width = Math.hypot(sim.vx, sim.vy) * VELOCITY_SCALE;
  overlay.velocity.height = 2;
  overlay.velocity.rotation = Math.atan2(sim.vy, sim.vx);
  overlay.velocity.position.set(pose.x, pose.y);
  overlay.contact[0].position.set(pose.x - 3, pose.y);
  overlay.contact[1].position.set(pose.x, pose.y - 3);

  // ---- Self real-time attack body (amber) ----
  // Override the static preview attack rect with the real-time one from entity data.
  const selfView = onlineScene.views?.get?.(onlineScene.selfId);
  if (selfView?.entity?.combatState?.phase === "attack") {
    const actionName = selfView.entity.action;
    const weaponType = selfView.entity.avatar?.combat?.weaponType;
    if (weaponType && actionName && overlay.catalog) {
      const rect = getAttackRectangle(overlay.catalog, weaponType, actionName);
      if (rect) {
        placeAuthoredRectangle(
          overlay.rectangles[1],  // amber = attack
          rect,
          selfView.drawX ?? selfView.entity.position?.x ?? sim.x,
          selfView.drawY ?? selfView.entity.position?.y ?? sim.y,
          selfView.entity.facing > 0 ? 1 : -1,
        );
      }
    }
  }

  // ---- Mob body rectangles (green) ----
  let mobIndex = 0;
  const viewValues = onlineScene.views?.values?.() ?? [];
  for (const view of viewValues) {
    const entity = view.entity;
    if (!entity || entity.kind !== "mob") continue;
    if (mobIndex >= MAX_MOB_RECTS) break;
    const mobEdges = overlay.mobRects[mobIndex];
    let bodyRect = null;
    try {
      const actionData = view.life?.actions?.[view.animation?.action];
      const frames = actionData?.frames;
      if (frames?.length) {
        const frameIdx = Math.max(0, Math.min(view.animation?.frame ?? 0, frames.length - 1));
        bodyRect = frames[frameIdx].body;
      }
    } catch { /* ignore */ }
    if (bodyRect) {
      placeAuthoredRectangle(
        mobEdges,
        bodyRect,
        view.drawX,
        view.drawY,
        entity.facing > 0 ? 1 : -1,
      );
      mobIndex++;
    } else {
      for (let i = 0; i < 4; i++) mobEdges[i].visible = false;
    }
  }
  for (; mobIndex < MAX_MOB_RECTS; mobIndex++) {
    const mobEdges = overlay.mobRects[mobIndex];
    for (let i = 0; i < 4; i++) mobEdges[i].visible = false;
  }
  overlay._activeMobCount = mobIndex;
}

function contactSprites(container) {
  const horizontal = lineSprite(container, 0xffffff);
  const vertical = lineSprite(container, 0xffffff);
  horizontal.width = 7;
  horizontal.height = 1;
  vertical.width = 1;
  vertical.height = 7;
  return [horizontal, vertical];
}

/** Preview placement follows the inspected actor; activation remains explicitly unknown. */
function applyPreview(context, preview, pose) {
  context.attack = preview?.attack ?? null;
  context.damage = preview?.damage ?? null;
  context.body = preview?.body ?? null;
  if (!context.damage) return;
  context.damage.x = pose.x;
  context.damage.y = pose.y;
  context.damage.facing = pose.facing;
}
/** @param {object} overlay @param {object} onlineScene @param {boolean} enabled */
function updateOverlay(overlay, onlineScene, enabled) {
  const streamScene = onlineScene?.scene;
  const visible = enabled && Boolean(streamScene?.simulation);
  overlay.scene = streamScene;
  overlay.onlineScene = onlineScene;

  overlay.container.visible = visible;
  overlay.readout.hidden = !visible;
  if (!visible) return;
  if (
    overlay.manifest !== streamScene.manifest ||
    overlay.simulation !== streamScene.simulation
  ) {
    drawFootholds(overlay, streamScene);
  }
  overlay.container.position.set(-streamScene.camera.x, -streamScene.camera.y);
  updateShapes(overlay, streamScene, onlineScene);
}

/** World-space geometry and side-panel diagnostic text; no guessed sprite hitboxes.
 * @param {import('pixi.js').Application} app initialized WebGL application
 * @param {HTMLElement} inspectionHost side-panel diagnostic destination
 * @param {object} catalog loaded catalog.json for weapon attack rectangle lookup
 */
export function createDebugOverlay(app, inspectionHost, catalog) {
  const container = new Container({ label: "physics-debug", zIndex: 1000000 });
  const lines = new Graphics();
  container.addChild(lines);
  const readout = document.createElement("pre");
  readout.className = "physics-debug-readout";
  readout.hidden = true;
  inspectionHost.appendChild(readout);
  app.stage.addChild(container);

  // Pre-allocate mob body rectangles (green)
  const mobRects = [];
  for (let i = 0; i < MAX_MOB_RECTS; i++) {
    mobRects.push(rectangleSprites(container, MOB_COLOR));
  }

  const overlay = {
    container,
    lines,
    readout,
    manifest: null,
    simulation: null,
    scene: null,
    catalog: catalog ?? null,
    shapes: createHitboxState(),
    context: { action: "", frame: 0, elapsedMs: 0, attacking: false },
    rectangles: SHAPE_COLORS.map((color) => rectangleSprites(container, color)),
    mobRects,
    velocity: lineSprite(container, 0xffffff),
    contact: contactSprites(container),
    _activeMobCount: 0,
  };
  const sampler = setInterval(() => {
    if (overlay.container.visible && overlay.scene) {
      updateReadout(overlay, overlay.scene, overlay.onlineScene);
    }
  }, READOUT_INTERVAL_MS);
  return {
    snapshot() {
      return overlay.container.visible ? structuredClone(overlay.shapes) : null;
    },
    update(onlineScene, enabled) {
      updateOverlay(overlay, onlineScene, enabled);
    },
    destroy() {
      clearInterval(sampler);
      readout.remove();
      container.destroy({ children: true });
    },
  };
}
