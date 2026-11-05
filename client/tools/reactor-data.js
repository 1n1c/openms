import { at, value, resolveNode } from "../src/assets/image.js";
import { publishSound } from "./audiovisual-data.js";

const MAX_PLACEMENTS = 4096;
const MAX_STATES = 256;
const MAX_EVENTS = 256;
const MAX_FRAMES = 1024;
const MAX_NODES = 32768;
const MAX_LINKS = 32;
const MAX_TEMPLATES = 512;
const MAX_FOOTHOLDS = 65536;
const FRAME_DELAY_MS = 120; // 007348a0 -> 0043ea3e -> 0043f768.
const caches = new WeakMap();

/** Complete typed nonpixel metadata, including UOLs and misspelled original fields. */
function metadata(root) {
  const queue = [{ node: root, path: "" }],
    rows = [];
  for (let index = 0; index < queue.length; index++) {
    const { node, path } = queue[index];
    const row = { path, type: node.type };
    if (node.value !== undefined) row.value = node.value;
    if (node.type === "Canvas") {
      row.width = node.width;
      row.height = node.height;
      row.format = node.format;
      row.scale = node.scale;
    }
    rows.push(row);
    for (const child of Object.values(node.children)) {
      if (queue.length >= MAX_NODES) {
        throw new Error("Reactor metadata bound exceeded");
      }
      queue.push({
        node: child,
        path: path ? `${path}/${child.name}` : child.name,
      });
    }
  }
  return rows;
}

function numericChildren(node, maximum) {
  if (!node) return [];
  const keys = Object.keys(resolveNode(node).children).filter((key) =>
    /^\d+$/.test(key),
  );
  if (keys.length > maximum) {
    throw new Error("Reactor collection bound exceeded");
  }
  return keys.sort((a, b) => Number(a) - Number(b));
}

/** 00739a92/0073a865 redirects info/link; each original IMG stays authoritative. */
export function linkedTemplate(context, id) {
  let current = id;
  const seen = new Set(),
    sources = [];
  for (let hop = 0; hop < MAX_LINKS; hop++) {
    if (!/^\d{7}$/.test(current) || seen.has(current)) {
      throw new Error("Invalid reactor link chain");
    }
    seen.add(current);
    const path = `${current}.img`,
      root = context.image("Reactor", path);
    sources.push({ source: `Reactor.wz:${path}`, metadata: metadata(root) });
    const link = value(root.children.info, "link", null);
    if (link === null) return { root, sources, resolvedId: current };
    current = String(link).padStart(7, "0");
  }
  throw new Error("Reactor link chain exceeds bound");
}

async function artwork(context, node) {
  const keys = numericChildren(node, MAX_FRAMES);
  if (!keys.length) return null;
  const frames = await context.frames(node);
  if (keys.length !== frames.length) {
    throw new Error("Reactor frame coverage mismatch");
  }
  const bounds = {
    left: Infinity,
    top: Infinity,
    right: -Infinity,
    bottom: -Infinity,
  };
  let duration = 0;
  for (let index = 0; index < keys.length; index++) {
    const frame = at(node, keys[index]),
      origin = value(frame, "origin", { x: 0, y: 0 });
    const delay = Number(value(frame, "delay", FRAME_DELAY_MS));
    if (!Number.isSafeInteger(delay) || delay < 0) {
      throw new Error("Invalid reactor frame delay");
    }
    frames[index].delay = delay;
    duration += delay;
    bounds.left = Math.min(bounds.left, -origin.x);
    bounds.top = Math.min(bounds.top, -origin.y);
    bounds.right = Math.max(bounds.right, frame.width - origin.x);
    bounds.bottom = Math.max(bounds.bottom, frame.height - origin.y);
  }
  return { frames, bounds, duration };
}

export function eventRecord(node) {
  const type = Number(value(node, "type")),
    state = Number(value(node, "state"));
  if (
    !Number.isSafeInteger(type) ||
    !Number.isSafeInteger(state) ||
    state < -1 ||
    state >= MAX_STATES
  ) {
    throw new Error("Invalid reactor event transition");
  }
  const skills = numericChildren(node.children.activeSkillID, MAX_EVENTS).map(
    (key) => Number(value(node.children.activeSkillID, key)),
  );
  return {
    id: Number(node.name),
    type,
    state,
    itemId: Number(value(node, "0", 0)),
    count: Number(value(node, "1", 0)),
    itemOption: value(node, "2", null),
    message: value(node, "message", null),
    hit: null,
    hitMs: 0,
    lt: value(node, "lt", null),
    rb: value(node, "rb", null),
    skills,
    status: [0, 1, 2, 5, 100, 101].includes(type)
      ? "local-data-transition"
      : "unavailable-event-consumer",
  };
}

