/**
 * Duckycut - FCP7 XML Generator (Turbo Mode)
 * Generates a Final Cut Pro 7 XML file that Premiere Pro can import natively.
 * Instead of making razor cuts via ExtendScript (O(N^2) and freezes Premiere),
 * we build a complete timeline description as XML and import it in one shot.
 */

const fs = require("fs");
const path = require("path");

/**
 * Generates the FCP7 XML file with all keep zones as clip items.
 * @param {Object} opts
 * @param {Array<[number,number]>} opts.keepZones - Array of [start, end] in seconds.
 * @param {string} opts.mediaPath - Absolute path to the source media file.
 * @param {string} opts.sequenceName - Name for the new sequence.
 * @param {number} opts.framerate - Timeline framerate (e.g., 29.97).
 * @param {number} opts.width - Video width.
 * @param {number} opts.height - Video height.
 * @param {number} opts.audioSampleRate - Audio sample rate.
 * @param {number} opts.durationSeconds - Total media duration in seconds.
 * @param {string} opts.outputPath - Where to save the XML file.
 * @param {number} opts.audioTrackCount - Number of audio tracks.
 * @returns {string} The path to the generated XML file.
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
    } = opts;

    // Calculate framerate as ntsc or not
    const isNTSC = [29.97, 23.976, 59.94].some(
        (f) => Math.abs(framerate - f) < 0.05
    );
    const timebase = Math.round(framerate);
    const ntsc = isNTSC ? "TRUE" : "FALSE";

    // Convert seconds to frames
    const toFrames = (seconds) => Math.round(seconds * framerate);

    // Total duration of the new sequence (sum of all keep zones)
    const totalKeepFrames = keepZones.reduce(
        (sum, z) => sum + toFrames(z[1] - z[0]),
        0
    );
    const totalMediaFrames = toFrames(durationSeconds);

    // File reference info
    const fileName = path.basename(mediaPath);
    const filePathURL = "file://localhost/" + mediaPath.replace(/\\/g, "/").replace(/^\//, "");

    // Build video clip items
    let videoClipItems = "";
    let audioClipItems = "";
    let timelinePosition = 0;

    for (let i = 0; i < keepZones.length; i++) {
        const [startSec, endSec] = keepZones[i];
        const inFrame = toFrames(startSec);
        const outFrame = toFrames(endSec);
        const duration = outFrame - inFrame;
        const clipStart = timelinePosition;
        const clipEnd = timelinePosition + duration;
        const clipId = `clipitem-${i + 1}`;
        const masterClipId = "masterclip-1";

        videoClipItems += `
                        <clipitem id="${clipId}-v">
                            <masterclipid>${masterClipId}</masterclipid>
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
                        </clipitem>`;

        // Create audio clip items for each audio track
        for (let t = 0; t < audioTrackCount; t++) {
            audioClipItems += `
                        <clipitem id="${clipId}-a${t + 1}">
                            <masterclipid>${masterClipId}</masterclipid>
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
                        </clipitem>`;
        }

        timelinePosition = clipEnd;
    }

    // Build audio tracks XML
    let audioTracksXML = "";
    for (let t = 0; t < audioTrackCount; t++) {
        // For simplicity, all audio tracks get the same clip items
        // In a real scenario, you might filter by track
        let trackClips = "";
        let pos = 0;
        for (let i = 0; i < keepZones.length; i++) {
            const [startSec, endSec] = keepZones[i];
            const inFrame = toFrames(startSec);
            const outFrame = toFrames(endSec);
            const duration = outFrame - inFrame;
            const clipStart = pos;
            const clipEnd = pos + duration;

            trackClips += `
                        <clipitem id="clipitem-${i + 1}-a${t + 1}-t">
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
                        </clipitem>`;
            pos = clipEnd;
        }

        audioTracksXML += `
                    <track>
                        ${trackClips}
                        <outputchannelindex>${t + 1}</outputchannelindex>
                    </track>`;
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
                    </samplecharacteristics>
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
