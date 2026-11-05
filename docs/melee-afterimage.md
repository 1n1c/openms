# Melee Afterimage — Implementation & Troubleshooting

## Overview

Melee afterimages are transient visual particles that appear behind a character
during melee weapon attacks. They are **not** procedurally generated — the
original MapleStory client authoring includes per-action, per-facing particle
frames in `Character.wz/Afterimage/<id>.img`.

This document records the full data flow, required resources, and a diagnostic
checklist for when afterimages fail to appear.

---

## End-to-End Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. Character.wz.zip (original MapleStory client archive)        │
│    └─ Afterimage/<afterImageId>.img                             │
│        ├─ 0/<action>  → melee hitbox rectangles (attack zone)   │
│        └─ <facing>/<action> → afterimage particle frames         │
│           (facing ∈ {0,1}; action ∈ {swing*, stab*, ...})        │
└──────────────────────────┬──────────────────────────────────────┘
                           │ bun tools/extract.js
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. client/public/generated/catalog.json                         │
│    → ui.avatar.entries[slot][weaponId].combat                   │
│      {                                                          │
│        schemaVersion: 3,    // 3 = has afterimage frames         │
│        weaponId, weaponType, equipment,                         │
│        attacks: {                                               │
│          swingO1: {                                             │
│            rectangle: { lt, rb },  // melee hitbox              │
│            afterimage: {                                        │
│              1: [ {spawnFrame, parts: [{texture,x,y,...}] } ]    │
│            }                                                    │
│          }                                                      │
│        }                                                        │
│      }                                                          │
└──────────────────────────┬──────────────────────────────────────┘
                           │ bun run build (packs catalog parsing + runtime code)
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. dist/main.js (bundled client)                                │
│                                                                 │
│    [runtime] avatar-visuals.js::selectAppearance()              │
│      → selection.combat = baseWeapon?.combat ?? null             │
│                                                                 │
│    [runtime] animation.js::tryPlayAfterimage()  [called on setAction()]
│      → combat = this.avatar?.combat                              │
│      → attack = combat.attacks[action]                           │
│      → framesByFacing = attack?.afterimage                       │
│      → if (!combat || !framesByFacing) return  ← early exit!     │
│      → queue _pendingAfterimageSpawns                            │
│                                                                 │
│    [runtime] animation.js::advanceAfterimages(ms)  [per frame]   │
│      → when frame >= spawnFrame                                  │
│      → new AfterimageEffect(particleData)                        │
│                                                                 │
│    [runtime] afterimage-effect.js                                │
│      → renders translucent particle copies behind actor          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Required Resources

| Resource | Path | Purpose |
|---|---|---|
| Character.wz.zip | Extracted from original MapleStory client install | Must contain `Afterimage/` subdirectory |
| `Afterimage/<id>.img/0/<action>` | Character.wz → melee hitbox rectangles | Attack zone for validation |
| `Afterimage/<id>.img/<facing>/<action>` | Character.wz → afterimage frames | Visual particle data |
| `Weapon/<id>.img/<weaponType>/info` | Character.wz → fallback rectangles | Used when Afterimage file missing |
| catalog.json | `client/public/generated/` | Weapon combat data mount point |
| dist/main.js | Server static root | Bundled runtime with catalog resolver |

---

## Troubleshooting Checklist

**Symptom: Sound works but afterimage never appears.**

Sound and afterimage are independent code paths. Sound uses `public/generated/audio/`
(extraction artifact), while afterimage depends on weapon combat data in
`catalog.json`. If combat extraction fails, all weapons get `.combat: null` and
afterimage silently returns early.

### Step 1 — Verify extraction is clean

Delete stale artifacts and re-extract:

```bash
rm -rf client/public/generated
# Ensure Character.wz.zip is the original (not corrupted or partial)
# → should contain Afterimage/ subdirectory at top level
bun tools/extract.js --assets <path-to-Maplestory-Client>
```

