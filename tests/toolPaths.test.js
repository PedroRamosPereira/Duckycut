// tests/toolPaths.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveTool, DEFAULT_BIN_DIR } = require("../server/toolPaths");

function makeTempBinDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "duckycut-bin-"));
}

test("resolveTool prefers the bundled .exe inside binDir", () => {
    const binDir = makeTempBinDir();
    const bundled = path.join(binDir, "ffmpeg.exe");
    fs.writeFileSync(bundled, "fake");
    assert.equal(resolveTool("ffmpeg", binDir), bundled);
    fs.rmSync(binDir, { recursive: true, force: true });
});

test("resolveTool accepts bundled tool without .exe suffix", () => {
    const binDir = makeTempBinDir();
    const bundled = path.join(binDir, "node");
    fs.writeFileSync(bundled, "fake");
    assert.equal(resolveTool("node", binDir), bundled);
    fs.rmSync(binDir, { recursive: true, force: true });
});

test("resolveTool falls back to the bare name when binDir has no tool", () => {
    const binDir = makeTempBinDir();
    assert.equal(resolveTool("ffmpeg", binDir), "ffmpeg");
    fs.rmSync(binDir, { recursive: true, force: true });
});

test("resolveTool falls back to the bare name when binDir does not exist", () => {
    assert.equal(resolveTool("ffmpeg", path.join(os.tmpdir(), "duckycut-nope-xyz")), "ffmpeg");
});

test("DEFAULT_BIN_DIR points to <extension root>/bin", () => {
    assert.equal(DEFAULT_BIN_DIR, path.join(path.resolve(__dirname, ".."), "bin"));
});

test("silenceDetector spawns ffmpeg through resolveTool", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "server", "silenceDetector.js"), "utf8");
    assert.match(src, /require\("\.\/toolPaths"\)/);
    assert.doesNotMatch(src, /spawn\("ffmpeg"/, "spawn must use resolveTool(\"ffmpeg\"), not the bare name");
    assert.match(src, /spawn\(resolveTool\("ffmpeg"\)/);
});

test("vadDetector resolves the external node through resolveTool", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "server", "vadDetector.js"), "utf8");
    assert.match(src, /require\("\.\/toolPaths"\)/);
    assert.match(src, /opts\.nodeCommand \|\| resolveTool\("node"\)/);
});
