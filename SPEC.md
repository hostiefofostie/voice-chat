# Voice Chat Web App - V0 Spec

> Real-time voice conversations with Claude via browser

## Overview

A minimal web app for voice conversations with Clawd (Claude). Speak into mic → Whisper transcribes → Gateway sends to Claude → TTS speaks response. Accessible from iPhone/Mac over Tailscale.

**Key benefit:** Keeps Claude as the AI with full OpenClaw context, memory, and tools.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser (Client)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐  │
│  │   Mic    │───▶│   VAD    │───▶│ Whisper  │───▶│ Gateway  │  │
│  │  Input   │    │ (Silero) │    │   STT    │    │    WS    │  │
│  └──────────┘    └──────────┘    └──────────┘    └────┬─────┘  │
│                                                        │        │
│  ┌──────────┐    ┌──────────┐                         │        │
│  │  Audio   │◀───│   TTS    │◀────────────────────────┘        │
│  │ Playback │    │ (OpenAI) │         Claude response          │
│  └──────────┘    └──────────┘                                   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                OpenClaw Gateway (localhost:18789)                │
│                                                                  │
│  • WebSocket protocol (chat.send / chat events)                 │
│  • Routes to Claude with full context                           │
│  • Maintains conversation history                                │
│  • Access to all tools (calendar, email, etc.)                  │
└─────────────────────────────────────────────────────────────────┘
```

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Frontend** | Vanilla JS + HTML | No build step, ~250 lines |
| **Voice Detection** | @ricky0123/vad-web | Best browser VAD, Silero model |
| **Speech-to-Text** | OpenAI gpt-4o-transcribe | Fast, accurate, accepts WAV |
| **LLM** | Claude via OpenClaw Gateway | Keeps existing context/memory |
| **Text-to-Speech** | OpenAI gpt-4o-mini-tts | Natural voice, low latency |

## User Flow

1. **Start** → Click "Start Conversation" (unlocks mic + audio on iOS)
2. **Listen** → VAD continuously monitors for speech (green indicator)
3. **Record** → Speech detected → indicator turns red
4. **Transcribe** → Speech ends → send to Whisper → show transcript
5. **Think** → Send to Gateway → Claude processes (yellow indicator)
6. **Speak** → Response → TTS → auto-play audio
7. **Loop** → Return to step 2

## UI Design

```
┌────────────────────────────────────────┐
│  🎙️ Voice Chat                         │
├────────────────────────────────────────┤
│                                        │
│           ◉ Listening...               │  ← Status indicator
│                                        │
│  ┌────────────────────────────────┐   │
│  │                                │   │
│  │  You: What's on my calendar?   │   │  ← Conversation
│  │                                │   │
│  │  Clawd: You have a meeting     │   │
│  │  at 3pm with...                │   │
│  │                                │   │
│  └────────────────────────────────┘   │
│                                        │
│         [ Stop Conversation ]          │
└────────────────────────────────────────┘
```

### Status States
| State | Color | Indicator |
|-------|-------|-----------|
| Listening | 🟢 Green | Pulsing dot |
| Recording | 🔴 Red | Solid dot |
| Processing | 🟡 Yellow | Spinning |
| Speaking | 🔵 Blue | Sound waves |
| Error | ⚫ Gray | X mark |

---

## Implementation Details

### 1. VAD Setup (@ricky0123/vad-web)

```html
<!-- CDN dependencies -->
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.wasm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js"></script>
```

```javascript
let vadInstance = null;

