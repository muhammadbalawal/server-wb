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

// Main WebSocket server for Twilio media streams
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    // Only accept connections that are NOT to the /transcript path
    const url = new URL(info.req.url, 'http://localhost');
    if (url.pathname === '/transcript') {
      return false; // Let the transcript server handle this
    }
    
    // Extract path to determine track type
    info.req.trackType = url.pathname === '/inbound' ? 'inbound_track' : 
                        url.pathname === '/outbound' ? 'outbound_track' : 'unknown';
    return true;
  }
});

// Separate WebSocket server for transcript clients
const transcriptWss = new WebSocket.Server({ 
  server,
  path: '/transcript'
});

// Store connections by call SID and track type
const connections = new Map();

// Store client connections for transcript broadcasting
const transcriptClients = new Map(); // callSid -> Set of client WebSockets

// Function to broadcast transcript to clients
function broadcastTranscript(callSid, speaker, transcript, isFinal) {
  if (transcriptClients.has(callSid)) {
    const message = JSON.stringify({
      type: 'transcript',
      speaker: speaker,
      transcript: transcript,
      isFinal: isFinal,
      timestamp: new Date().toISOString()
    });
    
    const clients = transcriptClients.get(callSid);
    clients.forEach(clientWs => {
      if (clientWs.readyState === WebSocket.OPEN) {
        try {
          clientWs.send(message);
          console.log(`📤 Sent transcript to client: [${speaker}] ${transcript.substring(0, 50)}...`);
        } catch (err) {
          console.error('❌ Failed to send transcript to client:', err);
        }
      }
    });
  }
}

function createDeepgramConnection(label, callSid) {
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
            // Broadcast final transcript to clients
            broadcastTranscript(callSid, label, result.transcript, true);
          } else {
            console.log(`🔄 [${label}] ${result.transcript}`);
            // Broadcast interim transcript to clients
            broadcastTranscript(callSid, label, result.transcript, false);
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

// Handle Twilio media stream connections
wss.on("connection", (ws, req) => {
  const trackType = req.trackType || 'unknown';
  console.log(`🔌 New Twilio Media Stream Connected - Track: ${trackType}`);
  
  let callSid = null;
  let deepgramConnection = null;
  
  // Handle Twilio messages
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === "start" && msg.start) {
        callSid = msg.start.callSid;
        const streamSid = msg.start.streamSid;
        
        console.log(`🎯 Call started: ${callSid} - Stream: ${streamSid} - Track: ${trackType}`);
        
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
        deepgramConnection = createDeepgramConnection(streamLabel, callSid);
        
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
          
          // Clean up transcript clients for this call
          if (transcriptClients.has(callSid)) {
            const clients = transcriptClients.get(callSid);
            clients.forEach(clientWs => {
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({
                  type: 'call_ended',
                  callSid: callSid
                }));
              }
            });
            transcriptClients.delete(callSid);
          }
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

// Handle transcript client connections
transcriptWss.on("connection", (clientWs, req) => {
  console.log("📱 Transcript client connected");
  
  let clientCallSid = null;
  
  // Send welcome message
  clientWs.send(JSON.stringify({
    type: 'connected',
    message: 'Connected to transcript server'
  }));
  
  clientWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'register' && msg.callSid) {
        clientCallSid = msg.callSid;
        
        // Add client to the call's transcript clients
        if (!transcriptClients.has(clientCallSid)) {
          transcriptClients.set(clientCallSid, new Set());
        }
        transcriptClients.get(clientCallSid).add(clientWs);
        
        console.log(`📱 Client registered for call ${clientCallSid}`);
        
        // Send confirmation
        clientWs.send(JSON.stringify({
          type: 'registered',
          callSid: clientCallSid,
          message: `Registered for call ${clientCallSid}`
        }));
      }
      
      if (msg.type === 'ping') {
        // Respond to ping with pong
        clientWs.send(JSON.stringify({
          type: 'pong'
        }));
      }
      
    } catch (err) {
      console.error("❌ Failed to parse client message:", err);
    }
  });
  
  clientWs.on("close", () => {
    console.log("📱 Transcript client disconnected");
    
    // Remove client from all call subscriptions
    if (clientCallSid && transcriptClients.has(clientCallSid)) {
      transcriptClients.get(clientCallSid).delete(clientWs);
      
      // Clean up empty sets
      if (transcriptClients.get(clientCallSid).size === 0) {
        transcriptClients.delete(clientCallSid);
        console.log(`📱 No more clients for call ${clientCallSid}`);
      }
    }
  });
  
  clientWs.on("error", (err) => {
    console.error("❌ Transcript client WebSocket error:", err);
  });
});

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      connections: connections.size,
      transcriptClients: Array.from(transcriptClients.keys()).length,
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
  console.log(`🎙️ Ready to handle dual stream transcription:`);
  console.log(`   📞 CALLER (inbound_track) - Real-time caller audio`);
  console.log(`   📱 CALLEE (outbound_track) - Real-time callee audio`);
  console.log(`   📡 Transcript broadcasting - Live transcripts to clients`);
  console.log(`   🏥 Health check available at: http://localhost:${PORT}/health`);
});