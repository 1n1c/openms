import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publishFile } from "./atlas.js";

/** Publish completed compilation artifacts only after source and content identity rechecks. */
export async function publishBrowserOutputs(outputs) {
  for (const file of outputs) {
    await mkdir(dirname(file.path), { recursive: true });
    await publishFile(file.path, new Uint8Array(await file.arrayBuffer()));
  }
}

async function emit(site, url, bytes) {
  const filename = resolve(site, `.${url}`);
  await mkdir(dirname(filename), { recursive: true });
  await publishFile(filename, bytes);
  return {
    url,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

/** Deployment keeps the existing generated store as a mount, never copies/scans the world. */
export async function emitOnlineDeployment(root, build) {
  const site = resolve(root, "dist/online/site");
  const resources = [];
  for (const [url, bytes] of build.shell) {
    resources.push(await emit(site, url, bytes));
  }
  for (const output of build.outputs) {
    // Bun.build returns absolute paths with OS-native separators on Windows.
    // Normalize backslashes to forward-slashes before extracting the basename.
    // const name = output.path.slice(output.path.lastIndexOf("/") + 1);
    const name = output.path.replace(/\\/g, "/").split("/").pop();
    const bytes = new Uint8Array(await output.arrayBuffer());
    resources.push(await emit(site, `/dist/online/${name}`, bytes));
    if (name === "atlas-worker.js" || name === "audio-capture-worklet.js") {
      resources.push(await emit(site, `/dist/${name}`, bytes));
    }
  }
  const manifest = {
    schemaVersion: 1,
    mode: "online",
    sourceBuildId: build.sourceBuildId,
    rulesHash: build.content.rulesHash,
    assetBuildId: build.content.assetBuildId,
    resources,
    generated: {
      mount: "/generated/",
      source: "client/public/generated/",
      catalog: build.catalog,
      startupPack: build.startupPack,
      regionPackIndex: build.regionPacks?.index ?? null,
      dependencyPolicy:
        "Serve the existing generated tree, including every transitive hash-addressed dependency of the catalog. Do not run offline extraction or install a service worker.",
    },
    api: {
      mount: "/api/",
      websocket: "/api/v1/play",
      policy:
        "Route to the matching authoritative server on the same origin; preserve cookies, Origin, CSRF and WebSocket subprotocol checks.",
    },
    http: {
      methods: ["GET", "HEAD"],
      immutable: "/generated/**/<sha256>.(json|png|mp3|wav|bin)(.gz)?",
      immutableCacheControl: "public, max-age=31536000, immutable",
      mutableCacheControl: "no-store",
      vary: "Accept-Encoding",
      gzip: { minimumBytes: 65536, maximumBytes: 67108864, level: 6 },
      headers: {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    },
  };
  await emit(
    site,
    "/deployment.json",
    new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  );
  return { directory: site, manifest };
}
