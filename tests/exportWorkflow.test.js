const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function readProjectFile(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("host exportSequenceAudio exports directly from Premiere, not through AME", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function exportSequenceAudio");
    assert.notEqual(start, -1, "exportSequenceAudio should exist");

    const end = host.indexOf("\n/**", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /\.exportAsMediaDirect\(/, "exportSequenceAudio should call sequence.exportAsMediaDirect");
    assert.doesNotMatch(fn, /app\.encoder\.|encodeSequence\(/, "exportSequenceAudio should not depend on AME encoder APIs");
});

test("panel analysis copy describes Premiere direct export instead of AME queueing", () => {
    const main = readProjectFile("client/js/main.js");

    assert.doesNotMatch(main, /Adobe Media Encoder|AME didn't produce|AME render/i);
    assert.match(main, /rendered mixdown/i);
});

test("host muteAudioTracks makes selected tracks audible and others muted", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function muteAudioTracks");
    assert.notEqual(start, -1, "muteAudioTracks should exist");

    const end = host.indexOf("\nfunction restoreAudioTrackMutes", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /track\.setMute\(false\)/, "selected tracks should be unmuted during export");
    assert.match(fn, /track\.setMute\(true\)/, "unselected tracks should be muted during export");
});

test("panel analysis prerenders selected sequence audio before detecting silence", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    //", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /ensureSelectedTrackMixdown\(/, "runAnalysis should use the shared selected-track mixdown helper");
    assert.match(fn, /detectSilence\(/, "runAnalysis should run FFmpeg on the rendered WAV");
    assert.doesNotMatch(fn, /detectSilenceFromSequence\(/, "runAnalysis should not skip prerender by building its own mix");
});

test("panel uses one shared direct mixdown helper for selected tracks", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function ensureSelectedTrackMixdown");
    assert.notEqual(start, -1, "ensureSelectedTrackMixdown should centralize selected-track rendering");

    const end = main.indexOf("\n    function runAnalysis", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /muteAudioTracks\(/, "helper should set selected track mutes before rendering");
    assert.match(fn, /exportSequenceAudio\(/, "helper should render the selected-track WAV");
    assert.match(fn, /restoreMutes\(/, "helper should restore original mute states after render finishes");
    assert.match(fn, /stableNeeded\s*=\s*(?:1[0-9]|[2-9][0-9])/, "helper should require a conservative stable-size window for large renders");
    assert.match(fn, /seqSettings\.durationSeconds/, "helper should compare WAV duration with expected sequence duration");
    assert.match(fn, /duration mismatch|duration is shorter/i, "helper should reject truncated WAVs before analysis");
});

test("panel Auto Detect probes first selected track source without prerender", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runProbe");
    assert.notEqual(start, -1, "runProbe should exist");

    const end = main.indexOf("\n    // ── Run Analysis", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /getAudioTrackMediaPath\(/, "runProbe should get a source path from the first selected track");
    assert.match(fn, /probeAudio\(mediaPath\)/, "runProbe should probe the source path directly");
    assert.doesNotMatch(fn, /ensureSelectedTrackMixdown\(/, "runProbe should not prerender just to check speech level");
    assert.doesNotMatch(fn, /exportSequenceAudio\(/, "runProbe should not export audio just to check speech level");
});

test("host applyCutsInPlace removes clips using ticks instead of Premiere seconds floats", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction muteAudioTracks", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /_timeToSecondsPreferTicks\(vClip\.start\)/, "video start should be read through tick-preferring helper");
    assert.match(fn, /_timeToSecondsPreferTicks\(vClip\.end\)/, "video end should be read through tick-preferring helper");
    assert.match(fn, /_timeToSecondsPreferTicks\(aClip\.start\)/, "audio start should be read through tick-preferring helper");
    assert.match(fn, /_timeToSecondsPreferTicks\(aClip\.end\)/, "audio end should be read through tick-preferring helper");
    assert.doesNotMatch(fn, /\.start\.seconds/, "clip start should not use float seconds");
    assert.doesNotMatch(fn, /\.end\.seconds/, "clip end should not use float seconds");
});

test("panel applies cut zones one at a time so cancellation is not blocked by a long evalScript", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // ── UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /runNextCutZone\(/, "panel should orchestrate cut zones as short sequential host calls");
    assert.match(fn, /applyCutsInPlace\(/, "panel should apply one small cut-zone payload per evalScript call");
    assert.doesNotMatch(fn, /applyCutsInPlaceFile\(/, "panel should not block cancellation behind a single full-batch evalScript call");
    assert.match(fn, /applyCancelRequested/, "panel should stop scheduling new zones as soon as cancel is clicked");
});

test("host can load cut zones from a temp JSON file", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlaceFile");
    assert.notEqual(start, -1, "applyCutsInPlaceFile should exist");
    const end = host.indexOf("\nfunction muteAudioTracks", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /function applyCutsInPlaceFile\(/, "host should expose file-based cut application");
    assert.match(fn, /new File\(/, "host should read the temp JSON through ExtendScript File I/O");
    assert.match(fn, /\.read\(\)/, "host should read file contents before delegating");
    assert.doesNotMatch(fn, /decodeURI\(/, "temp filesystem paths should not be URI-decoded");
});

test("host applyCutsInPlace reports per-zone diagnostics for failed removals", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /zoneDiagnostics/, "applyCutsInPlace should collect diagnostics for every cut zone");
    assert.match(fn, /removedVideo/, "diagnostics should count removed video clips per zone");
    assert.match(fn, /removedAudio/, "diagnostics should count removed audio clips per zone");
    assert.match(fn, /clipsBefore/, "diagnostics should record clip counts before razor");
    assert.match(fn, /clipsAfterRazor/, "diagnostics should record clip counts after razor/API refresh");
    assert.match(fn, /candidateClips/, "diagnostics should include nearby rejected clip candidates");
    assert.match(fn, /"_zoneDiag"/, "applyCutsInPlace should return the per-zone diagnostics payload");
});

test("panel logs per-zone Apply Cuts diagnostics returned by the host", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("applyCutsInPlace(");
    assert.notEqual(start, -1, "applyCutsInPlace call should exist");

    const fn = main.slice(start, main.indexOf("\n    // ── UI Helpers", start));

    assert.match(fn, /_zoneDiag/, "panel should read host per-zone diagnostics");
    assert.match(fn, /applyCutsInPlace zone diag/, "panel should log zone diagnostics with a searchable label");
});

test("panel turns Apply Cuts into a red Cancel button while cuts are running", () => {
    const main = readProjectFile("client/js/main.js");
    const styles = readProjectFile("client/css/styles.css");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // ── UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /beginApplyCancelMode\(\)/, "starting cuts should switch the Apply button into cancel mode");
    assert.match(main, /cancelApplyCutsFromPanel\(\)/, "a second click while cutting should request cancellation");
    assert.doesNotMatch(fn, /elBtnApply\.disabled\s*=\s*true/, "Apply button must stay clickable so it can cancel immediately");
    assert.match(styles, /\.btn-danger/, "cancel mode should use a red button style");
});

test("host applyCutsInPlace stops when cancellation is requested", () => {
    const host = readProjectFile("host/index.jsx");
    assert.match(host, /var\s+DUCKYCUT_CANCEL_APPLY\s*=\s*false/, "host should keep a global cancellation flag");
    assert.match(host, /function\s+cancelApplyCuts\s*\(/, "host should expose cancelApplyCuts for the panel");

    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");
    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /DUCKYCUT_CANCEL_APPLY\s*=\s*false/, "new apply run should clear stale cancellation state");
    assert.match(fn, /_isApplyCutsCancelled\(\)/, "apply loop should poll cancellation state");
    assert.match(fn, /\"cancelled\":true/, "cancelled runs should return a cancelled result");
});
