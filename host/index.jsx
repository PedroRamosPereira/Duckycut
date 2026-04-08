/**
 * Duckycut - ExtendScript Host (Premiere Pro)
 *
 * IMPORTANT: ExtendScript is NOT modern JavaScript.
 *   - No template literals, no let/const, no arrow functions.
 *   - Time objects need .ticks or .seconds to extract values.
 *   - JSON.stringify can crash on Adobe internal objects.
 *   - Always wrap in try/catch — a silent error = no return = panel gets "undefined".
 */

// ── Polyfill JSON if not available ──
if (typeof JSON === "undefined") {
    JSON = {};
    JSON.stringify = function (obj) {
        if (obj === null) return "null";
        if (typeof obj === "string") return '"' + obj.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
        if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
        if (obj instanceof Array) {
            var items = [];
            for (var i = 0; i < obj.length; i++) items.push(JSON.stringify(obj[i]));
            return "[" + items.join(",") + "]";
        }
        if (typeof obj === "object") {
            var pairs = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    pairs.push('"' + k + '":' + JSON.stringify(obj[k]));
                }
            }
            return "{" + pairs.join(",") + "}";
        }
        return '""';
    };
}

var TICKS = 254016000000;

function ticksToSeconds(t) {
    try { return Number(t) / TICKS; } catch(e) { return 0; }
}

/**
 * Returns info about the active sequence: name, audio tracks, video tracks, duration.
 */
function getActiveSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        var seqName = seq.name || "Untitled";
        var seqId   = "";
        try { seqId = seq.sequenceID; } catch (e) {}

        var durationSeconds = 0;
        try { durationSeconds = seq.end.seconds; }
        catch (e1) {
            try { durationSeconds = ticksToSeconds(seq.end.ticks); } catch (e2) {}
        }

        // ── Framerate (robust) ──────────────────────────────────────
        var fps = 29.97;
        try {
            var tbTicks = Number(seq.timebase);
            if (tbTicks > 0) fps = TICKS / tbTicks;
        } catch (e) {}

        // ── Audio tracks ────────────────────────────────────────────
        var audioTracks = [];
        try {
            var numA = seq.audioTracks.numTracks;
            for (var i = 0; i < numA; i++) {
                var at = seq.audioTracks[i];
                var atName = "Audio " + (i + 1);
                try { atName = at.name || atName; } catch (e) {}
                var atClips = 0;
                try { atClips = at.clips.numItems; } catch (e) {}
                var muted = false;
                try { muted = at.isMuted(); } catch (e) {}
                audioTracks.push({ index: i, name: atName, clipCount: atClips, muted: muted });
            }
        } catch (e) {}

        // ── Video tracks ────────────────────────────────────────────
        var videoTracks = [];
        try {
            var numV = seq.videoTracks.numTracks;
            for (var vi = 0; vi < numV; vi++) {
                var vt = seq.videoTracks[vi];
                var vtName = "Video " + (vi + 1);
                try { vtName = vt.name || vtName; } catch (e) {}
                var vtClips = 0;
                try { vtClips = vt.clips.numItems; } catch (e) {}
                videoTracks.push({ index: vi, name: vtName, clipCount: vtClips });
            }
        } catch (e) {}

        return JSON.stringify({
            name:            seqName,
            sequenceID:      seqId,
            framerate:       fps,
            durationSeconds: durationSeconds,
            audioTracks:     audioTracks,
            videoTracks:     videoTracks
        });
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets the file path of the first clip in a given audio track.
 */
