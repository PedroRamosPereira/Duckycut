const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
    detectVoiceActivity,
    probabilitiesToSpeechIntervals,
    readPcm16MonoWav,
} = require("../server/vadDetector");

function writeTestWav(filePath, opts) {
    const sampleRate = opts.sampleRate || 16000;
    const channels = opts.channels || 1;
    const samplesPerChannel = opts.samplesPerChannel || sampleRate;
    const bytesPerSample = 2;
    const dataSize = samplesPerChannel * channels * bytesPerSample;
    const buffer = Buffer.alloc(44 + dataSize);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
    buffer.writeUInt16LE(channels * bytesPerSample, 32);
    buffer.writeUInt16LE(16, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    fs.writeFileSync(filePath, buffer);
}

test("readPcm16MonoWav validates 16 kHz mono PCM WAV files", () => {
    const wavPath = path.join(os.tmpdir(), `duckycut_vad_${Date.now()}.wav`);
    writeTestWav(wavPath, { sampleRate: 16000, channels: 1, samplesPerChannel: 16000 });

    try {
        const wav = readPcm16MonoWav(wavPath);
        assert.equal(wav.sampleRate, 16000);
        assert.equal(wav.channels, 1);
        assert.equal(wav.durationSeconds, 1);
        assert.equal(wav.samples.length, 16000);
    } finally {
        fs.unlinkSync(wavPath);
    }
});

test("readPcm16MonoWav reports incompatible sample rate clearly", () => {
    const wavPath = path.join(os.tmpdir(), `duckycut_vad_${Date.now()}.wav`);
    writeTestWav(wavPath, { sampleRate: 48000, channels: 1, samplesPerChannel: 48000 });

    try {
        assert.throws(
            () => readPcm16MonoWav(wavPath),
            /Silero VAD expects 16 kHz mono\/16-bit WAV/
        );
    } finally {
        fs.unlinkSync(wavPath);
    }
});

test("probabilitiesToSpeechIntervals converts chunk probabilities into speech intervals", () => {
    const intervals = probabilitiesToSpeechIntervals(
        [0.1, 0.8, 0.9, 0.2, 0.1, 0.7],
        {
            threshold: 0.5,
            windowSizeSamples: 512,
            sampleRate: 16000,
            minSpeechDurationMs: 1,
            minSilenceDurationMs: 1,
            speechPadMs: 0,
        }
    );

    assert.deepEqual(intervals, [
        [0.032, 0.096],
        [0.16, 0.192],
    ]);
});

test("probabilitiesToSpeechIntervals keeps speech open until probabilities cross negThreshold", () => {
    const intervals = probabilitiesToSpeechIntervals(
        [0.8, 0.42, 0.39, 0.34],
        {
            threshold: 0.5,
            windowSizeSamples: 1600,
            sampleRate: 16000,
            minSpeechDurationMs: 1,
            minSilenceDurationMs: 1,
            speechPadMs: 0,
        }
    );

    assert.deepEqual(intervals, [[0, 0.3]]);
});

test("probabilitiesToSpeechIntervals applies Silero-style speech padding before returning intervals", () => {
    const intervals = probabilitiesToSpeechIntervals(
        [0.8, 0.8, 0.1],
        {
            threshold: 0.5,
            windowSizeSamples: 1600,
            sampleRate: 16000,
            minSpeechDurationMs: 1,
            minSilenceDurationMs: 1,
            speechPadMs: 30,
            mediaDuration: 1,
        }
    );

    assert.deepEqual(intervals, [[0, 0.23]]);
});

test("probabilitiesToSpeechIntervals uses VAD editing defaults that preserve speech edges", () => {
    const intervals = probabilitiesToSpeechIntervals(
        [0.46, 0.46, 0.1],
        {
            windowSizeSamples: 1600,
            sampleRate: 16000,
            mediaDuration: 1,
        }
    );

    assert.deepEqual(intervals, [[0, 0.35]]);
});

test("runSileroOnnx feeds the model with official Silero context samples", async () => {
    const { _internals } = require("../server/vadDetector");
    const inputLengths = [];
    const stateDims = [];
    const fakeOrt = {
        Tensor: class Tensor {
            constructor(type, data, dims) {
                this.type = type;
                this.data = data;
                this.dims = dims;
            }
        },
        InferenceSession: {
            create: async () => ({
                run: async feeds => {
                    inputLengths.push(feeds.input.dims[1]);
                    stateDims.push(feeds.state.dims.join("x"));
                    return {
                        output: new fakeOrt.Tensor("float32", new Float32Array([0.1]), [1, 1]),
                        stateN: feeds.state,
                    };
                },
            }),
        },
    };

    await _internals.runSileroOnnx(
        {
            sampleRate: 16000,
            samples: new Float32Array(1024),
        },
        fakeOrt,
        "unused.onnx",
        { windowSizeSamples: 512 }
    );

    assert.deepEqual(inputLengths, [576, 576]);
    assert.deepEqual(stateDims, ["2x1x128", "2x1x128"]);
});

test("detectVoiceActivity returns a friendly error when ONNX runtime is unavailable", async () => {
    const wavPath = path.join(os.tmpdir(), `duckycut_vad_${Date.now()}.wav`);
    writeTestWav(wavPath, { sampleRate: 16000, channels: 1, samplesPerChannel: 16000 });

    try {
        await assert.rejects(
            () => detectVoiceActivity(wavPath, {
                modelPath: __filename,
                runtimeFactory: () => { throw new Error("Cannot find module 'onnxruntime-node'"); },
            }),
            /onnxruntime-node is not available/
        );
    } finally {
        fs.unlinkSync(wavPath);
    }
});

test("detectVoiceActivity falls back to external Node when CEP cannot load ONNX runtime", async () => {
    const wavPath = path.join(os.tmpdir(), `duckycut_vad_${Date.now()}.wav`);
    writeTestWav(wavPath, { sampleRate: 16000, channels: 1, samplesPerChannel: 16000 });

    try {
        const result = await detectVoiceActivity(wavPath, {
            modelPath: __filename,
            runtimeFactory: () => { throw new Error("SharedArrayBuffer is not a constructor"); },
            externalNodeRunner: (receivedWavPath, receivedOptions, originalError) => {
                assert.equal(receivedWavPath, wavPath);
                assert.equal(receivedOptions.modelPath, __filename);
                assert.match(originalError.message, /SharedArrayBuffer is not a constructor/);
                return Promise.resolve({
                    type: "vad",
                    mediaDuration: 1,
                    speechIntervals: [[0.1, 0.5]],
                    raw: { fallback: "external-node" },
                });
            },
        });

        assert.deepEqual(result.speechIntervals, [[0.1, 0.5]]);
        assert.equal(result.raw.fallback, "external-node");
    } finally {
        fs.unlinkSync(wavPath);
    }
});

test("detectVoiceActivity returns a friendly error when the ONNX model is missing", async () => {
    const wavPath = path.join(os.tmpdir(), `duckycut_vad_${Date.now()}.wav`);
    writeTestWav(wavPath, { sampleRate: 16000, channels: 1, samplesPerChannel: 16000 });

    try {
        await assert.rejects(
            () => detectVoiceActivity(wavPath, {
                modelPath: path.join(os.tmpdir(), "missing-silero-vad.onnx"),
                runtimeFactory: () => ({}),
            }),
            /Silero VAD ONNX model not found/
        );
    } finally {
        fs.unlinkSync(wavPath);
    }
});
