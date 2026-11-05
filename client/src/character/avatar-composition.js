import { EXPRESSION_NAMES } from "../input/character-bindings.js";

// Original action table 004a38e7; alias resolution/timing 00406abd.
export const AVATAR_ACTIONS = Object.freeze([
  "walk1",
  "walk2",
  "stand1",
  "stand2",
  "alert",
  "swingO1",
  "swingO2",
  "swingO3",
  "swingOF",
  "swingT1",
  "swingT2",
  "swingT3",
  "swingTF",
  "swingP1",
  "swingP2",
  "swingPF",
  "stabO1",
  "stabO2",
  "stabOF",
  "stabT1",
  "stabT2",
  "stabTF",
  "shoot1",
  "shoot2",
  "shootF",
  "heal",
  "proneStab",
  "prone",
  "fly",
  "jump",
  "ladder",
  "rope",
  "dead",
  "sit",
  "alert2",
  "alert3",
  "alert4",
  "alert5",
  "alert6",
  "paralyze",
  "ladder2",
  "rope2",
  "prone2",
  "shot",
  "swingT2PoleArm",
  "swingP1PoleArm",
  "swingP2PoleArm",
  "bamboo",
  "float",
  "pyramid",
  "rush2",
  "brandish1",
  "brandish2",
  "blast",
  "sanctuary",
  "rush",
  "magic3",
  "shoot6",
  "meteor",
  "magic2",
  "magic1",
  "chainlightning",
  "blizzard",
  "holyshield",
  "resurrection",
  "genesis",
  "darksight",
  "avenger",
  "showdown",
  "ninjastorm",
  "savage",
  "assaulter",
  "assassination",
  "smokeshell",
  "straight",
  "somersault",
  "doublefire",
  "backspin",
  "doubleupper",
  "screw",
  "recovery",
  "eburster",
  "edrain",
  "shockwave",
  "dragonstrike",
  "eorb",
  "demolition",
  "snatch",
  "fist",
  "timeleap",
  "fake",
  "backstep",
  "triplefire",
  "octopus",
  "fireburner",
  "coolingeffect",
  "homing",
  "airstrike",
  "cannon",
  "torpedo",
  "blade",
  "souldriver",
  "magic5",
  "flamegear",
  "firestrike",
  "stormbreak",
  "windspear",
  "windshot",
  "vampire",
  "wave",
  "overSwingDouble",
  "overSwingTriple",
  "finalBlow",
  "doubleSwing",
  "combatStep",
  "tripleSwing",
  "finalCharge",
  "comboSmash",
  "finalToss",
  "comboFenrir",
  "rollingSpin",
  "fullSwingDouble",
  "fullSwingTriple",
  "comboTempest",
  "burster1",
  "burster2",
]);

/** Actions where the character is viewed from behind — GM sets pose.face=false
 *  so face/eye parts don't render through the back of the head. */
const FACE_HIDDEN_ACTIONS = Object.freeze(new Set([
  "ladder", "rope", "ladder2", "rope2",
]));

export const AVATAR_LIMITS = Object.freeze({
  items: 64,
  parts: 256,
  frames: 4096,
  records: 32768,
  anchors: 32,
  actions: 4096,
});
//00407757 retains aEquip positions1(cap),3(eye),4(ear) alongside hair at0 for death.
const DEATH_ACCESSORIES = new Set(["Cp", "HrCp", "Ay", "Ae"]);

/** Two UTF-16 characters per original islot/vslot token (00774815). */
export function avatarSlots(value) {
  if (typeof value !== "string" || value.length > 128 || value.length % 2) {
    throw new Error("Invalid avatar slot string");
  }
  const slots = [];
  for (let index = 0; index < value.length; index += 2) {
    slots.push(value.slice(index, index + 2));
  }
  return slots;
}

/** Validate the data-only per-item boundary before composition; pixels have separate validation. */
export function validateAvatarRecord(record) {
  validateRecordIdentity(record);
  validateEquipmentMetadata(record);
  validateRecordFrames(record);
  validateRecordMetadata(record);
  validateAvatarUnresolved(record.unresolved);
  validateBodyActions(record);
  return record;
}

function validateRecordIdentity(record) {
  if (
    record?.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.id) ||
    record.id < 0 ||
    !["body", "head", "face", "hair", "equipment"].includes(record.kind) ||
    typeof record.source !== "string" ||
    typeof record.visual !== "boolean"
  ) {
    throw new Error("Invalid avatar record");
  }
}

