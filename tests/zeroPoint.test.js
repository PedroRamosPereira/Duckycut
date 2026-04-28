const test   = require("node:test");
const assert = require("node:assert/strict");
const { parseZeroPoint } = require("../client/js/cutZones.js");

// 1 hour @ 254016000000 ticks/sec = 914,457,600,000,000 ticks
const ONE_HOUR_TICKS = 914457600000000;

test("parseZeroPoint: string ticks returns seconds", () => {
    assert.equal(parseZeroPoint(String(ONE_HOUR_TICKS)), 3600);
});

test("parseZeroPoint: number ticks returns seconds", () => {
    assert.equal(parseZeroPoint(ONE_HOUR_TICKS), 3600);
});

test("parseZeroPoint: Time object with .seconds returns seconds", () => {
    const fakeTimeObj = { ticks: String(ONE_HOUR_TICKS), seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTimeObj), 3600);
});

test("parseZeroPoint: Time object with only .ticks falls back to ticks math", () => {
    const fakeTimeObj = { ticks: String(ONE_HOUR_TICKS) };
    assert.equal(parseZeroPoint(fakeTimeObj), 3600);
});

test("parseZeroPoint: Time object with only .seconds works", () => {
    const fakeTimeObj = { seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTimeObj), 3600);
});

test("parseZeroPoint: zero / empty / null returns 0", () => {
    assert.equal(parseZeroPoint(0), 0);
    assert.equal(parseZeroPoint("0"), 0);
    assert.equal(parseZeroPoint(""), 0);
    assert.equal(parseZeroPoint(null), 0);
    assert.equal(parseZeroPoint(undefined), 0);
});

test("parseZeroPoint: negative ticks returns negative seconds", () => {
    assert.equal(parseZeroPoint(-ONE_HOUR_TICKS), -3600);
});

test("parseZeroPoint: garbage values return 0 without throwing", () => {
    assert.equal(parseZeroPoint("not-a-number"), 0);
    assert.equal(parseZeroPoint({}), 0);
    assert.equal(parseZeroPoint({ foo: "bar" }), 0);
});
