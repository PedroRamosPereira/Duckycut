# Phase 2 Long-Form Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the panel responsive and memory bounded while analyzing recordings of one to three hours.

**Architecture:** Make the external Node worker the only ONNX execution path, communicate through newline-delimited JSON, and read PCM windows from disk instead of materializing the full WAV. Add pure analysis-session and render-watcher modules so mixdown reuse, inactivity timeout, progress, and cancellation are deterministic and testable.

**Tech Stack:** Node.js streams and child processes, ONNX Runtime Node, CEP Node bridge, `node:test`

---

## File structure

- Create `server/wavReader.js`: WAV metadata parsing and bounded PCM window iterator.
- Create `server/vadProtocol.js`: newline-delimited worker event encode/decode.
- Modify `server/vadDetector.js`: cached session, RMS gate, reusable buffers, progress callback.
- Modify `server/vadWorker.js`: long-lived request loop and structured events.
- Create `client/js/analysisSession.js`: stable cache keys, artifact validity, expiry, mute recovery record.
- Create `client/js/renderWatcher.js`: inactivity-based file watcher with cancellation.
- Modify `client/js/main.js`: external worker only, session reuse, real progress, event-based sequence refresh.
- Modify `host/index.jsx`: persist and restore temporary mute state.
- Add focused tests under `tests/` for every new pure module and worker contract.

### Task 1: Bounded WAV reader and RMS gate

**Files:**
- Create: `server/wavReader.js`
- Create: `tests/wavReader.test.js`
- Modify: `server/vadDetector.js`
- Modify: `tests/vadDetector.test.js`

- [ ] **Step 1: Write failing WAV window tests**

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openPcm16MonoWav, rms } = require("../server/wavReader");

test("reader yields fixed windows without exposing a full samples array", () => {
    const file = makeMonoWav([0, 32767, -32768, 0, 1000], 16000);
    const reader = openPcm16MonoWav(file);
    assert.equal(reader.samples, undefined);
    assert.equal(reader.sampleCount, 5);
    assert.deepEqual(Array.from(reader.readWindow(1, 3)), [32767 / 32768, -1, 0]);
    reader.close();
});

test("rms returns zero for silence and normalized energy for signal", () => {
    assert.equal(rms(new Float32Array([0, 0, 0])), 0);
    assert.ok(Math.abs(rms(new Float32Array([1, -1])) - 1) < 1e-9);
});
```

Use the existing WAV fixture helper from `tests/vadDetector.test.js`; move it to `tests/helpers/wavFixture.js` and import it from both test files.

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/wavReader.test.js`

Expected: FAIL because `server/wavReader.js` does not exist.

- [ ] **Step 3: Implement metadata parsing and bounded reads**

```js
const fs = require("node:fs");

function openPcm16MonoWav(filePath) {
    const fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(65536);
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    const meta = parseHeader(header.subarray(0, bytes));
    if (meta.sampleRate !== 16000 || meta.channels !== 1 || meta.bitsPerSample !== 16 || meta.audioFormat !== 1) {
        fs.closeSync(fd);
        throw new Error("Silero VAD expects 16 kHz mono/16-bit PCM WAV");
    }
    return {
        sampleRate: meta.sampleRate,
        sampleCount: Math.floor(meta.dataSize / 2),
        durationSeconds: Math.floor(meta.dataSize / 2) / meta.sampleRate,
        readWindow(startSample, count) {
            const available = Math.max(0, Math.min(count, this.sampleCount - startSample));
            const bytesBuffer = Buffer.allocUnsafe(available * 2);
            fs.readSync(fd, bytesBuffer, 0, bytesBuffer.length, meta.dataOffset + startSample * 2);
            const out = new Float32Array(count);
            for (let i = 0; i < available; i++) out[i] = bytesBuffer.readInt16LE(i * 2) / 32768;
            return out;
        },
        close() { fs.closeSync(fd); },
    };
}

function rms(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
}

module.exports = { openPcm16MonoWav, rms, _internals: { parseHeader } };
```

