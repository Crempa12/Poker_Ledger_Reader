// Small pieces the hand-log pages share: the console's dim explanation lines, its "Label  value"
// lines, the loader's notes, and what to show while the results are missing.
import type { HandLogs } from "../handlogs.ts";
import { href } from "../router.ts";

// How a game's hand log gets in. A read-only copy (a phone on the Wi-Fi, a snapshot) has no + Add game, so
// it only says where that is done.
export function AddLogHint({ canWrite }: { canWrite: boolean }) {
  if (!canWrite) return <>Hand logs are added on the computer that runs the site.</>;
  return (
    <>
      Download &quot;poker_now_log_&lt;id&gt;.csv&quot; from PokerNow, then open <a href={href("add")}>+ Add</a>: it finds the file in
      Downloads and files it with its game (or file it with the console app&apos;s menu 19).
    </>
  );
}

// The console's explanation under a table, one line each.
export function Legend({ lines }: { lines: string[] }) {
  return (
    <div className="legend muted small">
      {lines.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </div>
  );
}

// "Label  value" lines, like the console's indented lines. An empty label continues the line above.
export function Lines({ rows }: { rows: [string, string][] }) {
  return (
    <div className="lines">
      {rows.map(([label, value], i) => (
        <div className="kv" key={i}>
          <span className="k">{label}</span>
          <span className="v">{value}</span>
        </div>
      ))}
    </div>
  );
}

// The loader's messages (skipped files, duplicate logs), folded away so they do not crowd the page.
export function Notes({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <details className="notes">
      <summary>{`Notes from the hand logs (${messages.length})`}</summary>
      <ul className="plain">
        {messages.map((m, i) => (
          <li key={i} className="small">
            {m}
          </li>
        ))}
      </ul>
    </details>
  );
}

// What to show in place of the results while they are missing: the wait, the reason, or a retry.
// compact: a line of text for a card that holds other things too.
export function HandStatus({ hand, compact = false }: { hand: HandLogs; compact?: boolean }) {
  if (hand.status === "ready") return null;
  const body =
    hand.status === "loading"
      ? "Reading the hand logs for this scope…"
      : hand.status === "error"
        ? `Could not read the hand logs: ${hand.message ?? "unknown problem"}`
        : (hand.message ?? "The hand-log results are not available for this scope.");
  if (compact) {
    return (
      <p className="muted">
        {body}
        {hand.retry !== undefined ? (
          <>
            {" "}
            <button className="link" onClick={hand.retry}>
              Try again
            </button>
          </>
        ) : null}
      </p>
    );
  }
  return (
    <div className="card pad">
      <p className={hand.status === "loading" ? "muted" : ""}>{body}</p>
      {hand.retry !== undefined ? (
        <button className="ghost" onClick={hand.retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
