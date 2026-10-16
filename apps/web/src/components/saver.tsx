import { useState, type ReactNode } from "react";

import type { Ctx } from "../context.ts";
import { errorText, writeSaved, type SavedFile } from "../saved.ts";

export interface Saver {
  busy: boolean;
  run: (file: SavedFile, text: string, done: string) => Promise<boolean>;
  shown: ReactNode; // the outcome of the last save, or null
}

// One Saved_Data save at a time, with the outcome to show under the card. run says
// whether the file was written; the page reloads the data after a write.
export function useSaver(ctx: Ctx, onSaved: () => void): Saver {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (file: SavedFile, text: string, done: string): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      await writeSaved(ctx, file, text);
      setNote({ ok: true, text: done });
      onSaved();
      return true;
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const shown = note === null ? null : <p className={note.ok ? "up small" : "down small"}>{note.text}</p>;
  return { busy, run, shown };
}
