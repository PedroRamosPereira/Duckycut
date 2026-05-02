const test = require("node:test");
const assert = require("node:assert/strict");

const { parseFfmpegDuration } = require("../server/silenceDetector.js");

test("parseFfmpegDuration handles ffmpeg durations with six fractional digits", () => {
    const output = "Duration: 00:01:02.345678, start: 0.000000, bitrate: 1536 kb/s";

    assert.equal(parseFfmpegDuration(output), 62.345678);
});

test("parseFfmpegDuration handles ffmpeg durations with two fractional digits", () => {
    const output = "Duration: 01:02:03.45, start: 0.000000, bitrate: 1536 kb/s";

    assert.equal(parseFfmpegDuration(output), 3723.45);
});
