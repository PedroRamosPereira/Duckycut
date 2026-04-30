const test   = require("node:test");
const assert = require("node:assert/strict");
const { computeSilenceCutZones, secondsToTimecode, jsxStringArg } = require("../client/js/cutZones.js");

test("computeSilenceCutZones: empty input -> empty output", () => {
    assert.deepEqual(computeSilenceCutZones([], 100, {}), []);
});

test("computeSilenceCutZones: single silence, no padding", () => {
    const out = computeSilenceCutZones([[2, 5]], 10, {});
    assert.deepEqual(out, [[2, 5]]);
});

test("computeSilenceCutZones: padding shrinks both sides", () => {
    const out = computeSilenceCutZones([[2, 5]], 10, { paddingIn: 0.2, paddingOut: 0.3 });
    assert.equal(out.length, 1);
    assert.ok(Math.abs(out[0][0] - 2.3) < 1e-9);
    assert.ok(Math.abs(out[0][1] - 4.8) < 1e-9);
});

test("computeSilenceCutZones: padding bigger than silence drops it", () => {
    const out = computeSilenceCutZones([[2, 2.5]], 10, { paddingIn: 1, paddingOut: 1 });
    assert.deepEqual(out, []);
});

test("computeSilenceCutZones: minGap merges close silences", () => {
    const out = computeSilenceCutZones([[1, 2], [2.3, 4]], 10, { minGapDuration: 0.5 });
    assert.deepEqual(out, [[1, 4]]);
});

test("computeSilenceCutZones: minSilence drops short ones", () => {
    const out = computeSilenceCutZones([[1, 1.2], [3, 5]], 10, { minSilenceDuration: 0.5 });
    assert.deepEqual(out, [[3, 5]]);
});

test("computeSilenceCutZones: clamps to [0, totalDuration]", () => {
    const out = computeSilenceCutZones([[-1, 2], [8, 12]], 10, {});
    assert.deepEqual(out, [[0, 2], [8, 10]]);
});

test("secondsToTimecode: integer fps, exact second", () => {
    assert.equal(secondsToTimecode(1.0, 25, false), "00:00:01:00");
});

test("secondsToTimecode: integer fps, sub-second frames", () => {
    assert.equal(secondsToTimecode(1.04, 25, false), "00:00:01:01");
});

test("secondsToTimecode: NTSC 29.97 uses round(s*30*1000/1001)", () => {
    assert.equal(secondsToTimecode(1.0, 29.97, true), "00:00:01:00");
});

test("secondsToTimecode: hours/minutes wrap correctly", () => {
    assert.equal(secondsToTimecode(3725.0, 30, false), "01:02:05:00");
});

test("secondsToTimecode: zero seconds", () => {
    assert.equal(secondsToTimecode(0, 25, false), "00:00:00:00");
});

test("jsxStringArg: escapes backslashes, quotes, and apostrophes for evalScript string args", () => {
    const value = "C:\\tmp\\duckycut 'quote' \"double\".wav";
    const arg = jsxStringArg(value);

    assert.equal(JSON.parse(arg), "C:/tmp/duckycut 'quote' \"double\".wav");
    assert.doesNotMatch(arg, /\\tmp/);
});
