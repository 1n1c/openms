import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { WzArchive } from "../src/assets/wz.js";
import { parseImage, at, value, resolveNode } from "../src/assets/image.js";
import { decodeCanvas } from "../src/assets/canvas.js";
import { readPhysicsData } from "./physics-data.js";
import { extractHitboxReferences } from "./hitbox-data.js";
import { hash, resource, publishFile, ATLAS_LIMIT, PADDING } from "./atlas.js";
import { packageMap, packageVisualBundle, REGION_SIZE } from "./packaging.js";
import { prepareCanvasTiles } from "./canvas-tiles.js";
import { extractGameUI } from "./ui-data.js";
import { collectPlayableMaps, extractPortals } from "./portal-data.js";
import { extractLife } from "./life-data.js";
import { extractAudiovisual } from "./audiovisual-data.js";
import { extractAvatar } from "./avatar-data.js";
import { extractQuests, extractMapNames } from "./quest-data.js";
import { extractCombat } from "./combat-data.js";
import { extractReactors } from "./reactor-data.js";
import { extractDropData, finalizeDropData } from "./drop-data.js";
import { convertServerData, extractServerData } from "./server-data.js";
import { extractLoadingArt } from "./loading-art.js";
import { defaultRoots, mapBounds, spawnPortal } from "./extraction-inputs.js";
import { originalFrames } from "./extraction-frames.js";
import { preflightAssets } from "./preflight.js";
import { createExtractionCache } from "./extraction-cache.js";
import { extractionRecipes } from "./extraction-recipes.js";
import { extractionStage } from "./extraction-timings.js";
import { resourceByteLimit } from "../src/assets/resource-validation.js";
import { parseFlags, sourcePaths } from "./source-options.js";
import { LIMITS } from "../src/rendering/stream-validation.js";

const started = performance.now();
const timings = {};
/** Terminal diagnostics stay separate from the existing JSON stdout records. */
function progress(message) {
  console.error(
    `[extract +${((performance.now() - started) / 1000).toFixed(2)}s] ${message}`,
  );
}
progress("Starting extraction: preparing options and output directories");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const flags = parseFlags(args, {
  assets: { type: "string" },
  "gameplay-definitions-root": { type: "string" },
  "sql-root": { type: "string" },
  "cache-dir": { type: "string" },
  map: { type: "string" },
  maps: { type: "string" },
  "preflight-report": { type: "string" },
  full: { type: "boolean" },
  help: { type: "boolean" },
});
if (flags.help) {
  console.log(
    "bun tools/openms.js extract [--assets DIR] [--gameplay-definitions-root DIR] [--sql-root DIR] [--cache-dir DIR] [--map ID | --maps ID,ID] [--preflight-report FILE] [--full]\nDefaults relative to the repository: ../Maplestory-Client, infra/gameplay-definitions, infra/sql, client/.cache/extraction. No environment overrides.",
  );
  process.exit(0);
}
if (flags.map && flags.maps) throw new Error("Use only --map or --maps");
const sources = sourcePaths({
  assets: flags.assets,
  gameplayDefinitionsRoot: flags["gameplay-definitions-root"],
  sqlRoot: flags["sql-root"],
  cacheDir: flags["cache-dir"],
});
const explicitMaps = flags.maps !== undefined || flags.map !== undefined;
const option = (name, fallback) => flags[name.slice(2)] ?? fallback;
const source = sources.assets;
const selected = option(
  "--maps",
  option("--map", defaultRoots.join(",")),
).split(",");
if (
  !selected.length ||
  selected.length > LIMITS.maps ||
  selected.some((id) => !/^\d{9}$/.test(id))
) {
  throw new Error(
    `--maps requires at most ${LIMITS.maps} comma-separated nine-digit IDs`,
  );
}
let mapIds = [...new Set(selected)].sort();
const output = resolve(root, "client/public/generated");
for (const directory of [
  "atlases",
  "regions",
  "maps",
  "references",
  "bundles",
  "audio",
]) {
  mkdirSync(resolve(output, directory), { recursive: true });
}
progress(
  `Original assets: ${source}; ${explicitMaps ? `${mapIds.length} selected maps` : `${mapIds.length} roots with world closure`}; ${args.includes("--full") ? "full conversion forced" : "incremental verification and reuse enabled"}`,
);
// This conversion process owns these caches; no runtime shares mutable data.
const archives = new Map(),
  images = new Map(),
  canvasIds = new WeakMap(); // node → Map<variantKey, hash>
