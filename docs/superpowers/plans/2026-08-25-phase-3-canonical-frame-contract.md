# Phase 3 Canonical Frame Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use integer frames as the only cut-zone boundary contract and remove silent or duplicated time conversions.

**Architecture:** Premiere supplies exact `timebaseTicks` and display format. Pure client math converts analysis seconds to integer frames; host code converts frames to ticks and the single QE timecode representation at the razor boundary. Strict JSON parsing and one documented zero-point convention replace heuristics and `eval`.

**Tech Stack:** CEP JavaScript, ExtendScript ES3, Premiere timebase ticks, `node:test`

---

## File structure

- Modify `client/js/cutZones.js`: production cut algorithm and frame-only interval utilities.
- Modify `client/js/main.js`: remove inline math/fallbacks and send `{startFrame,endFrame}` only.
- Create `host/timebase.js`: exact timebase table and frame/tick/timecode conversion.
- Create `host/jsonCompat.js`: strict recursive-descent JSON parser for ExtendScript.
- Modify `host/index.jsx`: include helpers, fail on unknown timebase, enforce one zero-point convention.
- Modify `tests/cutZones.test.js`, `tests/timecode.test.js`, `tests/zeroPoint.test.js`, and `tests/exportWorkflow.test.js`.
- Create `docs/superpowers/validation/premiere-phase-3-timebase.md`.

### Task 1: Move the production cut algorithm into the tested module

**Files:**
- Modify: `client/js/cutZones.js`
- Modify: `client/js/main.js:821-977`
- Modify: `tests/cutZones.test.js`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing production-algorithm tests**

```js
test("computeCleanCutZones applies padding, duration, gap fill, and minimum clip rules", () => {
    const zones = cutZones.computeCleanCutZones([[1, 3], [3.1, 5]], 8, {
        paddingIn: 0.1,
        paddingOut: 0.2,
        minSilenceDuration: 0.5,
        minGapDuration: 0.2,
        minClipDuration: 0.5,
    });
    assert.deepEqual(zones, [[1.2, 4.9]]);
});

test("panel calls the exported production algorithm", () => {
    const main = readProjectFile("client/js/main.js");
    assert.match(main, /getCutZoneHelpers\(\)\.computeCleanCutZones/);
    assert.doesNotMatch(main, /function computeCleanCutZones\(/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/cutZones.test.js tests/exportWorkflow.test.js --test-name-pattern="computeCleanCutZones|exported production"`

Expected: failures because production behavior remains inline.

- [ ] **Step 3: Move the exact algorithm and remove the competitor**

Move `computeCleanCutZones` from `main.js` into the `cutZones.js` factory and export it. Replace the panel call with:

```js
var helpers = getCutZoneHelpers();
var rangedCuts = helpers.computeCleanCutZones(result.silenceIntervals, result.mediaDuration, options);
```

Remove `computeSilenceCutZones` and update its tests to call `computeCleanCutZones` with the same explicit options.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/cutZones.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass and only one `function computeCleanCutZones` exists under `client/`.

- [ ] **Step 5: Commit**

```bash
git add client/js/cutZones.js client/js/main.js tests/cutZones.test.js tests/exportWorkflow.test.js
git commit -m "refactor(cuts): test production zone math"
```

### Task 2: Exact timebase model

**Files:**
- Create: `host/timebase.js`
- Create: `tests/hostTimebase.test.js`
- Modify: `host/index.jsx:36-141, 154-233, 518-606`

- [ ] **Step 1: Write failing exact-timebase tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const timebase = require("../host/timebase");

[
    ["10600670880", 23.976, 24],
    ["10160640000", 25, 25],
    ["8475667200", 29.97, 30],
    ["5295033540", 47.952, 48],
    ["5080320000", 50, 50],
    ["4237833600", 59.94, 60],
    ["2118916800", 119.88, 120],
].forEach(([ticks, fps, nominal]) => test(`resolves ${fps}`, () => {
    assert.deepEqual(timebase.resolveTimebase(ticks), { frameTicks: ticks, fps, nominalFps: nominal, ntsc: fps !== nominal });
}));

