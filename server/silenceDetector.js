/**
 * Duckycut - FFmpeg Silence Detector + Audio Probe
 */

const { spawn } = require("child_process");

/**
 * Probes audio file to get volume stats and channel count.
 * Used for auto-calibrating the aggressiveness threshold.
 *
 * @param {string} mediaPath
 * @returns {Promise<{meanVolume, maxVolume, channelCount, durationSeconds}>}
 */
function probeAudio(mediaPath) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-vn",
            "-i", mediaPath,
            "-af", "volumedetect",
            "-f", "null",
            "-",
        ];

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";

        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data",  (d) => (output += d.toString()));

        proc.on("error", (err) =>
            reject(new Error(`FFmpeg probe failed: ${err.message}`))
        );

        proc.on("close", () => {
            // Volume
            const meanMatch = output.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);
            const maxMatch  = output.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
            const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -30;
            const maxVolume  = maxMatch  ? parseFloat(maxMatch[1])  : -10;

            // Channel count — look for "stereo", "mono", or "N channels"
            let channelCount = 1;
            if (/\bstereo\b/i.test(output))               channelCount = 2;
            else if (/\b5\.1\b/.test(output))             channelCount = 6;
            else if (/\b7\.1\b/.test(output))             channelCount = 8;
            else {
                const chMatch = output.match(/Audio:.*?(\d+)\s*channels?/i);
                if (chMatch) channelCount = parseInt(chMatch[1], 10);
            }

            // Duration
            const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
            let durationSeconds = 0;
            if (durMatch) {
                durationSeconds =
                    parseInt(durMatch[1]) * 3600 +
                    parseInt(durMatch[2]) * 60  +
                    parseInt(durMatch[3])        +
                    parseInt(durMatch[4]) / 100;
            }

            resolve({ meanVolume, maxVolume, channelCount, durationSeconds });
        });
    });
}

/**
 * Runs FFmpeg silencedetect and returns silence intervals.
 *
 * @param {string} mediaPath
 * @param {number} thresholdDb  - e.g. -30
 * @param {number} minDuration  - minimum silence seconds, e.g. 0.75
 * @returns {Promise<{silenceIntervals, silenceCount, totalSilenceDuration, mediaDuration, timeSaved}>}
 */
function detectSilence(mediaPath, thresholdDb, minDuration) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner",
            "-vn",
            "-i", mediaPath,
            "-af", `silencedetect=n=${thresholdDb}dB:d=${minDuration}`,
            "-f", "null",
            "-",
        ];

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";

        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data",  (d) => (output += d.toString()));

        proc.on("error", (err) =>
            reject(new Error(`FFmpeg not found or failed to start: ${err.message}`))
        );

        proc.on("close", (code) => {
            if (code !== 0 && !output.includes("silence_start")) {
                reject(new Error(`FFmpeg exited with code ${code}`));
                return;
            }

            const silenceIntervals = parseSilenceOutput(output);

            const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
            let mediaDuration = 0;
            if (durationMatch) {
                mediaDuration =
                    parseInt(durationMatch[1]) * 3600 +
                    parseInt(durationMatch[2]) * 60  +
                    parseInt(durationMatch[3])        +
                    parseInt(durationMatch[4]) / 100;
            }

            let totalSilenceDuration = 0;
            for (const iv of silenceIntervals) {
                totalSilenceDuration += iv[1] - iv[0];
            }

            resolve({
                silenceIntervals,
                silenceCount:          silenceIntervals.length,
                totalSilenceDuration:  Math.round(totalSilenceDuration * 100) / 100,
                mediaDuration:         Math.round(mediaDuration * 100) / 100,
                timeSaved:             formatTime(totalSilenceDuration),
            });
        });
    });
}

function parseSilenceOutput(output) {
    const starts = [];
    const ends   = [];
    const startRe = /silence_start:\s*(-?\d+\.?\d*)/g;
    const endRe   = /silence_end:\s*(-?\d+\.?\d*)/g;
    let m;
    while ((m = startRe.exec(output)) !== null) starts.push(parseFloat(m[1]));
    while ((m = endRe.exec(output))   !== null) ends.push(parseFloat(m[1]));

    const intervals = [];
    for (let i = 0; i < starts.length; i++) {
        const end = i < ends.length ? ends[i] : starts[i] + 1;
        intervals.push([starts[i], end]);
    }
    return intervals;
}

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

module.exports = { detectSilence, probeAudio };
