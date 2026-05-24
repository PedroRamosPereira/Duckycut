const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const { parseFfmpegDuration, probeAudioFromSequence } = require("../server/silenceDetector.js");

const root = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("parseFfmpegDuration handles ffmpeg durations with six fractional digits", () => {
    const output = "Duration: 00:01:02.345678, start: 0.000000, bitrate: 1536 kb/s";

    assert.equal(parseFfmpegDuration(output), 62.345678);
});

test("parseFfmpegDuration handles ffmpeg durations with two fractional digits", () => {
    const output = "Duration: 01:02:03.45, start: 0.000000, bitrate: 1536 kb/s";

    assert.equal(parseFfmpegDuration(output), 3723.45);
});

test("probeAudioFromSequence is exported for selected-track calibration", () => {
    assert.equal(typeof probeAudioFromSequence, "function");
});

test("probeAudio rejects when FFmpeg exits with a non-zero code", () => {
    const source = readProjectFile("server/silenceDetector.js");
    const start = source.indexOf("function probeAudio");
    assert.notEqual(start, -1, "probeAudio should exist");

    const end = source.indexOf("\nfunction parseFfmpegDuration", start + 1);
    const fn = source.slice(start, end === -1 ? source.length : end);

    assert.match(fn, /proc\.on\("close",\s*\(code\)\s*=>/, "probeAudio should inspect FFmpeg's exit code");
    assert.match(fn, /if \(code !== 0\)[\s\S]*reject\(new Error\(`FFmpeg probe exited with code \$\{code\}/, "probeAudio should reject instead of returning fallback calibration on FFmpeg errors");
});
