import { resolve } from "node:path";
import { value, resolveNode } from "../src/assets/image.js";
import {
  extractAvatar,
  extractAvatarRecord,
  avatarMaps,
  defaultAvatarInputs,
} from "./avatar-data.js";
import { audiovisualSoundSources } from "./audiovisual-data.js";
import { originalFrames } from "./extraction-frames.js";
import { selectedMapIds } from "./extraction-inputs.js";
import { convertServerData } from "./server-data.js";
import {
  preflightInputs,
  preflightFindings,
  provenance,
} from "./preflight-inputs.js";
import { originalValidators } from "./preflight-validators.js";
import { selectWorld, validateWorldMap } from "./preflight-world.js";
import { sourcePaths, parseFlags } from "./source-options.js";

function createState(options, report) {
  const context = preflightInputs(
    sourcePaths(options).assets,
    report,
    options.progress,
  );
  const findings = preflightFindings(report);
  const validators = originalValidators(report, findings);
  context.part = async (original, x = 0, y = 0, z = 0, options) => {
    const node = resolveNode(original),
      origin = value(node, "origin", { x: 0, y: 0 });
    const texture = validators.canvas(node, options);
    if (texture === null) {
      throw new Error(`Canvas validation failed at ${nodePath(node)}`);
    }
    return { texture, x: x - origin.x, y: y - origin.y, z };
  };
  context.frames = (node) => originalFrames(node, context.part, nodePath);
  return {
    context,
    findings,
    validators,
    report,
    progress: options.progress,
    templateOwners: new Map(),
    lifeTemplates: new Set(),
  };
}

function nodePath(node) {
  const location = provenance(node);
  return `${location.source}/${location.field}`;
}

async function routes(state, options) {
  state.context.setOwner("shared");
  try {
    const converted = await convertServerData({
      progress: options.progress,
      gameplayDefinitionsRoot: sourcePaths(options).gameplayDefinitionsRoot,
      sqlRoot: sourcePaths(options).sqlRoot,
      defaultTalkForNpc: (id) => {
        const root = state.context.image("String", "Npc.img").children[
          String(id)
        ];
        return root ? value(root, "d0", "(...)") : "(...)";
      },
    });
    state.report.gameplayContent = converted.report;
    state.context.portalPrograms = converted.report.scripts.portalPrograms;
    state.context.portalScripts = converted.datasets.shops.portalScripts;
    state.context.transportSchedules =
      converted.datasets.shops.transportSchedules;
    state.context.npcRoutes = new Map(
      converted.datasets.shops.npcRoutes
        .filter((route) => route.status === "supported")
        .map((route) => [route.npcId, route]),
    );
  } catch (error) {
    error.code = "gameplay-content-boundary";
    state.findings.add(error);
  }
}

async function sharedWorld(state) {
  state.context.setOwner("shared");
  state.progress?.("Preflight: validating shared avatar and map assets");
  const maps = state.findings.check(null, "avatar-maps", undefined, () =>
    avatarMaps(state.context),
  );
  for (const input of defaultAvatarInputs) {
    try {
      state.progress?.(`Preflight: validating Character.wz:${input.path}`);
      state.context.image("Character", input.path);
      if (maps) await extractAvatarRecord(state.context, input, maps);
    } catch (error) {
      error.source ??= `Character.wz:${input.path}`;
      state.findings.add(error);
    }
  }
  try {
    await extractAvatar(state.context);
  } catch (error) {
    state.findings.add(error);
  }
  for (const [archive, path] of [
    ["Map", "MapHelper.img"],
    ["Map", "Physics.img"],
  ]) {
    try {
      state.context.image(archive, path);
    } catch (error) {
      state.findings.add(error);
    }
  }
}

/** The audiovisual recipe's UI/Game, combat and login sounds; map BGMs are per-map checks. */
function audiovisualSounds(state) {
  state.context.setOwner("shared");
  state.progress?.("Preflight: validating audiovisual sound families");
  const rows = state.findings.check(null, "audiovisual-sounds", undefined, () =>
    audiovisualSoundSources(state.context, state.report.selection.ids),
  );
  for (const row of rows ?? []) {
    if (row.optional) {
      try {
        resolveNode(row.node);
      } catch {
        continue; // extraction publishes this alias as unavailable
      }
    }
    state.validators.sound(row.node);
  }
}