test("unknown timebase returns null", () => assert.equal(timebase.resolveTimebase("1"), null));
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/hostTimebase.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the ES3-compatible lookup**

```js
var DuckycutTimebase = (function () {
    var TABLE = {
        "10600670880": { fps: 23.976, nominalFps: 24, ntsc: true },
        "10160640000": { fps: 25, nominalFps: 25, ntsc: false },
        "8475667200": { fps: 29.97, nominalFps: 30, ntsc: true },
        "5295033540": { fps: 47.952, nominalFps: 48, ntsc: true },
        "5080320000": { fps: 50, nominalFps: 50, ntsc: false },
        "4237833600": { fps: 59.94, nominalFps: 60, ntsc: true },
        "2118916800": { fps: 119.88, nominalFps: 120, ntsc: true }
    };
    function resolveTimebase(value) {
        var key = String(value);
        var found = TABLE[key];
        return found ? { frameTicks: key, fps: found.fps, nominalFps: found.nominalFps, ntsc: found.ntsc } : null;
    }
    function frameToTicks(frame, info) { return String(Math.round(Number(frame)) * Number(info.frameTicks)); }
    return { resolveTimebase: resolveTimebase, frameToTicks: frameToTicks };
}());
if (typeof module === "object" && module.exports) module.exports = DuckycutTimebase;
```

- [ ] **Step 4: Integrate strict failure**

Add `#include "timebase.js"` to `host/index.jsx`. In both `getActiveSequenceInfo` and `getSequenceSettings`, replace the `29.97` fallback with:

```jsx
var timebase = DuckycutTimebase.resolveTimebase(String(seq.timebase));
if (!timebase) return JSON.stringify({ success: false, code: "UNSUPPORTED_TIMEBASE", timebaseTicks: String(seq.timebase) });
```

Run: `node --test tests/hostTimebase.test.js tests/exportWorkflow.test.js tests/timecode.test.js`

Expected: all focused tests pass; no `var fps = 29.97` remains in host code.

- [ ] **Step 5: Commit**

```bash
git add host/timebase.js host/index.jsx tests/hostTimebase.test.js tests/exportWorkflow.test.js tests/timecode.test.js
git commit -m "fix(time): require exact sequence timebase"
```

### Task 3: Frame-only panel-to-host contract

**Files:**
- Modify: `client/js/cutZones.js`
- Modify: `client/js/main.js:821-1150`
- Modify: `host/index.jsx:668-1236`
- Modify: `tests/cutZones.test.js`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing frame-contract tests**

```js
test("seconds intervals convert to merged integer frame zones", () => {
    assert.deepEqual(cutZones.toFrameZones([[0.033, 0.067], [0.066, 0.1]], { fps: 30, nominalFps: 30, ntsc: false }), [
        { startFrame: 1, endFrame: 3 },
    ]);
});

test("panel apply payload contains frames and no seconds or ticks", () => {
    const main = readProjectFile("client/js/main.js");
    const fn = main.slice(main.indexOf("function applyCutsInPlaceFromPanel"), main.indexOf("// ── UI Helpers"));
    assert.match(fn, /toFrameZones/);
    assert.doesNotMatch(fn, /startTicks|endTicks|snapSecondsToFrame/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/cutZones.test.js tests/exportWorkflow.test.js --test-name-pattern="integer frame zones|payload contains frames"`

Expected: 2 failures.

- [ ] **Step 3: Implement frame conversion in `cutZones.js`**

```js
function secondsToFrame(seconds, info) {
    var rate = info.ntsc ? info.nominalFps * 1000 / 1001 : info.fps;
    return Math.round(Number(seconds) * rate);
}
function toFrameZones(intervals, info) {
    var frames = [];
    for (var i = 0; i < intervals.length; i++) {
        var startFrame = secondsToFrame(intervals[i][0], info);
        var endFrame = secondsToFrame(intervals[i][1], info);
        if (endFrame > startFrame) frames.push([startFrame, endFrame]);
    }
    var merged = mergeOverlapping(frames);
    return merged.map(function (zone) { return { startFrame: zone[0], endFrame: zone[1] }; });
}
```