const inputImages = Object.create(null);
const sourceHashes = Object.create(null);
const textures = Object.create(null),
  formats = Object.create(null);
const state = {
  output,
  pixels: textures,
  textures: Object.create(null),
  atlases: Object.create(null),
  verifiedBytes: 0,
  entities: [],
  rgbaBytes: 0,
};
state.regions = Object.create(null);
state.tiledCanvases = Object.create(null);
let incremental;
let preflight;
let decodedCanvases = 0;
const SOURCE_PROGRESS_INTERVAL = 100;
const CANVAS_PROGRESS_INTERVAL = 256;
const recipe = extractionRecipes();
const extractionContext = {
  image,
  part,
  frames,
  scenery: extractScenery,
  progress,
  output,
  imageEntries,
  sourceSha256: (key) => sourceRecord(key).sha256,
  mapIds,
  bundle: (value) => packageVisualBundle(value, state),
};
/** @param {string} name */
function archive(name) {
  if (!archives.has(name)) {
    progress(`Opening and indexing original ${name}.wz`);
    archives.set(name, new WzArchive(resolve(source, `${name}.wz`)));
  }
  return archives.get(name);
}
/** @param {string} name @param {string} path */
function image(name, path) {
  const key = `${name}.wz:${path}`;
  retainSource(key);
  incremental?.observe(key);
  if (!images.has(key)) {
    if (images.size % SOURCE_PROGRESS_INTERVAL === 0) {
      progress(`Reading original image ${key} (${images.size} images parsed)`);
    }
    const node = parseImage(archive(name).imageReader(path));
    node.source = key;
    images.set(key, node);
  }
  return images.get(key);
}

/** Hash original bytes even on cache hits; archive inventory changes are dependencies too. */
function sourceRecord(key) {
  if (sourceHashes[key]) return sourceHashes[key];
  const match = /^([A-Za-z0-9]+)\.wz:(.+)$/.exec(key);
  if (!match) throw new Error(`Invalid original source key ${key}`);
  const [, name, path] = match;
  const original = archive(name);
  const bytes =
    path === "@inventory"
      ? Buffer.from(JSON.stringify([...original.entries.keys()].sort()))
      : original.imageReader(path).bytes;
  sourceHashes[key] = {
    ...(path === "@inventory"
      ? { archive: `${name}.wz`, path }
      : original.entries.get(path)),
    sha256: hash(bytes),
    bytes: bytes.length,
  };
  return sourceHashes[key];
}

function retainSource(key) {
  inputImages[key] = sourceRecord(key);
}

