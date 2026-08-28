import test from "node:test";
import assert from "node:assert/strict";
import { compile, instantiate, textDuration } from "../engine/script.js";
import { parseIni } from "../engine/ini.js";
import { resolvePackagePath } from "../engine/path.js";
import { loadBitmaps } from "../engine/bitmaps.js";

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
