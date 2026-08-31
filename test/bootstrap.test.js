import test from "node:test";
import assert from "node:assert/strict";
import { createLoadingBar } from "../engine/bootstrap.js";

test("loading bar uses configured bitmap dimensions, colors, and wall", () => {
  const operations = [];
  const context = {
    fillStyle: "",
    clearRect: (...args) => operations.push(["clear", ...args]),
    fillRect: (...args) => operations.push(["fill", context.fillStyle, ...args])
  };
  const canvas = {
    style: { aspectRatio: "", setProperty() {} },
    setAttribute(name, value) { this[name] = value; },
    getContext: () => context
  };
  const page = { createElement: (tag) => { assert.equal(tag, "canvas"); return canvas; } };
  const host = { replaceChildren(child) { this.child = child; } };
  const loading = createLoadingBar(page, host, {
    display: { logical_width: "320", logical_height: "200" },
    loading: { rectangle_color: "#123456", wall_thickness: "3", bar_color: "#abcdef", size: "100,10" }
  });

  loading.update(0.5);
  assert.equal(host.child, canvas);
  assert.deepEqual([canvas.width, canvas.height], [320, 200]);
  assert.equal(canvas["aria-valuenow"], "50");
  assert.deepEqual(operations.slice(-3), [
    ["fill", "#123456", 110, 95, 100, 10],
    ["clear", 113, 98, 94, 4],
    ["fill", "#abcdef", 113, 98, 47, 4]
  ]);
});

test("loading bar rejects a wall too thick for its configured size", () => {
  const page = { createElement: () => ({ style: { setProperty() {} }, setAttribute() {}, getContext() { return {}; } }) };
  assert.throws(() => createLoadingBar(page, { replaceChildren() {} }, {
    display: { logical_width: "320", logical_height: "200" }, loading: { size: "10,4", wall_thickness: "2" }
  }), /larger than twice/);
});
