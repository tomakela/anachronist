import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, instantiate, textDuration } from "../engine/script.js";
import { parseIni } from "../engine/ini.js";
import { resolvePackagePath } from "../engine/path.js";
import { loadBitmaps, transparentBitmap } from "../engine/bitmaps.js";
import { bitmapWalkRegion, dragCursor, enteredTriggers, entityRenderOrder, interfacePoint, interpolatedScale, inventoryPage, parseScalingStops, prepareItemUse, retainedRoomEntities, roomEntryItems, shakeOffset, touchMoved, verbSentence } from "../engine/interaction.js";

const pixelCanvas = (width, height, values) => () => {
  const image = { data: new Uint8ClampedArray(values) };
  return { width, height, getContext: () => ({ drawImage() {}, getImageData: () => image, putImageData(next) { image.data = next.data; } }), image };
};

test("a handler is fully expanded into an ordered command chain", () => {
  const [handler] = compile(`on entity.use_item(item, target) {
    if (item == key) { sequence { walk player to key
 take key
 walk player to target
 say "Open"
 } }
    else { say "No"
 }
  }`);
  assert.deepEqual(instantiate(handler, ["key", "door"]).map(({ op, target }) => [op, target]), [
    ["walk", "key"], ["take", "key"], ["walk", "door"], ["say", undefined]
  ]);
  assert.equal(instantiate(handler, ["stone", "door"])[0].value, "No");
});

test("handlers can branch on game-global state", () => {
  const [handler] = compile(`on room.enter() {
    if (game.key_taken == true) { hide key
 }
  }`);
  assert.deepEqual(instantiate(handler, [], { game: { key_taken: true } }).map(({ op, target }) => [op, target]), [["hide", "key"]]);
  assert.deepEqual(instantiate(handler, [], { game: { key_taken: false } }), []);
});

test("newlines terminate statements while comments and blank lines remain harmless", () => {
  const [handler] = compile(`// heading

on game.start() {
  // before the first command
  say "one" // trailing comment

  if true {
    say "two"
  }
}`);
  assert.deepEqual(instantiate(handler, []).map(({ value }) => value), ["one", "two"]);
});

test("semicolons, module declarations, and multiple statements on one line are rejected", () => {
  assert.throws(() => compile("on game.start() { say \"no\"; }") , /semicolons are invalid/);
  assert.throws(() => compile("module demo\n"), /module declarations are not supported/);
  assert.throws(() => compile("on game.start() { say \"one\" say \"two\"\n}"), /expected newline or }/);
});

test("room-local handlers lower with ownership, guards, and optional if parentheses", () => {
  const handlers = compile(`on enter() {
  if game.clock_fallen { hide clock }
}
on door.open() {
  show door
}`, { roomId: "hall", entities: ["clock", "door"] });
  assert.deepEqual(handlers.map(({ event, roomId, localTarget }) => [event, roomId, localTarget]), [
    ["room.enter", "hall", undefined], ["entity.open", "hall", "door"]
  ]);
  assert.deepEqual(instantiate(handlers[0], ["garden"], { game: { clock_fallen: true } }), []);
  assert.throws(() => compile("on missing.open() {\n}\n", { roomId: "hall", entities: ["door"] }), /unknown local entity missing/);
});

test("INI parser rejects duplicate package values", () => {
  assert.throws(() => parseIni("[display]\nwidth=1\nwidth=2"), /duplicate key/);
});

test("package paths remain relative to the site root", () => {
  assert.equal(resolvePackagePath("game/", "interface.ini"), "game/interface.ini");
  assert.equal(resolvePackagePath("game/", "rooms/index.ini"), "game/rooms/index.ini");
});

test("PNG resources fall back to text-encoded PNG resources", async () => {
  const requested = [];
  const fetcher = async (path) => {
    requested.push(path);
    if (path === "game/images/actor.png") return new Response("", { status: 404 });
    if (path === "game/images/actor.png.base64") return new Response("aGVsbG8=");
    return fetch(path);
  };
  const decoded = [];
  const result = await loadBitmaps({ "graphic.actor": { path: "images/actor.png" } }, "game/", fetcher, async (blob) => {
    decoded.push(await blob.text());
    return "bitmap";
  });
  assert.deepEqual(requested.slice(0, 2), ["game/images/actor.png", "game/images/actor.png.base64"]);
  assert.deepEqual(decoded, ["hello"]);
  assert.equal(result.actor, "bitmap");
});