function getAudioTrackMediaPath(trackIndex) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        var idx = parseInt(trackIndex, 10);
        if (isNaN(idx)) idx = 0;

        var track = seq.audioTracks[idx];
        if (!track) return '{"error":"Track ' + idx + ' not found"}';

        var numClips = 0;
        try { numClips = track.clips.numItems; } catch (e) {}

        if (numClips > 0) {
            var clip = track.clips[0];
            if (clip && clip.projectItem) {
                var mPath = clip.projectItem.getMediaPath();
                if (mPath) return '{"path":"' + mPath.replace(/\\/g, "/") + '"}';
            }
        }

        // Fallback: try video track
        try {
            var vTrack = seq.videoTracks[0];
            if (vTrack && vTrack.clips.numItems > 0) {
                var vClip = vTrack.clips[0];
                if (vClip.projectItem) {
                    var vPath = vClip.projectItem.getMediaPath();
                    if (vPath) return '{"path":"' + vPath.replace(/\\/g, "/") + '"}';
                }
            }
        } catch (e) {}

        return '{"error":"Track has no clips"}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Reads ALL clips from ALL video and audio tracks in the sequence.
 * Returns an array of clip descriptors to reconstruct the timeline in XML.
 */
function getFullSequenceClips() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        var clips = [];

        // Video tracks
        try {
            for (var v = 0; v < seq.videoTracks.numTracks; v++) {
                var vt = seq.videoTracks[v];
                var numVClips = 0;
                try { numVClips = vt.clips.numItems; } catch (e) { continue; }
                for (var vc = 0; vc < numVClips; vc++) {
                    try {
                        var vClip = vt.clips[vc];
                        var pi = vClip.projectItem;
                        if (!pi) continue;
                        var mPath = "";
                        try { mPath = pi.getMediaPath() || ""; } catch(e) {}
                        var startSec = 0, endSec = 0, inSec = 0, outSec = 0;
                        try { startSec = vClip.start.seconds; } catch (e) {}
                        try { endSec   = vClip.end.seconds;   } catch (e) {}
                        try { inSec    = vClip.inPoint.seconds;  } catch (e) {}
                        try { outSec   = vClip.outPoint.seconds; } catch (e) {}
                        clips.push({
                            trackType:  "video",
                            trackIndex: v,
                            clipIndex:  vc,
                            clipName:   vClip.name || "",
                            mediaPath:  mPath.replace(/\\/g, "/"),
                            start:      startSec,
                            end:        endSec,
                            mediaIn:    inSec,
                            mediaOut:   outSec,
                            isOverlay:  (v > 0)
                        });
                    } catch (e) { continue; }
                }
            }
        } catch (e) {}

        // Audio tracks
        try {
            for (var a = 0; a < seq.audioTracks.numTracks; a++) {
                var at = seq.audioTracks[a];
                var numAClips = 0;
                try { numAClips = at.clips.numItems; } catch (e) { continue; }
                for (var ac = 0; ac < numAClips; ac++) {
                    try {
                        var aClip = at.clips[ac];
                        var api = aClip.projectItem;
                        if (!api) continue;
                        var aPath = "";
                        try { aPath = api.getMediaPath() || ""; } catch(e) {}
                        var aStart = 0, aEnd = 0, aIn = 0, aOut = 0;
                        try { aStart = aClip.start.seconds; } catch (e) {}
                        try { aEnd   = aClip.end.seconds;   } catch (e) {}
                        try { aIn    = aClip.inPoint.seconds;  } catch (e) {}
                        try { aOut   = aClip.outPoint.seconds; } catch (e) {}
                        clips.push({
                            trackType:  "audio",
                            trackIndex: a,
                            clipIndex:  ac,
                            clipName:   aClip.name || "",
                            mediaPath:  aPath.replace(/\\/g, "/"),
                            start:      aStart,
                            end:        aEnd,
                            mediaIn:    aIn,
                            mediaOut:   aOut
                        });
                    } catch (e) { continue; }
                }
            }
        } catch (e) {}

        return JSON.stringify(clips);
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Exports a mixdown of specified audio tracks to a WAV file using AME / encoder.
 * Falls back to returning the raw media path if export is not available.
 *
 * @param {string} audioTrackIndicesJSON - JSON array of track indices to include, e.g. "[0,1]"
 * @param {string} outputWavPath         - Where to write the rendered WAV
 */
