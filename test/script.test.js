import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BackgroundTasks, compile, instantiate, textDuration } from "../engine/script.js";
import { parseIni } from "../engine/ini.js";
import { resolvePackagePath } from "../engine/path.js";
import { bitmapPixels, loadBitmaps, transparentBitmap } from "../engine/bitmaps.js";
import { accelerateCommandQueue, advanceCutSceneQueue, advanceWalk, bitmapWalkRegion, dragCursor, enteredTriggers, entityHotspot, entityIsInteractive, entityRenderOrder, entityTargetAt, interfacePoint, interpolatedScale, inventoryLastRow, inventoryPage, objectSuggestedVerb, parseScalingStops, pointInHotspot, retainedRoomEntities, roomEntryItems, shakeOffset, spriteAlphaHit, touchMoved, verbSentence } from "../engine/interaction.js";
import { SaveStorage, snapshotRuntime, stableStringify, validateSnapshot } from "../engine/save.js";
import { parseActionBindings } from "../engine/input.js";
import { Runtime } from "../engine/bootstrap.js";
import { DeterministicVM, prepareItemUse } from "../engine/vm.js";
const ITEM_USE_PROTOCOL = { walk_command: "walk", take_command: "take", player_actor: "player", use_animation: "use" };

test("runtime saves deterministically round-trip durable world state", () => {
  const runtime = {
    room: "hall", globals: { door_open: true }, roomState: { hall: { visits: 2 } },
    roomEntities: { garden: { gate: { visible: "false", position: [10, 20] } } },
    entities: { door: { visible: "false", position: [44, 60] }, player: { position: [123, 77], moving: true, action: "use", actionTicks: 9 } },
    inventory: ["key"], inventoryEntities: { key: { label: "brass key", position: [8, 9] } }, inventoryRow: 1
  };
  const identity = { packageId: "anachronist", formatVersion: "1" }, rooms = { hall: {}, garden: {} }, items = { key: {} };
  const saved = snapshotRuntime(runtime, identity), encoded = stableStringify(saved);
  assert.equal(encoded, stableStringify(snapshotRuntime(runtime, identity)));
  const state = validateSnapshot(JSON.parse(encoded), identity, rooms, items);
  assert.deepEqual(state.inventory, ["key"]); assert.deepEqual(state.globals, { door_open: true });
  assert.equal(state.entities.hall.door.visible, "false"); assert.deepEqual(state.entities.hall.player.position, [123, 77]);
  assert.equal(state.entities.hall.player.actionTicks, 0); assert.equal(state.entities.garden.gate.visible, "false");
});

test("save validation rejects corrupt and incompatible data before returning state", () => {
  const identity = { packageId: "anachronist", formatVersion: "1" }, rooms = { hall: {} }, items = { key: {} };
  assert.throws(() => validateSnapshot(null, identity, rooms, items), /not an object/);
  assert.throws(() => validateSnapshot({ package_id: "another", format_version: "1", state: {} }, identity, rooms, items), /different game/);
  assert.throws(() => validateSnapshot({ package_id: "anachronist", format_version: "2", state: {} }, identity, rooms, items), /not compatible/);
});

test("save storage uses a package-scoped key and reports corrupt JSON", () => {
  const values = new Map(), storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const saves = new SaveStorage(storage, "demo"); saves.write({ good: true });
  assert.equal(values.has("anachronist.save.demo"), true); assert.deepEqual(saves.read(), { good: true });
  values.set("anachronist.save.demo", "{"); assert.throws(() => saves.read(), /corrupt/);
});

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

