import { createHash } from "node:crypto";
import { at, resolveNode, value } from "../src/assets/image.js";
import { extractMapleTV } from "./mapletv-data.js";
import { effectFrames } from "./audiovisual-data.js";
import { mobMovementMetadata } from "../src/combat/mob-movement-metadata.js";

const MAX_PLACEMENTS = 4096;
const MAX_TEMPLATES = 8192;
const MAX_ACTIONS = 128;
const MAX_FRAMES = 1024;
const MAX_METADATA = 32768;
const MAX_LINKS = 32;
const MAX_SPEECH = 256;
const MAX_TELEVISIONS = 128;
// Extraction context owns this cache; no runtime/global residency is introduced.
const caches = new WeakMap();

/** Preserve authored optional scalar/vector fields without inventing defaults.
 * An action's `context` omits only the recorded dangling frame UOL. */
export function fields(node, context = null) {
  const result = Object.create(null);
  if (!node) return result;
  const entries = Object.entries(resolveNode(node).children);
  if (entries.length > MAX_METADATA) {
    throw new Error("Life metadata exceeds policy");
  }
  for (const [key, child] of entries) {
    if (context && danglingFrameUol(context, child)) continue;
    const resolved = resolveNode(child);
    if (resolved.value !== undefined) result[key] = resolved.value;
  }
  return result;
}

/** Lossless nonpixel tree including unresolved UOL text, for extraction provenance. */
function metadata(root) {
  const rows = [];
  const queue = [{ node: root, path: "", depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const { node, path, depth } = queue[index];
    if (depth > 64) throw new Error("Life metadata depth exceeds policy");
    const row = { path, type: node.type };
    if (node.value !== undefined) row.value = node.value;
    if (node.type === "Canvas") {
      row.width = node.width;
      row.height = node.height;
    }
    rows.push(row);
    for (const [key, child] of Object.entries(node.children)) {
      if (queue.length >= MAX_METADATA) {
        throw new Error("Life metadata exceeds policy");
      }
      queue.push({
        node: child,
        path: path ? `${path}/${key}` : key,
        depth: depth + 1,
      });
    }
  }
  return rows;
}

/** Original Mob links chain (0067cf06); NPC loader redirects artwork once (006dce02). */
export function linkedImage(context, kind, id) {
  const archive = kind === "npc" ? "Npc" : "Mob";
  const original = context.image(archive, `${id}.img`);
  const chain = [
    { source: `${archive}.wz:${id}.img`, metadata: metadata(original) },
  ];
  const seen = new Set([id]);
  let node = original;
  for (let hop = 0; hop < MAX_LINKS; hop++) {
    const info = at(node, "info");
    const link = value(info, "link");
    if (link === undefined) return { original, node, chain };
    if (typeof link !== "string" || !/^\d{1,7}$/.test(link)) {
      throw new Error(`Unsupported life link ${archive}:${link}`);
    }
    const next = link.padStart(7, "0");
    if (seen.has(next)) throw new Error(`Cyclic life link ${archive}:${next}`);
    seen.add(next);
    node = context.image(archive, `${next}.img`);
    chain.push({
      source: `${archive}.wz:${next}.img`,
      metadata: metadata(node),
    });
    if (kind === "npc") return { original, node, chain };
  }
  throw new Error("Life link chain exceeds policy");
}

/** Strict WZ integer/string delay boundary; NPC absent delay is 180 ms at 0040de3a. */
export function delayValue(raw, kind) {
  if (raw === undefined) return kind === "npc" ? 180 : null;
  if (
    typeof raw !== "number" &&
    !(typeof raw === "string" && /^\d+$/.test(raw))
  ) {
    throw new Error("Invalid life frame delay");
  }
  const ms = Number(raw);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 60000) {
    throw new Error("Life frame delay exceeds policy");
  }
  return ms === 0 ? null : ms;
}

export function bodyRectangle(frame) {
  const lt = value(frame, "lt"),
    rb = value(frame, "rb");
  for (const corner of [lt, rb]) {
    if (
      corner !== undefined &&
      (!corner || ![corner.x, corner.y].every(Number.isFinite))
    ) {
      throw new Error("Incomplete life body rectangle");
    }
  }
  // 0040cd9a/0040cda7 -> 0040ce24: either absent corner installs an empty body.
  // docs/ghidra-client-corrections/iteration-mob-missing-corner.txt retains original code.
  if (lt === undefined || rb === undefined) return null;
  if (lt.x > rb.x || lt.y > rb.y) {
    throw new Error("Inverted life body rectangle");
  }
  return { left: lt.x, top: lt.y, right: rb.x, bottom: rb.y };
}

