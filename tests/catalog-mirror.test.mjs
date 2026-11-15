import test from "node:test";
import assert from "node:assert/strict";
import { resolveCatalogMirrorAction } from "../catalog-mirror.js";

test("catalog mirror updates the single matching SKU case-insensitively", () => {
  const rows = [
    ["OTHER-1", "Other product"],
    [" muse-starter ", "Muse starter"],
    ["OTHER-2", "Other product 2"]
  ];
  assert.deepEqual(resolveCatalogMirrorAction(rows, "MUSE-STARTER"), {
    action: "UPDATE",
    rowNumber: 3
  });
});

test("catalog mirror appends only when the SKU is absent", () => {
  assert.deepEqual(resolveCatalogMirrorAction([["OTHER-1"]], "NEW-SKU"), {
    action: "APPEND",
    rowNumbers: []
  });
});

test("catalog mirror refuses duplicate SKUs and returns every sheet row number", () => {
  const rows = [
    ["MUSE-STARTER", "first"],
    ["OTHER-1"],
    [" muse-starter ", "duplicate"],
    ["MUSE-STARTER", "third"]
  ];
  assert.deepEqual(resolveCatalogMirrorAction(rows, "muse-starter"), {
    action: "DUPLICATE",
    rowNumbers: [2, 4, 5]
  });
});

test("catalog mirror rejects an empty SKU instead of appending an ambiguous row", () => {
  assert.deepEqual(resolveCatalogMirrorAction([["SKU-1"]], "   "), {
    action: "INVALID",
    rowNumbers: []
  });
});

test("catalog mirror treats empty sheet cells as non-matches", () => {
  assert.deepEqual(resolveCatalogMirrorAction([[], [null], ["  "]], "SKU-1"), {
    action: "APPEND",
    rowNumbers: []
  });
});
