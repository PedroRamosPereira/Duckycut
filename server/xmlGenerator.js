/**
 * Duckycut - FCP7 XML Generator (Turbo Mode)
 *
 * FIX: Multi-track audio duplication bug.
 *
 * Root cause: the old generator never inserted <channelcount> into the file
 * declaration, so Premiere assumed 1 audio channel and mapped every audio
 * track to channel 1, duplicating A1 across all tracks.
 *
 * This version:
 *   1. Declares <channelcount> in the master <file> element so Premiere knows
 *      how many source channels the file actually has.
 *   2. Uses proper <links> elements inside every clip item so Premiere can
 *      correlate each video clip with its exact audio counterparts — without
 *      this, Premiere re-resolves the mapping by guessing.
 *   3. Removes the unused audioClipItems loop that was building data that
 *      was never inserted into the XML.
 *   4. Accepts audioChannelCount (from FFmpeg probe) separately from
 *      audioTrackCount (Premiere timeline tracks) so the file declaration
 *      always reflects reality even when both differ.
 */

const fs   = require("fs");
const path = require("path");

/**
 * @param {Object} opts
 * @param {Array<[number,number]>} opts.keepZones
 * @param {string}  opts.mediaPath
 * @param {string}  opts.sequenceName
 * @param {number}  opts.framerate
 * @param {number}  opts.width
 * @param {number}  opts.height
 * @param {number}  opts.audioSampleRate
 * @param {number}  opts.durationSeconds
 * @param {string}  opts.outputPath
 * @param {number}  opts.audioTrackCount   - Number of timeline audio tracks (from Premiere sequence)
 * @param {number}  opts.audioChannelCount - Number of channels in the source file (from FFmpeg probe)
 * @returns {string} outputPath
 */
