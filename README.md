# AI Transcriber

A self-contained, no-LiveKit, browser-based speech-to-text app **with optional Hindi → English translation**.

The browser captures microphone audio, streams it as 16 kHz mono PCM to a tiny
Python WebSocket bridge, which forwards it to **AssemblyAI's Universal-Streaming
v3** API and pipes the live transcripts back to the React UI. Each finalized
caption is also (optionally) sent to **Google's Gemini API** for Hindi → English
translation, which is rendered underneath the original line.

Two **free API keys** are needed for the full experience: AssemblyAI (required)
and Gemini (optional — leave it blank to disable translation).

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
                                Python bridge ──► Gemini (per finalized line)
                                       │   {"type":"transcript","text":...,"final":bool,"id":...}
                                       │   {"type":"translation","id":...,"text":...}
                                       ▼
                                  React UI
```

Both API keys never leave the server.

## Folder structure

```
backend/
├── main.py                # entry point — loads .env and starts the bridge
├── websocket_server.py    # the bridge: browser <-> AssemblyAI v3
├── translator.py          # optional Hindi -> English via Gemini (isolated)
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

## Get the (free) API keys

**AssemblyAI (required)** — sign up at
<https://www.assemblyai.com/dashboard/signup>. The free tier includes
credits that work on the Universal-Streaming endpoint.

**Gemini (optional, for Hindi → English translation)** — get a free key at
<https://aistudio.google.com/app/apikey>. The default model
(`gemini-2.5-flash-lite`) gives 15 requests/minute and 1000 requests/day on
the free tier — plenty for an interactive transcriber. Leave `GEMINI_API_KEY`
blank in `.env` to disable translation entirely.

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

`.env` minimally needs:

```
ASSEMBLYAI_API_KEY=your_assemblyai_key
GEMINI_API_KEY=                      # optional: enables Hindi -> English translation
GEMINI_MODEL=                        # optional: defaults to gemini-2.5-flash-lite
WS_HOST=0.0.0.0                      # optional
WS_PORT=8001                         # optional
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
- `{"type":"transcript","text":"...","final":true,"id":"..."}` — finalized line; append. The `id` is a short hex string the server generates so a later translation can attach to it.
- `{"type":"transcript","text":"...","final":false}` — interim turn; replace.
- `{"type":"translation","id":"<final-id>","text":"...","source_text":"..."}` — Gemini translation of a previously-sent finalized line. UI attaches it to the matching final by `id`. Only sent when `GEMINI_API_KEY` is configured **and** the translation actually differs from the original (English-only finals don't generate translation frames).
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
   - end-of-turn formatted → `{"type":"transcript","final":true,"id":...}`
6. **(Optional)** If `GEMINI_API_KEY` is set, every finalized line also
   triggers a fire-and-forget background task that calls Gemini, asks it to
   translate Hindi to English (and leave English alone), and — if the
   result differs from the original — sends back a separate
   `{"type":"translation","id":...}` frame. The UI attaches it to the
   matching line and renders it in muted green underneath.
7. The React UI appends finalized lines to a list and shows the current
   in-progress turn underneath. The transcript panel auto-scrolls to the
   bottom on every change.
8. **Stop Microphone** stops the audio tracks, closes the worklet, and
   sends `{"type":"stop"}`, which makes the backend gracefully terminate the
   AssemblyAI session and drain any pending translation tasks.

## Style

Dark theme, exactly as specified:

| Element            | Color       |
| ------------------ | ----------- |
| Background         | `#0f172a`   |
| Transcript panel   | `#1e293b`   |
| Text               | `#ffffff`   |

## Notes

- No LiveKit anywhere — backend or frontend.
- Translation is **fully isolated** in `backend/translator.py`. Removing
  `GEMINI_API_KEY` (or removing the file entirely) leaves the rest of the
  app untouched and working.
- The frontend reconnects to the backend WebSocket every 3 seconds if the
  connection drops, and shows **Disconnected** until it's back.
- The backend prints a warning at startup if `ASSEMBLYAI_API_KEY` is not set,
  and propagates a clear error to the UI if a client tries to start without
  one.
- Audio is never written to disk; it streams straight through.