/** Project authored idle/hit resources into the shared action table. */
async function stateArtwork(context, node, actions, id) {
  const art = await artwork(context, node);
  const idle = art ? `state:${id}` : null;
  if (art) actions[idle] = art.frames;
  const hitArt = node.children.hit
    ? await artwork(context, at(node, "hit"))
    : null;
  const hit = hitArt ? `hit:${id}` : null;
  if (hitArt) actions[hit] = hitArt.frames;
  return {
    idle,
    hit,
    bounds: art?.bounds ?? null,
    hitMs: hitArt?.duration ?? 0,
  };
}

async function stateEvents(context, node, actions, id) {
  const events = [];
  for (const key of numericChildren(node.children.event, MAX_EVENTS)) {
    const eventNode = at(node, `event/${key}`),
      event = eventRecord(eventNode);
    if (eventNode.children.hit) {
      const eventArt = await artwork(context, at(eventNode, "hit"));
      if (eventArt) {
        event.hit = `hit:${id}:${key}`;
        actions[event.hit] = eventArt.frames;
        event.hitMs = eventArt.duration;
      }
    }
    events.push(event);
  }
  return events;
}

export async function stateRecord(context, node, actions) {
  const id = Number(node.name);
  if (!Number.isSafeInteger(id) || id >= MAX_STATES) {
    throw new Error("Invalid reactor state index");
  }
  const art = await stateArtwork(context, node, actions, id);
  const events = await stateEvents(context, node, actions, id);
  const timeoutMs = Number(
    node.children.event ? value(node.children.event, "timeOut", 0) : 0,
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error("Invalid reactor timeOut");
  }
  return {
    id,
    idle: art.idle,
    hit: art.hit,
    repeat: Number(value(node, "repeat", 0)) !== 0,
    bounds: art.bounds,
    events,
    timeoutMs,
    hitMs: art.hitMs,
  };
}

/** Authored state first; missing hit assignments use original box PCM by requested browser policy. */
export function reactorHitSound(root, id, resolvedId, state) {
  const choices = [
    [Number(id), state, "authored"],
    [Number(resolvedId), state, "linked-artwork"],
    [2000, state, "fallback-box"],
    [2000, 0, "fallback-box"],
  ];
  for (const [familyId, soundState, assignment] of choices) {
    const family = root.children[familyId];
    const branch = family ? resolveNode(family).children[soundState] : null;
    const hit = branch ? resolveNode(branch).children.Hit : null;
    if (hit) {
      return {
        node: resolveNode(hit),
        source: `Sound.wz:Reactor.img/${familyId}/${soundState}/Hit`,
        assignment,
      };
    }
  }
  throw new Error("Original reactor fallback hit sound is missing");
}

async function reactorSounds(context, id, states, resolvedId) {
  const root = context.image("Sound", "Reactor.img"),
    sounds = {};
  for (const state of states) {
    // Timers/terminal decoration are not hits and do not need an invented cue.
    if (!state.events.some((event) => event.type !== 101)) continue;
    const hit = reactorHitSound(root, id, resolvedId, state.id);
    sounds[state.id] = {
      ...(await publishSound(context, hit.node, hit.source)),
      assignment: hit.assignment,
    };
  }
  return sounds;
}

async function extractTemplate(context, id) {
  const linked = linkedTemplate(context, id),
    actions = {},
    states = [];
  for (const key of numericChildren(linked.root, MAX_STATES)) {
    states.push(await stateRecord(context, at(linked.root, key), actions));
  }
  if (!states.some((state) => state.id === 0)) {
    throw new Error("Reactor has no initial state");
  }
  for (const state of states) {
    for (const event of state.events) {
      if (
        event.state >= 0 &&
        !states.some((target) => target.id === event.state)
      ) {
        event.status = "missing-target-state";
      }
      if (event.type === 101 && state.timeoutMs <= 0) {
        event.status = "missing-timeOut";
      }
    }
  }
  const original = context.image("Reactor", `${id}.img`);
  return {
    id,
    resolvedId: linked.resolvedId,
    sources: linked.sources,
    states,
    actions,
    action: value(original, "action", null),
    quest: value(original, "quest", null),
    info: metadata(at(linked.root, "info")),
    backTile: Number(value(at(linked.root, "info"), "backTile", 0)) !== 0,
    activateByTouch:
      Number(value(at(linked.root, "info"), "activateByTouch", 0)) !== 0,
    sounds: await reactorSounds(context, id, states, linked.resolvedId),
    authority: "provisional-local-event-transitions-no-script-rewards",
  };
}

