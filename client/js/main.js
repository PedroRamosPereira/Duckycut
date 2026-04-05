/**
 * Duckycut - Panel Client Logic
 * Orchestrates the UI, CSInterface (ExtendScript), and Node.js modules.
 *
 * CEP panels with --enable-nodejs and --mixed-context have full Node.js
 * access directly in the browser context. No HTTP server needed.
 */

(function () {
    "use strict";

    // ── CSInterface ──
    const csInterface = new CSInterface();

    // ── Node.js Modules (direct require, no HTTP server) ──
    // In CEP with --enable-nodejs + --mixed-context, require() is available.
    // __dirname points to the HTML file's folder (client/).
    // We also try cep_node.require() which some CEP versions expose separately.
    let silenceDetector = null;
    let xmlGenerator = null;
    let nodeRequire = null;
    let modulesError = "";

    try {
        // CEP may expose Node's require differently depending on version/context:
        // 1. window.nodeRequire — saved by us in index.html before scripts load
        // 2. cep_node.require — CEP's separate Node context
        // 3. require — available in mixed-context mode
        if (typeof window.nodeRequire === "function") {
            nodeRequire = window.nodeRequire;
        } else if (typeof cep_node !== "undefined" && cep_node.require) {
            nodeRequire = cep_node.require;
        } else if (typeof window.cep_node !== "undefined" && window.cep_node.require) {
            nodeRequire = window.cep_node.require;
        } else if (typeof require === "function") {
            nodeRequire = require;
        }
    } catch (e) {
        modulesError = "No Node.js require available: " + e.message;
    }

    if (nodeRequire) {
        try {
            var nodePath = nodeRequire("path");

            // Resolve the extension root to find server/ folder
            var serverDir = null;

            // Strategy 1: __dirname (if available, points to HTML dir or script dir)
            if (typeof __dirname !== "undefined" && __dirname) {
                // __dirname could be client/ or client/js/ — go up until we find server/
                var candidate = nodePath.resolve(__dirname, "..", "server");
                var nodeFs = nodeRequire("fs");
                if (nodeFs.existsSync(candidate)) {
                    serverDir = candidate;
                } else {
                    candidate = nodePath.resolve(__dirname, "server");
                    if (nodeFs.existsSync(candidate)) {
                        serverDir = candidate;
                    }
                }
            }

            // Strategy 2: CSInterface.getSystemPath
            if (!serverDir) {
                var extPath = csInterface.getSystemPath(SystemPath.EXTENSION);
                if (extPath) {
                    // CEP on Windows returns /c/Users/... — convert to C:/Users/...
                    extPath = extPath.replace(/^\/([a-zA-Z])\//, "$1:/");
                    serverDir = nodePath.join(extPath, "server");
                }
            }

            // Strategy 3: document.location based
            if (!serverDir) {
                var docPath = decodeURIComponent(document.location.pathname);
                // Remove leading slash on Windows paths: /C:/Users/...
                if (docPath.match(/^\/[a-zA-Z]:\//)) {
                    docPath = docPath.substring(1);
                }
                var docDir = nodePath.dirname(docPath);
                serverDir = nodePath.resolve(docDir, "..", "server");
            }

            silenceDetector = nodeRequire(nodePath.join(serverDir, "silenceDetector.js"));
            xmlGenerator = nodeRequire(nodePath.join(serverDir, "xmlGenerator.js"));
            console.log("[Duckycut] Modules loaded from:", serverDir);
        } catch (e) {
            modulesError = e.message;
            console.error("[Duckycut] Module load error:", e.message, e.stack);
        }
    } else if (!modulesError) {
        modulesError = "Node.js not available in this CEP context";
    }

    // ── DOM Elements ──
    const elSequenceName = document.getElementById("sequenceName");
    const elBtnRefreshSeq = document.getElementById("btnRefreshSeq");
    const elThreshold = document.getElementById("threshold");
    const elThresholdVal = document.getElementById("thresholdVal");
    const elMinDuration = document.getElementById("minDuration");
    const elMinDurationVal = document.getElementById("minDurationVal");
    const elPadding = document.getElementById("padding");
    const elPaddingVal = document.getElementById("paddingVal");
    const elDeleteSilence = document.getElementById("deleteSilence");
    const elTargetTrack = document.getElementById("targetTrack");
    const elBtnAnalyze = document.getElementById("btnAnalyze");
    const elResultsSection = document.getElementById("resultsSection");
    const elResultsContent = document.getElementById("resultsContent");
    const elBtnApply = document.getElementById("btnApply");
    const elProgressSection = document.getElementById("progressSection");
    const elProgressFill = document.getElementById("progressFill");
    const elProgressText = document.getElementById("progressText");
    const elStatusBar = document.getElementById("statusBar");

    // ── State ──
    let sequenceInfo = null;
    let analysisResult = null;
    let keepZones = null;

    // ── Init ──
    function init() {
        bindSliders();
        bindButtons();
        refreshSequence();

        if (silenceDetector && xmlGenerator) {
            setStatus("Ready", "success");
        } else {
            setStatus("Module error: " + (modulesError || "unknown"), "error");
        }
    }

    // ── Slider Bindings ──
    function bindSliders() {
        elThreshold.addEventListener("input", function () {
            elThresholdVal.textContent = elThreshold.value + " dB";
        });
        elMinDuration.addEventListener("input", function () {
            elMinDurationVal.textContent = elMinDuration.value + " ms";
        });
        elPadding.addEventListener("input", function () {
            elPaddingVal.textContent = elPadding.value + " ms";
        });
    }

    // ── Button Bindings ──
    function bindButtons() {
        elBtnRefreshSeq.addEventListener("click", refreshSequence);
        elBtnAnalyze.addEventListener("click", runAnalysis);
        elBtnApply.addEventListener("click", applyCuts);
    }

    // ── Eval ExtendScript (Promise wrapper) ──
    function evalScript(script) {
        return new Promise(function (resolve) {
            csInterface.evalScript(script, function (result) {
                resolve(result);
            });
        });
    }

    // ── Refresh Sequence Info ──
    function refreshSequence() {
        evalScript("getActiveSequenceInfo()").then(function (result) {
            try {
                if (result === "EvalScript_ErrMessage" || !result) {
                    elSequenceName.textContent = "No sequence";
                    sequenceInfo = null;
                    return;
                }
                var info = JSON.parse(result);
                if (info.error) {
                    elSequenceName.textContent = "No sequence";
                    sequenceInfo = null;
                    return;
                }
                sequenceInfo = info;
                elSequenceName.textContent = info.name;
                populateTrackDropdown(info.audioTracks);
                setStatus("Sequence: " + info.name, "success");
            } catch (e) {
                console.error("[Duckycut] Parse error:", e, "Raw:", result);
                elSequenceName.textContent = "No sequence";
                sequenceInfo = null;
            }
        });
    }

    // ── Populate Track Dropdown ──
    function populateTrackDropdown(tracks) {
        elTargetTrack.innerHTML = '<option value="all">All Tracks</option>';
        if (tracks) {
            tracks.forEach(function (t) {
                var opt = document.createElement("option");
                opt.value = t.index;
                opt.textContent = t.name + (t.clipCount > 0 ? "" : " (empty)");
                elTargetTrack.appendChild(opt);
            });
        }
    }

    // ── Get Media Path from ExtendScript ──
    function getMediaPath() {
        var trackVal = elTargetTrack.value;
        var trackIdx = trackVal === "all" ? "0" : trackVal;
        return evalScript("getAudioTrackMediaPath(" + trackIdx + ")").then(function (result) {
            try {
                var data = JSON.parse(result);
                return data.path || null;
            } catch (e) {
                return null;
            }
        });
    }

    // ── Run Analysis ──
    function runAnalysis() {
        if (!sequenceInfo) {
            setStatus("No active sequence. Open a sequence first.", "error");
            return;
        }
        if (!silenceDetector) {
            setStatus("Silence detector module not loaded.", "error");
            return;
        }

        elBtnAnalyze.disabled = true;
        elResultsSection.style.display = "none";
        showProgress("Locating media files...");

        getMediaPath().then(function (mediaPath) {
            if (!mediaPath) {
                setStatus("No media found in the selected track.", "error");
                hideProgress();
                elBtnAnalyze.disabled = false;
                return;
            }

            updateProgress(20, "Running FFmpeg silence detection...");

            var threshold = parseInt(elThreshold.value, 10);
            var minDuration = parseInt(elMinDuration.value, 10) / 1000;

            silenceDetector
                .detectSilence(mediaPath, threshold, minDuration)
                .then(function (result) {
                    analysisResult = result;
                    updateProgress(80, "Calculating keep zones...");

                    var paddingSec = parseInt(elPadding.value, 10) / 1000;
                    keepZones = computeKeepZones(
                        result.silenceIntervals,
                        result.mediaDuration,
                        paddingSec
                    );

                    updateProgress(100, "Analysis complete!");
                    showResults(result, keepZones);
                    setStatus("Analysis complete", "success");
                    hideProgress();
                    elBtnAnalyze.disabled = false;
                })
                .catch(function (err) {
                    setStatus("FFmpeg error: " + err.message, "error");
                    hideProgress();
                    elBtnAnalyze.disabled = false;
                });
        });
    }

    // ── Compute Keep Zones ──
    function computeKeepZones(silenceIntervals, totalDuration, paddingSec) {
        if (!silenceIntervals || silenceIntervals.length === 0) {
            return [[0, totalDuration]];
        }

        var speechZones = [];
        var cursor = 0;

        for (var i = 0; i < silenceIntervals.length; i++) {
            var silStart = silenceIntervals[i][0];
            var silEnd = silenceIntervals[i][1];
            if (silStart > cursor) {
                speechZones.push([cursor, silStart]);
            }
            cursor = silEnd;
        }
        if (cursor < totalDuration) {
            speechZones.push([cursor, totalDuration]);
        }

        // Apply padding
        var padded = speechZones.map(function (zone) {
            return [
                Math.max(0, zone[0] - paddingSec),
                Math.min(totalDuration, zone[1] + paddingSec),
            ];
        });

        return mergeOverlappingIntervals(padded);
    }

    // ── Merge Overlapping Intervals ──
    function mergeOverlappingIntervals(arr) {
        if (!arr || arr.length === 0) return [];

        arr.sort(function (a, b) { return a[0] - b[0]; });
        var merged = [[arr[0][0], arr[0][1]]];

        for (var i = 1; i < arr.length; i++) {
            var last = merged[merged.length - 1];
            if (arr[i][0] <= last[1]) {
                last[1] = Math.max(last[1], arr[i][1]);
            } else {
                merged.push([arr[i][0], arr[i][1]]);
            }
        }

        return merged;
    }

    // ── Show Results ──
    function showResults(analysis, zones) {
        var totalKept = zones.reduce(function (sum, z) { return sum + (z[1] - z[0]); }, 0);
        var timeSaved = analysis.mediaDuration - totalKept;

        elResultsContent.innerHTML =
            '<div class="result-line"><span>Silence regions found:</span><span class="result-value">' + analysis.silenceCount + '</span></div>' +
            '<div class="result-line"><span>Time saved:</span><span class="result-value">' + formatTime(timeSaved) + '</span></div>' +
            '<div class="result-line"><span>Keep zones:</span><span class="result-value">' + zones.length + '</span></div>' +
            '<div class="result-line"><span>Final duration:</span><span class="result-value">' + formatTime(totalKept) + '</span></div>';

        elResultsSection.style.display = "flex";
        elBtnApply.style.display = elDeleteSilence.checked ? "block" : "none";
    }

    // ── Apply Cuts (Turbo Mode — FCP7 XML) ──
    function applyCuts() {
        if (!keepZones || keepZones.length === 0) {
            setStatus("No keep zones. Run analysis first.", "error");
            return;
        }
        if (!xmlGenerator) {
            setStatus("XML generator module not loaded.", "error");
            return;
        }

        elBtnApply.disabled = true;
        showProgress("Generating FCP7 XML...");

        // Get sequence settings + media path + project dir in parallel
        Promise.all([
            evalScript("getSequenceSettings()"),
            getMediaPath(),
            evalScript("getProjectPath()"),
        ]).then(function (results) {
            var seqSettings, mediaPath, projectDir;
            try { seqSettings = JSON.parse(results[0]); } catch (e) { seqSettings = {}; }
            mediaPath = results[1];
            try {
                var projData = JSON.parse(results[2]);
                projectDir = projData.projectDir || null;
            } catch (e) {
                projectDir = null;
            }

            if (!projectDir) {
                setStatus("Save the project first.", "error");
                hideProgress();
                elBtnApply.disabled = false;
                return;
            }

            var path = nodeRequire("path");
            var xmlFileName = sequenceInfo.name + "_duckycut_" + Date.now() + ".xml";
            var outputPath = path.join(projectDir, xmlFileName);

            updateProgress(40, "Writing XML file...");

            try {
                xmlGenerator.generateFCP7XML({
                    keepZones: keepZones,
                    mediaPath: mediaPath,
                    sequenceName: sequenceInfo.name,
                    framerate: seqSettings.framerate || 29.97,
                    width: seqSettings.width || 1920,
                    height: seqSettings.height || 1080,
                    audioSampleRate: seqSettings.audioSampleRate || 48000,
                    durationSeconds: seqSettings.durationSeconds || analysisResult.mediaDuration,
                    outputPath: outputPath,
                    audioTrackCount: sequenceInfo.audioTracks ? sequenceInfo.audioTracks.length : 1,
                });

                updateProgress(70, "Importing XML into Premiere...");

                // Normalize path for ExtendScript (forward slashes)
                var escapedPath = outputPath.replace(/\\/g, "/");
                evalScript('importXMLToProject("' + escapedPath + '")').then(function (result) {
                    try {
                        var data = JSON.parse(result);
                        if (data.success) {
                            updateProgress(100, "Done!");
                            setStatus("New sequence created: " + sequenceInfo.name + " [Duckycut]", "success");
                        } else {
                            setStatus("Import error: " + (data.message || "unknown"), "error");
                        }
                    } catch (e) {
                        setStatus("Import parse error: " + e.message, "error");
                    }
                    hideProgress();
                    elBtnApply.disabled = false;
                });
            } catch (err) {
                setStatus("XML generation error: " + err.message, "error");
                hideProgress();
                elBtnApply.disabled = false;
            }
        });
    }

    // ── UI Helpers ──
    function showProgress(text) {
        elProgressSection.style.display = "block";
        elProgressFill.style.width = "0%";
        elProgressText.textContent = text;
    }

    function updateProgress(percent, text) {
        elProgressFill.style.width = percent + "%";
        if (text) elProgressText.textContent = text;
    }

    function hideProgress() {
        setTimeout(function () {
            elProgressSection.style.display = "none";
        }, 1500);
    }

    function setStatus(message, type) {
        elStatusBar.textContent = message;
        elStatusBar.className = "status-bar" + (type ? " " + type : "");
    }

    function formatTime(seconds) {
        var m = Math.floor(seconds / 60);
        var s = Math.round(seconds % 60);
        return m + "m " + s + "s";
    }

    // ── Start ──
    init();
})();
