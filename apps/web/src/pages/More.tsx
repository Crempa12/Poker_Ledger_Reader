import { useState } from "react";

import type { Ctx } from "../context.ts";
import { isSnapshot } from "../data.ts";
import { clockTime, plural, shortDate } from "../format.ts";
import { useHandLogs } from "../handlogs.ts";
import { href } from "../router.ts";
import { applyTheme, readTheme, type Theme } from "../theme.ts";
import { checkCount } from "./Check.tsx";

// Everything that is not one of the four places in the bar: the other pages, the facts about the data
// (the console's startup box), and light or dark.
export function More({ ctx }: { ctx: Ctx }) {
  const { world, me } = ctx;
  const snapshot = isSnapshot(ctx.payload);
  const checks = checkCount(ctx);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const pick = (t: Theme): void => {
    setTheme(t);
    applyTheme(t);
  };
  const taken = Math.floor(ctx.payload.loadedAt / 1000);
  return (
    <>
      <h1>More</h1>
      <ul className="rowlinks">
        <Row to="style" title="Play style" sub="From the hand logs: how each player plays, hit & run" />
        <Row to="check" title="Checks" sub={checks > 0 ? `${plural(checks, "thing")} to look at` : "Nothing to look at"} />
        <Row to="adjust" title="Payments & corrections" sub="Money paid outside a sheet, a forgiven debt" />
        {snapshot ? null : <Row to="settings" title="Settings" sub="Who you are, the banker, pinned payments, names, a snapshot" />}
        <Row to="help" title="Help" sub="Adding games, settling up, sharing" />
      </ul>

      <section className="sec">
        <h2>This data</h2>
        <Facts ctx={ctx} />
        <div className="kv">
          <span className="k">{snapshot ? "Snapshot of" : "Reading"}</span>
          <span className="v">
            <code>{folderName(ctx.payload.dataRoot)}</code>
            {snapshot ? "" : " on this computer"}
          </span>
        </div>
        <div className="kv">
          <span className="k">{snapshot ? "Taken" : "Read at"}</span>
          <span className="v">
            {shortDate(taken, ctx.tz)} {clockTime(taken, ctx.tz)}
          </span>
        </div>
        <div className="kv">
          <span className="k">Games</span>
          <span className="v">{world.games.length}</span>
        </div>
        <div className="kv">
          <span className="k">Times in</span>
          <span className="v">{ctx.tz}</span>
        </div>
        {me === "" && !snapshot ? (
          <p className="note">
            Tell the site who you are in <a href={href("settings")}>Settings</a> to see your own number first on Standings.
          </p>
        ) : null}
      </section>

      <section className="sec">
        <h2 id="theme-h">Light or dark</h2>
        <div className="seg" role="group" aria-labelledby="theme-h">
          {(["system", "light", "dark"] as const).map((t) => (
            <button key={t} aria-pressed={theme === t} onClick={() => pick(t)}>
              {t === "system" ? "Like this device" : t === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <p className="note">Kept in this browser only.</p>
      </section>
    </>
  );
}

function Row({ to, title, sub }: { to: string; title: string; sub: string }) {
  return (
    <li>
      <a href={href(to)}>
        <span className="t">{title}</span>
        <span className="sub">{sub}</span>
        <span className="chev" aria-hidden="true">
          ›
        </span>
      </a>
    </li>
  );
}

// The console's startup box, in one line: the hand logs for this scope (the logs that load and pair with
// a game in scope, out of the games in scope), the banker, the pinned payments and who "me" is. The
// hand-log count is left out until the results are read (and when a snapshot cannot give them for the dates chosen).
export function Facts({ ctx }: { ctx: Ctx }) {
  const { world, me } = ctx;
  const hand = useHandLogs(ctx);
  const banker = world.settings.banker === "" ? "off" : ctx.nameOf(world.settings.banker);
  const meName = me === "" ? "not set" : ctx.nameOf(me);
  const logged = hand.status === "ready" && hand.data !== undefined ? [`hand logs ${hand.data.logged}/${hand.data.games}`] : [];
  const facts = [...logged, `banker ${banker}`, `pinned payments ${world.prefs.length}`, `me ${meName}`].join(" · ");
  return <p className="sub facts-line">{facts}</p>;
}

function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
