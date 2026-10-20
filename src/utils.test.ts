// Path extraction / templating self-test:  npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractFirst, getPath, renderTemplate } from "./utils";

const body = { offers: [{ offerId: "" }, { offerId: "B" }], selectedOffer: { OfferId: "S" }, list: [[{ x: 1 }]] };

test("[*] returns the first non-empty match", () => {
  assert.equal(getPath(body, "offers[*].offerId"), "B");
  assert.equal(getPath(body, "offers[0].offerId"), "");
  assert.equal(getPath(body, "list[0][*].x"), 1);
  assert.equal(getPath(body, "missing[*].x"), undefined);
});

test("keys are case-insensitive and candidates are tried in order", () => {
  assert.equal(getPath(body, "selectedOffer.offerId"), "S");
  assert.equal(extractFirst(body, ["offers[0].offerId", "offers[*].offerId"]), "B");
  assert.equal(extractFirst({ offers: [] }, ["offers[*].offerId", "**.offerId"]), undefined);
});

test("templates keep raw types and reject unknown variables", () => {
  assert.deepEqual(renderTemplate({ a: "{{N}}", b: "x-{{N}}" }, { N: 5 }), { a: 5, b: "x-5" });
  assert.throws(() => renderTemplate({ a: "{{MISSING}}" }, {}), /MISSING/);
});
