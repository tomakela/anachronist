import test from "node:test";
import assert from "node:assert/strict";
import { compile, instantiate } from "../engine/script.js";
import { parseIni } from "../engine/ini.js";

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
