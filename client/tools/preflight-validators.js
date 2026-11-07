import { at, value, resolveNode } from "../src/assets/image.js";
import { createHash } from "node:crypto";
import { frameDelay } from "./extraction-frames.js";
import { decodeCanvas } from "../src/assets/canvas.js";
import { soundFormat, effectDelay, effectAlpha } from "./audiovisual-data.js";
import {
  DANGLING_NPC_FRAME_UOL,
  bodyRectangle,
  danglingFrameUol,
  delayValue,
  fields,
  lifeOrigin,
} from "./life-data.js";
import { screenCoordinate } from "./mapletv-data.js";
import { eventRecord } from "./reactor-data.js";
import { provenance, rawValue } from "./preflight-inputs.js";

/** Decode every consumed canvas once; retain only the actual pixel identity, never an atlas descriptor. */
function canvas(state, node, options) {
  const boostAlpha = !!options?.boostAlpha;
  if (!state.decoded.has(node)) state.decoded.set(node, new Map());
  const variants = state.decoded.get(node);
  const variantKey = boostAlpha ? "boost" : "normal";
  if (variants.has(variantKey)) return variants.get(variantKey);

  const pixels = state.findings.check(
    node,
    "canvas",
    {
      width: node.width,
      height: node.height,
      format: node.format,
      scale: node.scale,
    },
    () => decodeCanvas(node, options),
  );
  state.report.coverage.canvases++;
  if (!pixels) {
    variants.set(variantKey, null);
    return null;
  }
  const hash = createHash("sha256")
    .update(`${pixels.width}x${pixels.height}:`)
    .update(pixels.rgba)
    .digest("hex");
  variants.set(variantKey, hash);
  return hash;
}

function sound(state, original) {
  const node = state.findings.check(original, "", original.value, () =>
    resolveNode(original),
  );
  if (!node || state.sounds.has(node)) return;
  state.sounds.add(node);
  const origin = provenance(node);
  const format = state.findings.check(node, "envelope", node.value, () =>
    soundFormat(node, `${origin.source}/${origin.field}`),
  );
  state.report.coverage.sounds++;
  if (format && node.value.formatData.length === 0) {
    state.report.normalizations.push({
      ...origin,
      code: "native-mpeg1-audio",
      ...rawValue(node.value.subType),
      channels: format.channels,
      sampleRate: format.sampleRate,
    });
  }
}

function lifeFrame(state, node, kind) {
  const { findings } = state;
  findings.check(node, "delay", value(node, "delay"), () =>
    delayValue(value(node, "delay"), kind),
  );
  const origin = value(node, "origin");
  findings.check(node, "origin", origin, () => lifeOrigin(node));
  const lt = value(node, "lt"),
    rb = value(node, "rb");
  const raw = {
    lt: { ...rawValue(lt), wzType: node.children.lt?.type ?? null },
    rb: { ...rawValue(rb), wzType: node.children.rb?.type ?? null },
  };
  const inactive = findings.check(
    node,
    "lt,rb",
    raw,
    () => bodyRectangle(node) === null,
  );
  if (inactive && (lt === undefined) !== (rb === undefined)) {
    state.report.normalizations.push({
      ...provenance(node),
      code: "missing-life-body-corner",
      raw,
      valueType: "body-rectangle",
      normalized: null,
      evidence:
        "docs/ghidra-client-corrections/iteration-mob-missing-corner.txt",
    });
  }
}

function lifeAction(state, root, kind) {
  const { findings } = state;
  for (const key of Object.keys(root.children).filter((key) =>
    /^\d+$/.test(key),
  )) {
    if (danglingFrameUol(state.context, root.children[key])) {
      const { code, raw, normalized, evidence } = DANGLING_NPC_FRAME_UOL;
      state.report.normalizations.push({
        ...provenance(root.children[key]),
        code,
        raw,
        valueType: "life-frame-uol",
        normalized,
        evidence,
      });
      continue;
    }
    const frame = findings.check(
      root.children[key],
      "",
      root.children[key].value,
      () => at(root, key),
    );
    if (!frame) continue;
    findings.check(frame, "type", frame.type, () => {
      if (frame.type !== "Canvas") {
        throw new Error(`Unsupported life frame ${key}`);
      }
    });
    if (frame.type === "Canvas") lifeFrame(state, frame, kind);
  }
}

/** Resolved traversal target; the recorded dangling frame UOL is already a normalization. */
function treeNode(state, original) {
  if (danglingFrameUol(state.context, original)) return null;
  return state.findings.check(original, "", original.value, () =>
    resolveNode(original),
  );
}

