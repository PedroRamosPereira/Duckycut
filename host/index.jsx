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

function _clipFullyInside(clipStartSec, clipEndSec, zoneStartSec, zoneEndSec, fps) {
    var halfFrame = (fps && fps > 0) ? (0.5 / fps) : 0.02;
    return (clipStartSec >= zoneStartSec - halfFrame) &&
           (clipEndSec   <= zoneEndSec   + halfFrame);
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
 * Exports the active sequence audio (all tracks, with effects) to a WAV file
 * by queuing a render in Adobe Media Encoder (AME).
 *
 * Why AME (not exportAsMediaDirect): AME runs out-of-process, so Premiere's UI
 * stays responsive while the render happens — matches fireCut's behaviour. The
 * panel polls for the output WAV on disk to know when the render is done.
 *
 * Range is ENCODE_ENTIRE (not ENCODE_IN_TO_OUT) so existing sequence In/Out
 * marks don't silently truncate the export and shift every detected timestamp.
 *
 * @param {string} outputPath    - Destination WAV path (forward slashes OK)
 * @param {string} extensionPath - Root directory of the CEP extension
 */
function exportSequenceAudio(outputPath, extensionPath) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        // ── Sanitise paths: strip file:/// protocol + decode %20 etc. ──
        var cleanOutPath = decodeURI(outputPath).replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");
        var cleanExtPath = decodeURI(extensionPath).replace(/^file:\/{2,3}/i, "").replace(/\\/g, "/");

        var outNorm = cleanOutPath.replace(/\//g, "\\");

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

        // 1. Bundled inside extension root / server / presets
        var extRootBack = cleanExtPath.replace(/\//g, "\\");
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

        // ── Queue render through Adobe Media Encoder ────────────────
        // encodeSequence(sequence, outputPath, presetPath,
        //                encodeType[0=ENTIRE,1=IN_TO_OUT,2=WORKAREA],
        //                removeUponCompletion[0|1], startImmediately[0|1])
        try { app.encoder.launchEncoder(); } catch (eLaunch) {}

        var jobID = "";
        try {
            jobID = app.encoder.encodeSequence(
                seq,
                outNorm,
                presetPath,
                0,   // ENCODE_ENTIRE — ignore any In/Out marks on the sequence
                1,   // remove job from AME queue after it completes
                1    // start batch immediately
            );
        } catch (encErr) {
            return '{"success":false,"error":"encodeSequence failed: ' + encErr.toString().replace(/"/g, '\\"') + '"}';
        }

        // Defensive: on some PPro versions encodeSequence queues but doesn't
        // start the batch unless startBatch() is called explicitly.
        try { app.encoder.startBatch(); } catch (eStart) {}

        return JSON.stringify({
            success: true,
            queued:  true,
            jobID:   String(jobID || ""),
            path:    cleanOutPath,
            preset:  presetPath.replace(/\\/g, "/")
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
        try { numVideoTracks = seq.videoTracks.numTracks; } catch(e) {}

        return '{"name":"'     + seqName      + '",' +
               '"framerate":'  + fps           + ',' +
               '"exactFps":'   + fps           + ',' +
               '"isNTSC":'     + (isNTSC ? 'true' : 'false') + ',' +
               '"xmlTimebase":' + xmlTimebase  + ',' +
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

/**
 * Razor + ripple-delete of every cut zone across ALL video and audio tracks
 * in the active sequence. Equivalent to selecting each zone with the playhead
 * + Alt+C + Shift+Delete in Premiere, applied in batch from back to front
 * so the ripple shifts don't invalidate later cuts.
 */
function applyCutsInPlace(cutZonesJson, optsJson) {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return '{"success":false,"error":"No active sequence"}';

        var zones = [];
        var opts  = {};
        try { zones = eval("(" + cutZonesJson + ")") || []; } catch (e) {
            return '{"success":false,"error":"Bad cutZones JSON: ' + e.toString().replace(/"/g, '\\"') + '"}';
        }
        try { opts = eval("(" + optsJson + ")") || {}; } catch (e) {}
        var fps    = (typeof opts.fps    === "number")  ? opts.fps    : 29.97;
        var isNTSC = (typeof opts.isNTSC === "boolean") ? opts.isNTSC : false;

        if (!zones.length) return '{"success":true,"applied":0,"skipped":0}';

        zones.sort(function (a, b) { return b[0] - a[0]; });

        try { app.enableQE(); } catch (eQE) {
            return '{"success":false,"error":"QE DOM not available: ' + eQE.toString().replace(/"/g, '\\"') + '"}';
        }
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return '{"success":false,"error":"QE active sequence not found"}';

        var applied = 0, skipped = 0;
        var diag = [];

        for (var z = 0; z < zones.length; z++) {
            var zStart = Number(zones[z][0]);
            var zEnd   = Number(zones[z][1]);
            if (!(zEnd > zStart)) { skipped++; continue; }

            var startTC = _secondsToTimecodeHost(zStart, fps, isNTSC);
            var endTC   = _secondsToTimecodeHost(zEnd,   fps, isNTSC);

            try {
                for (var v = 0; v < qeSeq.numVideoTracks; v++) {
                    try { qeSeq.getVideoTrackAt(v).razor(endTC); }   catch (e1) {}
                    try { qeSeq.getVideoTrackAt(v).razor(startTC); } catch (e2) {}
                }
                for (var a = 0; a < qeSeq.numAudioTracks; a++) {
                    try { qeSeq.getAudioTrackAt(a).razor(endTC); }   catch (e3) {}
                    try { qeSeq.getAudioTrackAt(a).razor(startTC); } catch (e4) {}
                }
            } catch (eRazor) {
                diag.push("razor zone " + z + " failed: " + eRazor.toString());
                skipped++;
                continue;
            }

            try {
                for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                    var vTrack = seq.videoTracks[vt];
                    var nVC = 0; try { nVC = vTrack.clips.numItems; } catch(eN) {}
                    for (var vci = nVC - 1; vci >= 0; vci--) {
                        try {
                            var vClip = vTrack.clips[vci];
                            if (!vClip) continue;
                            var cs = 0, ce = 0;
                            try { cs = vClip.start.seconds; } catch(eS) {}
                            try { ce = vClip.end.seconds;   } catch(eE) {}
                            if (_clipFullyInside(cs, ce, zStart, zEnd, fps)) {
                                vClip.remove(true, true);
                            }
                        } catch (eRem) { diag.push("V remove fail t=" + vt + " c=" + vci + ": " + eRem.toString()); }
                    }
                }
                for (var at = 0; at < seq.audioTracks.numTracks; at++) {
                    var aTrack = seq.audioTracks[at];
                    var nAC = 0; try { nAC = aTrack.clips.numItems; } catch(eN2) {}
                    for (var aci = nAC - 1; aci >= 0; aci--) {
                        try {
                            var aClip = aTrack.clips[aci];
                            if (!aClip) continue;
                            var as = 0, ae = 0;
                            try { as = aClip.start.seconds; } catch(eS2) {}
                            try { ae = aClip.end.seconds;   } catch(eE2) {}
                            if (_clipFullyInside(as, ae, zStart, zEnd, fps)) {
                                aClip.remove(true, true);
                            }
                        } catch (eRem) { diag.push("A remove fail t=" + at + " c=" + aci + ": " + eRem.toString()); }
                    }
                }
                applied++;
            } catch (eRemAll) {
                diag.push("remove block zone " + z + " failed: " + eRemAll.toString());
                skipped++;
            }
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
        result += '}';
        return result;
    } catch (e) {
        return '{"success":false,"error":"' + e.toString().replace(/"/g, '\\"') + '"}';
    }
}
