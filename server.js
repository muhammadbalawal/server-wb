require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error("❌ Please set DEEPGRAM_API_KEY in your environment");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("🔌 Twilio Media Stream Connected");
  
  let callSid = null;
  
  // Deepgram WebSocket URL
  const deepgramUrl = `wss://api.deepgram.com/v1/listen?` + new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: 8000,
    channels: 1,
    punctuate: true,
    interim_results: true,
    smart_format: true,
    model: 'nova-2',
    language: 'en-US'
  }).toString();
  
  // Connect to Deepgram
  const deepgramWs = new WebSocket(deepgramUrl, {
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`
    }
  });
  
  let isDeepgramOpen = false;
  const audioQueue = [];
  
  deepgramWs.on("open", () => {
    console.log("✅ Connected to Deepgram");
    isDeepgramOpen = true;
    
    // Send any queued audio
    while (audioQueue.length > 0) {
      const audioData = audioQueue.shift();
      if (deepgramWs.readyState === WebSocket.OPEN) {
        deepgramWs.send(audioData);
      }
    }
  });
  
  deepgramWs.on("message", (message) => {
    try {
      const response = JSON.parse(message);
      
      if (response.type === 'Results') {
        const result = response.channel?.alternatives?.[0];
        
        if (result && result.transcript) {
          if (response.is_final) {
            console.log(`📝 [FINAL] ${result.transcript}`);
          } else {
            console.log(`🔄 [INTERIM] ${result.transcript}`);
          }
        }
      }
    } catch (err) {
      console.error("❌ Failed to process Deepgram message:", err);
    }
  });
  
  deepgramWs.on("close", () => {
    console.log("🔒 Deepgram WebSocket closed");
  });
  
  deepgramWs.on("error", (err) => {
    console.error("❌ Deepgram WebSocket error:", err);
  });
  
  // Handle Twilio messages
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === "start" && msg.start) {
        callSid = msg.start.callSid;
        console.log(`🎯 Call started: ${callSid}`);
      }
      
      if (msg.event === "media" && msg.media) {
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        
        if (isDeepgramOpen && deepgramWs.readyState === WebSocket.OPEN) {
          deepgramWs.send(audioBuffer);
        } else {
          audioQueue.push(audioBuffer);
        }
      }
      
      if (msg.event === "stop") {
        console.log(`🛑 Stream stopped for ${callSid}`);
      }
      
    } catch (err) {
      console.error("❌ Failed to parse Twilio message:", err);
    }
  });
  
  ws.on("close", () => {
    console.log("🔴 Twilio Media Stream Disconnected");
    
    if (deepgramWs && deepgramWs.readyState === WebSocket.OPEN) {
      deepgramWs.close();
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
});