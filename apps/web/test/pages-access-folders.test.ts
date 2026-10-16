// The Add game page with no Games folder, the page names, the labels screen readers hear, the colour
// pairs in styles.css, and the words in the README and the starter. Rendered with react-dom/server from
// made-up data (no browser).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ledger, loadWorld, type World } from "../../../packages/core/src/index.ts";
import { loadDataRoot } from "../../../tools/load.ts";
import { buildCtx, type Ctx } from "../src/context.ts";
import { EVERYTHING, type Payload } from "../src/data.ts";
import { LineChart, Sparkbars } from "../src/components/charts.tsx";
import { pageName } from "../src/App.tsx";
import { AddGame, FolderPicker, savedLabel } from "../src/pages/AddGame.tsx";
import { Settle } from "../src/pages/Settle.tsx";

const TZ = "America/New_York";
const SYNTHETIC = fileURLToPath(new URL("../../../fixtures/synthetic/", import.meta.url));
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

// The page context for the made-up data; gamesFolder is what the server says (absent: not said).
async function pageCtx(gamesFolder?: boolean): Promise<Ctx> {
  const data = await loadDataRoot(SYNTHETIC);
  const ledgers = data.games.filter((g) => ledger.looksLikeLedger(g.text));
  const world: World = loadWorld({ timeZone: TZ, ledgers, saved: data.savedData });
  const payload: Payload = {
    source: "local",
    dataRoot: "fixtures/synthetic",
    timeZone: TZ,
    loadedAt: 0,
    ledgers,
    logs: [],
    saved: data.savedData,
    canWrite: true,
    consoleOpen: 0,
    basis: "made-up",
    ...(gamesFolder === undefined ? {} : { gamesFolder }),
  };
  return buildCtx(payload, world, EVERYTHING);
}

describe("Add game with no Games folder", () => {
  it("starts the folder in typing mode when there are no folders, and offers no pick-existing link", () => {
    const out = renderToStaticMarkup(createElement(FolderPicker, { folders: [], value: "", onChange: () => undefined, disabled: false }));
    expect(out).toContain("<input");
    expect(out).not.toContain("<select");
    expect(out).not.toContain("pick existing");
  });

  it("lists the folders and keeps the pick-existing link when there are some", () => {
    const out = renderToStaticMarkup(
      createElement(FolderPicker, { folders: ["Nov"], value: "Nov", onChange: () => undefined, disabled: false }),
    );
    expect(out).toContain("<select");
    expect(out).toContain("New folder…");
  });

  it("names the saved folder by the data's real place: under Games only when there is a Games folder", () => {
    expect(savedLabel("Nov", true)).toBe("Games/Nov");
    expect(savedLabel("Nov", false)).toBe("Nov");
    expect(savedLabel("", true)).toBe("a folder");
    expect(savedLabel("  ", false)).toBe("a folder");
  });

  it("says where a game goes, from the data's Games folder", async () => {
    const without = renderToStaticMarkup(createElement(AddGame, { ctx: await pageCtx(false), onSaved: () => undefined }));
    expect(without).toContain("there is no <code>Games</code> folder yet");
    expect(without).not.toContain("menu 19 puts it");
    const withFolder = renderToStaticMarkup(createElement(AddGame, { ctx: await pageCtx(true), onSaved: () => undefined }));
    expect(withFolder).toContain("menu 19 puts it");
  });

  it("no longer tells people to commit game files to git", () => {
    expect(read("../src/pages/AddGame.tsx")).not.toContain("Commit the new files");
    expect(read("../../../README.md")).not.toContain("Commit the new files");
    expect(read("../../../README.md")).toMatch(/keep them\s+out of git/);
    expect(read("../src/pages/AddGame.tsx")).toContain("keep them out of git");
  });
});

describe("the README and the starter say what to install", () => {
  it("installs before the terminal start", () => {
    expect(read("../../../README.md")).toMatch(/npm install\nnpm run web/);
  });

  it("the macOS starter checks for npm and says what to install", () => {
    const starter = read("../../../Start Poker Ledger.command");
    expect(starter).toContain("command -v npm");
    expect(starter).toContain("https://nodejs.org");
  });
});

describe("the page names", () => {
  it("names each page as the tab bar does", () => {
    expect(pageName([])).toBe("Standings");
    expect(pageName(["games"])).toBe("Nights");
    expect(pageName(["more"])).toBe("More");
    expect(pageName(["settle"])).toBe("Settle up");
    expect(pageName(["owed"])).toBe("Who owes");
    expect(pageName(["style", "games"])).toBe("Play style");
    expect(pageName(["adjust"])).toBe("Payments & corrections");
    expect(pageName(["player", "della"])).toBe("Player");
    expect(pageName(["game", "pgl0"])).toBe("Night");
    expect(pageName(["nowhere"])).toBe("Page not found");
  });
});

