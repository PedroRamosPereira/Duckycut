const { detectVoiceActivity } = require("./vadDetector");

let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
    input += chunk;
});

process.stdin.on("end", async () => {
    try {
        const payload = JSON.parse(input || "{}");
        const result = await detectVoiceActivity(payload.wavPath, Object.assign({}, payload.options, {
            allowExternalNodeFallback: false,
        }));
        process.stdout.write(JSON.stringify(result));
    } catch (err) {
        process.stderr.write(err && err.stack ? err.stack : String(err || "Unknown VAD worker error"));
        process.exitCode = 1;
    }
});
