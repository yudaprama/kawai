import { type FormEvent, useRef, useState } from "react";
import { call } from "./lib/api";
import { type StreamController, streamOperation } from "./lib/stream";
import { type ActivityEvent, type ActivityInput } from "./types/events";

export default function App() {
  const [name, setName] = useState("");
  const [greetMsg, setGreetMsg] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [log, setLog] = useState<string[]>([]);
  const streamRef = useRef<StreamController | null>(null);

  async function onGreet(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const msg = await call<string>("greet", { name });
    setGreetMsg(msg);
  }

  function startStream() {
    setLog([]);
    setProgress(null);
    const input: ActivityInput = { events: 10, intervalMs: 500 };
    streamRef.current = streamOperation<ActivityEvent>(
      "generate_activity",
      input as unknown as Record<string, unknown>,
      {
        onEvent: (ev) => {
          if (ev.type === "started") {
            setProgress({ done: 0, total: ev.total });
          } else if (ev.type === "progress") {
            setProgress({ done: ev.done, total: ev.total });
            setLog((l) => [...l, `event ${ev.done}/${ev.total}`]);
          }
        },
        onDone: () => setLog((l) => [...l, "✅ finished"]),
        onError: (err) => setLog((l) => [...l, `❌ ${err.message}`]),
      },
    );
  }

  function stopStream() {
    streamRef.current?.cancel();
    streamRef.current = null;
  }

  return (
    <main className="container mx-auto max-w-2xl space-y-8 p-8">
      <h1 className="text-2xl font-bold">Kawai</h1>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">RPC (request-response)</h2>
        <form className="flex gap-2" onSubmit={onGreet}>
          <input
            className="input input-bordered flex-1"
            placeholder="Enter a name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn btn-primary" type="submit">
            Greet
          </button>
        </form>
        {greetMsg && <p className="text-sm">{greetMsg}</p>}
      </section>

      <hr />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Streaming</h2>
        <div className="flex gap-2">
          <button className="btn btn-primary" onClick={startStream}>
            Start stream
          </button>
          <button className="btn btn-ghost" onClick={stopStream}>
            Stop
          </button>
        </div>
        {progress && (
          <progress
            className="progress progress-primary w-full"
            max={progress.total}
            value={progress.done}
          />
        )}
        <ul className="font-mono text-xs">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
