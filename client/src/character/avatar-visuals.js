import { EntityAnimation } from "../rendering/animation.js";
import {
  AVATAR_LIMITS,
  avatarSlots,
  composeAvatar,
  validateAvatarRecord,
  validateAvatarUnresolved,
  avatarSpeechHeights,
} from "./avatar-composition.js";
import { loadVisualBundle } from "../rendering/visual-resources.js";
import { resource } from "../rendering/stream-validation.js";
import {
  MELEE_ACTIONS,
  RANGED_ACTIONS,
  weaponType,
  applyWeaponAttackSpeed,
  validateWeaponCombat,
} from "../combat/weapon-usage.js";
import {
  validateEquipmentEffectCatalog,
  selectEquipmentEffect,
  leasedEquipmentEffect,
} from "../items/equipment-effect-model.js";

const MAX_CATALOG = 32768;
//00407757 explicitly removes these transparent cash templates before composition.
const INVISIBLE_EQUIPMENT = new Set([
  1002186, 1032024, 1022079, 1072153, 1082102, 1102039, 1092067, 1702099,
  1702190,
]);

function validateCatalog(catalog) {
  const index = catalog?.ui?.avatar ?? catalog;
  if (index?.schemaVersion !== 1 || !index.entries || !index.skins) {
    throw new Error("Missing static avatar catalog");
  }
  const entries = Object.entries(index.entries);
  if (entries.length > MAX_CATALOG) {
    throw new Error("Avatar catalog bound exceeded");
  }
  for (const [key, entry] of entries) validateCatalogEntry(key, entry);
  validateEquipmentEffectCatalog(index.equipmentEffects);
  return index;
}

function validateCatalogEntry(key, entry) {
  if (
    String(entry.id) !== key ||
    !Number.isSafeInteger(entry.id) ||
    typeof entry.visual !== "boolean" ||
    typeof entry.source !== "string" ||
    !["body", "head", "face", "hair", "equipment"].includes(entry.kind)
  ) {
    throw new Error("Invalid avatar catalog entry");
  }
  avatarSlots(entry.islot);
  validateAvatarUnresolved(entry.unresolved);
  validateCatalogEquipment(entry);
  resource(entry.descriptor);
}

function validateCatalogEquipment(entry) {
  if (
    ![0, 1].includes(entry.cash) ||
    ![0, 1, 2].includes(entry.stand) ||
    ![0, 1, 2].includes(entry.walk) ||
    !Array.isArray(entry.equippedSlots) ||
    entry.equippedSlots.length > 8 ||
    entry.equippedSlots.some(
      (slot) => !Number.isInteger(slot) || slot >= 0 || slot < -199,
    )
  ) {
    throw new Error("Invalid avatar catalog equipment metadata");
  }
}

function catalogEntry(index, id, kind) {
  const entry = index.entries[id];
  if (!entry || entry.kind !== kind) {
    throw new Error(`Appearance ${id} is not in this offline release`);
  }
  return entry;
}

/** Profile instances remain untouched. Cash positions101+ overlay the corresponding normal slot. */
function visibleEquipment(profile, index) {
  if (
    !Array.isArray(profile.equipment) ||
    profile.equipment.length > AVATAR_LIMITS.items - 4 ||
    ![0, 1].includes(profile.gender)
  ) {
    throw new Error("Invalid avatar profile equipment");
  }
  const ordinary = new Map(),
    cash = new Map();
  for (const item of profile.equipment) {
    insertEquipment(item, index, ordinary, cash);
  }
  const selected = new Map(ordinary);
  for (const [slot, id] of cash) selected.set(slot, id);
  applyClothingSelection(selected, index, profile.gender);
  for (const [slot, id] of selected) {
    if (INVISIBLE_EQUIPMENT.has(id)) selected.delete(slot);
  }
  return { selected, weapon: ordinary.get(11) ?? 0 };
}

function insertEquipment(item, index, ordinary, cash) {
  if (
    !Number.isSafeInteger(item.id) ||
    !Number.isInteger(item.slot) ||
    item.slot >= 0 ||
    item.slot < -199
  ) {
    throw new Error("Invalid avatar equipment instance");
  }
  const entry = catalogEntry(index, item.id, "equipment");
  if (!entry.equippedSlots.includes(item.slot)) {
    throw new Error("Avatar instance occupies an unauthored slot");
  }
  const position = -item.slot,
    target = position > 100 ? cash : ordinary;
  const slot = position > 100 ? position - 100 : position;
  if (target.has(slot)) throw new Error("Duplicate avatar equipped position");
  target.set(slot, item.id);
}

