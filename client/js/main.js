/**
 * Duckycut - Panel Client Logic
 *
 * FIXES:
 *   1. Overlays (V2, V3+): reads ALL tracks via getFullSequenceClips() and passes
 *   2. Audio duplication: each audio clip now references its own sourcetrack
 *      channel; generator no longer duplicates A1 across all tracks.
 *   3. Framerate: getSequenceSettings() reads timebase directly from the
 *      sequence — no hardcoded 29.97 fallback unless the API truly fails.
 *   4. Audio selection: Analyze renders the checked Premiere tracks with
 *      temporary mutes, then runs detection on that rendered mix.
 */

(function () {
    "use strict";

    const csInterface = new CSInterface();
    const APPLY_CUTS_CHUNK_SIZE = 8;
    const APPLY_CUTS_CHUNK_SETTLE_DELAY_MS = 250;
    const SEQUENCE_AUTO_REFRESH_INTERVAL_MS = 5000;

    let silenceDetector = null;
    let vadDetector     = null;
    let nodeRequire     = null;
    let modulesError    = "";
    let nodeFs          = null;
    let nodePath        = null;
    let nodeOs          = null;

    // ── Load Node.js modules ─────────────────────────────────────
    try {
        if      (typeof window.nodeRequire === "function")                          nodeRequire = window.nodeRequire;
        else if (typeof cep_node !== "undefined" && cep_node.require)               nodeRequire = cep_node.require;
        else if (typeof window.cep_node !== "undefined" && window.cep_node.require) nodeRequire = window.cep_node.require;
        else if (typeof require === "function")                                      nodeRequire = require;
    } catch (e) { modulesError = "No Node.js require: " + e.message; }

    if (nodeRequire) {
        try {
            nodePath = nodeRequire("path");
            nodeFs   = nodeRequire("fs");
            nodeOs   = nodeRequire("os");
            var serverDir = null;

            if (typeof __dirname !== "undefined" && __dirname) {
                var c1 = nodePath.resolve(__dirname, "..", "server");
                var c2 = nodePath.resolve(__dirname, "server");
                if (nodeFs.existsSync(c1)) serverDir = c1;
                else if (nodeFs.existsSync(c2)) serverDir = c2;
            }
            if (!serverDir) {
                var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
                if (extPath) {
                    extPath = extPath.replace(/^\/([a-zA-Z])\//, "$1:/");
                    serverDir = nodePath.join(extPath, "server");
                }
            }
            if (!serverDir) {
                var docPath = decodeURIComponent(document.location.pathname);
                if (docPath.match(/^\/[a-zA-Z]:\//)) docPath = docPath.substring(1);
                serverDir = nodePath.resolve(nodePath.dirname(docPath), "..", "server");
            }

            silenceDetector = nodeRequire(nodePath.join(serverDir, "silenceDetector.js"));
            vadDetector = nodeRequire(nodePath.join(serverDir, "vadDetector.js"));
        } catch (e) {
            modulesError = e.message;
        }
    } else if (!modulesError) {
        modulesError = "Node.js not available";
    }

    // ── DOM elements ─────────────────────────────────────────────
    const elSequenceName      = document.getElementById("sequenceName");
    const elBtnRefreshSeq     = document.getElementById("btnRefreshSeq");
    const elAggressiveness    = document.getElementById("aggressiveness");
    const elAggressivenessVal = document.getElementById("aggressivenessVal");
    const elAggroThresholdHint= document.getElementById("aggroThresholdHint");
    const elMinDuration       = document.getElementById("minDuration");
    const elMinDurationVal    = document.getElementById("minDurationVal");
    const elPaddingIn         = document.getElementById("paddingIn");
    const elPaddingInVal      = document.getElementById("paddingInVal");
    const elPaddingOut        = document.getElementById("paddingOut");
    const elPaddingOutVal     = document.getElementById("paddingOutVal");
    const elMinClipDuration   = document.getElementById("minClipDuration");
    const elMinClipVal        = document.getElementById("minClipVal");
    const elMinGapFill        = document.getElementById("minGapFill");
    const elMinGapFillVal     = document.getElementById("minGapFillVal");
    const elBtnLinkPadding    = document.getElementById("btnLinkPadding");
    const elBtnAdvancedToggle = document.getElementById("btnAdvancedToggle");
    const elAdvancedSettings  = document.getElementById("advancedSettings");
    const elTrackList         = document.getElementById("trackList");
    const elBtnAnalyze        = document.getElementById("btnAnalyze");
    const elResultsSection    = document.getElementById("resultsSection");
    const elResultsContent    = document.getElementById("resultsContent");
    const elBtnApply          = document.getElementById("btnApply");
    const elProgressSection   = document.getElementById("progressSection");
    const elProgressFill      = document.getElementById("progressFill");
    const elProgressText      = document.getElementById("progressText");
    const elStatusBar         = document.getElementById("statusBar");
    const elBtnCancelConfig   = document.getElementById("btnCancelConfig");
    const elBtnCancelApply    = document.getElementById("btnCancelApply");
    const elBtnBackStart      = document.getElementById("btnBackStart");
    const elDoneSummary       = document.getElementById("doneSummary");
    const elManualConfigPanel = document.getElementById("manualConfigPanel");
    const elVadConfigPanel    = document.getElementById("vadConfigPanel");
    const elVadInitialCutsCount = document.getElementById("vadInitialCutsCount");
    const elVadPaddingIn      = document.getElementById("vadPaddingIn");
    const elVadPaddingInVal   = document.getElementById("vadPaddingInVal");
    const elVadPaddingOut     = document.getElementById("vadPaddingOut");
    const elVadPaddingOutVal  = document.getElementById("vadPaddingOutVal");
    const elBtnVadLinkPadding = document.getElementById("btnVadLinkPadding");
    const elBtnCancelVadConfig = document.getElementById("btnCancelVadConfig");
    const elBtnApplyVadPlaceholder = document.getElementById("btnApplyVadPlaceholder");

    // ── State ─────────────────────────────────────────────────────
    let sequenceInfo    = null;   // from getActiveSequenceInfo()
    let sequenceClips   = null;   // from getFullSequenceClips() — all tracks
    let analysisResult  = null;
    let keepZones       = null;
    let seqSettings     = null;   // from getSequenceSettings()
    let paddingLinked   = false;  // whether Padding In/Out are synced
    let vadPaddingLinked = false;
    let isPreparingCuts = false;
    let isApplyingCuts  = false;
    let isRefreshingSequence = false;
    let sequenceAutoRefreshTimer = null;
    let applyCancelRequested = false;
    let hideProgressTimer = null;
    let activeScreenName = "start";
    let analysisRangeMode = "full";
    let analysisRangeInfo = null;
    let analysisSession = {
        renderedMixPath: null,
        detectionMode: "manual",
        vadResult: null,
        vadKeepZones: null,
        vadInitialCutCount: null
    };

    function getSelectedTrackIndices() {
        return Array.from(document.querySelectorAll(".track-cb:checked"))
                    .map(function(cb) { return parseInt(cb.value, 10); });
    }

    function getSelectedRangeMode() {
        var selected = document.querySelector('input[name="rangeMode"]:checked');
        return selected ? selected.value : "full";
    }

    function getSelectedDetectionMode() {
        var selected = document.querySelector('input[name="detectionMode"]:checked');
        return selected ? selected.value : "manual";
    }

    function getApplyCutsLogPath() {
        if (!nodePath || !nodeOs) return "";
        return nodePath.join(nodeOs.tmpdir(), "duckycut-apply-cuts.log");
    }

    function writeApplyCutsLog(label, payload) {
        if (!nodeFs || !nodePath || !nodeOs) return "";
        var logPath = getApplyCutsLogPath();
        if (!logPath) return "";
        try {
            var entry = {
                at: new Date().toISOString(),
                label: label,
                payload: payload
            };
            nodeFs.appendFileSync(logPath, JSON.stringify(entry) + "\n", "utf8");
            return logPath;
        } catch (e) {
            try { console.log("[Duckycut] applyCutsInPlace log write failed:", e.message || e); } catch (ignore) {}
            return "";
        }
    }

    // ── Init ─────────────────────────────────────────────────────
    function init() {
        bindSliders();
        bindButtons();
        refreshSequence();
        updateAggroHint();
        showScreen("start");
        startSequenceAutoRefresh();

        if (silenceDetector) {
            setStatus("Ready", "success");
        } else {
            setStatus("Module error: " + (modulesError || "unknown"), "error");
        }
    }

    // ── Sliders ───────────────────────────────────────────────────
    function showScreen(name) {
        activeScreenName = name;
        var screens = document.querySelectorAll(".screen");
        for (var i = 0; i < screens.length; i++) {
            screens[i].style.display = screens[i].getAttribute("data-screen") === name ? "flex" : "none";
        }
    }

    function cleanupAnalysisSession() {
        if (analysisSession && analysisSession.renderedMixPath && nodeFs) {
            try { nodeFs.unlinkSync(analysisSession.renderedMixPath); } catch (_) {}
        }
        analysisSession = {
            renderedMixPath: null,
            detectionMode: "manual",
            vadResult: null,
            vadKeepZones: null,
            vadInitialCutCount: null
        };
    }

    function returnToStart() {
        cleanupAnalysisSession();
        analysisResult = null;
        keepZones = null;
        analysisRangeInfo = null;
        if (elResultsSection) elResultsSection.style.display = "none";
        hideProgress();
        showScreen("start");
    }

    function showConfigForDetectionMode(mode) {
        var isVadMode = mode === "vad";
        if (elManualConfigPanel) elManualConfigPanel.style.display = isVadMode ? "none" : "flex";
        if (elVadConfigPanel) elVadConfigPanel.style.display = isVadMode ? "flex" : "none";
        if (isVadMode) recomputeVadKeepZones();
        if (elVadInitialCutsCount) {
            var count = analysisSession && analysisSession.vadInitialCutCount;
            elVadInitialCutsCount.textContent = count == null ? "--" : String(count);
        }
    }

    function getVadTranslator() {
        return window.Duckycut && window.Duckycut.vadTranslator ? window.Duckycut.vadTranslator : null;
    }

    function bindSliders() {
        elMinDuration.addEventListener("input", () => {
            elMinDurationVal.textContent = elMinDuration.value + " ms";
        });
        elPaddingIn.addEventListener("input", () => {
            elPaddingInVal.textContent = elPaddingIn.value + " ms";
            if (paddingLinked) {
                elPaddingOut.value = elPaddingIn.value;
                elPaddingOutVal.textContent = elPaddingIn.value + " ms";
            }
        });
        elPaddingOut.addEventListener("input", () => {
            elPaddingOutVal.textContent = elPaddingOut.value + " ms";
            if (paddingLinked) {
                elPaddingIn.value = elPaddingOut.value;
                elPaddingInVal.textContent = elPaddingOut.value + " ms";
            }
        });
        if (elVadPaddingIn) elVadPaddingIn.addEventListener("input", () => {
            elVadPaddingInVal.textContent = elVadPaddingIn.value + " ms";
            if (vadPaddingLinked) {
                elVadPaddingOut.value = elVadPaddingIn.value;
                elVadPaddingOutVal.textContent = elVadPaddingIn.value + " ms";
            }
            recomputeVadKeepZones();
        });
        if (elVadPaddingOut) elVadPaddingOut.addEventListener("input", () => {
            elVadPaddingOutVal.textContent = elVadPaddingOut.value + " ms";
            if (vadPaddingLinked) {
                elVadPaddingIn.value = elVadPaddingOut.value;
                elVadPaddingInVal.textContent = elVadPaddingOut.value + " ms";
            }
            recomputeVadKeepZones();
        });
        elMinClipDuration.addEventListener("input", () => {
            elMinClipVal.textContent = elMinClipDuration.value + " ms";
        });
        elMinGapFill.addEventListener("input", () => {
            elMinGapFillVal.textContent = elMinGapFill.value + " ms";
        });
        elAggressiveness.addEventListener("input", () => {
            elAggressivenessVal.textContent = elAggressiveness.value;
            updateAggroHint();
        });
    }

    // ── Aggressiveness → threshold ────────────────────────────────
    function computeThreshold(aggressiveness) {
        var a = parseInt(aggressiveness, 10);
        return Math.round(-50 + a * 35 / 100);
    }

    function updateAggroHint() {
        var threshold = computeThreshold(elAggressiveness.value);
        elAggroThresholdHint.textContent = threshold + " dB";
        elAggressivenessVal.textContent  = elAggressiveness.value;
    }

    // ── Buttons ───────────────────────────────────────────────────
    function bindButtons() {
        if (elBtnRefreshSeq) elBtnRefreshSeq.addEventListener("click", function () { refreshSequence(true); });
        if (elBtnAnalyze) elBtnAnalyze.addEventListener("click", runAnalysis);
        if (elBtnApply) elBtnApply.addEventListener("click", applyCuts);
        if (elBtnCancelApply) elBtnCancelApply.addEventListener("click", cancelApplyCutsFromPanel);
        if (elBtnCancelConfig) elBtnCancelConfig.addEventListener("click", returnToStart);
        if (elBtnCancelVadConfig) elBtnCancelVadConfig.addEventListener("click", returnToStart);
        if (elBtnBackStart) elBtnBackStart.addEventListener("click", returnToStart);
        if (elBtnLinkPadding) elBtnLinkPadding.addEventListener("click", togglePaddingLink);
        if (elBtnVadLinkPadding) elBtnVadLinkPadding.addEventListener("click", toggleVadPaddingLink);
        if (elBtnApplyVadPlaceholder) elBtnApplyVadPlaceholder.addEventListener("click", applyVadCuts);
        if (elBtnAdvancedToggle) elBtnAdvancedToggle.addEventListener("click", toggleAdvanced);
    }

    function toggleAdvanced() {
        var expanded = elBtnAdvancedToggle.classList.toggle("expanded");
        elAdvancedSettings.classList.toggle("expanded", expanded);
    }

    // ── Padding Link ─────────────────────────────────────────────
    function togglePaddingLink() {
        paddingLinked = !paddingLinked;
        elBtnLinkPadding.classList.toggle("active", paddingLinked);
        elBtnLinkPadding.title = paddingLinked
            ? "Padding values are linked - click to unlink"
            : "Link padding values";

        if (paddingLinked) {
            // On link: bottom (Padding Out) immediately copies top (Padding In)
            elPaddingOut.value          = elPaddingIn.value;
            elPaddingOutVal.textContent = elPaddingIn.value + " ms";
        }
    }

    function toggleVadPaddingLink() {
        vadPaddingLinked = !vadPaddingLinked;
        elBtnVadLinkPadding.classList.toggle("active", vadPaddingLinked);
        elBtnVadLinkPadding.title = vadPaddingLinked
            ? "VAD padding values are linked - click to unlink"
            : "Link padding values";

        if (vadPaddingLinked) {
            elVadPaddingOut.value = elVadPaddingIn.value;
            elVadPaddingOutVal.textContent = elVadPaddingIn.value + " ms";
        }
    }

    function applyVadCuts() {
        if (isApplyingCuts) {
            cancelApplyCutsFromPanel();
            return;
        }
        if (!analysisSession || !analysisSession.vadResult) {
            setStatus("VAD result is not available", "error");
            return;
        }
        if (recomputeVadKeepZones() === null) {
            return;
        }
        keepZones = analysisSession.vadKeepZones || [];
        analysisResult = {
            type: "vad",
            mediaDuration: (seqSettings && seqSettings.durationSeconds) || analysisSession.vadResult.mediaDuration,
            speechIntervals: analysisSession.vadResult.speechIntervals,
        };
        return applyCutsInPlaceFromPanel();
    }

    function recomputeVadKeepZones() {
        if (!analysisSession || !analysisSession.vadResult || !analysisSession.vadResult.speechIntervals) return null;
        var translator = getVadTranslator();
        if (!translator || !translator.computeVadKeepZones) {
            setStatus("VAD translator not loaded", "error");
            return null;
        }

        var duration = analysisSession.vadResult.mediaDuration;
        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            duration = analysisRangeInfo.durationSeconds;
        }

        var localKeepZones = translator.computeVadKeepZones(
            analysisSession.vadResult.speechIntervals,
            duration,
            {
                paddingIn: parseInt(elVadPaddingIn.value, 10) / 1000,
                paddingOut: parseInt(elVadPaddingOut.value, 10) / 1000,
                minClipDuration: 0,
                minGapDuration: parseInt(elMinGapFill.value, 10) / 1000,
            }
        );

        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            analysisSession.vadKeepZones = translator.offsetIntervals(localKeepZones, analysisRangeInfo.startSeconds);
        } else {
            analysisSession.vadKeepZones = localKeepZones;
        }

        var totalKept = 0;
        for (var i = 0; i < analysisSession.vadKeepZones.length; i++) {
            totalKept += analysisSession.vadKeepZones[i][1] - analysisSession.vadKeepZones[i][0];
        }
        var fullDuration = duration;
        var localCutZones = translator.computeCutZonesFromKeepZones
            ? translator.computeCutZonesFromKeepZones(localKeepZones, duration)
            : [];
        analysisSession.vadInitialCutCount = localCutZones.length;
        if (elVadInitialCutsCount) elVadInitialCutsCount.textContent = String(analysisSession.vadInitialCutCount);
        setStatus("VAD ready - estimated removed: " + formatTime(Math.max(0, fullDuration - totalKept)), "success");
        return analysisSession.vadKeepZones;
    }

    function runVadAfterPrerender(renderedMixPath) {
        if (!vadDetector || !vadDetector.detectVoiceActivity) {
            return Promise.reject(new Error("VAD detector not loaded"));
        }
        updateProgress(70, "Running Silero VAD...");
        return vadDetector.detectVoiceActivity(renderedMixPath, {})
            .then(function(vadResult) {
                analysisSession.vadResult = vadResult;
                analysisSession.vadInitialCutCount = vadResult.speechIntervals ? Math.max(0, vadResult.speechIntervals.length - 1) : 0;
                recomputeVadKeepZones();
                return vadResult;
            });
    }

    function evalScript(script) {
        return new Promise((resolve) => csInterface.evalScript(script, resolve));
    }

    function jsxStringArg(value) {
        if (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.jsxStringArg) {
            return window.Duckycut.cutZones.jsxStringArg(value);
        }
        return JSON.stringify(String(value == null ? "" : value).replace(/\\/g, "/"));
    }

    function getProjectPathError(raw) {
        if (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.getProjectPathError) {
            return window.Duckycut.cutZones.getProjectPathError(raw);
        }
        try {
            var parsed = JSON.parse(raw || "{}");
            return parsed && parsed.error === "Project not saved"
                ? "Save the Premiere project before running analysis"
                : "";
        } catch (e) {
            return "";
        }
    }

    // ── Refresh Sequence ─────────────────────────────────────────
    // announceStatus === true only for the manual refresh button; the 5s auto
    // refresh stays silent so it can't clobber error messages in the status bar.
    function refreshSequence(announceStatus) {
        if (isRefreshingSequence) return Promise.resolve();
        isRefreshingSequence = true;
        return evalScript("getActiveSequenceInfo()").then((result) => {
            try {
                if (!result || result === "EvalScript_ErrMessage") {
                    elSequenceName.textContent = "No sequence";
                    sequenceInfo = null;
                    return;
                }
                var info = JSON.parse(result);
                if (info.error) { elSequenceName.textContent = "No sequence"; sequenceInfo = null; return; }
                sequenceInfo = info;
                elSequenceName.textContent = info.name;
                populateTrackCheckboxes(info.audioTracks);
                if (announceStatus === true) setStatus("Sequence: " + info.name + " (" + info.framerate.toFixed(2) + " fps)", "success");
            } catch (e) {
                elSequenceName.textContent = "No sequence"; sequenceInfo = null;
            }
        }).then(function() {
            isRefreshingSequence = false;
        }, function(err) {
            isRefreshingSequence = false;
            throw err;
        });
    }

    function isSequenceRefreshAllowed() {
        var screenStart = document.getElementById("screenStart");
        var isStartScreenVisible = activeScreenName === "start" && (!screenStart || screenStart.style.display !== "none");
        return isStartScreenVisible &&
            !isPreparingCuts &&
            !isApplyingCuts &&
            !(elBtnAnalyze && elBtnAnalyze.disabled);
    }

    function startSequenceAutoRefresh() {
        if (sequenceAutoRefreshTimer) return;

        sequenceAutoRefreshTimer = setInterval(function() {
            if (isSequenceRefreshAllowed()) refreshSequence();
        }, SEQUENCE_AUTO_REFRESH_INTERVAL_MS);

        document.addEventListener("visibilitychange", function() {
            if (!document.hidden && isSequenceRefreshAllowed()) refreshSequence();
        });

        window.addEventListener("focus", function() {
            if (isSequenceRefreshAllowed()) refreshSequence();
        });
    }

    function populateTrackCheckboxes(tracks) {
        var previousChecked = {};
        var previousBoxes = document.querySelectorAll(".track-cb");
        for (var p = 0; p < previousBoxes.length; p++) {
            previousChecked[String(previousBoxes[p].value)] = previousBoxes[p].checked;
        }
        var hasPreviousSelection = previousBoxes.length > 0;

        var visibleTracks = (tracks || []).filter(function(t) {
            return t && t.clipCount > 0;
        });
        if (visibleTracks.length === 0) {
            elTrackList.innerHTML = '<span class="track-list-empty">No audio tracks found</span>';
            return;
        }
        elTrackList.innerHTML = "";
        visibleTracks.forEach(function(t) {
            var label = document.createElement("label");
            label.className = "track-item";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "track-cb";
            cb.value = t.index;
            cb.checked = hasPreviousSelection && previousChecked.hasOwnProperty(String(t.index))
                ? previousChecked[String(t.index)]
                : true;
            var text = document.createTextNode(t.name + " (" + t.clipCount + " clips)");
            label.appendChild(cb);
            label.appendChild(text);
            elTrackList.appendChild(label);
        });
    }

    // ── Run Analysis ─────────────────────────────────────────────
    function buildSelectedAudioTracksForDetection(selectedIdx, clips, rangeInfo) {
        var tracksByIndex = {};
        var rangeStart = rangeInfo && rangeInfo.mode === "inout" ? Number(rangeInfo.startSeconds) : 0;
        var rangeEnd = rangeInfo && rangeInfo.mode === "inout" ? Number(rangeInfo.endSeconds) : null;

        if (!clips || !selectedIdx || selectedIdx.length === 0) return [];

        for (var i = 0; i < clips.length; i++) {
            var clip = clips[i];
            if (!clip || clip.trackType !== "audio") continue;
            if (selectedIdx.indexOf(clip.trackIndex) === -1) continue;
            if (!clip.mediaPath) continue;

            var clipStart = Number(clip.start);
            var clipEnd = Number(clip.end);
            if (!(clipEnd > clipStart)) continue;

            var overlapStart = clipStart;
            var overlapEnd = clipEnd;
            if (rangeEnd !== null) {
                overlapStart = Math.max(overlapStart, rangeStart);
                overlapEnd = Math.min(overlapEnd, rangeEnd);
                if (!(overlapEnd > overlapStart)) continue;
            }

            if (!tracksByIndex[clip.trackIndex]) {
                tracksByIndex[clip.trackIndex] = { index: clip.trackIndex, clips: [] };
            }

            tracksByIndex[clip.trackIndex].clips.push({
                mediaPath: clip.mediaPath,
                seqStart: overlapStart - rangeStart,
                seqEnd: overlapEnd - rangeStart,
                srcIn: clip.mediaIn + (overlapStart - clipStart),
                srcOut: clip.mediaIn + (overlapEnd - clipStart),
            });
        }

        var out = [];
        for (var t = 0; t < selectedIdx.length; t++) {
            if (tracksByIndex[selectedIdx[t]]) out.push(tracksByIndex[selectedIdx[t]]);
        }
        return out;
    }

    function waitForStableFile(filePath, onProgress) {
        return new Promise(function(resolve, reject) {
            var startedAt = Date.now();
            var timeoutMs = 180000;
            var stableNeeded = 4;
            var stableCount = 0;
            var lastSize = -1;

            function tick() {
                try {
                    if (Date.now() - startedAt > timeoutMs) {
                        reject(new Error("Timeout waiting for Premiere render output"));
                        return;
                    }
                    if (!nodeFs.existsSync(filePath)) {
                        setTimeout(tick, 300);
                        return;
                    }

                    var stat = nodeFs.statSync(filePath);
                    if (onProgress) onProgress(stat.size);
                    if (stat.size > 0 && stat.size === lastSize) stableCount++;
                    else stableCount = 0;
                    lastSize = stat.size;

                    if (stableCount >= stableNeeded) {
                        resolve(filePath);
                        return;
                    }
                } catch (e) {
                    reject(e);
                    return;
                }
                setTimeout(tick, 300);
            }
            tick();
        });
    }

    function ensureSelectedTrackMixdown(selectedIdx, rangeInfo, presetMode) {
        if (!nodeRequire || !nodeFs || !nodePath) {
            return Promise.reject(new Error("Node.js filesystem modules not available"));
        }

        presetMode = presetMode || "default";
        var nodeOs = nodeRequire("os");
        var extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION);
        var renderedMixPath = nodePath.join(nodeOs.tmpdir(), "duckycut_mixdown_" + Date.now() + ".wav");
        var workAreaType = rangeInfo && rangeInfo.mode === "inout" ? 1 : 0;
        var savedMuteStates = [];

        function restore() {
            return evalScript("restoreAudioTrackMutes(" + jsxStringArg(JSON.stringify(savedMuteStates)) + ")")
                .then(function(restoreRaw) {
                    var restoreResult = {};
                    try { restoreResult = JSON.parse(restoreRaw || "{}"); } catch (e) {}
                    if (!restoreResult.success) {
                        var restoreMessage = restoreResult.error || "Unable to restore Premiere track mutes";
                        if (restoreResult.diagnostics) {
                            try { restoreMessage += ": " + JSON.stringify(restoreResult.diagnostics); } catch (diagErr) {}
                        }
                        throw new Error(restoreMessage);
                    }
                    return restoreResult;
                });
        }

        function restoreAndReject(err) {
            return restore().then(function() {
                throw err;
            }, function() {
                throw err;
            });
        }

        return evalScript("muteAudioTracks(" + jsxStringArg(JSON.stringify(selectedIdx)) + ")")
            .then(function(muteRaw) {
                var muteResult = {};
                try { muteResult = JSON.parse(muteRaw || "{}"); } catch (e) {}
                if (muteResult.diagnostics) {
                    try { console.log("[Duckycut] muteAudioTracks diagnostics:", muteResult.diagnostics); } catch (logErr) {}
                }
                savedMuteStates = muteResult.savedStates || [];
                if (!muteResult.success) {
                    var muteMessage = muteResult.error || "Unable to set Premiere track mutes";
                    if (muteResult.diagnostics) {
                        try { muteMessage += ": " + JSON.stringify(muteResult.diagnostics); } catch (diagErr) {}
                    }
                    throw new Error(muteMessage);
                }

                return evalScript(
                    "exportSequenceAudio(" +
                    jsxStringArg(renderedMixPath) + "," +
                    jsxStringArg(extensionRoot) + "," +
                    workAreaType + "," +
                    jsxStringArg(presetMode) +
                    ")"
                );
            })
            .then(function(exportRaw) {
                var exportResult = {};
                try { exportResult = JSON.parse(exportRaw || "{}"); } catch (e) {}
                if (!exportResult.success) {
                    throw new Error(exportResult.error || "Premiere render failed");
                }
                return waitForStableFile(renderedMixPath, function(size) {
                    updateProgress(25, "Rendering Premiere audio mix... " + Math.round(size / 1024 / 1024) + " MB");
                });
            })
            .then(function() {
                return restore().then(function() {
                    return renderedMixPath;
                });
            }, restoreAndReject);
    }

    function runAnalysis() {
        if (!sequenceInfo) { setStatus("No active sequence", "error"); return; }
        if (!silenceDetector || !silenceDetector.detectSilence) { setStatus("Silence detector not loaded", "error"); return; }

        var selectedIdx = getSelectedTrackIndices();
        if (selectedIdx.length === 0) {
            setStatus("Select at least one audio track", "error"); return;
        }

        analysisRangeMode = getSelectedRangeMode();
        analysisRangeInfo = null;
        analysisSession.detectionMode = getSelectedDetectionMode();
        analysisSession.vadResult = null;
        analysisSession.vadKeepZones = null;
        analysisSession.vadInitialCutCount = null;
        if (analysisSession.detectionMode === "vad" && (!vadDetector || !vadDetector.detectVoiceActivity)) {
            setStatus("VAD detector not loaded: " + (modulesError || "unknown"), "error"); return;
        }

        elBtnAnalyze.disabled = true;
        elResultsSection.style.display = "none";
        showScreen("prerender");
        showProgress("Reading sequence tracks...");

        var rangePromise = analysisRangeMode === "inout"
            ? evalScript("getSequenceInOutRange()")
            : Promise.resolve('{"success":true,"valid":true}');

        Promise.all([
            evalScript("getProjectPath()"),
            evalScript("getFullSequenceClips()"),
            evalScript("getSequenceSettings()"),
            rangePromise,
        ]).then(function([projectRaw, clipsRaw, settingsRaw, rangeRaw]) {
            var projectError = getProjectPathError(projectRaw);
            if (projectError) {
                setStatus(projectError, "error");
                hideProgress(); elBtnAnalyze.disabled = false; showScreen("start");
                return;
            }

            try {
                var parsed = JSON.parse(clipsRaw);
                sequenceClips = Array.isArray(parsed) ? parsed : null;
            } catch (e) { sequenceClips = null; }

            try {
                seqSettings = JSON.parse(settingsRaw);
                if (seqSettings.error) seqSettings = null;
            } catch (e) { seqSettings = null; }

            var rangeInfo = null;
            try { rangeInfo = JSON.parse(rangeRaw || "{}"); } catch (e) { rangeInfo = null; }
            if (analysisRangeMode === "inout") {
                if (!rangeInfo || !rangeInfo.success || !rangeInfo.valid || !(rangeInfo.endSeconds > rangeInfo.startSeconds)) {
                    setStatus("Define In and Out in the Premiere timeline before using Range: In-Out", "error");
                    hideProgress(); elBtnAnalyze.disabled = false; showScreen("start");
                    return;
                }
                rangeInfo.mode = "inout";
                rangeInfo.workAreaType = 1;
                analysisRangeInfo = rangeInfo;
                console.log("[Duckycut] In-Out range:", {
                    startSeconds: rangeInfo.startSeconds,
                    endSeconds: rangeInfo.endSeconds,
                    durationSeconds: rangeInfo.durationSeconds,
                    rawStartSeconds: rangeInfo.rawStartSeconds,
                    rawEndSeconds: rangeInfo.rawEndSeconds,
                    zeroPointSeconds: rangeInfo.zeroPointSeconds,
                    normalizedByZeroPoint: rangeInfo.normalizedByZeroPoint
                });
            }

            updateProgress(10, "Preparing audio for analysis...");

            var presetMode = "reduced";

            var selectedAudioTracks = buildSelectedAudioTracksForDetection(selectedIdx, sequenceClips, analysisRangeInfo);
            if (selectedAudioTracks.length === 0) {
                setStatus("No audio clips found in selected tracks", "error");
                hideProgress(); elBtnAnalyze.disabled = false; showScreen("start");
                return;
            }

            updateProgress(25, "Rendering Premiere audio mix...");
            ensureSelectedTrackMixdown(selectedIdx, analysisRangeInfo, presetMode)
                .then(function(renderedMixPath) {
                    analysisSession.renderedMixPath = renderedMixPath;
                    analysisResult = null;
                    keepZones = null;
                    if (analysisSession.detectionMode === "vad") {
                        return runVadAfterPrerender(renderedMixPath).then(function() {
                            updateProgress(100, "VAD analysis complete!");
                            showConfigForDetectionMode(analysisSession.detectionMode);
                            setStatus("VAD analysis complete - adjust padding and apply cuts", "success");
                            showScreen("config");
                            hideProgress(); elBtnAnalyze.disabled = false;
                        });
                    }
                    updateProgress(100, "Prerender complete!");
                    showConfigForDetectionMode(analysisSession.detectionMode);
                    setStatus("Prerender complete - adjust settings and apply cuts", "success");
                    showScreen("config");
                    hideProgress(); elBtnAnalyze.disabled = false;
                })
                .catch(function(err) {
                    setStatus("Prerender error: " + (err.message || "unknown"), "error");
                    cleanupAnalysisSession();
                    analysisResult = null;
                    keepZones = null;
                    analysisRangeInfo = null;
                    showScreen("start");
                    hideProgress(); elBtnAnalyze.disabled = false;
                });
        });
    }

    // ══════════════════════════════════════════════════════════════
    function prepareCutZonesFromCurrentConfig() {
        if (!silenceDetector || !silenceDetector.detectSilence) {
            return Promise.reject(new Error("Silence detector not loaded"));
        }
        if (!analysisSession || !analysisSession.renderedMixPath) {
            return Promise.reject(new Error("Prerendered audio is not available"));
        }

        var threshold = computeThreshold(elAggressiveness.value);
        var minDuration = parseInt(elMinDuration.value, 10) / 1000;
        updateProgress(15, "Running FFmpeg silence detection on saved render...");

        return silenceDetector.detectSilence(analysisSession.renderedMixPath, threshold, minDuration)
            .then(function(result) {
                return processDetectionResult(result, threshold);
            });
    }

    function processDetectionResult(result, threshold) {
        updateProgress(30, "Applying cut algorithm...");

        var rawSilenceIntervals = result.silenceIntervals || [];
        var silenceIntervals = rawSilenceIntervals;
        var mediaDuration = seqSettings && seqSettings.durationSeconds
            ? seqSettings.durationSeconds
            : result.mediaDuration;
        var analysisWindowDuration = mediaDuration;
        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            analysisWindowDuration = analysisRangeInfo.durationSeconds;
        }
        result.mediaDuration = mediaDuration;
        analysisResult = result;

        var computedKeepZones = computeCleanCutZones(
            rawSilenceIntervals,
            analysisWindowDuration,
            {
                paddingIn:       parseInt(elPaddingIn.value, 10)       / 1000,
                paddingOut:      parseInt(elPaddingOut.value, 10)      / 1000,
                minClipDuration: parseInt(elMinClipDuration.value, 10) / 1000,
                minGapDuration:  parseInt(elMinGapFill.value, 10)      / 1000,
            }
        );

        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            silenceIntervals = offsetIntervalsForAnalysis(rawSilenceIntervals, analysisRangeInfo.startSeconds);
            keepZones = offsetIntervalsForAnalysis(computedKeepZones, analysisRangeInfo.startSeconds);
        } else {
            silenceIntervals = rawSilenceIntervals;
            keepZones = computedKeepZones;
        }
        result.silenceIntervals = silenceIntervals;

        showResults(result, keepZones, true);
        setStatus("Analysis complete - threshold: " + threshold + " dB (Premiere audio mix)", "success");
        return keepZones;
    }

    // ══════════════════════════════════════════════════════════════
    //  CLEAN CUT ALGORITHM  (6-step, corrected order)
    //
    //  Order matters:  Invert → Fill Gaps → Pad → Merge → Drop → Clamp
    //
    //  Old bug: "drop micro-segments" ran BEFORE padding, so short
    //  but legitimate speech fragments were killed before the safety
    //  margin (padding) could save them.  Now drop runs AFTER padding
    //  and merge, so the final duration includes the added margins.
    // ══════════════════════════════════════════════════════════════
    function computeCleanCutZones(silenceIntervals, totalDuration, opts) {
        var paddingIn       = opts.paddingIn       || 0;
        var paddingOut      = opts.paddingOut      || 0;
        var minClipDuration = opts.minClipDuration || 0;
        var minGapDuration  = opts.minGapDuration  || 0;

        if (!silenceIntervals || silenceIntervals.length === 0) return [[0, totalDuration]];

        // Step 0: invert silence intervals → raw speech (keep) zones
        var rawSpeech = [];
        var cursor = 0;
        for (var i = 0; i < silenceIntervals.length; i++) {
            var silStart = Math.max(0, silenceIntervals[i][0]);
            var silEnd   = silenceIntervals[i][1];
            if (silStart > cursor) rawSpeech.push([cursor, silStart]);
            cursor = silEnd;
        }
        if (cursor < totalDuration) rawSpeech.push([cursor, totalDuration]);
        if (rawSpeech.length === 0) return [[0, totalDuration]];

        // Step 1: fill small gaps — merge zones separated by ≤ minGapDuration
        var gapFilled = [rawSpeech[0].slice()];
        for (var j = 1; j < rawSpeech.length; j++) {
            var last    = gapFilled[gapFilled.length - 1];
            var gapSize = rawSpeech[j][0] - last[1];
            if (gapSize <= minGapDuration) last[1] = rawSpeech[j][1];
            else gapFilled.push(rawSpeech[j].slice());
        }

        // Step 2: asymmetric padding (expand each zone)
        var padded = gapFilled.map(function (z) {
            return [z[0] - paddingIn, z[1] + paddingOut];
        });

        // Step 3: merge overlaps created by padding expansion
        var merged = mergeOverlappingIntervals(padded);

        // Step 4: drop short clips — NOW, after padding has had its chance
        var valid = merged.filter(function (z) { return (z[1] - z[0]) >= minClipDuration; });
        if (valid.length === 0) return [[0, totalDuration]];

        // Step 5: clamp boundaries to [0, totalDuration]
        for (var k = 0; k < valid.length; k++) {
            if (valid[k][0] < 0)             valid[k][0] = 0;
            if (valid[k][1] > totalDuration) valid[k][1] = totalDuration;
        }

        // Step 6: final merge + re-filter after clamp
        //  Clamping can make adjacent zones touch at 0 or totalDuration,
        //  and can shrink zones below minClipDuration.
        var final = mergeOverlappingIntervals(valid);
        if (minClipDuration > 0) {
            final = final.filter(function (z) { return (z[1] - z[0]) >= minClipDuration; });
        }

        return final.length > 0 ? final : [[0, totalDuration]];
    }

    function mergeOverlappingIntervals(arr) {
        if (!arr || arr.length === 0) return [];
        arr.sort((a, b) => a[0] - b[0]);
        var merged = [[arr[0][0], arr[0][1]]];
        for (var i = 1; i < arr.length; i++) {
            var last = merged[merged.length - 1];
            if (arr[i][0] <= last[1]) last[1] = Math.max(last[1], arr[i][1]);
            else merged.push([arr[i][0], arr[i][1]]);
        }
        return merged;
    }

    function getCutZoneHelpers() {
        return window.Duckycut && window.Duckycut.cutZones ? window.Duckycut.cutZones : null;
    }

    function offsetIntervalsForAnalysis(intervals, offsetSeconds) {
        var helpers = getCutZoneHelpers();
        if (helpers && helpers.offsetIntervals) {
            return helpers.offsetIntervals(intervals, offsetSeconds);
        }
        var offset = Number(offsetSeconds) || 0;
        var out = [];
        if (!intervals) return out;
        for (var i = 0; i < intervals.length; i++) {
            out.push([Number(intervals[i][0]) + offset, Number(intervals[i][1]) + offset]);
        }
        return out;
    }

    function intersectIntervalsWithRangeForApply(intervals, range) {
        var helpers = getCutZoneHelpers();
        if (helpers && helpers.intersectIntervalsWithRange) {
            return helpers.intersectIntervalsWithRange(intervals, range);
        }
        var out = [];
        if (!intervals || !range) return out;
        var start = Number(range.startSeconds);
        var end = Number(range.endSeconds);
        if (!(end > start)) return out;
        for (var i = 0; i < intervals.length; i++) {
            var s = Math.max(Number(intervals[i][0]), start);
            var e = Math.min(Number(intervals[i][1]), end);
            if (e > s) out.push([s, e]);
        }
        return out;
    }

    // ── Show Results ─────────────────────────────────────────────
    function showResults(analysis, zones, wasRendered) {
        var totalKept = zones.reduce((sum, z) => sum + (z[1] - z[0]), 0);
        var timeSaved = analysis.mediaDuration - totalKept;
        var renderNote = wasRendered
            ? '<div class="result-line result-note"><span>Audio source:</span><span class="result-value">Rendered mixdown</span></div>'
            : '<div class="result-line result-note"><span>Audio source:</span><span class="result-value">Source file</span></div>';

        elResultsContent.innerHTML =
            renderNote +
            '<div class="result-line"><span>Silence regions found:</span><span class="result-value">' + analysis.silenceCount    + '</span></div>' +
            '<div class="result-line"><span>Time saved:</span><span class="result-value">'            + formatTime(timeSaved)    + '</span></div>' +
            '<div class="result-line"><span>Keep zones:</span><span class="result-value">'            + zones.length             + '</span></div>' +
            '<div class="result-line"><span>Final duration:</span><span class="result-value">'        + formatTime(totalKept)    + '</span></div>';

        elResultsSection.style.display = "flex";
        elBtnApply.style.display = "block";
    }

    // ── Apply Cuts ───────────────────────────────────────────────
    function applyCuts() {
        if (isApplyingCuts) {
            cancelApplyCutsFromPanel();
            return;
        }
        if (isPreparingCuts) {
            return;
        }
        if (!analysisSession || !analysisSession.renderedMixPath) {
            setStatus("Run analysis before applying cuts", "error"); return;
        }
        isPreparingCuts = true;
        elBtnApply.disabled = true;
        showScreen("apply");
        showProgress("Preparing cut zones...");
        return prepareCutZonesFromCurrentConfig()
            .then(function() {
                isPreparingCuts = false;
                return applyCutsInPlaceFromPanel();
            })
            .catch(function(err) {
                isPreparingCuts = false;
                setStatus("Apply error: " + (err.message || "unknown"), "error");
                hideProgress();
                endApplyCancelMode();
                showScreen("config");
            });
    }

    function beginApplyCancelMode() {
        isApplyingCuts = true;
        applyCancelRequested = false;
        showScreen("apply");
        if (elBtnCancelApply) {
            elBtnCancelApply.disabled = false;
            elBtnCancelApply.textContent = "Cancelar";
            elBtnCancelApply.classList.add("btn-danger");
            elBtnCancelApply.title = "Cancelar cortes imediatamente";
        }
    }

    function endApplyCancelMode() {
        isApplyingCuts = false;
        applyCancelRequested = false;
        elBtnApply.disabled = false;
        if (elBtnCancelApply) {
            elBtnCancelApply.disabled = false;
            elBtnCancelApply.textContent = "Cancelar";
            elBtnCancelApply.classList.remove("btn-danger");
            elBtnCancelApply.title = "";
        }
    }

    function cancelApplyCutsFromPanel() {
        if (applyCancelRequested) return;
        applyCancelRequested = true;
        updateProgress(100, "Cancelando cortes...");
        setStatus("Cancelando cortes...", "error");
        evalScript("cancelApplyCuts()").catch(function () {});
    }

    // Snap a sub-frame seconds value onto the nearest frame boundary using the
    // same rounding the host TC converter uses. Eliminates ±½-frame drift from
    // independent rounding of zone start vs end downstream.
    function snapSecondsToFrame(seconds, fps, isNTSC) {
        if (!fps || fps <= 0) fps = 29.97;
        var nominalFps = Math.round(fps);
        var totalFrames;
        if (isNTSC) {
            totalFrames = Math.round(seconds * nominalFps * 1000 / 1001);
            return totalFrames * 1001 / (1000 * nominalFps);
        }
        totalFrames = Math.round(seconds * fps);
        return totalFrames / fps;
    }

    function applyCutsInPlaceFromPanel() {
        beginApplyCancelMode();
        showProgress("Computing cut zones...");

        const totalDuration = (analysisResult && analysisResult.mediaDuration)
            || (seqSettings && seqSettings.durationSeconds) || 0;
        if (!totalDuration) {
            setStatus("Unknown sequence duration", "error");
            hideProgress(); endApplyCancelMode(); return;
        }

        const fps    = (seqSettings && seqSettings.framerate)
                    || (sequenceInfo && sequenceInfo.framerate) || 29.97;
        const isNTSC = (seqSettings && typeof seqSettings.isNTSC !== "undefined")
                    ? seqSettings.isNTSC
                    : (sequenceInfo && sequenceInfo.isNTSC) || false;
        const isDropFrame = (seqSettings && typeof seqSettings.isDropFrame === "boolean")
                    ? seqSettings.isDropFrame : false;

        const sorted = (keepZones || []).slice().sort(function (a, b) { return a[0] - b[0]; });
        const rawCuts = [];
        let cursor = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (sorted[i][0] > cursor) rawCuts.push([cursor, sorted[i][0]]);
            cursor = sorted[i][1];
        }
        if (cursor < totalDuration) rawCuts.push([cursor, totalDuration]);

        var rangedCuts = rawCuts;
        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            rangedCuts = intersectIntervalsWithRangeForApply(rawCuts, analysisRangeInfo);
        }

        // Snap each boundary to a frame so the host's TC conversion can't shift
        // it by ±½ frame (asymmetric round of zone start vs end). Drop zones
        // that collapse to zero width after snapping.
        const cutZones = (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.prepareCutZonesForApply)
            ? window.Duckycut.cutZones.prepareCutZonesForApply(rangedCuts, fps, isNTSC)
            : mergeOverlappingIntervals(rangedCuts.map(function (z) {
                return [snapSecondsToFrame(z[0], fps, isNTSC), snapSecondsToFrame(z[1], fps, isNTSC)];
            }).filter(function (z) { return z[1] > z[0]; }));

        const tickCutZones = (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.prepareTickCutZonesForApply)
            ? window.Duckycut.cutZones.prepareTickCutZonesForApply(cutZones, fps, isNTSC)
            : cutZones.map(function (z) {
                return {
                    startSeconds: z[0],
                    endSeconds: z[1],
                    startTicks: String(Math.round(z[0] * 254016000000)),
                    endTicks: String(Math.round(z[1] * 254016000000))
                };
            });

        if (cutZones.length === 0) {
            setStatus("Nothing to cut — keep zones cover the whole sequence", "info");
            hideProgress(); endApplyCancelMode(); return;
        }

        updateProgress(40, "Razoring " + cutZones.length + " zones...");

        const optsArg  = JSON.stringify(JSON.stringify({
            fps: fps,
            isNTSC: isNTSC,
            isDropFrame: isDropFrame,
            tickMode: true,
            qeTimecodeMode: isDropFrame ? "display" : "absolute",
            range: analysisRangeInfo && analysisRangeInfo.mode === "inout" ? {
                startSeconds: analysisRangeInfo.startSeconds,
                endSeconds: analysisRangeInfo.endSeconds
            } : null
        }));

        const zonesToApply = tickCutZones.slice().sort(function (a, b) {
            return Number(b.startTicks) - Number(a.startTicks);
        });
        const cutChunks = (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.chunkArray)
            ? window.Duckycut.cutZones.chunkArray(zonesToApply, APPLY_CUTS_CHUNK_SIZE)
            : (function () {
                var out = [];
                for (var i = 0; i < zonesToApply.length; i += APPLY_CUTS_CHUNK_SIZE) {
                    out.push(zonesToApply.slice(i, i + APPLY_CUTS_CHUNK_SIZE));
                }
                return out;
            }());

        function finishCancelled(appliedCount) {
            updateProgress(100, "Cancelado");
            setStatus("Cortes cancelados" + (appliedCount ? " após " + appliedCount + " zonas" : ""), "error");
            cleanupAnalysisSession();
            hideProgress(); endApplyCancelMode(); showScreen("config");
        }

        function runNextCutChunk(index, appliedCount, skippedCount) {
            if (applyCancelRequested) {
                finishCancelled(appliedCount);
                return;
            }

            if (index >= cutChunks.length) {
                updateProgress(100, "Done!");
                setStatus("Deleted " + appliedCount + " zones" +
                    (skippedCount ? " (" + skippedCount + " skipped)" : ""), "success");
                if (elDoneSummary) {
                    elDoneSummary.innerHTML =
                        '<div class="result-line"><span>Zonas deletadas:</span><span class="result-value">' + appliedCount + '</span></div>' +
                        '<div class="result-line"><span>Zonas puladas:</span><span class="result-value">' + skippedCount + '</span></div>';
                }
                cleanupAnalysisSession();
                showScreen("done");
                hideProgress(); endApplyCancelMode();
                return;
            }

            updateProgress(
                Math.min(95, 40 + Math.round((index / cutChunks.length) * 55)),
                "Razoring chunk " + (index + 1) + " of " + cutChunks.length + "..."
            );

            const chunkStartedAt = Date.now();
            evalScript("applyCutsInPlace(" + jsxStringArg(JSON.stringify(cutChunks[index])) + ", " + optsArg + ")")
                .then(function (raw) {
                    const chunkElapsedMs = Date.now() - chunkStartedAt;
                    var data = null;
                    var logPath = "";
                    try { data = JSON.parse(raw); }
                    catch (e) {
                        logPath = writeApplyCutsLog("parse-error", {
                            chunkIndex: index,
                            chunkCount: cutChunks.length,
                            zoneCount: cutChunks[index].length,
                            raw: raw,
                            error: e.message
                        });
                        setStatus("Cut parse error: " + e.message + " :: raw=" + raw + (logPath ? " | Log: " + logPath : ""), "error");
                        hideProgress(); endApplyCancelMode(); showScreen("config");
                        return;
                    }

                    if (data.cancelled || applyCancelRequested) {
                        finishCancelled(appliedCount + (data.applied || 0));
                        return;
                    }
                    var chunkDiag = {
                        chunkIndex: index,
                        chunkCount: cutChunks.length,
                        zoneCount: cutChunks[index].length,
                        chunkElapsedMs: chunkElapsedMs,
                        applied: data.applied || 0,
                        skipped: data.skipped || 0
                    };
                    console.log("[Duckycut] applyCutsInPlace chunk diag:", chunkDiag);
                    logPath = writeApplyCutsLog("chunk", chunkDiag) || logPath;
                    if (data._diag) {
                        console.log("[Duckycut] applyCutsInPlace diag:", data._diag);
                        logPath = writeApplyCutsLog("host-diag", data._diag) || logPath;
                    }
                    if (data._zoneDiag) {
                        console.log("[Duckycut] applyCutsInPlace zone diag:", data._zoneDiag);
                        logPath = writeApplyCutsLog("zone-diag", data._zoneDiag) || logPath;
                    }
                    if (!data.success) {
                        setStatus("Cut error: " + (data.error || "unknown") + (logPath ? " | Log: " + logPath : ""), "error");
                        hideProgress(); endApplyCancelMode(); showScreen("config");
                        return;
                    }

                    setTimeout(function () {
                        runNextCutChunk(index + 1, appliedCount + (data.applied || 0), skippedCount + (data.skipped || 0));
                    }, APPLY_CUTS_CHUNK_SETTLE_DELAY_MS);
                })
                .catch(function (err) {
                    var logPath = writeApplyCutsLog("eval-error", {
                        chunkIndex: index,
                        chunkCount: cutChunks.length,
                        zoneCount: cutChunks[index].length,
                        error: err && err.message ? err.message : "unknown"
                    });
                    setStatus("Cut error: " + (err.message || "unknown") + (logPath ? " | Log: " + logPath : ""), "error");
                    hideProgress(); endApplyCancelMode(); showScreen("config");
                });
        }

        runNextCutChunk(0, 0, 0);
    }

    // ── UI Helpers ────────────────────────────────────────────────
    function cancelPendingHideProgress() {
        if (hideProgressTimer) {
            clearTimeout(hideProgressTimer);
            hideProgressTimer = null;
        }
    }
    function showProgress(text) {
        cancelPendingHideProgress();
        elProgressSection.style.display = "block";
        elProgressFill.style.width = "0%";
        elProgressText.textContent = text;
    }
    function updateProgress(pct, text) {
        cancelPendingHideProgress();
        elProgressFill.style.width = pct + "%";
        if (text) elProgressText.textContent = text;
    }
    function hideProgress() {
        cancelPendingHideProgress();
        hideProgressTimer = setTimeout(() => {
            elProgressSection.style.display = "none";
            hideProgressTimer = null;
        }, 1500);
    }
    function setStatus(msg, type) {
        elStatusBar.textContent = msg;
        elStatusBar.className = "status-bar" + (type ? " " + type : "");
    }
    function formatTime(seconds) {
        var total = Math.max(0, Math.round(seconds));
        var m = Math.floor(total / 60);
        var s = total % 60;
        return m + "m " + s + "s";
    }

    init();
})();

