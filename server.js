// File: websocket-server.js
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

// Store connections by call SID and track type
const connections = new Map();

function createDeepgramConnection(label) {
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
  
  const deepgramWs = new WebSocket(deepgramUrl, {
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`
    }
  });
  
  let isDeepgramOpen = false;
  const audioQueue = [];
  
  deepgramWs.on("open", () => {
    console.log(`✅ Connected to Deepgram for ${label}`);
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
            console.log(`📝 [${label}] ${result.transcript}`);
          } else {
            console.log(`🔄 [${label}] ${result.transcript}`);
          }
        }
      }
    } catch (err) {
      console.error(`❌ Failed to process Deepgram message for ${label}:`, err);
    }
  });
  
  deepgramWs.on("close", () => {
    console.log(`🔒 Deepgram WebSocket closed for ${label}`);
  });
  
  deepgramWs.on("error", (err) => {
    console.error(`❌ Deepgram WebSocket error for ${label}:`, err);
  });
  
  return {
    deepgramWs,
    isDeepgramOpen: () => isDeepgramOpen,
    audioQueue,
    setOpen: (status) => { isDeepgramOpen = status; }
  };
}

wss.on("connection", (ws) => {
  console.log("🔌 New Twilio Media Stream Connected");
  
  let callSid = null;
  let trackType = null;
  let deepgramConnection = null;
  
  // Handle Twilio messages
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === "start" && msg.start) {
        callSid = msg.start.callSid;
        trackType = msg.start.mediaFormat?.track || 'unknown';
        
        console.log(`🎯 Call started: ${callSid} - Track: ${trackType}`);
        
        // Determine the label for this stream
        let streamLabel;
        if (trackType === 'inbound_track') {
          streamLabel = 'CALLER';
        } else if (trackType === 'outbound_track') {
          streamLabel = 'CALLEE';
        } else {
          streamLabel = `UNKNOWN-${trackType}`;
        }
        
        // Create Deepgram connection for this stream
        deepgramConnection = createDeepgramConnection(streamLabel);
        
        // Store connection info
        const connectionKey = `${callSid}-${trackType}`;
        connections.set(connectionKey, {
          ws,
          deepgramConnection,
          streamLabel,
          callSid,
          trackType
        });
        
        console.log(`🎙️ Live transcription started for ${streamLabel}`);
      }
      
      if (msg.event === "media" && msg.media && deepgramConnection) {
        const audioBuffer = Buffer.from(msg.media.payload, 'base64');
        
        if (deepgramConnection.isDeepgramOpen() && deepgramConnection.deepgramWs.readyState === WebSocket.OPEN) {
          deepgramConnection.deepgramWs.send(audioBuffer);
        } else {
          deepgramConnection.audioQueue.push(audioBuffer);
        }
      }
      
      if (msg.event === "stop") {
        console.log(`🛑 Stream stopped for ${callSid} - Track: ${trackType}`);
        
        // Clean up this specific connection
        const connectionKey = `${callSid}-${trackType}`;
        const connectionInfo = connections.get(connectionKey);
        
        if (connectionInfo && connectionInfo.deepgramConnection) {
          if (connectionInfo.deepgramConnection.deepgramWs.readyState === WebSocket.OPEN) {
            connectionInfo.deepgramConnection.deepgramWs.close();
          }
        }
        
        connections.delete(connectionKey);
        
        // Check if this was the last connection for this call
        const remainingConnections = Array.from(connections.keys()).filter(key => key.startsWith(callSid));
        if (remainingConnections.length === 0) {
          console.log(`✅ All streams ended for call ${callSid}`);
        }
      }
      
    } catch (err) {
      console.error("❌ Failed to parse Twilio message:", err);
    }
  });
  
  ws.on("close", () => {
    console.log(`🔴 Twilio Media Stream Disconnected - Call: ${callSid}, Track: ${trackType}`);
    
    // Clean up Deepgram connection
    if (deepgramConnection && deepgramConnection.deepgramWs.readyState === WebSocket.OPEN) {
      deepgramConnection.deepgramWs.close();
    }
    
    // Remove from connections map
    if (callSid && trackType) {
      const connectionKey = `${callSid}-${trackType}`;
      connections.delete(connectionKey);
    }
  });
  
  ws.on("error", (err) => {
    console.error(`❌ WebSocket error for ${callSid}-${trackType}:`, err);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
  console.log(`🎙️ Ready to handle dual stream transcription:`);
  console.log(`   📞 CALLER (inbound_track) - Real-time caller audio`);
  console.log(`   📱 CALLEE (outbound_track) - Real-time callee audio`);
});