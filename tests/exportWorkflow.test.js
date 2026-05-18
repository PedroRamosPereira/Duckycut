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

test("panel analysis copy describes Premiere-rendered selected-track detection", () => {
    const main = readProjectFile("client/js/main.js");

    assert.doesNotMatch(main, /Adobe Media Encoder|AME didn't produce|AME render/i);
    assert.match(main, /Premiere audio mix|Premiere render|selected tracks/i);
});

test("host muteAudioTracks makes selected tracks audible and others muted", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function muteAudioTracks");
    assert.notEqual(start, -1, "muteAudioTracks should exist");

    const end = host.indexOf("\nfunction restoreAudioTrackMutes", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /muteValue:\s*isSelected\s*\?\s*0\s*:\s*1/, "selected/unselected tracks should map to Premiere's numeric mute API");
    assert.match(fn, /\.setMute\(plan\.muteValue\)/, "host should pass numeric mute values to Premiere");
    assert.match(fn, /afterMuted\s*=\s*plannedTrack\.isMuted\(\)/, "host should verify the mute state after setting it");
    assert.match(fn, /Mute verification failed/, "host should fail before export if Premiere refuses the requested mute state");
});

test("panel Analyze renders the selected Premiere mix before detecting silence", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    //", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /ensureSelectedTrackMixdown\(selectedIdx,\s*analysisRangeInfo\)/, "Analyze should render the selected Premiere mix before silence detection");
    assert.match(fn, /detectSilence\(renderedMixPath/, "Analyze should run silencedetect on the rendered Premiere WAV");
    assert.doesNotMatch(fn, /detectSilenceFromSequence\(selectedAudioTracks/, "Analyze should not use FFmpeg sequence mix as the primary path");
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

test("panel helper restores Premiere track mutes after selected mix render", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function ensureSelectedTrackMixdown");
    assert.notEqual(start, -1, "ensureSelectedTrackMixdown should exist");

    const end = main.indexOf("\n    function runAnalysis", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /muteAudioTracks\(/, "helper should normalize Premiere track mutes before export");
    assert.match(fn, /muteResult\.diagnostics/, "helper should surface Premiere mute diagnostics");
    assert.match(fn, /savedMuteStates\s*=\s*muteResult\.savedStates/, "helper should keep the original Premiere mute states returned by the host");
    assert.match(fn, /restoreAudioTrackMutes\(" \+ jsxStringArg\(JSON\.stringify\(savedMuteStates\)/, "helper should pass saved mute states back to the host when restoring");
    assert.match(fn, /restoreResult\.success/, "helper should reject if the host reports mute restoration failure");
    assert.match(fn, /exportSequenceAudio\(/, "helper should export WAV through Premiere");
    assert.match(fn, /restoreAudioTrackMutes\(/, "helper should restore mutes after export");
    assert.match(fn, /function restore\(|\.finally\(/, "mute restoration must happen after success and failure paths");
    assert.match(fn, /workAreaType/, "helper should pass Full Sequence or In-Out export mode");
});

test("host restoreAudioTrackMutes restores saved states with Premiere numeric mute API", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function restoreAudioTrackMutes");
    assert.notEqual(start, -1, "restoreAudioTrackMutes should exist");

    const end = host.indexOf("\nfunction ", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /restoreValue\s*=\s*state\.wasMuted\s*\?\s*1\s*:\s*0/, "restore should map saved booleans to Premiere's numeric mute API");
    assert.match(fn, /track\.setMute\(restoreValue\)/, "restore should pass numeric mute values to Premiere");
    assert.match(fn, /afterMuted\s*=\s*track\.isMuted\(\)/, "restore should verify the mute state after restoring it");
    assert.match(fn, /Mute restore verification failed/, "restore should report when Premiere refuses the original state");
});

test("panel Auto Detect probes the selected-track mix instead of only the first selected track", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runProbe");
    assert.notEqual(start, -1, "runProbe should exist");

    const end = main.indexOf("\n    // ── Run Analysis", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /getFullSequenceClips\(/, "runProbe should read sequence clips for all selected tracks");
    assert.match(fn, /buildSelectedAudioTracksForDetection\(selectedForProbe/, "runProbe should reuse selected-track filtering");
    assert.match(fn, /probeAudioFromSequence\(/, "runProbe should probe a mix built from all selected tracks");
    assert.doesNotMatch(fn, /getAudioTrackMediaPath\(/, "runProbe should not collapse calibration to the first selected track");
    assert.doesNotMatch(fn, /selectedForProbe\[0\]/, "runProbe should not index only the first selected track");
});

test("host applyCutsInPlace removes clips using ticks instead of Premiere seconds floats", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction muteAudioTracks", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /_timeToTicksPreferTicks\([^)]*Clip\.start\)/, "clip starts should be read as ticks");
    assert.match(fn, /_timeToTicksPreferTicks\([^)]*Clip\.end\)/, "clip ends should be read as ticks");
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
    assert.match(fn, /refreshAttempts/, "diagnostics should record how many refresh attempts were needed after razor");
    assert.match(fn, /_waitForRazorRefresh\(/, "host should poll for regular DOM refresh instead of relying on one fixed sleep");
    assert.match(fn, /_waitForContainedTargets\(/, "host should retry until post-razor contained targets are visible");
    assert.match(fn, /candidateClips/, "diagnostics should include nearby rejected clip candidates");
    assert.match(fn, /"_zoneDiag"/, "applyCutsInPlace should return the per-zone diagnostics payload");
});

test("host Apply Cuts diagnostics include target order and frame deltas", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /frameDeltaStart/, "zone diagnostics should include start delta in frames for candidates");
    assert.match(fn, /frameDeltaEnd/, "zone diagnostics should include end delta in frames for candidates");
    assert.match(fn, /targetOrder/, "zone diagnostics should record target removal order");
    assert.match(fn, /rippleTargetKind/, "zone diagnostics should record which kind received ripple delete");
    assert.match(fn, /rippleTargetIndex/, "zone diagnostics should record which target index received ripple delete");
});

test("panel logs Apply Cuts chunk timing summaries", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // â”€â”€ UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /chunkStartedAt/, "panel should capture chunk start time");
    assert.match(fn, /chunkElapsedMs/, "panel should compute chunk elapsed time");
    assert.match(fn, /applyCutsInPlace chunk diag/, "panel should log a searchable chunk diagnostic label");
    assert.match(fn, /zoneCount/, "chunk diagnostics should include zone count");
});

test("panel persists Apply Cuts diagnostics to a temp log file", () => {
    const main = readProjectFile("client/js/main.js");

    assert.match(main, /nodeOs\s*=\s*nodeRequire\("os"\)/, "panel should load os module for temp log path");
    assert.match(main, /function getApplyCutsLogPath\(/, "panel should expose an Apply Cuts log path helper");
    assert.match(main, /duckycut-apply-cuts\.log/, "log file name should be stable and searchable");
    assert.match(main, /function writeApplyCutsLog\(/, "panel should have a persistent log writer");
    assert.match(main, /appendFileSync\(/, "panel should append diagnostics to disk");

    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");
    const end = main.indexOf("\n    // â”€â”€ UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /writeApplyCutsLog\("chunk"/, "chunk diagnostics should be persisted");
    assert.match(fn, /writeApplyCutsLog\("host-diag"/, "host diagnostics should be persisted");
    assert.match(fn, /writeApplyCutsLog\("zone-diag"/, "zone diagnostics should be persisted");
    assert.match(fn, /Log:/, "error status should tell the user where the log was written");
});

test("host target polling can collect contained clips without diagnostics", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /function _pushCandidate\([\s\S]*if \(!zoneDiag\) return/, "_pushCandidate should tolerate null zoneDiag during polling");
    assert.match(fn, /_collectZoneContainedClipTargets\(targetSeq, zoneStartTicks, zoneEndTicks, null\)/, "target polling should be able to collect without logging candidates");
});

test("host razor refresh waits for contained targets, not just clip count changes", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);
    const refreshStart = fn.indexOf("function _waitForRazorRefresh");
    assert.notEqual(refreshStart, -1, "_waitForRazorRefresh should exist");
    const refreshEnd = fn.indexOf("\n        function _waitForContainedTargets", refreshStart + 1);
    const refreshFn = fn.slice(refreshStart, refreshEnd === -1 ? fn.length : refreshEnd);

    assert.match(refreshFn, /zoneStartTicks/, "razor refresh should receive zone start ticks");
    assert.match(refreshFn, /zoneEndTicks/, "razor refresh should receive zone end ticks");
    assert.match(refreshFn, /_collectZoneContainedClipTargets\(/, "razor refresh should poll for removable contained targets");
    assert.doesNotMatch(refreshFn, /counts\.total\s*>\s*beforeCounts\.total\)\s*break/, "clip count change alone should not mark the DOM ready");
});

test("host reacquires QE sequence per zone and records razor attempts", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);
    const loopStart = fn.indexOf("for (var z = 0; z < zones.length; z++)");
    assert.notEqual(loopStart, -1, "applyCutsInPlace should loop over zones");
    const loopFn = fn.slice(loopStart);

    assert.match(loopFn, /qe\.project\.getActiveSequence\(\)/, "host should reacquire QE active sequence inside the zone loop");
    assert.match(fn, /razorAttempts/, "zone diagnostics should count razor attempts");
    assert.match(fn, /razorErrors/, "zone diagnostics should capture per-track razor failures");
    assert.match(fn, /qeVideoTracks/, "zone diagnostics should record QE video track count");
    assert.match(fn, /qeAudioTracks/, "zone diagnostics should record QE audio track count");
});

test("host target polling suppresses transient collect errors while diagnostics are disabled", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /catch \(eCV\) \{ if \(zoneDiag\) diag\.push\("V collect fail/, "video polling with null zoneDiag should not spam diag on transient clip read errors");
    assert.match(fn, /catch \(eCA\) \{ if \(zoneDiag\) diag\.push\("A collect fail/, "audio polling with null zoneDiag should not spam diag on transient clip read errors");
});

test("host applyCutsInPlace refuses orphan razors that delete no clips", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /_clipIntersectsTicks\(/, "host should detect clips intersecting the zone before razor");
    assert.match(fn, /_collectZoneIntersectingClips\(/, "host should collect pre-razor targets before mutating the timeline");
    assert.match(fn, /preflightTargets/, "zone diagnostics should include pre-razor target count");
    assert.match(fn, /preflightTargets\.total\s*===\s*0[\s\S]*continue/, "zones with no targets should be skipped before razor");
    assert.match(fn, /removeTargets\.total\s*===\s*0[\s\S]*_waitForContainedTargets\(/, "zero-delete guard should retry target discovery before failing");
    assert.match(fn, /deleteRequired/, "host should flag a razor that removed zero clips as an error");
    assert.match(fn, /success:\s*false[\s\S]*deleteRequired:\s*true/, "zero-delete razor should fail instead of being counted as skipped");
});

test("panel reports deleted zones, not generic applied cuts", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function applyCutsInPlaceFromPanel");
    assert.notEqual(start, -1, "applyCutsInPlaceFromPanel should exist");

    const end = main.indexOf("\n    // ── UI Helpers", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /Deleted "\s*\+\s*appliedCount\s*\+\s*" zones/, "success status should describe deleted zones");
    assert.doesNotMatch(fn, /Applied "\s*\+\s*appliedCount\s*\+\s*" cuts/, "success status should not imply razor-only success");
});

test("panel logs per-zone Apply Cuts diagnostics returned by the host", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("applyCutsInPlace(");
    assert.notEqual(start, -1, "applyCutsInPlace call should exist");

    const fn = main.slice(start, main.indexOf("\n    // ── UI Helpers", start));

    assert.match(fn, /_zoneDiag/, "panel should read host per-zone diagnostics");
    assert.match(fn, /applyCutsInPlace zone diag/, "panel should log zone diagnostics with a searchable label");
    assert.ok(
        fn.indexOf("if (data._zoneDiag)") < fn.indexOf("if (!data.success)"),
        "panel should log diagnostics before returning on host errors"
    );
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

test("panel Analyze validates In-Out range, renders that range, and offsets detected silence", () => {
    const main = readProjectFile("client/js/main.js");
    const start = main.indexOf("function runAnalysis");
    assert.notEqual(start, -1, "runAnalysis should exist");

    const end = main.indexOf("\n    // ═", start + 1);
    const fn = main.slice(start, end === -1 ? main.length : end);

    assert.match(fn, /getSelectedRangeMode\(/, "Analyze should read selected range mode");
    assert.match(fn, /getSequenceInOutRange\(/, "Analyze should request In-Out range from host");
    assert.match(fn, /Define In and Out|set In and Out/i, "invalid In-Out should fail clearly");
    assert.match(fn, /ensureSelectedTrackMixdown\(selectedIdx,\s*analysisRangeInfo\)/, "Analyze should render selected Premiere tracks for the active range");
    assert.match(fn, /workAreaType\s*=\s*1/, "In-Out Analyze should export with workAreaType=1");
    assert.match(fn, /offsetIntervals\(/, "Analyze should offset FFmpeg intervals into sequence time");
});

test("panel Analyze uses sequence duration after Premiere-rendered detection", () => {
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

test("host uses QE-specific timecode for drop-frame razor calls", () => {
    const host = readProjectFile("host/index.jsx");
    const start = host.indexOf("function applyCutsInPlace");
    assert.notEqual(start, -1, "applyCutsInPlace should exist");

    const end = host.indexOf("\nfunction applyCutsInPlaceFile", start + 1);
    const fn = host.slice(start, end === -1 ? host.length : end);

    assert.match(fn, /_secondsToQeRazorTimecodeHost/, "host should have a QE-specific razor timecode helper");
    assert.match(fn, /displayStartTC/, "zone diagnostics should keep display drop-frame timecode separate from QE razor timecode");
    assert.match(fn, /displayEndTC/, "zone diagnostics should keep display drop-frame timecode separate from QE razor timecode");
    assert.match(fn, /_zoneToDisplayTC/, "host diagnostics should still expose display timecode");
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
