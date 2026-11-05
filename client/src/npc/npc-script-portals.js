// Authorized Cosmic portal sources. These are exact closed programs, not arbitrary JavaScript.
export const TUTORIAL_PORTAL_PROGRAMS = Object.freeze({
  tutoChatNPC: Object.freeze({
    schemaVersion: 1,
    script: "tutoChatNPC",
    source: "scripts/portal/tutoChatNPC.js",
    // All 4 tutorial portal sha256 presets were updated 2026-10-26 to match the
    // f406ffb (2026-09-14) vendor import of infra/gameplay-definitions/portal/*.js.
    // Original presets (from 1a88f80 2026-09-12) were computed against scripts
    // that predated the vendor CRLF+whitespace versions.
    sha256: "5265c78364c097b972f3b820bc7e71af2ae217eae414369ee6628e564ecd48c5",
    branches: Object.freeze([]),
    openNpc: Object.freeze({ npcId: 2007, minimumAccountLevel: 30 }),
    blockPortal: true,
    result: true,
  }),
  infoMinimap: Object.freeze({
    schemaVersion: 1,
    script: "infoMinimap",
    source: "scripts/portal/infoMinimap.js",
    sha256: "621daf58b866f671dd4c58fd29f5dcc3b3d1403c6d8abd25849fbf9b591c1adf",
    branches: Object.freeze([
      Object.freeze({ questId: 1031, state: 1, path: "UI/tutorial.img/25" }),
    ]),
    blockPortal: true,
    result: true,
  }),
  infoPickup: Object.freeze({
    schemaVersion: 1,
    script: "infoPickup",
    source: "scripts/portal/infoPickup.js",
    sha256: "412da97f6ca1f01f8c7b4edf0c05fd3e0fe383971261e9588703dcbf3f41aa30",
    branches: Object.freeze([
      Object.freeze({ questId: 1035, state: 1, path: "UI/tutorial.img/21" }),
    ]),
    blockPortal: true,
    result: true,
  }),
  infoReactor: Object.freeze({
    schemaVersion: 1,
    script: "infoReactor",
    source: "scripts/portal/infoReactor.js",
    sha256: "2d519d64ecd03f34a68ed360e7d58df1303b2f71484eab28eabeded7122f2263",
    branches: Object.freeze([
      Object.freeze({ questId: 1008, state: 2, path: "UI/tutorial.img/22" }),
      Object.freeze({ questId: 1020, state: 2, path: "UI/tutorial.img/27" }),
    ]),
    blockPortal: true,
    result: true,
  }),
});

/** Conversations a tutorial portal may still admit but must no longer offer.
 *
 *  `scripts/npc/2007.js` (Shanks, Maple Island) is the "Would you like to skip the tutorials
 *  and head straight to Lith Harbor?" prompt: answering yes warps to 104000000. The original
 *  client only renders what the server script asks for, so removing the option is a content
 *  policy, not a client change. This project removes it, so the `tutoChatNPC` portal opens no
 *  NPC and the skip prompt is never shown. */
export const REMOVED_TUTORIAL_NPCS = Object.freeze(new Set([2007]));

/** Only these complete closed programs may enter the portal authority. */
export function admitTutorialPortal(program) {
  const expected = TUTORIAL_PORTAL_PROGRAMS[program?.script];
  if (!expected || JSON.stringify(program) !== JSON.stringify(expected)) {
    throw new Error("Tutorial portal source program is missing or altered");
  }
  return expected;
}

/** A removed conversation is treated as absent, never as a missing/broken program. */
export function tutorialNpcOffered(program) {
  return Boolean(
    program?.openNpc && !REMOVED_TUTORIAL_NPCS.has(program.openNpc.npcId),
  );
}

export function tutorialPortalKind(portal, raw) {
  return portal.type === 9 &&
    portal.targetMap === 999999999 &&
    Object.hasOwn(TUTORIAL_PORTAL_PROGRAMS, raw.script)
    ? raw.script
    : null;
}

/** Source branch order is significant: infoReactor's completed-1008 branch wins. */
export function resolveTutorialPortal(program, profile) {
  const source = admitTutorialPortal(program);
  if (!profile?.quests) {
    throw new Error(
      "Tutorial portal requires the active character quest ledger",
    );
  }
  for (const branch of source.branches) {
    const state = profile.quests[branch.questId]?.state ?? 0;
    if (![0, 1, 2].includes(state)) {
      throw new Error("Invalid tutorial quest state");
    }
    if (state === branch.state) return branch.path;
  }
  return null;
}