function applyClothingSelection(selected, index, gender) {
  //00407757: overall vs cash pants is resolved before gendered underwear substitutions.
  const overall = selected.get(5);
  if (Math.floor(overall / 10000) === 105 && selected.has(6)) {
    if (index.entries[overall].cash || !index.entries[selected.get(6)].cash) {
      selected.delete(6);
    } else selected.delete(5);
  }
  if (!selected.has(5)) selected.set(5, gender ? 1041046 : 1040036);
  if (!selected.has(6) && Math.floor(selected.get(5) / 10000) !== 105) {
    selected.set(6, gender ? 1061039 : 1060026);
  }
}

function selectAppearance(profile, index) {
  const appearance = profile?.appearance;
  const skin = appearanceSkin(appearance, index);
  const { selected, weapon } = visibleEquipment(profile, index);
  selected.set(0, appearance.hair);
  const equipmentEffect = selectEquipmentEffect(
    index.equipmentEffects,
    selected,
  );
  const entries = [
    catalogEntry(index, skin.body, "body"),
    catalogEntry(index, skin.head, "head"),
    catalogEntry(index, appearance.hair, "hair"),
    catalogEntry(index, appearance.face, "face"),
  ];
  for (const [slot, id] of [...selected].sort((a, b) => a[0] - b[0])) {
    if (slot === 0) continue;
    //0041272c excludes mounted/dragon actors18..20; those are not body parts.
    if (slot >= 18 && slot <= 20) continue;
    entries.push(catalogEntry(index, id, "equipment"));
  }
  const baseWeapon = index.entries[weapon];
  validateWeaponCombat(baseWeapon ? baseWeapon.combat : null);
  return {
    entries,
    equipmentEffect,
    skin: appearance.skin,
    weaponFamily: weaponType(weapon),
    combat: baseWeapon?.combat ?? null,
    attack: baseWeapon?.attack ?? 0,
    //004515bd unarmed defaults1;00451ec8 uses family2 whenever authored value differs from1.
    hiddenSlots: selected.has(1) ? "" : "H4H5",
    stand: weaponPoseFamily(baseWeapon, "stand"),
    walk: weaponPoseFamily(baseWeapon, "walk"),
  };
}

/** Share exact visible equipment selection with the verified offline working set. */
export function avatarResourceDescriptors(catalog, profile) {
  const index = catalog?.ui?.avatar ?? catalog;
  const selection = selectAppearance(profile, index);
  const resources = selection.entries.map((entry) => entry.descriptor);
  if (selection.equipmentEffect) {
    resources.push(selection.equipmentEffect.descriptor);
  }
  return resources;
}

function weaponPoseFamily(weapon, pose) {
  return weapon ? (weapon[pose] === 1 ? 1 : 2) : 1;
}

function appearanceSkin(appearance, index) {
  if (
    !appearance ||
    !Number.isInteger(appearance.skin) ||
    !Number.isSafeInteger(appearance.face) ||
    !Number.isSafeInteger(appearance.hair)
  ) {
    throw new Error("Invalid avatar appearance");
  }
  const skin = index.skins[appearance.skin];
  if (!skin) {
    throw new Error(`Skin ${appearance.skin} is not in this offline release`);
  }
  return skin;
}

function actorEntity(actor, appearance) {
  const entity = actor
    ? { ...actor }
    : {
        id: "avatar-portrait",
        order: 0,
        kind: "character",
        x: 0,
        y: 0,
        z: 0,
        visible: true,
        flip: false,
        opacity: 1,
        action: "stand1",
      };
  entity.actions = appearance.actions;
  entity.equipment = appearance.equipment;
  entity.unresolved = appearance.unresolved;
  return entity;
}

function composedEntity(entity, records, selection) {
  const result = actorEntity(entity, composeAvatar(records, selection));
  applyWeaponAttackSpeed(result.actions, selection.combat);
  result.avatar = {
    standAction: `stand${selection.stand}`,
    walkAction: `walk${selection.walk}`,
    weaponFamily: selection.weaponFamily,
    combat: selection.combat,
    speechHeights: avatarSpeechHeights(result.actions),
  };
  if (result.action === "stand1" || result.action === "stand2") {
    result.action = result.avatar.standAction;
  }
  if (result.action === "walk1" || result.action === "walk2") {
    result.action = result.avatar.walkAction;
  }
  return result;
}

