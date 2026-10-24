import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOutputFormat } from "../../src/contract.js";
test("CLI retains explicit stream-json and rejects unknown output formats", () => {
  assert.equal(normalizeOutputFormat("stream-json"), "stream-json");
  assert.equal(normalizeOutputFormat(undefined), undefined);
  assert.throws(
    () => normalizeOutputFormat("owned-invalid-format"),
    /--output-format must be one of/,
  );
});
