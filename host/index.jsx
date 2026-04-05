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

/**
 * Returns info about the active sequence: name, audio tracks, duration.
 */
function getActiveSequenceInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"error":"No active sequence"}';
        }

        var seqName = seq.name || "Untitled";
        var seqId = "";
        try { seqId = seq.sequenceID; } catch (e) { seqId = ""; }

        // Duration — seq.end is a Time object
        var durationSeconds = 0;
        try {
            durationSeconds = seq.end.seconds;
        } catch (e1) {
            try {
                var ticksPerSecond = 254016000000;
                durationSeconds = Number(seq.end.ticks) / ticksPerSecond;
            } catch (e2) {
                durationSeconds = 0;
            }
        }

        // Framerate
        var fps = 29.97;
        try {
            var ticksPerSecond = 254016000000;
            var tbTicks = Number(seq.timebase);
            if (tbTicks > 0) {
                fps = ticksPerSecond / tbTicks;
            }
        } catch (e) {}

        // Audio tracks
        var audioTracks = [];
        try {
            var numAudioTracks = seq.audioTracks.numTracks;
            for (var i = 0; i < numAudioTracks; i++) {
                var track = seq.audioTracks[i];
                var trackName = "Audio " + (i + 1);
                try { trackName = track.name || trackName; } catch (e) {}

                var clipCount = 0;
                try { clipCount = track.clips.numItems; } catch (e) {}

                audioTracks.push({
                    index: i,
                    name: trackName,
                    clipCount: clipCount
                });
            }
        } catch (e) {}

        var result = {
            name: seqName,
            sequenceID: seqId,
            framerate: fps,
            durationSeconds: durationSeconds,
            audioTracks: audioTracks
        };

        return JSON.stringify(result);
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
        if (!seq) {
            return '{"error":"No active sequence"}';
        }

        var idx = parseInt(trackIndex, 10);
        if (isNaN(idx)) idx = 0;

        var track = seq.audioTracks[idx];
        if (!track) {
            return '{"error":"Track ' + idx + ' not found"}';
        }

        var numClips = 0;
        try { numClips = track.clips.numItems; } catch (e) {}

        if (numClips === 0) {
            // Try video tracks — sometimes audio is linked to video clips
            try {
                var vTrack = seq.videoTracks[0];
                if (vTrack && vTrack.clips.numItems > 0) {
                    var vClip = vTrack.clips[0];
                    if (vClip.projectItem) {
                        var vPath = vClip.projectItem.getMediaPath();
                        if (vPath) {
                            return '{"path":"' + vPath.replace(/\\/g, "/") + '"}';
                        }
                    }
                }
            } catch (e) {}
            return '{"error":"Track has no clips"}';
        }

        var clip = track.clips[0];
        if (!clip) {
            return '{"error":"Could not access clip"}';
        }

        var projectItem = clip.projectItem;
        if (!projectItem) {
            return '{"error":"No project item for clip"}';
        }

        var mediaPath = projectItem.getMediaPath();
        if (!mediaPath) {
            return '{"error":"getMediaPath returned empty"}';
        }

        // Normalize backslashes to forward slashes for cross-platform paths
        mediaPath = mediaPath.replace(/\\/g, "/");
        return '{"path":"' + mediaPath + '"}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets all media file paths from the active sequence.
 */
function getAllMediaPaths() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"error":"No active sequence"}';
        }

        var results = [];
        var ticksPerSecond = 254016000000;

        // Check audio tracks
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
                    try { endSec = clip.end.seconds; } catch (e) {}

                    results.push({
                        trackIndex: t,
                        trackName: track.name || ("Audio " + (t + 1)),
                        clipIndex: c,
                        clipName: clip.name || "",
                        mediaPath: mPath.replace(/\\/g, "/"),
                        startTime: startSec,
                        endTime: endSec
                    });
                } catch (e) {
                    continue;
                }
            }
        }

        // Also check video tracks for linked media
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

                    // Check if this path already exists in results
                    var exists = false;
                    for (var r = 0; r < results.length; r++) {
                        if (results[r].mediaPath === vPath.replace(/\\/g, "/")) {
                            exists = true;
                            break;
                        }
                    }
                    if (!exists) {
                        var vStart = 0, vEnd = 0;
                        try { vStart = vClip.start.seconds; } catch (e) {}
                        try { vEnd = vClip.end.seconds; } catch (e) {}

                        results.push({
                            trackIndex: v,
                            trackName: "Video " + (v + 1),
                            clipIndex: vc,
                            clipName: vClip.name || "",
                            mediaPath: vPath.replace(/\\/g, "/"),
                            startTime: vStart,
                            endTime: vEnd
                        });
                    }
                } catch (e) {
                    continue;
                }
            }
        }

        return JSON.stringify(results);
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Imports an FCP7 XML file into the Premiere project (Turbo Mode).
 */
function importXMLToProject(xmlPath) {
    try {
        app.project.importFiles(
            [xmlPath],
            1,
            app.project.rootItem,
            0
        );
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
        if (!projectPath || projectPath === "") {
            return '{"error":"Project not saved"}';
        }
        var normalized = projectPath.replace(/\\/g, "/");
        var lastSlash = normalized.lastIndexOf("/");
        var dir = normalized.substring(0, lastSlash);

        return '{"projectPath":"' + normalized + '","projectDir":"' + dir + '"}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Gets sequence settings for XML generation.
 */
function getSequenceSettings() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return '{"error":"No active sequence"}';
        }

        var seqName = seq.name || "Untitled";
        var ticksPerSecond = 254016000000;

        // Framerate
        var fps = 29.97;
        try {
            var tbTicks = Number(seq.timebase);
            if (tbTicks > 0) {
                fps = ticksPerSecond / tbTicks;
            }
        } catch (e) {}

        // Duration
        var durationSeconds = 0;
        try {
            durationSeconds = seq.end.seconds;
        } catch (e1) {
            try {
                durationSeconds = Number(seq.end.ticks) / ticksPerSecond;
            } catch (e2) {}
        }

        // Resolution — try getSettings first, fallback to frameSizeHorizontal/Vertical
        var width = 1920;
        var height = 1080;
        var sampleRate = 48000;

        try {
            var settings = seq.getSettings();
            if (settings) {
                if (settings.videoFrameWidth) width = settings.videoFrameWidth;
                if (settings.videoFrameHeight) height = settings.videoFrameHeight;
                if (settings.audioSampleRate) sampleRate = settings.audioSampleRate;
            }
        } catch (e) {
            // getSettings() not available in this Premiere version
            try { width = seq.frameSizeHorizontal; } catch (e2) {}
            try { height = seq.frameSizeVertical; } catch (e3) {}
        }

        return '{"name":"' + seqName + '","framerate":' + fps +
               ',"width":' + width + ',"height":' + height +
               ',"audioSampleRate":' + sampleRate +
               ',"durationSeconds":' + durationSeconds + '}';
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}
