// A message that must outlive the page that made it: on a first run, the page that files the games is
// replaced by Standings as soon as one game is in, so what went wrong with the others is said here,
// above every page, until it is dismissed.
import { useSyncExternalStore } from "react";

let current: string | null = null;
const listeners = new Set<() => void>();

export function setNotice(text: string | null): void {
  current = text;
  for (const l of listeners) l();
}

export function useNotice(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => null,
  );
}