function exportAudioMixdown(audioTrackIndicesJSON, outputWavPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        // Try to use the Premiere encoder queue (requires AME)
        try {
            // Mute tracks we do NOT want included
            var trackIndices = JSON.parse(audioTrackIndicesJSON);
            var numA = seq.audioTracks.numTracks;
            var originalMutes = [];
            for (var i = 0; i < numA; i++) {
                var muted = false;
                try { muted = seq.audioTracks[i].isMuted(); } catch(e) {}
                originalMutes.push(muted);
                var shouldBeIncluded = false;
                for (var k = 0; k < trackIndices.length; k++) {
                    if (trackIndices[k] === i) { shouldBeIncluded = true; break; }
                }
                // Mute tracks not in selection
                try {
                    if (!shouldBeIncluded) seq.audioTracks[i].setMute(true);
                    else seq.audioTracks[i].setMute(false);
                } catch(e) {}
            }

            // Export via encoder
            var encoder = app.encoder;
            encoder.launchEncoder();

            var outputPath = outputWavPath.replace(/\//g, "\\\\");
            var exportResult = encoder.exportSequence(
                seq,
                outputPath,
                "audio-only",   // preset hint — AME resolves actual preset
                app.encoder.ENCODE_IN_TO_OUT
            );

            // Restore mute states
            for (var r = 0; r < numA; r++) {
                try { seq.audioTracks[r].setMute(originalMutes[r]); } catch(e) {}
            }

            return JSON.stringify({ success: true, path: outputWavPath, method: "encoder" });
        } catch (encErr) {
            // AME not available — return the source media path so caller falls back to FFmpeg on original
            var fallbackPath = "";
            try {
                var ft = seq.audioTracks[0];
                if (ft && ft.clips.numItems > 0) {
                    var fp = ft.clips[0].projectItem.getMediaPath();
                    if (fp) fallbackPath = fp.replace(/\\/g, "/");
                }
            } catch(e) {}

            return JSON.stringify({
                success:  false,
                fallback: true,
                path:     fallbackPath,
                error:    encErr.toString()
            });
        }
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets the file path of the first clip in a given audio track.
 */
function getAllMediaPaths() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        var results = [];

        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var numClips = 0;
            try { numClips = track.clips.numItems; } catch (e) { continue; }
            for (var c = 0; c < numClips; c++) {
                try {
                    var clip = track.clips[c];
                    var pi = clip.projectItem;
                    if (!pi) continue;
                    var mPath = pi.getMediaPath();
                    if (!mPath) continue;
                    var startSec = 0, endSec = 0;
                    try { startSec = clip.start.seconds; } catch (e) {}
                    try { endSec   = clip.end.seconds;   } catch (e) {}
                    results.push({
                        trackIndex: t,
                        trackName:  track.name || ("Audio " + (t + 1)),
                        clipIndex:  c,
                        clipName:   clip.name || "",
                        mediaPath:  mPath.replace(/\\/g, "/"),
                        startTime:  startSec,
                        endTime:    endSec
                    });
                } catch (e) { continue; }
            }
        }

        for (var v = 0; v < seq.videoTracks.numTracks; v++) {
            var vTrack = seq.videoTracks[v];
            var vNumClips = 0;
            try { vNumClips = vTrack.clips.numItems; } catch (e) { continue; }
            for (var vc = 0; vc < vNumClips; vc++) {
                try {
                    var vClip = vTrack.clips[vc];
                    var vPi = vClip.projectItem;
                    if (!vPi) continue;
                    var vPath = vPi.getMediaPath();
                    if (!vPath) continue;
                    var exists = false;
                    for (var rr = 0; rr < results.length; rr++) {
                        if (results[rr].mediaPath === vPath.replace(/\\/g, "/")) { exists = true; break; }
                    }
                    if (!exists) {
                        var vStart = 0, vEnd = 0;
                        try { vStart = vClip.start.seconds; } catch (e) {}
                        try { vEnd   = vClip.end.seconds;   } catch (e) {}
                        results.push({
                            trackIndex: v,
                            trackName:  "Video " + (v + 1),
                            clipIndex:  vc,
                            clipName:   vClip.name || "",
                            mediaPath:  vPath.replace(/\\/g, "/"),
                            startTime:  vStart,
                            endTime:    vEnd
                        });
                    }
                } catch (e) { continue; }
            }
        }

        return JSON.stringify(results);
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Exports the active sequence audio (all tracks, with effects) to a WAV file.
 *
 * Uses exportAsMediaDirect() which renders synchronously through Premiere's
 * own audio engine — preserving volume, EQ, and all audio effects.
 *
 * @param {string} outputPath    - Destination WAV path (forward slashes OK)
 * @param {string} extensionPath - Root directory of the CEP extension
 */
function exportSequenceAudio(outputPath, extensionPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        var outNorm    = outputPath.replace(/\//g, "\\");
        var presetPath = extensionPath.replace(/\//g, "\\") + "\\WAV.epr";

        var presetFile = new File(presetPath);
        if (!presetFile.exists) {
            return '{"success":false,"error":"WAV.epr not found at: ' + presetPath.replace(/\\/g, '\\\\') + '"}';
        }

        // ── Export ──────────────────────────────────────────────────
        seq.exportAsMediaDirect(
            outNorm,
            presetPath,
            app.encoder.ENCODE_IN_TO_OUT
        );

        return JSON.stringify({
            success: true,
            path:    outputPath,
            preset:  presetPath
        });
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Imports an FCP7 XML file into the Premiere project.
 */
function importXMLToProject(xmlPath) {
    try {
        app.project.importFiles([xmlPath], 1, app.project.rootItem, 0);
        return '{"success":true,"message":"XML imported"}';
    } catch (e) {
        return '{"success":false,"message":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets the project directory path.
 */
function getProjectPath() {
    try {
        var projectPath = app.project.path;
        if (!projectPath || projectPath === "") return '{"error":"Project not saved"}';
        var normalized = projectPath.replace(/\\/g, "/");
        var lastSlash  = normalized.lastIndexOf("/");
        var dir        = normalized.substring(0, lastSlash);
        return '{"projectPath":"' + normalized + '","projectDir":"' + dir + '"}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets sequence settings for XML generation (robust framerate + resolution).
 */
function getSequenceSettings() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"error":"No active sequence"}';

        var seqName = seq.name || "Untitled";

        // ── Framerate ─────────────────────────────────────────────
        var fps = 29.97;
        try {
            var tbTicks = Number(seq.timebase);
            if (tbTicks > 0) fps = TICKS / tbTicks;
        } catch (e) {}

        // ── Duration ──────────────────────────────────────────────
        var durationSeconds = 0;
        try { durationSeconds = seq.end.seconds; }
        catch (e1) {
            try { durationSeconds = ticksToSeconds(seq.end.ticks); } catch (e2) {}
        }

        // ── Resolution & Sample Rate ───────────────────────────────
        var width = 1920, height = 1080, sampleRate = 48000;
        var numAudioTracks = 0;
        try {
            var settings = seq.getSettings();
            if (settings) {
                if (settings.videoFrameWidth)  width      = settings.videoFrameWidth;
                if (settings.videoFrameHeight) height     = settings.videoFrameHeight;
                if (settings.audioSampleRate)  sampleRate = settings.audioSampleRate;
            }
        } catch (e) {
            try { width  = seq.frameSizeHorizontal; } catch (e2) {}
            try { height = seq.frameSizeVertical;   } catch (e3) {}
        }

        try { numAudioTracks = seq.audioTracks.numTracks; } catch(e) {}
        try { numVideoTracks = seq.videoTracks.numTracks; } catch(e) {}

        return '{"name":"'     + seqName      + '",' +
               '"framerate":'  + fps           + ',' +
               '"width":'      + width         + ',' +
               '"height":'     + height        + ',' +
               '"audioSampleRate":' + sampleRate + ',' +
               '"audioTrackCount":' + numAudioTracks + ',' +
               '"videoTrackCount":' + numVideoTracks + ',' +
               '"durationSeconds":' + durationSeconds + '}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}
