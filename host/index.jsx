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
var DUCKYCUT_CANCEL_APPLY = false;
var DUCKYCUT_AUDIO_MUTE_STATES = null;

function ticksToSeconds(t) {
    try { return Number(t) / TICKS; } catch(e) { return 0; }
}

function _timeToSecondsPreferTicks(t) {
    try {
        if (t && t.ticks !== undefined) {
            var ticks = Number(t.ticks);
            if (!isNaN(ticks)) return ticks / TICKS;
        }
    } catch (e1) {}
    try {
        if (t && typeof t.seconds === "number") return t.seconds;
    } catch (e2) {}
    return 0;
}

// Mirror of client/js/cutZones.js parseZeroPoint — keep in sync.
// seq.zeroPoint may be string ticks, number ticks, Time object (PPro 14+), or empty.
// Number(timeObj) returns NaN — this guards against that.
function _parseZeroPoint(raw) {
    if (raw === null || raw === undefined || raw === "") return 0;
    if (typeof raw === "object") {
        try {
            if (typeof raw.seconds === "number" && !isNaN(raw.seconds)) return raw.seconds;
        } catch (e) {}
        try {
            if (raw.ticks !== undefined) {
                var t = Number(raw.ticks);
                return isNaN(t) ? 0 : t / TICKS;
            }
        } catch (e) {}
        return 0;
    }
    var n = Number(raw);
    if (isNaN(n)) return 0;
    return n / TICKS;
}

function _secondsToTimecodeHost(seconds, fps, isNTSC) {
    if (!fps || fps <= 0) fps = 30;
    var nominalFps = Math.round(fps);
    var totalFrames;
    if (isNTSC) {
        totalFrames = Math.round(seconds * nominalFps * 1000 / 1001);
    } else {
        totalFrames = Math.round(seconds * fps);
    }
    var ff = totalFrames % nominalFps;
    var totalSec = Math.floor(totalFrames / nominalFps);
    var ss = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60);
    var mm = totalMin % 60;
    var hh = Math.floor(totalMin / 60);
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff);
}

// Mirror of client/js/cutZones.js secondsToDropTimecode — keep in sync.
// SMPTE 12M drop-frame: skip 2 (or 4 for 60p) frame labels at start of every
// minute except every 10th. razor() in DF sequences expects ';' before frames.
function _secondsToDropTimecodeHost(seconds, fps) {
    if (!fps || fps <= 0) fps = 29.97;
    var nominalFps   = Math.round(fps);
    var dropPerMin   = (nominalFps === 60) ? 4 : 2;
    var framesPer10m = nominalFps * 60 * 10 - dropPerMin * 9;
    var framesPerMin = nominalFps * 60       - dropPerMin;

    var totalFrames = Math.round(seconds * fps);
    var d = Math.floor(totalFrames / framesPer10m);
    var m = totalFrames %  framesPer10m;
    if (m > dropPerMin) {
        totalFrames = totalFrames + dropPerMin * 9 * d +
                      dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
    } else {
        totalFrames = totalFrames + dropPerMin * 9 * d;
    }

    var ff = totalFrames % nominalFps;
    var ss = Math.floor(totalFrames / nominalFps) % 60;
    var mm = Math.floor(totalFrames / (nominalFps * 60)) % 60;
    var hh = Math.floor(totalFrames / (nominalFps * 3600));
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ";" + pad(ff);
}

// QE razor() receives a string label; the panel chooses whether that label
// should be display timecode (confirmed drop-frame) or absolute/nominal.
function _secondsToQeRazorTimecodeHost(seconds, fps, isDropFrame, isNTSC) {
    if (!fps || fps <= 0) fps = 30;
    if (!isDropFrame) return _secondsToTimecodeHost(seconds, fps, isNTSC);

    var nominalFps = Math.round(fps);
    var totalFrames = Math.round(seconds * fps);
    var ff = totalFrames % nominalFps;
    var ss = Math.floor(totalFrames / nominalFps) % 60;
    var mm = Math.floor(totalFrames / (nominalFps * 60)) % 60;
    var hh = Math.floor(totalFrames / (nominalFps * 3600));
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ";" + pad(ff);
}

function _clipFullyInside(clipStartSec, clipEndSec, zoneStartSec, zoneEndSec, fps) {
    // 1.5 frames covers NTSC tick-to-seconds drift (up to ~1 frame off)
    // without false-positives: keep-zone clips are much longer than 3 frames.
    var tol = (fps && fps > 0) ? (1.5 / fps) : 0.06;
    return (clipStartSec >= zoneStartSec - tol) &&
           (clipEndSec   <= zoneEndSec   + tol);
}

function _isApplyCutsCancelled() {
    return DUCKYCUT_CANCEL_APPLY === true;
}

