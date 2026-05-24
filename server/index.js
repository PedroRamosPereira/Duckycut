/**
 * Duckycut - Node.js Backend Server
 * Runs on port 3847. Handles FFmpeg silence detection.
 */

const http = require("http");
const { detectSilence } = require("./silenceDetector");

const PORT = 3847;

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            } catch (e) {
                reject(new Error("Invalid JSON"));
            }
        });
        req.on("error", reject);
    });
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
        sendJSON(res, 200, {});
        return;
    }

    try {
        // Health check
        if (req.method === "GET" && req.url === "/health") {
            sendJSON(res, 200, { status: "ok", version: "1.0.0" });
            return;
        }

        // Analyze: runs FFmpeg silencedetect on the media file
        if (req.method === "POST" && req.url === "/analyze") {
            const params = await parseBody(req);
            const { mediaPath, threshold, minDuration } = params;

            if (!mediaPath) {
                sendJSON(res, 400, { error: "mediaPath is required" });
                return;
            }

            const result = await detectSilence(
                mediaPath,
                threshold || -30,
                minDuration || 0.75
            );

            sendJSON(res, 200, result);
            return;
        }

        sendJSON(res, 404, { error: "Not found" });
    } catch (err) {
        console.error("Server error:", err);
        sendJSON(res, 500, { error: err.message });
    }
});

server.listen(PORT, "127.0.0.1", () => {
    console.log(`[Duckycut] Server running on http://127.0.0.1:${PORT}`);
});
