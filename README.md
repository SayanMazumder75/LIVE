# AI Transcriber

A self-contained, no-LiveKit, browser-based **live transcription** app with
optional **Hindi → English translation** and **system-audio capture** for
things like YouTube videos and Google Meet calls.

Pick a **language** (English / Hindi) and an **audio source** (Microphone /
System Audio), click Start, and watch transcripts stream in. Hindi lines get
an English translation rendered underneath.

```
        Microphone   ─┐                            ┌─►  AssemblyAI v3 (English STT)
                      ├─► AudioWorklet ─► WS ──────┤
        System Audio ─┘    PCM16 16 kHz            └─►  (transcripts back to UI)

        (Hindi mode)
        Microphone ─► browser Web Speech API (hi-IN) ─► local final + WS "translate"
                                                                  │
                                                                  ▼
                                                              Groq Llama 3.3
                                                              Hindi → English
                                                                  │
                                                                  ▼
                                                            English under each line
```

API keys never leave the server.

## Free API keys you'll need

| Provider     | Used for                                | Free tier (2026) |
|--------------|-----------------------------------------|------------------|
| AssemblyAI   | English speech → text (mic & system)    | Streaming credits, no card |
| Groq         | Hindi text → English translation        | ~30 RPM, ~14,400 req/day |

- **AssemblyAI**: <https://www.assemblyai.com/dashboard/signup>
- **Groq**: <https://console.groq.com/keys>

Each key has exactly one job. AssemblyAI never sees your Hindi text; Groq
never sees your English audio. Leave `GROQ_API_KEY` blank to disable
translation entirely (English mode keeps working).

## Folder structure

```
backend/
├── main.py                # entry point — loads .env, starts the bridge
├── websocket_server.py    # the bridge: browser <-> AssemblyAI v3
├── translator.py          # Hindi -> English via Groq (isolated)
├── requirements.txt
└── .env.example

frontend/
├── package.json
├── vite.config.js
├── tailwind.config.js
├── postcss.config.js
├── index.html
├── public/
│   └── pcm-worklet.js          # AudioWorkletProcessor: PCM16 16 kHz mono
└── src/
    ├── main.jsx
    ├── App.jsx
    ├── index.css
    ├── components/
    │   └── TranscriptPanel.jsx
    └── hooks/
        ├── useMicrophone.js        # mic capture (getUserMedia)
        ├── useSystemAudio.js       # system / tab audio (getDisplayMedia)
        ├── useSpeechRecognition.js # browser Web Speech API for Hindi
        └── useTranscriptSocket.js  # WS protocol + auto-reconnect
```

## Backend

### Setup

```bash
cd backend
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
# edit .env and paste your real keys
```

`.env`:

```ini
ASSEMBLYAI_API_KEY=your_assemblyai_key
GROQ_API_KEY=                        # optional: enables Hindi -> English translation
GROQ_MODEL=                          # optional: defaults to llama-3.3-70b-versatile
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
[INFO] translator: translator enabled (provider=groq, model=llama-3.3-70b-versatile)
```

### Wire protocol

Browser → server:
- Binary frames: 16-bit signed little-endian PCM, mono, 16 kHz.
- `{"type":"start"}` — open an AssemblyAI session (English mode only).
- `{"type":"stop"}` — close the AAI session.
- `{"type":"translate","id":"<id>","text":"<hindi text>"}` — Hindi mode only;
  the browser already did the speech-to-text and just wants the Hindi → English
  step.

Server → browser:
- `{"type":"status","status":"connected" | "ready" | "stopped"}`
- `{"type":"transcript","text":"...","final":true,"id":"..."}` — finalized line.
- `{"type":"transcript","text":"...","final":false}` — interim turn.
- `{"type":"translation","id":"<final-id>","text":"...","source_text":"..."}` —
  Groq's English translation, keyed to the line's `id`.
- `{"type":"error","message":"..."}` — surfaced to the UI as a banner. The
  most common one is Groq returning HTTP 429 (rate limit).

The `id` lets a later translation frame attach to the right line in the UI
even though they arrive over time.

