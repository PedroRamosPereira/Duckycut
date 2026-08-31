# Phase 1 Timeline Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cut application linear, cancellable, and non-destructive by default while rejecting unsafe timelines before removal.

**Architecture:** Add an ES3-compatible pure apply planner shared by Node tests and `host/index.jsx`. The host duplicates and preflights the sequence, razors all boundaries in one pass, reads geometry once, validates a complete plan, then removes targets from end to start. A disk sentinel provides cancellation without a concurrent `evalScript` call.

**Tech Stack:** Adobe CEP, ExtendScript ES3, QE DOM, Node.js `node:test`, filesystem sentinel

---

## File structure

- Create `host/applyPlanner.js`: pure clip-geometry validation and removal ordering; no Premiere APIs.
- Create `tests/applyPlanner.test.js`: asymmetric-track, missing-segment, tolerance, and ordering coverage.
- Modify `host/index.jsx`: include planner, duplicate/preflight, batch razor, one geometry read, structured results.
- Modify `client/js/main.js`: one host call, duplicate-by-default option, sentinel lifecycle, compact results.
- Modify `client/js/cutZones.js`: remove apply chunking from the public API after the panel stops using it.
- Modify `tests/exportWorkflow.test.js`: replace tests that require per-zone sleeps/chunks with stage-order contracts.
- Create `docs/superpowers/validation/premiere-phase-1-smoke.md`: exact Premiere validation matrix and undo spike.

### Task 1: Pure removal planner

**Files:**
- Create: `host/applyPlanner.js`
- Create: `tests/applyPlanner.test.js`

- [ ] **Step 1: Write failing planner tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const planner = require("../host/applyPlanner");

const geometry = [
    { trackType: "video", trackIndex: 0, clipIndex: 1, startFrame: 100, endFrame: 140 },
    { trackType: "audio", trackIndex: 0, clipIndex: 2, startFrame: 100, endFrame: 140 },
];

test("planRemovals requires one exact segment on every participating track", () => {
    assert.deepEqual(planner.planRemovals(geometry, [{ startFrame: 100, endFrame: 140 }], { toleranceFrames: 0 }), {
        ok: true,
        removals: [geometry[1], geometry[0]],
        zones: 1,
    });
});

