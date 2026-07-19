/**
 * Duckycut - resolvedor de binários externos.
 * O instalador Windows pode baixar ffmpeg.exe/node.exe para <extensão>/bin;
 * quando o bundled não existe, cai para o nome puro e o spawn usa o PATH.
 */
const fs = require("fs");
const path = require("path");

const DEFAULT_BIN_DIR = path.join(__dirname, "..", "bin");

function resolveTool(toolName, binDir) {
    const dir = binDir || DEFAULT_BIN_DIR;
    const candidates = [path.join(dir, toolName + ".exe"), path.join(dir, toolName)];
    for (const candidate of candidates) {
        try {
            if (fs.statSync(candidate).isFile()) return candidate;
        } catch (_) {}
    }
    return toolName;
}

module.exports = { resolveTool, DEFAULT_BIN_DIR };
