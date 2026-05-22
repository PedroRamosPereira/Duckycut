const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const DEFAULT_SAMPLE_RATE = 16000;
const DEFAULT_WINDOW_SIZE = 512;
const DEFAULT_MODEL_PATH = path.join(__dirname, "models", "silero_vad.onnx");

function readPcm16MonoWav(wavPath) {
    if (!wavPath || !fs.existsSync(wavPath)) {
        throw new Error("VAD WAV could not be read: file not found");
    }

    const buffer = fs.readFileSync(wavPath);
    if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("VAD WAV could not be read: invalid WAV header");
    }

    let offset = 12;
    let fmt = null;
    let dataOffset = -1;
    let dataSize = 0;

    while (offset + 8 <= buffer.length) {
        const id = buffer.toString("ascii", offset, offset + 4);
        const size = buffer.readUInt32LE(offset + 4);
        const chunkStart = offset + 8;

        if (id === "fmt ") {
            fmt = {
                audioFormat: buffer.readUInt16LE(chunkStart),
                channels: buffer.readUInt16LE(chunkStart + 2),
                sampleRate: buffer.readUInt32LE(chunkStart + 4),
                bitsPerSample: buffer.readUInt16LE(chunkStart + 14),
            };
        } else if (id === "data") {
            dataOffset = chunkStart;
            dataSize = size;
            break;
        }

        offset = chunkStart + size + (size % 2);
    }

    if (!fmt || dataOffset < 0) {
        throw new Error("VAD WAV could not be read: missing fmt or data chunk");
    }
    if (fmt.audioFormat !== 1 || fmt.sampleRate !== DEFAULT_SAMPLE_RATE || fmt.channels !== 1 || fmt.bitsPerSample !== 16) {
        throw new Error("Silero VAD expects 16 kHz mono/16-bit WAV from the reduced prerender preset");
    }

    const sampleCount = Math.floor(dataSize / 2);
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        samples[i] = buffer.readInt16LE(dataOffset + i * 2) / 32768;
    }

    return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bitsPerSample,
        samples,
        durationSeconds: sampleCount / fmt.sampleRate,
    };
}

function loadOnnxRuntime(runtimeFactory) {
    try {
        if (runtimeFactory) return runtimeFactory();
        return require("onnxruntime-node");
    } catch (err) {
        throw new Error("onnxruntime-node is not available. Run npm install and make sure the CEP Node runtime can load native modules. Original error: " + (err.message || err));
    }
}

function shouldUseExternalNodeFallback(err) {
    const message = err && err.message ? err.message : String(err || "");
    return /SharedArrayBuffer is not a constructor/i.test(message);
}

function buildWorkerOptions(opts) {
    return {
        modelPath: opts.modelPath,
        threshold: opts.threshold,
        minSpeechDurationMs: opts.minSpeechDurationMs,
        minSilenceDurationMs: opts.minSilenceDurationMs,
        windowSizeSamples: opts.windowSizeSamples,
        allowExternalNodeFallback: false,
    };
}

function runExternalNodeVad(wavPath, opts, originalError) {
    const runner = opts.externalNodeRunner;
    if (runner) return runner(wavPath, buildWorkerOptions(opts), originalError);

    return new Promise((resolve, reject) => {
        const workerPath = path.join(__dirname, "vadWorker.js");
        const nodeCommand = opts.nodeCommand || "node";
        const worker = childProcess.spawn(nodeCommand, [workerPath], {
            cwd: path.resolve(__dirname, ".."),
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeoutMs = opts.externalNodeTimeoutMs || 10 * 60 * 1000;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { worker.kill(); } catch (_) {}
            reject(new Error("External Node VAD timed out after " + timeoutMs + "ms"));
        }, timeoutMs);

        worker.stdout.on("data", chunk => { stdout += chunk.toString(); });
        worker.stderr.on("data", chunk => { stderr += chunk.toString(); });
        worker.on("error", err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error("External Node VAD could not start: " + (err.message || err)));
        });
        worker.on("close", code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                reject(new Error("External Node VAD failed: " + (stderr || stdout || ("exit code " + code)).trim()));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (err) {
                reject(new Error("External Node VAD returned invalid JSON: " + (err.message || err)));
            }
        });

        worker.stdin.end(JSON.stringify({
            wavPath,
            options: buildWorkerOptions(opts),
            originalError: originalError && originalError.message ? originalError.message : String(originalError || ""),
        }));
    });
}

function getTensorData(outputMap, names) {
    for (const name of names) {
        if (outputMap && outputMap[name] && outputMap[name].data) return outputMap[name].data;
    }
    const keys = outputMap ? Object.keys(outputMap) : [];
    if (keys.length > 0 && outputMap[keys[0]] && outputMap[keys[0]].data) return outputMap[keys[0]].data;
    return null;
}

function getStateTensor(outputMap) {
    if (!outputMap) return null;
    return outputMap.stateN || outputMap.state || outputMap.state_out || outputMap.output_state || null;
}