function validateEquipmentMetadata(record) {
  avatarSlots(record.islot);
  avatarSlots(record.vslot);
  if (
    (!Number.isInteger(record.priority) &&
      (record.visual || record.priority !== null)) ||
    ![0, 1, 2].includes(record.stand) ||
    ![0, 1, 2].includes(record.walk)
  ) {
    throw new Error("Invalid avatar equipment metadata");
  }
}

function validateRecordFrames(record) {
  const roots = Object.entries(record.frames ?? {});
  if (roots.length > AVATAR_LIMITS.actions) {
    throw new Error("Avatar action bound exceeded");
  }
  let total = 0,
    hasParts = false;
  for (const [key, frames] of roots) {
    if (
      !/^[a-zA-Z0-9/]+$/.test(key) ||
      !Array.isArray(frames) ||
      frames.length > AVATAR_LIMITS.frames
    ) {
      throw new Error("Invalid avatar frames");
    }
    total += frames.length;
    if (total > AVATAR_LIMITS.records) {
      throw new Error("Avatar frame record bound exceeded");
    }
    const rootHasParts = validateFrameRoot(record, key, frames);
    hasParts ||= rootHasParts;
  }
  if (record.visual !== hasParts) {
    throw new Error(
      "Avatar visual availability disagrees with its authored parts",
    );
  }
}

function validateFrameRoot(record, key, frames) {
  let hasParts = false;
  for (const frame of frames) {
    if (
      frame === null &&
      record.kind !== "body" &&
      record.kind !== "face" &&
      !EXPRESSION_NAMES.includes(key)
    ) {
      continue;
    }
    validatePartFrame(frame);
    hasParts ||= frame.parts.length > 0;
  }
  return hasParts;
}

/** Optional diagnostics preserve authored failed resource queries; they are never pixel substitutes. */
export function validateAvatarUnresolved(unresolved = []) {
  if (!Array.isArray(unresolved) || unresolved.length > AVATAR_LIMITS.records) {
    throw new Error("Invalid avatar unresolved resources");
  }
  for (const entry of unresolved) {
    validateResourceDiagnostic(entry);
  }
}

function validateResourceDiagnostic(entry) {
  if (
    typeof entry.path !== "string" ||
    !entry.path ||
    entry.path.length > 4096 ||
    (entry.link !== null &&
      (typeof entry.link !== "string" || entry.link.length > 4096)) ||
    ![
      "missing-property",
      "missing-property-interface",
      "non-canvas",
      "non-anchor-interface",
      "missing-anchor-map",
      "unknown-z",
    ].includes(entry.reason)
  ) {
    throw new Error("Invalid avatar resource diagnostic");
  }
  validateDiagnosticValue(entry.value);
}

function validateDiagnosticValue(value) {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    if (value.length > 4096) {
      throw new Error("Invalid avatar resource diagnostic");
    }
    return;
  }
  if (!Number.isFinite(value)) {
    throw new Error("Invalid avatar resource diagnostic");
  }
}

function validateRecordMetadata(record) {
  if (
    ![0, 1].includes(record.cash) ||
    typeof record.expressionDriven !== "boolean" ||
    !Array.isArray(record.weaponFamilies) ||
    record.weaponFamilies.length > 64 ||
    !record.expressionDurations ||
    typeof record.expressionDurations !== "object"
  ) {
    throw new Error("Invalid avatar visual metadata");
  }
  for (const family of record.weaponFamilies) {
    if (!Number.isInteger(family) || family < 0 || family > 99) {
      throw new Error("Invalid avatar weapon family");
    }
  }
  validateExpressionDurations(record);
  if (record.kind === "face") validateFaceTiming(record);
}

function validateExpressionDurations(record) {
  for (const [name, duration] of Object.entries(record.expressionDurations)) {
    if (
      !EXPRESSION_NAMES.includes(name) ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      throw new Error("Invalid avatar expression duration");
    }
  }
}

function validateFaceTiming(record) {
  if (!record.frames.default?.length) {
    throw new Error("Missing default avatar face");
  }
  for (const name of EXPRESSION_NAMES) {
    if (record.frames[name]?.length && !record.expressionDurations[name]) {
      throw new Error("Missing avatar expression timing");
    }
  }
}

