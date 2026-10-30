import { animationId, protocolError } from "../../shared/protocol.js";
import { inventoryType } from "../../client/src/items/inventory-model.js";
import { progressQuestViews } from "./interaction-quest.js";
import { UPGRADE_STATS } from "../../client/src/profile/profile-item-state.js";
import { equipmentUpgrade } from "../../client/src/items/equipment-enhancement.js";
import { nativePresentationParts } from "./native-presentation.js";
import { actorWorldFields } from "./field-world-actions.js";
import { actorCombatFields, mobCombatFields } from "./field-combat.js";
import { dropInfo } from "./field-drops.js";

const TABS = ["equip", "use", "setup", "etc", "cash"];
const STATS = [
  "str",
  "dex",
  "int",
  "luk",
  "hp",
  "mp",
  "pad",
  "mad",
  "pdd",
  "mdd",
  "acc",
  "eva",
  "speed",
  "jump",
];

export function fieldReference(actor) {
  return {
    instanceId: actor.field.id,
    mapId: actor.field.mapId,
    fieldEpoch: actor.field.epoch,
    spawn: { x: actor.arrival.x, y: actor.arrival.y },
  };
}

export function actorEntity(actor) {
  const sim = actor.simulation;
  const profile = actor.profile;
  const name =
    profile.hp <= 0 ? "dead" : (actor.skillField?.action ?? sim.action);
  return {
    id: actor.id,
    kind: "player",
    templateId: 0,
    position: { x: sim.x, y: sim.y },
    velocity: { x: sim.vx, y: sim.vy },
    foothold: sim.foothold?.id ?? null,
    facing: sim.facing,
    action: animationId(name),
    actionStartTick: actor.actionStartTick,
    playerMotion: baselinePlayerMotion(actor),
    appearance: {
      name: profile.name,
      gender: profile.gender,
      ...profile.appearance,
      equipment: profile.equipment.map((item) => ({
        slot: Math.abs(item.slot),
        templateId: item.id,
      })),
    },
    ...actorWorldFields(actor),
    ...actorCombatFields(actor),
  };
}

/** The baseline covers recorded samples in this field only, including queued bursts. */
function baselinePlayerMotion(actor) {
  const projection = playerMotion(actor.simulation);
  const pathTick =
    actor.peerMoveQueue?.epoch === actor.field?.epoch
      ? actor.peerMoveQueue?.tick
      : null;
  projection.pathTick = pathTick ?? actor.field?.tick ?? 0;
  return projection;
}

/** Compact presentation-only coefficients, derived from admitted state, not another full checkpoint. */
function playerMotion(sim) {
  const settings = sim.effectiveSettings;
  return {
    state: sim.state,
    gravity: settings.gravityAcc * settings.gravity,
    fallSpeed: settings.fallSpeed * settings.gravity,
    ignoredFoothold: sim.ignoredFootholdId,
    contactLayer: sim.contactLayer,
    contactGroup: sim.contactGroup,
    ladder: sim.ladder
      ? { x: sim.ladder.x, top: sim.ladder.y1, bottom: sim.ladder.y2 }
      : null,
  };
}

/** Authority sample for peer path replay. Position, velocity, contact and action match
 * the recovered path inputs; movement coefficients/contact planes are OpenMS metadata. */
export function peerMotionEntity(actor) {
  const sim = actor.simulation;
  return {
    id: actor.id,
    position: { x: sim.x, y: sim.y },
    velocity: { x: sim.vx, y: sim.vy },
    foothold: sim.foothold?.id ?? null,
    facing: sim.facing,
    action: animationId(
      actor.profile.hp <= 0 ? "dead" : (actor.skillField?.action ?? sim.action),
    ),
    actionStartTick: actor.actionStartTick,
    playerMotion: playerMotion(sim),
  };
}

export function lifeEntity(entity, kind) {
  return {
    id: entity.id,
    kind,
    templateId: entity.templateId,
    ...(kind === "mob" && entity.placementId !== undefined
      ? { placementId: entity.placementId }
      : {}),
    position: { x: entity.x, y: entity.y },
    velocity: { x: 0, y: 0 },
    // Mob entities (from offline-mobs.js) carry `.foothold` (the current segment),
    // NPC entities use `.segment`. Both have an `.id` field when set.
    foothold: (entity.foothold ?? entity.segment)?.id ?? null,
    facing: entity.facing ?? -1,
    action: animationId(entity.action ?? "stand"),
    actionStartTick: entity.actionStartTick ?? 0,
    appearance: null,
    ...(kind === "mob" ? mobCombatFields(entity) : {}),
    ...(kind === "npc" ? { npcSpeech: entity.npcSpeech ?? null } : {}),
  };
}