Export `secondsToFrame` and `toFrameZones`. Remove `prepareTickCutZonesForApply`, `secondsToTicksString`, client timecode functions, and inline equivalents from `main.js`.

- [ ] **Step 4: Convert only at the host boundary**

In `host/index.jsx`, validate integer non-negative frames and use `DuckycutTimebase.frameToTicks(frame, timebase)` only for clip comparisons and QE formatting. Reject invalid zones with `INVALID_FRAME_ZONE` before duplication.

Run: `npm test`

Expected: all tests pass and `rg -n "startTicks|endTicks|secondsToTimecode|secondsToDropTimecode" client` returns no production matches.

- [ ] **Step 5: Commit**

```bash
git add client/js/cutZones.js client/js/main.js host/index.jsx tests/cutZones.test.js tests/exportWorkflow.test.js
git commit -m "refactor(time): send frame-only cut zones"
```

### Task 4: Strict JSON parsing and zero-point convention

**Files:**
- Create: `host/jsonCompat.js`
- Create: `tests/jsonCompat.test.js`
- Modify: `host/index.jsx:40-78, 607-667, 668-690, 1223-1236`
- Modify: `tests/zeroPoint.test.js`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing parser and zero-point tests**

```js
test("strict parser accepts JSON and rejects executable expressions", () => {
    const json = require("../host/jsonCompat");
    assert.deepEqual(json.parse('{"zones":[1,true,null]}'), { zones: [1, true, null] });
    assert.throws(() => json.parse('({"x":1})'));
    assert.throws(() => json.parse('{"x":(function(){return 1})()}'));
});

test("host never evals panel payloads", () => {
    const host = readProjectFile("host/index.jsx");
    assert.doesNotMatch(host, /eval\("\("\s*\+/);
    assert.match(host, /DuckycutJSON\.parse/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/jsonCompat.test.js tests/exportWorkflow.test.js --test-name-pattern="strict parser|never evals"`

Expected: failures because the parser does not exist and host payloads use `eval`.

- [ ] **Step 3: Implement a strict ES3 parser**

Create `host/jsonCompat.js` as a recursive-descent parser with `at`, `ch`, `next`, `white`, `string`, `number`, `word`, `array`, `object`, and `value` functions. It must accept only JSON whitespace, escapes, finite numbers, `true`, `false`, and `null`; reject trailing characters; and expose:

```js
var DuckycutJSON = (function () {
    function parse(source) {
        var at = 0, ch = " ", text = String(source);
        function error(message) { throw new SyntaxError(message + " at " + at); }
        function next(expected) { if (expected && expected !== ch) error("Expected " + expected); ch = text.charAt(at); at += 1; return ch; }
        function white() { while (ch && ch <= " ") next(); }
        function string() {
            var out = ""; if (ch !== '"') error("Expected string");
            while (next()) { if (ch === '"') { next(); return out; } if (ch === "\\") { next(); var escapes = { '"':'"', '\\':'\\', '/':'/', b:'\b', f:'\f', n:'\n', r:'\r', t:'\t' }; if (ch === "u") { var hex=""; for(var i=0;i<4;i++){ next(); hex+=ch; } out+=String.fromCharCode(parseInt(hex,16)); } else if (escapes[ch]) out+=escapes[ch]; else error("Bad escape"); } else out += ch; }
            error("Unterminated string");
        }
        function number() { var value=""; if(ch==="-"){value="-";next();} while(ch>="0"&&ch<="9"){value+=ch;next();} if(ch==="."){do{value+=ch;next();}while(ch>="0"&&ch<="9");} if(ch==="e"||ch==="E"){value+=ch;next();if(ch==="-"||ch==="+"){value+=ch;next();}while(ch>="0"&&ch<="9"){value+=ch;next();}} var n=Number(value); if(!isFinite(n)) error("Bad number"); return n; }
        function word() { if(ch==="t"){next("t");next("r");next("u");next("e");return true;} if(ch==="f"){next("f");next("a");next("l");next("s");next("e");return false;} if(ch==="n"){next("n");next("u");next("l");next("l");return null;} error("Unexpected token"); }
        function array() { var out=[]; next("["); white(); if(ch==="]"){next();return out;} while(ch){out.push(value());white();if(ch==="]"){next();return out;}next(",");white();} error("Bad array"); }
        function object() { var out={}; next("{"); white(); if(ch==="}"){next();return out;} while(ch){var key=string();white();next(":");out[key]=value();white();if(ch==="}"){next();return out;}next(",");white();} error("Bad object"); }
        function value() { white(); if(ch==="{")return object(); if(ch==="[")return array(); if(ch==='"')return string(); if(ch==="-"||(ch>="0"&&ch<="9"))return number(); return word(); }
        next(); var result=value(); white(); if(ch) error("Trailing characters"); return result;
    }
    return { parse: parse };
}());
if (typeof module === "object" && module.exports) module.exports = DuckycutJSON;
```

