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

test("panel analysis copy describes selected-track FFmpeg detection instead of Premiere direct export", () => {
    const main = readProjectFile("client/js/main.js");

    assert.doesNotMatch(main, /Adobe Media Encoder|AME didn't produce|AME render/i);
    assert.match(main, /selected tracks/i);
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

test("panel analysis filters sequence clips by selected audio tracks before detecting silence", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    //", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /buildSelectedAudioTracksForDetection\(/, "runAnalysis should build a detection payload from selected checkboxes");
    assert.match(fn, /detectSilenceFromSequence\(/, "runAnalysis should run FFmpeg only on selected track clips");
    assert.doesNotMatch(fn, /ensureSelectedTrackMixdown\(/, "runAnalysis should not rely on Premiere mute state to filter tracks");
    assert.doesNotMatch(fn, /detectSilence\(/, "runAnalysis should not analyze a Premiere-rendered WAV containing unselected tracks");
});

test("panel maps selected sequence clips into range-relative audio tracks", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function buildSelectedAudioTracksForDetection");
    assert.notEqual(start, -1, "buildSelectedAudioTracksForDetection should exist");

    const end = main.indexOf("\n    function runAnalysis", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /selectedIdx\.indexOf\(clip\.trackIndex\)/, "helper should include only selected track indices");
    assert.match(fn, /clip\.trackType\s*!==\s*"audio"/, "helper should ignore non-audio clips");
    assert.match(fn, /rangeInfo\.startSeconds/, "helper should clamp clips to In-Out start");
    assert.match(fn, /rangeInfo\.endSeconds/, "helper should clamp clips to In-Out end");
    assert.match(fn, /seqStart:\s*overlapStart\s*-\s*rangeStart/, "range clips should be shifted so FFmpeg timestamps start at zero");
    assert.match(fn, /srcIn:\s*clip\.mediaIn\s*\+\s*\(overlapStart\s*-\s*clipStart\)/, "source in should follow the clipped overlap");
});

test("panel does not rely on Premiere mute state to filter selected tracks", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    // ═", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.doesNotMatch(fn, /muteAudioTracks\(/, "Analyze should not use track mute state as the selection filter");
    assert.doesNotMatch(fn, /exportSequenceAudio\(/, "Analyze should not use Premiere direct export for selected-track filtering");
    assert.match(fn, /buildSelectedAudioTracksForDetection\(/, "Analyze should filter collected clips by checkbox selection");
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

    assert.match(fn, /_timeToTicksPreferTicks\(vClip\.start\)/, "video start should be read as ticks");
    assert.match(fn, /_timeToTicksPreferTicks\(vClip\.end\)/, "video end should be read as ticks");
    assert.match(fn, /_timeToTicksPreferTicks\(aClip\.start\)/, "audio start should be read as ticks");
    assert.match(fn, /_timeToTicksPreferTicks\(aClip\.end\)/, "audio end should be read as ticks");
    assert.match(fn, /_clipFullyInsideTicks\(/, "clip inclusion should compare ticks");
    assert.doesNotMatch(fn, /_clipFullyInside\(cs, ce, zStart, zEnd, fps\)/, "video removal should not compare seconds");
    assert.doesNotMatch(fn, /_clipFullyInside\(as, ae, zStart, zEnd, fps\)/, "audio removal should not compare seconds");
    assert.doesNotMatch(fn, /\.start\.seconds/, "clip start should not use float seconds");
    assert.doesNotMatch(fn, /\.end\.seconds/, "clip end should not use float seconds");
});

test("panel applies cut zones in cancellable chunks", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // ── UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /prepareTickCutZonesForApply\(/, "panel should convert cut zones to tick payloads");
    assert.match(fn, /chunkArray\(/, "panel should split zones into chunks");
    assert.match(fn, /runNextCutChunk\(/, "panel should schedule chunks sequentially");
    assert.match(fn, /APPLY_CUTS_CHUNK_SIZE/, "panel should use an explicit chunk size constant");
    assert.match(fn, /applyCancelRequested/, "panel should stop scheduling new zones as soon as cancel is clicked");
    assert.match(fn, /applyCutsInPlace\(/, "panel should keep using host applyCutsInPlace for each chunk");
    assert.doesNotMatch(fn, /runNextCutZone\(/, "panel should not schedule one evalScript per zone anymore");
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

test("host exposes sequence In-Out range in ticks and seconds", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function getSequenceInOutRange");
    assert.notEqual(start, -1, "getSequenceInOutRange should exist");

    const end = host.indexOf("\n/**", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /getInPointAsTime\(/, "range should read sequence In point");
    assert.match(fn, /getOutPointAsTime\(/, "range should read sequence Out point");
    assert.match(fn, /\.ticks/, "range should prefer ticks for precision");
    assert.match(fn, /254016000000|TICKS/, "range should convert ticks using Premiere tick rate");
    assert.match(fn, /durationSeconds/, "range should return durationSeconds");
});

test("host exportSequenceAudio accepts workAreaType for In-Out exports", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function exportSequenceAudio");
    assert.notEqual(start, -1, "exportSequenceAudio should exist");

    const end = host.indexOf("\n/**", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /workAreaType/, "exportSequenceAudio should accept workAreaType");
    assert.match(fn, /exportAsMediaDirect\([\s\S]*workAreaType/, "exportAsMediaDirect should receive workAreaType");
});

test("panel exposes Full Sequence / In-Out range toggle", () => {
    const html = readProjectFile("client/index.html");
    const main = readProjectFile("client/js/main.js");

    assert.match(html, /name="rangeMode"/, "range mode radio group should exist");
    assert.match(html, /value="full"/, "Full Sequence option should exist");
    assert.match(html, /value="inout"/, "In-Out option should exist");
    assert.match(main, /getSelectedRangeMode\(/, "panel should read selected range mode");
});

test("panel Analyze validates In-Out range, clips selected tracks, and offsets detected silence", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    // ═", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /getSelectedRangeMode\(/, "Analyze should read selected range mode");
    assert.match(fn, /getSequenceInOutRange\(/, "Analyze should request In-Out range from host");
    assert.match(fn, /Define In and Out|set In and Out/i, "invalid In-Out should fail clearly");
    assert.match(fn, /buildSelectedAudioTracksForDetection\(selectedIdx, sequenceClips, analysisRangeInfo\)/, "Analyze should clip selected tracks to the active range");
    assert.match(fn, /offsetIntervals\(/, "Analyze should offset FFmpeg intervals into sequence time");
});

test("panel Analyze uses sequence duration after selected-track FFmpeg detection", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    // ═", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /seqSettings\s*&&\s*seqSettings\.durationSeconds/, "Analyze should prefer full sequence duration");
    assert.match(fn, /result\.mediaDuration\s*=\s*mediaDuration/, "result duration should be normalized before showResults and Apply Cuts");
});

test("panel clamps Apply cut zones to analyzed In-Out range", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // ── UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /intersectIntervalsWithRange\(/, "Apply should clamp cut zones to In-Out range");
    assert.match(fn, /analysisRangeInfo/, "Apply should use range captured during Analyze");
    assert.match(fn, /range:/, "Apply should pass range to host opts");
});

test("host applyCutsInPlace ignores zones outside opts.range", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /opts\.range/, "host should read opts.range");
    assert.match(fn, /rangeStart/, "host should derive rangeStart");
    assert.match(fn, /rangeEnd/, "host should derive rangeEnd");
});

test("host applyCutsInPlace normalizes zones to ticks before razor and remove", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /_normalizeCutZone\(/, "host should normalize array and object zones");
    assert.match(fn, /startTicks/, "host should read startTicks from zone payload");
    assert.match(fn, /endTicks/, "host should read endTicks from zone payload");
    assert.match(fn, /_ticksToTimecode\(/, "host should convert ticks to timecode only for razor");
    assert.match(fn, /_clipFullyInsideTicks\(/, "host should compare clip bounds against zone ticks");
});

test("host applyCutsInPlace filters opts.range using tick bounds", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /rangeStartTicks/, "host should convert range start to ticks");
    assert.match(fn, /rangeEndTicks/, "host should convert range end to ticks");
    assert.match(fn, /zEndTicks\s*<=\s*rangeStartTicks/, "host should skip zones before range by ticks");
    assert.match(fn, /zStartTicks\s*>=\s*rangeEndTicks/, "host should skip zones after range by ticks");
});