function validatePartFrame(frame) {
  if (
    !frame ||
    !Array.isArray(frame.parts) ||
    frame.parts.length > AVATAR_LIMITS.parts ||
    !Number.isFinite(frame.delay) ||
    frame.delay < 0
  ) {
    throw new Error("Invalid avatar part frame");
  }
  for (const part of frame.parts) validatePart(part);
}

function validatePart(part) {
  if (
    typeof part.name !== "string" ||
    typeof part.texture !== "string" ||
    ![part.x, part.y, part.z].every(Number.isFinite)
  ) {
    throw new Error("Invalid avatar part geometry");
  }
  avatarSlots(part.slots);
  if (
    part.skin !== null &&
    (!Number.isInteger(part.skin) || part.skin < 0 || part.skin > 255)
  ) {
    throw new Error("Invalid hair shade index");
  }
  validateAnchors(part.anchors);
}

function validateAnchors(value) {
  const anchors = Object.entries(value ?? {});
  if (anchors.length > AVATAR_LIMITS.anchors) {
    throw new Error("Invalid avatar anchors");
  }
  for (const [name, point] of anchors) {
    if (
      !name ||
      !Number.isSafeInteger(point?.x) ||
      !Number.isSafeInteger(point?.y) ||
      Math.abs(point.x) > 1048576 ||
      Math.abs(point.y) > 1048576
    ) {
      throw new Error("Invalid avatar anchor vector");
    }
  }
}

function validateBodyActions(record) {
  if (record.kind !== "body") return;
  for (const action of AVATAR_ACTIONS) {
    const poses = record.poses?.[action];
    if (
      !Array.isArray(poses) ||
      !poses.length ||
      poses.length > AVATAR_LIMITS.frames
    ) {
      throw new Error("Invalid avatar body poses");
    }
    for (const pose of poses) validateBodyPose(record, pose);
  }
}

/** Resolve only admitted body-frame references; movement is validated separately below. */
function bodyPoseFrame(record, pose) {
  if (
    !AVATAR_ACTIONS.includes(pose.action) ||
    !Number.isInteger(pose.index) ||
    pose.index < 0
  ) {
    return null;
  }
  return record.frames[pose.action]?.[pose.index] ?? null;
}

function validateBodyPose(record, pose) {
  const frame = bodyPoseFrame(record, pose);
  if (
    !frame?.parts.length ||
    typeof pose.face !== "boolean" ||
    !Number.isFinite(pose.delay) ||
    pose.delay < 0
  ) {
    throw new Error("Invalid avatar resolved pose");
  }
  validatePoseTransforms(pose);
}

function validatePoseTransforms(pose) {
  if (
    !Number.isFinite(pose.moveX ?? 0) ||
    !Number.isFinite(pose.moveY ?? 0) ||
    ![0, 90, 180, 270].includes(pose.rotate ?? 0)
  ) {
    throw new Error("Invalid avatar pose geometry");
  }
  for (const field of ["flip", "preAction", "alias"]) {
    if (pose[field] !== undefined && typeof pose[field] !== "boolean") {
      throw new Error("Invalid avatar pose metadata");
    }
  }
}

/** 00401a17: separately truncate the signed integer centroids, not their difference. */
function componentOffset(target, source) {
  let targetX = 0,
    targetY = 0,
    sourceX = 0,
    sourceY = 0,
    count = 0;
  for (const [name, vector] of source.anchors) {
    const existing = target.anchors.get(name);
    if (!existing) continue;
    targetX += existing.x;
    targetY += existing.y;
    sourceX += vector.x;
    sourceY += vector.y;
    count++;
  }
  if (!count) return null;
  return {
    x: Math.trunc(targetX / count) - Math.trunc(sourceX / count),
    y: Math.trunc(targetY / count) - Math.trunc(sourceY / count),
  };
}

/** 00401b0d: translate new anchors and all members; retain destination common anchors. */
function mergeComponents(target, source, offset) {
  for (const [name, vector] of source.anchors) {
    if (!target.anchors.has(name)) {
      target.anchors.set(name, {
        x: vector.x + offset.x,
        y: vector.y + offset.y,
      });
    }
  }
  for (const position of source.positions) {
    position.x += offset.x;
    position.y += offset.y;
    target.positions.push(position);
  }
}

/** 0040197d searches the anchor forest in insertion order, never drawing-depth order. */
function connectedComponent(components, source) {
  for (const target of components) {
    if (target === source) continue;
    const offset = componentOffset(target, source);
    if (offset) return { target, offset };
  }
  return null;
}

