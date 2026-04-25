/**
 * Duckycut - Panel Client Logic
 *
 * FIXES:
 *   1. Overlays (V2, V3+): reads ALL tracks via getFullSequenceClips() and passes
 *      them to xmlGenerator, which maps every clip through the keepZones.
 *   2. Audio duplication: each audio clip now references its own sourcetrack
 *      channel; generator no longer duplicates A1 across all tracks.
 *   3. Framerate: getSequenceSettings() reads timebase directly from the
 *      sequence — no hardcoded 29.97 fallback unless the API truly fails.
 *   4. Audio pre-render: when Analyze is clicked, the panel asks Premiere to
 *      export a WAV mixdown of the user-selected audio tracks. FFmpeg then
 *      analyses that rendered file instead of the raw source — giving accurate
 *      silence detection even when audio lives on multiple tracks or is mixed
 *      from clips at different source offsets.
 */

(function () {
    "use strict";

    const csInterface = new CSInterface();

    let silenceDetector = null;
    let xmlGenerator    = null;
    let nodeRequire     = null;
    let modulesError    = "";

    // ── Load Node.js modules ─────────────────────────────────────
    try {
        if      (typeof window.nodeRequire === "function")                          nodeRequire = window.nodeRequire;
        else if (typeof cep_node !== "undefined" && cep_node.require)               nodeRequire = cep_node.require;
        else if (typeof window.cep_node !== "undefined" && window.cep_node.require) nodeRequire = window.cep_node.require;
        else if (typeof require === "function")                                      nodeRequire = require;
    } catch (e) { modulesError = "No Node.js require: " + e.message; }

    if (nodeRequire) {
        try {
            var nodePath = nodeRequire("path");
            var serverDir = null;

            if (typeof __dirname !== "undefined" && __dirname) {
                var nodeFs = nodeRequire("fs");
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
            xmlGenerator    = nodeRequire(nodePath.join(serverDir, "xmlGenerator.js"));
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

    // Feature flag — when true, applyCuts skips XML generation and razors+removes
    // directly in the timeline via host applyCutsInPlace (mirrors fireCut Alt+C).
    const USE_INPLACE_CUTS = true;

    // ── State ─────────────────────────────────────────────────────
    let sequenceInfo    = null;   // from getActiveSequenceInfo()
    let sequenceClips   = null;   // from getFullSequenceClips() — all tracks
    let analysisResult  = null;
    let keepZones       = null;
    let probeResult     = null;   // { meanVolume, maxVolume, channelCount }
    let seqSettings     = null;   // from getSequenceSettings()
    let paddingLinked   = false;  // whether Padding In/Out are synced

    function getSelectedTrackIndices() {
        return Array.from(document.querySelectorAll(".track-cb:checked"))
                    .map(function(cb) { return parseInt(cb.value, 10); });
    }

    // ── Init ─────────────────────────────────────────────────────
    function init() {
        bindSliders();
        bindButtons();
        refreshSequence();
        updateAggroHint();

        if (silenceDetector && xmlGenerator) {
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
    function runAnalysis() {
        if (!sequenceInfo) { setStatus("No active sequence", "error"); return; }
        if (!silenceDetector) { setStatus("Silence detector not loaded", "error"); return; }

        elBtnAnalyze.disabled = true;
        elResultsSection.style.display = "none";
        showProgress("Reading sequence tracks...");

        // Step 1: read all clips from every track
        Promise.all([
            evalScript("getFullSequenceClips()"),
            evalScript("getSequenceSettings()"),
            evalScript("getProjectPath()"),
        ]).then(([clipsRaw, settingsRaw, projRaw]) => {
            // Parse sequence clips (V1/V2/overlays + audio tracks)
            try {
                var parsed = JSON.parse(clipsRaw);
                sequenceClips = Array.isArray(parsed) ? parsed : null;
            } catch (e) { sequenceClips = null; }

            try {
                seqSettings = JSON.parse(settingsRaw);
                if (seqSettings.error) seqSettings = null;
            } catch (e) { seqSettings = null; }

            var projectDir = null;
            try {
                var pd = JSON.parse(projRaw);
                projectDir = pd.projectDir || null;
            } catch (e) {}

            updateProgress(10, "Preparing audio for analysis...");

            // Step 2: resolve audio source
            var threshold   = computeThreshold(elAggressiveness.value);
            var minDuration = parseInt(elMinDuration.value, 10) / 1000;

            if (elTargetTrack.value === "all") {
                // ── Native Premiere mixdown (preserves effects/EQ/volume) ──
                var fs2 = nodeRequire("fs");
                var os2 = nodeRequire("os");
                var tempWav = (os2.tmpdir() + "/duckycut_temp_mixdown_" + Date.now() + ".wav")
                                .replace(/\\/g, "/");

                updateProgress(15, "Queuing sequence render in Adobe Media Encoder...");

                var extensionRoot = csInterface.getSystemPath(SystemPath.EXTENSION)
                                        .replace(/\\/g, "/");

                evalScript('exportSequenceAudio("' + tempWav.replace(/"/g, '\\"') + '","' + extensionRoot.replace(/"/g, '\\"') + '")')
                    .then(function (r) {
                        var res;
                        try { res = JSON.parse(r); } catch (e) { res = {}; }

                        if (!res.success) {
                            setStatus("Mixdown failed: " + (res.error || "unknown"), "error");
                            hideProgress(); elBtnAnalyze.disabled = false;
                            return;
                        }

                        // ── Wait for AME to finish writing the WAV ──
                        // Two-phase poll: first wait for file to appear, then
                        // wait for its size to be stable for N consecutive
                        // samples (AME keeps the handle open while encoding).
                        // Reading too early → FFmpeg EACCES (exit -13).
                        var pollInterval   = 500;    // ms
                        var pollTimeout    = 180000; // 3 min max total
                        var stableSampleMs = 300;
                        var stableNeeded   = 4;      // ~1.2s of unchanged size
                        var elapsed        = 0;

                        function waitForFile() {
                            if (fs2.existsSync(tempWav)) {
                                waitForStableSize();
                                return;
                            }
                            elapsed += pollInterval;
                            if (elapsed >= pollTimeout) {
                                setStatus("Timeout: AME didn't produce the WAV in 3 min", "error");
                                hideProgress(); elBtnAnalyze.disabled = false;
                                return;
                            }
                            updateProgress(
                                15 + Math.min(8, Math.round(elapsed / pollTimeout * 8)),
                                "Waiting for Adobe Media Encoder to start..."
                            );
                            setTimeout(waitForFile, pollInterval);
                        }

                        function waitForStableSize() {
                            var lastSize    = -1;
                            var stableCount = 0;

                            function sample() {
                                var size = -1;
                                try { size = fs2.statSync(tempWav).size; } catch (e) {}

                                if (size > 0 && size === lastSize) {
                                    stableCount++;
                                    if (stableCount >= stableNeeded) {
                                        runDetection(tempWav, true);
                                        return;
                                    }
                                } else {
                                    stableCount = 0;
                                }
                                lastSize = size;

                                elapsed += stableSampleMs;
                                if (elapsed >= pollTimeout) {
                                    setStatus("Timeout waiting for AME render to finish", "error");
                                    hideProgress(); elBtnAnalyze.disabled = false;
                                    return;
                                }

                                var sizeMB = size > 0 ? (Math.round(size / 1024 / 1024 * 10) / 10) : 0;
                                updateProgress(
                                    23 + Math.min(2, stableCount),
                                    "Rendering in Adobe Media Encoder... " +
                                        (sizeMB > 0 ? sizeMB + " MB" : "")
                                );
                                setTimeout(sample, stableSampleMs);
                            }
                            sample();
                        }

                        waitForFile();
                    });
            } else {
                // ── Single track: use raw source file directly ──
                getMediaPath().then(function (audioPath) {
                    if (!audioPath) {
                        setStatus("No audio media found in track", "error");
                        hideProgress(); elBtnAnalyze.disabled = false; return;
                    }
                    runDetection(audioPath, false);
                });
            }

            function runDetection(audioPath, wasRendered) {
                var renderNote = wasRendered ? " (rendered mixdown)" : " (source file)";
                updateProgress(25, "Running FFmpeg silence detection" + renderNote + "...");

                silenceDetector.detectSilence(audioPath, threshold, minDuration)
                    .then(function (result) {
                        analysisResult = result;
                        updateProgress(80, "Applying Clean Cut algorithm...");

                        keepZones = computeCleanCutZones(
                            result.silenceIntervals,
                            result.mediaDuration,
                            {
                                paddingIn:       parseInt(elPaddingIn.value, 10)       / 1000,
                                paddingOut:      parseInt(elPaddingOut.value, 10)      / 1000,
                                minClipDuration: parseInt(elMinClipDuration.value, 10) / 1000,
                                minGapDuration:  parseInt(elMinGapFill.value, 10)      / 1000,
                            }
                        );

                        // Clean up temp WAV
                        if (wasRendered) {
                            try { nodeRequire("fs").unlinkSync(audioPath); } catch (e) {}
                        }

                        updateProgress(100, "Analysis complete!");
                        showResults(result, keepZones, wasRendered);
                        setStatus("Analysis complete — threshold: " + threshold + " dB" + renderNote, "success");
                        hideProgress(); elBtnAnalyze.disabled = false;
                    })
                    .catch(function (err) {
                        // Clean up temp WAV on error too
                        if (wasRendered) {
                            try { nodeRequire("fs").unlinkSync(audioPath); } catch (e) {}
                        }
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
        if (!keepZones || keepZones.length === 0) {
            setStatus("No keep zones — run analysis first", "error"); return;
        }
        if (USE_INPLACE_CUTS) return applyCutsInPlaceFromPanel();
        return applyCutsViaXML();
    }

    function applyCutsInPlaceFromPanel() {
        elBtnApply.disabled = true;
        showProgress("Computing cut zones...");

        const totalDuration = (analysisResult && analysisResult.mediaDuration)
            || (seqSettings && seqSettings.durationSeconds) || 0;
        if (!totalDuration) {
            setStatus("Unknown sequence duration", "error");
            hideProgress(); elBtnApply.disabled = false; return;
        }

        const sorted = keepZones.slice().sort(function (a, b) { return a[0] - b[0]; });
        const cutZones = [];
        let cursor = 0;
        for (let i = 0; i < sorted.length; i++) {
            if (sorted[i][0] > cursor) cutZones.push([cursor, sorted[i][0]]);
            cursor = sorted[i][1];
        }
        if (cursor < totalDuration) cutZones.push([cursor, totalDuration]);

        if (cutZones.length === 0) {
            setStatus("Nothing to cut — keep zones cover the whole sequence", "info");
            hideProgress(); elBtnApply.disabled = false; return;
        }

        const fps    = (seqSettings && seqSettings.framerate)
                    || (sequenceInfo && sequenceInfo.framerate) || 29.97;
        const isNTSC = (seqSettings && typeof seqSettings.isNTSC !== "undefined")
                    ? seqSettings.isNTSC
                    : (sequenceInfo && sequenceInfo.isNTSC) || false;

        updateProgress(40, "Razoring " + cutZones.length + " zones...");

        const zonesArg = JSON.stringify(JSON.stringify(cutZones));
        const optsArg  = JSON.stringify(JSON.stringify({ fps: fps, isNTSC: isNTSC }));

        evalScript("applyCutsInPlace(" + zonesArg + ", " + optsArg + ")").then(function (raw) {
            try {
                const data = JSON.parse(raw);
                if (data.success) {
                    updateProgress(100, "Done!");
                    setStatus("Applied " + data.applied + " cuts" +
                        (data.skipped ? " (" + data.skipped + " skipped)" : ""), "success");
                    if (data._diag) console.log("[Duckycut] applyCutsInPlace diag:", data._diag);
                } else {
                    setStatus("Cut error: " + (data.error || "unknown"), "error");
                }
            } catch (e) {
                setStatus("Cut parse error: " + e.message + " :: raw=" + raw, "error");
            }
            hideProgress(); elBtnApply.disabled = false;
        });
    }

    function applyCutsViaXML() {
        if (!xmlGenerator) { setStatus("XML generator not loaded", "error"); return; }

        elBtnApply.disabled = true;
        showProgress("Reading full sequence timeline...");

        Promise.all([
            evalScript("getFullSequenceClips()"),
            evalScript("getSequenceSettings()"),
            evalScript("getProjectPath()"),
        ]).then(([clipsRaw, settingsRaw, projRaw]) => {
            // Always re-read clips in case something changed
            try {
                var parsed = JSON.parse(clipsRaw);
                if (Array.isArray(parsed)) sequenceClips = parsed;
            } catch (e) {}

            var settings = seqSettings;
            try {
                var fresh = JSON.parse(settingsRaw);
                if (!fresh.error) settings = fresh;
            } catch (e) {}

            var projectDir = null;
            try { var pd = JSON.parse(projRaw); projectDir = pd.projectDir || null; } catch (e) {}

            if (!projectDir) {
                setStatus("Save the project first", "error");
                hideProgress(); elBtnApply.disabled = false; return;
            }

            updateProgress(30, "Generating FCP7 XML...");

            var nPath       = nodeRequire("path");
            var xmlFileName = (sequenceInfo ? sequenceInfo.name : "Duckycut") + "_duckycut_" + Date.now() + ".xml";
            var outputPath  = nPath.join(projectDir, xmlFileName);

            // Use actual sequence framerate — not hardcoded fallback
            var fps = (settings && settings.framerate) ? settings.framerate
                    : (sequenceInfo && sequenceInfo.framerate) ? sequenceInfo.framerate
                    : 29.97;

            // Exact framerate fields for precise frame math (from Adobe ticks)
            var exactFps    = (settings && settings.exactFps) || fps;
            var isNTSC      = (settings && typeof settings.isNTSC !== "undefined") ? settings.isNTSC : false;
            var xmlTimebase = (settings && settings.xmlTimebase) || Math.round(fps);

            var numAudioTracks = (settings && settings.audioTrackCount)
                ? settings.audioTrackCount
                : (sequenceInfo && sequenceInfo.audioTracks ? sequenceInfo.audioTracks.length : 1);

            var numVideoTracks = (settings && settings.videoTrackCount)
                ? settings.videoTrackCount
                : (sequenceInfo && sequenceInfo.videoTracks ? sequenceInfo.videoTracks.length : 1);

            try {
                xmlGenerator.generateFCP7XML({
                    keepZones:         keepZones,
                    sequenceClips:     sequenceClips,
                    sequenceName:      sequenceInfo ? sequenceInfo.name : "Duckycut",
                    framerate:         fps,
                    exactFps:          exactFps,
                    isNTSC:            isNTSC,
                    xmlTimebase:       xmlTimebase,
                    width:             (settings && settings.width)           || 1920,
                    height:            (settings && settings.height)          || 1080,
                    audioSampleRate:   (settings && settings.audioSampleRate) || 48000,
                    durationSeconds:   (settings && settings.durationSeconds) || (analysisResult && analysisResult.mediaDuration) || 0,
                    outputPath:        outputPath,
                    audioTrackCount:   numAudioTracks,
                    videoTrackCount:   numVideoTracks,
                    audioChannelCount: probeResult ? probeResult.channelCount : numAudioTracks,
                });

                updateProgress(70, "Importing XML into Premiere...");

                var escapedPath = outputPath.replace(/\\/g, "/");
                evalScript('importXMLToProject("' + escapedPath + '")').then((result) => {
                    try {
                        var data = JSON.parse(result);
                        if (data.success) {
                            updateProgress(100, "Done!");
                            setStatus("New sequence created: " + (sequenceInfo ? sequenceInfo.name : "") + " [Duckycut]", "success");
                        } else {
                            setStatus("Import error: " + (data.message || "unknown"), "error");
                        }
                    } catch (e) { setStatus("Import parse error: " + e.message, "error"); }
                    hideProgress(); elBtnApply.disabled = false;
                });
            } catch (err) {
                setStatus("XML generation error: " + err.message, "error");
                hideProgress(); elBtnApply.disabled = false;
            }
        });
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
