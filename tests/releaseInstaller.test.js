const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), "utf8");
}

test("package exposes release scripts without changing development install", () => {
    const pkg = JSON.parse(read("package.json"));

    assert.equal(pkg.scripts["install-extension"], "node scripts/install.js");
    assert.equal(pkg.scripts["release:prepare"], "node scripts/prepare-release.js");
    assert.equal(pkg.scripts["release:installer"], "powershell -ExecutionPolicy Bypass -File scripts/build-installer.ps1");
});

test("release preparation script ships only the CEP payload needed by Duckycut", () => {
    const script = read("scripts/prepare-release.js");

    [
        "client",
        "host",
        "CSXS/manifest.xml",
        "preset/Duckycut_Silero_Analysis.epr",
        "server/silenceDetector.js",
        "server/vadDetector.js",
        "server/vadWorker.js",
        "server/models/silero_vad.onnx",
        "server/toolPaths.js",
        "package.json",
        "package-lock.json"
    ].forEach((required) => {
        assert.match(script, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "[/\\\\]")));
    });

    assert.match(script, /onnxruntime-node/, "native ONNX dependency must ship in the payload");
    assert.match(script, /requiredNodeModules/, "onnxruntime must be required, not optional");
    assert.doesNotMatch(script, /optionalNodeModules/, "missing onnxruntime must abort the release build");
    assert.doesNotMatch(script, /tests[/\\\\]/, "tests should not be part of the release payload");
    assert.doesNotMatch(script, /\.git[/\\\\]/, ".git should not be part of the release payload");
    assert.match(script, /fs\.cpSync|copyRecursive/, "payload should use real file copies");
});

test("Inno Setup script installs to the CEP extension folder and runs dependency helpers", () => {
    const iss = read("installer/duckycut.iss");

    assert.match(iss, /DuckycutSetup/, "installer output should be DuckycutSetup.exe");
    assert.match(iss, /Adobe\\CEP\\extensions\\com\.duckycut\.panel/, "installer should target the CEP extension folder");
    assert.match(iss, /Source:\s*"\.\.\\dist\\release-payload\\\*"/, "installer should include the prepared payload");
    assert.match(iss, /enable-cep-debug\.ps1/, "installer should enable unsigned CEP extensions");
    assert.match(iss, /check-dependencies\.ps1/, "installer should run dependency checks");
    assert.match(iss, /Flags:\s*recursesubdirs/, "installer should copy directories, not symlink them");
});

test("installer removes an existing development junction before copying files", () => {
    const iss = read("installer/duckycut.iss");

    assert.match(iss, /PrepareToInstall/, "installer should clean unsafe existing targets before writing files");
    assert.match(iss, /ReparsePoint/, "installer should detect the dev install junction/symlink");
    assert.match(iss, /Remove-Item/, "installer should remove only the junction path before copying real files");
    assert.match(iss, /com\.duckycut\.panel/, "cleanup should be scoped to the Duckycut CEP folder");
});

test("dependency scripts check FFmpeg, Node, CEP folder, payload files, and CSXS debug keys", () => {
    const check = read("installer/scripts/check-dependencies.ps1");
    const enable = read("installer/scripts/enable-cep-debug.ps1");

    assert.match(check, /ffmpeg/i);
    assert.match(check, /node/i);
    assert.match(check, /Adobe\\CEP\\extensions/i);
    assert.match(check, /CSXS\.\*/);
    assert.match(check, /server\\models\\silero_vad\.onnx/);
    assert.match(check, /package-lock\.json/);

    ["9", "10", "11", "12", "13"].forEach((version) => {
        assert.match(enable, new RegExp(`CSXS\\.${version}`));
    });
    assert.match(enable, /PlayerDebugMode/);
});

test("build installer script prepares payload and explains missing Inno Setup", () => {
    const script = read("scripts/build-installer.ps1");

    assert.match(script, /prepare-release\.js/, "build should prepare payload first");
    assert.match(script, /ISCC\.exe/, "build should call the Inno Setup compiler");
    assert.match(script, /LOCALAPPDATA\\Programs\\Inno Setup 6\\ISCC\.exe/, "build should find per-user Inno Setup installs");
    assert.match(script, /winget install JRSoftware\.InnoSetup|Inno Setup/i, "build should explain how to install Inno Setup");
    assert.match(script, /dist\\installer\\DuckycutSetup\.exe/, "build should point to the final exe path");
});

test("dev install script detects broken junctions with lstat", () => {
    const script = read("scripts/install.js");

    assert.match(script, /fs\.lstatSync\(targetPath\)/, "broken symlinks are invisible to existsSync; lstat must be used");
    assert.doesNotMatch(script, /fs\.existsSync\(targetPath\)/, "existsSync would skip broken junctions and fail with EEXIST");
});

test("installer build stops when payload preparation fails", () => {
    const script = read("scripts/build-installer.ps1");

    assert.match(script, /\$LASTEXITCODE -ne 0/, "PowerShell 5.1 does not stop on native exe failure; the exit code must be checked");
});

test("installer downloads FFmpeg and Node when missing and extracts them to app bin", () => {
    const iss = read("installer/duckycut.iss");

    assert.match(iss, /CreateDownloadPage/, "installer should use the Inno Setup 6 download page");
    assert.match(iss, /gyan\.dev\/ffmpeg\/builds\/ffmpeg-release-essentials\.zip/, "FFmpeg comes from the gyan.dev static release build");
    assert.match(iss, /nodejs\.org\/dist\/v22\.12\.0\/node-v22\.12\.0-win-x64\.zip/, "Node version must be pinned");
    assert.match(iss, /Expand-Archive/, "zips are extracted with PowerShell");
    assert.match(iss, /\{app\}\\bin/, "binaries land inside the extension bin folder");
    assert.match(iss, /where\.exe|Get-Command/, "installer must skip downloads when the tool is already on PATH");
    assert.match(iss, /\[UninstallDelete\]/, "downloaded binaries must be removed on uninstall");
});

test("dependency check accepts bundled binaries in the install bin folder", () => {
    const check = read("installer/scripts/check-dependencies.ps1");

    assert.match(check, /bin\\ffmpeg\.exe|bin\\\$Name\.exe/i, "check must look at <install>\\bin before PATH");
    assert.match(check, /bundled/i, "report should say when the tool is the bundled one");
});