test("walk commands accept script-configured coordinate destinations", () => {
  const [handler] = compile(`on door.walk() {
    walk player to 123, 87
  }`, { roomId: "hall", entities: ["door"] });
  assert.deepEqual(instantiate(handler, ["door"]), [{ op: "walk", actor: "player", point: [123, 87], value: undefined }]);
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

test("INI variables before the first section are typed", () => {
  const ini = parseIni('ready = true\ncaption = "text here"\ncount = 2\n[room]\ninteractive = false');
  assert.deepEqual({ ...ini.$variables }, { ready: true, caption: "text here", count: 2 });
  assert.equal(ini.room.interactive, "false");
});

test("input action sections parse keyboard, pointer, and touch bindings", () => {
  const bindings = parseActionBindings(parseIni(`[action.activate_primary]\nkeyboard_code = Enter, Space\npointer_button = primary\ntouch = tap\n[action.cancel]\nkeyboard_code = Escape`));
  assert.equal(bindings.keyboard.get("Enter"), "activate_primary");
  assert.equal(bindings.keyboard.get("Space"), "activate_primary");
  assert.equal(bindings.pointer.get(0), "activate_primary");
  assert.equal(bindings.touch.get("tap"), "activate_primary");
  assert.equal(bindings.keyboard.get("Escape"), "cancel");
  assert.throws(() => parseActionBindings(parseIni("[action.a]\nkeyboard_code=Enter\n[action.b]\nkeyboard_code=Enter")), /already bound/);
});

test("inventory item scripts use an explicit namespace", () => {
  const [handler] = compile('on inventory.coffee_cup.look() {\n say "Portable"\n}', { itemId: "coffee_cup" });
  assert.deepEqual([handler.event, handler.localTarget, handler.inventoryOnly], ["entity.look", "coffee_cup", true]);
  assert.equal(instantiate(handler, ["coffee_cup"])[0].value, "Portable");
  assert.deepEqual(instantiate(handler, ["coin"]), []);
  assert.throws(() => compile('on inventory.coin.look() {\n}', { itemId: "coffee_cup" }), /invalid inventory event/);
  assert.throws(() => compile('on look() {\n}', { itemId: "coffee_cup" }), /must reference inventory\.coffee_cup/);
});

test("every demo object responds to the look action used by long touch", async () => {
  const main = compile(await readFile(new URL("../game/main.ana", import.meta.url), "utf8"));
  const roomSpecs = [
    ["hall", ["door", "clock", "fallen_clock", "key", "bush", "stick"]],
    ["garden", ["gate", "fountain", "wire", "lamp"]]
  ];
  const handlers = [...main];
  for (const [room, entities] of roomSpecs) {
    handlers.push(...compile(await readFile(new URL(`../game/rooms/${room}/script.ana`, import.meta.url), "utf8"), { roomId: room, entities }));
  }
  const itemIndex = parseIni(await readFile(new URL("../game/items/inventory.ini", import.meta.url), "utf8"));
  for (const item of itemIndex.catalogue.items.split(",").map((value) => value.trim())) {
    const script = itemIndex[`inventory.${item}`].script;
    handlers.push(...compile(await readFile(new URL(`../game/items/${script}`, import.meta.url), "utf8"), { itemId: item }));
  }

  const lookTargets = ["door", "clock", "fallen_clock", "key", "bush", "stick", "gate", "fountain", "wire", "lamp", "coffee_cup", "coin", "notebook", "pencil", "handkerchief"];
  for (const target of lookTargets) {
    assert.ok(handlers.some((handler) => handler.event === "entity.look" && handler.localTarget === target), `${target} is missing a look handler`);
  }
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

test("alpha hits cache pixels and use the current frame", () => {
  let reads = 0;
  const factory = () => ({ getContext: () => ({ drawImage() {}, getImageData() { reads++; return { data: new Uint8ClampedArray([0,0,0,0, 1,1,1,255, 1,1,1,255, 0,0,0,0]) }; } }) });
  const bitmap = { width: 4, height: 1 }, pixels = bitmapPixels(bitmap, factory);
  assert.equal(bitmapPixels(bitmap, factory), pixels); assert.equal(reads, 1);
  assert.equal(spriteAlphaHit([15, 15], [10, 10, 20, 10], [0, 0, 2, 1], pixels), false);
  assert.equal(spriteAlphaHit([15, 15], [10, 10, 20, 10], [2, 0, 2, 1], pixels), true);
});

test("explicit polygon hotspots are independent of sprite bounds", () => {
  const hotspot = entityHotspot({ id: "door", hotspot_polygon: "0,0; 20,0; 10,20" });
  assert.equal(pointInHotspot([10, 5], hotspot), true); assert.equal(pointInHotspot([19, 19], hotspot), false);
});

test("target selection uses z order and priority while ignoring decorations", () => {
  const entities = { low: { id: "low", z: "1" }, high: { id: "high", z: "2" }, decor: { id: "decor", z: "9", interactive: "false" } };
  assert.equal(entityTargetAt([0, 0], entities, () => true), "high"); entities.low.hotspot_priority = "3";
  assert.equal(entityTargetAt([0, 0], entities, () => true), "low");
});

test("alpha coordinates respect scaled and origin-shifted bounds", () => {
  const pixels = { width: 2, height: 1, data: new Uint8ClampedArray([0,0,0,0, 0,0,0,255]) }, bounds = [80, 50, 40, 20];
  assert.equal(spriteAlphaHit([85, 60], bounds, [0, 0, 2, 1], pixels), false);
  assert.equal(spriteAlphaHit([115, 60], bounds, [0, 0, 2, 1], pixels), true);
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
  assert.deepEqual(prepareItemUse(commands, world, ITEM_USE_PROTOCOL).map(({ op, target }) => [op, target]), [
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
  assert.deepEqual(prepareItemUse(commands, world, ITEM_USE_PROTOCOL).map(({ op, target }) => [op, target]), [
    ["walk", "door"], ["animate", undefined], ["say", undefined]
  ]);
});

test("item-use transactions can consume an inventory item", () => {
  const commands = instantiate(compile(`on fountain.use_item(item) {
    walk player to fountain
    remove item from inventory
    set game.coin_thrown = true
  }`, { roomId: "garden", entities: ["fountain"] })[0], ["coin", "fountain"]);
  const world = { inventory: ["coin"], entities: {
    player: { visible: "true" }, fountain: { visible: "true" }
  }, rooms: {} };
  assert.deepEqual(prepareItemUse(commands, world, ITEM_USE_PROTOCOL).map(({ op, target }) => [op, target]), [
    ["walk", "fountain"], ["animate", undefined], ["remove", "coin"], ["set", "game.coin_thrown"]
  ]);
});

test("an invalid item-use tail rejects the entire transaction", () => {
  const commands = [{ op: "walk", actor: "player", target: "key" }, { op: "take", target: "key" }, { op: "walk", actor: "player", target: "missing" }];
  const world = { inventory: [], entities: { player: { visible: "true" }, key: { visible: "true" } }, rooms: {} };
  assert.equal(prepareItemUse(commands, world, ITEM_USE_PROTOCOL), null);
});

const fallbackRuntime = (handlers = []) => {
  const runtime = Object.create(Runtime.prototype);
  Object.assign(runtime, {
    handlers, game: { protocol: { walk_command: "walk", take_command: "take", player_actor: "player", look_verb: "look", use_verb: "use", use_animation: "use", pickup_animation: "pickup" } }, room: "hall", queue: [], globals: {}, roomState: { hall: {} }, inventory: [],
    entities: { player: { moving: false }, door: { label: "painted door", visible: "true" }, key: { label: "brass key", visible: "true" } },
    inventoryEntities: {}, items: { key: { label: "small brass key" } }, rooms: {}, ui: {
      verb_panel: { verbs: "look" },
      "verb.look": { label: "Look", rect: "0,0,0,0" },
      "verb.open": { label: "Open", rect: "0,0,0,0" }, "verb.use": { label: "Use", object_preposition: "on", rect: "0,0,0,0" },
      "fallback.open": { text: "No opening {target}." },
      "fallback.use_item": { text: "No {first} with {second}." }
    }
  });
  return runtime;
};

test("clicking an entity without a walk handler walks to the clicked point", () => {
  const runtime = fallbackRuntime();
  Object.assign(runtime, {
    interactive: true, activeVerb: null, firstObject: null, message: "", width: 320, height: 200,
    targetAt: () => "door", inventoryLayout: () => ({ upRect: [0, 0, 0, 0], downRect: [0, 0, 0, 0], page: {} }),
    interruptCommands() { this.queue = []; }, actionSentence: ""
  });
  runtime.ui.accessibility = { walk_to: "Walk to {target}" };
  runtime.pointer({ button: 0, point: [111.4, 82.6] });
  assert.deepEqual(runtime.queue, [{ op: "walk", actor: "player", point: [111, 83], manual: true }]);
});

test("ground and inventory objects with the same id dispatch separate look handlers", () => {
  const roomHandler = compile('on key.look() {\n say "On the floor"\n}', { roomId: "hall", entities: ["key"] })[0];
  const inventoryHandler = compile('on inventory.key.look() {\n say "Small brass key"\n}', { itemId: "key" })[0];
  const runtime = fallbackRuntime([roomHandler, inventoryHandler]);
  assert.equal(runtime.commands("entity.look", ["key"])[0].value, "On the floor");
  runtime.inventory.push("key");
  assert.equal(runtime.commands("entity.look", ["key"])[0].value, "Small brass key");
  assert.equal(runtime.label("key"), "small brass key");
});

test("unsupported single-object verbs enqueue their configured narration", () => {
  const runtime = fallbackRuntime();
  runtime.perform("open", "door");
  assert.deepEqual(runtime.queue, [{ op: "narrate", value: "No opening painted door." }]);
});

test("invalid item combinations interpolate both configured labels", () => {
  const runtime = fallbackRuntime();
  runtime.enqueueFallback("use_item", ["key", "door"]);
  assert.deepEqual(runtime.queue, [{ op: "narrate", value: "No brass key with painted door." }]);
});

test("a rejected item transaction narrates without walking or animating", () => {
  const handler = compile(`on entity.use_item(item, target) { walk player to missing\n }`)[0];
  const runtime = fallbackRuntime([handler]);
  Object.assign(runtime, { interactive: true, activeVerb: "use", firstObject: "key", actionSentence: "", hoverTarget: null });
  runtime.inventoryLayout = () => ({ upRect: [0, 0, 0, 0], downRect: [0, 0, 0, 0], page: {} });
  runtime.targetAt = () => "door";
  runtime.action({ type: "pointer", button: 0, point: [10, 10] });
  assert.deepEqual(runtime.queue, [{ op: "narrate", value: "No brass key with painted door." }]);
});

test("a touch tap dispatches its pointer action exactly once", () => {
  const runtime = Object.create(Runtime.prototype), calls = [];
  Object.assign(runtime, {
    interactive: true,
    input: { touch: new Map([["tap", "pointer_primary"]]) },
    touchCursor: [10, 20],
    touch: { id: 7, startedAt: performance.now(), moved: false, long: false },
    longTouchMilliseconds: 550,
    doubleTouchMilliseconds: 350,
    doubleTouchMoveTolerance: 12,
    lastTap: null,
    action: (...args) => calls.push(args)
  });
  const event = { pointerType: "touch", pointerId: 7, preventDefault() {} };
  runtime.pointerUp(event);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ type: "pointer", button: 0, point: [10, 20], fast: null }]);
});

test("the secondary pointer action looks at the touched target", () => {
  const runtime = fallbackRuntime(), calls = [];
  Object.assign(runtime, {
    interactive: true, activeVerb: "use", firstObject: "key", message: "",
    width: 320, height: 200,
    inventoryLayout: () => ({ upRect: [0, 0, 0, 0], downRect: [0, 0, 0, 0], page: {} }),
    targetAt: () => "door",
    perform: (...args) => calls.push(args)
  });
  runtime.inputAction("pointer_secondary", { event: { preventDefault() {} }, point: [10, 10] });
  assert.deepEqual(calls, [["look", "door"]]);
  assert.equal(runtime.activeVerb, null);
  assert.equal(runtime.firstObject, null);
});

test("objects customize the secondary-pointer verb with look as the default", () => {
  assert.equal(objectSuggestedVerb({}, ["look", "take"]), "look");
  assert.equal(objectSuggestedVerb({ suggested_verb: "take" }, ["look", "take"]), "take");
  assert.throws(() => objectSuggestedVerb({ suggested_verb: "push" }, ["look", "take"]), /unknown verb push/);

  const runtime = fallbackRuntime(), calls = [];
  runtime.ui.verb_panel.verbs = "look, use, take";
  runtime.entities.key.suggested_verb = "take";
  Object.assign(runtime, { interactive: true, activeVerb: null, firstObject: null, message: "", width: 320, height: 200,
    inventoryLayout: () => ({ upRect: [0, 0, 0, 0], downRect: [0, 0, 0, 0], page: {} }), targetAt: () => "key", perform: (...args) => calls.push(args) });
  runtime.inputAction("pointer_secondary", { point: [10, 10] });
  assert.deepEqual(calls, [["take", "key"]]);

  runtime.inventory.push("key"); runtime.items.key.suggested_verb = "use";
  runtime.inputAction("pointer_secondary", { point: [10, 10] });
  assert.equal(runtime.activeVerb, "use"); assert.equal(runtime.firstObject, "key");
});

test("entity and room fallback scripts override generic narration in order", () => {
  const game = compile(`on fallback.open(target) { narrate "game"\n }`);
  const room = compile(`on fallback.open(target) { narrate "room"\n }`, { roomId: "hall", entities: ["door"] });
  const entity = compile(`on door.fallback_open() { narrate "entity"\n }`, { roomId: "hall", entities: ["door"] });
  const runtime = fallbackRuntime([...game, ...room, ...entity]);
  assert.equal(runtime.fallbackCommands("open", ["door"])[0].value, "entity");
  runtime.handlers = [...game, ...room];
  assert.equal(runtime.fallbackCommands("open", ["door"])[0].value, "room");
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
  assert.equal(inventoryLastRow(4, 4), 0);
  assert.equal(inventoryLastRow(5, 4), 1);
  assert.equal(inventoryLastRow(9, 4), 2);
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

test("entities use explicit z values and type defaults for back-to-front ordering", () => {
  const entities = {
    player: { id: "player", position: [0, 10] }, foreground: { id: "foreground", position: [0, 0], z: "150" },
    backdrop: { id: "backdrop", position: [0, 190] }
  };
  assert.deepEqual(entityRenderOrder(entities).map(({ id }) => id), ["backdrop", "player", "foreground"]);
});

test("z-clipped entities swap drawing order as the player crosses their y line", () => {
  const entities = {
    player: { id: "player", position: [0, 80] },
    hedge: { id: "hedge", position: [0, 0], z_clip: "100" }
  };
  assert.deepEqual(entityRenderOrder(entities).map(({ id }) => id), ["hedge", "player"]);
  entities.player.position[1] = 120;
  assert.deepEqual(entityRenderOrder(entities).map(({ id }) => id), ["player", "hedge"]);
});

test("non-interactive entities remain visible but are not interaction targets", () => {
  assert.equal(entityIsInteractive({ visible: "true", interactive: "false" }), false);
  assert.equal(entityIsInteractive({ visible: "false" }), false);
  assert.equal(entityIsInteractive({ visible: "true" }), true);
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

test("skippable handlers attach explicit metadata to every ordered command", () => {
  const [handler] = compile(`on room.enter() skippable {
 wait 20 ticks
 set game.seen = true
 shake 8 ticks
 enter room hall at door
}`);
  const commands = instantiate(handler, []);
  assert.equal(handler.skippable, true);
  assert.deepEqual(commands.map(({ op }) => op), ["wait", "set", "shake", "enter"]);
  assert.ok(commands.every(({ skippable }) => skippable));
  assert.equal(compile('on game.start() {\n set game.ready = true\n}')[0].skippable, false);
});

test("fast walking samples masks and triggers instead of jumping over them", () => {
  const visited = [];
  const result = advanceWalk([0, 0], [20, 0], 2, 10, ([x]) => x < 9, (point) => visited.push(point[0]));
  assert.deepEqual(result, { point: [8, 0], reached: false, blocked: true });
  assert.deepEqual(visited, [2, 4, 6, 8]);
});

test("fast exit traversal observes a narrow trigger boundary", () => {
  const triggers = { exit: [5, -1, 2, 2] }, entered = [];
  let occupied = new Set();
  const result = advanceWalk([0, 0], [12, 0], 1, 12, () => true, (point) => {
    const state = enteredTriggers(point, triggers, occupied); occupied = state.occupied; entered.push(...state.entered);
  });
  assert.equal(result.reached, true);
  assert.deepEqual(entered, ["exit"]);
});

test("cut-scene skipping retains persistent mutations and transitions in order", () => {
  const queue = [
    { op: "wait", skippable: true }, { op: "set", target: "game.key", value: true, skippable: true },
    { op: "say", skippable: true }, { op: "hide", target: "key", skippable: true },
    { op: "enter", room: "hall", skippable: true }, { op: "set", target: "game.puzzle", value: true }
  ];
  assert.equal(accelerateCommandQueue(queue), true);
  assert.deepEqual(queue.filter(({ skipPresentation }) => skipPresentation).map(({ op }) => op), ["wait", "set", "say", "hide", "enter"]);
  assert.deepEqual(queue.filter(({ op }) => ["set", "hide", "enter"].includes(op)).map(({ op, target }) => [op, target]), [
    ["set", "game.key"], ["hide", "key"], ["enter", undefined], ["set", "game.puzzle"]
  ]);
  assert.equal(queue.at(-1).fast, undefined, "the following non-skippable puzzle boundary is untouched");
});

test("cut-scene clicks advance one presentation phase at a time", () => {
  const waiting = [{ op: "pause" }, { op: "pause" }, { op: "set", target: "game.seen", value: true }, { op: "wait", ticks: 20 }, { op: "enter", room: "hall" }];
  assert.equal(advanceCutSceneQueue(waiting), true);
  assert.deepEqual(waiting.map(({ op }) => op), ["set", "wait", "enter"]);
  assert.equal(waiting[1].skipPresentation, undefined, "a later phase is not skipped by the same click");

  waiting.shift();
  assert.equal(advanceCutSceneQueue(waiting), true);
  assert.equal(waiting[0].skipPresentation, true);
  assert.equal(waiting[1].skipPresentation, undefined);
});

test("spawned tasks await independently and survive command interruption", () => {
  const handlers = compile(`task fountain_cycle() {
  loop {
    await 2 ticks
    set fountain.graphic = fountain_splash
    await 1 ticks
    set fountain.graphic = fountain
  }
}
on room.enter() {
  spawn fountain_cycle()
}`);
  const spawned = instantiate(handlers[0], [])[0];
  assert.equal(spawned.op, "spawn");
  const effects = [];
  const scheduler = new BackgroundTasks((command) => effects.push([command.op, command.target, command.value]));
  scheduler.start(spawned.definition, spawned.args, "garden");
  scheduler.step(); scheduler.step(); scheduler.step();
  assert.deepEqual(effects, []);
  scheduler.step();
  assert.deepEqual(effects, [["set", "fountain.graphic", "fountain_splash"]]);
  scheduler.step(); scheduler.step(); scheduler.step();
  assert.deepEqual(effects.at(-1), ["set", "fountain.graphic", "fountain"]);
});

test("room-owned background tasks are cancelled on room exit", () => {
  const [handler] = compile(`task later() {
  await 1 ticks
  set fountain.visible = false
}
on enter() {
  spawn later()
}`, { roomId: "garden", entities: ["fountain"] });
  const command = instantiate(handler, ["garden"])[0], effects = [];
  const scheduler = new BackgroundTasks((effect) => effects.push(effect));
  scheduler.start(command.definition, command.args, command.ownerRoom);
  scheduler.cancelRoom("garden"); scheduler.step(); scheduler.step(); scheduler.step();
  assert.deepEqual(effects, []);
});

test("browser bootstrap contains no authoritative interaction methods or package identities", async () => {
  const host = await readFile(new URL("../engine/bootstrap.js", import.meta.url), "utf8");
  for (const method of ["activateFocused", "pointer", "perform", "execute", "performBackground", "updateTriggers", "enter", "fallbackCommands"]) {
    assert.doesNotMatch(host, new RegExp(`\\n\\s{2}${method}\\(`), `${method} must be VM-owned`);
  }
  assert.doesNotMatch(host, /That doesn't work|rooms\.(?:hall|garden|title)|placeholder\.actor/);
});

test("browser bootstrap does not maintain or render keyboard target focus", async () => {
  const host = await readFile(new URL("../engine/bootstrap.js", import.meta.url), "utf8");
  assert.doesNotMatch(host, /focusedTarget|interactiveTargets|focusIndicator|aria-activedescendant/);
});

test("VM accepts normalized actions and returns detached immutable snapshots", () => {
  const vm = Object.create(DeterministicVM.prototype);
  Object.assign(vm, { room: "r", entities: { actor: { position: [1, 2] } }, inventory: [], inventoryEntities: {}, queue: [], message: "", messageKind: "", actionSentence: "", activeVerb: null, firstObject: null, tick: 0, shakeTicks: 0 });
  const scene = vm.sceneSnapshot();
  assert.ok(Object.isFrozen(scene) && Object.isFrozen(scene.entities.actor));
  vm.entities.actor.position[0] = 9;
  assert.equal(scene.entities.actor.position[0], 1);
  assert.throws(() => vm.action({ type: "physical_mouse_click" }), /Unknown VM action/);
});
