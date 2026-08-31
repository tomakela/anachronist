import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadProject, validateProject } from "../engine/project.js";

function fileLoad(overrides = {}, requested = []) {
  return async (path, { optional = false } = {}) => {
    requested.push(path);
    if (Object.hasOwn(overrides, path)) return overrides[path];
    try { return await readFile(new URL(`../${path}`, import.meta.url), "utf8"); }
    catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  };
}

test("injected loaders produce the complete structured project", async () => {
  const requested = [], assetCalls = [], configurations = [];
  const project = await loadProject("game/game.ini", {
    loadText: fileLoad({}, requested),
    loadAssets: async (graphics, base) => { assetCalls.push([graphics, base]); return { actor: "decoded" }; },
    onConfiguration: (configuration) => configurations.push(configuration)
  });
  assert.equal(project.configuration.package.id, "anachronist");
  assert.ok(project.ui.interface);
  assert.ok(project.input.keyboard instanceof Map);
  assert.ok(project.roomCatalogue.catalogue.rooms);
  assert.ok(project.rooms.hall.room);
  assert.ok(project.itemCatalogue.catalogue.items);
  assert.ok(project.items.key);
  assert.ok(project.graphics["graphic.placeholder.actor"]);
  assert.ok(project.animations["animation.idle_down"]);
  assert.equal(project.bitmaps.actor, "decoded");
  assert.ok(project.handlers.length > 0);
  assert.deepEqual(assetCalls.map(([, base]) => base), ["game/resources/"]);
  assert.ok(requested.includes("game/rooms/hall/room.ini"));
  assert.ok(requested.includes("game/items/key.ana"));
  assert.equal(configurations[0].loading.size, "160,12");
});

test("missing optional package and room debug files become diagnostics", async () => {
  const project = await loadProject("game/game.ini", { loadText: fileLoad(), debug: true });
  assert.ok(project.diagnostics.some(({ path }) => path === "game/debug.ini"));
  assert.ok(project.diagnostics.some(({ path }) => path === "game/rooms/hall/debug.ana"));
});

test("editor validation reports malformed INI through the production parser", async () => {
  const result = await validateProject("game/game.ini", { loadText: fileLoad({ "game/game.ini": "not an ini entry" }) });
  assert.equal(result.project, null);
  assert.match(result.diagnostics[0].message, /game\/game\.ini:1: invalid INI entry/);
});

test("editor validation reports malformed scripts through the production compiler", async () => {
  const result = await validateProject("game/game.ini", { loadText: fileLoad({ "game/main.ana": "on game.start() {\n nonsense\n}" }) });
  assert.equal(result.project, null);
  assert.match(result.diagnostics[0].message, /unsupported statement nonsense/);
});
