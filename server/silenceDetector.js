/**
 * Duckycut - FFmpeg Silence Detector + Audio Probe
 *
 * NEW in this version:
 *   detectSilenceFromSequence(audioTracks, threshold, minDuration)
 *     Accepts the full audio-track structure from getFullSequenceData(),
 *     builds an FFmpeg filter-graph that mixes every clip at its exact
 *     sequence-timeline position, writes a temp WAV, and then runs
 *     silencedetect on that WAV.  All returned timestamps are in
 *     SEQUENCE time — no manual offset calculation needed.
 *
 *   buildMixedAudio(clips, outputPath)
 *     Low-level helper: accepts an array of
 *     { mediaPath, seqStart, seqEnd, srcIn, srcOut }
 *     and produces a mixed WAV using FFmpeg's adelay / atrim.
 */

const { spawn } = require("child_process");
const os        = require("os");
const path      = require("path");
const fs        = require("fs");

// ─────────────────────────────────────────────────────────────────
//  probeAudio
// ─────────────────────────────────────────────────────────────────
function probeAudio(mediaPath) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner", "-vn",
            "-i", mediaPath,
            "-af", "volumedetect",
            "-f", "null", "-",
        ];
        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data",  (d) => (output += d.toString()));
        proc.on("error", (err) => reject(new Error(`FFmpeg probe failed: ${err.message}`)));
        proc.on("close", () => {
            const meanMatch = output.match(/mean_volume:\s*(-?\d+\.?\d*)\s*dB/);
            const maxMatch  = output.match(/max_volume:\s*(-?\d+\.?\d*)\s*dB/);
            const meanVolume = meanMatch ? parseFloat(meanMatch[1]) : -30;
            const maxVolume  = maxMatch  ? parseFloat(maxMatch[1])  : -10;

            let channelCount = 1;
            if      (/\bstereo\b/i.test(output))   channelCount = 2;
            else if (/\b5\.1\b/.test(output))       channelCount = 6;
            else if (/\b7\.1\b/.test(output))       channelCount = 8;
            else {
                const chMatch = output.match(/Audio:.*?(\d+)\s*channels?/i);
                if (chMatch) channelCount = parseInt(chMatch[1], 10);
            }

            const durMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
            let durationSeconds = 0;
            if (durMatch) {
                durationSeconds =
                    parseInt(durMatch[1]) * 3600 +
                    parseInt(durMatch[2]) * 60   +
                    parseInt(durMatch[3])         +
                    parseInt(durMatch[4]) / 100;
            }
            resolve({ meanVolume, maxVolume, channelCount, durationSeconds });
        });
    });
}

// ─────────────────────────────────────────────────────────────────
//  detectSilence  (original single-file version — kept for probe fallback)
// ─────────────────────────────────────────────────────────────────
function detectSilence(mediaPath, thresholdDb, minDuration) {
    return new Promise((resolve, reject) => {
        const args = [
            "-hide_banner", "-vn",
            "-i", mediaPath,
            "-af", `silencedetect=n=${thresholdDb}dB:d=${minDuration}`,
            "-f", "null", "-",
        ];
        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        proc.stdout.on("data", (d) => (output += d.toString()));
        proc.stderr.on("data",  (d) => (output += d.toString()));
        proc.on("error", (err) =>
            reject(new Error(`FFmpeg not found or failed to start: ${err.message}`))
        );
        proc.on("close", (code) => {
            if (code !== 0) {
                reject(new Error(`FFmpeg exited with code ${code}. Output: ${output.slice(-200)}`));
                return;
            }
            const silenceIntervals = parseSilenceOutput(output);
            const durationMatch = output.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
            let mediaDuration = 0;
            if (durationMatch) {
                mediaDuration =
                    parseInt(durationMatch[1]) * 3600 +
                    parseInt(durationMatch[2]) * 60   +
                    parseInt(durationMatch[3])         +
                    parseInt(durationMatch[4]) / 100;
            }
            let totalSilenceDuration = 0;
            for (const iv of silenceIntervals) totalSilenceDuration += iv[1] - iv[0];
            resolve({
                silenceIntervals,
                silenceCount:         silenceIntervals.length,
                totalSilenceDuration: Math.round(totalSilenceDuration * 100) / 100,
                mediaDuration:        Math.round(mediaDuration         * 100) / 100,
                timeSaved:            formatTime(totalSilenceDuration),
            });
        });
    });
}