test("planRemovals rejects a zone before mutation when a track segment is missing", () => {
    const result = planner.planRemovals(geometry.slice(0, 1), [{ startFrame: 100, endFrame: 140 }], {
        toleranceFrames: 0,
        requiredTracks: [{ trackType: "video", trackIndex: 0 }, { trackType: "audio", trackIndex: 0 }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "MISSING_RAZOR_SEGMENT");
    assert.deepEqual(result.track, { trackType: "audio", trackIndex: 0 });
});

test("planRemovals orders later clips first", () => {
    const result = planner.planRemovals([
        { trackType: "video", trackIndex: 0, clipIndex: 1, startFrame: 10, endFrame: 20 },
        { trackType: "video", trackIndex: 0, clipIndex: 2, startFrame: 30, endFrame: 40 },
    ], [{ startFrame: 10, endFrame: 20 }, { startFrame: 30, endFrame: 40 }], { toleranceFrames: 0 });
    assert.deepEqual(result.removals.map(x => x.startFrame), [30, 10]);
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `node --test tests/applyPlanner.test.js`

Expected: FAIL with `Cannot find module '../host/applyPlanner'`.

- [ ] **Step 3: Implement the ES3-compatible planner**

```js
var DuckycutApplyPlanner = (function () {
    function sameTrack(a, b) {
        return a.trackType === b.trackType && Number(a.trackIndex) === Number(b.trackIndex);
    }
    function matches(clip, zone, tolerance) {
        return Math.abs(Number(clip.startFrame) - Number(zone.startFrame)) <= tolerance &&
            Math.abs(Number(clip.endFrame) - Number(zone.endFrame)) <= tolerance;
    }
    function uniqueTracks(geometry) {
        var out = [];
        for (var i = 0; i < geometry.length; i++) {
            var track = { trackType: geometry[i].trackType, trackIndex: Number(geometry[i].trackIndex) };
            var seen = false;
            for (var j = 0; j < out.length; j++) if (sameTrack(out[j], track)) seen = true;
            if (!seen) out.push(track);
        }
        return out;
    }
    function planRemovals(geometry, zones, options) {
        options = options || {};
        var tolerance = Number(options.toleranceFrames || 0);
        var requiredTracks = options.requiredTracks || uniqueTracks(geometry || []);
        var removals = [];
        for (var z = 0; z < zones.length; z++) {
            for (var t = 0; t < requiredTracks.length; t++) {
                var found = null;
                for (var c = 0; c < geometry.length; c++) {
                    if (sameTrack(geometry[c], requiredTracks[t]) && matches(geometry[c], zones[z], tolerance)) {
                        if (found) return { ok: false, code: "AMBIGUOUS_RAZOR_SEGMENT", zoneIndex: z, track: requiredTracks[t] };
                        found = geometry[c];
                    }
                }
                if (!found) return { ok: false, code: "MISSING_RAZOR_SEGMENT", zoneIndex: z, track: requiredTracks[t] };
                removals.push(found);
            }
        }
        removals.sort(function (a, b) {
            if (b.startFrame !== a.startFrame) return b.startFrame - a.startFrame;
            if (a.trackType !== b.trackType) return a.trackType === "audio" ? -1 : 1;
            return b.trackIndex - a.trackIndex;
        });
        return { ok: true, removals: removals, zones: zones.length };
    }
    return { planRemovals: planRemovals };
}());
if (typeof module === "object" && module.exports) module.exports = DuckycutApplyPlanner;
```

- [ ] **Step 4: Run the planner tests**

Run: `node --test tests/applyPlanner.test.js`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add host/applyPlanner.js tests/applyPlanner.test.js
git commit -m "test(host): add pure removal planner"
```

### Task 2: Preflight and duplicate sequence

**Files:**
- Modify: `host/index.jsx:1-40`
- Modify: `host/index.jsx:668-760`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Add failing host contract tests**

```js
test("host duplicates and preflights before razor", () => {
    const host = readProjectFile("host/index.jsx");
    const fn = host.slice(host.indexOf("function applyCutsInPlace("), host.indexOf("function applyCutsInPlaceFile("));
    const duplicate = fn.indexOf("_duplicateSequenceForApply");
    const preflight = fn.indexOf("_preflightApply");
    const razor = fn.indexOf("_razorAllZones");
    assert.ok(duplicate !== -1 && duplicate < preflight && preflight < razor);
    assert.match(fn, /duplicateSequence\s*!==\s*false/);
});

test("host preflight rejects locked tracks and unknown timebase", () => {
    const host = readProjectFile("host/index.jsx");
    assert.match(host, /code:\s*"LOCKED_TRACK"/);
    assert.match(host, /code:\s*"UNSUPPORTED_TIMEBASE"/);
});
```

- [ ] **Step 2: Verify the contracts fail**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="duplicates and preflights|preflight rejects"`

Expected: 2 failures because the helpers and typed errors do not exist.

- [ ] **Step 3: Include the planner and add host helpers**

Add at the beginning of `host/index.jsx`:

```jsx
#include "applyPlanner.js"
```

Add before `applyCutsInPlace`:

```jsx
function _duplicateSequenceForApply(sourceSeq) {
    var sourceId = String(sourceSeq.sequenceID);
    var sourceName = String(sourceSeq.name);
    if (!sourceSeq.clone()) return { ok: false, code: "SEQUENCE_DUPLICATE_FAILED" };
    var copy = app.project.activeSequence;
    if (!copy || String(copy.sequenceID) === sourceId) return { ok: false, code: "SEQUENCE_DUPLICATE_FAILED" };
    copy.name = sourceName + " - Duckycut";
    return { ok: true, sequence: copy, sourceSequenceID: sourceId };
}

function _preflightApply(seq, opts) {
    var frameTicks = Number(seq.timebase);
    if (!(frameTicks > 0)) return { ok: false, code: "UNSUPPORTED_TIMEBASE" };
    var groups = [{ type: "video", tracks: seq.videoTracks }, { type: "audio", tracks: seq.audioTracks }];
    var requiredTracks = [];
    for (var g = 0; g < groups.length; g++) {
        for (var i = 0; i < groups[g].tracks.numTracks; i++) {
            var track = groups[g].tracks[i];
            if (track.isLocked && track.isLocked()) {
                return { ok: false, code: "LOCKED_TRACK", trackType: groups[g].type, trackIndex: i };
            }
            if (track.clips && track.clips.numItems > 0) requiredTracks.push({ trackType: groups[g].type, trackIndex: i });
        }
    }
    return { ok: true, frameTicks: frameTicks, requiredTracks: requiredTracks };
}
```

- [ ] **Step 4: Make duplication the default and run contracts**

At the top of `applyCutsInPlace`, parse options, retain the original sequence identity, and use:

```jsx
var sourceSeq = app.project.activeSequence;
var duplicate = opts.duplicateSequence !== false ? _duplicateSequenceForApply(sourceSeq) : { ok: true, sequence: sourceSeq, sourceSequenceID: String(sourceSeq.sequenceID) };
if (!duplicate.ok) return JSON.stringify({ success: false, stage: "duplicate", code: duplicate.code, applied: 0, skipped: 0 });
var seq = duplicate.sequence;
var preflight = _preflightApply(seq, opts);
if (!preflight.ok) return JSON.stringify({ success: false, stage: "preflight", code: preflight.code, trackType: preflight.trackType, trackIndex: preflight.trackIndex, applied: 0, skipped: 0, sequenceID: String(seq.sequenceID) });
```

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="duplicates and preflights|preflight rejects"`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add host/index.jsx tests/exportWorkflow.test.js
git commit -m "feat(host): preflight duplicate sequence"
```

### Task 3: Batch razor, one refresh, and validated removal

**Files:**
- Modify: `host/index.jsx:668-1222`
- Modify: `tests/exportWorkflow.test.js`
- Modify: `tests/applyPlanner.test.js`

- [ ] **Step 1: Replace obsolete polling expectations with failing stage-order tests**

```js
test("host razors all zones before collecting geometry once", () => {
    const host = readProjectFile("host/index.jsx");
    const fn = host.slice(host.indexOf("function applyCutsInPlace("), host.indexOf("function applyCutsInPlaceFile("));
    assert.ok(fn.indexOf("_razorAllZones") < fn.indexOf("_collectTimelineGeometry"));
    assert.ok(fn.indexOf("_collectTimelineGeometry") < fn.indexOf("DuckycutApplyPlanner.planRemovals"));
    assert.doesNotMatch(fn, /\$\.sleep/);
    assert.doesNotMatch(fn, /_waitForRazorRefresh|_waitForContainedTargets/);
});

test("host validates every target before the first remove", () => {
    const host = readProjectFile("host/index.jsx");
    const fn = host.slice(host.indexOf("function applyCutsInPlace("), host.indexOf("function applyCutsInPlaceFile("));
    assert.ok(fn.indexOf("planRemovals") < fn.indexOf("_removePlannedTargets"));
    assert.match(fn, /toleranceFrames:\s*1/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="razors all zones|validates every target"`

Expected: 2 failures on missing batch helpers.

- [ ] **Step 3: Add batch helpers and replace the per-zone loop**

```jsx
function _razorAllZones(qeSeq, zones, requiredTracks, toTimecode) {
    for (var z = 0; z < zones.length; z++) {
        var startTC = toTimecode(zones[z].startFrame);
        var endTC = toTimecode(zones[z].endFrame);
        for (var t = 0; t < requiredTracks.length; t++) {
            var track = requiredTracks[t];
            var qeTrack = track.trackType === "video" ? qeSeq.getVideoTrackAt(track.trackIndex) : qeSeq.getAudioTrackAt(track.trackIndex);
            qeTrack.razor(startTC);
            qeTrack.razor(endTC);
        }
    }
}

function _collectTimelineGeometry(seq, frameTicks) {
    var out = [];
    var groups = [{ type: "video", tracks: seq.videoTracks }, { type: "audio", tracks: seq.audioTracks }];
    for (var g = 0; g < groups.length; g++) for (var t = 0; t < groups[g].tracks.numTracks; t++) {
        var clips = groups[g].tracks[t].clips;
        for (var c = 0; c < clips.numItems; c++) out.push({
            trackType: groups[g].type,
            trackIndex: t,
            clipIndex: c,
            startFrame: Math.round(Number(clips[c].start.ticks) / frameTicks),
            endFrame: Math.round(Number(clips[c].end.ticks) / frameTicks),
            clip: clips[c]
        });
    }
    return out;
}

function _removePlannedTargets(removals) {
    for (var i = 0; i < removals.length; i++) removals[i].clip.remove(i === removals.length - 1, true);
}
```

Replace the old retry/chunk loop with this exact stage sequence:

```jsx
_razorAllZones(qeSeq, zones, preflight.requiredTracks, _frameToQeTimecode);
var geometry = _collectTimelineGeometry(seq, preflight.frameTicks);
var plan = DuckycutApplyPlanner.planRemovals(geometry, zones, { requiredTracks: preflight.requiredTracks, toleranceFrames: 1 });
if (!plan.ok) return JSON.stringify({ success: false, stage: "validate", code: plan.code, zoneIndex: plan.zoneIndex, track: plan.track, applied: 0, skipped: 0, sequenceID: String(seq.sequenceID) });
_removePlannedTargets(plan.removals);
return JSON.stringify({ success: true, applied: plan.zones, skipped: 0, sequenceID: String(seq.sequenceID), sequenceName: String(seq.name) });
```

- [ ] **Step 4: Run focused and full tests**

Run: `node --test tests/applyPlanner.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass; obsolete tests that explicitly require chunk delays, six-frame tolerance, or per-zone diagnostics have been replaced, not weakened.

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add host/index.jsx tests/applyPlanner.test.js tests/exportWorkflow.test.js
git commit -m "perf(host): batch timeline cuts"
```

### Task 4: Filesystem cancellation and single-call panel apply

**Files:**
- Modify: `client/js/main.js:17-20, 1021-1275`
- Modify: `client/js/cutZones.js:90-125, 245-255`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing cancellation contracts**

```js
test("panel cancellation creates a sentinel instead of queueing evalScript", () => {
    const main = readProjectFile("client/js/main.js");
    const cancel = main.slice(main.indexOf("function cancelApplyCutsFromPanel"), main.indexOf("function applyCutsInPlaceFromPanel"));
    assert.match(cancel, /writeFileSync\(applyCancelSentinelPath/);
    assert.doesNotMatch(cancel, /evalScript\("cancelApplyCuts/);
});

test("panel sends all frame zones in one host call", () => {
    const main = readProjectFile("client/js/main.js");
    const fn = main.slice(main.indexOf("function applyCutsInPlaceFromPanel"), main.indexOf("// ── UI Helpers"));
    assert.doesNotMatch(fn, /chunkArray|APPLY_CUTS_CHUNK/);
    assert.match(fn, /duplicateSequence:\s*true/);
    assert.match(fn, /cancelSentinelPath/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="cancellation creates|all frame zones"`

Expected: 2 failures.

- [ ] **Step 3: Implement sentinel lifecycle**

Add panel state and helpers:

```js
let applyCancelSentinelPath = null;
function createApplyCancelSentinelPath() {
    return nodePath.join(nodeOs.tmpdir(), "duckycut-cancel-" + Date.now() + ".flag");
}
function clearApplyCancelSentinel() {
    if (applyCancelSentinelPath && nodeFs.existsSync(applyCancelSentinelPath)) nodeFs.unlinkSync(applyCancelSentinelPath);
}
function cancelApplyCutsFromPanel() {
    applyCancelRequested = true;
    if (applyCancelSentinelPath) nodeFs.writeFileSync(applyCancelSentinelPath, "cancel\n", "utf8");
    setStatus("Cancelamento solicitado; concluindo a etapa segura atual.", "warning");
}
```

Before the one `applyCutsInPlace` call:

```js
applyCancelSentinelPath = createApplyCancelSentinelPath();
clearApplyCancelSentinel();
var options = {
    duplicateSequence: true,
    cancelSentinelPath: applyCancelSentinelPath,
    debug: false,
    range: analysisRangeInfo
};
return evalScript("applyCutsInPlace(" + jsxStringArg(JSON.stringify(frameZones)) + "," + jsxStringArg(JSON.stringify(options)) + ")")
    .then(handleApplyResult)
    .finally(function () { clearApplyCancelSentinel(); applyCancelSentinelPath = null; });
```

Add to `host/index.jsx` and call it between duplicate, razor, geometry, validate, and remove stages:

```jsx
function _isSentinelCancelled(pathValue) {
    if (!pathValue) return false;
    try { return new File(String(pathValue)).exists; } catch (e) { return false; }
}
```

- [ ] **Step 4: Remove chunk exports and run tests**

Remove `APPLY_CUTS_CHUNK_SIZE`, `APPLY_CUTS_CHUNK_SETTLE_DELAY_MS`, and `chunkArray` from production code and the `cutZones.js` export.

Run: `npm test`

Expected: all tests pass and no production match for `APPLY_CUTS_CHUNK` remains.

- [ ] **Step 5: Commit**

```bash
git add client/js/main.js client/js/cutZones.js host/index.jsx tests/exportWorkflow.test.js tests/cutZones.test.js
git commit -m "feat(apply): add safe cancellation"
```

### Task 5: Compact diagnostics and Phase 1 Premiere validation

**Files:**
- Modify: `client/js/main.js:156-176, 1097-1275`
- Modify: `host/index.jsx:668-1236`
- Modify: `tests/exportWorkflow.test.js`
- Create: `docs/superpowers/validation/premiere-phase-1-smoke.md`

- [ ] **Step 1: Add failing compact-result tests**

```js
test("production apply response excludes per-zone diagnostics", () => {
    const host = readProjectFile("host/index.jsx");
    const fn = host.slice(host.indexOf("function applyCutsInPlace("), host.indexOf("function applyCutsInPlaceFile("));
    assert.doesNotMatch(fn, /_zoneDiag|candidateClips/);
    assert.match(fn, /opts\.debug/);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="excludes per-zone"`

Expected: FAIL while unconditional diagnostic payloads remain.

- [ ] **Step 3: Gate debug logs and add the smoke document**

Production success must be exactly:

```jsx
{ success: true, applied: plan.zones, skipped: 0, sequenceID: String(seq.sequenceID), sequenceName: String(seq.name) }
```

Only when `opts.debug === true`, add a single `_diag` object containing stage durations and counts; never include clip objects.

Write `docs/superpowers/validation/premiere-phase-1-smoke.md` with this executable matrix:

```markdown
# Premiere Phase 1 Smoke Test

1. Open a saved 29.97 DF project with zero point 01:00:00:00.
2. Use two video and two audio tracks; leave one asymmetric gap and place one transition across a proposed zone.
3. Analyze and apply with duplication enabled.
4. Confirm the original sequence is byte-for-byte visually unchanged and the duplicate is named `<source> - Duckycut`.
5. Confirm preflight blocks locked tracks and transition intersections before razor.
6. Remove the transition, retry, and confirm every track stays synchronized.
7. Create the cancellation sentinel after razor and confirm no removal begins.
8. Time 500 zones; record Premiere version, hardware, zone count, razor time, validation time, removal time, and total time.
9. Press Ctrl+Z once. Record whether the whole apply reverses; sequence duplication remains mandatory regardless of the result.
```

- [ ] **Step 4: Run automated verification**

Run: `npm test`

Expected: all tests pass.

Run: `rg -n "\\$\\.sleep|_waitForRazorRefresh|_waitForContainedTargets|BOUNDARY_TOLERANCE_FRAMES\\s*=\\s*6|APPLY_CUTS_CHUNK" host client tests`

Expected: no production matches; historical text may remain only in the design document.

- [ ] **Step 5: Run the manual matrix and commit the checkpoint**

Expected: original sequence unchanged, no desynchronization, pre-removal cancellation consistent, and timing recorded in the smoke document.

```bash
git add client/js/main.js host/index.jsx tests/exportWorkflow.test.js docs/superpowers/validation/premiere-phase-1-smoke.md
git commit -m "test(apply): validate safe timeline flow"
```