export function dropEntity(drop) {
  return {
    id: drop.id,
    kind: "drop",
    templateId: drop.item?.id ?? 0,
    position: { x: drop.position.x, y: drop.position.y },
    velocity: { x: 0, y: 0 },
    foothold: drop.foothold?.id ?? null,
    facing: 1,
    action: animationId(
      drop.item
        ? "stand"
        : `currency${drop.mesos < 50 ? 0 : drop.mesos < 100 ? 1 : drop.mesos < 1000 ? 2 : 3}`,
    ),
    actionStartTick: 0,
    appearance: null,
    dropInfo: dropInfo(drop),
    dropMotion: {
      state: drop.state,
      age: drop.age,
      phaseAge: drop.phaseAge,
      sourceX: drop.sourceX,
      sourceY: drop.sourceY,
      groundX: drop.groundX,
      groundY: drop.groundY,
      durationMs: drop.durationMs,
      launchSpeed: drop.launchSpeed,
      rotation: drop.rotation,
      alpha: drop.alpha,
    },
  };
}

export function itemView(item, revision, equipped = false, items) {
  let equipment = null;
  if (inventoryType(item.id) === 1) {
    const upgrade = equipmentUpgrade(item, items[item.id]);
    equipment = {
      // Catalogs built before numeric info Strings were read as integers can still hold "1"; the
      // protocol rejects a string stat, which would lock the owner out of every join.
      upgradesRemaining: Number(upgrade?.slots ?? 0),
      upgradesUsed: Number(upgrade?.level ?? 0),
      stats: STATS.flatMap((key, index) =>
        upgrade?.stats?.[UPGRADE_STATS[index]] === undefined
          ? []
          : [{ key, value: Number(upgrade.stats[UPGRADE_STATS[index]]) }],
      ),
    };
  }
  return {
    id: item.uid,
    templateId: item.id,
    quantity: item.count,
    owner: item.owner,
    flags: item.flags,
    expiresAt: item.expiresAt,
    location: equipped
      ? { kind: "equipped", slot: Math.abs(item.slot) }
      : {
          kind: "inventory",
          tab: TABS[inventoryType(item.id) - 1],
          slot: item.slot,
        },
    revision,
    equipment,
  };
}

export function selfView(actor) {
  const p = actor.profile;
  return {
    entity: actorEntity(actor),
    hp: p.hp,
    mp: p.mp,
    maxHp: p.maxHP,
    maxMp: p.maxMP,
    job: p.job,
    level: p.level,
    exp: p.exp,
    ap: p.remainingAp,
    sp: p.remainingSp.slice(),
    stats: { str: p.str, dex: p.dex, int: p.int, luk: p.luk },
    effects: (p.onlineState?.effects ?? []).map((effect) => ({
      id: effect.id,
      templateId: effect.templateId,
      kind: effect.kind,
      duration:
        effect.duration ?? (effect.kind === "item" ? effect.spec.time : null),
      expiresAt: effect.expiresAt,
      cancelable: effect.cancelable,
    })),
  };
}

function pages(parts, key, values, metadata) {
  for (let start = 0; start < Math.max(1, values.length); start += 128) {
    if (parts.length >= 64) throw protocolError("SERVER_BUSY");
    parts.push({
      kind: metadata.kind,
      [key]: values.slice(start, start + 128),
      ...metadata,
    });
  }
}

export function snapshotParts(world, actor) {
  const p = actor.profile;
  const parts = [
    {
      kind: "field",
      field: fieldReference(actor),
      characterRevision: actor.revision,
      inventoryRevision: actor.inventoryRevision,
      socialRevision: actor.socialRevision,
      self: selfView(actor),
    },
  ];
  pages(parts, "entities", world.entities(actor), { kind: "entities" });
  const items = p.inventory.map((item) =>
    itemView(item, actor.inventoryRevision, false, world.content.items),
  );
  for (const item of p.equipment) {
    items.push(
      itemView(item, actor.inventoryRevision, true, world.content.items),
    );
  }
  const capacities = Object.fromEntries(
    TABS.map((tab, i) => [tab, p.inventorySlots[i]]),
  );
  pages(parts, "items", items, {
    kind: "inventory",
    mesos: p.meso,
    capacities,
  });
  const skills = Object.entries(p.skills).map(([id, skill]) => ({
    id: Number(id),
    rank: skill.level,
    mastery: skill.masterLevel,
    cooldownUntil: p.onlineState?.cooldowns?.[`skill:${id}`] ?? 0,
  }));
  const quests = progressQuestViews(actor, world);
  pages(parts, "quests", quests, { kind: "progress", skills: [] });
  if (skills.length) {
    pages(parts, "skills", skills, { kind: "progress", quests: [] });
  }
  parts.push(...nativePresentationParts(actor, world));
  return parts;
}
