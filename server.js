// File: websocket-server.js
require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");
const { createClient } = require('@supabase/supabase-js');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!DEEPGRAM_API_KEY) {
  console.error("❌ Please set DEEPGRAM_API_KEY in your environment");
  process.exit(1);
}

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Please set SUPABASE_URL and SUPABASE_ANON_KEY in your environment");
  process.exit(1);
}

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const server = http.createServer();
const wss = new WebSocket.Server({ 
  server,
  verifyClient: (info) => {
    // Extract path to determine track type
    const url = new URL(info.req.url, 'http://localhost');
    info.req.trackType = url.pathname === '/inbound' ? 'inbound_track' : 
                        url.pathname === '/outbound' ? 'outbound_track' : 'unknown';
    return true;
  }
});

// Store connections by call SID and track type
const connections = new Map();

// Store conversation buffers by call SID
const conversationBuffers = new Map();

// Function to save transcript to Supabase
async function saveTranscriptToSupabase(callSid, speaker, transcript) {
  try {
    const { error } = await supabase
      .from('transcriptions')
      .insert([
        {
          call_sid: callSid,
          speaker: speaker,
          transcript: transcript.trim()
        }
      ]);

    if (error) {
      console.error('❌ Error saving to Supabase:', error);
    } else {
      console.log(`💾 Saved: [${speaker}] ${transcript.substring(0, 50)}...`);
    }
  } catch (err) {
    console.error('❌ Exception saving to Supabase:', err);
  }
}

// Function to handle conversation turns
function handleConversationTurn(callSid, currentSpeaker, transcript) {
  if (!conversationBuffers.has(callSid)) {
    conversationBuffers.set(callSid, {
      currentSpeaker: null,
      buffer: '',
      lastActivity: Date.now()
    });
  }

  const conversation = conversationBuffers.get(callSid);
  
  // If speaker changed or this is the first message
  if (conversation.currentSpeaker !== currentSpeaker) {
    // Save the previous speaker's complete turn (if exists)
    if (conversation.currentSpeaker && conversation.buffer.trim()) {
      saveTranscriptToSupabase(callSid, conversation.currentSpeaker, conversation.buffer);
    }
    
    // Start new turn
    conversation.currentSpeaker = currentSpeaker;
    conversation.buffer = transcript + ' ';
  } else {
    // Same speaker continuing - append to buffer
    conversation.buffer += transcript + ' ';
  }
  
  conversation.lastActivity = Date.now();
}

// Function to flush any remaining conversation when call ends
function flushConversation(callSid) {
  if (conversationBuffers.has(callSid)) {
    const conversation = conversationBuffers.get(callSid);
    
    // Save any remaining buffered content
    if (conversation.currentSpeaker && conversation.buffer.trim()) {
      saveTranscriptToSupabase(callSid, conversation.currentSpeaker, conversation.buffer);
    }
    
    // Clean up
    conversationBuffers.delete(callSid);
  }
}

function createDeepgramConnection(label, callSid, trackType, streamSid) {
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
            // Buffer the transcript by conversation turns
            handleConversationTurn(callSid, label, result.transcript);
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

wss.on("connection", (ws, req) => {
  const trackType = req.trackType || 'unknown';
  console.log(`🔌 New Twilio Media Stream Connected - Track: ${trackType}`);
  
  let callSid = null;
  let streamSid = null;
  let deepgramConnection = null;
  
  // Handle Twilio messages
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event === "start" && msg.start) {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        
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
        deepgramConnection = createDeepgramConnection(streamLabel, callSid, trackType, streamSid);
        
        // Store connection info
        const connectionKey = `${callSid}-${trackType}`;
        connections.set(connectionKey, {
          ws,
          deepgramConnection,
          streamLabel,
          callSid,
          trackType,
          streamSid
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
          // Flush any remaining conversation when call completely ends
          flushConversation(callSid);
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
      
      // Check if this was the last connection for this call
      const remainingConnections = Array.from(connections.keys()).filter(key => key.startsWith(callSid));
      if (remainingConnections.length === 0) {
        // Flush any remaining conversation when call completely ends
        flushConversation(callSid);
      }
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
  console.log(`💾 Transcriptions will be saved to Supabase`);
});