/** Join ownership after every traversal, including cached sources reused by later maps. */
export function finalizePreflight(state) {
  const { context, report, templateOwners } = state;
  const shared = context.dependencies.get("shared") ?? new Set();
  for (const id of report.selection.ids) {
    report.dependencies[id] = [
      ...new Set([...shared, ...(context.dependencies.get(id) ?? [])]),
    ].sort();
  }
  for (const row of [...report.failures, ...report.normalizations]) {
    const sourceOwners = context.owners.get(row.source) ?? new Set();
    row.mapIds = sourceOwners.has("shared")
      ? [...report.selection.ids]
      : [...sourceOwners].sort();
    const owners = templateOwners.get(row.source);
    row.npcIds = [...(owners?.npcIds ?? [])].sort();
    row.mobIds = [...(owners?.mobIds ?? [])].sort();
  }
  report.status = report.failures.length ? "fail" : "pass";
}

/** Validate the complete selected world closure without creating any generated release resources. */
export async function preflightAssets(options = {}) {
  const started = performance.now();
  const report = {
    schemaVersion: 1,
    status: "fail",
    elapsedMs: 0,
    selection: { ids: [], seeds: [], blocked: [] },
    sources: {},
    dependencies: {},
    failures: [],
    normalizations: [],
    coverage: {
      scope: "selected-world-dependency-closure",
      canvases: 0,
      sounds: 0,
      nodes: 0,
      releaseGate:
        "Full inventory, cash shop, all-skill UI and catalog publication are a separate final release gate.",
    },
  };
  const state = createState(options, report);
  try {
    options.progress?.("Preflight: scanning local gameplay routes");
    const seeds = selectedMapIds(options.maps);
    await routes(state, options);
    options.progress?.("Preflight: scanning original map dependency closure");
    selectWorld(state, seeds, options.maps !== undefined);
    await sharedWorld(state);
    await validateSelectedMaps(state);
    audiovisualSounds(state);
    options.progress?.("Preflight: finalizing source ownership and findings");
    finalizePreflight(state);
  } catch (error) {
    state.findings.add(error);
  } finally {
    state.context.close();
  }
  report.elapsedMs = Math.round(performance.now() - started);
  if (options.report) {
    options.progress?.(`Preflight: writing report ${resolve(options.report)}`);
    await Bun.write(
      resolve(options.report),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  options.progress?.(
    `Preflight ${report.status}: ${report.selection.ids.length} maps, ${report.failures.length} findings (${(report.elapsedMs / 1000).toFixed(2)}s)`,
  );
  return report;
}

/** Validate each selected map independently; checked does not imply admissible. */
async function validateSelectedMaps(state) {
  const { report, progress } = state;
  let completed = 0;
  for (const id of report.selection.ids) {
    progress?.(
      `Preflight map ${completed + 1}/${report.selection.ids.length}: ${id}`,
    );
    try {
      await validateWorldMap(state, id);
    } catch (error) {
      state.findings.add(error);
    }
    completed++;
    progress?.(
      `Preflight map ${completed}/${report.selection.ids.length} checked: ${id}; ${report.failures.length} findings so far`,
    );
  }
}

export function preflightOptions(args) {
  const values = parseFlags(args, {
    assets: { type: "string" },
    map: { type: "string" },
    maps: { type: "string" },
    "gameplay-definitions-root": { type: "string" },
    "sql-root": { type: "string" },
    report: { type: "string" },
  });
  if (values.map && values.maps) throw new Error("Use only --map or --maps");
  return {
    ...sourcePaths({
      assets: values.assets,
      gameplayDefinitionsRoot: values["gameplay-definitions-root"],
      sqlRoot: values["sql-root"],
    }),
    maps: values.map ?? values.maps,
    report: values.report,
  };
}

if (import.meta.main) {
  try {
    const report = await preflightAssets(
      preflightOptions(process.argv.slice(2)),
    );
    console.log(JSON.stringify(report));
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        status: "fail",
        failures: [{ code: "cli-input", message: error.message }],
      }),
    );
    process.exitCode = 1;
  }
}