function imageEntries(name) {
  const key = `${name}.wz:@inventory`;
  retainSource(key);
  incremental?.observe(key);
  return archive(name).entries;
}
/** @param {import('../src/assets/image.js').WzNode} node */
function nodePath(node) {
  const parts = [];
  for (let depth = 0; node.parent && depth < 256; depth++) {
    parts.unshift(node.name);
    node = node.parent;
  }
  if (node.parent) throw new Error("Canvas ancestry exceeds 256 nodes");
  return `${node.source}/${parts.join("/")}`;
}
/** @param {import('../src/assets/image.js').WzNode} node @param {{boostAlpha?: boolean}} [options] */
async function texture(
  node,
  options,
) {
  node = resolveNode(node);
  const boostAlpha = !!options?.boostAlpha;
  const variantKey = boostAlpha ? "boost" : "normal";
  if (!canvasIds.has(node)) canvasIds.set(node, new Map());
  const variants = canvasIds.get(node);
  if (variants.has(variantKey)) return variants.get(variantKey);
  if (decodedCanvases % CANVAS_PROGRESS_INTERVAL === 0) {
    progress(`Decoding canvas ${nodePath(node)} (${decodedCanvases} decoded)`);
  }
  const decoded = decodeCanvas(node, options);
  const id = createHash("sha256")
    .update(`${decoded.width}x${decoded.height}:`)
    .update(decoded.rgba)
    .digest("hex");
  if (!textures[id]) {
    textures[id] = {
      rgba: decoded.rgba,
      width: decoded.width,
      height: decoded.height,
      source: nodePath(node),
      format: decoded.format,
      scale: decoded.scale,
    };
    state.rgbaBytes += decoded.rgba.length;
    prepareCanvasTiles(state, id);
    const key = `${decoded.format}/${decoded.scale}`;
    formats[key] = (formats[key] ?? 0) + 1;
  }
  variants.set(variantKey, id);
  decodedCanvases++;
  return id;
}
/** @param {import('../src/assets/image.js').WzNode} node @param {number} [x] @param {number} [y] @param {number} [z] @param {{boostAlpha?: boolean}} [options] */
async function part(node, x = 0, y = 0, z = 0, options) {
  node = resolveNode(node);
  const origin = value(node, "origin", { x: 0, y: 0 });
  return { texture: await texture(node, options), x: x - origin.x, y: y - origin.y, z };
}
/** @param {import('../src/assets/image.js').WzNode} node */
async function frames(node) {
  return originalFrames(node, part, nodePath);
}
/** Create one map entity from original placement and animation metadata. */
function mapEntity(id, placement, frameList, flip = false) {
  const entity = {
    id,
    kind: "map",
    ...placement,
    visible: true,
    opacity: 1,
    flip,
    action: "default",
    actions: { default: frameList },
  };
  state.entities.push(entity);
  return entity;
}
/** Original layer object placements. */
async function objects(layer, l) {
  for (const [id, entry] of Object.entries(at(l, "obj").children)) {
    const path = `Obj/${value(entry, "oS")}.img`;
    const resource = at(
      image("Map", path),
      `${value(entry, "l0")}/${value(entry, "l1")}/${value(entry, "l2")}`,
    );
    mapEntity(
      `obj-${layer}-${id}`,
      {
        x: value(entry, "x"),
        y: value(entry, "y"),
        z: 2000 + layer * 30000 + value(entry, "z", 0),
      },
      await frames(resource),
      Boolean(value(entry, "f", 0)),
    );
  }
}
/** Original tile placements and zM ordering. */
async function tiles(layer, l) {
  const tileSet = value(at(l, "info"), "tS");
  for (const [id, entry] of Object.entries(at(l, "tile").children)) {
    const resource = at(
      image("Map", `Tile/${tileSet}.img`),
      `${value(entry, "u")}/${value(entry, "no")}`,
    );
    mapEntity(
      `tile-${layer}-${id}`,
      {
        x: value(entry, "x"),
        y: value(entry, "y"),
        z:
          19990 +
          layer * 30000 -
          value(entry, "zM", 0) * 10 +
          value(resource, "z", 0),
      },
      await frames(resource),
    );
  }
}
/** Background alpha and camera-relative tiling remain original metadata. */
async function backgrounds(map) {
  for (const [id, entry] of Object.entries(at(map, "back").children)) {
    const set = value(entry, "bS");
    if (!set) continue;
    const animated = Boolean(value(entry, "ani", 0));
    const resource = at(
      image("Map", `Back/${set}.img`),
      `${animated ? "ani" : "back"}/${value(entry, "no")}`,
    );
    const f = await frames(resource);
    const canvas = textures[f[0].parts[0].texture];
    const entity = mapEntity(
      `back-${id}`,
      {
        x: value(entry, "x", 0),
        y: value(entry, "y", 0),
        z: (value(entry, "front", 0) ? 272000 : -128000) + Number(id) * 1000,
      },
      f,
      Boolean(value(entry, "f", 0)),
    );
    entity.opacity = value(entry, "a", 255) / 255;
    entity.background = {
      type: value(entry, "type", 0),
      rx: value(entry, "rx", 0),
      ry: value(entry, "ry", 0),
      cx: value(entry, "cx", 0),
      cy: value(entry, "cy", 0),
      canvas: {
        width: canvas.width,
        height: canvas.height,
        scale: canvas.scale,
      },
    };
  }
}

