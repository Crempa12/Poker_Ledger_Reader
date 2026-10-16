// Light or dark: the device's choice unless More says otherwise. Kept in this browser only (a per-viewer
// convenience), and the page works the same when the browser keeps nothing.
export type Theme = "system" | "light" | "dark";

const KEY = "plr-theme";

export function readTheme(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

// Sets the page's colours (styles.css reads data-theme) and remembers the choice.
export function applyTheme(theme: Theme, remember = true): void {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (!remember) return;
  try {
    if (theme === "system") window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, theme);
  } catch {
    // A private window or blocked storage: the choice lasts until the page is closed.
  }
}