function actionAlpha(canvas, key, inherited) {
  const alpha = value(canvas, key, -1);
  return alpha < 0 ? inherited : alpha;
}

export function lifeOrigin(canvas) {
  const origin = value(canvas, "origin");
  if (!origin || ![origin.x, origin.y].every(Number.isFinite)) {
    throw new Error("Life canvas lacks a valid original origin");
  }
  return origin;
}

/**
 * Npc.wz:2111000.img say/14 is UOL "../4". PCOM 50c0fd6f joins a UOL to its owning
 * directory (docs/asset-evidence.md), giving the absent Npc/2111000.img/4. The
 * original client's runtime handling of a missing frame target is unrecovered; only
 * this exact frame of these exact image bytes is omitted, so a changed input fails again.
 */
export const DANGLING_NPC_FRAME_UOL = Object.freeze({
  code: "dangling-npc-frame-uol",
  source: "Npc.wz:2111000.img",
  field: "say/14",
  raw: "../4",
  sha256: "f5b174528fbcc11db46e65dd0ba140ad250443aad9cd1d8a26c69f2c128970a3",
  normalized: null,
  evidence:
    "PCOM.dll 50c0f3e7/50c0fca8/50c0fd6f textual UOL join; docs/asset-evidence.md UOL base; client handling of a missing target unrecovered",
});

/** True only for the recorded dangling frame UOL; context.sourceSha256 reads original IMG bytes. */
export function danglingFrameUol(context, frame) {
  const action = frame?.parent,
    root = action?.parent,
    known = DANGLING_NPC_FRAME_UOL;
  return (
    frame.type === "UOL" &&
    frame.value === known.raw &&
    `${action.name}/${frame.name}` === known.field &&
    root?.parent === null &&
    root.source === known.source &&
    context.sourceSha256(root.source) === known.sha256
  );
}

/** Parts retain shared artwork hashes and original origins; timing never uses context.frames defaults. */
async function extractAction(context, node, kind) {
  const keys = Object.keys(node.children).filter(
    (key) =>
      /^\d+$/.test(key) && !danglingFrameUol(context, node.children[key]),
  );
  keys.sort((a, b) => Number(a) - Number(b));
  if (!keys.length || keys.length > MAX_FRAMES) {
    throw new Error("Invalid life frame count");
  }
  const frames = [],
    geometry = [];
  let timingKnown = true,
    carriedAlpha = 255;
  for (const key of keys) {
    const canvas = at(node, key);
    if (canvas.type !== "Canvas") {
      throw new Error(`Unsupported life frame ${key}`);
    }
    const raw = value(canvas, "delay");
    const delay = delayValue(raw, kind);
    if (delay === null) timingKnown = false;
    const origin = lifeOrigin(canvas);
    // 006657de applies authored a0/a1; omitted endpoints inherit the prior alpha.
    const start = actionAlpha(canvas, "a0", carriedAlpha),
      end = actionAlpha(canvas, "a1", start);
    const part = await context.part(canvas);
    part.opacity = start / 255;
    frames.push({ delay: delay ?? 0, parts: [part], alphaEnd: end / 255 });
    carriedAlpha = end;
    geometry.push({
      key,
      delayRaw: raw ?? null,
      delayMs: delay,
      origin,
      body: bodyRectangle(canvas),
      width: canvas.width,
      height: canvas.height,
    });
  }
  // The shared contract permits a zero-duration static frame, not timed zero-delay sequences.
  // Preserve every authored frame in metadata but expose only the untimed first-frame preview.
  if (!timingKnown) {
    frames.length = 1;
    frames[0].delay = 0;
  }
  return {
    frames,
    metadata: {
      timingKnown,
      properties: fields(node, context),
      frames: geometry,
    },
  };
}

