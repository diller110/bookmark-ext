import { test } from "node:test";
import assert from "node:assert/strict";
import { placeResource, removeResource, canvasResourceIds, canvasDropEdge, restoreCanvasLayout, resizeCanvasSplit, createCanvasHistory, canvasLayoutKey } from "../src/canvas-layout.js";

test("canvas storage and history are scoped by library, folder or collection IDs", () => {
  assert.equal(canvasLayoutKey("library"), "resourceCanvas/library", "Keep the previous layout in all resources");
  const keys = [canvasLayoutKey("library"), canvasLayoutKey("other"), canvasLayoutKey("library", "1"), canvasLayoutKey("library", "2"), canvasLayoutKey("library", undefined, "1"), canvasLayoutKey("library", undefined, "2")];
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(canvasLayoutKey("library", "folder", "collection"), canvasLayoutKey("library", undefined, "collection"));
  assert.notEqual(canvasLayoutKey("library", "a/b"), canvasLayoutKey("library", "a%2Fb"));
});

test("side middle is a column target even on very wide or tall panes", () => {
  for (const [width, height] of [[1200, 200], [200, 1200], [800, 600]]) {
    const rect = { left: 20, top: 30, width, height };
    for (const y of [0.26, 0.5, 0.74]) {
      assert.equal(canvasDropEdge(rect, 20 + width * 0.35, 30 + height * y), "left");
      assert.equal(canvasDropEdge(rect, 20 + width * 0.65, 30 + height * y), "right");
    }
    assert.equal(canvasDropEdge(rect, 20 + width / 2, 30 + height * 0.1), "top");
    assert.equal(canvasDropEdge(rect, 20 + width / 2, 30 + height * 0.9), "bottom");
    assert.equal(canvasDropEdge(rect, 20 + width / 2, 30 + height / 2), "replace");
  }
});

const row = (...children) => ({ axis: "horizontal", children });
const column = (...children) => ({ axis: "vertical", children });

test("canvas history undoes and redoes additions, moves, replacements, removals and resize snapshots", () => {
  const initial = row("a", "b", "c");
  const history = createCanvasHistory(initial);
  const moved = placeResource(initial, "a", "b", "bottom");
  const replaced = placeResource(moved, "d", "b", "replace");
  const removed = removeResource(replaced, "c");
  for (const layout of [moved, replaced, removed]) assert.equal(history.record(layout), true);
  const resized = resizeCanvasSplit(removed, 0, 0.7);
  history.record(resized);
  const snapshot = structuredClone(resized);
  resized.sizes[0] = 100;
  for (const expected of [removed, replaced, moved, initial]) assert.deepEqual(history.undo(), expected);
  assert.equal(history.undo(), undefined);
  for (const expected of [moved, replaced, removed, snapshot]) assert.deepEqual(history.redo(), expected);
  assert.equal(history.redo(), undefined);
  assert.equal(history.matches(snapshot), true);
  history.undo();
  assert.equal(history.record(removed), false);
  assert.deepEqual(history.redo(), snapshot, "A no-op must not discard redo");
  history.undo();
  history.record(placeResource(removed, "e", "d", "right"));
  assert.equal(history.redo(), undefined, "A new action must discard the abandoned redo branch");
  const empty = createCanvasHistory(null);
  empty.record("a");
  assert.equal(empty.undo(), null);
  assert.equal(empty.redo(), "a");
});

test("a central drop replaces only the target, retaining its dimensions without duplicates", () => {
  const layout = { ...row("a", { ...column("b", "c"), sizes: [3, 1] }), sizes: [2, 5] };
  assert.deepEqual(placeResource(layout, "d", "b", "replace"), { ...row("a", { ...column("d", "c"), sizes: [3, 1] }), sizes: [2, 5] });
  assert.deepEqual(placeResource(row("a", "b", "c"), "a", "c", "replace"), row("b", "a"));
  assert.equal(placeResource("a", "b", "a", "replace"), "b");
  assert.deepEqual(placeResource(layout, "b", "b", "replace"), layout);
});

test("swapping existing resources retains every slot, nested split and dimension", () => {
  const layout = { ...row("a", { ...column("b", "c"), sizes: [3, 1] }), sizes: [2, 5] };
  const swapped = { ...row("c", { ...column("b", "a"), sizes: [3, 1] }), sizes: [2, 5] };
  assert.deepEqual(placeResource(layout, "a", "c", "swap"), swapped);
  assert.deepEqual(placeResource(swapped, "c", "a", "swap"), layout);
  assert.deepEqual(placeResource(layout, "a", "a", "swap"), layout);
  assert.deepEqual(placeResource(layout, "d", "b", "swap"), placeResource(layout, "d", "b", "replace"), "A resource outside the canvas has no slot to swap");
});