### Step 2 — Check catalog.json for combat data

```bash
bun -e "
const c = require('./client/public/generated/catalog.json');
const entries = c.ui?.avatar?.entries || {};
let withCombat = 0;
for (const [slot, items] of Object.entries(entries)) {
  if (typeof items !== 'object') continue;
  for (const [id, entry] of Object.entries(items)) {
    if (entry?.combat) withCombat++;
  }
}
console.log('Weapons with combat data:', withCombat);
"
```

**Expected**: non-zero count. If 0 → combat extraction is failing.

### Step 3 — Check Character.wz integrity

Verify the Afterimage directory exists in the original archive:

```bash
# Inspect Character.wz.zip or extracted Character.wz
unzip -l Character.wz.zip | grep Afterimage | head -5
# Should show entries like: Afterimage/00000000.img, Afterimage/00000001.img, ...
```

**Expected**: hundreds of `.img` files under `Afterimage/`.
**If missing**: the archive is incomplete or the wrong version of the game client.

### Step 4 — Rebuild client bundle

Combat extraction changes require a fresh `dist/main.js`:

```bash
cd client && bun run build
# Then restart the server so it serves new dist files
```

### Step 5 — Browser DevTools

In Console tab, search for any error mentioning `combat`, `afterimage`, or
`Invalid original equipped combat metadata` — these indicate
`validateWeaponCombat()` rejecting a weapon's combat data.

---

## combat-data.js — Defensive Extraction

The original `extractWeaponCombat()` had hard `at()` lookups that threw
immediately when `Afterimage/<afterImage>.img` was missing (common when
the weapon's `info.afterImage` field is `0` or the WZ archive has incomplete
Afterimage coverage). A single throw cancelled combat extraction for **all**
weapons, resulting in 0 entries in catalog.json.

The current implementation follows a **try-then-fallback** strategy:

1. **Try preferred path**: `Afterimage/<afterImage>.img` — provides both
   melee hitbox rectangles (from `/0/<action>`) and afterimage visual frames
   (from `/<facing>/<action>`). Sets `schemaVersion: 3`.

2. **Fallback**: `Weapon/<id>.img/<weaponType>/info` — provides only the
   melee hitbox rectangles needed for combat validation. Sets
   `schemaVersion: 2` (no afterimage frames, but combat system still works).

3. **Default**: If both paths fail, weapon gets `combat: null` — skipped
   gracefully rather than crashing the entire extraction.

```javascript
// combat-data.js — simplified logic
let schemaVersion = 2;
let attacks = {};

if (equipment.afterImage && equipment.afterImage !== "0") {
  try {
    // Try Afterimage/<id>.img → rectangles + visual frames
    // Success → schemaVersion = 3
  } catch {
    // Afterimage file missing — fall through
  }
}

if (Object.keys(attacks).length === 0) {
  try {
    // Fallback: Weapon/<id>.img/<weaponType>/info → rectangles only
    // Stays schemaVersion = 2
  } catch {
    // Both unavailable — attacks stays empty, weapon skipped
  }
}
```

`validateWeaponCombat()` in `client/src/combat/weapon-usage.js` accepts both
schemaVersion 2 and 3 — the difference is whether `attacks[action].afterimage`
is populated.

---

## History

- **Original implementation**: Character.wz Afterimage nodes were researched
  and mapped by hand before code was written. The hardcoded path
  `Afterimage/<afterImage>.img` came directly from inspecting the original
  WZ archive with WZ Explorer.
- **2026-10-17 cache bug**: Afterimages silently stopped appearing because
  stale `client/public/generated/` was half-extracted (Character.wz path
  changed but directory not cleaned). Deleting `generated/`, re-extracting
  with the correct assets path, and rebuilding resolved it.
- **2026-10-17 defensive fix**: combat-data.js was updated to tolerate
  missing Afterimage files rather than crashing the entire weapon combat
  extraction pipeline.