/** Original name/function lookup retains missing strings and flags separately from artwork links. */
export async function extractTemplate(context, kind, id) {
  const linked = linkedImage(context, kind, id);
  const infoNode = at(kind === "mob" ? linked.node : linked.original, "info");
  const strings = context.image(
    "String",
    kind === "npc" ? "Npc.img" : "Mob.img",
  );
  const stringNode = strings.children[String(Number(id))];
  const stringsFields = fields(stringNode);
  const { actions, actionMetadata } = await extractTemplateActions(
    context,
    linked.node,
    kind,
  );
  const combat =
    kind === "mob" ? mobCombat(infoNode, actionMetadata, linked.node) : null;
  const info = fields(infoNode);
  const movement = kind === "mob" ? mobMovementMetadata(info, actions) : null;
  const defaultAction = defaultLifeAction(actions, movement);
  const artworkHash = createHash("sha256")
    .update(JSON.stringify(actions))
    .digest("hex");
  return {
    actions,
    metadata: {
      key: `${kind}:${id}`,
      kind,
      originalId: id,
      artworkHash,
      name: stringsFields.name ?? null,
      function: stringsFields.func ?? null,
      info,
      sources: linked.chain,
      actions: actionMetadata,
      defaultAction,
      speech: kind === "npc" ? npcSpeech(linked, stringNode, actions) : null,
      artworkStatus: defaultAction
        ? "original-action-artwork"
        : "unavailable: no original action canvases",
      combat,
      movement,
      stringSource: `String.wz:${kind === "npc" ? "Npc" : "Mob"}.img/${Number(id)}`,
    },
  };
}

function defaultLifeAction(actions, movement) {
  if (movement?.type === 3 || (!actions.stand && actions.fly)) return "fly";
  if (actions.stand) return "stand";
  return Object.keys(actions)[0] ?? null;
}

/** Extract only original action canvas branches; retain each timing/body record. */
export async function extractTemplateActions(context, root, kind) {
  const actions = Object.create(null);
  const actionMetadata = Object.create(null);
  const branches = Object.entries(root.children);
  if (branches.length > MAX_ACTIONS) {
    throw new Error("Life action count exceeds policy");
  }
  for (const [name, child] of branches) {
    if (name === "info") continue;
    const action = resolveNode(child);
    if (!action.children["0"]) continue;
    if (at(action, "0").type !== "Canvas") continue;
    const extracted = await extractAction(context, action, kind);
    actions[name] = extracted.frames;
    actionMetadata[name] = extracted.metadata;
  }
  return { actions, actionMetadata };
}

/** 006dce02 resolves speak keys against the original-id String/Npc record. */
function speechRows(node, strings) {
  const rows = Object.entries(node?.children ?? {});
  if (rows.length > MAX_SPEECH) {
    throw new Error("NPC speech count exceeds policy");
  }
  return rows.map(([index, child]) => {
    const key = resolveNode(child).value;
    const text = strings?.children?.[key]?.value;
    if (
      text !== undefined &&
      (typeof text !== "string" || text.length > MAX_SPEECH)
    ) {
      throw new Error("NPC speech text exceeds policy");
    }
    return { index, key: key ?? null, text: text ?? null };
  });
}

/** Ordinary action choices exclude stand/move and authored special actions (006de126). */
function npcSpeech(linked, strings, actions) {
  const choices = [];
  for (const name of Object.keys(actions)) {
    const branch = at(linked.node, name);
    if (name === "stand" || name === "move" || value(branch, "special", 0)) {
      continue;
    }
    choices.push({
      action: name,
      lines: speechRows(branch.children.speak, strings),
      durationMs: actions[name].reduce(
        (total, frame) => total + frame.delay,
        0,
      ),
    });
  }
  return {
    lines: speechRows(at(linked.original, "info").children.speak, strings),
    actions: choices,
    source: "006d2c8c/006d20b1/006d271f; original NPC speak keys",
  };
}

/** Native world indicators use QuestIcon0/1/2, not journal decoration or icon3+. */
export async function extractNpcWorldUI(context) {
  const root = context.image("UI", "UIWindow.img");
  const actions = Object.create(null);
  for (let state = 0; state < 3; state++) {
    actions[state] = (
      await effectFrames(context, at(root, `QuestIcon/${state}`))
    ).frames;
  }
  const entity = {
    id: "npc-quest-marker",
    kind: "effect",
    order: 0,
    x: 0,
    y: 0,
    z: 3,
    visible: false,
    flip: false,
    opacity: 1,
    action: "0",
    actions,
  };
  return {
    markers: await context.bundle({
      id: "npc-quest-markers",
      entities: [entity],
      metadata: { source: "UI.wz:UIWindow.img/QuestIcon/{0,1,2}" },
    }),
  };
}