/** 00402442 keeps the first component coordinate system and all disconnected components. */
function insertComponent(components, component) {
  components.push(component);
  for (let merge = 0; merge < AVATAR_LIMITS.parts; merge++) {
    const connection = connectedComponent(components, component);
    if (!connection) return;
    let { target, offset } = connection;
    let source = component;
    if (component === components[0]) {
      source = target;
      target = component;
      offset = { x: -offset.x, y: -offset.y };
    }
    mergeComponents(target, source, offset);
    components.splice(components.indexOf(source), 1);
    component = target;
  }
  throw new Error("Avatar component merge bound exceeded");
}

/** 00401c74: arbitration is per canvas smap∩vslot; equal islot priority coexists. */
function arbitrate(candidates, hiddenSlots) {
  const slots = new Map();
  for (const slot of avatarSlots(hiddenSlots)) {
    slots.set(slot, { priority: Infinity, visible: false });
  }
  const ordered = candidates.slice().sort((a, b) => a.part.z - b.part.z);
  for (const candidate of ordered) {
    for (const slot of avatarSlots(candidate.part.slots)) {
      const previous = slots.get(slot);
      if (previous && previous.priority === candidate.priority) continue;
      if (previous && previous.priority > candidate.priority) {
        candidate.visible = false;
        break;
      }
      if (previous) previous.visible = false;
      slots.set(slot, candidate);
    }
  }
}

export function placeCandidates(candidates, hiddenSlots) {
  if (!candidates.length || candidates.length > AVATAR_LIMITS.parts) {
    throw new Error("Avatar composition part bound exceeded");
  }
  const components = [];
  for (const candidate of candidates) {
    const anchors = new Map(Object.entries(candidate.part.anchors));
    candidate.position = { x: 0, y: 0 };
    insertComponent(components, { anchors, positions: [candidate.position] });
  }
  arbitrate(candidates, hiddenSlots);
  return candidates;
}

/**0041272c uses jump for dead head/hair/accessories;00407757 keeps only cap/eye/ear. */
function selectedFrame(record, pose, selection, expression) {
  if (
    pose.action === "dead" &&
    record.kind === "equipment" &&
    !DEATH_ACCESSORIES.has(record.islot)
  ) {
    return null;
  }
  if (record.kind === "face" || record.expressionDriven) {
    // if (!pose.face) return null;
    if (!pose.face && FACE_HIDDEN_ACTIONS.has(pose.action)) return null;
    return expressionFrame(record, expression);
  }
  return actionFrame(record, pose, selection);
}

function expressionFrame(record, expression) {
  return (
    record.frames[expression?.name ?? "default"]?.[expression?.index ?? 0] ??
    null
  );
}

function actionFrame(record, pose, selection) {
  const deadHead = pose.action === "dead" && record.kind !== "body";
  const action = deadHead ? "jump" : pose.action;
  const prefix = record.weaponFamilies?.length
    ? `${selection.weaponFamily}/`
    : "";
  return (
    record.frames[`${prefix}${action}`]?.[deadHead ? 0 : pose.index] ?? null
  );
}

function candidatesFor(records, pose, selection, expression) {
  const candidates = [];
  for (const record of records) {
    const frame = selectedFrame(record, pose, selection, expression);
    if (!frame) continue;
    for (const part of frame.parts) {
      if (part.skin !== null && part.skin !== selection.skin) continue;
      candidates.push({
        part,
        priority: record.priority,
        visible: true,
        expressionDriven: record.kind === "face" || record.expressionDriven,
      });
      if (candidates.length > AVATAR_LIMITS.parts) {
        throw new Error("Avatar part bound exceeded");
      }
    }
  }
  return placeCandidates(candidates, selection.hiddenSlots ?? "");
}

function renderedPart(candidate, expression) {
  const { part, position } = candidate;
  const output = {
    texture: part.texture,
    x: part.x + position.x,
    y: part.y + position.y,
    z: part.z,
  };
  if (candidate.expressionDriven) {
    output.expression = expression?.name ?? "default";
    if (expression) {
      output.expressionStart = expression.start;
      output.expressionEnd = expression.end;
      output.expressionLoopMs = expression.loopMs;
      output.expressionDuration = expression.duration;
    }
  }
  return output;
}

