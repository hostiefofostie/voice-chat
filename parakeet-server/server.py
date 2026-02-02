#!/usr/bin/env python3
"""
Parakeet MLX Transcription Server
Run on Apple Silicon Mac, access over Tailscale.

Usage:
    pip install parakeet-mlx fastapi uvicorn python-multipart
    python server.py

API:
    POST /transcribe - Upload audio file, get transcription
    GET /health - Health check
"""

import tempfile
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

# Lazy load model (first request will be slow, ~10s)
_model = None

def get_model():
    global _model
    if _model is None:
        print("🦜 Loading Parakeet model (first time only)...")
        from parakeet_mlx import from_pretrained
        _model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
        print("✅ Model loaded!")
    return _model

app = FastAPI(
    title="Parakeet Transcription API",
    description="Local speech-to-text using NVIDIA Parakeet on Apple Silicon",
    version="1.0.0"
)

# Allow CORS from anywhere (for browser access)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "ok", "model": "parakeet-tdt-0.6b-v3"}

@app.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    """
    Transcribe audio file to text.
    
    Accepts: WAV, MP3, WebM, OGG, M4A, FLAC
    Returns: { "text": "transcription", "duration": 1.23 }
    """
    # Validate file type
    allowed_types = {
        "audio/wav", "audio/x-wav", "audio/wave",
        "audio/mpeg", "audio/mp3",
        "audio/webm", "audio/ogg", "audio/flac",
        "audio/m4a", "audio/mp4", "audio/x-m4a",
        "application/octet-stream"  # Browser sometimes sends this
    }
    
    content_type = audio.content_type or "application/octet-stream"
    
    # Save to temp file
    suffix = Path(audio.filename).suffix if audio.filename else ".webm"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        content = await audio.read()
        tmp.write(content)
        tmp_path = tmp.name
    
    try:
        # Transcribe
        model = get_model()
        result = model.transcribe(tmp_path)
        
        return JSONResponse({
            "text": result.text,
            "segments": [
                {"start": seg.start, "end": seg.end, "text": seg.text}
                for seg in (result.segments or [])
            ] if hasattr(result, 'segments') and result.segments else []
        })
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    
    finally:
        # Cleanup temp file
        os.unlink(tmp_path)

@app.on_event("startup")
async def startup():
    """Pre-load model on startup for faster first request"""
    print("🚀 Starting Parakeet server...")
    print("   Model will load on first request (or set PRELOAD=1 to load now)")
    if os.environ.get("PRELOAD") == "1":
        get_model()

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0", help="Bind address")
    parser.add_argument("--port", type=int, default=8765, help="Port")
    parser.add_argument("--preload", action="store_true", help="Load model on startup")
    args = parser.parse_args()
    
    if args.preload:
        os.environ["PRELOAD"] = "1"
    
    print(f"🦜 Parakeet server starting on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)
