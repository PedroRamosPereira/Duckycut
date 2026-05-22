// client/js/vadTranslator.js
// Pure VAD timestamp translator. Loaded in the panel and in node:test.

(function (root, factory) {
    var api = factory();
    if (typeof module === "object" && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.Duckycut = root.Duckycut || {};
        root.Duckycut.vadTranslator = api;
    }
}(typeof self !== "undefined" ? self : this, function () {

    function toNumber(value, fallback) {
        var n = Number(value);
        return isFinite(n) ? n : fallback;
    }

    function mergeTouching(intervals) {
        if (!intervals || intervals.length === 0) return [];
        var sorted = intervals.slice().sort(function (a, b) { return a[0] - b[0]; });
        var out = [[sorted[0][0], sorted[0][1]]];

        for (var i = 1; i < sorted.length; i++) {
            var last = out[out.length - 1];
            if (sorted[i][0] <= last[1]) {
                last[1] = Math.max(last[1], sorted[i][1]);
            } else {
                out.push([sorted[i][0], sorted[i][1]]);
            }
        }
        return out;
    }

    function mergeSmallGaps(intervals, minGapDuration) {
        if (!intervals || intervals.length === 0) return [];
        var gap = Math.max(0, toNumber(minGapDuration, 0));
        var merged = [intervals[0].slice()];

        for (var i = 1; i < intervals.length; i++) {
            var last = merged[merged.length - 1];
            if ((intervals[i][0] - last[1]) <= gap) {
                last[1] = Math.max(last[1], intervals[i][1]);
            } else {
                merged.push(intervals[i].slice());
            }
        }
        return merged;
    }

    function computeVadKeepZones(speechIntervals, totalDuration, opts) {
        opts = opts || {};
        var duration = Math.max(0, toNumber(totalDuration, 0));
        if (!speechIntervals || speechIntervals.length === 0 || duration <= 0) return [];

        var paddingIn = Math.max(0, toNumber(opts.paddingIn, 0));
        var paddingOut = Math.max(0, toNumber(opts.paddingOut, 0));
        var minClipDuration = Math.max(0, toNumber(opts.minClipDuration, 0));
        var minGapDuration = Math.max(0, toNumber(opts.minGapDuration, 0));

        var padded = [];
        for (var i = 0; i < speechIntervals.length; i++) {
            var s = toNumber(speechIntervals[i][0], 0);
            var e = toNumber(speechIntervals[i][1], 0);
            if (!(e > s)) continue;
            padded.push([
                Math.max(0, s - paddingIn),
                Math.min(duration, e + paddingOut)
            ]);
        }

        var merged = mergeTouching(padded);
        merged = mergeSmallGaps(merged, minGapDuration);
        merged = mergeTouching(merged);

        if (minClipDuration > 0) {
            merged = merged.filter(function (z) { return (z[1] - z[0]) >= minClipDuration; });
        }
        return merged;
    }

    function offsetIntervals(intervals, offsetSeconds) {
        var offset = toNumber(offsetSeconds, 0);
        var out = [];
        if (!intervals) return out;
        for (var i = 0; i < intervals.length; i++) {
            out.push([toNumber(intervals[i][0], 0) + offset, toNumber(intervals[i][1], 0) + offset]);
        }
        return out;
    }

    function computeCutZonesFromKeepZones(keepZones, totalDuration) {
        var duration = Math.max(0, toNumber(totalDuration, 0));
        if (duration <= 0) return [];

        var sorted = [];
        if (keepZones) {
            for (var i = 0; i < keepZones.length; i++) {
                var s = Math.max(0, toNumber(keepZones[i][0], 0));
                var e = Math.min(duration, toNumber(keepZones[i][1], 0));
                if (e > s) sorted.push([s, e]);
            }
        }

        sorted = mergeTouching(sorted);

        var cuts = [];
        var cursor = 0;
        for (var j = 0; j < sorted.length; j++) {
            if (sorted[j][0] > cursor) cuts.push([cursor, sorted[j][0]]);
            cursor = Math.max(cursor, sorted[j][1]);
        }
        if (cursor < duration) cuts.push([cursor, duration]);
        return cuts;
    }

    return {
        computeVadKeepZones: computeVadKeepZones,
        computeCutZonesFromKeepZones: computeCutZonesFromKeepZones,
        offsetIntervals: offsetIntervals,
        _internals: {
            mergeTouching: mergeTouching,
            mergeSmallGaps: mergeSmallGaps
        }
    };
}));
