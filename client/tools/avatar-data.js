import { at, value, resolveNode } from "../src/assets/image.js";
import { EXPRESSION_NAMES } from "../src/input/character-bindings.js";
import {
  AVATAR_ACTIONS,
  AVATAR_LIMITS,
  avatarSlots,
  composeAvatar,
  validateAvatarRecord,
  avatarSpeechHeights,
} from "../src/character/avatar-composition.js";
import { extractWeaponCombat } from "./combat-data.js";
import { applyWeaponAttackSpeed } from "../src/combat/weapon-usage.js";

const ORIGINAL_DELAY_MS = 150;
const MAX_ALIAS_HOPS = 64;

function sourcePath(node) {
  const parts = [];
  for (
    let depth = 0;
    node?.parent && depth < MAX_ALIAS_HOPS;
    depth++, node = node.parent
  ) {
    parts.push(node.name);
  }
  if (node?.parent) throw new Error("Avatar source path depth exceeded");
  return parts.reverse().join("/");
}

function unavailableNode(record, node, reason) {
  if (record.unresolved.length >= AVATAR_LIMITS.records) {
    throw new Error("Avatar unresolved resource bound exceeded");
  }
  const entry = {
    path: sourcePath(node),
    link: node.type === "UOL" ? node.value : null,
    reason,
  };
  if (node.type === "value") entry.value = node.value;
  record.unresolved.push(entry);
  return null;
}

/** Native optional resource boundary, not a permissive replacement for resolveNode.
 * PCOM50c0cf8f returns S_FALSE/VT_EMPTY for absent properties;00414ada resolves
 * UOLs through ResMan51003740;0041e42b maps empty to E_NOINTERFACE and0041371b
 * inserts only nonnull canvases. Other failures, including cycles, remain fatal. */
function avatarNode(node, record) {
  if (node?.type !== "UOL") return resolveNode(node);
  const visited = new Set();
  for (let hop = 0; node?.type === "UOL" && hop < MAX_ALIAS_HOPS; hop++) {
    if (visited.has(node)) {
      throw new Error(`Cyclic avatar UOL ${record.source}/${sourcePath(node)}`);
    }
    visited.add(node);
    const current = avatarLinkTarget(node, record);
    if (!current) return null;
    node = current;
  }
  if (node?.type === "UOL") {
    throw new Error("Avatar UOL traversal exceeded limit");
  }
  return resolveNode(node);
}

function avatarLinkTarget(node, record) {
  let current = node.parent;
  for (const key of node.value.split("/")) {
    if (key === "..") current = current?.parent;
    else if (key !== "." && key !== "") {
      if (current?.type === "UOL") {
        return unavailableNode(record, node, "missing-property-interface");
      }
      current = avatarPropertyChild(current, key, node);
    }
    if (!current) return unavailableNode(record, node, "missing-property");
  }
  return current;
}

function avatarPropertyChild(current, key, origin) {
  if (current && current.type !== "Property" && current.type !== "Canvas") {
    throw new Error(
      `Invalid avatar UOL property interface ${sourcePath(origin)}`,
    );
  }
  return current?.children[key];
}

/** 00406abd: aliases retain their own timing; UOLs are resolved by the original parser. */
function bodyPose(body, action, index) {
  const visited = new Set();
  let moveX = 0,
    moveY = 0;
  let rotate = 0,
    flip = false;
  for (let hop = 0; hop < MAX_ALIAS_HOPS; hop++) {
    const key = `${action}/${index}`;
    if (visited.has(key)) throw new Error(`Cyclic body action alias ${key}`);
    visited.add(key);
    const frame = at(body, key);
    const rotation = value(frame, "rotate", 0);
    if (![0, 90, 180, 270].includes(rotation)) {
      throw new Error(`Invalid original body rotation ${key}`);
    }
    rotate = (rotate + (flip ? -rotation : rotation) + 360) % 360;
    flip = flip !== Boolean(value(frame, "flip", 0));
    const move = value(frame, "move", { x: 0, y: 0 });
    if (!Number.isSafeInteger(move.x) || !Number.isSafeInteger(move.y)) {
      throw new Error(`Invalid ordinary body translation ${key}`);
    }
    moveX += move.x;
    moveY += move.y;
    const target = value(frame, "action");
    if (target === undefined) {
      if (frame.children.frame) {
        throw new Error(`Frame alias without action ${key}`);
      }
      return {
        action,
        index: Number(index),
        face: Boolean(value(frame, "face", 0)),
        moveX,
        moveY,
        rotate,
        flip,
        alias: hop > 0,
      };
    }
    const targetFrame = value(frame, "frame", 0);
    if (
      typeof target !== "string" ||
      !Number.isInteger(targetFrame) ||
      targetFrame < 0
    ) {
      throw new Error(`Invalid body action alias ${key}`);
    }
    action = target;
    index = String(targetFrame);
  }
  throw new Error("Body action alias traversal exceeded limit");
}