function generateFCP7XML(opts) {
    const {
        keepZones,
        mediaPath,
        sequenceName,
        framerate,
        width,
        height,
        audioSampleRate,
        durationSeconds,
        outputPath,
        audioTrackCount,
        audioChannelCount,   // ← new: actual file channel count from probe
    } = opts;

    const isNTSC  = [29.97, 23.976, 59.94].some((f) => Math.abs(framerate - f) < 0.05);
    const timebase = Math.round(framerate);
    const ntsc     = isNTSC ? "TRUE" : "FALSE";

    const toFrames = (s) => Math.round(s * framerate);

    const totalKeepFrames = keepZones.reduce((sum, z) => sum + toFrames(z[1] - z[0]), 0);
    const totalMediaFrames = toFrames(durationSeconds);

    const fileName    = path.basename(mediaPath);
    const filePathURL = "file://localhost/" + mediaPath.replace(/\\/g, "/").replace(/^\//, "");

    // How many audio tracks to lay on the timeline
    const numTracks = audioTrackCount || 1;
    // How many channels the SOURCE FILE actually has (for the <file> declaration)
    const numChannels = audioChannelCount || numTracks;

    // ── Build video track clip items ──────────────────────────────
    let videoClipItems = "";
    let timelinePos    = 0;

    for (let i = 0; i < keepZones.length; i++) {
        const [startSec, endSec] = keepZones[i];
        const inFrame   = toFrames(startSec);
        const outFrame  = toFrames(endSec);
        const duration  = outFrame - inFrame;
        const clipStart = timelinePos;
        const clipEnd   = timelinePos + duration;
        const vId       = `clipitem-${i + 1}-v`;

        // <links> — connect this video clip to each audio track's counterpart
        let vLinks = "";
        for (let t = 0; t < numTracks; t++) {
            vLinks += `
                            <link>
                                <linkclipref>clipitem-${i + 1}-a${t + 1}</linkclipref>
                                <mediatype>audio</mediatype>
                                <trackindex>${t + 1}</trackindex>
                                <clipindex>${i + 1}</clipindex>
                            </link>`;
        }

        videoClipItems += `
                        <clipitem id="${vId}">
                            <masterclipid>masterclip-1</masterclipid>
                            <name>${fileName}</name>
                            <enabled>TRUE</enabled>
                            <duration>${totalMediaFrames}</duration>
                            <rate>
                                <timebase>${timebase}</timebase>
                                <ntsc>${ntsc}</ntsc>
                            </rate>
                            <start>${clipStart}</start>
                            <end>${clipEnd}</end>
                            <in>${inFrame}</in>
                            <out>${outFrame}</out>
                            <file id="file-1"/>
                            <links>${vLinks}
                            </links>
                        </clipitem>`;

        timelinePos = clipEnd;
    }

    // ── Build audio tracks ────────────────────────────────────────
    // One <track> per Premiere audio track.
    // Each clip inside a track:
    //   • <sourcetrack><trackindex> = which SOURCE CHANNEL of the file
    //   • <links>                   = references to sibling clips (v + other a tracks)
    let audioTracksXML = "";

    for (let t = 0; t < numTracks; t++) {
        let trackClipItems = "";
        let pos = 0;

        for (let i = 0; i < keepZones.length; i++) {
            const [startSec, endSec] = keepZones[i];
            const inFrame   = toFrames(startSec);
            const outFrame  = toFrames(endSec);
            const duration  = outFrame - inFrame;
            const clipStart = pos;
            const clipEnd   = pos + duration;
            const aId       = `clipitem-${i + 1}-a${t + 1}`;

            // <links> — connect back to video clip + sibling audio clips
            let aLinks = `
                            <link>
                                <linkclipref>clipitem-${i + 1}-v</linkclipref>
                                <mediatype>video</mediatype>
                                <trackindex>1</trackindex>
                                <clipindex>${i + 1}</clipindex>
                            </link>`;
            for (let st = 0; st < numTracks; st++) {
                if (st !== t) {
                    aLinks += `
                            <link>
                                <linkclipref>clipitem-${i + 1}-a${st + 1}</linkclipref>
                                <mediatype>audio</mediatype>
                                <trackindex>${st + 1}</trackindex>
                                <clipindex>${i + 1}</clipindex>
                            </link>`;
                }
            }

            trackClipItems += `
                        <clipitem id="${aId}">
                            <masterclipid>masterclip-1</masterclipid>
                            <name>${fileName}</name>
                            <enabled>TRUE</enabled>
                            <duration>${totalMediaFrames}</duration>
                            <rate>
                                <timebase>${timebase}</timebase>
                                <ntsc>${ntsc}</ntsc>
                            </rate>
                            <start>${clipStart}</start>
                            <end>${clipEnd}</end>
                            <in>${inFrame}</in>
                            <out>${outFrame}</out>
                            <file id="file-1"/>
                            <sourcetrack>
                                <mediatype>audio</mediatype>
                                <trackindex>${t + 1}</trackindex>
                            </sourcetrack>
                            <links>${aLinks}
                            </links>
                        </clipitem>`;

            pos = clipEnd;
        }

        audioTracksXML += `
                    <track>
                        ${trackClipItems}
                        <outputchannelindex>${t + 1}</outputchannelindex>
                    </track>`;
    }

    // ── Build per-channel audio track declarations for <file> ─────
    // Without this, Premiere infers channelcount=1 and maps every track to channel 1.
    let fileAudioChannels = "";
    for (let ch = 1; ch <= numChannels; ch++) {
        fileAudioChannels += `
                    <audio>
                        <channelcount>1</channelcount>
                    </audio>`;
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
    <sequence>
        <name>${escapeXml(sequenceName)} [Duckycut]</name>
        <duration>${totalKeepFrames}</duration>
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
                        <rate>
                            <timebase>${timebase}</timebase>
                            <ntsc>${ntsc}</ntsc>
                        </rate>
                    </samplecharacteristics>
                </format>
                <track>
                    ${videoClipItems}
                </track>
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
            <rate>
                <timebase>${timebase}</timebase>
                <ntsc>${ntsc}</ntsc>
            </rate>
            <string>00:00:00:00</string>
            <frame>0</frame>
            <displayformat>NDF</displayformat>
        </timecode>
    </sequence>

    <clip id="masterclip-1">
        <name>${escapeXml(fileName)}</name>
        <duration>${totalMediaFrames}</duration>
        <rate>
            <timebase>${timebase}</timebase>
            <ntsc>${ntsc}</ntsc>
        </rate>
        <file id="file-1">
            <name>${escapeXml(fileName)}</name>
            <pathurl>${escapeXml(filePathURL)}</pathurl>
            <duration>${totalMediaFrames}</duration>
            <rate>
                <timebase>${timebase}</timebase>
                <ntsc>${ntsc}</ntsc>
            </rate>
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
    </clip>
</xmeml>`;

    fs.writeFileSync(outputPath, xml, "utf-8");
    return outputPath;
}

function escapeXml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

module.exports = { generateFCP7XML };
