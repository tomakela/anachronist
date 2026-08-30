import test from "node:test";
import assert from "node:assert/strict";
import { parseIni, parseIniDocument } from "../engine/ini.js";
import { compile, compileScript } from "../engine/script.js";

test("lossless INI documents retain trivia, ordering, and key/value ranges", () => {
  const document = parseIniDocument("; heading\n\n[room]\nname = Hall\n", "rooms/hall.ini");
  assert.deepEqual(document.nodes.map(({ type }) => type), ["comment", "blank", "section", "property", "blank"]);
  assert.equal(document.nodes[3].section, "room");
  assert.deepEqual(document.nodes[3].keyRange.start, { line: 4, column: 1, offset: 18 });
  assert.equal(document.value.room.name, "Hall");
  assert.equal(parseIni("[room]\nname=Hall").room.name, "Hall");
});

test("INI diagnostics are structured while the runtime API throws the first error", () => {
  const { diagnostics } = parseIniDocument("[room]\nname=a\nname=b", "room.ini");
  assert.deepEqual({ ...diagnostics[0], range: undefined }, {
    path: "room.ini", filePath: "room.ini", line: 3, column: 1, range: undefined,
    severity: "error", code: "ini-duplicate-key", message: "duplicate key name"
  });
  assert.throws(() => parseIni("bad", "room.ini"), (error) => error.diagnostic.code === "ini-invalid-entry");
});

test("script compilation exposes tokens, declarations, commands, and diagnostics", () => {
  const result = compileScript("on door.look(item) {\n set game.seen = true\n}\n", { path: "hall.ana", roomId: "hall", entities: ["door"] });
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.syntax.handlers[0].target, "door");
  assert.deepEqual(result.syntax.handlers[0].arguments, ["item", "target"]);
  assert.deepEqual(result.syntax.handlers[0].stateReferences, ["game.seen"]);
  assert.equal(result.syntax.handlers[0].commandRanges[0].command, "set");
  assert.equal(result.tokens[0].range.start.line, 1);

  const invalid = compileScript("on game.start() { nope\n}\n", { path: "main.ana" });
  assert.equal(invalid.diagnostics[0].path, "main.ana");
  assert.equal(invalid.diagnostics[0].severity, "error");
  assert.throws(() => compile("on game.start() { nope\n}\n", { path: "main.ana" }), (error) => error.diagnostic.code === "script-syntax-error");
});