function frameIndices(root, sparse = false) {
  const keys = Object.keys(resolveNode(root).children).filter((key) =>
    /^\d+$/.test(key),
  );
  if (!keys.length || keys.length > AVATAR_LIMITS.frames) {
    throw new Error("Invalid avatar action frame count");
  }
  keys.sort((left, right) => Number(left) - Number(right));
  for (let index = 0; index < keys.length; index++) {
    const number = Number(keys[index]);
    if (!Number.isSafeInteger(number) || number >= AVATAR_LIMITS.frames) {
      throw new Error("Avatar frame index bound exceeded");
    }
    if (!sparse && number !== index) {
      throw new Error("Noncontiguous avatar frames");
    }
  }
  return keys;
}

function delayFor(frame) {
  //00414d40 returns the caller's150ms when a delay UOL resolves to a nonscalar canvas.
  const delay = value(frame, "delay", ORIGINAL_DELAY_MS) ?? ORIGINAL_DELAY_MS;
  if (!Number.isFinite(delay) || (delay < 0 && !frame.children.action)) {
    throw new Error("Invalid original avatar frame delay");
  }
  return Math.abs(delay);
}

/**0040138d assigns null zmap entries -1,-2,...;00774bb1 takes the maximum islot rank. */
export function avatarMaps(context) {
  const zmap = Object.keys(context.image("Base", "zmap.img").children);
  const smap = Object.create(null);
  for (const [name, node] of Object.entries(
    context.image("Base", "smap.img").children,
  )) {
    smap[name] = resolveNode(node).value;
  }
  if (zmap.length > 4096 || Object.keys(smap).length > 4096) {
    throw new Error("Avatar depth map bound exceeded");
  }
  return { zmap, smap };
}

/**00774901: empty z stays zero; named map overrides numeric z; failed conversion
 * and absent symbolic lookup retain INT_MIN. Unknown names are not canvas rejection. */
function depthRank(canvas, record, maps) {
  const z = value(canvas, "z");
  if (z === null || z === undefined) return 0;
  const index = maps.zmap.indexOf(String(z));
  if (index !== -1) return -index - 1;
  const numeric =
    typeof z === "number"
      ? z
      : typeof z === "string" && z.trim()
        ? Number(z)
        : NaN;
  if (
    Number.isInteger(numeric) &&
    numeric >= -2147483648 &&
    numeric <= 2147483647
  ) {
    return numeric;
  }
  if (typeof z !== "string") {
    throw new Error(`Unsupported avatar z variant ${typeof z}`);
  }
  unavailableNode(record, canvas.children.z, "unknown-z");
  return -2147483648;
}

/**00401835 admits objects,0040184b queries IWzShape2D,00401879 skips null.
 * Canvas5000375d/50014308 has no shape IID; scalar variants have no object.
 * The original Character map scan contains only vectors, scalars and canvases. */
function canvasAnchors(canvas, record) {
  const anchors = Object.create(null);
  //00401767 returns the origin-relative component unchanged when map has no property interface.
  if (!canvas.children.map) {
    unavailableNode(record, canvas, "missing-anchor-map");
    return anchors;
  }
  const children = Object.entries(at(canvas, "map").children);
  if (children.length > AVATAR_LIMITS.anchors) {
    throw new Error("Avatar anchor count bound exceeded");
  }
  for (const [name, node] of children) {
    if (node.type === "value" || node.type === "Canvas") {
      unavailableNode(record, node, "non-anchor-interface");
      continue;
    }
    if (node.type !== "Shape2D#Vector2D") {
      throw new Error(
        `Unsupported avatar anchor interface ${node.type} at ${sourcePath(node)}`,
      );
    }
    const point = node.value;
    if (!Number.isSafeInteger(point?.x) || !Number.isSafeInteger(point?.y)) {
      throw new Error(`Invalid avatar canvas anchor at ${sourcePath(node)}`);
    }
    anchors[name] = { x: point.x, y: point.y };
  }
  return anchors;
}

