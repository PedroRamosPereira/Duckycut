const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outputDir = path.join(root, "dist", "release-payload");

const requiredEntries = [
    "client",
    "host",
    "CSXS/manifest.xml",
    "preset/Duckycut_Silero_Analysis.epr",
    "server/silenceDetector.js",
    "server/vadDetector.js",
    "server/vadWorker.js",
    "server/models/silero_vad.onnx",
    "package.json",
    "package-lock.json"
];

const optionalNodeModules = [
    "onnxruntime-node",
    "onnxruntime-common"
];

const excludedNames = new Set([
    ".git",
    "tests",
    "docs",
    ".claude"
]);

function toPlatformPath(relativePath) {
    return relativePath.split(/[\\/]/).join(path.sep);
}

function ensureInsideRoot(targetPath) {
    const relative = path.relative(root, targetPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Refusing to copy outside project root: " + targetPath);
    }
}

function ensureRequiredFile(relativePath) {
    const fullPath = path.join(root, toPlatformPath(relativePath));
    ensureInsideRoot(fullPath);
    if (!fs.existsSync(fullPath)) {
        throw new Error("Required release payload entry is missing: " + relativePath);
    }
    return fullPath;
}

function copyRecursive(source, destination) {
    const name = path.basename(source);
    if (excludedNames.has(name)) {
        return;
    }

    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
        throw new Error("Release payload must use real files, not symlinks: " + source);
    }

    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source)) {
            copyRecursive(path.join(source, entry), path.join(destination, entry));
        }
        return;
    }

    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function copyEntry(relativePath) {
    const source = ensureRequiredFile(relativePath);
    const destination = path.join(outputDir, toPlatformPath(relativePath));
    copyRecursive(source, destination);
}

function copyOptionalNodeDependency(packageName) {
    const source = path.join(root, "node_modules", packageName);
    if (!fs.existsSync(source)) {
        console.warn("Optional dependency not copied because it is not installed: " + packageName);
        return;
    }

    copyRecursive(source, path.join(outputDir, "node_modules", packageName));
}

function prepareRelease() {
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });

    for (const entry of requiredEntries) {
        copyEntry(entry);
    }

    for (const packageName of optionalNodeModules) {
        copyOptionalNodeDependency(packageName);
    }

    console.log("Duckycut release payload prepared:");
    console.log("  " + outputDir);
}

if (require.main === module) {
    try {
        prepareRelease();
    } catch (err) {
        console.error("Release preparation failed: " + err.message);
        process.exit(1);
    }
}

module.exports = {
    prepareRelease,
    requiredEntries,
    outputDir
};