Move the existing RIFF chunk scan into `parseHeader` unchanged except that it returns `{ audioFormat, channels, sampleRate, bitsPerSample, dataOffset, dataSize }` and throws on a data chunk beyond the 64 KiB header scan.

- [ ] **Step 4: Integrate the reader and conservative gate**

In `runSileroOnnx`, accept a reader instead of `wav.samples`, read one 512-sample window at a time, and skip ONNX only when `rms(chunk) < 0.0005` (`-66.02 dBFS`). Emit probability zero for skipped windows while still updating context.

Run: `node --test tests/wavReader.test.js tests/vadDetector.test.js`

Expected: all focused tests pass, including a test asserting `session.run` is not called for an all-zero window.

- [ ] **Step 5: Commit**

```bash
git add server/wavReader.js server/vadDetector.js tests/helpers/wavFixture.js tests/wavReader.test.js tests/vadDetector.test.js
git commit -m "perf(vad): stream PCM windows"
```

### Task 2: Long-lived external worker and real progress

**Files:**
- Create: `server/vadProtocol.js`
- Create: `tests/vadProtocol.test.js`
- Modify: `server/vadWorker.js`
- Modify: `server/vadDetector.js`
- Modify: `tests/vadDetector.test.js`

- [ ] **Step 1: Write failing protocol and session-reuse tests**

```js
test("protocol decodes split newline-delimited events", () => {
    const decoder = require("../server/vadProtocol").createDecoder();
    assert.deepEqual(decoder.push('{"type":"progress","completed":1'), []);
    assert.deepEqual(decoder.push(',"total":2}\n'), [{ type: "progress", completed: 1, total: 2 }]);
});

test("getSession caches ONNX sessions by model path", async () => {
    let creates = 0;
    const ort = { InferenceSession: { create: async () => ({ id: ++creates }) } };
    const first = await internals.getSession(ort, "model.onnx");
    const second = await internals.getSession(ort, "model.onnx");
    assert.equal(first, second);
    assert.equal(creates, 1);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/vadProtocol.test.js tests/vadDetector.test.js --test-name-pattern="protocol|caches ONNX"`

Expected: failures for the missing decoder and session cache.

- [ ] **Step 3: Implement protocol and cached session**

```js
function encode(event) { return JSON.stringify(event) + "\n"; }
function createDecoder() {
    let pending = "";
    return { push(chunk) {
        pending += String(chunk);
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        return lines.filter(Boolean).map(line => JSON.parse(line));
    }};
}
module.exports = { encode, createDecoder };
```

In `vadDetector.js`:

```js
const sessionCache = new Map();
async function getSession(ort, modelPath) {
    if (!sessionCache.has(modelPath)) {
        sessionCache.set(modelPath, ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] }));
    }
    try { return await sessionCache.get(modelPath); }
    catch (err) { sessionCache.delete(modelPath); throw err; }
}
```

Pass `opts.onProgress({ completed, total })` after every 128 windows and at completion.

- [ ] **Step 4: Convert the worker to request/event lines**

`vadWorker.js` must read one JSON request line, emit `started`, `progress`, and `result`, and keep the process alive:

```js
const readline = require("node:readline");
const { detectVoiceActivity } = require("./vadDetector");
const { encode } = require("./vadProtocol");
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", async line => {
    const request = JSON.parse(line);
    try {
        process.stdout.write(encode({ type: "started", requestId: request.requestId }));
        const result = await detectVoiceActivity(request.wavPath, Object.assign({}, request.options, {
            onProgress(value) { process.stdout.write(encode(Object.assign({ type: "progress", requestId: request.requestId }, value))); },
        }));
        process.stdout.write(encode({ type: "result", requestId: request.requestId, result }));
    } catch (err) {
        process.stdout.write(encode({ type: "error", requestId: request.requestId, message: err.message || String(err) }));
    }
});
```

Run: `node --test tests/vadProtocol.test.js tests/vadDetector.test.js`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/vadProtocol.js server/vadWorker.js server/vadDetector.js tests/vadProtocol.test.js tests/vadDetector.test.js
git commit -m "perf(vad): reuse external worker session"
```

### Task 3: Analysis-session cache and mute recovery

**Files:**
- Create: `client/js/analysisSession.js`
- Create: `tests/analysisSession.test.js`
- Modify: `client/index.html:221-224`
- Modify: `client/js/main.js:116-225, 625-820`
- Modify: `host/index.jsx:1237-1368`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing cache-key tests**

```js
const sessions = require("../client/js/analysisSession");

