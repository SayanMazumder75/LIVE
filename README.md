# AI Transcriber

A minimal speech-to-text web app powered by an existing LiveKit + AssemblyAI
worker on the backend, and a custom React + Vite + Tailwind UI on the frontend.

The frontend does **not** use any LiveKit SDK or LiveKit React components — it
talks to the backend over a plain WebSocket and only renders the live
transcript.

```
Microphone Audio
      ↓
LiveKit Worker
      ↓
AssemblyAI STT
      ↓
Transcript
      ↓
WebSocket Broadcast (port 8001)
      ↓
React UI (Vite, port 5173)
```

## Folder structure

```
backend/
├── main.py                 # LiveKit worker (unchanged transcription logic)
├── websocket_server.py     # WebSocket broadcaster on port 8001
├── requirements.txt
└── .env.example

frontend/
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── index.html
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css
    ├── components/
    │   └── TranscriptPanel.jsx
    └── hooks/
        └── useTranscriptSocket.js
```

## Backend

The backend keeps the original LiveKit worker intact. Inside
`on_user_turn_completed`, immediately after

```python
user_transcript = new_message.text_content
```

it broadcasts the line to every connected frontend client:

```python
await broadcast_transcript(user_transcript)
```

`raise StopResponse()` is preserved as before.

The broadcaster (`websocket_server.py`) runs an `asyncio` WebSocket server in a
dedicated background thread on **port 8001**, so it coexists peacefully with
the LiveKit worker's own event loop. Connections that drop are pruned
automatically; messages are sent as JSON:

```json
{ "type": "transcript", "text": "Today we will discuss the project" }
```

### Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # then fill in your real credentials
```

Required env vars (in `.env`):

- `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- `ASSEMBLYAI_API_KEY`

### Run

```bash
cd backend
python main.py dev
```

This starts the WebSocket broadcast server on `ws://localhost:8001` and then
runs the LiveKit worker (the standard `livekit-agents` CLI subcommands like
`dev`, `start`, `connect`, etc. all work).

## Frontend

A minimal React + Vite + Tailwind UI:

- Connects to `ws://localhost:8001` (override with `VITE_WS_URL` if needed).
- Shows connection status: **Connected** / **Disconnected**.
- Appends every incoming transcript to a list and auto-scrolls the panel to
  the bottom.
- Reconnects automatically every 3 seconds if the WebSocket closes.
- Dark theme: background `#0f172a`, transcript panel `#1e293b`, text
  `#ffffff`.

### Setup & run

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173.

To point the UI at a non-default backend host:

```bash
VITE_WS_URL=ws://my-host:8001 npm run dev
```

### Production build

```bash
cd frontend
npm run build
npm run preview        # optional: serve dist/ locally
```

## Putting it all together

In three separate terminals (only the first two are services; the third
is your audio source):

1. **Backend worker + WebSocket broadcaster**

   ```bash
   cd backend && python main.py dev
   ```

2. **Frontend UI**

   ```bash
   cd frontend && npm run dev
   ```

3. **Anything that publishes a microphone track into your LiveKit room**
   (LiveKit Meet, Sandbox, your own publisher, etc.). As soon as a participant
   speaks, AssemblyAI transcripts flow through the worker and into the UI.

## Notes

- The WebSocket server listens on `0.0.0.0:8001` so other devices on your
  network can connect during development.
- The UI never imports any LiveKit SDK; it only reads JSON messages from the
  broadcast server.
- Multiple browser tabs can be open simultaneously — each one receives every
  transcript.
