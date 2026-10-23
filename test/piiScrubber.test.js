import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { REDACTED, scrub, scrubString } from "../src/piiScrubber.js";

// A byte-identical copy of sdks/pii_scrubbing_vectors.json, generated from the server's own
// app/services/pii_scrubber.rb: card numbers, IBANs and bank-detail keys, as sdks/PII_SCRUBBING.md
// describes them.
const fixtureUrl = new URL("./fixtures/pii_scrubbing_vectors.json", import.meta.url);
const vectors = JSON.parse(fs.readFileSync(fixtureUrl, "utf8"));

for (const vector of vectors.strings) {
  test(`scrubs ${JSON.stringify(vector.input)} exactly as the server does`, () => {
    assert.equal(scrub(vector.input), vector.scrubbed);
  });
}

for (const vector of vectors.keys) {
  test(`${vector.redacted ? "redacts" : "keeps"} a value under ${JSON.stringify(vector.key)}, as the server does`, () => {
    const scrubbed = /** @type {Record<string, unknown>} */ (scrub({ [vector.key]: "x" }));
    assert.equal(scrubbed[vector.key] === REDACTED, vector.redacted);
  });
}

test("redacts an email address embedded in free text", () => {
  assert.equal(
    scrubString("undefined method 'name' for user@example.com"),
    "undefined method 'name' for [EMAIL FILTERED]"
  );
});

test("redacts a formatted credit card number but leaves an ordinary long numeric id alone", () => {
  assert.equal(scrubString("card 4111-1111-1111-1111 declined"), "card [CREDIT CARD FILTERED] declined");
  assert.equal(
    scrubString("Couldn't find Invoice with id=8821445199"),
    "Couldn't find Invoice with id=8821445199"
  );
});

test("redacts known API key and token formats", () => {
  assert.equal(scrubString("using sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc"), "using [STRIPE KEY FILTERED]");
  assert.equal(scrubString("Authorization: Bearer abc123.def456"), "Authorization: [BEARER TOKEN FILTERED]");
});

test("redacts the whole value under a sensitive-looking key regardless of type or casing", () => {
  const scrubbed = scrub({ password: "hunter2", "API-Key": "sk_live_abc", count: 3 });

  assert.deepEqual(scrubbed, { password: "[FILTERED]", "API-Key": "[FILTERED]", count: 3 });
});

test("recurses into nested objects and arrays", () => {
  const scrubbed = scrub({ user: { email: "ada@example.com" }, notes: ["no PII here"] });

  assert.deepEqual(scrubbed, { user: { email: "[EMAIL FILTERED]" }, notes: ["no PII here"] });
});