/** Bounds are original pixels around feet(0,0), excluding non-default expression overlays. */
function idleBounds(entity, textures, action) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const frame of entity.actions[action]) {
    for (const part of frame.parts) {
      if (part.expression && part.expression !== "default") continue;
      const texture = textures.get(part.texture);
      if (!texture) throw new Error("Missing composed avatar texture");
      left = Math.min(left, part.x);
      top = Math.min(top, part.y);
      right = Math.max(right, part.x + texture.width);
      bottom = Math.max(bottom, part.y + texture.height);
    }
  }
  if (![left, top, right, bottom].every(Number.isFinite)) {
    throw new Error("Missing authored avatar idle art");
  }
  const bounds = { left, top, right, bottom };
  includeEquipmentBounds(bounds, entity, textures, action);
  return {
    ...bounds,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
  };
}

function includeEquipmentBounds(bounds, entity, textures, action) {
  const effect = entity.avatar.equipmentEffect;
  if (!effect) return;
  const anchor =
    effect.pos === 1 ? entity.actions[action][0].effectAnchor : null;
  const x = anchor?.x ?? 0,
    y = anchor?.y ?? 0;
  for (const frame of effect.frames) {
    for (const part of frame.parts) {
      const texture = textures.get(part.texture);
      const left = part.x + x,
        top = part.y + y;
      bounds.left = Math.min(bounds.left, left);
      bounds.top = Math.min(bounds.top, top);
      bounds.right = Math.max(bounds.right, left + texture.width);
      bounds.bottom = Math.max(bounds.bottom, top + texture.height);
    }
  }
}

function preparedOwner(entity, resources, textures, selection) {
  let destroyed = false;
  return {
    entity,
    textures,
    standAction: `stand${selection.stand}`,
    walkAction: `walk${selection.walk}`,
    weaponFamily: selection.weaponFamily,
    attackCategory: selection.attack,
    bounds: idleBounds(entity, textures, `stand${selection.stand}`),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const owner of resources) owner.destroy();
      textures.clear();
    },
  };
}

