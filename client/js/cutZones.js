// client/js/cutZones.js
// Pure helpers shared between the CEP panel and node:test.
// Loaded as a plain script in the panel (exposes window.Duckycut.cutZones)
// and via require() in node:test.

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.Duckycut = root.Duckycut || {};
        root.Duckycut.cutZones = factory();
    }
}(typeof self !== "undefined" ? self : this, function () {

    function mergeOverlapping(arr) {
        if (!arr || arr.length === 0) return [];
        var sorted = arr.slice().sort(function (a, b) { return a[0] - b[0]; });
        var out = [[sorted[0][0], sorted[0][1]]];
        for (var i = 1; i < sorted.length; i++) {
            var last = out[out.length - 1];
            if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1]);
            else out.push([sorted[i][0], sorted[i][1]]);
        }
        return out;
    }

    function computeSilenceCutZones(silenceIntervals, totalDuration, opts) {
        opts = opts || {};
        var paddingIn          = opts.paddingIn          || 0;
        var paddingOut         = opts.paddingOut         || 0;
        var minSilenceDuration = opts.minSilenceDuration || 0;
        var minGapDuration     = opts.minGapDuration     || 0;

        if (!silenceIntervals || silenceIntervals.length === 0) return [];

        var shrunk = [];
        for (var i = 0; i < silenceIntervals.length; i++) {
            var s = silenceIntervals[i][0] + paddingOut;
            var e = silenceIntervals[i][1] - paddingIn;
            if (e > s) shrunk.push([s, e]);
        }
        if (shrunk.length === 0) return [];

        var merged = [shrunk[0].slice()];
        for (var j = 1; j < shrunk.length; j++) {
            var last = merged[merged.length - 1];
            var gap  = shrunk[j][0] - last[1];
            if (gap <= minGapDuration) last[1] = shrunk[j][1];
            else merged.push(shrunk[j].slice());
        }

        var valid = merged.filter(function (z) { return (z[1] - z[0]) >= minSilenceDuration; });

        for (var k = 0; k < valid.length; k++) {
            if (valid[k][0] < 0)             valid[k][0] = 0;
            if (valid[k][1] > totalDuration) valid[k][1] = totalDuration;
        }

        return mergeOverlapping(valid);
    }

    var TICKS_PER_SECOND = 254016000000;

    // seq.zeroPoint can be: string ticks (PPro pre-14), number ticks,
    // Time object with .seconds/.ticks (PPro 14+), or null/empty.
    // Number(timeObject) returns NaN, which is the bug this guards against.
    function parseZeroPoint(raw) {
        if (raw === null || raw === undefined || raw === "") return 0;
        if (typeof raw === "object") {
            if (typeof raw.seconds === "number" && !isNaN(raw.seconds)) {
                return raw.seconds;
            }
            if (raw.ticks !== undefined) {
                var t = Number(raw.ticks);
                return isNaN(t) ? 0 : t / TICKS_PER_SECOND;
            }
            return 0;
        }
        var n = Number(raw);
        if (isNaN(n)) return 0;
        return n / TICKS_PER_SECOND;
    }

    function jsxStringArg(value) {
        var normalized = String(value == null ? "" : value).replace(/\\/g, "/");
        return JSON.stringify(normalized);
    }

    // 29.97 / 59.94 drop-frame timecode (SMPTE 12M).
    // Skip 2 (or 4 for 60p) frames at start of every minute except every 10th.
    function secondsToDropTimecode(seconds, fps) {
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

    function secondsToTimecode(seconds, fps, isNTSC) {
        if (!fps || fps <= 0) fps = 30;
        var nominalFps = Math.round(fps);

        var totalFrames;
        if (isNTSC) {
            totalFrames = Math.round(seconds * nominalFps * 1000 / 1001);
        } else {
            totalFrames = Math.round(seconds * fps);
        }

        var framesPerSec = nominalFps;
        var ff = totalFrames % framesPerSec;
        var totalSec = Math.floor(totalFrames / framesPerSec);
        var ss = totalSec % 60;
        var totalMin = Math.floor(totalSec / 60);
        var mm = totalMin % 60;
        var hh = Math.floor(totalMin / 60);

        function pad(n) { return n < 10 ? "0" + n : "" + n; }
        return pad(hh) + ":" + pad(mm) + ":" + pad(ss) + ":" + pad(ff);
    }

    return {
        computeSilenceCutZones: computeSilenceCutZones,
        secondsToTimecode:      secondsToTimecode,
        secondsToDropTimecode:  secondsToDropTimecode,
        parseZeroPoint:         parseZeroPoint,
        jsxStringArg:           jsxStringArg,
        _internals:             { mergeOverlapping: mergeOverlapping }
    };
}));
