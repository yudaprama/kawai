// Shared event/input types mirroring the Rust enums in src-tauri/src/logic.rs.
// Keep these in sync with the backend `#[serde(tag = "type")]` definitions.

export interface ActivityInput {
  events: number;
  intervalMs: number;
}

export type ActivityEvent =
  | { type: "started"; total: number }
  | { type: "progress"; done: number; total: number }
  | { type: "finished" }
  | { type: "error"; message: string };

// Notes DB demo — mirrors src-tauri/src/logic.rs Note / NoteEvent.

export interface Note {
  id: number;
  body: string;
  createdAt: number;
}

export type NoteEvent =
  | { type: "notes"; notes: Note[] }
  | { type: "finished" }
  | { type: "error"; message: string };