/** 00407a36 expression duration5000 and per-frame150 defaults were resolved at extraction. */
function expressionsFor(face) {
  const output = [];
  for (const name of EXPRESSION_NAMES) {
    const frames = face.frames[name];
    if (!frames?.length) continue;
    const loopMs = frames.reduce((sum, frame) => sum + frame.delay, 0);
    let start = 0;
    for (let index = 0; index < frames.length; index++) {
      const end = start + frames[index].delay;
      output.push({
        name,
        index,
        start,
        end,
        loopMs,
        duration: face.expressionDurations[name],
      });
      start = end;
      if (output.length > AVATAR_LIMITS.parts) {
        throw new Error("Avatar expression bound exceeded");
      }
    }
  }
  return output;
}

function framePartsFor(records, pose, selection, expressions) {
  const parts = [];
  let effectAnchor = null;
  for (const candidate of candidatesFor(records, pose, selection, null)) {
    if (candidate.part.name === "head" && candidate.part.anchors.brow) {
      const brow = candidate.part.anchors.brow;
      effectAnchor = {
        x: candidate.position.x + brow.x,
        y: candidate.position.y + brow.y,
      };
    }
    if (candidate.visible) parts.push(renderedPart(candidate, null));
  }
  // if (pose.face) {
  if (pose.face || !FACE_HIDDEN_ACTIONS.has(pose.action)) {
    for (const expression of expressions) {
      for (const candidate of candidatesFor(
        records,
        pose,
        selection,
        expression,
      )) {
        if (candidate.visible && candidate.expressionDriven) {
          parts.push(renderedPart(candidate, expression));
        }
      }
    }
  }
  if (parts.length > AVATAR_LIMITS.parts) {
    throw new Error("Avatar expression composition bound exceeded");
  }
  return { parts, effectAnchor };
}

function composeFrame(records, pose, selection, expressions) {
  const { parts, effectAnchor } = framePartsFor(
    records,
    pose,
    selection,
    expressions,
  );
  return {
    delay: pose.delay,
    parts,
    effectAnchor,
    moveX: pose.moveX ?? 0,
    moveY: pose.moveY ?? 0,
    rotate: pose.rotate ?? 0,
    flip: pose.flip ?? false,
    preAction: pose.preAction ?? false,
    alias: pose.alias ?? false,
    poseAction: pose.action,
    poseIndex: pose.index,
  };
}

/** Pure bounded composition shared by offline extraction and lazy profile preparation. No tick work. */
export function composeAvatar(records, selection) {
  if (
    !Array.isArray(records) ||
    records.length > AVATAR_LIMITS.items ||
    !Number.isInteger(selection.skin)
  ) {
    throw new Error("Invalid avatar selection");
  }
  for (const record of records) validateAvatarRecord(record);
  const body = records.find((record) => record.kind === "body");
  const face = records.find((record) => record.kind === "face");
  if (
    !body ||
    !face ||
    !records.some((record) => record.kind === "head") ||
    !records.some((record) => record.kind === "hair")
  ) {
    throw new Error("Incomplete avatar base appearance");
  }
  const expressions = expressionsFor(face);
  const actions = composeActions(records, body, selection, expressions);
  const unresolved = compositionDiagnostics(records);
  return {
    actions,
    equipment: records.map((record) => record.source),
    unresolved,
  };
}

function composeActions(records, body, selection, expressions) {
  const actions = Object.create(null);
  for (const action of AVATAR_ACTIONS) {
    const frames = body.poses[action].map((pose) =>
      composeFrame(records, pose, selection, expressions),
    );
    if (action === "stand1" || action === "stand2" || action === "alert") {
      for (let index = frames.length - 2; index > 0; index--) {
        frames.push(frames[index]);
      }
    }
    actions[action] = frames;
  }
  return actions;
}

function compositionDiagnostics(records) {
  const unresolved = [];
  for (const record of records) {
    for (const entry of record.unresolved ?? []) {
      unresolved.push({ source: record.source, ...entry });
    }
  }
  return unresolved;
}

/**004519aa queries the first canvas of both composite partitions, not the current frame. */
export function avatarSpeechHeights(actions) {
  const heights = Object.create(null);
  for (const [action, frames] of Object.entries(actions)) {
    let height = 0;
    for (const part of frames[0].parts) {
      if (part.expression && part.expression !== "default") continue;
      height = Math.max(height, -part.y);
    }
    heights[action] = height;
  }
  return heights;
}