/** The finite parsed tree plus resolved targets bounds traversal; visited identities close UOL cycles. */
function tree(state, root, options = {}) {
  if (state.walked.has(root)) return;
  state.walked.add(root);
  if (options.life) lifeAction(state, root, options.life);
  const queue = [root],
    seen = new Set();
  for (let index = 0; index < queue.length; index++) {
    const node = treeNode(state, queue[index]);
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "Canvas") canvas(state, node);
    if (node.type === "Sound_DX8") sound(state, node);
    for (const child of Object.values(node.children)) queue.push(child);
    if (node.type === "Canvas" && /^\d+$/.test(node.name)) {
      frameMetadata(state, node, options);
    }
  }
  state.report.coverage.nodes += seen.size;
}

function frameMetadata(state, node, options) {
  if (options.animation) {
    state.findings.check(node, "delay", value(node, "delay", 120), () =>
      frameDelay(node, provenance(node).field),
    );
  }
  if (options.effect) {
    state.findings.check(node, "delay", value(node, "delay", null), () =>
      effectDelay(node),
    );
    state.findings.check(
      node,
      "a0,a1",
      { a0: value(node, "a0", -1), a1: value(node, "a1", -1) },
      () => effectAlpha(node, 255),
    );
  }
}

function television(state, node) {
  const info = fields(node);
  if (!info.MapleTV) return false;
  for (const key of [
    "MapleTVmsgX",
    "MapleTVmsgY",
    "MapleTVadX",
    "MapleTVadY",
  ]) {
    const coordinate = state.findings.check(node, key, info[key], () =>
      screenCoordinate(info, key),
    );
    if (coordinate !== null && typeof info[key] === "string") {
      state.report.normalizations.push({
        ...provenance(node),
        field: `info/${key}`,
        code: "decimal-screen-coordinate",
        ...rawValue(info[key]),
        normalized: coordinate,
      });
    }
  }
  return true;
}

function reactor(state, root) {
  const states = Object.entries(root.children).filter(([key]) =>
    /^\d+$/.test(key),
  );
  state.findings.check(
    root,
    "states",
    states.map(([key]) => key),
    () => {
      if (!states.some(([key]) => key === "0") || states.length > 256) {
        throw new Error("Invalid reactor state inventory");
      }
    },
  );
  for (const [, node] of states) {
    const events = node.children.event;
    if (!events) continue;
    const timeout = value(events, "timeOut", 0);
    state.findings.check(events, "timeOut", timeout, () => {
      if (!Number.isSafeInteger(Number(timeout)) || Number(timeout) < 0) {
        throw new Error("Invalid reactor timeOut");
      }
    });
    for (const [key, event] of Object.entries(events.children)) {
      if (/^\d+$/.test(key)) {
        state.findings.check(event, "", fields(event), () =>
          eventRecord(event),
        );
      }
    }
  }
  tree(state, root, { animation: true });
}

function animation(state, root) {
  const node = state.findings.check(root, "", root?.value, () =>
    resolveNode(root),
  );
  if (!node) return;
  const frames =
    node.type === "Canvas"
      ? [node]
      : Object.keys(node.children)
          .filter((key) => /^\d+$/.test(key))
          .map((key) =>
            state.findings.check(
              node.children[key],
              "",
              node.children[key].value,
              () => at(node, key),
            ),
          )
          .filter(Boolean);
  state.findings.check(
    node,
    "frames",
    frames.map((frame) => frame.type),
    () => {
      if (!frames.length) throw new Error("No canvas frames");
    },
  );
  for (const frame of frames) {
    state.findings.check(frame, "type", frame.type, () => {
      if (frame.type !== "Canvas") {
        throw new Error("Expected Canvas animation frame");
      }
    });
    state.findings.check(frame, "delay", value(frame, "delay", 120), () =>
      frameDelay(frame, provenance(frame).field),
    );
    if (frame.type === "Canvas") canvas(state, frame);
  }
}

export function originalValidators(report, findings) {
  const state = {
    report,
    findings,
    context: { sourceSha256: (key) => report.sources[key]?.sha256 ?? null },
    decoded: new WeakMap(),
    walked: new WeakSet(),
    sounds: new WeakSet(),
  };
  return {
    tree: (root, options) => tree(state, root, options),
    effect: (root) => tree(state, root, { effect: true }),
    canvas: (node, options) => canvas(state, node, options),
    sound: (node) => sound(state, node),
    television: (node) => television(state, node),
    reactor: (root) => reactor(state, root),
    animation: (root) => animation(state, root),
  };
}
