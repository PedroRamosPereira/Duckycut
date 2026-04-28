const test   = require("node:test");
const assert = require("node:assert/strict");
const { secondsToTimecode, secondsToDropTimecode } = require("../client/js/cutZones.js");

test("NDF NTSC 29.97: 60s -> 00:00:59:28 (timecode trails wall clock)", () => {
    // round(60 * 30000/1001) = round(1798.20) = 1798 frames
    // 1798 / 30 = 59 sec + 28 frames
    assert.equal(secondsToTimecode(60, 29.97, true), "00:00:59:28");
});

test("DF NTSC 29.97: 60s real -> 00:00:59;28 (frame 1798 still inside minute 0)", () => {
    // round(60 * 29.97) = 1798 frames; drop happens starting at frame 1800.
    assert.equal(secondsToDropTimecode(60, 29.97), "00:00:59;28");
});

test("DF NTSC 29.97: ~60.07s real -> 00:01:00;02 (first frame after drop)", () => {
    // frame 1800 ≈ 60.0667s real → minute 1 starts; labels 00,01 dropped → ;02
    assert.equal(secondsToDropTimecode(1800 / 29.97, 29.97), "00:01:00;02");
});

test("DF NTSC 29.97: 600s -> 00:10:00;00 (10-min boundary suppresses drop)", () => {
    // 600 real sec = round(600 * 30000/1001) = 17982 frames
    // frames per 10 min in DF: 30*60*10 - 18 = 17982 -> exact 00:10:00;00
    assert.equal(secondsToDropTimecode(600, 29.97), "00:10:00;00");
});

test("DF separator is semicolon before frames", () => {
    const tc = secondsToDropTimecode(1, 29.97);
    assert.match(tc, /^\d\d:\d\d:\d\d;\d\d$/);
});

test("Integer 30 fps: secondsToTimecode uses colon separator", () => {
    assert.equal(secondsToTimecode(1, 30, false), "00:00:01:00");
});

test("Integer 30 fps with isNTSC=false: 60s -> 00:01:00:00", () => {
    assert.equal(secondsToTimecode(60, 30, false), "00:01:00:00");
});

test("DF 59.94 60fps: 60s real -> 00:00:59;56 (frame 3596 inside minute 0)", () => {
    // round(60 * 59.94) = 3596 frames; 3596 % 60 = 56; drop happens at frame 3600.
    assert.equal(secondsToDropTimecode(60, 59.94), "00:00:59;56");
});

test("DF 59.94 60fps: ~60.06s real -> 00:01:00;04 (4 frames dropped at minute 1)", () => {
    assert.equal(secondsToDropTimecode(3600 / 59.94, 59.94), "00:01:00;04");
});
