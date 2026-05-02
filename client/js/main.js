/**
 * Duckycut - Panel Client Logic
 *
 * FIXES:
 *   1. Overlays (V2, V3+): reads ALL tracks via getFullSequenceClips() and passes
 *   2. Audio duplication: each audio clip now references its own sourcetrack
 *      channel; generator no longer duplicates A1 across all tracks.
 *   3. Framerate: getSequenceSettings() reads timebase directly from the
 *      sequence — no hardcoded 29.97 fallback unless the API truly fails.
 *   4. Audio pre-render: when Analyze is clicked, the panel asks Premiere
 *      to export a WAV mixdown of the checked audio tracks. FFmpeg analyses
 *      that rendered file, matching the Premiere sequence mix.
 */

(function () {
    "use strict";

    const csInterface = new CSInterface();

    let silenceDetector = null;
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
        } catch (e) {
            modulesError = e.message;
        }
    } else if (!modulesError) {
        modulesError = "Node.js not available";
    }

    // ── DOM elements ─────────────────────────────────────────────
    const elSequenceName      = document.getElementById("sequenceName");
    const elBtnRefreshSeq     = document.getElementById("btnRefreshSeq");
    const elBtnProbe          = document.getElementById("btnProbe");
    const elVolumeIdle        = document.getElementById("volumeIdle");
    const elVolumeStats       = document.getElementById("volumeStats");
    const elVolMean           = document.getElementById("volMean");
    const elVolMax            = document.getElementById("volMax");
    const elVolChannels       = document.getElementById("volChannels");
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
    const elBtnSavePreset     = document.getElementById("btnSavePreset");
    const elBtnLoadPreset     = document.getElementById("btnLoadPreset");
    const elPresetFileInput   = document.getElementById("presetFileInput");
    const elDeleteSilence     = document.getElementById("deleteSilence");
    const elTrackList         = document.getElementById("trackList");
    const elBtnAnalyze        = document.getElementById("btnAnalyze");
    const elResultsSection    = document.getElementById("resultsSection");
    const elResultsContent    = document.getElementById("resultsContent");
    const elBtnApply          = document.getElementById("btnApply");
    const elProgressSection   = document.getElementById("progressSection");
    const elProgressFill      = document.getElementById("progressFill");
    const elProgressText      = document.getElementById("progressText");
    const elStatusBar         = document.getElementById("statusBar");

    // ── State ─────────────────────────────────────────────────────
    let sequenceInfo    = null;   // from getActiveSequenceInfo()
    let sequenceClips   = null;   // from getFullSequenceClips() — all tracks
    let analysisResult  = null;
    let keepZones       = null;
    let probeResult     = null;   // { meanVolume, maxVolume, channelCount }
    let seqSettings     = null;   // from getSequenceSettings()
    let paddingLinked   = false;  // whether Padding In/Out are synced
    let isApplyingCuts  = false;
    let applyCancelRequested = false;
    let analysisRangeMode = "full";
    let analysisRangeInfo = null;

    function getSelectedTrackIndices() {
        return Array.from(document.querySelectorAll(".track-cb:checked"))
                    .map(function(cb) { return parseInt(cb.value, 10); });
    }

    function getSelectedRangeMode() {
        var selected = document.querySelector('input[name="rangeMode"]:checked');
        return selected ? selected.value : "full";
    }

    // ── Init ─────────────────────────────────────────────────────
    function init() {
        bindSliders();
        bindButtons();
        refreshSequence();
        updateAggroHint();

        if (silenceDetector) {
            setStatus("Ready — run Auto Detect to calibrate", "success");
        } else {
            setStatus("Module error: " + (modulesError || "unknown"), "error");
        }
    }

    // ── Sliders ───────────────────────────────────────────────────
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
        if (probeResult) {
            var offset = 15 - (a * 13 / 100);
            return Math.round(probeResult.meanVolume - offset);
        }
        return Math.round(-50 + a * 35 / 100);
    }

    function updateAggroHint() {
        var threshold = computeThreshold(elAggressiveness.value);
        elAggroThresholdHint.textContent = threshold + " dB";
        elAggressivenessVal.textContent  = elAggressiveness.value;
    }

    // ── Buttons ───────────────────────────────────────────────────
    function bindButtons() {
        elBtnRefreshSeq.addEventListener("click", refreshSequence);
        elBtnProbe.addEventListener("click", runProbe);
        elBtnAnalyze.addEventListener("click", runAnalysis);
        elBtnApply.addEventListener("click", applyCuts);
        elBtnLinkPadding.addEventListener("click", togglePaddingLink);
        elBtnAdvancedToggle.addEventListener("click", toggleAdvanced);
        elBtnSavePreset.addEventListener("click", savePreset);
        elBtnLoadPreset.addEventListener("click", () => elPresetFileInput.click());
        elPresetFileInput.addEventListener("change", loadPreset);
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
            ? "Padding values are linked — click to unlink"
            : "Link padding values";

        if (paddingLinked) {
            // On link: bottom (Padding Out) immediately copies top (Padding In)
            elPaddingOut.value          = elPaddingIn.value;
            elPaddingOutVal.textContent = elPaddingIn.value + " ms";
        }
    }

    // ── Presets ───────────────────────────────────────────────────
    function gatherSettings() {
        return {
            duckycut_preset: true,
            version: 1,
            aggressiveness:  parseInt(elAggressiveness.value, 10),
            minDuration:     parseInt(elMinDuration.value, 10),
            paddingIn:       parseInt(elPaddingIn.value, 10),
            paddingOut:      parseInt(elPaddingOut.value, 10),
            paddingLinked:   paddingLinked,
            minClipDuration: parseInt(elMinClipDuration.value, 10),
            minGapFill:      parseInt(elMinGapFill.value, 10),
            deleteSilence:   elDeleteSilence.checked,
        };
    }

    function applySettings(s) {
        if (s.aggressiveness != null)  { elAggressiveness.value = s.aggressiveness; elAggressivenessVal.textContent = s.aggressiveness; updateAggroHint(); }
        if (s.minDuration != null)     { elMinDuration.value = s.minDuration; elMinDurationVal.textContent = s.minDuration + " ms"; }
        if (s.paddingIn != null)       { elPaddingIn.value = s.paddingIn; elPaddingInVal.textContent = s.paddingIn + " ms"; }
        if (s.paddingOut != null)      { elPaddingOut.value = s.paddingOut; elPaddingOutVal.textContent = s.paddingOut + " ms"; }
        if (s.minClipDuration != null) { elMinClipDuration.value = s.minClipDuration; elMinClipVal.textContent = s.minClipDuration + " ms"; }
        if (s.minGapFill != null)      { elMinGapFill.value = s.minGapFill; elMinGapFillVal.textContent = s.minGapFill + " ms"; }
        if (s.deleteSilence != null)   { elDeleteSilence.checked = s.deleteSilence; }
        if (s.paddingLinked != null && s.paddingLinked !== paddingLinked) { togglePaddingLink(); }
    }

    function savePreset() {
        if (!nodeRequire) { setStatus("Node.js not available — cannot save", "error"); return; }

        var settings = gatherSettings();
        var json = JSON.stringify(settings, null, 2);
        var fileName = "duckycut_preset_" + Date.now() + ".json";

        // Save next to the Premiere project file, or fallback to user Desktop
        evalScript("getProjectPath()").then(function (r) {
            var saveDir = null;
            try { var pd = JSON.parse(r); saveDir = pd.projectDir || null; } catch (e) {}

            if (!saveDir) {
                try { saveDir = nodeRequire("os").homedir() + "/Desktop"; } catch (e) {}
            }
            if (!saveDir) { setStatus("Could not determine save location", "error"); return; }

            var nPath = nodeRequire("path");
            var nFs   = nodeRequire("fs");
            var fullPath = nPath.join(saveDir.replace(/\//g, nPath.sep), fileName);

            try {
                nFs.writeFileSync(fullPath, json, "utf8");
                setStatusWithPath("Saved: ", fullPath, "success");
            } catch (err) {
                setStatus("Save error: " + err.message, "error");
            }
        });
    }

    function setStatusWithPath(prefix, fullPath, type) {
        elStatusBar.className = "status-bar" + (type ? " " + type : "");
        elStatusBar.textContent = "";

        var prefixNode = document.createTextNode(prefix);
        var link = document.createElement("a");
        link.className = "status-link";
        link.href = "#";
        link.textContent = fullPath.replace(/\\/g, "/");
        link.title = "Click to reveal in file explorer";
        link.addEventListener("click", function (ev) {
            ev.preventDefault();
            revealInExplorer(fullPath);
        });

        elStatusBar.appendChild(prefixNode);
        elStatusBar.appendChild(link);
    }

    function revealInExplorer(fullPath) {
        if (!nodeRequire) { setStatus("Node.js not available", "error"); return; }
        try {
            var child = nodeRequire("child_process");
            var nativePath = fullPath.replace(/\//g, "\\");
            // Windows: /select, highlights the file in Explorer
            child.exec('explorer /select,"' + nativePath + '"');
        } catch (err) {
            setStatus("Could not open explorer: " + err.message, "error");
        }
    }

    function loadPreset(e) {
        var file = e.target.files[0];
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function (ev) {
            try {
                var s = JSON.parse(ev.target.result);
                if (!s.duckycut_preset) { setStatus("Invalid preset file", "error"); return; }
                applySettings(s);
                setStatus("Preset loaded: " + file.name, "success");
            } catch (err) {
                setStatus("Failed to parse preset: " + err.message, "error");
            }
        };
        reader.readAsText(file);
        elPresetFileInput.value = "";
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
    function refreshSequence() {
        evalScript("getActiveSequenceInfo()").then((result) => {
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
                setStatus("Sequence: " + info.name + " (" + info.framerate.toFixed(2) + " fps)", "success");
            } catch (e) {
                elSequenceName.textContent = "No sequence"; sequenceInfo = null;
            }
        });
    }

    function populateTrackCheckboxes(tracks) {
        if (!tracks || tracks.length === 0) {
            elTrackList.innerHTML = '<span class="track-list-empty">No audio tracks found</span>';
            return;
        }
        elTrackList.innerHTML = "";
        tracks.forEach(function(t) {
            var label = document.createElement("label");
            label.className = "track-item";
            var cb = document.createElement("input");
            cb.type = "checkbox";
            cb.className = "track-cb";
            cb.value = t.index;
            cb.checked = true;
            var text = document.createTextNode(
                t.name + (t.clipCount > 0 ? " (" + t.clipCount + " clips)" : " (empty)")
            );
            label.appendChild(cb);
            label.appendChild(text);
            elTrackList.appendChild(label);
        });
    }

    // ── Auto Detect Volume ────────────────────────────────────────
    function runProbe() {
        if (!silenceDetector || !silenceDetector.probeAudio) {
            setStatus("probeAudio not available", "error"); return;
        }
        if (!sequenceInfo) {
            setStatus("No active sequence", "error"); return;
        }

        elBtnProbe.disabled = true;
        elBtnProbe.textContent = "Detecting...";
        setStatus("Probing audio volume...", "");

        var selectedForProbe = getSelectedTrackIndices();
        if (selectedForProbe.length === 0) {
            setStatus("Select at least one audio track", "error");
            elBtnProbe.disabled = false;
            elBtnProbe.textContent = "Auto Detect";
            return;
        }
        evalScript("getAudioTrackMediaPath(" + selectedForProbe[0] + ")").then(function(r) {
            var mediaPath = null;
            try { mediaPath = JSON.parse(r).path || null; } catch(e) {}
            if (!mediaPath) {
                setStatus("No media found in track", "error");
                elBtnProbe.disabled = false;
                elBtnProbe.textContent = "Auto Detect";
                return;
            }

            silenceDetector.probeAudio(mediaPath)
                .then((result) => {
                    probeResult = result;
                    elVolumeIdle.style.display  = "none";
                    elVolumeStats.style.display = "flex";
                    elVolMean.textContent     = result.meanVolume.toFixed(1) + " dB";
                    elVolMax.textContent      = result.maxVolume.toFixed(1)  + " dB";
                    elVolChannels.textContent = result.channelCount;
                    updateAggroHint();
                    setStatus("Volume detected — threshold calibrated", "success");
                    elBtnProbe.disabled = false;
                    elBtnProbe.textContent = "Re-Detect";
                })
                .catch((err) => {
                    setStatus("Probe error: " + err.message, "error");
                    elBtnProbe.disabled = false;
                    elBtnProbe.textContent = "Auto Detect";
                });
        });
    }

    // ── Run Analysis ─────────────────────────────────────────────
    function restoreMutes(savedStates) {
        if (!savedStates) return Promise.resolve();
        return evalScript("restoreAudioTrackMutes(" + JSON.stringify(JSON.stringify(savedStates)) + ")");
    }

    function ensureSelectedTrackMixdown(selectedIdx, progressBase, progressSpan, rangeInfo) {
        if (!nodeFs || !nodePath || !nodeOs) {
            return Promise.reject(new Error("Node.js File I/O unavailable"));
        }
        if (!selectedIdx || selectedIdx.length === 0) {
            return Promise.reject(new Error("Select at least one audio track"));
        }

        var tempWav = nodePath.join(nodeOs.tmpdir(), "duckycut_temp_mixdown_" + Date.now() + ".wav")
                        .replace(/\\/g, "/");
        var extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION)
                                .replace(/\\/g, "/");
        var savedMuteStates = null;
        var expectedDuration = rangeInfo && rangeInfo.mode === "inout"
            ? rangeInfo.durationSeconds
            : ((seqSettings && seqSettings.durationSeconds)
                || (sequenceInfo && sequenceInfo.durationSeconds) || 0);
        var pollInterval   = 500;
        var stableSampleMs = 300;
        var stableNeeded   = 10;
        var pollTimeout    = Math.max(180000, Math.round(expectedDuration * 1000 * 0.75));
        var elapsed        = 0;
        var base           = progressBase || 10;
        var span           = progressSpan || 20;

        console.log("[Duckycut] Rendering selected tracks as one mixdown:", JSON.stringify(selectedIdx));

        function cleanupOnError(err) {
            return restoreMutes(savedMuteStates).then(function() {
                try { if (nodeFs.existsSync(tempWav)) nodeFs.unlinkSync(tempWav); } catch (e) {}
                throw err;
            });
        }

        function updateMixProgress(pct, msg) {
            updateProgress(Math.min(95, base + Math.round(span * pct)), msg);
        }

        function validateRenderedDuration() {
            if (!silenceDetector || !silenceDetector.probeAudio || !expectedDuration) {
                return Promise.resolve(tempWav);
            }
            return silenceDetector.probeAudio(tempWav).then(function(probe) {
                var renderedDuration = probe && probe.durationSeconds ? probe.durationSeconds : 0;
                var tolerance = Math.max(1, expectedDuration * 0.01);
                console.log("[Duckycut] mixdown duration=", renderedDuration,
                    "expected=", expectedDuration, "tolerance=", tolerance);
                if (renderedDuration && renderedDuration < expectedDuration - tolerance) {
                    throw new Error("Mixdown duration is shorter than sequence duration; possible duration mismatch/truncated Premiere render");
                }
                return tempWav;
            });
        }

        function waitForStableSize() {
            return new Promise(function(resolve, reject) {
                var lastSize = -1;
                var stableCount = 0;

                function sample() {
                    var size = -1;
                    try { size = nodeFs.statSync(tempWav).size; } catch (e) {}

                    if (size > 0 && size === lastSize) {
                        stableCount++;
                        if (stableCount >= stableNeeded) {
                            console.log("[Duckycut] mixdown stable size=", size, "bytes");
                            validateRenderedDuration().then(resolve, reject);
                            return;
                        }
                    } else {
                        stableCount = 0;
                    }
                    lastSize = size;

                    elapsed += stableSampleMs;
                    if (elapsed >= pollTimeout) {
                        reject(new Error("Timeout waiting for Premiere render to finish"));
                        return;
                    }

                    var sizeMB = size > 0 ? (Math.round(size / 1024 / 1024 * 10) / 10) : 0;
                    updateMixProgress(
                        0.65 + Math.min(0.25, stableCount / stableNeeded * 0.25),
                        "Rendering directly in Premiere... " +
                            (sizeMB > 0 ? sizeMB + " MB" : "")
                    );
                    setTimeout(sample, stableSampleMs);
                }
                sample();
            });
        }

        function waitForFile() {
            return new Promise(function(resolve, reject) {
                function tick() {
                    if (nodeFs.existsSync(tempWav)) {
                        waitForStableSize().then(resolve, reject);
                        return;
                    }
                    elapsed += pollInterval;
                    if (elapsed >= pollTimeout) {
                        reject(new Error("Timeout: Premiere didn't produce the WAV"));
                        return;
                    }
                    updateMixProgress(0.25, "Waiting for Premiere render output...");
                    setTimeout(tick, pollInterval);
                }
                tick();
            });
        }

        updateMixProgress(0.05, "Muting unselected audio tracks...");
        return evalScript("muteAudioTracks(" + JSON.stringify(JSON.stringify(selectedIdx)) + ")")
            .then(function(muteRaw) {
                var mr = {};
                try { mr = JSON.parse(muteRaw); } catch(e) {}
                if (!mr.success) throw new Error("Failed to mute tracks: " + (mr.error || "unknown"));
                savedMuteStates = mr.savedStates;

                updateMixProgress(0.15, "Rendering sequence audio directly in Premiere...");
                var workAreaType = rangeInfo && typeof rangeInfo.workAreaType === "number"
                    ? rangeInfo.workAreaType
                    : (rangeInfo && rangeInfo.mode === "inout" ? 1 : 0);
                return evalScript("exportSequenceAudio(" + jsxStringArg(tempWav) + "," + jsxStringArg(extensionRoot) + "," + workAreaType + ")");
            })
            .then(function(r) {
                var res = {};
                try { res = JSON.parse(r); } catch (e) {}
                if (!res.success) throw new Error("Mixdown failed: " + (res.error || "unknown"));
                return waitForFile();
            })
            .then(function(path) {
                return restoreMutes(savedMuteStates).then(function() { return path; });
            })
            .catch(cleanupOnError);
    }

    function runAnalysis() {
        if (!sequenceInfo) { setStatus("No active sequence", "error"); return; }
        if (!silenceDetector) { setStatus("Silence detector not loaded", "error"); return; }

        var selectedIdx = getSelectedTrackIndices();
        if (selectedIdx.length === 0) {
            setStatus("Select at least one audio track", "error"); return;
        }

        analysisRangeMode = getSelectedRangeMode();
        analysisRangeInfo = null;

        elBtnAnalyze.disabled = true;
        elResultsSection.style.display = "none";
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
                hideProgress(); elBtnAnalyze.disabled = false;
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
                    hideProgress(); elBtnAnalyze.disabled = false;
                    return;
                }
                rangeInfo.mode = "inout";
                rangeInfo.workAreaType = 1;
                analysisRangeInfo = rangeInfo;
            }

            updateProgress(10, "Preparing audio for analysis...");

            var threshold   = computeThreshold(elAggressiveness.value);
            var minDuration = parseInt(elMinDuration.value, 10) / 1000;

            ensureSelectedTrackMixdown(selectedIdx, 10, 25, analysisRangeInfo)
                .then(function(tempWav) {
                    runDetection(tempWav);
                })
                .catch(function(err) {
                    setStatus("Analysis error: " + (err.message || "unknown"), "error");
                    hideProgress(); elBtnAnalyze.disabled = false;
                });

            function runDetection(audioPath) {
                updateProgress(25, "Running FFmpeg silence detection (rendered mixdown)...");

                silenceDetector.detectSilence(audioPath, threshold, minDuration)
                    .then(function (result) {
                        analysisResult = result;
                        updateProgress(80, "Applying Clean Cut algorithm...");

                        var silenceIntervals = result.silenceIntervals;
                        var mediaDuration = result.mediaDuration;
                        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
                            silenceIntervals = window.Duckycut.cutZones.offsetIntervals(
                                result.silenceIntervals,
                                analysisRangeInfo.startSeconds
                            );
                            mediaDuration = seqSettings && seqSettings.durationSeconds
                                ? seqSettings.durationSeconds
                                : analysisRangeInfo.endSeconds;
                        }

                        keepZones = computeCleanCutZones(
                            silenceIntervals,
                            mediaDuration,
                            {
                                paddingIn:       parseInt(elPaddingIn.value, 10)       / 1000,
                                paddingOut:      parseInt(elPaddingOut.value, 10)      / 1000,
                                minClipDuration: parseInt(elMinClipDuration.value, 10) / 1000,
                                minGapDuration:  parseInt(elMinGapFill.value, 10)      / 1000,
                            }
                        );

                        try { nodeFs.unlinkSync(audioPath); } catch (e) {}

                        updateProgress(100, "Analysis complete!");
                        showResults(result, keepZones, true);
                        setStatus("Analysis complete — threshold: " + threshold + " dB (rendered mixdown)", "success");
                        hideProgress(); elBtnAnalyze.disabled = false;
                    })
                    .catch(function (err) {
                        try { nodeFs.unlinkSync(audioPath); } catch (e) {}
                        setStatus("FFmpeg error: " + err.message, "error");
                        hideProgress(); elBtnAnalyze.disabled = false;
                    });
            }
        });
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

    // ── Show Results ─────────────────────────────────────────────
    function showResults(analysis, zones, wasRendered) {
        var totalKept = zones.reduce((sum, z) => sum + (z[1] - z[0]), 0);
        var timeSaved = analysis.mediaDuration - totalKept;
        var renderNote = wasRendered
            ? '<div class="result-line result-note"><span>Audio source:</span><span class="result-value">Rendered mixdown ✓</span></div>'
            : '<div class="result-line result-note"><span>Audio source:</span><span class="result-value">Source file</span></div>';

        elResultsContent.innerHTML =
            renderNote +
            '<div class="result-line"><span>Silence regions found:</span><span class="result-value">' + analysis.silenceCount    + '</span></div>' +
            '<div class="result-line"><span>Time saved:</span><span class="result-value">'            + formatTime(timeSaved)    + '</span></div>' +
            '<div class="result-line"><span>Keep zones:</span><span class="result-value">'            + zones.length             + '</span></div>' +
            '<div class="result-line"><span>Final duration:</span><span class="result-value">'        + formatTime(totalKept)    + '</span></div>';

        elResultsSection.style.display = "flex";
        elBtnApply.style.display = elDeleteSilence.checked ? "block" : "none";
    }

    // ── Apply Cuts ───────────────────────────────────────────────
    function applyCuts() {
        if (isApplyingCuts) {
            cancelApplyCutsFromPanel();
            return;
        }
        if (!keepZones || keepZones.length === 0) {
            setStatus("No keep zones — run analysis first", "error"); return;
        }
        return applyCutsInPlaceFromPanel();
    }

    function beginApplyCancelMode() {
        isApplyingCuts = true;
        applyCancelRequested = false;
        elBtnApply.disabled = false;
        elBtnApply.textContent = "Cancelar";
        elBtnApply.classList.add("btn-danger");
        elBtnApply.title = "Cancelar cortes imediatamente";
    }

    function endApplyCancelMode() {
        isApplyingCuts = false;
        applyCancelRequested = false;
        elBtnApply.disabled = false;
        elBtnApply.textContent = "Apply Cuts";
        elBtnApply.classList.remove("btn-danger");
        elBtnApply.title = "";
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

        const sorted = keepZones.slice().sort(function (a, b) { return a[0] - b[0]; });
        const rawCuts = [];
        let cursor = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (sorted[i][0] > cursor) rawCuts.push([cursor, sorted[i][0]]);
            cursor = sorted[i][1];
        }
        if (cursor < totalDuration) rawCuts.push([cursor, totalDuration]);

        var rangedCuts = rawCuts;
        if (analysisRangeInfo && analysisRangeInfo.mode === "inout") {
            rangedCuts = window.Duckycut.cutZones.intersectIntervalsWithRange(rawCuts, analysisRangeInfo);
        }

        // Snap each boundary to a frame so the host's TC conversion can't shift
        // it by ±½ frame (asymmetric round of zone start vs end). Drop zones
        // that collapse to zero width after snapping.
        const cutZones = (window.Duckycut && window.Duckycut.cutZones && window.Duckycut.cutZones.prepareCutZonesForApply)
            ? window.Duckycut.cutZones.prepareCutZonesForApply(rangedCuts, fps, isNTSC)
            : mergeOverlappingIntervals(rangedCuts.map(function (z) {
                return [snapSecondsToFrame(z[0], fps, isNTSC), snapSecondsToFrame(z[1], fps, isNTSC)];
            }).filter(function (z) { return z[1] > z[0]; }));

        if (cutZones.length === 0) {
            setStatus("Nothing to cut — keep zones cover the whole sequence", "info");
            hideProgress(); endApplyCancelMode(); return;
        }

        updateProgress(40, "Razoring " + cutZones.length + " zones...");

        const optsArg  = JSON.stringify(JSON.stringify({
            fps: fps,
            isNTSC: isNTSC,
            isDropFrame: isDropFrame,
            range: analysisRangeInfo && analysisRangeInfo.mode === "inout" ? {
                startSeconds: analysisRangeInfo.startSeconds,
                endSeconds: analysisRangeInfo.endSeconds
            } : null
        }));

        const zonesToApply = cutZones.slice().sort(function (a, b) { return b[0] - a[0]; });

        function finishCancelled(appliedCount) {
            updateProgress(100, "Cancelado");
            setStatus("Cortes cancelados" + (appliedCount ? " após " + appliedCount + " zonas" : ""), "error");
            hideProgress(); endApplyCancelMode();
        }

        function runNextCutZone(index, appliedCount, skippedCount) {
            if (applyCancelRequested) {
                finishCancelled(appliedCount);
                return;
            }

            if (index >= zonesToApply.length) {
                updateProgress(100, "Done!");
                setStatus("Applied " + appliedCount + " cuts" +
                    (skippedCount ? " (" + skippedCount + " skipped)" : ""), "success");
                hideProgress(); endApplyCancelMode();
                return;
            }

            updateProgress(
                Math.min(95, 40 + Math.round((index / zonesToApply.length) * 55)),
                "Razoring zone " + (index + 1) + " of " + zonesToApply.length + "..."
            );

            evalScript("applyCutsInPlace(" + jsxStringArg(JSON.stringify([zonesToApply[index]])) + ", " + optsArg + ")")
                .then(function (raw) {
                    var data = null;
                    try { data = JSON.parse(raw); }
                    catch (e) {
                        setStatus("Cut parse error: " + e.message + " :: raw=" + raw, "error");
                        hideProgress(); endApplyCancelMode();
                        return;
                    }

                    if (data.cancelled || applyCancelRequested) {
                        finishCancelled(appliedCount + (data.applied || 0));
                        return;
                    }
                    if (!data.success) {
                        setStatus("Cut error: " + (data.error || "unknown"), "error");
                        hideProgress(); endApplyCancelMode();
                        return;
                    }
                    if (data._diag) console.log("[Duckycut] applyCutsInPlace diag:", data._diag);
                    if (data._zoneDiag) console.log("[Duckycut] applyCutsInPlace zone diag:", data._zoneDiag);

                    setTimeout(function () {
                        runNextCutZone(index + 1, appliedCount + (data.applied || 0), skippedCount + (data.skipped || 0));
                    }, 0);
                })
                .catch(function (err) {
                    setStatus("Cut error: " + (err.message || "unknown"), "error");
                    hideProgress(); endApplyCancelMode();
                });
        }

        runNextCutZone(0, 0, 0);
    }

    // ── UI Helpers ────────────────────────────────────────────────
    function showProgress(text) {
        elProgressSection.style.display = "block";
        elProgressFill.style.width = "0%";
        elProgressText.textContent = text;
    }
    function updateProgress(pct, text) {
        elProgressFill.style.width = pct + "%";
        if (text) elProgressText.textContent = text;
    }
    function hideProgress() {
        setTimeout(() => { elProgressSection.style.display = "none"; }, 1500);
    }
    function setStatus(msg, type) {
        elStatusBar.textContent = msg;
        elStatusBar.className = "status-bar" + (type ? " " + type : "");
    }
    function formatTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.round(seconds % 60);
        return m + "m " + s + "s";
    }

    init();
})();
