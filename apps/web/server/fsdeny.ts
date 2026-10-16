// The Vite fs.deny pattern for a folder the website must never serve through /@fs/ (local/: the
// Saved_Data backups, the snapshots, the real-data runs). Vite compares a file's path with forward
// slashes, on Windows too, so a Windows folder is written with forward slashes first. Glob characters
// in the folder's own path (parentheses, brackets, braces, and so on) each become a bracket class,
// which matches that character on every platform.
export function denyPatternFor(folder: string): string {
  const slashed = folder.replace(/\\/g, "/");
  const literal = slashed.replace(/[[\]{}()*?+@!]/g, (c) => (c === "]" ? "[]]" : `[${c}]`));
  return `${literal}/**`;
}