test("resizing changes only the adjacent pair and preserves total space", () => {
  const layout = { ...row("a", "b", "c"), sizes: [2, 4, 6] };
  assert.deepEqual(resizeCanvasSplit(layout, 0, 0.75).sizes, [4.5, 1.5, 6]);
  assert.deepEqual(layout.sizes, [2, 4, 6]);
  assert.deepEqual(resizeCanvasSplit(row("a", "b"), 0, -1).sizes, [0.04, 1.96]);
  assert.deepEqual(resizeCanvasSplit(column("a", "b"), 0, 0.25).sizes, [0.5, 1.5]);
});

test("saved proportions survive restore, insertion and removal including missing resources", () => {
  const layout = { ...row("a", { ...column("b", "c"), sizes: [3, 1] }, "d"), sizes: [2, 5, 3] };
  assert.deepEqual(restoreCanvasLayout(JSON.parse(JSON.stringify(layout)), new Set(["a", "b", "c", "d"])), layout);
  assert.deepEqual(removeResource(layout, "a"), { ...row({ ...column("b", "c"), sizes: [3, 1] }, "d"), sizes: [5, 3] });
  assert.deepEqual(restoreCanvasLayout(layout, new Set(["a", "b", "d"])), { ...row("a", "b", "d"), sizes: [2, 5, 3] });
  assert.deepEqual(placeResource({ ...row("a", "b"), sizes: [2, 6] }, "c", "b", "left"), { ...row("a", "c", "b"), sizes: [2, 3, 3] });
  for (const sizes of [[0, 1], [-1, 2], [NaN, 1], [Infinity, 1], [2], "bad"]) {
    assert.deepEqual(restoreCanvasLayout({ ...row("a", "b"), sizes }, new Set(["a", "b"])).sizes, [1, 1]);
  }
});

test("saved canvas restores nested positions and removes only missing, duplicate or invalid entries", () => {
  const available = new Set(["a", "b", "c"]);
  const layout = row(column("c", "a"), "b");
  assert.deepEqual(restoreCanvasLayout(JSON.parse(JSON.stringify(layout)), available), layout);
  assert.deepEqual(restoreCanvasLayout(row(column("missing", "a"), "b", "a", { axis: "wrong", children: ["c"] }), available), row("a", "b"));
  for (const value of [null, 123, {}, { axis: "vertical", children: null }, "missing"]) {
    assert.equal(restoreCanvasLayout(value, available), null);
  }
  assert.equal(restoreCanvasLayout(row("missing", "c"), available), "c");
});

test("canvas inserts adjacent columns and rows, including splits inside an existing layout", () => {
  assert.equal(placeResource(null, "a"), "a");
  assert.deepEqual(placeResource("a", "b", "a", "left"), row("b", "a"));
  assert.deepEqual(placeResource("a", "b", "a", "bottom"), column("a", "b"));
  assert.deepEqual(placeResource(row("a", "b"), "c", "a", "right"), row("a", "c", "b"));
  assert.deepEqual(placeResource(row("a", "b"), "c", "a", "bottom"), row(column("a", "c"), "b"));
  assert.deepEqual(placeResource(row(column("a", "c"), "b"), "d", "b", "bottom"), row(column("a", "c"), column("b", "d")));
});

test("canvas has no four-resource limit and adding never replaces another resource", () => {
  let layout = null;
  for (let index = 0; index < 200; index++) layout = placeResource(layout, `resource-${index}`, `resource-${index - 1}`, "right");
  assert.deepEqual(canvasResourceIds(layout), Array.from({ length: 200 }, (_, index) => `resource-${index}`));
  assert.equal(layout.children.length, 200);
  assert.deepEqual(placeResource(row("a", "b", "c", "d"), "e", "b", "right"), row("a", "b", "e", "c", "d"));
});

test("canvas moves existing resources to the requested side or row without duplicates", () => {
  assert.deepEqual(placeResource(row("a", column("b", "c")), "a", "c", "left"), column("b", row("a", "c")));
  assert.deepEqual(placeResource(row("a", "b", "c"), "a", "b", "bottom"), row(column("b", "a"), "c"));
  assert.deepEqual(placeResource(row("a", "b", "c"), "c", "a", "top"), row(column("c", "a"), "b"));
  assert.deepEqual(placeResource(column("a", "b"), "a", "b", "right"), row("b", "a"));
  assert.deepEqual(placeResource(row("a", "b", "c"), "a", "c", "right"), row("b", "c", "a"));
  assert.deepEqual(placeResource(row("a", "b"), "a", "a", "right"), row("a", "b"));
});

test("canvas collapses removed empty splits", () => {
  assert.deepEqual(removeResource(row("a", column("b", "c")), "b"), row("a", "c"));
  assert.equal(removeResource(row("a", "b"), "b"), "a");
  assert.equal(removeResource("a", "a"), null);
});