function footholdY(node, x) {
  const x1 = value(node, "x1"),
    x2 = value(node, "x2");
  if (x1 === x2 || x < Math.min(x1, x2) || x > Math.max(x1, x2)) {
    return null;
  }
  const y1 = value(node, "y1"),
    y2 = value(node, "y2");
  return y1 + ((x - x1) * (y2 - y1)) / (x2 - x1);
}

/** Use the original foothold below placement; an unavailable plane stays explicitly local. */
function drawingDepth(map, placement, backTile) {
  let nearest = Infinity,
    depth = backTile ? 2000 : 29990,
    count = 0;
  for (const layer of Object.values(map.children.foothold?.children ?? {})) {
    for (const group of Object.values(layer.children)) {
      for (const node of Object.values(group.children)) {
        if (++count > MAX_FOOTHOLDS) {
          throw new Error("Reactor foothold bound exceeded");
        }
        const y = footholdY(node, placement.x);
        if (y === null || y < placement.y - 1 || y >= nearest) continue;
        nearest = y;
        // 00734d30 normal: B+29990+10*(plane*3000-group); 00734fb5 backTile: B+2000+plane*30000.
        // Reactor base (29800) must be LOWER than mob base (29900) so crates never cover mobs.
        depth = backTile
          ? 2000 + Number(layer.name) * 30000
          : 29800 + (Number(layer.name) * 3000 - Number(group.name)) * 10;
      }
    }
  }
  return depth;
}

export function placementRecord(node, template) {
  const x = Number(value(node, "x")),
    y = Number(value(node, "y"));
  const reactorTime = Number(value(node, "reactorTime", 0));
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isSafeInteger(reactorTime) ||
    reactorTime < -1
  ) {
    throw new Error("Invalid reactor placement");
  }
  return {
    id: `reactor:${node.name}`,
    templateId: template.id,
    x,
    y,
    flip: Number(value(node, "f", 0)) !== 0,
    name: value(node, "name", ""),
    // Original -1 and zero disable respawn; metadata retains the authored seconds.
    respawnMs: reactorTime > 0 ? reactorTime * 1000 : 0,
    metadata: metadata(node),
    entityId: null,
  };
}

async function cachedTemplate(context, cache, id) {
  if (!cache.has(id)) {
    if (cache.size >= MAX_TEMPLATES) {
      throw new Error("Reactor template bound exceeded");
    }
    cache.set(id, await extractTemplate(context, id));
  }
  return cache.get(id);
}

function reactorEntity(map, node, placement, template) {
  const firstAction = Object.keys(template.actions)[0];
  if (!firstAction) return null;
  placement.entityId = placement.id;
  return {
    id: placement.id,
    kind: "reactor",
    order: Number(node.name),
    x: placement.x,
    y: placement.y,
    z: drawingDepth(map, placement, template.backTile),
    visible: template.states[0].idle !== null,
    flip: placement.flip,
    opacity: 1,
    action: template.states[0].idle ?? firstAction,
    actions: template.actions,
  };
}

/** Region-owned artwork, scene-owned live state; no independent texture/cache ownership. */
export async function extractReactors(context, map, mapId) {
  if (!/^\d{9}$/.test(String(mapId))) throw new Error("Invalid reactor map id");
  const nodes = Object.values(map.children.reactor?.children ?? {});
  if (nodes.length > MAX_PLACEMENTS) {
    throw new Error("Reactor placement bound exceeded");
  }
  let cache = caches.get(context);
  if (!cache) {
    cache = new Map();
    caches.set(context, cache);
  }
  const templates = {},
    placements = [],
    entities = [];
  for (const node of nodes) {
    if (!/^\d+$/.test(node.name)) {
      throw new Error("Invalid reactor placement index");
    }
    const id = String(value(node, "id")).padStart(7, "0");
    const template = await cachedTemplate(context, cache, id),
      placement = placementRecord(node, template);
    templates[id] = template;
    const entity = reactorEntity(map, node, placement, template);
    if (entity) entities.push(entity);
    placements.push(placement);
  }
  const metadataTemplates = {};
  for (const [id, template] of Object.entries(templates)) {
    const description = { ...template };
    delete description.actions;
    metadataTemplates[id] = description;
  }
  return {
    entities,
    reactors: {
      schemaVersion: 1,
      mapId,
      placements,
      templates: metadataTemplates,
      provenance: "Reactor.wz; 00739a92,0073a16c,007348a0,007356c7,00736091",
      policy:
        "Local WZ event targets/offering/timeOut/respawn; never script rewards",
    },
  };
}