## Frontend

### Setup & run

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. You'll see two dropdowns in the header:
**Language** and **Source**.

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

### Modes

There are three useful combinations:

| Language | Source        | What happens                                           |
|----------|---------------|--------------------------------------------------------|
| English  | Microphone    | Mic → AssemblyAI → live English transcripts            |
| English  | System Audio  | Tab/screen audio → AssemblyAI → live English transcripts |
| Hindi    | Microphone    | Mic → browser Web Speech API → Hindi line + Groq translation |

Hindi + System Audio is intentionally disabled: the browser's Hindi speech
recognizer only listens to the microphone, there's no API to feed it an
arbitrary stream. The **Source** dropdown shows the option grayed out with
*(English only)* in Hindi mode.

### Using System Audio (YouTube, Google Meet, …)

1. Pick **English** as the language and **System Audio** as the source.
2. Click **Start System Audio**.
3. In the browser's share picker:
   - Choose **a Tab** (best for YouTube, Meet) or **Entire Screen**.
   - **Tick "Share tab audio"** (or **"Share system audio"** for full screen).
   - **Window** mode has no audio — picking a window will fail with a
     friendly error.
4. Transcripts start streaming. To stop, either click **Stop System Audio**
   in the app, or click the browser's persistent "Stop sharing" indicator
   at the top of the page — both flip the UI back to idle.

The video track is captured to satisfy the `getDisplayMedia` spec but is
discarded immediately, so no video is recorded or sent anywhere.

### Browser requirements

- `getUserMedia` (microphone) and `getDisplayMedia` (system audio) both
  require **HTTPS or `localhost`**.
- **System Audio** works best in **Chrome / Edge** on a desktop OS. Firefox
  has limited support; Safari mostly doesn't support it.
- **Hindi mode** requires the Web Speech API. **Chrome / Edge** support it
  with `hi-IN` natively; Firefox doesn't expose continuous recognition.
- **Floating Mic Widget** (Document Picture-in-Picture) requires
  **Chrome 116+ / Edge 116+**. The widget pops the mic controls into a
  small always-on-top window so they stay visible while you watch a
  video or attend a meeting in another tab.

### Embedding inside MeetMind (or any host page)

The AI Transcriber works fine when embedded in an `<iframe>`, with one
caveat: **Document Picture-in-Picture cannot be opened from inside an
iframe.** Chrome only allows `documentPictureInPicture.requestWindow()`
from a top-level browsing context, so the floating mic widget would
silently fail if it tried to open itself from the iframe.

The fix is split across two parts:

1. **Inside the iframe** (this app), `FloatingMicWidget.jsx` detects
   that it's embedded and delegates to the parent via `postMessage`
   instead of calling `requestWindow()` directly.

2. **On the parent page** (e.g. MeetMind), include the drop-in host
   script that ships with this project:

   ```html
   <iframe
     src="https://ai-transcriber.example.com/"
     allow="microphone; display-capture; picture-in-picture; clipboard-write"
   ></iframe>

   <!-- Optional: lock down which iframe origins can drive PiP. -->
   <script>
     window.MeetMindAITranscriberPiPConfig = {
       allowedOrigins: ["https://ai-transcriber.example.com"],
     };
   </script>
   <script src="https://ai-transcriber.example.com/meetmind-pip-host.js"></script>
   ```

   The host script is shipped from this repo at
   `frontend/public/meetmind-pip-host.js` (so the production build
   serves it at `/meetmind-pip-host.js`). It owns the call to
   `documentPictureInPicture.requestWindow()`, paints a small widget
   UI inside the new window, and proxies mic toggle / close events
   back to the iframe so the audio pipeline keeps running there.

   The script also exposes a tiny runtime API on
   `window.MeetMindAITranscriberPiP` for the host page:

   - `apiSupported` — boolean, true if the browser supports the API
   - `hasActive()` — boolean, true while a PiP window is open
   - `closeActive()` — programmatically close the active PiP window
   - `setAllowedOrigins([...])` — update the allow-list at runtime

