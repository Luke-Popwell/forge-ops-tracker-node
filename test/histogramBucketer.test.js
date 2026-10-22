import assert from "node:assert/strict";
import { test } from "node:test";
import { BOUNDARIES_MS, bucketFor } from "../src/histogramBucketer.js";

test("returns the smallest boundary a duration fits under, as a string", () => {
  assert.equal(bucketFor(10), "50");
  assert.equal(bucketFor(50), "50");
  assert.equal(bucketFor(51), "100");
  assert.equal(bucketFor(4999), "5000");
});

test("returns inf for anything larger than the largest boundary", () => {
  assert.equal(bucketFor(10001), "inf");
  assert.equal(bucketFor(1000000), "inf");
});

test("puts a duration exactly on a boundary into that boundary's own bucket, not the next one up", () => {
  for (const boundary of BOUNDARIES_MS) {
    assert.equal(bucketFor(boundary), String(boundary));
  }
});

test("boundaries match the server's HistogramPercentile", () => {
  // app/services/histogram_percentile.rb and every other SDK must agree on this exact list.
  assert.deepEqual([...BOUNDARIES_MS], [50, 100, 250, 500, 1000, 2500, 5000, 10000]);
});
