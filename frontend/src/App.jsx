import TranscriptPanel from "./components/TranscriptPanel.jsx";
import { useTranscriptSocket } from "./hooks/useTranscriptSocket.js";

const WS_URL = import.meta.env.VITE_WS_URL || "ws://localhost:8001";

export default function App() {
  const { status, transcripts } = useTranscriptSocket(WS_URL);
  const isConnected = status === "connected";

  return (
    <div
      className="min-h-screen w-full flex flex-col"
      style={{ backgroundColor: "#0f172a", color: "#ffffff" }}
    >
      <header className="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">
          AI Transcriber
        </h1>
        <div className="flex items-center gap-2 text-sm">
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-2.5 rounded-full ${
              isConnected ? "bg-emerald-500" : "bg-red-500"
            }`}
          />
          <span className="text-slate-200">
            Status:{" "}
            <span className={isConnected ? "text-emerald-400" : "text-red-400"}>
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </span>
        </div>
      </header>

      <main className="flex-1 min-h-0 p-6 flex flex-col">
        <h2 className="text-lg font-medium mb-3 text-slate-300">
          Live Transcript
        </h2>
        <div className="flex-1 min-h-0">
          <TranscriptPanel transcripts={transcripts} />
        </div>
      </main>
    </div>
  );
}
