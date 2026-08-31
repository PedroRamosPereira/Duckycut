# Phase 4 Review-First UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Analyze produce a visible, adjustable result and make Apply perform only the reviewed timeline mutation.

**Architecture:** Replace the five-screen wizard with an analyze-review-apply state machine. Cached analysis results feed pure zone recomputation and a canvas waveform; settings, presets, and strings live in focused modules. The UI renders structured state and never starts hidden detection from Apply.

**Tech Stack:** CEP HTML/CSS/JavaScript, Canvas 2D, Node filesystem, Brazilian Portuguese locale, `node:test`

---

## File structure

- Create `client/js/workflowState.js`: pure analyze-review-apply state transitions.
- Create `server/waveformPeaks.js`: bounded WAV peak extraction.
- Create `client/js/waveform.js`: canvas drawing and zone overlays.
- Create `client/js/settingsStore.js`: JSON persistence and named presets.
- Create `client/js/i18n.js`: locale dictionary and interpolation.
- Modify `client/index.html`, `client/css/styles.css`, and `client/js/main.js`.
- Add `tests/workflowState.test.js`, `tests/waveformPeaks.test.js`, `tests/waveform.test.js`, `tests/settingsStore.test.js`, and `tests/i18n.test.js`.

### Task 1: Analyze-review-apply state machine

**Files:**
- Create: `client/js/workflowState.js`
- Create: `tests/workflowState.test.js`
- Modify: `client/index.html`
- Modify: `client/js/main.js:116-238, 703-1084`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing workflow tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const workflow = require("../client/js/workflowState");

test("analysis result enters review before apply", () => {
    let state = workflow.initial();
    state = workflow.reduce(state, { type: "ANALYZE_STARTED" });
    state = workflow.reduce(state, { type: "ANALYZE_COMPLETED", result: { mediaDuration: 10 }, zones: [{ startFrame: 2, endFrame: 4 }] });
    assert.equal(state.screen, "review");
    assert.equal(state.canApply, true);
});

