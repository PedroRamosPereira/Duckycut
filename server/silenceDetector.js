/**
 * Duckycut - FFmpeg Silence Detector
 * Uses FFmpeg's silencedetect filter to find silence regions in media files.
 */

const { spawn } = require("child_process");

/**
 * Runs FFmpeg silencedetect and returns silence intervals + keep zones.
 * @param {string} mediaPath - Path to the media file.
 * @param {number} thresholdDb - Silence threshold in dB (e.g., -30).
 * @param {number} minDuration - Minimum silence duration in seconds (e.g., 0.75).
 * @returns {Promise<Object>} { silenceIntervals, totalSilenceDuration, mediaDuration }
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

        proc.stdout.on("data", (data) => (output += data.toString()));
        proc.stderr.on("data", (data) => (output += data.toString()));

        proc.on("error", (err) => {
            reject(new Error(`FFmpeg not found or failed to start: ${err.message}`));
        });

        proc.on("close", (code) => {
            if (code !== 0 && !output.includes("silence_start")) {
                reject(new Error(`FFmpeg exited with code ${code}`));
                return;
            }

            // Parse silence intervals from FFmpeg output
            const silenceIntervals = parseSilenceOutput(output);

            // Get media duration from FFmpeg output
            const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
            let mediaDuration = 0;
            if (durationMatch) {
                mediaDuration =
                    parseInt(durationMatch[1]) * 3600 +
                    parseInt(durationMatch[2]) * 60 +
                    parseInt(durationMatch[3]) +
                    parseInt(durationMatch[4]) / 100;
            }

            // Calculate total silence duration
            let totalSilenceDuration = 0;
            for (const interval of silenceIntervals) {
                totalSilenceDuration += interval[1] - interval[0];
            }

            resolve({
                silenceIntervals,
                silenceCount: silenceIntervals.length,
                totalSilenceDuration: Math.round(totalSilenceDuration * 100) / 100,
                mediaDuration: Math.round(mediaDuration * 100) / 100,
                timeSaved: formatTime(totalSilenceDuration),
            });
        });
    });
}

/**
 * Parses FFmpeg silencedetect output into an array of [start, end] intervals.
 */
function parseSilenceOutput(output) {
    const starts = [];
    const ends = [];

    const startRegex = /silence_start:\s*(-?\d+\.?\d*)/g;
    const endRegex = /silence_end:\s*(-?\d+\.?\d*)/g;

    let match;
    while ((match = startRegex.exec(output)) !== null) {
        starts.push(parseFloat(match[1]));
    }
    while ((match = endRegex.exec(output)) !== null) {
        ends.push(parseFloat(match[1]));
    }

    const intervals = [];
    for (let i = 0; i < starts.length; i++) {
        const end = i < ends.length ? ends[i] : starts[i] + 1;
        intervals.push([starts[i], end]);
    }

    return intervals;
}

/**
 * Formats seconds into mm:ss string.
 */
function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
}

module.exports = { detectSilence };