- [ ] **Step 4: Replace `eval` and fix zero-point behavior**

Include `jsonCompat.js`, parse every host entry payload with `DuckycutJSON.parse`, and return `INVALID_JSON` on syntax error. Document and enforce: Premiere In/Out ticks are sequence-relative; zero point is display metadata only and is never subtracted from In/Out. Replace heuristic tests with direct sequence-relative expectations.

Run: `node --test tests/jsonCompat.test.js tests/zeroPoint.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass and `rg -n "eval\\(" host/index.jsx` returns no matches.

- [ ] **Step 5: Commit**

```bash
git add host/jsonCompat.js host/index.jsx tests/jsonCompat.test.js tests/zeroPoint.test.js tests/exportWorkflow.test.js
git commit -m "fix(host): parse payloads without eval"
```

### Task 5: Duration validation and Premiere timebase matrix

**Files:**
- Modify: `client/js/main.js:703-880`
- Modify: `tests/exportWorkflow.test.js`
- Create: `docs/superpowers/validation/premiere-phase-3-timebase.md`

- [ ] **Step 1: Write failing analyzed-duration test**

```js
test("panel rejects render duration drift beyond one frame", () => {
    const main = readProjectFile("client/js/main.js");
    assert.match(main, /ANALYSIS_DURATION_MISMATCH/);
    assert.doesNotMatch(main, /result\.mediaDuration\s*=\s*seqSettings\.durationSeconds/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="duration drift"`

Expected: FAIL while sequence duration overwrites WAV duration.

- [ ] **Step 3: Validate within one frame**

```js
function assertAnalysisDuration(resultSeconds, rangeSeconds, timebase) {
    var driftFrames = Math.abs(getCutZoneHelpers().secondsToFrame(resultSeconds - rangeSeconds, timebase));
    if (driftFrames > 1) {
        var err = new Error("A duração renderizada não corresponde ao intervalo analisado.");
        err.code = "ANALYSIS_DURATION_MISMATCH";
        throw err;
    }
    return resultSeconds;
}
```

Use the validated WAV duration for the final zone and all estimates.

- [ ] **Step 4: Add and run the Premiere matrix**

Create the validation document with Full Sequence and In/Out cases for 24, 25, 29.97 DF/NDF, 47.952, 50, 59.94 DF/NDF, and 119.88; repeat 29.97 DF with zero points `00:00:00:00` and `01:00:00:00`. For each case, razor known frame 100 and confirm Premiere reports the same boundary.

Run: `npm test`

Expected: all automated tests pass.

- [ ] **Step 5: Commit the checkpoint**

```bash
git add client/js/main.js tests/exportWorkflow.test.js docs/superpowers/validation/premiere-phase-3-timebase.md
git commit -m "test(time): validate Premiere frame matrix"
```
