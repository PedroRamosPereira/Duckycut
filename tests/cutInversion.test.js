const test   = require("node:test");
const assert = require("node:assert/strict");
const { secondsToTimecode, secondsToDropTimecode, parseZeroPoint } =
    require("../client/js/cutZones.js");

const ONE_HOUR_TICKS = 914457600000000;

test("zeroPoint=0 + 1s NTSC NDF -> 00:00:00:29 (frame 30 since round(1*30000/1001)=30)", () => {
    var zp = parseZeroPoint(0);
    assert.equal(zp, 0);
    // round(1 * 30 * 1000 / 1001) = round(29.97) = 30. NDF: 30%30=0, 30/30=1s.
    assert.equal(secondsToTimecode(1 + zp, 29.97, true), "00:00:01:00");
});

test("zeroPoint=1h string ticks + 1s NTSC NDF -> ~00:59:57:12", () => {
    var zp = parseZeroPoint(String(ONE_HOUR_TICKS));
    assert.equal(zp, 3600);
    var tc = secondsToTimecode(1 + zp, 29.97, true);
    // round(3601 * 30000/1001) = round(107922.077) = 107922 frames
    // 107922/30 = 3597 sec + 12 frames; 3597 sec = 59 min 57 sec
    assert.equal(tc, "00:59:57:12");
});

test("zeroPoint=1h Time object: same as string", () => {
    var fakeTime = { ticks: String(ONE_HOUR_TICKS), seconds: 3600 };
    assert.equal(parseZeroPoint(fakeTime), 3600);
});

test("zeroPoint=1h Time object without .seconds: derives from ticks", () => {
    var fakeTime = { ticks: String(ONE_HOUR_TICKS) };
    assert.equal(parseZeroPoint(fakeTime), 3600);
});

test("DF 29.97 with zeroPoint=1h: 1s into seq -> 01:00:00;something", () => {
    var zp = parseZeroPoint(String(ONE_HOUR_TICKS));
    var tc = secondsToDropTimecode(1 + zp, 29.97);
    // DF aligns with wall clock: 3601s real ≈ TC 01:00:01;ff
    assert.match(tc, /^01:00:0[01];\d\d$/);
});

test("regression: Number(timeObj) was NaN bug (would have given zp=0)", () => {
    var fakeTime = { ticks: String(ONE_HOUR_TICKS), seconds: 3600 };
    // Old code: Number(fakeTime) -> NaN -> zpSec stays 0. New code: 3600.
    assert.notEqual(parseZeroPoint(fakeTime), 0);
    assert.equal(parseZeroPoint(fakeTime), 3600);
});
