require("dotenv").config();

const http = require("http");
const WebSocket = require("ws");

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!ASSEMBLYAI_API_KEY) {
  console.error("Please set ASSEMBLYAI_API_KEY in your environment");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Twilio Media Stream Connected");

  // ✅ Connect to AssemblyAI's WebSocket directly (no axios)
  const assemblyWs = new WebSocket(
    "wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000",
    {
      headers: {
        Authorization: ASSEMBLYAI_API_KEY,
      },
    }
  );

  assemblyWs.on("open", () => {
    console.log("✅ Connected to AssemblyAI realtime websocket");
  });

  assemblyWs.on("message", (message) => {
    const res = JSON.parse(message);
    if (res.message_type === "FinalTranscript") {
      console.log("📄 Final Transcript:", res.text);
      ws.send(JSON.stringify({ transcript: res.text }));
    }
  });

  assemblyWs.on("error", (err) => {
    console.error("❌ AssemblyAI error:", err);
  });

  assemblyWs.on("close", () => {
    console.log("🔒 AssemblyAI WebSocket closed");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === "media") {
        const audioBase64 = msg.media.payload;
        assemblyWs.send(JSON.stringify({ audio_data: audioBase64 }));
      }
    } catch (err) {
      console.error("❌ Failed to parse Twilio message:", err);
    }
  });

  ws.on("close", () => {
    console.log("🔴 Twilio Media Stream Disconnected");
    assemblyWs.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
});