function cancelApplyCuts() {
    DUCKYCUT_CANCEL_APPLY = true;
    return '{"success":true,"cancelled":true}';
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

        // ── NTSC detection & XML timebase ───────────────────────────
        var isNTSC = false;
        var ntscRates = [23.976, 29.97, 59.94];
        for (var n = 0; n < ntscRates.length; n++) {
            if (Math.abs(fps - ntscRates[n]) < 0.05) { isNTSC = true; break; }
        }
        var xmlTimebase = Math.round(fps);

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
            exactFps:        fps,
            isNTSC:          isNTSC,
            xmlTimebase:     xmlTimebase,
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
 * Exports the active sequence audio (with current track mute states) to a WAV
 * file directly through Premiere. The panel mutes unselected tracks before
 * calling this, so the exported mixdown reflects only the tracks under analysis.
 *
 * Range defaults to ENCODE_ENTIRE so existing sequence In/Out marks don't
 * silently truncate the export. The panel may pass workAreaType=1 explicitly
 * when the user selects Range: In-Out.
 *
 * @param {string} outputPath    - Destination WAV path (forward slashes OK)
 * @param {string} extensionPath - Root directory of the CEP extension
 * @param {string} presetMode    - "reduced" uses bundled 16kHz mono preset
 */
function exportSequenceAudio(outputPath, extensionPath, workAreaType, presetMode) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        // ── Sanitise paths: strip file:/// protocol + decode %20 etc. ──
        var cleanOutPath = decodeURI(outputPath).replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");
        var cleanExtPath = decodeURI(extensionPath).replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");

        var outNorm = cleanOutPath.replace(/\//g, "\\");
        var requestedPresetMode = String(presetMode || "default");

        // ── Locate a WAV encoder preset (.epr) ─────────────────────
        // Adobe moves preset GUIDs and filenames between versions:
        //   2022-2025: systempresets\58444341_4d635174\WAV\48kHz 16-bit.epr
        //   2026+    : systempresets\3F3F3F3F_57415645\Waveform Audio 48kHz 16-bit.epr
        //   Premiere : Settings\EncoderPresets\Wave48mono16.epr
        // Strategy: try hard-coded known paths first, then fall back to a
        // recursive scan with diagnostic trace so failures are debuggable.
        var presetPath = "";
        var triedPaths = [];
        var trace = [];

        function isFolder(f) {
            try { return f && typeof f.getFiles === "function"; } catch (e) { return false; }
        }

        var extRootBack = cleanExtPath.replace(/\//g, "\\");
        if (requestedPresetMode === "reduced") {
            var reducedPresetPath = cleanExtPath + "/preset/Duckycut_Silero_Analysis.epr";
            triedPaths.push(reducedPresetPath);
            var reducedPresetFile = new File(reducedPresetPath);
            if (!reducedPresetFile.exists) {
                return '{"success":false,"error":"Reduced prerender preset not found: ' + reducedPresetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"}';
            }
            presetPath = reducedPresetFile.fsName;
        }

        // 1. Bundled inside extension root / server / presets
        if (!presetPath) {
            var bundled = [
                extRootBack + "\\WAV.epr",
                extRootBack + "\\server\\WAV.epr",
                extRootBack + "\\presets\\WAV.epr"
            ];
            for (var bc = 0; bc < bundled.length; bc++) {
                triedPaths.push(bundled[bc]);
                var bf = new File(bundled[bc]);
                if (bf.exists) { presetPath = bundled[bc]; break; }
            }
        }

        // 2. Known concrete paths across years + GUIDs
        if (!presetPath) {
            var years = ["2026", "2025", "2024", "2023", "2022"];
            var bases = [
                "C:\\Program Files\\Adobe\\Adobe Media Encoder ",
                "C:\\Program Files\\Adobe\\Adobe Premiere Pro "
            ];
            var relPaths = [
                // Newer (2026+) layout
                "\\MediaIO\\systempresets\\3F3F3F3F_57415645\\Waveform Audio 48kHz 16-bit.epr",
                // Older (2022-2025) layout
                "\\MediaIO\\systempresets\\58444341_4d635174\\WAV\\48kHz 16-bit.epr",
                // Premiere user-visible presets
                "\\Settings\\EncoderPresets\\Wave48mono16.epr"
            ];
            for (var bi = 0; bi < bases.length && !presetPath; bi++) {
                for (var yi = 0; yi < years.length && !presetPath; yi++) {
                    for (var ri = 0; ri < relPaths.length; ri++) {
                        var candidate = bases[bi] + years[yi] + relPaths[ri];
                        triedPaths.push(candidate);
                        var cf = new File(candidate);
                        if (cf.exists) { presetPath = candidate; break; }
                    }
                }
            }
        }

        // 3. Recursive scan with diagnostic trace
        if (!presetPath) {
            var adobeRoot = new Folder("C:\\Program Files\\Adobe");
            trace.push("adobeRoot=" + adobeRoot.fsName + " exists=" + adobeRoot.exists);
            if (adobeRoot.exists) {
                var adobeApps = adobeRoot.getFiles();
                trace.push("adobeApps.count=" + (adobeApps ? adobeApps.length : -1));
                for (var ai = 0; ai < adobeApps.length && !presetPath; ai++) {
                    var appDir = adobeApps[ai];
                    if (!isFolder(appDir)) { trace.push("skip[" + ai + "] not-folder"); continue; }
                    if (!/^Adobe (Media Encoder|Premiere Pro)/i.test(appDir.name)) continue;
                    trace.push("enter " + appDir.name);

                    var sysRoot = new Folder(appDir.fsName + "\\MediaIO\\systempresets");
                    trace.push("  sysRoot.exists=" + sysRoot.exists);
                    if (sysRoot.exists) {
                        var guidDirs = sysRoot.getFiles();
                        trace.push("  guidDirs=" + (guidDirs ? guidDirs.length : -1));
                        var eprSample = [];
                        for (var gi = 0; gi < guidDirs.length && !presetPath; gi++) {
                            var gd = guidDirs[gi];
                            if (!isFolder(gd)) continue;
                            var eprs = gd.getFiles("*.epr");
                            for (var ei = 0; ei < eprs.length; ei++) {
                                if (eprSample.length < 8) eprSample.push(eprs[ei].name);
                                if (/wav/i.test(eprs[ei].name)) {
                                    presetPath = eprs[ei].fsName;
                                    break;
                                }
                            }
                        }
                        trace.push("  epr sample=[" + eprSample.join(" | ") + "]");
                    }

                    if (!presetPath) {
                        var userPresets = new Folder(appDir.fsName + "\\Settings\\EncoderPresets");
                        trace.push("  userPresets.exists=" + userPresets.exists);
                        if (userPresets.exists) {
                            var uprs = userPresets.getFiles("*.epr");
                            for (var ui = 0; ui < uprs.length; ui++) {
                                if (/wav/i.test(uprs[ui].name)) {
                                    presetPath = uprs[ui].fsName;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        if (!presetPath) {
            var msg = "No WAV .epr preset found.\\n\\nTried direct paths:";
            for (var tp = 0; tp < triedPaths.length; tp++) {
                msg += "\\n  " + triedPaths[tp].replace(/\\/g, "\\\\");
            }
            msg += "\\n\\nScan trace:";
            for (var tr = 0; tr < trace.length; tr++) {
                msg += "\\n  " + trace[tr].replace(/\\/g, "\\\\").replace(/"/g, "'");
            }
            return '{"success":false,"error":"' + msg + '"}';
        }

        var exportWorkAreaType = parseInt(workAreaType, 10);
        if (isNaN(exportWorkAreaType)) exportWorkAreaType = 0;

        // ── Export directly through Premiere ────────────────────────
        // exportAsMediaDirect(outputPath, presetPath, workAreaType)
        // workAreaType 0 = full sequence, 1 = sequence In to Out.
        try {
            seq.exportAsMediaDirect(
                outNorm,
                presetPath,
                exportWorkAreaType
            );
        } catch (exportErr) {
            return '{"success":false,"error":"exportAsMediaDirect failed: ' + exportErr.toString().replace(/"/g, '\\"') + '"}';
        }

        return JSON.stringify({
            success: true,
            path:    cleanOutPath,
            preset:  presetPath.replace(/\\/g, "/"),
            presetMode: requestedPresetMode,
            workAreaType: exportWorkAreaType
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

        // ── NTSC detection & XML timebase ─────────────────────────
        var isNTSC = false;
        var ntscRates = [23.976, 29.97, 59.94];
        for (var n = 0; n < ntscRates.length; n++) {
            if (Math.abs(fps - ntscRates[n]) < 0.05) { isNTSC = true; break; }
        }
        var xmlTimebase = Math.round(fps);

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
        var numVideoTracks = 0;
        try { numVideoTracks = seq.videoTracks.numTracks; } catch(e) {}

        // ── Drop-frame detection ──────────────────────────────────
        // PPro exposes drop-frame via videoDisplayFormat enum.
        // Official sequence enums: 102 = 29.97 Drop, 106 = 59.94 Drop.
        // Do not infer DF from NTSC rate alone: 59.94 non-drop exists and QE
        // will treat DF display labels as absolute frame labels in that case.
        var isDropFrame = false;
        var videoDisplayFormat = null;
        try {
            var settings2 = seq.getSettings();
            if (settings2 && typeof settings2.videoDisplayFormat === "number") {
                videoDisplayFormat = settings2.videoDisplayFormat;
                isDropFrame = (videoDisplayFormat === 102 ||
                               videoDisplayFormat === 106);
            }
        } catch (e) {}

        // ── Zero point (sequence start TC offset) ─────────────────
        var zeroPointSeconds = 0;
        try { zeroPointSeconds = _parseZeroPoint(seq.zeroPoint); } catch (e) {}

        return JSON.stringify({
            name:             seqName,
            framerate:        fps,
            exactFps:         fps,
            isNTSC:           isNTSC,
            isDropFrame:      isDropFrame,
            videoDisplayFormat: videoDisplayFormat,
            xmlTimebase:      xmlTimebase,
            width:            width,
            height:           height,
            audioSampleRate:  sampleRate,
            audioTrackCount:  numAudioTracks,
            videoTrackCount:  numVideoTracks,
            durationSeconds:  durationSeconds,
            zeroPointSeconds: zeroPointSeconds
        });
    } catch (e) {
        return '{"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function getSequenceInOutRange() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        var inTime = null;
        var outTime = null;
        try { inTime = seq.getInPointAsTime(); } catch (e1) {}
        try { outTime = seq.getOutPointAsTime(); } catch (e2) {}

        var rawStartTicks = NaN;
        var rawEndTicks = NaN;
        try { rawStartTicks = Number(inTime.ticks); } catch (e3) {}
        try { rawEndTicks = Number(outTime.ticks); } catch (e4) {}

        if (isNaN(rawStartTicks)) rawStartTicks = Math.round(_timeToSecondsPreferTicks(inTime) * TICKS);
        if (isNaN(rawEndTicks)) rawEndTicks = Math.round(_timeToSecondsPreferTicks(outTime) * TICKS);

        var zeroPointSeconds = 0;
        try { zeroPointSeconds = _parseZeroPoint(seq.zeroPoint); } catch (e5) {}
        var zeroPointTicks = Math.round(zeroPointSeconds * TICKS);
        var normalizedByZeroPoint = false;
        var startTicks = rawStartTicks;
        var endTicks = rawEndTicks;
        if (zeroPointTicks !== 0 && rawStartTicks >= zeroPointTicks && rawEndTicks > zeroPointTicks) {
            startTicks = rawStartTicks - zeroPointTicks;
            endTicks = rawEndTicks - zeroPointTicks;
            normalizedByZeroPoint = true;
        }

        var startSeconds = startTicks / TICKS;
        var endSeconds = endTicks / TICKS;
        var valid = endTicks > startTicks;

        return JSON.stringify({
            success: true,
            valid: valid,
            startTicks: String(startTicks),
            endTicks: String(endTicks),
            startSeconds: startSeconds,
            endSeconds: endSeconds,
            durationSeconds: endSeconds - startSeconds,
            rawStartTicks: String(rawStartTicks),
            rawEndTicks: String(rawEndTicks),
            rawStartSeconds: rawStartTicks / TICKS,
            rawEndSeconds: rawEndTicks / TICKS,
            zeroPointTicks: String(zeroPointTicks),
            zeroPointSeconds: zeroPointSeconds,
            normalizedByZeroPoint: normalizedByZeroPoint
        });
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

/**
 * Razor + ripple-delete of every cut zone across ALL video and audio tracks
 * in the active sequence. Equivalent to selecting each zone with the playhead
 * + Alt+C + Shift+Delete in Premiere, applied in batch from back to front
 * so the ripple shifts don't invalidate later cuts.
 */
function applyCutsInPlace(cutZonesJson, optsJson) {
    try {
        DUCKYCUT_CANCEL_APPLY = false;

        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        // If the user switches sequences mid-apply, resyncing from
        // app.project.activeSequence would collect and delete clips from the
        // wrong timeline. Every resync must go through this guard.
        var applySeqId = "";
        try { applySeqId = String(seq.sequenceID); } catch (eSeqIdInit) {}

        function _resyncActiveSequence(current) {
            try {
                var cand = app.project.activeSequence;
                if (!cand) return current;
                if (applySeqId) {
                    var candId = "";
                    try { candId = String(cand.sequenceID); } catch (eCandId) {}
                    if (candId !== applySeqId) return current;
                }
                return cand;
            } catch (eResyncGuard) { return current; }
        }

        var zones = [];
        var opts  = {};
        try { zones = eval("(" + cutZonesJson + ")") || []; } catch (e) {
            return '{"success":false,"error":"Bad cutZones JSON: ' + e.toString().replace(/"/g, '\\"') + '"}';
        }
        try { opts = eval("(" + optsJson + ")") || {}; } catch (e) {}
        var fps         = (typeof opts.fps         === "number")  ? opts.fps         : 29.97;
        var isNTSC      = (typeof opts.isNTSC      === "boolean") ? opts.isNTSC      : false;
        var isDropFrame = (typeof opts.isDropFrame === "boolean") ? opts.isDropFrame : false;
        var qeTimecodeMode = (opts.qeTimecodeMode === "display") ? "display" : "absolute";
        var hostVideoDisplayFormat = null;
        try {
            var cutSettings = seq.getSettings();
            if (cutSettings && typeof cutSettings.videoDisplayFormat === "number") {
                hostVideoDisplayFormat = cutSettings.videoDisplayFormat;
                if (hostVideoDisplayFormat === 102 || hostVideoDisplayFormat === 106) {
                    isDropFrame = true;
                    qeTimecodeMode = "display";
                }
            }
        } catch (eCutSettings) {}
        if (!zones.length) return '{"success":true,"applied":0,"skipped":0}';

        zones.sort(function (a, b) {
            var aStartTicks = (a && a.startTicks !== undefined) ? Number(a.startTicks) : Math.round(Number(a[0]) * TICKS);
            var bStartTicks = (b && b.startTicks !== undefined) ? Number(b.startTicks) : Math.round(Number(b[0]) * TICKS);
            return bStartTicks - aStartTicks;
        });

        try { app.enableQE(); } catch (eQE) {
            return '{"success":false,"error":"QE DOM not available: ' + eQE.toString().replace(/"/g, '\\"') + '"}';
        }
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return '{"success":false,"error":"QE active sequence not found"}';

        var applied = 0, skipped = 0;
        var diag = [];
        var zoneDiagnostics = [];
        var INTERSECT_TOLERANCE_FRAMES = 1.5;
        var CONTAINED_TOLERANCE_FRAMES = 4.5;
        var BOUNDARY_TOLERANCE_FRAMES = 6;
        diag.push("hostVideoDisplayFormat=" + (hostVideoDisplayFormat === null ? "null" : hostVideoDisplayFormat));

        // razor() receives sequence timecode relative to seq.zeroPoint. The
        // panel selects display labels for confirmed DF and absolute/nominal
        // labels for non-DF or unknown formats.
        // _parseZeroPoint handles string ticks, number ticks, and PPro 14+ Time
        // objects (where Number(timeObj) returns NaN — the prior bug).
        var zpRaw  = null;
        var zpType = "";
        var zpSec  = 0;
        try {
            zpRaw  = seq.zeroPoint;
            zpType = typeof zpRaw;
            zpSec  = _parseZeroPoint(zpRaw);
        } catch (eZP) {}

        function _zoneToTC(secs) {
            if (qeTimecodeMode === "display") return _zoneToDisplayTC(secs);
            return _secondsToQeRazorTimecodeHost(secs + zpSec, fps, isDropFrame, isNTSC);
        }

        function _zoneToDisplayTC(secs) {
            if (isDropFrame) return _secondsToDropTimecodeHost(secs + zpSec, fps);
            return _secondsToTimecodeHost(secs + zpSec, fps, isNTSC);
        }

        function _cancelledResult() {
            return '{"success":false,"cancelled":true,"applied":' + applied + ',"skipped":' + skipped + '}';
        }

        function _countTimelineClips(s) {
            var video = 0, audio = 0;
            try {
                for (var cv = 0; cv < s.videoTracks.numTracks; cv++) {
                    try { video += s.videoTracks[cv].clips.numItems; } catch (eVCount) {}
                }
            } catch (eVTotal) {}
            try {
                for (var ca = 0; ca < s.audioTracks.numTracks; ca++) {
                    try { audio += s.audioTracks[ca].clips.numItems; } catch (eACount) {}
                }
            } catch (eATotal) {}
            return { video: video, audio: audio, total: video + audio };
        }

        function _pushCandidate(zoneDiag, kind, trackIndex, clipIndex, startSec, endSec, inside, boundaryMatch) {
            if (!zoneDiag) return;
            if (zoneDiag.candidateClips.length >= 12) return;
            var tol = (fps && fps > 0) ? (3 / fps) : 0.1;
            var intersects = (endSec >= zoneDiag.zStart - tol) && (startSec <= zoneDiag.zEnd + tol);
            if (!inside && !intersects) return;
            var frameRate = (fps && fps > 0) ? fps : 30;
            zoneDiag.candidateClips.push({
                kind: kind,
                trackIndex: trackIndex,
                clipIndex: clipIndex,
                start: startSec,
                end: endSec,
                frameDeltaStart: (startSec - zoneDiag.zStart) * frameRate,
                frameDeltaEnd: (endSec - zoneDiag.zEnd) * frameRate,
                inside: inside,
                boundaryMatch: boundaryMatch === true
            });
        }

        function _secondsToTicks(secs) {
            return Math.round(Number(secs) * TICKS);
        }

        function _timeToTicksPreferTicks(t) {
            try {
                if (t && t.ticks !== undefined) {
                    var rawTicks = Number(t.ticks);
                    if (!isNaN(rawTicks)) return Math.round(rawTicks);
                }
            } catch (e1) {}
            try {
                if (t && typeof t.seconds === "number") return _secondsToTicks(t.seconds);
            } catch (e2) {}
            return 0;
        }

        function _ticksToSeconds(ticks) {
            return Number(ticks) / TICKS;
        }

        function _ticksToTimecode(ticks) {
            return _zoneToTC(_ticksToSeconds(ticks));
        }

        function _ticksToDisplayTimecode(ticks) {
            return _zoneToDisplayTC(_ticksToSeconds(ticks));
        }

        function _normalizeCutZone(zone) {
            var startTicks = 0;
            var endTicks = 0;
            var startSeconds = 0;
            var endSeconds = 0;

            if (zone && zone.startTicks !== undefined && zone.endTicks !== undefined) {
                startTicks = Number(zone.startTicks);
                endTicks = Number(zone.endTicks);
                startSeconds = _ticksToSeconds(startTicks);
                endSeconds = _ticksToSeconds(endTicks);
            } else {
                startSeconds = Number(zone[0]);
                endSeconds = Number(zone[1]);
                startTicks = _secondsToTicks(startSeconds);
                endTicks = _secondsToTicks(endSeconds);
            }

            return {
                startTicks: startTicks,
                endTicks: endTicks,
                startSeconds: startSeconds,
                endSeconds: endSeconds
            };
        }

        function _clipFullyInsideTicks(clipStartTicks, clipEndTicks, zoneStartTicks, zoneEndTicks, fps, toleranceFrames) {
            var frameTicks = (fps && fps > 0) ? Math.round(TICKS / fps) : Math.round(TICKS / 30);
            var tolTicks = Math.round(frameTicks * toleranceFrames);
            return (clipStartTicks >= zoneStartTicks - tolTicks) &&
                   (clipEndTicks   <= zoneEndTicks   + tolTicks);
        }

        function _clipMatchesRazorSegmentTicks(clipStartTicks, clipEndTicks, zoneStartTicks, zoneEndTicks, fps) {
            var frameTicks = (fps && fps > 0) ? Math.round(TICKS / fps) : Math.round(TICKS / 30);
            var tolTicks = Math.round(frameTicks * BOUNDARY_TOLERANCE_FRAMES);
            return (Math.abs(clipStartTicks - zoneStartTicks) <= tolTicks) &&
                   (Math.abs(clipEndTicks - zoneEndTicks) <= tolTicks);
        }

        function _clipIntersectsTicks(clipStartTicks, clipEndTicks, zoneStartTicks, zoneEndTicks, fps, toleranceFrames) {
            var frameTicks = (fps && fps > 0) ? Math.round(TICKS / fps) : Math.round(TICKS / 30);
            var tolTicks = Math.round(frameTicks * toleranceFrames);
            return (clipEndTicks > zoneStartTicks - tolTicks) &&
                   (clipStartTicks < zoneEndTicks + tolTicks);
        }

        function _collectZoneIntersectingClips(s, zoneStartTicks, zoneEndTicks, zoneDiag) {
            var targets = { video: 0, audio: 0, total: 0 };
            try {
                for (var pvt = 0; pvt < s.videoTracks.numTracks; pvt++) {
                    var pvTrack = s.videoTracks[pvt];
                    for (var pvci = 0; pvci < pvTrack.clips.numItems; pvci++) {
                        try {
                            var pvClip = pvTrack.clips[pvci];
                            if (!pvClip) continue;
                            var pvs = _timeToTicksPreferTicks(pvClip.start);
                            var pve = _timeToTicksPreferTicks(pvClip.end);
                            if (_clipIntersectsTicks(pvs, pve, zoneStartTicks, zoneEndTicks, fps, INTERSECT_TOLERANCE_FRAMES)) {
                                targets.video++;
                                targets.total++;
                                if (zoneDiag) _pushCandidate(zoneDiag, "video", pvt, pvci, _ticksToSeconds(pvs), _ticksToSeconds(pve), false, false);
                            }
                        } catch (ePV) {}
                    }
                }
            } catch (ePVAll) {}
            try {
                for (var pat = 0; pat < s.audioTracks.numTracks; pat++) {
                    var paTrack = s.audioTracks[pat];
                    for (var paci = 0; paci < paTrack.clips.numItems; paci++) {
                        try {
                            var paClip = paTrack.clips[paci];
                            if (!paClip) continue;
                            var pas = _timeToTicksPreferTicks(paClip.start);
                            var pae = _timeToTicksPreferTicks(paClip.end);
                            if (_clipIntersectsTicks(pas, pae, zoneStartTicks, zoneEndTicks, fps, INTERSECT_TOLERANCE_FRAMES)) {
                                targets.audio++;
                                targets.total++;
                                if (zoneDiag) _pushCandidate(zoneDiag, "audio", pat, paci, _ticksToSeconds(pas), _ticksToSeconds(pae), false, false);
                            }
                        } catch (ePA) {}
                    }
                }
            } catch (ePAAll) {}
            return targets;
        }

        function _collectZoneContainedClipTargets(s, zoneStartTicks, zoneEndTicks, zoneDiag) {
            var targets = { video: [], audio: [], total: 0 };
            try {
                for (var cvt = 0; cvt < s.videoTracks.numTracks; cvt++) {
                    var cvTrack = s.videoTracks[cvt];
                    for (var cvci = cvTrack.clips.numItems - 1; cvci >= 0; cvci--) {
                        try {
                            var cvClip = cvTrack.clips[cvci];
                            if (!cvClip) continue;
                            var cvs = _timeToTicksPreferTicks(cvClip.start);
                            var cve = _timeToTicksPreferTicks(cvClip.end);
                            var cvInside = _clipFullyInsideTicks(cvs, cve, zoneStartTicks, zoneEndTicks, fps, CONTAINED_TOLERANCE_FRAMES);
                            var cvBoundaryMatch = _clipMatchesRazorSegmentTicks(cvs, cve, zoneStartTicks, zoneEndTicks, fps);
                            _pushCandidate(zoneDiag, "video", cvt, cvci, _ticksToSeconds(cvs), _ticksToSeconds(cve), cvInside, cvBoundaryMatch);
                            if (cvBoundaryMatch) {
                                targets.video.push(cvClip);
                                targets.total++;
                            }
                        } catch (eCV) { if (zoneDiag) diag.push("V collect fail t=" + cvt + " c=" + cvci + ": " + eCV.toString()); }
                    }
                }
            } catch (eCVAll) {}
            try {
                for (var cat = 0; cat < s.audioTracks.numTracks; cat++) {
                    var caTrack = s.audioTracks[cat];
                    for (var caci = caTrack.clips.numItems - 1; caci >= 0; caci--) {
                        try {
                            var caClip = caTrack.clips[caci];
                            if (!caClip) continue;
                            var cas = _timeToTicksPreferTicks(caClip.start);
                            var cae = _timeToTicksPreferTicks(caClip.end);
                            var caInside = _clipFullyInsideTicks(cas, cae, zoneStartTicks, zoneEndTicks, fps, CONTAINED_TOLERANCE_FRAMES);
                            var caBoundaryMatch = _clipMatchesRazorSegmentTicks(cas, cae, zoneStartTicks, zoneEndTicks, fps);
                            _pushCandidate(zoneDiag, "audio", cat, caci, _ticksToSeconds(cas), _ticksToSeconds(cae), caInside, caBoundaryMatch);
                            if (caBoundaryMatch) {
                                targets.audio.push(caClip);
                                targets.total++;
                            }
                        } catch (eCA) { if (zoneDiag) diag.push("A collect fail t=" + cat + " c=" + caci + ": " + eCA.toString()); }
                    }
                }
            } catch (eCAAll) {}
            return targets;
        }

        function _removeCollectedTargets(targets, zoneDiag) {
            var allTargets = [];
            for (var rv = 0; rv < targets.video.length; rv++) allTargets.push({ kind: "video", clip: targets.video[rv] });
            for (var ra = 0; ra < targets.audio.length; ra++) allTargets.push({ kind: "audio", clip: targets.audio[ra] });

            for (var ri = 0; ri < allTargets.length; ri++) {
                try {
                    var ripple = (ri === allTargets.length - 1);
                    allTargets[ri].clip.remove(ripple, true);
                    zoneDiag.targetOrder.push({
                        kind: allTargets[ri].kind,
                        targetIndex: ri,
                        ripple: ripple
                    });
                    if (ripple) {
                        zoneDiag.rippleTargetKind = allTargets[ri].kind;
                        zoneDiag.rippleTargetIndex = ri;
                    }
                    if (allTargets[ri].kind === "video") zoneDiag.removedVideo++;
                    else zoneDiag.removedAudio++;
                } catch (eRemoveCollected) {
                    diag.push("remove collected " + allTargets[ri].kind + " failed: " + eRemoveCollected.toString());
                }
            }
        }

        function _waitForRazorRefresh(beforeCounts, zoneStartTicks, zoneEndTicks, zoneDiag) {
            var refreshedSeq = seq;
            var counts = beforeCounts;
            var attempts = 0;
            var targets = { video: [], audio: [], total: 0 };
            for (var wr = 0; wr < 10; wr++) {
                attempts++;
                try { $.sleep(40); } catch(eSleep) {}
                refreshedSeq = _resyncActiveSequence(refreshedSeq);
                counts = _countTimelineClips(refreshedSeq);
                targets = _collectZoneContainedClipTargets(refreshedSeq, zoneStartTicks, zoneEndTicks, null);
                if (targets.total > 0) break;
            }
            if (zoneDiag) zoneDiag.razorRefreshFoundTargets = targets.total;
            return { sequence: refreshedSeq, counts: counts, refreshAttempts: attempts, targets: targets };
        }

        function _waitForContainedTargets(zoneStartTicks, zoneEndTicks, zoneDiag) {
            var targetSeq = seq;
            var targetCounts = _countTimelineClips(targetSeq);
            var targets = { video: [], audio: [], total: 0 };
            var attempts = 0;
            for (var wt = 0; wt < 12; wt++) {
                attempts++;
                targetSeq = _resyncActiveSequence(targetSeq);
                targetCounts = _countTimelineClips(targetSeq);
                targets = _collectZoneContainedClipTargets(targetSeq, zoneStartTicks, zoneEndTicks, null);
                if (targets.total > 0) break;
                try { $.sleep(60); } catch(eTargetSleep) {}
            }
            zoneDiag.targetRefreshAttempts = attempts;
            targets = _collectZoneContainedClipTargets(targetSeq, zoneStartTicks, zoneEndTicks, zoneDiag);
            return { sequence: targetSeq, counts: targetCounts, targets: targets, targetRefreshAttempts: attempts };
        }

        var rangeStartTicks = null;
        var rangeEndTicks = null;
        if (opts.range) {
            if (opts.range.startTicks !== undefined && opts.range.endTicks !== undefined) {
                rangeStartTicks = Number(opts.range.startTicks);
                rangeEndTicks = Number(opts.range.endTicks);
            } else if (opts.range.startSeconds !== undefined && opts.range.endSeconds !== undefined) {
                rangeStartTicks = _secondsToTicks(opts.range.startSeconds);
                rangeEndTicks = _secondsToTicks(opts.range.endSeconds);
            }
        }

        for (var z = 0; z < zones.length; z++) {
            if (_isApplyCutsCancelled()) return _cancelledResult();

            var normalizedZone = _normalizeCutZone(zones[z]);
            var zStartTicks = normalizedZone.startTicks;
            var zEndTicks = normalizedZone.endTicks;
            var zStart = normalizedZone.startSeconds;
            var zEnd = normalizedZone.endSeconds;
            if (!(zEndTicks > zStartTicks)) { skipped++; continue; }
            if (rangeStartTicks !== null && rangeEndTicks !== null) {
                if (zEndTicks <= rangeStartTicks || zStartTicks >= rangeEndTicks) {
                    skipped++;
                    continue;
                }
                if (zStartTicks < rangeStartTicks) zStartTicks = rangeStartTicks;
                if (zEndTicks > rangeEndTicks) zEndTicks = rangeEndTicks;
                zStart = _ticksToSeconds(zStartTicks);
                zEnd = _ticksToSeconds(zEndTicks);
                if (!(zEndTicks > zStartTicks)) { skipped++; continue; }
            }

            var startTC = _ticksToTimecode(zStartTicks);
            var endTC   = _ticksToTimecode(zEndTicks);
            var displayStartTC = _ticksToDisplayTimecode(zStartTicks);
            var displayEndTC   = _ticksToDisplayTimecode(zEndTicks);
            var zoneDiag = {
                zoneIndex: z,
                zStart: zStart,
                zEnd: zEnd,
                zStartTicks: String(zStartTicks),
                zEndTicks: String(zEndTicks),
                startTC: startTC,
                endTC: endTC,
                displayStartTC: displayStartTC,
                displayEndTC: displayEndTC,
                qeTimecodeMode: qeTimecodeMode,
                clipsBefore: _countTimelineClips(seq),
                clipsAfterRazor: null,
                refreshAttempts: 0,
                removedVideo: 0,
                removedAudio: 0,
                targetOrder: [],
                rippleTargetKind: "",
                rippleTargetIndex: -1,
                razorAttempts: 0,
                razorErrors: [],
                qeVideoTracks: 0,
                qeAudioTracks: 0,
                candidateClips: []
            };

            var preflightTargets = _collectZoneIntersectingClips(seq, zStartTicks, zEndTicks, zoneDiag);
            zoneDiag.preflightTargets = preflightTargets;
            if (preflightTargets.total === 0) {
                skipped++;
                zoneDiagnostics.push(zoneDiag);
                continue;
            }

            try {
                try { qeSeq = qe.project.getActiveSequence(); } catch (eQeRefresh) {
                    zoneDiag.razorErrors.push("QE refresh failed: " + eQeRefresh.toString());
                }
                if (!qeSeq) {
                    zoneDiag.razorError = "QE active sequence not found during zone";
                    zoneDiagnostics.push(zoneDiag);
                    skipped++;
                    continue;
                }
                zoneDiag.qeVideoTracks = qeSeq.numVideoTracks;
                zoneDiag.qeAudioTracks = qeSeq.numAudioTracks;
                for (var v = 0; v < qeSeq.numVideoTracks; v++) {
                    try {
                        zoneDiag.razorAttempts++;
                        qeSeq.getVideoTrackAt(v).razor(endTC);
                    } catch (e1) {
                        zoneDiag.razorErrors.push("V" + v + " end: " + e1.toString());
                    }
                    try {
                        zoneDiag.razorAttempts++;
                        qeSeq.getVideoTrackAt(v).razor(startTC);
                    } catch (e2) {
                        zoneDiag.razorErrors.push("V" + v + " start: " + e2.toString());
                    }
                }
                for (var a = 0; a < qeSeq.numAudioTracks; a++) {
                    try {
                        zoneDiag.razorAttempts++;
                        qeSeq.getAudioTrackAt(a).razor(endTC);
                    } catch (e3) {
                        zoneDiag.razorErrors.push("A" + a + " end: " + e3.toString());
                    }
                    try {
                        zoneDiag.razorAttempts++;
                        qeSeq.getAudioTrackAt(a).razor(startTC);
                    } catch (e4) {
                        zoneDiag.razorErrors.push("A" + a + " start: " + e4.toString());
                    }
                }
            } catch (eRazor) {
                diag.push("razor zone " + z + " failed: " + eRazor.toString());
                zoneDiag.razorError = eRazor.toString();
                zoneDiagnostics.push(zoneDiag);
                skipped++;
                continue;
            }

            if (_isApplyCutsCancelled()) return _cancelledResult();

            // Resync regular API after QE DOM razor — without this, clips[vci].start
            // may still reflect pre-razor geometry and _clipFullyInside never matches.
            var refreshResult = _waitForRazorRefresh(zoneDiag.clipsBefore, zStartTicks, zEndTicks, zoneDiag);
            seq = refreshResult.sequence;
            zoneDiag.refreshAttempts = refreshResult.refreshAttempts;
            zoneDiag.clipsAfterRazor = refreshResult.counts;

            try {
                var removeTargets = _collectZoneContainedClipTargets(seq, zStartTicks, zEndTicks, zoneDiag);
                if (removeTargets.total === 0) {
                    var targetWait = _waitForContainedTargets(zStartTicks, zEndTicks, zoneDiag);
                    seq = targetWait.sequence;
                    zoneDiag.clipsAfterRazor = targetWait.counts;
                    zoneDiag.targetRefreshAttempts = targetWait.targetRefreshAttempts;
                    removeTargets = targetWait.targets;
                }
                if (_isApplyCutsCancelled()) return _cancelledResult();
                _removeCollectedTargets(removeTargets, zoneDiag);
                if (zoneDiag.removedVideo + zoneDiag.removedAudio > 0) applied++;
                else {
                    zoneDiag.deleteRequired = true;
                    zoneDiag.error = "Razor created no removable segment for this zone";
                    zoneDiagnostics.push(zoneDiag);
                    return JSON.stringify({
                        success: false,
                        deleteRequired: true,
                        error: "Cut zone was razored but no clip segment was deleted",
                        applied: applied,
                        skipped: skipped,
                        _diag: diag,
                        _zoneDiag: zoneDiagnostics
                    });
                }
                zoneDiagnostics.push(zoneDiag);
            } catch (eRemAll) {
                diag.push("remove block zone " + z + " failed: " + eRemAll.toString());
                zoneDiag.removeError = eRemAll.toString();
                zoneDiagnostics.push(zoneDiag);
                skipped++;
            }
        }

        // Always include zeroPoint + DF diagnostic — primary suspect for misalignment.
        diag.push("zpRaw=" + (zpRaw === null ? "null" : String(zpRaw)));
        diag.push("zpType=" + zpType);
        diag.push("zpSec=" + zpSec);
        diag.push("fps=" + fps + " isNTSC=" + isNTSC + " isDropFrame=" + isDropFrame);
        diag.push("qeTimecodeMode=" + qeTimecodeMode);
        if (zones.length > 0) {
            // zones is sorted descending by start; first entry = latest, last entry = earliest.
            var firstZone = _normalizeCutZone(zones[zones.length - 1]);
            var lastZone  = _normalizeCutZone(zones[0]);
            diag.push("firstZoneSec=[" + firstZone.startSeconds + "," + firstZone.endSeconds + "]");
            diag.push("firstZoneTC=[" + _ticksToTimecode(firstZone.startTicks) + "," + _ticksToTimecode(firstZone.endTicks) + "]");
            diag.push("firstZoneDisplayTC=[" + _ticksToDisplayTimecode(firstZone.startTicks) + "," + _ticksToDisplayTimecode(firstZone.endTicks) + "]");
            diag.push("lastZoneTC=["  + _ticksToTimecode(lastZone.startTicks)  + "," + _ticksToTimecode(lastZone.endTicks)  + "]");
            diag.push("lastZoneDisplayTC=["  + _ticksToDisplayTimecode(lastZone.startTicks)  + "," + _ticksToDisplayTimecode(lastZone.endTicks)  + "]");
        }

        var result = '{"success":true,"applied":' + applied + ',"skipped":' + skipped;
            if (diag.length) {
            var diagStr = '[';
            for (var d = 0; d < diag.length; d++) {
                if (d > 0) diagStr += ',';
                diagStr += '"' + String(diag[d]).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
            }
            diagStr += ']';
                result += ',"_diag":' + diagStr;
            }
            if (zoneDiagnostics.length) {
                result += ',"_zoneDiag":' + JSON.stringify(zoneDiagnostics);
            }
            result += '}';
        return result;
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function applyCutsInPlaceFile(cutZonesPath, optsJson) {
    try {
        var cleanPath = String(cutZonesPath).replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");
        var f = new File(cleanPath);
        if (!f.exists) return '{"success":false,"error":"Cut zones file not found"}';
        if (!f.open("r")) return '{"success":false,"error":"Unable to open cut zones file"}';
        var cutZonesJson = f.read();
        try { f.close(); } catch (eClose) {}
        return applyCutsInPlace(cutZonesJson, optsJson);
    } catch (e) {
        return '{"success":false,"error":"Cut zones file read failed: ' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function muteAudioTracks(selectedIndicesJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        var selectedIndices = [];
        try { selectedIndices = eval("(" + selectedIndicesJson + ")") || []; } catch (e) {
            return '{"success":false,"error":"Bad indices JSON: ' + e.toString().replace(/"/g, '\\"') + '"}';
        }

        var savedStates = [];
        var trackPlans = [];
        var numTracks = 0;
        try { numTracks = seq.audioTracks.numTracks; } catch (e) {}

        for (var i = 0; i < numTracks; i++) {
            try {
                var track = seq.audioTracks[i];
                var wasMuted = false;
                try { wasMuted = track.isMuted(); } catch (e) {}
                savedStates.push({ index: i, wasMuted: wasMuted });

                var isSelected = false;
                for (var j = 0; j < selectedIndices.length; j++) {
                    if (parseInt(selectedIndices[j], 10) === i) { isSelected = true; break; }
                }
                trackPlans.push({ index: i, muteValue: isSelected ? 0 : 1, expectMuted: !isSelected });
            } catch (e) {}
        }

        DUCKYCUT_AUDIO_MUTE_STATES = savedStates;

        var diagnostics = [];
        for (var p = 0; p < trackPlans.length; p++) {
            try {
                var plan = trackPlans[p];
                var plannedTrack = seq.audioTracks[plan.index];
                var setResult = null;
                var setError = "";
                try { setResult = plannedTrack.setMute(plan.muteValue); } catch (setErr) { setError = setErr.toString(); }

                var afterMuted = false;
                var readError = "";
                try { afterMuted = plannedTrack.isMuted(); } catch (readErr) { readError = readErr.toString(); }

                diagnostics.push({
                    index: plan.index,
                    requestedMuted: plan.expectMuted,
                    afterMuted: afterMuted,
                    setResult: setResult,
                    setError: setError,
                    readError: readError
                });

                if (setError || readError || afterMuted !== plan.expectMuted) {
                    return JSON.stringify({
                        success: false,
                        error: "Mute verification failed for audio track " + (plan.index + 1),
                        savedStates: savedStates,
                        diagnostics: diagnostics
                    });
                }
            } catch (ePlan) {
                return JSON.stringify({
                    success: false,
                    error: "Mute verification failed: " + ePlan.toString(),
                    savedStates: savedStates,
                    diagnostics: diagnostics
                });
            }
        }

        return JSON.stringify({ success: true, savedStates: savedStates, diagnostics: diagnostics });
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}

function restoreAudioTrackMutes(savedStatesJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        var savedStates = DUCKYCUT_AUDIO_MUTE_STATES || [];
        if (savedStatesJson !== undefined && savedStatesJson !== null && String(savedStatesJson) !== "") {
            try { savedStates = eval("(" + savedStatesJson + ")") || []; } catch (e) {
                return '{"success":false,"error":"Bad states JSON: ' + e.toString().replace(/"/g, '\\"') + '"}';
            }
        }

        var diagnostics = [];
        for (var i = 0; i < savedStates.length; i++) {
            try {
                var state = savedStates[i];
                var track = seq.audioTracks[state.index];
                if (track) {
                    var restoreValue = state.wasMuted ? 1 : 0;
                    var setResult = null;
                    var setError = "";
                    try { setResult = track.setMute(restoreValue); } catch (setErr) { setError = setErr.toString(); }

                    var afterMuted = false;
                    var readError = "";
                    try { afterMuted = track.isMuted(); } catch (readErr) { readError = readErr.toString(); }

                    diagnostics.push({
                        index: state.index,
                        requestedMuted: state.wasMuted,
                        afterMuted: afterMuted,
                        setResult: setResult,
                        setError: setError,
                        readError: readError
                    });

                    if (setError || readError || afterMuted !== state.wasMuted) {
                        DUCKYCUT_AUDIO_MUTE_STATES = null;
                        return JSON.stringify({
                            success: false,
                            error: "Mute restore verification failed for audio track " + (state.index + 1),
                            diagnostics: diagnostics
                        });
                    }
                }
            } catch (e) {}
        }

        DUCKYCUT_AUDIO_MUTE_STATES = null;
        return JSON.stringify({ success: true, diagnostics: diagnostics });
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}
