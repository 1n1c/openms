import { at, resolveNode, value } from "../src/assets/image.js";
import { readRectangle } from "./hitbox-data.js";
import {
  weaponType,
  MELEE_ACTIONS,
  RANGED_ACTIONS,
  weaponActionNames,
  validateWeaponCombat,
} from "../src/combat/weapon-usage.js";

const MAX_ACTIONS = 128;
const MAX_PROPERTIES = 32768;
const MAX_AFTERIMAGE_FRAMES = 64;

/** Preserve original scalar inputs without assigning original damage semantics. */
function scalarFields(node) {
  const result = Object.create(null);
  const children = Object.entries(resolveNode(node).children);
  if (children.length > MAX_PROPERTIES) {
    throw new Error("Combat metadata limit");
  }
  for (const [key, child] of children) {
    const resolved = resolveNode(child);
    if (resolved.value !== undefined) result[key] = resolved.value;
  }
  return result;
}

/** Original00792d21: six job families, zero initial defense, positive values forward-filled. */
function standardDefense(context) {
  const root = context.image("Base", "StandardPDD.img");
  const rows = Array.from({ length: 6 }, () => new Array(201).fill(0));
  for (let family = 0; family < rows.length; family++) {
    const node = root.children[family];
    if (!node) break;
    let current = 0;
    for (let level = 0; level < rows[family].length; level++) {
      const child = node.children[level];
      if (child) {
        const defense = resolveNode(child).value;
        if (!Number.isSafeInteger(defense)) {
          throw new Error(
            `Invalid original standard defense ${family}/${level}`,
          );
        }
        if (defense > 0) current = defense;
      }
      rows[family][level] = current;
    }
  }
  return rows;
}

/** Read all Afterimage canvas frames for one action on one facing.
 *  Each numeric Property directory under the action node is a canvas group
 *  whose NUMBER equals the WEAPON ANIMATION FRAME where this AI should spawn
 *  (matching GM MapleCharacter.pas: IntToStr(Frame) used as group key).
 *  Each canvas has delay (AI frame duration ms), a1 (end alpha 0-255), origin.
 *  Returns [{spawnFrame, delay, alphaEnd, parts:[{texture,x,y,z}]}] or null. */
async function extractAfterimageFrames(context, actionNode) {
  const childKeys = Object.keys(actionNode.children ?? {});
  const numericDirs = childKeys.filter(k => /^\d+$/.test(k));
  const hasTopLevelRect = actionNode.children?.lt && actionNode.children?.rb;

  const groups = [];
  for (const [dirName, child] of Object.entries(actionNode.children)) {
    if (!/^\d+$/.test(dirName)) continue;
    const resolved = resolveNode(child);
    if (!resolved?.children) continue;
    const canvases = [];
    for (const [cname, cchild] of Object.entries(resolved.children)) {
      const cresolved = resolveNode(cchild);
      if (cresolved?.type !== "Canvas") continue;
      canvases.push({ name: cname, node: cresolved });
    }
    if (canvases.length) {
      canvases.sort((a, b) => Number(a.name) - Number(b.name));
      groups.push({ frameIndex: Number(dirName), canvases });
    }
  }
  if (!groups.length) return null;
  groups.sort((a, b) => a.frameIndex - b.frameIndex);

  const frames = [];
  for (const { frameIndex, canvases } of groups) {
    for (const { node: canvasNode } of canvases) {
      if (frames.length >= MAX_AFTERIMAGE_FRAMES) {
        throw new Error("Afterimage frame bound exceeded");
      }
      const part = await context.part(canvasNode, 0, 0, 0, { boostAlpha: true });
      const delayRaw = value(canvasNode, "delay", null);
      const delay = delayRaw === null ? 120 : Number(delayRaw);
      const a1Raw = value(canvasNode, "a1", -1);
      const a1 = Number(a1Raw);
      const alphaEnd = a1 < 0 ? 1 : a1 / 255;
      frames.push({
        // spawnFrame = numeric dir name (matches MapleStory Afterimage.firstframe)
        // melee swingT2/dir"2" → spawnFrame=2 (wait till attack anim frame 2)
        // ranged shoot1/dir"2" → spawnFrame=2
        spawnFrame: frameIndex,
        delay,
        alphaEnd,
        parts: [{ ...part, opacity: 1 }],
      });
    }
  }
  return frames.length ? frames : null;
}

