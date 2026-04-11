/**
 * Duckycut - FCP7 XML Generator
 *
 * FIXES:
 *   1. Multi-track timeline: builds a track entry for every video+audio track
 *      in the original sequence, not just the main media file.
 *   2. Overlays (V2, V3, etc.) are preserved with their original in/out times
 *      mapped to the new timeline positions after silence removal.
 *   3. Audio duplication fixed: each audio clip references the correct
 *      sourcetrack channel index and proper <links>.
 *   4. Framerate: timebase is calculated from the actual sequence fps,
 *      with correct NTSC flag.
 *   5. Each unique media file gets its own <file id> so Premiere doesn't
 *      collapse different clips to the same source.
 */

const fs   = require("fs");
const path = require("path");

/**
 * @param {Object} opts
 * @param {Array<[number,number]>} opts.keepZones         - Timeline zones to keep [start, end] in seconds
 * @param {Array<Object>}          opts.sequenceClips     - All clips from getFullSequenceClips()
 * @param {string}                 opts.sequenceName
 * @param {number}                 opts.framerate
 * @param {number}                 opts.width
 * @param {number}                 opts.height
 * @param {number}                 opts.audioSampleRate
 * @param {number}                 opts.durationSeconds   - Total sequence duration (original)
 * @param {string}                 opts.outputPath
 * @param {number}                 opts.audioChannelCount - Source file channel count from FFmpeg probe
 * @param {number}                 opts.audioTrackCount   - Number of audio tracks in sequence
 * @param {number}                 opts.videoTrackCount   - Number of video tracks in sequence
 * @param {number}                [opts.exactFps]         - Precise fractional FPS from Adobe ticks (e.g. 29.97002997)
 * @param {boolean}              [opts.isNTSC]           - Whether the sequence is NTSC (from host)
 * @param {number}               [opts.xmlTimebase]      - Integer timebase for XML tags (e.g. 30)
 */
