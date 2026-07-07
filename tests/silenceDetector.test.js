const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const path = require("node:path");

const { parseFfmpegDuration, probeAudioFromSequence, parseSilenceOutput, formatTime } = require("../server/silenceDetector.js");

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

test("probeAudioFromSequence remains available for selected-track diagnostics", () => {
    assert.equal(typeof probeAudioFromSequence, "function");
});

test("parseSilenceOutput closes a trailing unterminated silence at media duration", () => {
    const output = "silence_start: 50.5\n";

    assert.deepEqual(parseSilenceOutput(output, 60), [[50.5, 60]]);
});

test("parseSilenceOutput keeps the one-second fallback when duration is unknown", () => {
    assert.deepEqual(parseSilenceOutput("silence_start: 50.5\n", 0), [[50.5, 51.5]]);
});

test("parseSilenceOutput still pairs matched start/end markers", () => {
    const output = "silence_start: 1.25\nsilence_end: 2.5 | silence_duration: 1.25\n";

    assert.deepEqual(parseSilenceOutput(output, 60), [[1.25, 2.5]]);
});

test("formatTime rounds 119.6s to 2m 0s, never 1m 60s", () => {
    assert.equal(formatTime(119.6), "2m 0s");
    assert.equal(formatTime(59.6), "1m 0s");
    assert.equal(formatTime(59.4), "0m 59s");
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