async function startVAD() {
  vadInstance = await vad.MicVAD.new({
    onSpeechStart: () => {
      setStatus('recording');
    },
    onSpeechEnd: async (audio) => {
      // audio = Float32Array at 16kHz
      setStatus('processing');
      await processAudio(audio);
      setStatus('listening');
    },
    onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
    baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/'
  });
  vadInstance.start();
}
```

### 2. Audio Conversion (Float32 → WAV)

```javascript
function float32ToWav(samples, sampleRate = 16000) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  
  // Helper to write string
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  
  // WAV header
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);           // fmt chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);   // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  
  // Convert float32 to int16
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  
  return new Blob([buffer], { type: 'audio/wav' });
}
```

### 3. Whisper STT

```javascript
async function transcribe(wavBlob) {
  const formData = new FormData();
  formData.append('file', wavBlob, 'audio.wav');
  formData.append('model', 'gpt-4o-transcribe');
  formData.append('language', 'en');
  
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openaiApiKey}`
    },
    body: formData
  });
  
  if (!response.ok) {
    throw new Error(`Whisper error: ${response.status}`);
  }
  
  const data = await response.json();
  return data.text;
}
```

### 4. OpenClaw Gateway WebSocket

```javascript
let ws = null;
let connected = false;
let pendingRequests = new Map();
let responseBuffer = '';

function connectGateway() {
  ws = new WebSocket(config.gatewayUrl);
  
  ws.onmessage = (event) => {
    const frame = JSON.parse(event.data);
    
    // Handle connect challenge
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      sendConnect();
    }
    
    // Handle responses
    if (frame.type === 'res') {
      const pending = pendingRequests.get(frame.id);
      if (pending) {
        pendingRequests.delete(frame.id);
        if (frame.ok) {
          pending.resolve(frame.payload);
        } else {
          pending.reject(new Error(frame.error?.message || 'Request failed'));
        }
      }
      
      // Check for hello-ok
      if (frame.payload?.type === 'hello-ok') {
        connected = true;
        console.log('Gateway connected');
      }
    }
    
    // Handle chat events (streaming response)
    if (frame.type === 'event' && frame.event === 'chat') {
      const { state, message } = frame.payload;
      
      if (state === 'delta' && message?.content) {
        // Accumulate streaming text
        const text = extractText(message.content);
        if (text) {
          responseBuffer += text;
          updateResponse(responseBuffer);
        }
      } else if (state === 'final') {
        // Response complete - send to TTS
        if (responseBuffer.trim()) {
          speak(responseBuffer);
        }
        responseBuffer = '';
      } else if (state === 'error') {
        console.error('Chat error:', frame.payload.errorMessage);
        setStatus('error');
      }
    }
  };
  
  ws.onclose = () => {
    connected = false;
    // Reconnect after delay
    setTimeout(connectGateway, 2000);
  };
  
  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function sendConnect() {
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({
    type: 'req',
    id,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'voice-chat',
        version: '1.0.0',
        platform: 'web',
        mode: 'operator'
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      ...(config.gatewayToken && { auth: { token: config.gatewayToken } })
    }
  }));
}

function sendMessage(text) {
  if (!connected) {
    console.error('Not connected to gateway');
    return;
  }
  
  const id = crypto.randomUUID();
  ws.send(JSON.stringify({
    type: 'req',
    id,
    method: 'chat.send',
    params: {
      sessionKey: config.sessionKey,
      message: text,
      idempotencyKey: crypto.randomUUID()
    }
  }));
  
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function extractText(content) {
  // Handle different content formats
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');
  }
  return '';
}
```

### 5. TTS Playback

```javascript
let currentAudio = null;

async function speak(text) {
  // Stop any playing audio
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  
  setStatus('speaking');
  
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.openaiApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: config.voice || 'nova',
      input: text,
      response_format: 'mp3'
    })
  });
  
  if (!response.ok) {
    throw new Error(`TTS error: ${response.status}`);
  }
  
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  
  currentAudio = new Audio(url);
  currentAudio.onended = () => {
    setStatus('listening');
    URL.revokeObjectURL(url);
    currentAudio = null;
  };
  currentAudio.onerror = () => {
    setStatus('error');
    URL.revokeObjectURL(url);
    currentAudio = null;
  };
  
  await currentAudio.play();
}
```

### 6. iOS Audio Unlock