/** Preserve executable type-0 inputs and classify other attack families explicitly. */
function mobCombat(info, actions, root) {
  const allowed = info.children.damagedBySelectedSkill;
  const allowedSkills = allowed ? Object.values(fields(allowed)) : [];
  if (!allowedSkills.every(Number.isSafeInteger)) {
    throw new Error("Invalid selected-skill mob restriction");
  }
  const attacks = [];
  for (const name of Object.keys(actions)) {
    if (!/^attack\d+$/.test(name)) continue;
    attacks.push(mobAttack(name, actions[name], root));
  }
  return { allowedSkills, attacks };
}

function mobAttack(name, metadata, root) {
  const action = at(root, name);
  const node = action.children.info ? at(action, "info") : null;
  const properties = node ? fields(node) : {};
  const range = node?.children.range ? bodyRectangle(at(node, "range")) : null;
  const supported =
    properties.type === 0 &&
    !!range &&
    Number.isSafeInteger(properties.attackAfter) &&
    properties.attackAfter >= 0 &&
    metadata.timingKnown;
  return {
    action: name,
    properties,
    rectangle: range,
    supported,
    status: supported
      ? "type-0-area; local selection/eligibility/damage"
      : "unavailable attack type, timing or geometry; no synthetic projectile/summon",
  };
}

/** Validate one authored placement coordinate independently for aggregate preflight. */
export function placementCoordinate(authored, key, mapId) {
  if (key !== "x" && key !== "y" && authored[key] === undefined) return;
  if (
    !Number.isSafeInteger(authored[key]) ||
    Math.abs(authored[key]) > 1000000
  ) {
    throw new Error(`Invalid life ${key} on ${mapId}`);
  }
}

export function placement(node, mapId) {
  const authored = fields(node);
  if (!/^(m|n)$/.test(authored.type) || !/^\d{1,7}$/.test(authored.id)) {
    throw new Error(`Invalid life template reference on ${mapId}`);
  }
  for (const key of ["x", "y", "fh", "cy", "rx0", "rx1"]) {
    placementCoordinate(authored, key, mapId);
  }
  if (authored.rx0 > authored.rx1) {
    throw new Error("Inverted life authored range");
  }
  const kind = authored.type === "n" ? "npc" : "mob";
  return {
    id: `life:${node.name}`,
    template: `${kind}:${authored.id.padStart(7, "0")}`,
    kind,
    authored,
    source: `Map.wz:Map/Map${mapId[0]}/${mapId}.img/life/${node.name}`,
  };
}

/** Match original foothold drawing planes without making authored fh a live contact. */
function placementPlanes(map) {
  const planes = new Map();
  const root = map.children.foothold ? at(map, "foothold") : null;
  if (!root) return planes;
  for (const layer of Object.values(root.children)) {
    for (const group of Object.values(layer.children)) {
      for (const segment of Object.values(group.children)) {
        if (planes.size >= 65536) {
          throw new Error("Life foothold count exceeds policy");
        }
        const plane = (Number(layer.name) * 3000 - Number(group.name)) * 10;
        if (!Number.isSafeInteger(plane)) {
          throw new Error("Invalid life foothold plane");
        }
        planes.set(Number(segment.name), {
          plane,
          x1: value(segment, "x1"),
          y1: value(segment, "y1"),
          x2: value(segment, "x2"),
          y2: value(segment, "y2"),
        });
      }
    }
  }
  return planes;
}

/** World entities use the shared region/atlas contract, never a second life texture loader. */
function lifeEntity(record, template, planes) {
  const segment = planes.get(record.authored.fh);
  let x = record.authored.x;
  let y = record.authored.y;
  // 006d089a -> 009c1d70 -> 009b12a8/009b1553 initializes on the supplied
  // contact segment, not on the slightly airborne map-editor placement.
  if (record.kind === "npc" && segment && segment.x2 > segment.x1) {
    x = Math.max(segment.x1, Math.min(segment.x2, x));
    y =
      segment.y1 +
      ((x - segment.x1) * (segment.y2 - segment.y1)) /
        (segment.x2 - segment.x1);
  }
  return {
    id: record.id,
    kind: record.kind,
    order: 100000 + Number(record.id.slice(5)),
    x: Math.trunc(x),
    y: Math.trunc(y),
    z:
      template.metadata.movement?.type === 3
        ? 270100
        : (record.kind === "npc" ? 29995 : 29900) + (segment?.plane ?? 210000),
    visible: record.authored.hide !== 1,
    // Cosmic spawnNPC sends f!=1; native006d232a flips when the received bit is0.
    flip:
      record.kind === "npc" ? record.authored.f === 1 : record.authored.f === 0,
    opacity: 1,
    action: template.metadata.defaultAction,
    actions: template.actions,
  };
}

