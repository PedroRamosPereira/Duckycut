const test   = require("node:test");
const assert = require("node:assert/strict");
const {
    computeSilenceCutZones,
    prepareCutZonesForApply,
    offsetIntervals,
    intersectIntervalsWithRange,
    secondsToTimecode,
    jsxStringArg,
    getProjectPathError,
} = require("../client/js/cutZones.js");

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

test("getProjectPathError: warns when Premiere project is not saved", () => {
    assert.equal(
        getProjectPathError('{"error":"Project not saved"}'),
        "Save the Premiere project before running analysis"
    );
});

test("getProjectPathError: accepts saved project response", () => {
    assert.equal(
        getProjectPathError('{"projectPath":"C:/p/edit.prproj","projectDir":"C:/p"}'),
        ""
    );
});

test("prepareCutZonesForApply: merges overlapping cut zones after frame snap", () => {
    const out = prepareCutZonesForApply([[0, 2.02], [1.98, 4]], 25, false);

    assert.deepEqual(out, [[0, 4]]);
});

test("prepareCutZonesForApply: drops zones collapsed by frame snap", () => {
    const out = prepareCutZonesForApply([[1.001, 1.002], [2, 2.08]], 25, false);

    assert.deepEqual(out, [[2, 2.08]]);
});

test("offsetIntervals shifts detected silence into sequence time", () => {
    const zones = offsetIntervals([[0.5, 1.25], [2, 3]], 10);
    assert.deepEqual(zones, [[10.5, 11.25], [12, 13]]);
});

test("intersectIntervalsWithRange clamps zones to In-Out", () => {
    const zones = intersectIntervalsWithRange(
        [[0, 5], [8, 12], [15, 20], [22, 25]],
        { startSeconds: 10, endSeconds: 22 }
    );
    assert.deepEqual(zones, [[10, 12], [15, 20]]);
});

test("prepareTickCutZonesForApply converts snapped cut zones to integer ticks", () => {
    const zones = require("../client/js/cutZones.js").prepareTickCutZonesForApply(
        [[1, 2], [2.00001, 3]],
        25,
        false
    );

    assert.deepEqual(zones, [
        {
            startSeconds: 1,
            endSeconds: 2,
            startTicks: "254016000000",
            endTicks: "508032000000"
        },
        {
            startSeconds: 2,
            endSeconds: 3,
            startTicks: "508032000000",
            endTicks: "762048000000"
        }
    ]);
});

test("chunkArray splits zones into deterministic chunk sizes", () => {
    const zones = [1, 2, 3, 4, 5];
    const chunks = require("../client/js/cutZones.js").chunkArray(zones, 2);
    assert.deepEqual(chunks, [[1, 2], [3, 4], [5]]);
});