// ─────────────────────────────────────────────────────────────────
//  buildMixedAudio  ← NEW
//
//  clips: [{ mediaPath, seqStart, seqEnd, srcIn, srcOut }]
//
//  For each clip, FFmpeg:
//    • trims the source to [srcIn, srcOut]
//    • resets timestamps to 0
//    • delays the stream by seqStart ms (places it at sequence position)
//  Then amix joins everything into one flat WAV.
//
//  Result: a WAV whose timeline matches the Premiere sequence timeline.
//  Silence detection on this WAV returns SEQUENCE-TIME intervals.
// ─────────────────────────────────────────────────────────────────
function buildMixedAudio(clips, outputPath) {
    return new Promise((resolve, reject) => {
        if (!clips || clips.length === 0) {
            return reject(new Error("buildMixedAudio: no clips provided"));
        }

        // Deduplicate input files (ffmpeg needs one -i per unique file)
        const uniquePaths = [];
        const pathToIdx   = {};
        for (const c of clips) {
            if (c.mediaPath && !(c.mediaPath in pathToIdx)) {
                pathToIdx[c.mediaPath] = uniquePaths.length;
                uniquePaths.push(c.mediaPath);
            }
        }

        const args = ["-hide_banner"];
        for (const p of uniquePaths) args.push("-i", p);

        const filterParts = [];
        const outLabels   = [];

        clips.forEach((clip, i) => {
            const idx       = pathToIdx[clip.mediaPath];
            const delayMs   = Math.max(0, Math.round(clip.seqStart * 1000));
            const trimStart = (typeof clip.srcIn  === "number") ? clip.srcIn  : 0;
            const trimEnd   = (typeof clip.srcOut === "number" && clip.srcOut > trimStart)
                                ? clip.srcOut
                                : trimStart + (clip.seqEnd - clip.seqStart);
            const label     = `dc${i}`;

            filterParts.push(
                `[${idx}:a]` +
                `atrim=start=${trimStart}:end=${trimEnd},` +
                `asetpts=PTS-STARTPTS,` +
                `adelay=${delayMs}|${delayMs}` +
                `[${label}]`
            );
            outLabels.push(`[${label}]`);
        });

        let filterComplex;
        if (clips.length === 1) {
            // Single clip: skip amix, just rename the label to "out"
            filterComplex = filterParts[0].replace(/\[dc0\]$/, "[out]");
        } else {
            filterParts.push(
                outLabels.join("") +
                `amix=inputs=${clips.length}:duration=longest:normalize=0[out]`
            );
            filterComplex = filterParts.join(";");
        }

        args.push(
            "-filter_complex", filterComplex,
            "-map", "[out]",
            "-y", outputPath
        );

        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        proc.stderr.on("data", (d) => (stderr += d.toString()));
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code === 0) return resolve(outputPath);
            reject(new Error(
                `FFmpeg mix failed (code ${code}):\n${stderr.slice(-500)}`
            ));
        });
    });
}

// ─────────────────────────────────────────────────────────────────
//  detectSilenceFromSequence  ← NEW
//
//  audioTracks: the audioTracks array from getFullSequenceData()
//
//  Builds a single mixed WAV that represents the Premiere sequence
//  audio mix, then runs silencedetect on it.  All timestamps in the
//  returned silenceIntervals are in SEQUENCE time, so they can be
//  applied directly to the timeline without any offset.
//
//  Falls back to single-file detectSilence() if building the mix
//  fails for any reason (e.g., clips with missing mediaPath).
// ─────────────────────────────────────────────────────────────────
async function detectSilenceFromSequence(audioTracks, threshold, minDuration) {
    // Collect valid clips from all provided tracks
    const clips = [];
    for (const track of audioTracks) {
        for (const clip of (track.clips || [])) {
            if (clip.mediaPath && clip.seqEnd > clip.seqStart) {
                clips.push({
                    mediaPath: clip.mediaPath,
                    seqStart:  clip.seqStart,
                    seqEnd:    clip.seqEnd,
                    srcIn:     typeof clip.srcIn  === "number" ? clip.srcIn  : 0,
                    srcOut:    typeof clip.srcOut === "number" && clip.srcOut > clip.srcIn
                                   ? clip.srcOut
                                   : clip.srcIn + (clip.seqEnd - clip.seqStart),
                });
            }
        }
    }

    if (clips.length === 0) {
        throw new Error("No audio clips with media paths found in the selected tracks");
    }

    const seqDuration = Math.max(...clips.map((c) => c.seqEnd));
    const tempWav = path.join(os.tmpdir(), `duckycut_mix_${Date.now()}.wav`);

    try {
        await buildMixedAudio(clips, tempWav);
        const result = await detectSilence(tempWav, threshold, minDuration);

        // Replace mediaDuration with actual sequence duration
        return {
            ...result,
            mediaDuration: Math.round(seqDuration * 100) / 100,
        };
    } finally {
        try { fs.unlinkSync(tempWav); } catch (_) {}
    }
}

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────
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

module.exports = { detectSilence, probeAudio, detectSilenceFromSequence, buildMixedAudio };
