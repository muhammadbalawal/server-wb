require("dotenv").config();
const http = require("http");
const WebSocket = require("ws");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

if (!ASSEMBLYAI_API_KEY) {
  console.error("❌ Please set ASSEMBLYAI_API_KEY in your environment");
  process.exit(1);
}

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// Store active connections for monitoring
const activeConnections = new Map();

wss.on("connection", (ws) => {
  const connectionId = `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  console.log(`🔌 Twilio Media Stream Connected: ${connectionId}`);
  
  let callSid = null;
  let assemblyWs = null;
  let transcriptionBuffer = [];
  
  // Get AssemblyAI token and establish connection
  axios
    .post(
      "https://api.assemblyai.com/v2/realtime/token",
      { expires_in: 3600 }, // Optional: set token expiration
      {
        headers: {
          authorization: ASSEMBLYAI_API_KEY,
        },
      }
    )
    .then((res) => {
      const { token } = res.data;
      
      assemblyWs = new WebSocket(
        `wss://api.assemblyai.com/v2/realtime/ws?sample_rate=8000&token=${token}`
      );
      
      const audioQueue = [];
      let isAssemblyOpen = false;
      
      assemblyWs.on("open", () => {
        console.log(`✅ AssemblyAI connected for ${connectionId}`);
        isAssemblyOpen = true;
        
        // Flush any queued audio
        while (audioQueue.length > 0) {
          const audio_data = audioQueue.shift();
          assemblyWs.send(JSON.stringify({ audio_data }));
        }
      });
      
      assemblyWs.on("message", async (message) => {
        try {
          const res = JSON.parse(message);
          
          if (res.message_type === "FinalTranscript" && res.text) {
            const transcriptData = {
              callSid: callSid,
              text: res.text,
              confidence: res.confidence,
              timestamp: new Date().toISOString(),
              speaker: 'caller', // Media stream typically captures caller
              connectionId: connectionId
            };
            
            console.log(`📝 [${callSid || connectionId}] Transcript:`, res.text);
            
            // Save to file
            await saveTranscription(transcriptData);
            
            // Send back to Twilio client
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'transcript',
                data: transcriptData 
              }));
            }
          } else if (res.message_type === "PartialTranscript" && res.text) {
            // Optional: handle partial transcripts for real-time display
            console.log(`🔄 [${callSid || connectionId}] Partial:`, res.text);
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ 
                type: 'partial_transcript',
                data: {
                  text: res.text,
                  timestamp: new Date().toISOString()
                }
              }));
            }
          }
        } catch (err) {
          console.error("❌ Failed to process AssemblyAI message:", err);
        }
      });
      
      assemblyWs.on("close", (code, reason) => {
        console.log(`🔒 AssemblyAI WebSocket closed for ${connectionId}:`, code, reason);
      });
      
      assemblyWs.on("error", (err) => {
        console.error(`❌ AssemblyAI WebSocket error for ${connectionId}:`, err);
      });
      
      // Handle Twilio messages
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data);
          
          // Capture call SID from start event
          if (msg.event === "start" && msg.start) {
            callSid = msg.start.callSid;
            console.log(`🎯 Call started: ${callSid}`);
            
            // Store connection info
            activeConnections.set(connectionId, {
              callSid,
              startTime: new Date(),
              transcriptCount: 0
            });
          }
          
          // Process media (audio) events
          if (msg.event === "media" && msg.media) {
            const audioBase64 = msg.media.payload;
            
            if (isAssemblyOpen && assemblyWs.readyState === WebSocket.OPEN) {
              assemblyWs.send(JSON.stringify({ audio_data: audioBase64 }));
            } else {
              audioQueue.push(audioBase64);
            }
          }
          
          // Handle stop event
          if (msg.event === "stop") {
            console.log(`🛑 Stream stopped for ${callSid || connectionId}`);
          }
          
        } catch (err) {
          console.error("❌ Failed to parse Twilio message:", err);
        }
      });
      
      ws.on("close", async () => {
        console.log(`🔴 Twilio Media Stream Disconnected: ${connectionId}`);
        
        // Clean up AssemblyAI connection
        if (assemblyWs && assemblyWs.readyState === WebSocket.OPEN) {
          assemblyWs.close();
        }
        
        // Remove from active connections
        activeConnections.delete(connectionId);
        
        // Final save of any remaining transcriptions
        if (transcriptionBuffer.length > 0) {
          await saveTranscriptionBatch(transcriptionBuffer);
        }
      });
      
    })
    .catch((err) => {
      console.error("❌ Failed to get AssemblyAI token:", err.response?.data || err.message);
      ws.close();
    });
});

// Function to save individual transcription
async function saveTranscription(transcriptData) {
  try {
    if (!transcriptData.callSid) return;
    
    const transcriptionsDir = path.join(process.cwd(), 'transcriptions');
    
    // Create directory if it doesn't exist
    try {
      await fs.access(transcriptionsDir);
    } catch {
      await fs.mkdir(transcriptionsDir, { recursive: true });
    }
    
    const fileName = `call_${transcriptData.callSid}.json`;
    const filePath = path.join(transcriptionsDir, fileName);
    
    // Read existing transcriptions
    let transcriptions = [];
    try {
      const existingData = await fs.readFile(filePath, 'utf8');
      transcriptions = JSON.parse(existingData);
    } catch {
      // File doesn't exist yet
      transcriptions = [];
    }
    
    // Add new transcription
    transcriptions.push({
      ...transcriptData,
      savedAt: new Date().toISOString()
    });
    
    // Save back to file
    await fs.writeFile(filePath, JSON.stringify(transcriptions, null, 2));
    
    console.log(`💾 Transcription saved for ${transcriptData.callSid}`);
  } catch (error) {
    console.error('❌ Error saving transcription:', error);
  }
}

// Function to save batch of transcriptions
async function saveTranscriptionBatch(transcriptions) {
  for (const transcript of transcriptions) {
    await saveTranscription(transcript);
  }
}

// Health check endpoint
server.on('request', (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      activeConnections: activeConnections.size,
      uptime: process.uptime(),
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  
  // Close all WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close();
  });
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`✅ WebSocket server listening on port ${PORT}`);
  console.log(`🏥 Health check available at http://localhost:${PORT}/health`);
});