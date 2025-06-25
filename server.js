const WebSocket = require('ws');
const axios = require('axios');

class TranscriptionServer {
  constructor(port = 8080) {
    this.port = port;
    this.wss = new WebSocket.Server({ 
      port: this.port,
      path: '/audio-stream'
    });
    this.callSessions = new Map();
    this.deepgramUrl = 'wss://api.deepgram.com/v1/listen';
    
    this.setupWebSocketHandlers();
    console.log(`🚀 WebSocket server running on port ${this.port}`);
  }

  setupWebSocketHandlers() {
    this.wss.on('connection', (ws, request) => {
      console.log('🔌 New WebSocket connection established');
      
      const callSid = this.extractCallSid(request.url);
      if (!callSid) {
        console.error('❌ No CallSid found in WebSocket URL');
        ws.close();
        return;
      }

      // Store call session
      this.callSessions.set(callSid, {
        callSid,
        ws,
        transcriptBuffer: []
      });

      console.log(`📞 Call session started for: ${callSid}`);

      // Connect to Deepgram
      this.connectToDeepgram(callSid);

      // Handle incoming audio data
      ws.on('message', (data) => {
        this.handleAudioData(callSid, data);
      });

      // Handle connection close
      ws.on('close', () => {
        console.log(`📞 Call session ended for: ${callSid}`);
        this.disconnectFromDeepgram(callSid);
        this.callSessions.delete(callSid);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`❌ WebSocket error for call ${callSid}:`, error);
        this.disconnectFromDeepgram(callSid);
        this.callSessions.delete(callSid);
      });
    });
  }

  extractCallSid(url) {
    if (!url) return null;
    const urlParams = new URLSearchParams(url.split('?')[1]);
    return urlParams.get('callSid');
  }

  connectToDeepgram(callSid) {
    const session = this.callSessions.get(callSid);
    if (!session) return;

    // Deepgram connection parameters
    const params = new URLSearchParams({
      model: 'nova-2',
      language: 'en-US',
      punctuate: 'true',
      smart_format: 'true',
      diarize: 'true',
      interim_results: 'true',
      endpointing: '200'
    });

    const deepgramWs = new WebSocket(`${this.deepgramUrl}?${params.toString()}`, {
      headers: {
        'Authorization': `Token ${process.env.DEEPGRAM_API_KEY}`
      }
    });

    deepgramWs.onopen = () => {
      console.log(`🔗 Connected to Deepgram for call: ${callSid}`);
      session.deepgramConnection = deepgramWs;
    };

    deepgramWs.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleDeepgramResponse(callSid, data);
      } catch (error) {
        console.error('Error parsing Deepgram response:', error);
      }
    };

    deepgramWs.onerror = (error) => {
      console.error(`❌ Deepgram error for call ${callSid}:`, error);
    };

    deepgramWs.onclose = () => {
      console.log(`🔗 Deepgram connection closed for call: ${callSid}`);
    };
  }

  disconnectFromDeepgram(callSid) {
    const session = this.callSessions.get(callSid);
    if (session?.deepgramConnection) {
      session.deepgramConnection.close();
      session.deepgramConnection = undefined;
    }
  }

  handleAudioData(callSid, audioData) {
    const session = this.callSessions.get(callSid);
    if (!session?.deepgramConnection) {
      console.error(`❌ No Deepgram connection for call: ${callSid}`);
      return;
    }

    // Send audio data to Deepgram
    if (session.deepgramConnection.readyState === WebSocket.OPEN) {
      session.deepgramConnection.send(audioData);
    }
  }

  handleDeepgramResponse(callSid, data) {
    const session = this.callSessions.get(callSid);
    if (!session) return;

    if (data.type === 'Results') {
      const results = data.channel?.alternatives?.[0];
      if (!results) return;

      const transcript = results.transcript;
      const confidence = results.confidence || 0;
      const isFinal = !data.is_final;

      if (transcript && transcript.trim()) {
        const transcriptMessage = {
          transcript: transcript.trim(),
          confidence,
          timestamp: Date.now()
        };

        // Add speaker information if available
        if (data.speaker !== undefined) {
          transcriptMessage.speaker = data.speaker;
        }

        if (isFinal) {
          // Final result
          session.transcriptBuffer.push(transcriptMessage);
          this.broadcastTranscript(callSid, transcriptMessage);
          console.log(`📝 [${callSid}] Final transcript: ${transcriptMessage.transcript}`);
        } else {
          // Interim result
          transcriptMessage.isInterim = true;
          this.broadcastInterimTranscript(callSid, transcriptMessage);
        }
      }
    }
  }

  broadcastTranscript(callSid, message) {
    const session = this.callSessions.get(callSid);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'transcript',
        callSid,
        data: message
      }));
    }
  }

  broadcastInterimTranscript(callSid, message) {
    const session = this.callSessions.get(callSid);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({
        type: 'interim',
        callSid,
        data: message
      }));
    }
  }

  getTranscriptHistory(callSid) {
    const session = this.callSessions.get(callSid);
    return session ? session.transcriptBuffer : [];
  }

  close() {
    // Close all Deepgram connections
    for (const [callSid] of this.callSessions) {
      this.disconnectFromDeepgram(callSid);
    }
    this.wss.close();
  }
}

// Start the server if this file is run directly
if (require.main === module) {
  const port = process.env.WEBSOCKET_PORT || 8080;
  const server = new TranscriptionServer(port);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('🛑 Shutting down WebSocket server...');
    server.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('🛑 Terminating WebSocket server...');
    server.close();
    process.exit(0);
  });
}

module.exports = TranscriptionServer; 