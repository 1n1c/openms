import { avatarMaps, extractAvatarRecord } from "./avatar-data.js";
import { equippedSlots } from "../src/items/inventory-model.js";
import { extractProjectiles } from "./combat-data.js";
import { extractEquipmentEffects } from "./equipment-effect-data.js";

const MAX_IMAGES = 50000;
const MAX_CATALOG_ITEMS = 32768;
const MAX_APPEARANCES = 256;

/** Catalog dependencies, not archive-wide wardrobe conversion. Release authors may supply
 * avatarAppearances for supported saved/creation choices; the current original profile is explicit. */
function dependencies(context, items) {
  const templates = Object.values(items);
  if (templates.length > MAX_CATALOG_ITEMS) {
    throw new Error("Avatar catalog item bound exceeded");
  }
  //00407757 original gendered underwear substitutions when coat/pants are absent.
  const wanted = new Set([1040036, 1041046, 1060026, 1061039]);
  addEquipmentDependencies(templates, wanted);
  const appearances = context.avatarAppearances ?? [
    { skin: 0, face: 20000, hair: 30000 },
  ];
  if (
    !Array.isArray(appearances) ||
    !appearances.length ||
    appearances.length > MAX_APPEARANCES
  ) {
    throw new Error("Avatar appearance dependency bound exceeded");
  }
  const skins = Object.create(null);
  for (const appearance of appearances) {
    validateAppearance(appearance);
    const body = 2000 + appearance.skin,
      head = 12000 + appearance.skin;
    skins[appearance.skin] = { body, head };
    wanted.add(body);
    wanted.add(head);
    wanted.add(appearance.face);
    wanted.add(appearance.hair);
  }
  return { wanted, skins };
}

function addEquipmentDependencies(templates, wanted) {
  for (const item of templates) {
    if (!Number.isSafeInteger(item.id)) {
      throw new Error("Invalid avatar catalog item ID");
    }
    if (item.id >= 1000000 && item.id < 2000000 && item.info?.islot) {
      wanted.add(item.id);
    }
  }
}

function validateAppearance(appearance) {
  if (
    !Number.isInteger(appearance.skin) ||
    appearance.skin < 0 ||
    appearance.skin > 255 ||
    !Number.isInteger(appearance.face) ||
    appearance.face < 10000 ||
    appearance.face > 99999 ||
    !Number.isInteger(appearance.hair) ||
    appearance.hair < 10000 ||
    appearance.hair > 99999
  ) {
    throw new Error("Invalid release avatar appearance");
  }
}

function sources(context, wanted) {
  const entries = context.imageEntries("Character");
  if (!(entries instanceof Map) || entries.size > MAX_IMAGES) {
    throw new Error("Invalid avatar original image index");
  }
  const result = new Map();
  for (const path of entries.keys()) {
    const match = /(?:^|\/)(\d{8})\.img$/.exec(path);
    if (!match || !wanted.has(Number(match[1]))) continue;
    const id = Number(match[1]);
    if (result.has(id)) throw new Error(`Ambiguous avatar source ${id}`);
    result.set(id, { id, kind: sourceKind(path, id), path });
  }
  for (const id of wanted) {
    if (!result.has(id)) {
      throw new Error(`Missing original avatar dependency ${id}`);
    }
  }
  return result;
}

function sourceKind(path, id) {
  if (!path.includes("/")) return id < 10000 ? "body" : "head";
  if (path.startsWith("Face/")) return "face";
  if (path.startsWith("Hair/")) return "hair";
  return "equipment";
}

/** Pixel references occur in bounded ordinary visual entities; metadata retains only part records.
 * Empty ring/pendant/medal/belt/dragon records stay explicitly nonvisual, never invented art. */
async function packageRecord(context, record) {
  const entities = [];
  for (const [name, frames] of Object.entries(record.frames)) {
    const available = frames.filter((frame) => frame !== null);
    if (!available.length) continue;
    const packaged = available.map((frame) => ({
      delay: frame.delay,
      parts: frame.parts.map((part) => ({
        texture: part.texture,
        x: part.x,
        y: part.y,
        z: part.z,
      })),
    }));
    entities.push({
      id: `avatar:${record.id}:${name}`,
      order: entities.length,
      kind: "character",
      x: 0,
      y: 0,
      z: 0,
      visible: true,
      flip: false,
      opacity: 1,
      action: "default",
      actions: { default: packaged },
    });
  }

  // Afterimage entities: inject AI textures into this bundle's atlas.
  // We create one entity per facing whose single "frame" has one part per unique
  // AI texture — this forces all AI textures into the atlas manifest.
  if (record.combat?._afterimageTexts) {
    for (const [facing, textKeys] of Object.entries(record.combat._afterimageTexts)) {
      if (!textKeys?.length) continue;
      entities.push({
        id: `avatar:${record.id}:ai${facing}`,
        order: entities.length,
        kind: "character",
        x: 0, y: 0, z: 0,
        visible: false, // never rendered as part of the weapon action
        flip: false, opacity: 1,
        action: "default",
        actions: {
          default: [{
            delay: 1,
            parts: textKeys.map((textureKey, i) => ({
              texture: textureKey,
              x: 0, y: 0, z: i,
            })),
          }],
        },
      });
    }
  }

  return context.bundle({
    id: `avatar:${record.id}`,
    entities,
    metadata: { avatar: record },
  });
}

/** Returns exactly catalog.ui.avatar. Each ID owns one lazy visual descriptor; no runtime WZ. */
export async function extractAvatarCatalog(context, items) {
  const { wanted, skins } = dependencies(context, items);
  const originals = sources(context, wanted);
  const maps = avatarMaps(context);
  const entries = Object.create(null);
  for (const input of originals.values()) {
    const record = await extractAvatarRecord(context, input, maps);
    entries[record.id] = {
      id: record.id,
      kind: record.kind,
      source: record.source,
      visual: record.visual,
      islot: record.islot,
      cash: record.cash,
      stand: record.stand,
      walk: record.walk,
      attack: record.attack,
      combat: record.combat,
      unresolved: record.unresolved,
      equippedSlots:
        record.kind === "equipment"
          ? equippedSlots({ id: record.id, info: record })
          : [],
      descriptor: await packageRecord(context, record),
    };
  }
  return {
    schemaVersion: 1,
    entries,
    skins,
    equipmentEffects: await extractEquipmentEffects(context, wanted),
    projectiles: await extractProjectiles(context, items),
  };
}
