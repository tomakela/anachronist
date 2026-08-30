import test from "node:test";
import assert from "node:assert/strict";
import { compileRoomScripts, debugModeFromSearch, debugUrl, fetchOptionalText, overlayIni, siblingPath } from "../engine/bootstrap.js";
import { parseIni } from "../engine/ini.js";

test("debug mode is enabled by presence of the URL flag", () => {
  assert.equal(debugModeFromSearch("?debug"), true);
  assert.equal(debugModeFromSearch("?debug=false"), true);
  assert.equal(debugModeFromSearch("?mode=debug"), false);
});

test("debug INI recursively overlays sections and top-level variables", () => {
  const normal = parseIni('lives = 3\nname = "normal"\n[display]\nwidth = 320\nheight = 200\n[input]\nmode = mouse');
  const debug = parseIni('lives = 99\n[display]\nwidth = 640\n[extra]\nenabled = true');
  const merged = overlayIni(normal, debug);
  assert.deepEqual({ ...merged.$variables }, { lives: 99, name: "normal" });
  assert.deepEqual({ ...merged.display }, { width: "640", height: "200" });
  assert.deepEqual({ ...merged.input }, { mode: "mouse" });
  assert.deepEqual({ ...merged.extra }, { enabled: "true" });
});

test("optional files ignore only HTTP 404", async () => {
  assert.equal(await fetchOptionalText("debug.ini", async () => ({ ok: false, status: 404 })), null);
  await assert.rejects(fetchOptionalText("debug.ini", async () => ({ ok: false, status: 500 })), /HTTP 500/);
  await assert.rejects(fetchOptionalText("debug.ini", async () => { throw new TypeError("network down"); }), /network down/);
});

test("room debug scripts are room-relative and compile after normal scripts", async () => {
  const requested = [], compiled = [];
  const sources = { "game/rooms/hall/script.ana": "normal", "game/rooms/hall/debug.ana": "debug" };
  const fetcher = async (path) => { requested.push(path); return { ok: path in sources, status: path in sources ? 200 : 404, text: async () => sources[path] }; };
  const context = { roomId: "hall", entities: ["door"] };
  const compiler = (source, received) => { compiled.push([source, received]); return [{ source }]; };
  const handlers = await compileRoomScripts("game/rooms/hall/script.ana", "game/rooms/hall/room.ini", context, true, fetcher, compiler);
  assert.equal(siblingPath("game/rooms/hall/room.ini", "debug.ana"), "game/rooms/hall/debug.ana");
  assert.deepEqual(requested, ["game/rooms/hall/script.ana", "game/rooms/hall/debug.ana"]);
  assert.deepEqual(handlers.map(({ source }) => source), ["normal", "debug"]);
  assert.equal(compiled[0][1], context); assert.equal(compiled[1][1], context);
});

test("missing room debug script is optional but malformed debug script surfaces", async () => {
  const missing = async (path) => ({ ok: !path.endsWith("debug.ana"), status: path.endsWith("debug.ana") ? 404 : 200, text: async () => "normal" });
  assert.equal((await compileRoomScripts("rooms/a/script.ana", "rooms/a/room.ini", {}, true, missing, () => [1])).length, 1);
  const present = async (path) => ({ ok: true, status: 200, text: async () => path.endsWith("debug.ana") ? "bad" : "normal" });
  await assert.rejects(compileRoomScripts("rooms/a/script.ana", "rooms/a/room.ini", {}, true, present, (source) => { if (source === "bad") throw new Error("malformed script"); return []; }), /malformed script/);
});

test("debug checkbox URL updates preserve unrelated query parameters", () => {
  assert.equal(debugUrl("https://example.test/game?slot=2#scene", true), "https://example.test/game?slot=2&debug=#scene");
  assert.equal(debugUrl("https://example.test/game?slot=2&debug#scene", false), "https://example.test/game?slot=2#scene");
});
