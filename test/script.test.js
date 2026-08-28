import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile, instantiate, textDuration } from "../engine/script.js";
import { parseIni } from "../engine/ini.js";
import { resolvePackagePath } from "../engine/path.js";
import { loadBitmaps } from "../engine/bitmaps.js";
import { enteredTriggers, prepareItemUse, verbSentence } from "../engine/interaction.js";

test("a handler is fully expanded into an ordered command chain", () => {
  const [handler] = compile(`module demo; on entity.use_item(item, target) {
    if (item == key) { sequence { walk player to key; take key; walk player to target; say "Open"; } }
    else { say "No"; }
  }`);
  assert.deepEqual(instantiate(handler, ["key", "door"]).map(({ op, target }) => [op, target]), [
    ["walk", "key"], ["take", "key"], ["walk", "door"], ["say", undefined]
  ]);
  assert.equal(instantiate(handler, ["stone", "door"])[0].value, "No");
});

test("handlers can branch on game-global state", () => {
  const [handler] = compile(`on room.enter() {
    if (game.key_taken == true) { hide key; }
  }`);
  assert.deepEqual(instantiate(handler, [], { game: { key_taken: true } }).map(({ op, target }) => [op, target]), [["hide", "key"]]);
  assert.deepEqual(instantiate(handler, [], { game: { key_taken: false } }), []);
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

test("using the key on a non-door does not enqueue a walk", () => {
  const source = `on entity.use_item(item, target) {
    if (target == door) { if (item == key) { walk player to door; } else { say "No"; } }
    else { say "I can't do that"; }
  }`;
  const commands = instantiate(compile(source)[0], ["key", "clock"]);
  assert.deepEqual(commands.map(({ op }) => op), ["say"]);
});

test("dialogue duration is configured from character count", () => {
  const runtime = { text_base_ticks: "30", text_ticks_per_character: "4", text_minimum_ticks: "90" };
  assert.equal(textDuration("short", runtime), 90);
  assert.equal(textDuration("a sufficiently long sentence", runtime), 142);
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
    walk player to item; take item; walk player to target; set door.open = true;
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
    walk player to item; take item; walk player to target; say "Used";
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