/** Detached playback reuses the field's compiled authored periods and climb-hold rules. */
function preparedPreview(animation, resource) {
  const ranged = resource.weaponFamily === 45 || resource.weaponFamily === 46;
  const attacks = (ranged ? RANGED_ACTIONS : MELEE_ACTIONS)[
    resource.attackCategory
  ];
  let destroyed = false;
  let poseAction = resource.standAction;
  animation.setAction(poseAction);
  return {
    root: animation.container,
    bounds: resource.bounds,
    get speechHeight() {
      return resource.entity.avatar.speechHeights[animation.action];
    },
    get attacking() {
      return animation.playback === "once" && !animation.completed;
    },
    pose(simulation) {
      poseAction =
        simulation.action === "stand1"
          ? resource.standAction
          : simulation.action === "walk1"
            ? resource.walkAction
            : simulation.action;
      if (!this.attacking) animation.setAction(poseAction);
      const climbAction = poseAction === "ladder" || poseAction === "rope" || poseAction === "ladder2" || poseAction === "rope2";
      animation.container.scale.x = climbAction ? 1 : (simulation.facing > 0 ? -1 : 1);
      animation.holdFrame =
        !this.attacking &&
        simulation.state === "ladder" &&
        simulation.y === simulation.previousY;
    },
    attack(prone) {
      if (destroyed || this.attacking || !attacks?.length) return false;
      const name = prone
        ? "proneStab"
        : attacks[Math.floor(Math.random() * attacks.length)];
      const action = animation.actions.get(name);
      if (!action || action.duration <= 0) return false;
      animation.setAction(name, "once");
      animation.holdFrame = false;
      return true;
    },
    update(ms) {
      if (destroyed) return;
      animation.advance(ms);
      if (animation.playback === "once" && animation.completed) {
        animation.setAction(poseAction);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      animation.container.destroy({ children: true });
      resource.destroy();
    },
  };
}

function leasedRecord(entry, owner) {
  const record = validateAvatarRecord(owner.manifest.metadata.avatar);
  if (
    record.id !== entry.id ||
    record.kind !== entry.kind ||
    record.source !== entry.source
  ) {
    throw new Error("Avatar descriptor identity mismatch");
  }
  for (const frames of Object.values(record.frames)) {
    for (const frame of frames) {
      if (!frame) continue;
      for (const part of frame.parts) {
        if (!owner.textures.has(part.texture)) {
          throw new Error("Avatar record references unleased pixels");
        }
      }
    }
  }
  return record;
}

/** One request loads only equipped/base IDs sequentially under existing network/atlas budgets.
 * Completed owners have independent leases; aborting a later request never invalidates visible art. */
export class AvatarVisuals {
  constructor(services, catalog) {
    this.services = services;
    this.index = validateCatalog(catalog);
    this.loadVisual = services.loadVisual ?? loadVisualBundle;
  }

  async prepare(profile, { signal, entity } = {}) {
    const requestSignal = signal ?? new AbortController().signal;
    requestSignal.throwIfAborted();
    const selection = selectAppearance(profile, this.index);
    const resources = [],
      records = [],
      textures = new Map();
    try {
      for (const entry of selection.entries) {
        requestSignal.throwIfAborted();
        const owner = await this.loadVisual(
          entry.descriptor,
          this.services,
          requestSignal,
        );
        resources.push(owner);
        requestSignal.throwIfAborted();
        records.push(leasedRecord(entry, owner));
        for (const [id, texture] of owner.textures) {
          if (!textures.has(id)) textures.set(id, texture);
        }
      }
      const result = composedEntity(entity, records, selection);
      if (selection.equipmentEffect) {
        const owner = await this.loadVisual(
          selection.equipmentEffect.descriptor,
          this.services,
          requestSignal,
        );
        resources.push(owner);
        result.avatar.equipmentEffect = leasedEquipmentEffect(
          selection.equipmentEffect,
          owner,
        );
        for (const [id, texture] of owner.textures) {
          if (!textures.has(id)) textures.set(id, texture);
        }
      }
      requestSignal.throwIfAborted();
      return preparedOwner(result, resources, textures, selection);
    } catch (error) {
      for (const owner of resources) owner.destroy();
      textures.clear();
      throw error;
    }
  }

  /** CashShop preview is a detached appearance proposal, never a durable inventory mutation. */
  async preparePreview({ profile, itemIds = [], removeAll = false, signal }) {
    if (!Array.isArray(itemIds) || itemIds.length > AVATAR_LIMITS.items - 4) {
      throw new Error("Invalid avatar preview request");
    }
    const preview = previewProfile(profile, this.index, itemIds, removeAll);
    const resource = await this.prepare(preview, { signal });
    let animation;
    try {
      signal?.throwIfAborted();
      animation = new EntityAnimation(resource.entity, resource.textures);
      return preparedPreview(animation, resource);
    } catch (error) {
      animation?.container.destroy({ children: true });
      resource.destroy();
      throw error;
    }
  }
}

function previewProfile(profile, index, itemIds, removeAll) {
  if (
    !Array.isArray(profile.equipment) ||
    profile.equipment.length > AVATAR_LIMITS.items - 4
  ) {
    throw new Error("Invalid avatar preview equipment");
  }
  const equipment = removeAll
    ? []
    : profile.equipment.map((item) => ({ ...item }));
  for (const id of itemIds) {
    const entry = catalogEntry(index, id, "equipment");
    const slots = entry.equippedSlots;
    if (!Array.isArray(slots) || !slots.length) {
      throw new Error(`Item ${id} has no authored preview position`);
    }
    const slot = slots[0];
    removePreviewConflicts(equipment, id, slot);
    equipment.push({ id, slot });
  }
  return { ...profile, equipment };
}

function removePreviewConflicts(equipment, id, slot) {
  //A trial replaces conflicting wear in its own layer;00407757 arbitrates the remaining cash overlay.
  const cashLayer = slot < -100;
  const category = Math.floor(id / 10000);
  for (let position = equipment.length - 1; position >= 0; position--) {
    const incumbent = equipment[position];
    if (incumbent.slot < -100 !== cashLayer) continue;
    const incumbentCategory = Math.floor(incumbent.id / 10000);
    const clothingConflict =
      (category === 106 && incumbentCategory === 105) ||
      (category === 105 && incumbentCategory === 106);
    if (incumbent.slot === slot || clothingConflict) {
      equipment.splice(position, 1);
    }
  }
}