/** Login and playable fields share original object, tile and background extraction. */
async function extractScenery(map) {
  state.entities = [];
  for (let layer = 0; layer < 8; layer++) {
    const node = at(map, String(layer));
    await objects(layer, node);
    await tiles(layer, node);
  }
  await backgrounds(map);
  for (let index = 0; index < state.entities.length; index++) {
    state.entities[index].order = index;
  }
  return state.entities;
}

/** Local initial field placement uses the original spawn portal and feet offset. */
function appendAvatar(map, character) {
  const portal = spawnPortal(map);
  const actor = {
    id: "character",
    kind: "character",
    x: value(portal, "x"),
    y: value(portal, "y") - 10, // 0094969a: original portal-entry feet offset.
    z: 239997, // 009b12a8 / 0092fd16: active local controller, plane7/group0.
    visible: true,
    flip: false,
    opacity: 1,
    action: "stand1",
    actions: character.actions,
    avatar: character.avatar,
  };
  state.entities.push(actor);
  return actor;
}

/** Extract a complete map's geometry and region-ready original artwork. */
async function extractMap(mapId, character) {
  const mapPath = `Map/Map${mapId[0]}/${mapId}.img`;
  const map = image("Map", mapPath);
  const info = at(map, "info");
  if (info.children.link) {
    throw new Error(
      `Linked maps require explicit target extraction: ${value(info, "link")}`,
    );
  }
  await extractScenery(map);
  const portals = await extractPortals(extractionContext, map, mapId);
  const life = await extractLife(extractionContext, map, mapId);
  const reactors = await extractReactors(extractionContext, map, mapId);
  state.entities.push(
    ...portals.entities,
    ...life.entities,
    ...reactors.entities,
  );
  const actor = appendAvatar(map, character);
  for (let index = 0; index < state.entities.length; index++) {
    state.entities[index].order = index;
  }
  return {
    id: mapId,
    source: `Map.wz:${mapPath}`,
    bounds: mapBounds(map),
    camera: { x: actor.x - 400, y: actor.y - 360 },
    entities: state.entities,
    physics: readPhysicsData(map, image("Map", "Physics.img")),
    equipment: character.equipment,
    portalPresentation: portals.presentation,
    life: life.life,
    reactors: reactors.reactors,
    evidence: [
      "docs/asset-evidence.md",
      "docs/client-evidence.md",
      "docs/physics-options.md",
    ],
  };
}
/** Conversion diagnostics are not part of content identities. */
function conversionReport(buildId, reports) {
  return {
    schemaVersion: 2,
    buildId,
    inputDirectory: source,
    maps: reports,
    incremental: {
      ...incremental.evidence,
      verification: incremental.verification,
    },
    policy: {
      atlasLimit: ATLAS_LIMIT,
      padding: PADDING,
      regionSize: REGION_SIZE,
      maxMaps: LIMITS.maps,
    },
    counts: {
      textures: Object.keys(textures).length,
      atlases: Object.keys(state.atlases).length,
      images: Object.keys(inputImages).length,
    },
    bytes: {
      originalRGBA: state.rgbaBytes,
      newlyDecodedRGBA: state.rgbaBytes,
      roundTripCompared: state.verifiedBytes,
      logicalReusedRGBA: incremental.evidence.reusedRGBABytes,
      atlasPNG: Object.values(state.atlases).reduce(
        (sum, a) => sum + a.bytes,
        0,
      ),
    },
    pixelRoundTrip: {
      passed: true,
      method:
        "New atlases compare independently inflated PNG subrects byte-for-byte; reused units verify immutable transitive output hashes against successful conversion records.",
    },
    formats: publicationFormats(),
    newlyDecodedFormats: formats,
    images: Object.keys(inputImages).sort(),
    durationMs: performance.now() - started,
    timings,
    limitations: [
      "Camera fallback derived from footholds; exact original fallback remains unverified.",
      "Map metadata retains active unsupported physics in physics.unsupported.",
      "Unpackaged destinations and original server-script dependencies remain explicitly unavailable.",
    ],
  };
}

