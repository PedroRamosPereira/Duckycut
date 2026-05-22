const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { computeVadKeepZones, offsetIntervals } = require("../client/js/vadTranslator");

test("VAD translator converts speech intervals into keep zones", () => {
    assert.deepEqual(
        computeVadKeepZones([[1, 2], [4, 5]], 10, {}),
        [[1, 2], [4, 5]]
    );
});

test("VAD translator expands speech with asymmetric padding", () => {
    assert.deepEqual(
        computeVadKeepZones([[1, 2]], 10, { paddingIn: 0.25, paddingOut: 0.5 }),
        [[0.75, 2.5]]
    );
});

test("VAD translator merges zones that touch after padding", () => {
    assert.deepEqual(
        computeVadKeepZones([[1, 2], [2.2, 3]], 10, { paddingIn: 0.1, paddingOut: 0.1 }),
        [[0.9, 3.1]]
    );
});

test("VAD translator merges zones separated by a small gap", () => {
    assert.deepEqual(
        computeVadKeepZones([[1, 2], [2.4, 3]], 10, { minGapDuration: 0.5 }),
        [[1, 3]]
    );
});

test("VAD translator clamps keep zones to the media duration", () => {
    assert.deepEqual(
        computeVadKeepZones([[0.1, 9.8]], 10, { paddingIn: 1, paddingOut: 1 }),
        [[0, 10]]
    );
});

test("VAD translator drops clips shorter than minClipDuration", () => {
    assert.deepEqual(
        computeVadKeepZones([[1, 1.2], [2, 3]], 10, { minClipDuration: 0.5 }),
        [[2, 3]]
    );
});

test("VAD translator returns an empty keep list for empty speech input", () => {
    assert.deepEqual(computeVadKeepZones([], 10, {}), []);
});

test("VAD translator treats no speech as one full-duration cut", () => {
    const { computeCutZonesFromKeepZones } = require("../client/js/vadTranslator");

    assert.deepEqual(computeCutZonesFromKeepZones([], 10), [[0, 10]]);
});

test("VAD In-Out flow keeps local calculation separate from sequence offset", () => {
    const localKeepZones = computeVadKeepZones([[1, 2]], 5, { paddingIn: 0.25, paddingOut: 0.25 });
    assert.deepEqual(localKeepZones, [[0.75, 2.25]]);
    assert.deepEqual(offsetIntervals(localKeepZones, 100), [[100.75, 102.25]]);
});

test("VAD translator attaches to the CEP window even when CommonJS globals exist", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "../client/js/vadTranslator.js"), "utf8");
    const sandbox = {
        module: { exports: {} },
        exports: {},
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;

    vm.runInNewContext(source, sandbox, { filename: "vadTranslator.js" });

    assert.equal(typeof sandbox.module.exports.computeVadKeepZones, "function");
    assert.equal(typeof sandbox.Duckycut.vadTranslator.computeVadKeepZones, "function");
});