function probabilitiesToSpeechIntervals(probabilities, opts) {
    opts = opts || {};
    const threshold = opts.threshold == null ? 0.5 : Number(opts.threshold);
    const sampleRate = opts.sampleRate || DEFAULT_SAMPLE_RATE;
    const windowSizeSamples = opts.windowSizeSamples || DEFAULT_WINDOW_SIZE;
    const minSpeechDuration = (opts.minSpeechDurationMs == null ? 250 : Number(opts.minSpeechDurationMs)) / 1000;
    const minSilenceDuration = (opts.minSilenceDurationMs == null ? 100 : Number(opts.minSilenceDurationMs)) / 1000;
    const chunkSeconds = windowSizeSamples / sampleRate;

    const intervals = [];
    let speechStart = null;
    let lastSpeechEnd = 0;

    for (let i = 0; i < probabilities.length; i++) {
        const start = i * chunkSeconds;
        const end = start + chunkSeconds;
        if (probabilities[i] >= threshold) {
            if (speechStart == null) speechStart = start;
            lastSpeechEnd = end;
            continue;
        }

        if (speechStart != null && (start - lastSpeechEnd) >= minSilenceDuration) {
            if ((lastSpeechEnd - speechStart) >= minSpeechDuration) intervals.push([roundSeconds(speechStart), roundSeconds(lastSpeechEnd)]);
            speechStart = null;
        }
    }

    if (speechStart != null && (lastSpeechEnd - speechStart) >= minSpeechDuration) {
        intervals.push([roundSeconds(speechStart), roundSeconds(lastSpeechEnd)]);
    }

    return intervals;
}

function roundSeconds(value) {
    return Math.round(value * 1000000) / 1000000;
}

async function runSileroOnnx(wav, ort, modelPath, opts) {
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ["cpu"] });
    const windowSizeSamples = opts.windowSizeSamples || DEFAULT_WINDOW_SIZE;
    const probabilities = [];
    let state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
    const sr = new ort.Tensor("int64", BigInt64Array.from([BigInt(wav.sampleRate)]), []);

    for (let pos = 0; pos < wav.samples.length; pos += windowSizeSamples) {
        const chunk = new Float32Array(windowSizeSamples);
        chunk.set(wav.samples.subarray(pos, Math.min(pos + windowSizeSamples, wav.samples.length)));
        const feeds = {
            input: new ort.Tensor("float32", chunk, [1, windowSizeSamples]),
            state,
            sr,
        };

        const outputs = await session.run(feeds);
        const probs = getTensorData(outputs, ["output", "prob", "probability"]);
        probabilities.push(probs && probs.length ? Number(probs[0]) : 0);
        state = getStateTensor(outputs) || state;
    }

    return probabilities;
}

async function detectVoiceActivity(wavPath, options) {
    const opts = options || {};
    const modelPath = opts.modelPath || DEFAULT_MODEL_PATH;

    if (!fs.existsSync(modelPath)) {
        throw new Error("Silero VAD ONNX model not found: " + modelPath);
    }

    let ort = null;
    try {
        ort = loadOnnxRuntime(opts.runtimeFactory);
    } catch (err) {
        if (opts.allowExternalNodeFallback !== false && shouldUseExternalNodeFallback(err)) {
            return runExternalNodeVad(wavPath, opts, err);
        }
        throw err;
    }
    const wav = readPcm16MonoWav(wavPath);
    const windowSizeSamples = opts.windowSizeSamples || DEFAULT_WINDOW_SIZE;
    const threshold = opts.threshold == null ? 0.5 : Number(opts.threshold);
    const minSpeechDurationMs = opts.minSpeechDurationMs == null ? 250 : Number(opts.minSpeechDurationMs);
    const minSilenceDurationMs = opts.minSilenceDurationMs == null ? 100 : Number(opts.minSilenceDurationMs);

    const probabilities = opts.probabilities || await runSileroOnnx(wav, ort, modelPath, {
        windowSizeSamples,
    });

    const speechIntervals = probabilitiesToSpeechIntervals(probabilities, {
        threshold,
        minSpeechDurationMs,
        minSilenceDurationMs,
        windowSizeSamples,
        sampleRate: wav.sampleRate,
    });

    return {
        type: "vad",
        mediaDuration: Math.round(wav.durationSeconds * 1000000) / 1000000,
        speechIntervals,
        raw: {
            model: "silero-vad-onnx",
            modelPath,
            threshold,
            minSpeechDurationMs,
            minSilenceDurationMs,
            windowSizeSamples,
        },
    };
}

module.exports = {
    detectVoiceActivity,
    probabilitiesToSpeechIntervals,
    readPcm16MonoWav,
    _internals: {
        DEFAULT_MODEL_PATH,
        runSileroOnnx,
        loadOnnxRuntime,
        shouldUseExternalNodeFallback,
        runExternalNodeVad,
    },
};
