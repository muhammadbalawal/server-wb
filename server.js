require('dotenv').config();


const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
if (!ASSEMBLYAI_API_KEY) {
  console.error("Please set ASSEMBLYAI_API_KEY in your environment");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Twilio Media Stream Connected");

  // Step 1: Start AssemblyAI realtime transcript session
  axios.post("https://api.assemblyai.com/v2/realtime/ws?sample_rate=8000", null, {
    headers: {
      Authorization: ASSEMBLYAI_API_KEY,
    },
  }).then(({ data }) => {
    // Step 2: Connect to AssemblyAI WebSocket endpoint
    const assemblyWs = new WebSocket(data.url);

    assemblyWs.on("open", () => {
      console.log("✅ Connected to AssemblyAI realtime websocket");
    });

    assemblyWs.on("message", (message) => {
      // Print transcription results
      const res = JSON.parse(message);
      if (res.message_type === "FinalTranscript") {
        console.log("Transcript:", res.text);
      }
    });

    assemblyWs.on("close", () => {
      console.log("AssemblyAI WebSocket closed");
    });

    ws.on("message", (data) => {
      // Twilio Media Stream sends JSON messages with audio payload in base64
      try {
        const msg = JSON.parse(data);
        if (msg.event === "media") {
          const audioBase64 = msg.media.payload;
          // Send raw audio bytes to AssemblyAI
          assemblyWs.send(
            JSON.stringify({ audio_data: audioBase64 })
          );
        }
      } catch (err) {
        console.error("Failed to parse Twilio message", err);
      }
    });

    ws.on("close", () => {
      console.log("🔴 Twilio Media Stream Disconnected");
      assemblyWs.close();
    });

  }).catch((err) => {
    console.error("Failed to start AssemblyAI realtime session", err);
    ws.close();
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
});