/** One immutable descriptor per actual base weapon, never the cash overlay. */
export async function extractWeaponCombat(context, weaponId) {
  const type = weaponType(weaponId);
  if (!type) return null;
  const weaponPath = `Weapon/${String(weaponId).padStart(8, "0")}.img`;
  const equipment = scalarFields(
    at(context.image("Character", weaponPath), "info"),
  );
  if (equipment.cash) return null;
  const source = `Character.wz:${weaponPath}/info`;

  // --- Basic combat rectangles (schemaVersion 2 baseline) ---
  // Fall back to Weapon/<id>.img/Sword/info (or PoleArm/Axe/etc.) when
  // Afterimage/<afterImage>.img is missing or the field is 0/null.
  let attacks = Object.create(null);
  let schemaVersion = 2;
  let afterimageTexts = Object.create(null); // facing → Set<textureKey>

  // First try: Afterimage/<afterImage>.img — preferred location, has both
  // rectangles AND afterimage visual frames.
  const afterImageId = equipment.afterImage;
  const hasAfterimageFile = afterImageId && afterImageId !== "0";
  if (hasAfterimageFile) {
    const afterimagePath = `Afterimage/${afterImageId}.img`;
    try {
      const root = at(context.image("Character", afterimagePath), "0");
      const children = Object.entries(root.children);
      if (children.length > MAX_ACTIONS) throw new Error("Weapon action limit");
      for (const [name, child] of children) {
        const node = resolveNode(child);
        if (node.children.lt && node.children.rb) {
          attacks[name] = { rectangle: readRectangle(node, `Character.wz:${afterimagePath}/0/${name}`) };
        } else if (!attacks[name]) {
          // Ranged actions (shoot1/shoot2 on bow/crossBow/gun) have no
          // lt/rb rectangle but still need an attack entry so afterimage
          // frames can be attached and animation code can play them.
          attacks[name] = { rectangle: null };
        }
      }

      // Afterimage visual frames — independent of rectangle presence.
      schemaVersion = 3;
      for (const facing of [0, 1]) {
        let facingRoot;
        try { facingRoot = at(context.image("Character", afterimagePath), String(facing)); } catch { continue; }
        if (!facingRoot?.children) continue;
        for (const [actionName, actionNode] of Object.entries(facingRoot.children)) {
          if (!attacks[actionName]) attacks[actionName] = { rectangle: null };
          const attack = attacks[actionName];
          const frames = await extractAfterimageFrames(context, actionNode);
          if (!frames?.length) continue;
          attack.afterimage ||= Object.create(null);
          attack.afterimage[facing] = frames;
          afterimageTexts[facing] ||= new Set();
          for (const f of frames) for (const p of f.parts) afterimageTexts[facing].add(p.texture);
        }
      }
    } catch (afterimageErr) {
      // Afterimage file missing or malformed — fall through to weapon-info rectangles.
      schemaVersion = 2;
      afterimageTexts = Object.create(null);
    }
  }

  // Second try: weapon info rectangles from Weapon/<id>.img/<weaponType>/info
  if (Object.keys(attacks).length === 0) {
    try {
      const weaponRectPath = `Weapon/${String(weaponId).padStart(8, "0")}.img/${type}/info`;
      const weaponRoot = at(context.image("Character", `Weapon/${String(weaponId).padStart(8, "0")}.img`), String(type));
      const rectNode = resolveNode(weaponRoot);
      if (rectNode?.children?.lt && rectNode?.children?.rb) {
        const category = equipment.attack;
        const meleeNames = MELEE_ACTIONS[category];
        if (meleeNames) {
          for (const name of meleeNames) {
            attacks[name] = { rectangle: readRectangle(rectNode, `Character.wz:${weaponRectPath}/${name}`) };
          }
        }
      }
    } catch {
      // Weapon-specific rectangle unavailable — skip; validateWeaponCombat
      // will accept combat with empty attacks (schemaVersion 2).
    }
  }

  const category = equipment.attack;
  if (!MELEE_ACTIONS[category]?.length) {
    throw new Error(`Original basic attack row unavailable: ${weaponId}`);
  }
  const combat = {
    schemaVersion,
    weaponId,
    weaponType: type,
    source: `Character.wz:${weaponPath}/info`,
    equipment,
    attacks,
    defaultAction: MELEE_ACTIONS[category][0],
    proneAction: "proneStab",
    // Export unique AI texture keys per facing so avatar-catalog can wire them
    // into the weapon bundle (making them appear in atlas manifest).
    _afterimageTexts: Object.fromEntries(
      Object.entries(afterimageTexts).map(([k, v]) => [k, [...v]]),
    ),
  };
  completeAttackMetadata(context, combat);
  const validated = validateWeaponCombat(combat);
  validated._afterimageTexts = combat._afterimageTexts; // preserve after atlas injection
  return validated;
}

/** Native shots use the forward ray, not a fabricated melee afterimage rectangle. */
function completeAttackMetadata(context, combat) {
  const ranged = RANGED_ACTIONS[combat.equipment.attack];
  for (const name of weaponActionNames(combat)) {
    if (!combat.attacks[name]) {
      if (!ranged?.includes(name)) {
        throw new Error(
          `Original weapon hit rectangle unavailable: ${combat.weaponId}/${name}`,
        );
      }
      combat.attacks[name] = { rectangle: null };
    }
    combat.attacks[name].timing = attackTiming(context, name);
  }
}