describe("the words a screen reader hears", () => {
  it("names the payments' direction in text, not on a plain span", async () => {
    const out = renderToStaticMarkup(createElement(Settle, { ctx: await pageCtx(), gameId: "", onSaved: () => undefined }));
    expect(out).not.toContain('aria-label="pays"');
    expect(out).toContain('<span class="sr-only"> pays </span>');
  });

  it("names a sparkline by its player and nights", () => {
    const out = renderToStaticMarkup(createElement(Sparkbars, { values: [5, -2.5], subject: "Della" }));
    expect(out).toMatch(/aria-label="Della, last 2 nights: [^"]*\$5\.00[^"]*"/);
  });

  it("names the running total with its latest value, and can take focus", () => {
    const points = [
      { label: "Jan 1", value: 2 },
      { label: "Jan 2", value: 5 },
      { label: "Jan 3", value: 3 },
    ];
    const out = renderToStaticMarkup(createElement(LineChart, { points, label: "Running total for Della" }));
    expect(out).toMatch(/aria-label="Running total for Della: now [^"]+ after 3 nights"/);
    expect(out).toContain('tabindex="0"');
  });
});

describe("the colour pairs in styles.css", () => {
  const css = read("../src/styles.css");
  const block = (re: RegExp): string => re.exec(css)?.[1] ?? "";
  const tokens = (text: string): Record<string, string> =>
    Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{3,6})\s*;/g)].map((m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()]));
  const light = tokens(block(/:root\s*\{([^}]*)\}/));
  // Dark comes twice: the device's (unless More forces light) and forced from More. They must be the same.
  const deviceDark = tokens(block(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/));
  const forcedDark = tokens(block(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/));
  const dark = { ...light, ...deviceDark };

  function luminance(hex: string): number {
    const short = hex.replace("#", "");
    const h = short.length === 3 ? short.split("").map((c) => c + c).join("") : short;
    const [r, g, b] = [0, 2, 4].map((i) => {
      const v = parseInt(h.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  }
  function contrast(a: string, b: string): number {
    const sorted = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((sorted[0] ?? 0) + 0.05) / ((sorted[1] ?? 0) + 0.05);
  }

  for (const [name, t] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    const pairs: [string, string, string][] = [
      ["text on the page", "--ink", "--paper"],
      ["text on a field or a pressed row", "--ink", "--paper-2"],
      ["text on the highlighted row (yours)", "--ink", "--you"],
      ["secondary text on the page (dim rows, notes)", "--ink-2", "--paper"],
      ["secondary text on a field", "--ink-2", "--paper-2"],
      ["secondary text on the highlighted row", "--ink-2", "--you"],
      ["green on the page (amounts won, paid)", "--up", "--paper"],
      ["green on a field", "--up", "--paper-2"],
      ["green on the highlighted row", "--up", "--you"],
      ["red on the page (amounts lost, open, partial)", "--down", "--paper"],
      ["red on a field", "--down", "--paper-2"],
      ["red on the highlighted row", "--down", "--you"],
      ["the warning colour on the page", "--warn", "--paper"],
      ["a button's label", "--on-solid", "--solid"],
    ];
    for (const [what, fg, bg] of pairs) {
      it(`${name}: ${what} is at least 4.5:1`, () => {
        expect(contrast(t[fg] ?? "", t[bg] ?? "")).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("the forced dark theme is the device's dark theme, colour for colour", () => {
    expect(Object.keys(deviceDark).length).toBeGreaterThan(10);
    expect(forcedDark).toEqual(deviceDark);
  });

  it("the dotted leaders and slip edges (never text) are at least 3:1, as a line must be", () => {
    expect(contrast(light["--ink-3"] ?? "", light["--paper"] ?? "")).toBeGreaterThanOrEqual(3);
    expect(contrast(dark["--ink-3"] ?? "", dark["--paper"] ?? "")).toBeGreaterThanOrEqual(3);
  });

  it("the badge's count is ink on the highlighter in both themes", () => {
    expect(/\.badge \{[^}]*color: var\(--ink\)/.test(css)).toBe(true);
    expect(/\.badge \{[^}]*background: var\(--you\)/.test(css)).toBe(true);
  });

  it("settled and even rows are muted by colour, not by opacity", () => {
    expect(/tr\.dim td \{[^}]*\}/.exec(css)?.[0] ?? "").not.toContain("opacity");
    expect(/\.choices \.muted \{[^}]*\}/.exec(css)?.[0] ?? "").not.toContain("opacity");
  });

  it("has a visually hidden class for the words only a screen reader reads", () => {
    expect(css).toContain(".sr-only {");
  });
});