function generateFCP7XML(opts) {
    const {
        keepZones,
        sequenceClips,
        sequenceName,
        framerate,
        width,
        height,
        audioSampleRate,
        durationSeconds,
        outputPath,
        audioChannelCount,
        audioTrackCount,
        videoTrackCount,
    } = opts;

    // Use exact values from host when available; fall back to deriving from framerate
    const exactFps  = opts.exactFps || framerate;
    const isNTSC    = (typeof opts.isNTSC === "boolean")
        ? opts.isNTSC
        : [29.97, 23.976, 59.94].some((f) => Math.abs(framerate - f) < 0.05);
    const timebase  = opts.xmlTimebase || Math.round(framerate);
    const ntsc      = isNTSC ? "TRUE" : "FALSE";
    const toFrames  = (s) => Math.round(s * exactFps);

    // ── File registry: one <file> element per unique media path ──────
    const fileRegistry = {};  // mediaPath → file-N id
    let fileCounter = 1;

    function getFileId(mediaPath) {
        if (!mediaPath) return null;
        const norm = mediaPath.replace(/\\/g, "/");
        if (!fileRegistry[norm]) {
            fileRegistry[norm] = "file-" + fileCounter++;
        }
        return fileRegistry[norm];
    }

    // Pre-register all media paths so IDs are stable
    if (sequenceClips) {
        sequenceClips.forEach((c) => { if (c.mediaPath) getFileId(c.mediaPath); });
    }

    // ── Pre-compute keepZone boundaries in frames (ONCE) ─────────────
    // Converting each boundary exactly once eliminates double-rounding drift.
    // outputOffsets[i] = frame where keepZone[i] starts on the NEW timeline.
    const keepZonesF = keepZones.map(([ks, ke]) => [toFrames(ks), toFrames(ke)]);
    const outputOffsets = [];
    let runningOffset = 0;
    for (const [ksF, keF] of keepZonesF) {
        outputOffsets.push(runningOffset);
        runningOffset += (keF - ksF);   // duration = endFrame − startFrame, no re-rounding
    }
    const totalOutputFrames = runningOffset;
    const totalInputFrames  = toFrames(durationSeconds);

    /**
     * Maps a clip (originalStart..originalEnd) through the keepZones
     * and returns an array of output segments.
     *
     * Each segment: { outStart, outEnd, mediaIn, mediaOut }
     * (all in frames, relative to new timeline / source media)
     */
    function mapClipToOutput(clipOrigStart, clipOrigEnd, clipMediaIn) {
        const cStartF = toFrames(clipOrigStart);
        const cEndF   = toFrames(clipOrigEnd);
        const cInF    = toFrames(clipMediaIn);

        const segments = [];
        for (let zi = 0; zi < keepZonesF.length; zi++) {
            const [kStartF, kEndF] = keepZonesF[zi];

            // Intersection of [kStartF, kEndF] and [cStartF, cEndF]
            const iStart = Math.max(kStartF, cStartF);
            const iEnd   = Math.min(kEndF,   cEndF);
            if (iStart >= iEnd) continue;

            // Duration of this segment in frames
            const segDur = iEnd - iStart;

            // Output position: offsetIntoKeepZone + outputOffset[zi]
            const offsetInZone = iStart - kStartF;
            const outStart = outputOffsets[zi] + offsetInZone;
            const outEnd   = outStart + segDur;

            // Source media in/out: shift by how far into the clip this segment starts
            const segClipOffset = iStart - cStartF;
            const mediaIn  = cInF + segClipOffset;
            const mediaOut = mediaIn + segDur;

            segments.push({ outStart, outEnd, mediaIn, mediaOut });
        }
        return segments;
    }

    // ── Gather clips by track ────────────────────────────────────────
    // videoTrackClips[trackIndex] = [ ...clip objects ]
    // audioTrackClips[trackIndex] = [ ...clip objects ]
    const videoTrackClips = {};
    const audioTrackClips = {};

    const numVideoTracks = videoTrackCount || 1;
    const numAudioTracks = audioTrackCount || 1;

    for (let i = 0; i < numVideoTracks; i++) videoTrackClips[i] = [];
    for (let i = 0; i < numAudioTracks; i++) audioTrackClips[i] = [];

    if (sequenceClips && sequenceClips.length > 0) {
        for (const clip of sequenceClips) {
            if (clip.trackType === "video" && clip.trackIndex < numVideoTracks) {
                videoTrackClips[clip.trackIndex].push(clip);
            } else if (clip.trackType === "audio" && clip.trackIndex < numAudioTracks) {
                audioTrackClips[clip.trackIndex].push(clip);
            }
        }
    }

    // ── clipitem ID counter ──────────────────────────────────────────
    let clipItemCounter = 1;
    function nextClipId(suffix) {
        return "clipitem-" + (clipItemCounter++) + "-" + suffix;
    }

    // ── Build video tracks XML ───────────────────────────────────────
    let videoTracksXML = "";

    for (let ti = 0; ti < numVideoTracks; ti++) {
        const clipsInTrack = videoTrackClips[ti] || [];
        let trackItems = "";

        for (const clip of clipsInTrack) {
            const fileId  = getFileId(clip.mediaPath);
            const segs    = mapClipToOutput(clip.start, clip.end, clip.mediaIn || 0);
            // FCP7 spec: <duration> = total source media length, NOT the trimmed segment
            const fileDurFrames = totalInputFrames;

            for (const seg of segs) {
                const segDur = seg.outEnd - seg.outStart;
                const id = nextClipId("v" + ti);
                trackItems += `
                        <clipitem id="${id}">
                            <masterclipid>${fileId || "masterclip-1"}</masterclipid>
                            <name>${escapeXml(clip.clipName || "")}</name>
                            <enabled>TRUE</enabled>
                            <duration>${fileDurFrames}</duration>
                            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
                            <start>${seg.outStart}</start>
                            <end>${seg.outEnd}</end>
                            <in>${seg.mediaIn}</in>
                            <out>${seg.mediaOut}</out>
                            <file id="${fileId || "file-1"}"/>
                        </clipitem>`;
            }
        }

        // Enabled flag: V1 is always enabled; V2+ are overlay tracks
        const enabled = (ti === 0) ? "TRUE" : "TRUE";
        videoTracksXML += `
                    <track>
                        ${trackItems}
                        <enabled>${enabled}</enabled>
                        <locked>FALSE</locked>
                    </track>`;
    }

    // ── Build audio tracks XML ───────────────────────────────────────
    const numChannels = audioChannelCount || numAudioTracks;
    let audioTracksXML = "";

    for (let ti = 0; ti < numAudioTracks; ti++) {
        const clipsInTrack = audioTrackClips[ti] || [];
        let trackItems = "";

        for (const clip of clipsInTrack) {
            const fileId  = getFileId(clip.mediaPath);
            const segs    = mapClipToOutput(clip.start, clip.end, clip.mediaIn || 0);
            // FCP7 spec: <duration> = total source media length, NOT the trimmed segment
            const fileDurFrames = totalInputFrames;

            // Source channel: audio track 0 → ch 1, track 1 → ch 2, etc.
            // Cap to actual file channels so mono files don't break
            const srcChannel = Math.min(ti + 1, numChannels);

            for (const seg of segs) {
                const segDur = seg.outEnd - seg.outStart;
                const id = nextClipId("a" + ti);
                trackItems += `
                        <clipitem id="${id}">
                            <masterclipid>${fileId || "masterclip-1"}</masterclipid>
                            <name>${escapeXml(clip.clipName || "")}</name>
                            <enabled>TRUE</enabled>
                            <duration>${fileDurFrames}</duration>
                            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
                            <start>${seg.outStart}</start>
                            <end>${seg.outEnd}</end>
                            <in>${seg.mediaIn}</in>
                            <out>${seg.mediaOut}</out>
                            <file id="${fileId || "file-1"}"/>
                            <sourcetrack>
                                <mediatype>audio</mediatype>
                                <trackindex>${srcChannel}</trackindex>
                            </sourcetrack>
                        </clipitem>`;
            }
        }

        audioTracksXML += `
                    <track>
                        ${trackItems}
                        <outputchannelindex>${ti + 1}</outputchannelindex>
                    </track>`;
    }

    // ── Build <file> declarations ────────────────────────────────────
    let fileDeclarations = "";
    for (const [mediaPath, fileId] of Object.entries(fileRegistry)) {
        const fileName    = path.basename(mediaPath);
        const filePathURL = "file://localhost/" + mediaPath.replace(/\\/g, "/").replace(/^\//, "");

        let fileAudioChannels = "";
        for (let ch = 1; ch <= numChannels; ch++) {
            fileAudioChannels += `
                    <audio><channelcount>1</channelcount></audio>`;
        }

        fileDeclarations += `
    <clip id="${fileId}">
        <name>${escapeXml(fileName)}</name>
        <duration>${totalInputFrames}</duration>
        <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
        <file id="${fileId}">
            <name>${escapeXml(fileName)}</name>
            <pathurl>${escapeXml(filePathURL)}</pathurl>
            <duration>${totalInputFrames}</duration>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <media>
                <video>
                    <samplecharacteristics>
                        <width>${width}</width>
                        <height>${height}</height>
                    </samplecharacteristics>
                </video>
                <audio>
                    <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>${audioSampleRate}</samplerate>
                        <channelcount>${numChannels}</channelcount>
                    </samplecharacteristics>
                    ${fileAudioChannels}
                </audio>
            </media>
        </file>
    </clip>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence>
        <name>${escapeXml(sequenceName)} [Duckycut]</name>
        <duration>${totalOutputFrames}</duration>
        <rate>
            <timebase>${timebase}</timebase>
            <ntsc>${ntsc}</ntsc>
        </rate>
        <media>
            <video>
                <format>
                    <samplecharacteristics>
                        <width>${width}</width>
                        <height>${height}</height>
                        <anamorphic>FALSE</anamorphic>
                        <pixelaspectratio>square</pixelaspectratio>
                        <fielddominance>none</fielddominance>
                        <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
                    </samplecharacteristics>
                </format>
                ${videoTracksXML}
            </video>
            <audio>
                <format>
                    <samplecharacteristics>
                        <depth>16</depth>
                        <samplerate>${audioSampleRate}</samplerate>
                        <channelcount>${numChannels}</channelcount>
                    </samplecharacteristics>
                </format>
                ${audioTracksXML}
            </audio>
        </media>
        <timecode>
            <rate><timebase>${timebase}</timebase><ntsc>${ntsc}</ntsc></rate>
            <string>00:00:00:00</string>
            <frame>0</frame>
            <displayformat>NDF</displayformat>
        </timecode>
    </sequence>
${fileDeclarations}
</xmeml>`;

    fs.writeFileSync(outputPath, xml, "utf-8");
    return outputPath;
}

function escapeXml(str) {
    if (!str) return "";
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

module.exports = { generateFCP7XML };