```javascript
let audioUnlocked = false;

async function unlockAudio() {
  if (audioUnlocked) return;
  
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = ctx.createBuffer(1, 1, 22050);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  
  audioUnlocked = true;
  console.log('Audio unlocked');
}
```

### 7. Main Flow

```javascript
async function processAudio(audioSamples) {
  try {
    // Convert to WAV
    const wavBlob = float32ToWav(audioSamples);
    
    // Transcribe
    const transcript = await transcribe(wavBlob);
    if (!transcript.trim()) {
      setStatus('listening');
      return;
    }
    
    // Display user message
    addMessage('user', transcript);
    
    // Send to Claude via gateway
    await sendMessage(transcript);
    
  } catch (error) {
    console.error('Processing error:', error);
    setStatus('error');
  }
}

async function start() {
  // Unlock audio (required for iOS)
  await unlockAudio();
  
  // Connect to gateway
  connectGateway();
  
  // Start VAD
  await startVAD();
  
  setStatus('listening');
}

function stop() {
  if (vadInstance) {
    vadInstance.pause();
    vadInstance = null;
  }
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
  setStatus('stopped');
}
```

---

## Configuration

On first load, prompt for config and store in localStorage:

```javascript
const config = {
  openaiApiKey: '',      // Required: sk-...
  gatewayUrl: 'ws://localhost:18789/gateway',
  gatewayToken: '',      // Optional: if gateway auth enabled
  sessionKey: 'voice-chat:main',
  voice: 'nova'          // Options: alloy, echo, fable, onyx, nova, shimmer
};

function loadConfig() {
  const saved = localStorage.getItem('voice-chat-config');
  if (saved) {
    Object.assign(config, JSON.parse(saved));
  }
}

function saveConfig() {
  localStorage.setItem('voice-chat-config', JSON.stringify(config));
}
```

---

## File Structure

```
~/dev/voice-chat/
├── SPEC.md        # This document
├── index.html     # Complete app (~250 lines)
└── README.md      # Quick setup guide
```

---

## Implementation Plan

| Phase | Time | Tasks |
|-------|------|-------|
| **1. Shell** | 15 min | HTML/CSS, config prompt, status display |
| **2. Gateway** | 30 min | WebSocket connect, chat.send, streaming |
| **3. Audio In** | 45 min | VAD, Float32→WAV, Whisper API |
| **4. Audio Out** | 20 min | TTS API, iOS unlock, playback |
| **5. Polish** | 20 min | Error handling, stop/restart, edge cases |

**Total: ~2.5 hours**

---

## Expected Latency

| Step | Time |
|------|------|
| VAD detection | ~100ms |
| Whisper transcription | ~500-800ms |
| Gateway + Claude | ~1-2s |
| TTS generation | ~300-500ms |
| **Total** | **~2-3.5s** |

---

## Cost Estimate (per 5-min conversation)

| Service | Cost |
|---------|------|
| Whisper (gpt-4o-transcribe) | ~$0.03 |
| Claude (via gateway) | varies |
| TTS (gpt-4o-mini-tts) | ~$0.05 |
| **Total** | **~$0.10-0.20** |

---

## Error Handling

| Error | Recovery |
|-------|----------|
| Mic permission denied | Show setup instructions |
| Gateway disconnect | Auto-reconnect with backoff |
| Whisper timeout | Retry once, then show error |
| TTS failure | Show text response, skip audio |
| Empty transcript | Ignore, return to listening |

---

## Future Enhancements

1. **Interruption** - Stop TTS when user starts speaking
2. **Waveform visualization** - Visual feedback during recording
3. **Push-to-talk mode** - Alternative to continuous VAD
4. **Voice selection** - UI to pick TTS voice
5. **Transcript export** - Download conversation history

---

## Success Criteria

- [ ] Voice conversation works end-to-end
- [ ] Works on iPhone Safari over Tailscale
- [ ] Works on Mac Chrome/Safari
- [ ] Response latency < 4s
- [ ] Handles errors gracefully
- [ ] Code under 300 lines
