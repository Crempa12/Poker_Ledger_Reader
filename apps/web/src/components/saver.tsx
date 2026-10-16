import { useState, type ReactNode } from "react";

import type { Ctx } from "../context.ts";
import { errorText, writeSaved, type SavedFile } from "../saved.ts";

export interface Saver {
  busy: boolean;
  run: (file: SavedFile, text: string, done: string) => Promise<boolean>;
  shown: ReactNode; // the outcome of the last save (an empty live region until there is one)
  said: boolean; // whether there is an outcome to show yet
}

// One Saved_Data save at a time, with the outcome to show under the card. run says
// whether the file was written; the page reloads the data after a write, and the buttons stay busy until
// that reload is in (a second save sent with the data from before the first would be refused as stale).
export function useSaver(ctx: Ctx, onSaved: () => void | Promise<void>): Saver {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (file: SavedFile, text: string, done: string): Promise<boolean> => {
    setBusy(true);
    setNote(null);
    try {
      // false: the person said no to the question writeSaved asks, so nothing was written.
      if (!(await writeSaved(ctx, file, text))) return false;
      setNote({ ok: true, text: done });
      await onSaved();
      return true;
    } catch (err) {
      setNote({ ok: false, text: errorText(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  // The status region is on the page before the outcome is written into it, so a screen reader reads it out.
  const shown = (
    <>
      <div role="status">{note !== null && note.ok ? <p className="up small">{note.text}</p> : null}</div>
      {note !== null && !note.ok ? (
        <p className="down small" role="alert">
          {note.text}
        </p>
      ) : null}
    </>
  );
  return { busy, run, shown, said: note !== null };
}