test("cache key changes only when analysis inputs change", () => {
    const base = { sequenceID: "7", tracks: [2, 0], range: { mode: "full" }, preset: "reduced" };
    assert.equal(sessions.createKey(base), sessions.createKey({ ...base, tracks: [0, 2] }));
    assert.notEqual(sessions.createKey(base), sessions.createKey({ ...base, tracks: [0] }));
});

test("valid entry survives Back until expiry", () => {
    const cache = sessions.createCache({ now: () => 1000, maxAgeMs: 5000 });
    cache.put("key", { wavPath: "C:/tmp/a.wav", completedAt: 1000 });
    assert.equal(cache.get("key").wavPath, "C:/tmp/a.wav");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/analysisSession.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the UMD session module**

```js
(function (root, factory) {
    if (typeof module === "object" && module.exports) module.exports = factory();
    else { root.Duckycut = root.Duckycut || {}; root.Duckycut.analysisSession = factory(); }
}(typeof self !== "undefined" ? self : this, function () {
    function createKey(input) {
        return JSON.stringify({
            sequenceID: String(input.sequenceID),
            tracks: input.tracks.slice().sort(function (a, b) { return a - b; }),
            range: input.range,
            preset: input.preset
        });
    }
    function createCache(options) {
        var entries = {};
        var now = options.now;
        var maxAgeMs = options.maxAgeMs;
        return {
            put: function (key, value) { entries[key] = value; },
            get: function (key) {
                var value = entries[key];
                if (!value || now() - value.completedAt > maxAgeMs) { delete entries[key]; return null; }
                return value;
            },
            remove: function (key) { delete entries[key]; },
            values: function () { return Object.keys(entries).map(function (key) { return entries[key]; }); }
        };
    }
    return { createKey: createKey, createCache: createCache };
}));
```

- [ ] **Step 4: Integrate reuse and persisted mute state**

Load `analysisSession.js` before `main.js`. In `ensureSelectedTrackMixdown`, look up the cache key before export and store completed WAVs with `completedAt: Date.now()`. Change `returnToStart` to clear UI state without deleting valid cache entries.

Before `muteAudioTracks`, write saved states to `%TEMP%/duckycut-pending-mutes.json`; after successful restore, delete it. During `init`, read the file, call `restoreAudioTrackMutes`, show `Mutes de áudio restaurados após uma sessão interrompida.`, then delete the recovery record.

Run: `node --test tests/analysisSession.test.js tests/exportWorkflow.test.js`

Expected: focused tests pass and the old expectation that Back deletes the WAV is replaced with cache-retention coverage.

- [ ] **Step 5: Commit**

```bash
git add client/index.html client/js/analysisSession.js client/js/main.js host/index.jsx tests/analysisSession.test.js tests/exportWorkflow.test.js
git commit -m "feat(analysis): cache mixdown sessions"
```

### Task 4: Inactivity timeout, worker cancellation, and real panel progress

**Files:**
- Create: `client/js/renderWatcher.js`
- Create: `tests/renderWatcher.test.js`
- Modify: `client/index.html`
- Modify: `client/js/main.js:413-426, 482-506, 586-623, 703-820`
- Modify: `tests/exportWorkflow.test.js`

- [ ] **Step 1: Write failing render-watcher tests**

```js
const { createRenderWatcher } = require("../client/js/renderWatcher");

test("file growth resets inactivity timeout", async () => {
    const sizes = [0, 10, 20, 20, 20];
    const watcher = createRenderWatcher({ statSize: () => sizes.shift(), inactivityMs: 900, stableReads: 2, pollMs: 300 });
    await watcher.wait("mix.wav");
});

test("abort rejects with RENDER_CANCELLED", async () => {
    const watcher = createRenderWatcher({ statSize: () => 0, inactivityMs: 900, stableReads: 2, pollMs: 300 });
    const pending = watcher.wait("mix.wav");
    watcher.abort();
    await assert.rejects(pending, err => err.code === "RENDER_CANCELLED");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/renderWatcher.test.js`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement and load the watcher**

Implement a UMD `createRenderWatcher` that tracks `lastGrowthAt`, resolves after two unchanged non-zero reads, rejects only when `now() - lastGrowthAt >= inactivityMs`, and exposes `abort()`. Inject `setTimeout`, `now`, and `statSize` through options for fake-time tests.

Load it before `main.js` and replace `waitForStableFile` with one watcher instance. Set `inactivityMs` to `30000`, `stableReads` to `2`, and `pollMs` to `300`.

- [ ] **Step 4: Make external worker progress/cancellation the only VAD path**

In `main.js`, spawn `vadWorker.js` once per panel session, parse events with `vadProtocol.createDecoder`, map `completed / total` to the VAD stage of the progress bar, and retain the child handle. The Analyze cancel action calls `child.kill()` during VAD and `renderWatcher.abort()` during export. Remove direct `vadDetector.detectVoiceActivity` calls from the CEP process.

Delete `SEQUENCE_AUTO_REFRESH_INTERVAL_MS` and `setInterval`; retain only `visibilitychange` and `focus` listeners.

Run: `node --test tests/renderWatcher.test.js tests/exportWorkflow.test.js`

Expected: all focused tests pass; source contracts show no fixed 180-second total timeout and no sequence refresh interval.

- [ ] **Step 5: Run full verification and commit**

Run: `npm test`

Expected: all tests pass.

```bash
git add client/index.html client/js/renderWatcher.js client/js/main.js tests/renderWatcher.test.js tests/exportWorkflow.test.js
git commit -m "perf(panel): report real analysis progress"
```

### Task 5: Production diagnostics and long-form acceptance

**Files:**
- Modify: `client/js/main.js:156-176`
- Modify: `server/vadWorker.js`
- Modify: `tests/exportWorkflow.test.js`
- Create: `scripts/measure-vad-memory.js`
- Create: `docs/superpowers/validation/phase-2-performance.md`

- [ ] **Step 1: Add failing production-log tests**

```js
test("production mode avoids synchronous per-stage log writes", () => {
    const main = readProjectFile("client/js/main.js");
    assert.doesNotMatch(main, /appendFileSync/);
    assert.match(main, /DUCKYCUT_DEBUG/);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `node --test tests/exportWorkflow.test.js --test-name-pattern="avoids synchronous"`

Expected: FAIL while `appendFileSync` remains.

- [ ] **Step 3: Replace diagnostics and add the benchmark**

Use `const DUCKYCUT_DEBUG = false`; when enabled, buffer log entries and flush once with `writeFile`. `scripts/measure-vad-memory.js` must accept a WAV path, sample `process.memoryUsage().rss` once per second, run the external worker, and print one JSON object containing `durationSeconds`, `peakRssBytes`, and `elapsedMs`.

Create `docs/superpowers/validation/phase-2-performance.md` with exact commands:

```markdown
# Phase 2 Performance Validation

Run `node scripts/measure-vad-memory.js fixtures/three-hour-16k-mono.wav > dist/vad-memory.json`.

Pass conditions:
- peak RSS remains below 350 MiB;
- progress arrives at least once every five seconds;
- the panel remains interactive during VAD;
- a second analysis with the same key skips Premiere export;
- Back then Analyze reuses the cached WAV;
- cancel during render restores mutes;
- cancel during VAD retains the completed WAV.
```

- [ ] **Step 4: Run verification**

Run: `npm test`

Expected: all tests pass.

Run: `node scripts/measure-vad-memory.js <absolute-path-to-3h-16k-mono-wav>`

Expected: exit 0 and JSON with `peakRssBytes < 367001600`.

- [ ] **Step 5: Commit**

```bash
git add client/js/main.js server/vadWorker.js scripts/measure-vad-memory.js tests/exportWorkflow.test.js docs/superpowers/validation/phase-2-performance.md
git commit -m "test(vad): verify long-form performance"
```