/** Original00774901 intersects canvas smap with item vslot. Pixel coordinates remain origin-relative. */
async function canvasPart(context, canvas, record, maps) {
  try {
    const origin = value(canvas, "origin");
    if (!Number.isInteger(origin?.x) || !Number.isInteger(origin?.y)) {
      throw new Error("Invalid avatar canvas origin");
    }
    const anchors = canvasAnchors(canvas, record);
    const z = value(canvas, "z");
    const slots =
      typeof z === "string" &&
      maps.smap[z] !== null &&
      maps.smap[z] !== undefined
        ? avatarSlots(maps.smap[z])
        : [];
    const visible = new Set(avatarSlots(record.vslot));
    return {
      ...(await context.part(canvas, 0, 0, depthRank(canvas, record, maps))),
      name: canvas.name,
      anchors,
      slots: slots.filter((slot) => visible.has(slot)).join(""),
      skin: null,
    };
  } catch (error) {
    throw new Error(
      `${record.source}/${sourcePath(canvas)}: ${error.message}`,
      { cause: error },
    );
  }
}

/** Preserve all authored skin banks; select one only when composing a real appearance. */
async function frameParts(context, frame, input) {
  const { record, maps } = input;
  const parts = [];
  const children =
    frame.type === "Canvas" ? [frame] : Object.values(frame.children);
  if (children.length > AVATAR_LIMITS.parts) {
    throw new Error("Avatar frame part bound exceeded");
  }
  for (const child of children) {
    const node = avatarNode(child, record);
    if (!node) continue;
    if (node.type === "Canvas") {
      parts.push(await canvasPart(context, node, record, maps));
    } else if (child.name === "hairShade") {
      await appendHairShades(context, node, input, parts);
    } else if (Object.keys(node.children).length) {
      unavailableNode(record, child, "non-canvas");
    }
  }
  if (parts.length > AVATAR_LIMITS.parts) {
    throw new Error("Avatar frame part bound exceeded");
  }
  return { delay: delayFor(frame), parts };
}

async function appendHairShades(context, node, input, parts) {
  const { record, maps } = input;
  const shades = Object.entries(node.children);
  if (shades.length > 256) {
    throw new Error("Avatar hair shade bank bound exceeded");
  }
  for (const [key, shade] of shades) {
    if (!/^\d+$/.test(key)) {
      throw new Error("Invalid original hair shade bank");
    }
    const canvas = avatarNode(shade, record);
    if (!canvas) continue;
    if (canvas.type !== "Canvas") {
      unavailableNode(record, shade, "non-canvas");
      continue;
    }
    const part = await canvasPart(context, canvas, record, maps);
    part.skin = Number(key);
    parts.push(part);
  }
}

async function appendRoot(context, input, name, root) {
  const { record } = input;
  const resolved = avatarNode(root, record);
  if (!resolved) {
    record.frames[name] = [];
    return;
  }
  const numeric = Object.keys(resolved.children).some((key) =>
    /^\d+$/.test(key),
  );
  const frames = [];
  if (numeric) {
    //004132d5 parses the authored frame index;00413742 addresses that frame's component list.
    for (const index of frameIndices(
      resolved,
      record.kind !== "body" && !EXPRESSION_NAMES.includes(name),
    )) {
      for (let gap = frames.length; gap < Number(index); gap++) {
        frames.push(null);
      }
      const frame = avatarNode(resolved.children[index], record);
      frames.push(frame ? await frameParts(context, frame, input) : null);
    }
  } else frames.push(await frameParts(context, resolved, input));
  record.frames[name] = frames;
}

function recordMetadata(node, input, maps) {
  const info = at(node, "info");
  const islot = value(info, "islot", ""),
    vslot = value(info, "vslot", "");
  const ranks = avatarSlots(islot).map((slot) => maps.zmap.indexOf(slot));
  return {
    schemaVersion: 1,
    id: input.id,
    kind: input.kind,
    source: `Character.wz:${input.path}`,
    islot,
    vslot,
    priority:
      ranks.length && !ranks.includes(-1) ? -Math.min(...ranks) - 1 : null,
    stand: value(info, "stand", 0),
    walk: value(info, "walk", 0),
    attack: value(info, "attack", 0),
    cash: Number(value(info, "cash", 0)),
    visual: false,
    expressionDriven:
      input.kind === "face" ||
      (input.kind === "equipment" &&
        Boolean(node.children.blink) &&
        !node.children.stand1),
    weaponFamilies: [],
    frames: Object.create(null),
    poses: Object.create(null),
    expressionDurations: Object.create(null),
    unresolved: [],
  };
}

function extractionActions(node, input) {
  if (!input.riding) return ["default", ...AVATAR_ACTIONS, ...EXPRESSION_NAMES];
  const roots = Object.keys(node.children);
  if (roots.length > AVATAR_LIMITS.actions) {
    throw new Error("Riding action bound exceeded");
  }
  return roots.filter(
    (name) =>
      name !== "info" &&
      Object.keys(resolveNode(node.children[name]).children).some((key) =>
        /^\d+$/.test(key),
      ),
  );
}

