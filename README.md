# AI Transcriber

A self-contained, no-LiveKit, browser-based speech-to-text app.

The browser captures microphone audio, streams it as 16 kHz mono PCM to a tiny
Python WebSocket bridge, which forwards it to **AssemblyAI's Universal-Streaming
v3** API and pipes the live transcripts back to the React UI.

Only **one free API key** is needed: AssemblyAI.

```
Microphone (browser)
      │  getUserMedia + AudioWorklet
      │  → resample to 16 kHz, convert to PCM16 LE
      ▼
Browser WebSocket  ──────────►  Python bridge (ws://localhost:8001)
                                       │
                                       │  per-client session
                                       ▼
                          AssemblyAI Universal-Streaming v3
                            (wss://streaming.assemblyai.com/v3/ws)
                                       │
                                       │  Begin / Turn / Termination
                                       ▼
                                Python bridge
                                       │  {"type":"transcript","text":...,"final":bool}
                                       ▼
                                  React UI
```

The AssemblyAI API key never leaves the server.

## Folder structure

```
backend/
├── main.py                # entry point — loads .env and starts the bridge
├── websocket_server.py    # the bridge: browser <-> AssemblyAI v3
├── requirements.txt
└── .env.example

frontend/
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── public/
│   └── pcm-worklet.js     # AudioWorkletProcessor: PCM16 16 kHz mono
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css
    ├── components/
    │   └── TranscriptPanel.jsx
    └── hooks/
        ├── useMicrophone.js        # mic capture + resample
        └── useTranscriptSocket.js  # WS protocol + auto-reconnect
```

## Get the (free) API key

Sign up at <https://www.assemblyai.com/dashboard/signup>. The free tier
includes credits that work on the Universal-Streaming endpoint — no paid plan
required for development.

Copy the API key from the dashboard.

## Backend

### Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and paste your real ASSEMBLYAI_API_KEY
```

`.env` only needs:

```
ASSEMBLYAI_API_KEY=your_key
WS_HOST=0.0.0.0       # optional
WS_PORT=8001          # optional
```

### Run

```bash
cd backend
python main.py
```

You should see:

```
[INFO] websocket_server: transcriber WS server listening on ws://0.0.0.0:8001
```

### Wire protocol

Browser → server:
- Binary frames: 16-bit signed little-endian PCM, mono, 16 kHz.
- Control: `{"type":"start"}`, `{"type":"stop"}`.

Server → browser:
- `{"type":"status","status":"connected" | "ready" | "stopped"}`
- `{"type":"transcript","text":"...","final":true}` — finalized line, append.
- `{"type":"transcript","text":"...","final":false}` — interim turn, replace.
- `{"type":"error","message":"..."}`

Each `start` opens one AssemblyAI session for that browser; `stop` (or a
WebSocket close) tears it down so you don't keep burning credits.

## Frontend

### Setup & run

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>, click **Start Microphone**, allow mic access,
and start talking. Finalized lines append; the current in-progress turn is
shown italic-grayed at the bottom and is replaced as you speak.

To point the UI at a non-default backend host:

```bash
VITE_WS_URL=ws://my-host:8001 npm run dev
```

### Production build

```bash
cd frontend
npm run build
npm run preview
```

### Browser requirements

- `getUserMedia` requires **HTTPS or `localhost`**. `http://localhost:5173`
  works for local development; deploying behind plain HTTP will not.
- Modern Chromium / Firefox / Safari all support `AudioWorklet`.

## How it all fits together

1. You click **Start Microphone**.
2. The browser requests mic permission, opens an `AudioContext`, and loads
   `/pcm-worklet.js` as an AudioWorkletNode. The worklet downsamples each
   frame from the device rate (typically 48 kHz float32) to 16 kHz int16
   little-endian and posts ~50 ms chunks to the main thread.
3. The main thread sends each chunk as a binary frame over the existing
   WebSocket to the backend.
4. The backend opens a per-client session to AssemblyAI's Universal-Streaming
   v3 endpoint with your API key in the `Authorization` header, and forwards
   audio frames straight through.
5. AssemblyAI emits `Turn` events. The backend translates them:
   - in-progress turns → `{"type":"transcript","final":false}`
   - end-of-turn formatted → `{"type":"transcript","final":true}`
6. The React UI appends finalized lines to a list and shows the current
   in-progress turn underneath. The transcript panel auto-scrolls to the
   bottom on every change.
7. **Stop Microphone** stops the audio tracks, closes the worklet, and
   sends `{"type":"stop"}`, which makes the backend gracefully terminate the
   AssemblyAI session.

## Style

Dark theme, exactly as specified:

| Element            | Color       |
| ------------------ | ----------- |
| Background         | `#0f172a`   |
| Transcript panel   | `#1e293b`   |
| Text               | `#ffffff`   |

## Notes

- No LiveKit anywhere — backend or frontend.
- The frontend reconnects to the backend WebSocket every 3 seconds if the
  connection drops, and shows **Disconnected** until it's back.
- The backend prints a warning at startup if `ASSEMBLYAI_API_KEY` is not set,
  and propagates a clear error to the UI if a client tries to start without
  one.
- Audio is never written to disk; it streams straight through.
