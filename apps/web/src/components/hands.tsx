// The two hand-log blocks of a player's history (menu 3): "At the table" (playtime.cpp printPlayer)
// and "Beaten at showdown by" (showdowns.cpp printPlayer). The wording and the numbers are the
// console's.
import { playTimeHours, playtime, showdowns, util, type PlayTime } from "@plr/core";

import type { HandScopePayload } from "../handtypes.ts";
import { moneySigned } from "../format.ts";
import { entryOf, withCommas, nightWord } from "../handformat.ts";
import { Legend, Lines } from "./handlines.tsx";

// The console's printf rounding (util.fixedText), under the name the console's own code uses.
const fixedText = util.fixedText;

// The "Beaten at showdown by" summary for one person. A person with no showdown in the scope has no
// entry in the payload, so the summary is the one the core gives for no record.
export function beatenFor(data: HandScopePayload, normalized: string): showdowns.ShowdownSummary {
  return entryOf(data.showdowns, normalized) ?? showdowns.showdownSummary(undefined, data.logged, data.games);
}

// "At the table": the time on the tables, the rate, the hands, and the ledger's seat-time note.
export function AtTheTable({ displayName, totalNet, time }: { displayName: string; totalNet: number; time: PlayTime | undefined }) {
  if (time === undefined || !playtime.hasSeatTime(time)) {
    return <p>{`No seat time on record for ${displayName} in this scope.`}</p>;
  }
  const hours = playTimeHours(time);
  const nightsShown = Math.max(1, time.nights);
  const rows: [string, string][] = [
    [
      "Time",
      `${playtime.hoursText(time)} over ${time.nights} ${nightWord(time.nights)}, ${fixedText(hours / nightsShown, 1)} h a night`,
    ],
    ["Rate", `${moneySigned(totalNet / hours)} an hour   (poker net ${moneySigned(totalNet)} / ${fixedText(hours, 1)} h)`],
  ];
  if (time.nightsLogged > 0) {
    const about =
      time.secondsDealt >= 60 ? `, about ${fixedText(time.hands / (time.secondsDealt / 3600), 0)} an hour` : "";
    rows.push([
      "Hands",
      `${withCommas(time.hands)} dealt over ${time.nightsLogged} ${nightWord(time.nightsLogged)} with a hand log${about}`,
    ]);
  }
  return (
    <>
      <Lines rows={rows} />
      {time.secondsEstimated >= 0.5 ? (
        <Legend
          lines={[
            `~ ${fixedText(time.secondsEstimated / 3600, 1)} h of it is ledger seat time (nights with no hand log, or before a log begins).`,
            "It runs long: a seat stays open while its player sits out.",
          ]}
        />
      ) : null}
    </>
  );
}

// "Beaten at showdown by": the showdowns in the scope's logs, and the people who beat them most.
export function BeatenAtShowdown({
  displayName,
  games,
  summary,
}: {
  displayName: string;
  games: number;
  summary: showdowns.ShowdownSummary;
}) {
  if (summary.noLogs) {
    return <p>{`None of the ${games} ${games === 1 ? "game" : "games"} in scope has a hand log, so there are no showdowns to read.`}</p>;
  }
  if (!summary.reached) {
    return <p>{`${displayName} reached no showdowns (${summary.coverText}).`}</p>;
  }
  return (
    <>
      <p>
        {`Reached showdown ${summary.showdowns} ${summary.showdowns === 1 ? "time" : "times"}: won ${summary.won} (${summary.wonPercent}%), lost ${summary.lost}, losing ${util.money(summary.lostAmount)} in those hands.`}
      </p>
      <p className="muted small">{`${summary.coverText}; these numbers come from those nights only.`}</p>
      {summary.beatenBy.length === 0 ? (
        <p>Nobody has beaten them at showdown yet.</p>
      ) : (
        <>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th className="num">#</th>
                  <th className="stick">Player</th>
                  <th className="num">Times</th>
                  <th className="num">Lost to them</th>
                </tr>
              </thead>
              <tbody>
                {summary.beatenBy.map((r, i) => (
                  <tr key={r.person}>
                    <td className="num">{i + 1}</td>
                    <td className="stick">{r.displayName}</td>
                    <td className="num">{r.times}</td>
                    <td className="num down">{util.money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {summary.moreRivals > 0 ? (
            <p className="muted small">
              {`... and ${summary.moreRivals} more (the showdown_rivals.csv download on the Play style page has them all).`}
            </p>
          ) : null}
          <Legend
            lines={[
              `Times = showdowns they won that ${displayName} lost. Lost to them = what ${displayName} lost in those hands, shared between the winners by what each collected (7-2 bounties left out). A chop is no loss.`,
            ]}
          />
        </>
      )}
    </>
  );
}