/**00406abd: direct actions release before their final frame; aliases sum negative delays. */
function attackTiming(context, action) {
  const root = at(context.image("Character", "00002000.img"), action);
  let duration = 0,
    release = 0,
    last = 0,
    alias = false;
  const frames = Object.values(root.children);
  if (!frames.length || frames.length > 4096) {
    throw new Error("Weapon timing bound exceeded");
  }
  for (const frame of frames) {
    const data = scalarFields(frame);
    last = data.delay ?? 150;
    if (!Number.isSafeInteger(last)) {
      throw new Error("Invalid original weapon delay");
    }
    alias ||= data.action !== undefined;
    duration += Math.abs(last);
    if (last < 0) release -= last;
  }
  return { duration, release: alias ? release : duration - Math.abs(last) };
}

/** Per-field global inputs only; equipped attack metadata is owned by the avatar. */
export function extractCombat(context) {
  const octoSkill = at(context.image("Skill", "500.img"), "skill/5001003");
  return {
    schemaVersion: 2,
    standardPDD: standardDefense(context),
    capabilities: {
      basicAttack:
        "all original ordinary weapon rows, equipped afterimage geometry and native melee/ranged arbitration",
      skills:
        "learned SkillSystem: catalog-classified sword attacks, self-stat buffs and passive consumers; unrecovered controllers remain unavailable",
      projectile:
        "ordinary bow/crossbow/claw/gun ammunition, authored bullet canvases and native1.5ms/pixel flight",
      summon:
        "unavailable: no learned summon skill or authoritative summon controller; artwork alone never spawns actors",
      mobProjectile:
        "type 1/2 and type 3/4 geometry/controller dependencies unresolved at 0066d9c0",
      scripts:
        "server skill/event scripts not supplied; retained metadata is not executable code",
      drops:
        "unavailable: original server drop tables/ownership not supplied; no synthetic drops",
      restrictedSkill5001003: {
        source: "Skill.wz:500.img/skill/5001003/level/1",
        levelOne: scalarFields(at(octoSkill, "level/1")),
        status:
          "not learned/equipped; selected-skill-only mobs reject basic damage",
      },
      experienceTable:
        "not recovered from retained original consumers or Etc inventory; explicit local quadratic progression",
    },
  };
}

/** Extract hit.img sword/mace impact spark frames from Character.wz Afterimage folder.
 *  hit.img has no facing dimension — one frame sequence per variant, mirror at runtime.
 *  Variants: sword1/sword2 (random pick per sharp hit), mace1/mace2 (random per blunt hit). */
const HIT_VARIANTS = ["sword1", "sword2", "mace1", "mace2"];
const MAX_HIT_FRAMES_PER_VARIANT = 16;

export async function extractHitEffects(context) {
  const image = context.image("Character", "Afterimage/hit.img");
  const actions = Object.create(null);
  const sources = Object.create(null);
  let totalFrames = 0;

  for (const variant of HIT_VARIANTS) {
    const node = image.children[variant];
    if (!node) continue;
    const frames = await context.frames(node);
    if (!frames?.length) continue;
    if (frames.length > MAX_HIT_FRAMES_PER_VARIANT) {
      throw new Error(`Hit effect frame bound exceeded: ${variant}`);
    }
    totalFrames += frames.length;
    if (totalFrames > MAX_AFTERIMAGE_FRAMES * 4) {
      throw new Error("Total hit effect frame bound exceeded");
    }
    actions[variant] = frames;
    sources[variant] = `Character.wz:Afterimage/hit.img/${variant}`;
  }

  if (Object.keys(actions).length === 0) {
    throw new Error("Missing original hit.img variants");
  }

  const entity = {
    id: "hit-effect",
    kind: "effect",
    order: 0,
    x: 0,
    y: 0,
    z: 0,
    visible: false,
    flip: false,
    opacity: 1,
    action: Object.keys(actions)[0],
    actions,
  };

  return context.bundle({
    id: "hit-effects",
    entities: [entity],
    metadata: { sources },
  });
}

/** Compile only release-catalog ammunition; every projectile is its own original bullet animation. */
export async function extractProjectiles(context, items) {
  const entities = [],
    sources = Object.create(null);
  const templates = Object.values(items);
  if (templates.length > MAX_PROPERTIES) {
    throw new Error("Projectile catalog bound exceeded");
  }
  for (const item of templates) {
    const category = Math.trunc(item.id / 10000);
    if (category !== 206 && category !== 207 && category !== 233) continue;
    const path = `Consume/${String(category).padStart(4, "0")}.img`;
    const id = String(item.id).padStart(8, "0");
    const root = at(context.image("Item", path), id);
    sources[item.id] = `Item.wz:${path}/${id}/bullet`;
    const actions = { bullet: await context.frames(at(root, "bullet")) };
    if (root.children.hit) actions.hit = await context.frames(at(root, "hit"));
    entities.push({
      id: String(item.id),
      order: entities.length,
      kind: "effect",
      x: 0,
      y: 0,
      z: 0,
      visible: true,
      flip: false,
      opacity: 1,
      action: "bullet",
      actions,
    });
  }
  return context.bundle({
    id: "ordinary-projectiles",
    entities,
    metadata: { sources },
  });
}
