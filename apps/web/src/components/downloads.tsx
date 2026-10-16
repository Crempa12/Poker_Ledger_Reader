// The CSV files the console app writes for these menus, as downloads. The text is the core's, byte for
// byte (the same texts the console writes), and the names are the console's file names.
import type { HandExports } from "@plr/core";

// Each file, its name in Saved_Data, and the export it comes from (null = the console would not write it).
export const EXPORT_FILES: { name: string; text: (e: HandExports) => string | null }[] = [
  { name: "style_stats.csv", text: (e) => e.styleStats },
  { name: "playstyle.csv", text: (e) => e.playstyle },
  { name: "hit_and_run.csv", text: (e) => e.hitAndRun },
  { name: "hit_and_run_nights.csv", text: (e) => e.hitAndRunNights },
  { name: "player_summary.csv", text: (e) => e.playerSummary },
  { name: "showdown_rivals.csv", text: (e) => e.showdownRivals },
];

// The files this scope has: a file the console would not write is left out.
export function downloadsFor(exports: HandExports): { name: string; text: string }[] {
  return EXPORT_FILES.flatMap(({ name, text }) => {
    const body = text(exports);
    return body === null ? [] : [{ name, text: body }];
  });
}

// Saves text as a file the browser downloads. Runs only on a click.
export function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The download buttons for a scope's files.
export function Downloads({ exports }: { exports: HandExports }) {
  const files = downloadsFor(exports);
  if (files.length === 0) return null;
  return (
    <section className="card">
      <h2>Downloads</h2>
      <p className="muted small">The same files the console app saves (menus 12, 18, 21 and 22), for the scope on screen.</p>
      <div className="choices">
        {files.map((f) => (
          <button key={f.name} className="ghost" onClick={() => saveText(f.name, f.text)}>
            {f.name}
          </button>
        ))}
      </div>
    </section>
  );
}