test("explicit base64 resources load without requesting a binary PNG first", async () => {
  const requested = [];
  const fetcher = async (path) => {
    requested.push(path);
    if (path === "game/images/actor.png.base64") return new Response("aGVsbG8=");
    return fetch(path);
  };
  const result = await loadBitmaps({
    "graphic.actor": { path: "images/actor.png.base64", encoding: "base64", mime_type: "image/png" }
  }, "game/", fetcher, async (blob) => {
    assert.equal(await blob.text(), "hello");
    return "bitmap";
  });
  assert.equal(requested[0], "game/images/actor.png.base64");
  assert.equal(requested.some((path) => path === "game/images/actor.png"), false);
  assert.equal(result.actor, "bitmap");
});

test("a catalogue transparent color clears only exactly matching pixels", () => {
  const factory = pixelCanvas(2, 1, [255, 0, 255, 255, 254, 0, 255, 255]);
  const canvas = transparentBitmap({ width: 2, height: 1 }, "#ff00ff", factory);
  assert.deepEqual([...canvas.image.data], [255, 0, 255, 0, 254, 0, 255, 255]);
  assert.throws(() => transparentBitmap({ width: 1, height: 1 }, "magenta", factory), /expected #RRGGBB/);
});

test("the demo graphic catalogue requests images before using base64 fallbacks", async () => {
  const graphics = parseIni(await readFile(new URL("../game/resources/graphics.ini", import.meta.url), "utf8"));
  for (const [section, spec] of Object.entries(graphics)) {
    assert.match(section, /^graphic\./);
    assert.match(spec.path, /\.png$/);
    assert.notEqual(spec.encoding, "base64");
    assert.equal(spec.mime_type, "image/png");
  }
});

test("using the key on a non-door does not enqueue a walk", () => {
  const source = `on entity.use_item(item, target) {
    if (target == door) { if (item == key) { walk player to door
 } else { say "No"
 } }
    else { say "I can't do that"
 }
  }`;
  const commands = instantiate(compile(source)[0], ["key", "clock"]);
  assert.deepEqual(commands.map(({ op }) => op), ["say"]);
});

test("dialogue duration is configured from character count", () => {
  const runtime = { text_base_ticks: "30", text_ticks_per_character: "4", text_minimum_ticks: "90" };
  assert.equal(textDuration("short", runtime), 90);
  assert.equal(textDuration("a sufficiently long sentence", runtime), 142);
});

test("shake commands compile with a deterministic screen offset", () => {
  const [command] = instantiate(compile("on room.enter() { shake 24 ticks\n }")[0], []);
  assert.deepEqual(command, { op: "shake", ticks: 24, value: undefined });
  assert.deepEqual([1, 2, 3, 4].map((ticks) => shakeOffset(ticks, 2)), [[2, 0], [0, -2], [0, 2], [-2, 0]]);
  assert.deepEqual(shakeOffset(0, 2), [0, 0]);
});

test("the configured verb sentences use only the intended prepositions", async () => {
  const ui = parseIni(await readFile(new URL("../game/interface.ini", import.meta.url), "utf8"));
  assert.equal(ui["verb.look"].preposition, "at");
  assert.equal(ui["verb.use"].object_preposition, "on");
  const label = (id) => id;
  assert.equal(verbSentence(ui, label, "look", "clock"), "Look at clock");
  assert.equal(verbSentence(ui, label, "use", "key"), "Use key");
  assert.equal(verbSentence(ui, label, "use", "key", "door"), "Use key on door");
});

test("ground item use walks, takes, approaches, and uses in order", () => {
  const commands = instantiate(compile(`on entity.use_item(item, target) {
    walk player to item
 take item
 walk player to target
 set door.open = true

  }`)[0], ["key", "door"]);
  const world = { inventory: [], entities: {
    player: { visible: "true" }, key: { visible: "true" }, door: { visible: "true" }
  }, rooms: {} };
  assert.deepEqual(prepareItemUse(commands, world).map(({ op, target }) => [op, target]), [
    ["walk", "key"], ["take", "key"], ["walk", "door"], ["animate", undefined], ["set", "door.open"]
  ]);
});

test("inventory item use never returns to the item's former room position", () => {
  const commands = instantiate(compile(`on entity.use_item(item, target) {
    walk player to item
 take item
 walk player to target
 say "Used"

  }`)[0], ["key", "door"]);
  const world = { inventory: ["key"], entities: {
    player: { visible: "true" }, key: { visible: "false" }, door: { visible: "true" }
  }, rooms: {} };
  assert.deepEqual(prepareItemUse(commands, world).map(({ op, target }) => [op, target]), [
    ["walk", "door"], ["animate", undefined], ["say", undefined]
  ]);
});

test("an invalid item-use tail rejects the entire transaction", () => {
  const commands = [{ op: "walk", actor: "player", target: "key" }, { op: "take", target: "key" }, { op: "walk", actor: "player", target: "missing" }];
  const world = { inventory: [], entities: { player: { visible: "true" }, key: { visible: "true" } }, rooms: {} };
  assert.equal(prepareItemUse(commands, world), null);
});

test("triggers fire only when crossing into their region", () => {
  const triggers = { door: [10, 10, 20, 20] };
  let state = enteredTriggers([15, 15], triggers);
  assert.deepEqual(state.entered, ["door"]);
  state = enteredTriggers([16, 16], triggers, state.occupied);
  assert.deepEqual(state.entered, []);
  state = enteredTriggers([5, 5], triggers, state.occupied);
  assert.deepEqual([...state.occupied], []);
  state = enteredTriggers([15, 15], triggers, state.occupied);
  assert.deepEqual(state.entered, ["door"]);
});

test("a spawn inside a trigger can be initialized as already occupied", () => {
  const initial = enteredTriggers([15, 15], { return: [10, 10, 20, 20] }).occupied;
  assert.deepEqual(enteredTriggers([15, 15], { return: [10, 10, 20, 20] }, initial).entered, []);
});

test("room entity mutations survive leaving and returning", () => {
  const states = Object.create(null);
  const hall = retainedRoomEntities(states, "hall", () => ({ clock: { visible: "true" } }));
  hall.clock.visible = "false";
  const returned = retainedRoomEntities(states, "hall", () => ({ clock: { visible: "true" } }));
  assert.equal(returned, hall);
  assert.equal(returned.clock.visible, "false");
});

test("rooms can grant inventory items on entry", () => {
  assert.deepEqual(roomEntryItems({ room: {}, "inventory.coffee": { label: "coffee cup", graphic: "cup" } }), [
    { id: "coffee", label: "coffee cup", graphic: "cup" }
  ]);
});

test("inventory rows clamp and enable only useful arrows", () => {
  assert.deepEqual(inventoryPage(4, 0, 4), { row: 0, start: 0, end: 4, up: false, down: false });
  assert.deepEqual(inventoryPage(5, 0, 4), { row: 0, start: 0, end: 4, up: false, down: true });
  assert.deepEqual(inventoryPage(5, 1, 4), { row: 1, start: 4, end: 5, up: true, down: false });
});

test("drag cursor movement applies sensitivity and clamps to the game", () => {
  assert.deepEqual(dragCursor([100, 50], [4, -2], 2.25, 320, 200), [109, 45.5]);
  assert.deepEqual(dragCursor([318, 1], [4, -2], 2, 320, 200), [319, 0]);
  assert.throws(() => dragCursor([0, 0], [1, 1], 0, 320, 200), /positive number/);
});

test("long touches tolerate small finger movement", () => {
  assert.equal(touchMoved([100, 50], [106, 55], 8), false);
  assert.equal(touchMoved([100, 50], [108, 50], 8), false);
  assert.equal(touchMoved([100, 50], [108.1, 50], 8), true);
  assert.throws(() => touchMoved([0, 0], [0, 0], -1), /non-negative number/);
});

test("verb and inventory interface points are not walk destinations", async () => {
  const ui = parseIni(await readFile(new URL("../game/interface.ini", import.meta.url), "utf8"));
  assert.equal(interfacePoint(10, 160, ui, 320, 200), true);
  assert.equal(interfacePoint(200, 180, ui, 320, 200), true);
  assert.equal(interfacePoint(200, 100, ui, 320, 200), false);
});

test("room perspective scaling interpolates and clamps between y stops", () => {
  const stops = parseScalingStops("140,1.2; 60,0.5; 100,0.9");
  assert.deepEqual(stops, [[60, 0.5], [100, 0.9], [140, 1.2]]);
  assert.equal(interpolatedScale(40, stops), 0.5);
  assert.equal(interpolatedScale(80, stops), 0.7);
  assert.equal(interpolatedScale(120, stops), 1.05);
  assert.equal(interpolatedScale(160, stops), 1.2);
  assert.throws(() => parseScalingStops("100,1"), /at least two stops/);
});

test("entities use explicit depth or foot position for back-to-front ordering", () => {
  const entities = {
    player: { id: "player", position: [0, 80] }, foreground: { id: "foreground", position: [0, 100] },
    backdrop: { id: "backdrop", position: [0, 150], depth: "10" }
  };
  assert.deepEqual(entityRenderOrder(entities).map(({ id }) => id), ["backdrop", "player", "foreground"]);
});

test("walk masks scale bitmap pixels and allow only visible non-black areas", () => {
  const factory = pixelCanvas(2, 2, [255,255,255,255, 0,0,0,255, 1,2,3,255, 255,255,255,0]);
  const allowed = bitmapWalkRegion({ width: 2, height: 2 }, 100, 100, factory);
  assert.equal(allowed([10, 10]), true);
  assert.equal(allowed([75, 10]), false);
  assert.equal(allowed([10, 75]), true);
  assert.equal(allowed([75, 75]), false);
  assert.equal(allowed([100, 50]), false);
});

test("taking the wall clock creates the persistent fallen-clock scene", async () => {
  const handlers = compile(await readFile(new URL("../game/rooms/hall/script.ana", import.meta.url), "utf8"), { roomId: "hall", entities: ["door", "clock", "fallen_clock", "key", "bush", "stick"] });
  const handler = (event, target) => handlers.find((candidate) => candidate.event === event && (!target || candidate.localTarget === target));
  assert.deepEqual(instantiate(handler("entity.take", "clock"), ["clock"], { game: {} }).map(({ op, target, value }) => [op, target, value]), [
    ["walk", "clock", undefined], ["hide", "clock", undefined], ["show", "fallen_clock", undefined],
    ["set", "game.clock_fallen", true], ["shake", undefined, undefined], ["say", undefined, "Ooops"]
  ]);
  assert.deepEqual(instantiate(handler("room.enter"), ["hall"], { game: { door_open: false, clock_fallen: true, fallen_clock_taken: false } }).map(({ op, target }) => [op, target]), [
    ["hide", "clock"], ["show", "fallen_clock"]
  ]);
  assert.deepEqual(instantiate(handler("entity.take", "fallen_clock"), ["fallen_clock"], { game: { clock_fallen: true, fallen_clock_taken: false } }).map(({ op, target, value }) => [op, target, value]), [
    ["walk", "fallen_clock", undefined], ["take", "fallen_clock", undefined],
    ["set", "game.fallen_clock_taken", true], ["say", undefined, "Taken."]
  ]);
  assert.deepEqual(instantiate(handler("room.enter"), ["garden"], { game: { door_open: true, clock_fallen: true, fallen_clock_taken: true } }), []);
  assert.deepEqual(instantiate(handler("room.enter"), ["hall"], { game: { door_open: false, clock_fallen: true, fallen_clock_taken: true } }).map(({ op, target }) => [op, target]), [
    ["hide", "clock"], ["hide", "fallen_clock"]
  ]);
});

test("the demo door can close, reopen, and be walked through", async () => {
  const handlers = compile(await readFile(new URL("../game/rooms/hall/script.ana", import.meta.url), "utf8"), { roomId: "hall", entities: ["door", "clock", "fallen_clock", "key", "bush", "stick"] });
  const handler = (event) => handlers.find((candidate) => candidate.event === event);
  assert.deepEqual(instantiate(handler("entity.close"), ["door"], { game: { door_open: true } }).map(({ op, target }) => [op, target]), [
    ["walk", "door"], ["set", "door.open"], ["set", "door.graphic"], ["set", "game.door_open"]
  ]);
  assert.deepEqual(instantiate(handler("entity.open"), ["door"], { game: { door_unlocked: true } }).map(({ op, target }) => [op, target]), [
    ["walk", "door"], ["set", "door.open"], ["set", "door.graphic"], ["set", "game.door_open"]
  ]);
  assert.deepEqual(instantiate(handler("entity.walk"), ["door"], { game: { door_open: false } }).map(({ op, target }) => [op, target]), [["walk", "door"]]);
  assert.deepEqual(instantiate(handler("entity.walk"), ["door"], { game: { door_open: true } }).map(({ op, target, room }) => [op, target, room]), [
    ["walk", "door", undefined], ["enter", undefined, "garden"]
  ]);
});