function lifeManifest(mapId, placements, templates, mapleTV) {
  return {
    schemaVersion: 1,
    mode: "metadata-preview",
    activationKnown: false,
    mapId,
    placements,
    templates,
    mapleTV,
    policies: {
      placementFacing:
        "NPC authored f=1 mirrors: Cosmic spawnNPC f!=1 then native006d232a bit==0; mob preview f=0 mirrors",
      depth:
        "NPC006d267d, mob00664e35; fly controller3 uses270100, otherwise authored foothold plane or uncontacted plane7/group0; boss overrides unavailable",
      ground:
        "NPC anchor projected to authored finite floor via009b1553; canvas origin remains literal; map y/cy retained separately",
      placementHide: "preview suppression only; live server activation unknown",
      actionSelection:
        "stand or explicit local preview; no automatic transitions",
      missingMobDelay: "unsupported; action frozen",
      missingNpcDelayMs: 180,
      regionReload: "preview action/time retained by LifeSystem",
    },
  };
}

/** Offline metadata inventory only; original actors originate in pool/network consumers. */
export async function extractLife(context, map, mapId) {
  if (!/^\d{9}$/.test(mapId)) throw new Error("Invalid life map id");
  if (!caches.has(context)) caches.set(context, new Map());
  const cache = caches.get(context);
  const entities = [],
    placements = [],
    mapleTV = [],
    templates = Object.create(null);
  const planes = placementPlanes(map);
  const children = map.children.life
    ? Object.values(at(map, "life").children)
    : [];
  if (children.length > MAX_PLACEMENTS) {
    throw new Error("Life placement count exceeds policy");
  }
  for (const child of children) {
    if (!/^\d+$/.test(child.name)) {
      throw new Error("Invalid authored life index");
    }
    const record = placement(child, mapId);
    if (!cache.has(record.template)) {
      if (cache.size >= MAX_TEMPLATES) {
        throw new Error("Life template count exceeds policy");
      }
      cache.set(
        record.template,
        await extractTemplate(
          context,
          record.kind,
          record.authored.id.padStart(7, "0"),
        ),
      );
    }
    const template = cache.get(record.template);
    templates[record.template] = template.metadata;
    placements.push(record);
    if (template.metadata.defaultAction) {
      const actor = lifeEntity(record, template, planes);
      entities.push(actor);
      if (record.kind === "npc" && template.metadata.info.MapleTV) {
        await appendTelevision(context, actor, template.metadata.info, {
          entities,
          mapleTV,
        });
      }
    }
  }
  await appendInvasionTemplates(context, mapId, {
    cache,
    templates,
    entities,
    planes,
  });
  return {
    entities,
    life: lifeManifest(mapId, placements, templates, mapleTV),
  };
}

/**
 * Published transport invasions (Boats Crimson Balrog) spawning on this map have
 * no placement: package the template and artwork so the server can spawn them.
 */
async function appendInvasionTemplates(context, mapId, output) {
  const { cache, templates, entities, planes } = output;
  const spawns = Object.values(context.transportSchedules ?? {}).flatMap(
    (schedule) =>
      schedule.invasion?.spawns.filter(
        (row) => String(row.mapId).padStart(9, "0") === mapId,
      ) ?? [],
  );
  for (const row of spawns) {
    const id = String(row.mobId).padStart(7, "0");
    const key = `mob:${id}`;
    if (templates[key]) continue;
    if (!cache.has(key)) {
      cache.set(key, await extractTemplate(context, "mob", id));
    }
    const template = cache.get(key);
    templates[key] = template.metadata;
    const record = {
      id: `invasion:${id}`,
      kind: "mob",
      authored: { x: row.x, y: row.y, fh: 0, f: 1, hide: 0 },
    };
    // Packaging keys this placement-less artwork by template.
    entities.push({ ...lifeEntity(record, template, planes), template: key });
  }
}

async function appendTelevision(context, actor, info, output) {
  if (output.mapleTV.length >= MAX_TELEVISIONS) {
    throw new Error("MapleTV placement count exceeds policy");
  }
  const television = await extractMapleTV(context, actor, info);
  output.entities.push(...television.entities);
  output.mapleTV.push(television.controller);
}
