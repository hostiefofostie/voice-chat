# Parakeet Transcription Server

Local speech-to-text API using NVIDIA Parakeet on Apple Silicon.

## Quick Start

```bash
# Install dependencies
pip install -r requirements.txt

# Run server (binds to all interfaces for Tailscale access)
python server.py

# Or preload model on startup (slower start, faster first request)
python server.py --preload
```

Server runs on `http://0.0.0.0:8765` by default.

## API

### POST /transcribe

Upload audio file, get transcription.

```bash
curl -X POST http://localhost:8765/transcribe \
  -F "audio=@recording.webm"
```

Response:
```json
{
  "text": "Hello, this is a test.",
  "segments": [
    {"start": 0.0, "end": 1.5, "text": "Hello, this is a test."}
  ]
}
```

### GET /health

```bash
curl http://localhost:8765/health
```

## Access Over Tailscale

1. Run server on your MacBook
2. Get your Tailscale IP: `tailscale ip -4`
3. Access from any device: `http://<tailscale-ip>:8765`

## Supported Audio Formats

WAV, MP3, WebM, OGG, FLAC, M4A

## Performance

- First request: ~10s (model loading)
- Subsequent: ~100-200ms for short clips
- Model: parakeet-tdt-0.6b-v3 (600M params)