/** Data-only authored records, one item at a time; no precomputed wardrobe combinations. */
export async function extractAvatarRecord(
  context,
  input,
  maps = avatarMaps(context),
) {
  const node = context.image("Character", input.path);
  const record = recordMetadata(node, input, maps);
  record.combat = input.path.startsWith("Weapon/")
    ? await extractWeaponCombat(context, input.id)
    : null;
  //0041272c explicitly excludes mount/saddle/dragon positions18..20 from ordinary avatars.
  if (excludedOrdinaryEquipment(input, record)) {
    return validateAvatarRecord(record);
  }
  const state = { record, maps };
  const actionRoot =
    input.riding && input.bank !== undefined
      ? at(node, String(input.bank))
      : node;
  for (const name of extractionActions(actionRoot, input)) {
    if (actionRoot.children[name]) {
      await appendRoot(context, state, name, actionRoot.children[name]);
    }
  }
  if (input.path.startsWith("Weapon/")) {
    await appendWeaponFamilies(context, node, state);
  }
  appendExpressionDurations(node, record);
  //00406ae7 loads id2000 once for the global pose table, independently of skin canvases.
  if (input.kind === "body") {
    appendBodyPoses(
      input.id === 2000 ? node : context.image("Character", "00002000.img"),
      record,
    );
  }
  record.visual = Object.values(record.frames).some((frames) =>
    frames.some((frame) => frame?.parts.length),
  );
  return validateAvatarRecord(record);
}

function excludedOrdinaryEquipment(input, record) {
  return (
    input.kind === "equipment" &&
    !input.riding &&
    (record.islot === "Tm" || record.islot === "Sd")
  );
}

async function appendWeaponFamilies(context, node, state) {
  const { record } = state;
  for (const [family, root] of Object.entries(node.children)) {
    if (!/^\d+$/.test(family)) continue;
    record.weaponFamilies.push(Number(family));
    if (record.weaponFamilies.length > 64) {
      throw new Error("Avatar weapon family bound exceeded");
    }
    for (const name of AVATAR_ACTIONS) {
      const action = resolveNode(root).children[name];
      if (action) {
        await appendRoot(context, state, `${family}/${name}`, action);
      }
    }
  }
}

function appendExpressionDurations(node, record) {
  for (const name of EXPRESSION_NAMES) {
    if (!record.frames[name]?.length) continue;
    const duration = value(at(node, name), "delay", 5000);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("Invalid avatar expression duration");
    }
    record.expressionDurations[name] = duration;
  }
}

function appendBodyPoses(node, record) {
  for (const action of AVATAR_ACTIONS) {
    record.poses[action] = frameIndices(at(node, action)).map((index) => ({
      ...bodyPose(node, action, index),
      delay: delayFor(at(node, `${action}/${index}`)),
      preAction:
        value(at(node, `${action}/${index}`), "delay", ORIGINAL_DELAY_MS) < 0,
    }));
  }
}

export const defaultAvatarInputs = Object.freeze([
  { id: 2000, kind: "body", path: "00002000.img" },
  { id: 12000, kind: "head", path: "00012000.img" },
  { id: 30000, kind: "hair", path: "Hair/00030000.img" },
  { id: 20000, kind: "face", path: "Face/00020000.img" },
  { id: 1040002, kind: "equipment", path: "Coat/01040002.img" },
  { id: 1060002, kind: "equipment", path: "Pants/01060002.img" },
  { id: 1072001, kind: "equipment", path: "Shoes/01072001.img" },
  { id: 1302000, kind: "equipment", path: "Weapon/01302000.img" },
]);

/** Existing field extraction now uses the exact canonical modular compositor.
 * This is the authored initial appearance, not an inventory grant or fallback for missing profile items. */
export async function extractAvatar(context) {
  const maps = avatarMaps(context);
  const records = [];
  for (const input of defaultAvatarInputs) {
    records.push(await extractAvatarRecord(context, input, maps));
  }
  const result = composeAvatar(records, {
    skin: 0,
    weaponFamily: 30,
    hiddenSlots: "H4H5",
  });
  applyWeaponAttackSpeed(result.actions, records[records.length - 1].combat);
  result.avatar = {
    combat: records[records.length - 1].combat,
    weaponFamily: 30,
    standAction: "stand1",
    walkAction: "walk1",
    speechHeights: avatarSpeechHeights(result.actions),
  };
  return result;
}