function publicationFormats() {
  const counts = Object.create(null);
  for (const texture of Object.values(state.textures)) {
    const key = `${texture.format}/${texture.scale}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
/** Publish diagnostics after the content-addressed catalog has been committed. */
async function publishReport(catalog, reports) {
  const { buildId, maps, hitboxes } = catalog;
  progress("Writing extraction diagnostics and JSON report");
  const report = conversionReport(buildId, reports);
  report.inputs = inputImages;
  report.tiledCanvases = state.tiledCanvases;
  report.bytes.tileReconstructionCompared = Object.values(
    state.tiledCanvases,
  ).reduce((sum, item) => sum + item.comparedBytes, 0);
  report.counts.textures = Object.keys(state.textures).length;
  report.bytes.mapJSON = Object.values(maps).reduce(
    (sum, item) => sum + item.bytes,
    0,
  );
  report.bytes.hitboxReferencesJSON = hitboxes.bytes;
  report.bytes.catalogJSON = Buffer.byteLength(JSON.stringify(catalog));
  report.bytes.regionJSON = Object.values(state.regions).reduce(
    (sum, item) => sum + item.bytes,
    0,
  );
  report.bytes.atlasDecodedRGBA = Object.values(state.atlases).reduce(
    (sum, item) => sum + item.width * item.height * 4,
    0,
  );
  report.counts.regions = reports.reduce((sum, item) => sum + item.regions, 0);
  await Bun.write(
    resolve(root, "docs/extraction.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
/** Package each selected map once; neighbor membership uses an immutable selection. */
async function extractMaps(character, combat) {
  const maps = Object.create(null),
    monsters = Object.create(null),
    spawns = Object.create(null),
    reports = [];
  const selectedMaps = new Set(mapIds);
  const prerequisites = {
    character: hash(Buffer.from(JSON.stringify(character))),
    combat: hash(Buffer.from(JSON.stringify(combat))),
    portalPrograms: hash(
      Buffer.from(JSON.stringify(extractionContext.portalPrograms)),
    ),
    // Ride maps package their transport invasion monster templates.
    transportInvasions: hash(
      Buffer.from(
        JSON.stringify(
          Object.values(extractionContext.transportSchedules ?? {}).map(
            (schedule) => schedule.invasion ?? null,
          ),
        ),
      ),
    ),
  };
  let completed = 0;
  for (const id of mapIds) {
    progress(`Map ${completed + 1}/${mapIds.length}: ${id}; preparing recipe`);
    const result = await incremental.run(
      {
        id: `map/${id}`,
        recipe: await recipe("map"),
        prerequisites,
        sources: preflight.dependencies[id],
      },
      () => packagedMap(id, character, combat),
    );
    maps[id] = {
      ...result.descriptor,
      neighbors: result.neighbors.filter((target) => selectedMaps.has(target)),
    };
    reports.push(result.report);
    for (const monster of result.monsters) {
      monsters[monster.id] ??= { ...monster, mapId: id };
    }
    for (const spawn of result.spawns ?? []) {
      (spawns[spawn.id] ??= []).push({ mapId: id, count: spawn.count });
    }
    completed++;
    progress(`Map ${completed}/${mapIds.length} complete: ${id}`);
  }
  for (const rows of Object.values(spawns)) {
    rows.sort((a, b) => a.mapId.localeCompare(b.mapId, "en"));
  }
  return { maps, monsters, spawns, reports };
}

async function packagedMap(id, character, combat) {
  const scene = await extractMap(id, character);
  scene.combat = combat;
  progress(`Map ${id}: packaging regions and verifying atlas pixels`);
  const result = await packageMap(scene, state);
  const neighbors = [
    ...new Set(
      scene.physics.portals.map((portal) =>
        String(portal.targetMap).padStart(9, "0"),
      ),
    ),
  ]
    .filter((target) => target !== id)
    .sort();
  return {
    descriptor: result.descriptor,
    neighbors,
    monsters: mapMonsterEntries(result.manifest),
    spawns: mapSpawnEntries(result.manifest),
    report: {
      id,
      entities: scene.entities.length,
      regions: result.manifest.regions.length,
      textures: Object.keys(result.manifest.textures).length,
      physics: scene.physics.map,
    },
  };
}

/** Development selection indexes existing packaged templates, not invented mobs. */
function mapMonsterEntries(manifest) {
  const entries = Object.entries(manifest.life.templates);
  if (entries.length > 8192) throw new Error("Monster catalog exceeds bounds");
  const result = [];
  for (const [key, template] of entries) {
    if (template.kind !== "mob" || !manifest.life.renderables[key]) continue;
    result.push({
      id: Number(template.originalId),
      name: template.name ?? "",
      template: key,
    });
  }
  return result;
}

/** Authored life placements are the spawn authority; templates only prove the artwork exists. */
function mapSpawnEntries(manifest) {
  const counts = new Map();
  for (const placement of manifest.life.placements ?? []) {
    if (placement.kind !== "mob") continue;
    const id = Number(placement.authored?.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, count]) => ({ id, count }));
}

async function cached(name, prerequisites, build) {
  progress(`Shared domain ${name}: preparing recipe`);
  return incremental.run(
    { id: name, recipe: await recipe(name), prerequisites },
    build,
  );
}

/** Reference inventories share the same immutable offline descriptor publisher. */
function reference(value) {
  return resource(
    output,
    "references",
    "json",
    Buffer.from(JSON.stringify(value)),
  );
}
/** Cosmic LifeFactory298-300 reads the original d0 and explicitly uses "(...)" when absent. */
function defaultTalkForNpc(id) {
  const record = image("String", "Npc.img").children[String(id)];
  return record ? value(record, "d0", "(...)") : "(...)";
}

async function sharedCatalog(converted) {
  const quests = await cached("quests", null, async () => {
    const result = await extractQuests(extractionContext);
    result.inventory = await reference(result.inventory);
    return result;
  });
  const combat = await cached("combat", null, () =>
    extractCombat(extractionContext),
  );
  progress("Shared drop data: resolving original item references");
  const drops = extractDropData(extractionContext, converted.datasets.drops);
  const serverData = await cached("server", converted, () =>
    extractServerData({ output, converted }),
  );
  progress("Shared map names: reading original strings");
  const mapNames = extractMapNames(extractionContext);
  const ui = await cached(
    "ui",
    { quests, serverData, mapNames, dropItemIds: drops.itemIds, mapIds },
    () =>
      extractGameUI({
        ...extractionContext,
        quests,
        serverData,
        mapNames,
        dropItemIds: drops.itemIds,
      }),
  );
  finalizeDropData(drops, ui.items);
  const audiovisual = await cached("audiovisual", mapIds, () =>
    extractAudiovisual(extractionContext, mapIds),
  );
  return { quests, combat, drops, serverData, mapNames, ui, audiovisual };
}

/** Reference conversion is separate from the preflight's route validation. */
function gameplayDefinitions() {
  const originalQuestIds = new Set(
    Object.keys(image("Quest", "Check.img").children)
      .filter((key) => /^\d+$/.test(key))
      .map(Number),
  );
  progress("Compiling local gameplay definitions");
  return convertServerData({
    defaultTalkForNpc,
    originalQuestIds,
    progress,
    gameplayDefinitionsRoot: sources.gameplayDefinitionsRoot,
    sqlRoot: sources.sqlRoot,
  });
}

/** Atomic catalog is the only mutable entry point. */
async function run() {
  await prepareExtraction();
  const converted = await extractionStage(
    timings,
    "gameplayDefinitionsMs",
    gameplayDefinitions,
  );
  extractionContext.portalPrograms = converted.report.scripts.portalPrograms;
  const { portalScripts, transportSchedules } = converted.datasets.shops;
  Object.assign(extractionContext, { portalScripts, transportSchedules });
  progress("Selecting original map and supported-NPC route closure");
  const routes = selectMapClosure(converted.datasets.shops.npcRoutes);
  progress(`Selected ${mapIds.length} maps; converting shared avatar artwork`);
  const character = await extractionStage(timings, "avatarMs", () =>
    extractAvatar(extractionContext),
  );
  const { quests, combat, drops, serverData, mapNames, ui, audiovisual } =
    await extractionStage(timings, "sharedMs", () => sharedCatalog(converted));
  const { maps, monsters, spawns, reports } = await extractionStage(
    timings,
    "mapsMs",
    () => extractMaps(character, combat),
  );
  const hitboxes = await cached("hitboxes", null, () =>
    reference(extractHitboxReferences(image)),
  );
  const loadingDecoration = await cached("loading", null, () =>
    extractLoadingArt(extractionContext),
  );
  progress("Publishing original-source inventory");
  const originalSources = await reference({
    schemaVersion: 1,
    images: Object.fromEntries(
      Object.entries(inputImages).sort(([a], [b]) => a.localeCompare(b, "en")),
    ),
  });
  const content = {
    defaultMap: mapIds.includes("000010000") ? "000010000" : mapIds[0],
    maps,
    mapNames,
    monsters,
    spawns: { schemaVersion: 1, mobs: spawns },
    originalSources,
    loadingDecoration,
    hitboxes,
    ui,
    audiovisual,
    quests,
    combat,
    drops,
    serverData,
    routes,
  };
  const catalog = {
    schemaVersion: 2,
    buildId: hash(Buffer.from(JSON.stringify(content))),
    ...content,
  };
  await publishCatalog(catalog, reports);
}

async function prepareExtraction() {
  const directory = sources.cacheDir;
  progress(
    `Preparing ${args.includes("--full") ? "full-conversion" : "incremental"} cache: ${directory}`,
  );
  incremental = await createExtractionCache({
    directory,
    full: args.includes("--full"),
    state,
    source: sourceRecord,
    retain: retainSource,
    progress,
  });
  const preflightReport = resolve(
    option("--preflight-report", resolve(directory, "preflight.json")),
  );
  progress("Preflight: scanning original assets and authorized references");
  preflight = await extractionStage(timings, "preflightMs", () =>
    preflightAssets({
      assets: source,
      gameplayDefinitionsRoot: sources.gameplayDefinitionsRoot,
      sqlRoot: sources.sqlRoot,
      maps: explicitMaps ? mapIds : undefined,
      report: preflightReport,
      progress,
    }),
  );
  if (preflight.status !== "pass") {
    throw new Error(
      `Original-asset preflight failed (${preflight.failures.length} findings); previous catalog retained. See ${preflightReport}`,
    );
  }
  progress(`Preflight passed: ${preflight.selection.ids.length} maps`);
}

function selectMapClosure(npcRoutes) {
  extractionContext.npcRoutes = new Map(
    npcRoutes
      .filter((route) => route.status === "supported")
      .map((route) => [route.npcId, route]),
  );
  const routes = explicitMaps
    ? { ids: mapIds, blocked: [], scope: "explicit selected-content release" }
    : collectPlayableMaps(extractionContext, mapIds);
  routes.seeds = mapIds;
  routes.scope ??=
    "original inspection roots with strict portal and supported-NPC closure";
  mapIds = routes.ids;
  extractionContext.mapIds = mapIds;
  for (const id of mapIds) {
    if (
      !Array.isArray(preflight.dependencies[id]) ||
      !preflight.dependencies[id].length
    ) {
      throw new Error(`Preflight omitted complete dependencies for map ${id}`);
    }
  }
  return routes;
}

async function publishCatalog(catalog, reports) {
  progress(`Publishing catalog ${catalog.buildId} (${reports.length} maps)`);
  const encoded = JSON.stringify(catalog);
  if (
    Buffer.byteLength(encoded) > resourceByteLimit("/generated/catalog.json")
  ) {
    throw new Error(
      "Generated catalog exceeds its delivery byte bound; previous catalog retained",
    );
  }
  await publishFile(resolve(output, "catalog.json"), encoded);
  await publishReport(catalog, reports);
}
try {
  await run();
} finally {
  for (const a of archives.values()) a.close();
}
progress(
  `Extraction succeeded: ${mapIds.length} maps; ${incremental.evidence.hits} cached units reused, ${incremental.evidence.misses} converted; elapsed ${((performance.now() - started) / 1000).toFixed(2)}s`,
);
