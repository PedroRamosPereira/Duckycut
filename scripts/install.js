/**
 * Duckycut Installer
 * Creates a symlink from the CEP extensions folder to this project,
 * so Premiere Pro can load the extension during development.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const EXTENSION_ID = "com.duckycut.panel";
const extensionRoot = path.resolve(__dirname, "..");

// CEP extensions folder per platform
function getCEPFolder() {
    const platform = os.platform();
    if (platform === "win32") {
        return path.join(
            process.env.APPDATA,
            "Adobe",
            "CEP",
            "extensions"
        );
    } else if (platform === "darwin") {
        return path.join(
            os.homedir(),
            "Library",
            "Application Support",
            "Adobe",
            "CEP",
            "extensions"
        );
    }
    throw new Error("Unsupported platform: " + platform);
}

try {
    const cepFolder = getCEPFolder();
    const targetPath = path.join(cepFolder, EXTENSION_ID);

    // Create CEP folder if it doesn't exist
    if (!fs.existsSync(cepFolder)) {
        fs.mkdirSync(cepFolder, { recursive: true });
        console.log("Created CEP extensions folder:", cepFolder);
    }

    // Remove existing symlink/folder
    if (fs.existsSync(targetPath)) {
        const stats = fs.lstatSync(targetPath);
        if (stats.isSymbolicLink()) {
            fs.unlinkSync(targetPath);
        } else {
            console.log("WARNING: Existing folder at", targetPath);
            console.log("Please remove it manually and re-run this script.");
            process.exit(1);
        }
    }

    // Create symlink
    fs.symlinkSync(extensionRoot, targetPath, "junction");
    console.log("Symlink created:");
    console.log("  " + targetPath + " -> " + extensionRoot);
    console.log("");
    console.log("Next steps:");
    console.log("  1. Enable unsigned extensions (for development):");
    console.log("     Windows: Set registry key");
    console.log('       HKEY_CURRENT_USER\\SOFTWARE\\Adobe\\CSXS.11 -> "PlayerDebugMode" = "1"');
    console.log("     Mac: defaults write com.adobe.CSXS.11 PlayerDebugMode 1");
    console.log("  2. Restart Premiere Pro");
    console.log("  3. Go to Window > Extensions > Duckycut");
    console.log("");
    console.log("Make sure FFmpeg is installed and available in PATH!");
} catch (err) {
    console.error("Installation failed:", err.message);
    process.exit(1);
}
