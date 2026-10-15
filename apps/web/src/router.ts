// A tiny hash router: "#/player/ace" -> ["player", "ace"]. No library needed, and
// links keep working when the site is opened from a file or a sub-path.
import { useEffect, useState } from "react";

export function parseHash(hash: string): string[] {
  const path = hash.replace(/^#\/?/, "").split("?")[0] ?? "";
  return path === "" ? [] : path.split("/").map((p) => decodeURIComponent(p));
}

export function useRoute(): string[] {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function href(...parts: string[]): string {
  return "#/" + parts.map((p) => encodeURIComponent(p)).join("/");
}