3. **If the host page does NOT include the host script**, the
   floating-mic-widget button in the iframe stays disabled and shows a
   tooltip explaining that PiP is unavailable in embedded mode. Users
   can still open AI Transcriber in its own tab to use the widget.

The wire protocol between the iframe and the host script is documented
in the JSDoc at the top of
[`frontend/src/components/FloatingMicWidget.jsx`](frontend/src/components/FloatingMicWidget.jsx)
and
[`frontend/public/meetmind-pip-host.js`](frontend/public/meetmind-pip-host.js).
To target a known parent origin from the iframe (recommended in
production), set `VITE_PARENT_ORIGIN=https://meetmind.example.com`
before `npm run build`.

Required iframe `allow` attribute, in full:

| Permission        | Why                                                |
| ----------------- | -------------------------------------------------- |
| `microphone`      | mic capture inside the iframe                      |
| `display-capture` | tab/system audio via `getDisplayMedia`             |
| `picture-in-picture` | propagates user activation for the parent's PiP open |
| `clipboard-write` | optional, for "Copy transcript" if you add it later |

## How a session flows

1. The page loads and opens a WebSocket to the backend → status flips to
   **Connected**.
2. You pick Language and Source, then click **Start**.

   - **English + Microphone**: browser asks for mic permission → AudioContext
     at 16 kHz → AudioWorklet emits PCM16 chunks → WS sends `{type:"start"}`,
     server opens an AssemblyAI session, server forwards audio chunks → AAI
     replies with `Begin` → `Turn` (interim & final) → `Termination`.
   - **English + System Audio**: browser shows the share picker → if the
     user cancels, **no AAI session is opened** (no quota wasted) → if they
     pick a Tab/Screen with audio, the rest is identical to the mic flow.
   - **Hindi + Microphone**: browser asks for mic permission → Web Speech
     API streams interim and final results in `hi-IN` → each Hindi final is
     appended to the UI immediately and shipped to the server with
     `{type:"translate"}` → server calls Groq → server returns
     `{type:"translation", id, text}` → UI attaches the English under the
     matching line.

3. The **Live Transcript** panel auto-scrolls. Finals stay on screen; the
   current in-progress turn is shown italic-greyed at the bottom and is
   replaced as you speak.

4. **Stop** releases the audio source, sends `{"type":"stop"}` (or the
   stream end fires automatically when you hit the browser's Stop sharing
   indicator), and the AAI session is gracefully terminated server-side.

## Style

Dark theme, exactly as originally specified:

| Element            | Color       |
| ------------------ | ----------- |
| Background         | `#0f172a`   |
| Transcript panel   | `#1e293b`   |
| Text               | `#ffffff`   |

## Notes

- **No LiveKit anywhere** — backend or frontend.
- **Translation is isolated** in `backend/translator.py`. Removing
  `GROQ_API_KEY` from `.env` (or deleting the file entirely) leaves the
  rest of the app untouched and working — English transcription still runs.
- **AssemblyAI is never called for Hindi text**, and **Groq is never called
  for English audio**. Each provider does exactly one thing and no quota
  is wasted on round-trips that produce no UI change.
- Audio is **never written to disk**; it streams straight through.
- The frontend reconnects to the backend WebSocket every 3 seconds if the
  connection drops, and shows **Disconnected** until it's back. Hindi mode
  is independent of the WS — recognition keeps working locally; only the
  translation step pauses until the WS comes back.
- The backend prints a warning at startup if `ASSEMBLYAI_API_KEY` is not
  set, and propagates a clear error frame to the UI if a client tries to
  start without one. Same goes for `GROQ_API_KEY` when a Hindi translation
  is requested.

## If translations stop appearing under Hindi lines

Most often, you've hit Groq's free-tier rate limit. The UI shows a banner
like *"Translation: Groq rate limit reached…"*. Options:

- Wait a minute (the per-minute window resets quickly).
- Set `GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct` or another
  free-tier-eligible model in `.env`.
- Generate a fresh Groq key.

Hindi recognition itself doesn't go through Groq, so transcripts keep
flowing in Devanagari even when translations are paused — only the English
under each line is missing.