test("apply cannot begin without reviewed zones", () => {
    assert.throws(() => workflow.reduce(workflow.initial(), { type: "APPLY_STARTED" }), /reviewed analysis/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/workflowState.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure reducer**

```js
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { root.Duckycut = root.Duckycut || {}; root.Duckycut.workflowState = factory(); }
}(typeof self !== "undefined" ? self : this, function () {
    function initial() { return { screen: "setup", busy: false, canApply: false, result: null, zones: null, error: null }; }
    function reduce(state, event) {
        if (event.type === "ANALYZE_STARTED") return { screen: "analyzing", busy: true, canApply: false, result: null, zones: null, error: null };
        if (event.type === "ANALYZE_COMPLETED") return { screen: "review", busy: false, canApply: true, result: event.result, zones: event.zones, error: null };
        if (event.type === "ANALYZE_FAILED") return { screen: "setup", busy: false, canApply: false, result: null, zones: null, error: event.error };
        if (event.type === "APPLY_STARTED") {
            if (!state.canApply || !state.zones) throw new Error("Apply requires reviewed analysis");
            return { screen: "applying", busy: true, canApply: false, result: state.result, zones: state.zones, error: null };
        }
        if (event.type === "APPLY_COMPLETED") return { screen: "done", busy: false, canApply: false, result: event.result, zones: state.zones, error: null };
        if (event.type === "BACK") return { screen: "setup", busy: false, canApply: false, result: state.result, zones: state.zones, error: null };
        return state;
    }
    return { initial: initial, reduce: reduce };
}));
```

- [ ] **Step 4: Integrate the three visible states**

Load `workflowState.js` before `main.js`. Rename screens to `setup`, `analyzing`, `review`, `applying`, and `done`, but show setup and review within one responsive workspace. `runAnalysis` must complete render plus detection, dispatch `ANALYZE_COMPLETED`, calculate zones, call `showResults`, and show review. `applyCuts` must dispatch `APPLY_STARTED` and call only `applyCutsInPlaceFromPanel`; remove `prepareCutZonesFromCurrentConfig` from Apply.

Run: `node --test tests/workflowState.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass; no test states that Apply starts FFmpeg or VAD.

- [ ] **Step 5: Commit**

```bash
git add client/index.html client/js/workflowState.js client/js/main.js tests/workflowState.test.js tests/exportWorkflow.test.js
git commit -m "feat(panel): review analysis before apply"
```

### Task 2: Waveform peaks and canvas renderer

**Files:**
- Create: `server/waveformPeaks.js`
- Create: `tests/waveformPeaks.test.js`
- Create: `client/js/waveform.js`
- Create: `tests/waveform.test.js`
- Modify: `client/index.html`
- Modify: `client/js/main.js`

- [ ] **Step 1: Write failing peak and projection tests**

```js
test("buildPeaks returns bounded min/max buckets", () => {
    const { buildPeaksFromSamples } = require("../server/waveformPeaks");
    assert.deepEqual(buildPeaksFromSamples(new Float32Array([-1, 0.5, -0.25, 1]), 2), [
        { min: -1, max: 0.5 }, { min: -0.25, max: 1 },
    ]);
});

test("zoneRect projects frame zones to canvas coordinates", () => {
    const waveform = require("../client/js/waveform");
    assert.deepEqual(waveform.zoneRect({ startFrame: 25, endFrame: 50 }, 100, 400), { x: 100, width: 100 });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/waveformPeaks.test.js tests/waveform.test.js`

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement bounded peak extraction**

```js
function buildPeaksFromSamples(samples, bucketCount) {
    const out = [];
    const bucketSize = Math.max(1, Math.ceil(samples.length / bucketCount));
    for (let start = 0; start < samples.length; start += bucketSize) {
        let min = 1, max = -1;
        for (let i = start; i < Math.min(start + bucketSize, samples.length); i++) {
            min = Math.min(min, samples[i]); max = Math.max(max, samples[i]);
        }
        out.push({ min, max });
    }
    return out;
}
module.exports = { buildPeaksFromSamples, buildPeaks };
```

`buildPeaks(wavPath, bucketCount)` must reuse `openPcm16MonoWav`, read bounded windows, and cap output at `bucketCount` entries.

- [ ] **Step 4: Implement and mount the renderer**

```js
function zoneRect(zone, totalFrames, width) {
    return { x: Math.round(zone.startFrame / totalFrames * width), width: Math.max(1, Math.round((zone.endFrame - zone.startFrame) / totalFrames * width)) };
}
function draw(canvas, model) {
    var ctx = canvas.getContext("2d"), width = canvas.clientWidth, height = canvas.clientHeight;
    canvas.width = width; canvas.height = height; ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#9aa4b2"; ctx.beginPath();
    for (var i = 0; i < model.peaks.length; i++) {
        var x = i / model.peaks.length * width;
        ctx.moveTo(x, (1 - model.peaks[i].max) * height / 2);
        ctx.lineTo(x, (1 - model.peaks[i].min) * height / 2);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(239, 68, 68, .28)";
    for (var z = 0; z < model.zones.length; z++) { var rect = zoneRect(model.zones[z], model.totalFrames, width); ctx.fillRect(rect.x, 0, rect.width, height); }
}
```

Add `<canvas id="waveform" role="img" aria-label="Forma de onda com regiões de corte"></canvas>` to review and redraw it after analysis and every slider input without rerunning export or ONNX.

Run: `node --test tests/waveformPeaks.test.js tests/waveform.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/waveformPeaks.js client/js/waveform.js client/index.html client/js/main.js tests/waveformPeaks.test.js tests/waveform.test.js tests/exportWorkflow.test.js
git commit -m "feat(review): add cut waveform"
```

### Task 3: Settings persistence and presets

**Files:**
- Create: `client/js/settingsStore.js`
- Create: `tests/settingsStore.test.js`
- Modify: `client/index.html`
- Modify: `client/js/main.js:242-347`

- [ ] **Step 1: Write failing store tests**

```js
const storeModule = require("../client/js/settingsStore");
test("store validates and round-trips settings", () => {
    let saved = "";
    const store = storeModule.createStore({ read: () => saved, write: value => { saved = value; } });
    store.save({ preset: "podcast", aggressiveness: 40, minDurationMs: 750, paddingInMs: 50, paddingOutMs: 150, locale: "pt-BR" });
    assert.equal(store.load().preset, "podcast");
});
test("preset values are explicit and editable", () => {
    assert.deepEqual(storeModule.PRESETS.podcast, { aggressiveness: 40, minDurationMs: 700, paddingInMs: 80, paddingOutMs: 180, minClipDurationMs: 500, minGapFillMs: 250 });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/settingsStore.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement validated storage**

Create a UMD module exporting `PRESETS` for `podcast`, `vlog`, and `tutorial`, `sanitizeSettings`, and `createStore`. `sanitizeSettings` must clamp every value to the input's HTML min/max and accept only known preset and locale names. CEP adapters read/write `%APPDATA%/Duckycut/settings.json` through injected filesystem functions; tests use in-memory functions.

Use these presets:

```js
var PRESETS = {
    podcast: { aggressiveness: 40, minDurationMs: 700, paddingInMs: 80, paddingOutMs: 180, minClipDurationMs: 500, minGapFillMs: 250 },
    vlog: { aggressiveness: 32, minDurationMs: 550, paddingInMs: 100, paddingOutMs: 220, minClipDurationMs: 400, minGapFillMs: 180 },
    tutorial: { aggressiveness: 25, minDurationMs: 900, paddingInMs: 120, paddingOutMs: 260, minClipDurationMs: 700, minGapFillMs: 350 }
};
```

- [ ] **Step 4: Bind presets and save on change**

Add a preset `<select>` above the sliders. On selection, apply all six values and redraw results. Any manual slider change sets the preset label to `Personalizado`. Save a debounced settings snapshot after 250 ms; restore it during `init` before the first render.

Run: `node --test tests/settingsStore.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add client/js/settingsStore.js client/index.html client/js/main.js tests/settingsStore.test.js tests/exportWorkflow.test.js
git commit -m "feat(settings): persist editing presets"
```

### Task 4: Brazilian Portuguese localization and actionable errors

**Files:**
- Create: `client/js/i18n.js`
- Create: `tests/i18n.test.js`
- Modify: `client/index.html`
- Modify: `client/js/main.js`

- [ ] **Step 1: Write failing locale tests**

```js
const i18n = require("../client/js/i18n");
test("Brazilian Portuguese is complete", () => {
    assert.equal(i18n.validateLocale("pt-BR"), true);
    assert.equal(i18n.t("pt-BR", "actions.analyze"), "Analisar");
    assert.equal(i18n.t("pt-BR", "errors.LOCKED_TRACK", { track: "A2" }), "Destrave a faixa A2 antes de aplicar os cortes.");
});
test("unknown key is visible during development", () => assert.equal(i18n.t("pt-BR", "missing.key"), "[missing.key]"));
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/i18n.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement dictionary and interpolation**

Create a UMD module with one `pt-BR` dictionary covering every visible label, status, progress stage, validation code, and button title. Implement dotted-key lookup and `{name}` interpolation. `validateLocale` compares its flattened keys to a frozen canonical key list exported as `REQUIRED_KEYS`.

- [ ] **Step 4: Replace hard-coded strings**

Mark static HTML nodes with `data-i18n`, load `i18n.js` before `main.js`, and translate at initialization. Map structured host/worker error codes to short localized messages; write stack, raw JSON, paths, and timing only to the debug log.

Run: `node --test tests/i18n.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass and `client/index.html` contains no mixed English visible copy.

- [ ] **Step 5: Commit**

```bash
git add client/js/i18n.js client/index.html client/js/main.js tests/i18n.test.js tests/exportWorkflow.test.js
git commit -m "feat(i18n): localize panel in pt-BR"
```

### Task 5: Responsive review layout and UX acceptance

**Files:**
- Modify: `CSXS/manifest.xml:34-46`
- Modify: `client/css/styles.css`
- Modify: `client/index.html`
- Create: `docs/superpowers/validation/phase-4-review-ux.md`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Add failing layout contracts**

```js
test("manifest provides waveform-capable panel geometry", () => {
    const manifest = readProjectFile("CSXS/manifest.xml");
    assert.match(manifest, /<Width>520<\/Width>/);
    assert.match(manifest, /<MinSize>[\s\S]*<Width>420<\/Width>/);
});
test("review canvas remains keyboard and screen-reader discoverable", () => {
    const html = readProjectFile("client/index.html");
    assert.match(html, /id="waveform"[^>]*role="img"[^>]*aria-label=/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="waveform-capable|screen-reader"`

Expected: 2 failures.

- [ ] **Step 3: Implement responsive geometry and styles**

Set manifest default size to `520x680` and minimum to `420x480`. Use a two-column review grid above 620 px and one column below it. Give the waveform `width: 100%`, `height: 180px`, visible focus treatment, and a text summary immediately after the canvas. Preserve 44 px minimum action-button height and WCAG AA contrast for text and interactive states.

- [ ] **Step 4: Write and run the UX matrix**

Create `docs/superpowers/validation/phase-4-review-ux.md` with these checks at widths 420, 520, and 800 px:

```markdown
- Analyze ends on Review with count, removed duration, final duration, waveform, and enabled Apply.
- Moving each slider redraws within 100 ms and causes no export or ONNX process.
- Back preserves the cached result; changing tracks invalidates the cache key.
- Podcast, Vlog, and Tutorial presets visibly change zones and remain editable.
- Keyboard traversal reaches every control in visual order and shows focus.
- Error messages fit the status region without raw JSON; debug log retains details.
- Apply performs only the host apply stages and opens the duplicated sequence result.
```

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 5: Commit the checkpoint**

```bash
git add CSXS/manifest.xml client/index.html client/css/styles.css tests/exportWorkflow.test.js docs/superpowers/validation/phase-4-review-ux.md
git commit -m "feat(panel): finish responsive review flow"
```
