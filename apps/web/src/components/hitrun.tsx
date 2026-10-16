// Menu 22 (hit & run): the table (hitrun.cpp printTable) and one person's nights (printPlayer).
// The explanations are the console's, with its constants read from the core, so they cannot drift.
import { hitrun, util } from "@plr/core";

import { libcppSort } from "../../../../packages/core/src/libcpp-sort.ts";

import { href } from "../router.ts";
import type { HandScopePayload } from "../handtypes.ts";
import { moneySigned, toneOf } from "../format.ts";
import { factorText, factorTone, nightWord, pctOfShare } from "../handformat.ts";
import { AddLogHint, Legend, Lines } from "./handlines.tsx";

// The console's footer under the table (printTable), one line each.
const TABLE_LEGEND = [
  "Each night ends in one exit, judged on the LAST time they left (a break they came back from is not).",
  `Stay = dealt in during the night's last ${hitrun.GRACE_HANDS} hands.  Play = share of each night's hands dealt to them.`,
  `Up / Down = left for good with chips, ${util.fixedText(hitrun.EVEN_BB, 0)}+ big blinds ahead / behind.`,
  "(About even, and taken out by the admin: in the player view.)",
  `Bust = went under ${util.fixedText(hitrun.BUST_BB, 0)} big blind and went home.  Rebuy = busted and bought back in.`,
  `Back = gone ${hitrun.BREAK_HANDS}+ hands, then dealt in again.`,
  `When up = share of the night (from their sit-down) still to come when they left, on nights they finished ahead, weighted by the win (${util.fixedText(hitrun.FULL_WIN_BB, 0)}+ big blinds counts fully).  Staying counts as 0%.`,
  "When dn = the same on nights they finished behind with chips.",
  `Hit = the part of When up that came right after their best point of the night, with most of it kept: full credit leaving at the peak, half ${util.fixedText(hitrun.PEAK_HALF_LIFE_HANDS, 0)} hands later, a sixteenth ${util.fixedText(4 * hitrun.PEAK_HALF_LIFE_HANDS, 0)} hands later.`,
  "All three lean toward the pool's average for a player with few such nights.",
  "H&R = 100 x (When up + how much When up exceeds When dn + Hit) / 3.",
  `An H&R in (brackets) has fewer than ${hitrun.MIN_UP_NIGHTS} winning nights; the only tag it can get is Busts out.`,
];

// The menu 22 table, every person in the console's order (core summaries come sorted).
export function HitRunView({ data, scope, canWrite = true }: { data: HandScopePayload; scope: string; canWrite?: boolean }) {
  const { summaries, nights, unmeasured } = data.hitRun;
  return (
    <>
      <p className="muted">{`Hit & run for ${scope}.`}</p>
      {summaries.length === 0 ? (
        <div className="card pad">
          <p>
            No hand logs in scope, so no nights to judge. <AddLogHint canWrite={canWrite} />
          </p>
        </div>
      ) : (
        <HitRunTable summaries={summaries} nights={nights} unmeasured={unmeasured} />
      )}
    </>
  );
}

function HitRunTable({
  summaries,
  nights,
  unmeasured,
}: {
  summaries: hitrun.Summary[];
  nights: hitrun.Night[];
  unmeasured: number;
}) {
  const measured = new Set(nights.map((n) => n.gameId)).size;
  const cut = new Set(nights.filter((n) => n.handsMissing > 0).map((n) => n.gameId)).size;
  // The average over the people the console calls reliable (menu 22's "Average H&R" line).
  let poolFactor = 0;
  let trusted = 0;
  for (const s of summaries) {
    if (hitrun.reliable(s)) {
      poolFactor += s.factor;
      trusted++;
    }
  }
  return (
    <section className="card">
      <h2>Hit &amp; run: how early they leave when winning</h2>
      <p className="muted small">{`${measured} ${measured === 1 ? "night" : "nights"} with a hand log, measured hand by hand.`}</p>
      {cut > 0 ? (
        <p className="muted small">
          {`${cut} of those logs start late (PokerNow cuts the first hands off a long night); seats from before a log begins are placed by the ledger's times.`}
        </p>
      ) : null}
      {unmeasured > 0 ? (
        <p className="warn small">
          {`${unmeasured} ${unmeasured === 1 ? "night" : "nights"} in scope have no hand log and are left out: a ledger cannot say when someone stopped playing.`}
        </p>
      ) : null}
      {trusted > 0 ? (
        <p className="muted small">
          {`Average H&R over the ${trusted} players with ${hitrun.MIN_UP_NIGHTS}+ winning nights: ${util.fixedText(poolFactor / trusted, 0)}.`}
        </p>
      ) : null}
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th className="stick">Player</th>
              <th className="num">Nights</th>
              <th className="num">Play</th>
              <th className="num">Stay</th>
              <th className="num">Up</th>
              <th className="num">Down</th>
              <th className="num">Bust</th>
              <th className="num">Rebuy</th>
              <th className="num">Back</th>
              <th className="num">When up</th>
              <th className="num">When dn</th>
              <th className="num">Hit</th>
              <th className="num">H&amp;R</th>
              <th>Tag</th>
            </tr>
          </thead>
          <tbody>
            {summaries.map((s) => {
              const tone = factorTone(s);
              return (
                <tr key={s.person}>
                  <td className="stick">
                    <a href={href("style", "hitrun", s.person)}>{s.displayName}</a>
                  </td>
                  <td className="num">{s.nights}</td>
                  <td className="num">{pctOfShare(s.played)}</td>
                  <td className="num">{s.stayed}</td>
                  <td className="num">{s.leftUp}</td>
                  <td className="num">{s.leftDown}</td>
                  <td className="num">{s.busted}</td>
                  <td className="num">{s.rebuys}</td>
                  <td className="num">{s.cameBack}</td>
                  <td className="num">{s.upNights > 0 ? pctOfShare(s.whenUp) : "-"}</td>
                  <td className="num">{pctOfShare(s.whenDown)}</td>
                  <td className="num">{s.upNights > 0 ? pctOfShare(s.hit) : "-"}</td>
                  <td className={`num ${tone}`}>{factorText(s)}</td>
                  <td className={tone}>{s.tag}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend lines={TABLE_LEGEND} />
    </section>
  );
}

// One person's nights (hitrun.cpp printPlayer): the three habits in words, then every night of theirs.
export function HitRunPlayer({ data, person, tz }: { data: HandScopePayload; person: string; tz: string }) {
  const s = data.hitRun.summaries.find((x) => x.person === person);
  if (s === undefined) {
    return (
      <div className="card pad">
        <p>No hand logs for this person in this scope.</p>
        <a href={href("style", "hitrun")}>Back to hit &amp; run</a>
      </div>
    );
  }
  const mine = data.hitRun.nights.filter((n) => n.person === person);
  // Newest first, the console's sort (libc++ std::sort, by date).
  libcppSort(mine, 0, mine.length, (a, b) => (a.date ?? -1) > (b.date ?? -1));
  const anyCut = mine.some((n) => n.satDownHand < n.handsMissing + 1);
  const anyEstimated = mine.some((n) => n.estimated);

  const rows: [string, string][] = [
    [
      "When winning",
      s.upNights > 0
        ? `left with ${pctOfShare(s.whenUpRaw)} of the night still to come over ${s.upNights} winning ${nightWord(s.upNights)} (${pctOfShare(s.whenUp)} with the pool)`
        : "no winning nights",
    ],
    [
      "When losing",
      s.downNights > 0
        ? `left with ${pctOfShare(s.whenDownRaw)} still to come over ${s.downNights} losing ${nightWord(s.downNights)} with chips (${pctOfShare(s.whenDown)} with the pool)`
        : `no losing nights with chips (the pool's ${pctOfShare(s.whenDown)} stands in)`,
    ],
  ];
  if (s.peakNightsLeftUp > 0) {
    rows.push([
      "The hit",
      `leaving up (median of ${s.peakNightsLeftUp}): ${util.fixedText(s.handsAfterPeakWhenUp, 0)} hands (${util.fixedText(s.minutesAfterPeakWhenUp, 0)} min) after their peak, keeping ${pctOfShare(s.keptWhenUp)} of it`,
    ]);
    rows.push(["", `hit ${pctOfShare(s.hitRaw)} (${pctOfShare(s.hit)} with the pool)`]);
  } else {
    rows.push(["The hit", "never left up on a night whose peak is known"]);
  }
  rows.push([
    "Exits",
    `stayed ${s.stayed} (${s.stayedUp} up, ${s.stayedDown} down), left up ${s.leftUp}, down ${s.leftDown}, even ${s.leftEven}, busted out ${s.busted}, removed ${s.removed}`,
  ]);
  rows.push([
    "Along the way",
    `${s.rebuys} rebuy${s.rebuys === 1 ? "" : "s"}; came back after a break ${s.cameBack} time${s.cameBack === 1 ? "" : "s"}, ${s.cameBackUp} of them after leaving up`,
  ]);
  rows.push([
    "Hands",
    `played ${pctOfShare(s.played)} of each night's hands${s.leftUp > 0 ? `; left up with ${util.fixedText(s.handsLeftWhenUp, 0)} still to deal, on average` : ""}`,
  ]);

  return (
    <section className="card">
      <h2>{`${s.displayName} - hit & run ${factorText(s)}${s.tag === "" ? "" : ` (${s.tag})`}`}</h2>
      <Lines rows={rows} />
      <div className="tablewrap nights">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th className="num">Sat at</th>
              <th className="num">Last</th>
              <th className="num">Still to come</th>
              <th className="num">Result</th>
              <th className="num">Peak</th>
              <th className="num">After peak</th>
              <th className="num">Rebuy</th>
              <th className="num">Back</th>
              <th>Exit</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((n, i) => {
              const cut = n.satDownHand < n.handsMissing + 1;
              const exit =
                hitrun.exitName(n.exit) +
                (n.exit === "stayed" ? (hitrun.finishedUp(n) ? " (up)" : hitrun.finishedDown(n) ? " (down)" : " (even)") : "");
              return (
                <tr key={`${n.gameId}-${i}`}>
                  <td className="nowrap">{util.formatLocalDate(n.date, tz)}</td>
                  <td className="num">{`${cut ? "~#" : "#"}${n.satDownHand}`}</td>
                  <td className="num">{`${n.estimated ? "~#" : "#"}${n.lastHand}`}</td>
                  <td className="num">
                    {`${n.handsLeft}/${n.handsInNight - n.satDownHand + 1}`}
                    {n.exit === "stayed" ? "" : ` (${pctOfShare(n.away)})`}
                  </td>
                  <td className={`num ${toneOf(n.net)}`}>{moneySigned(n.net)}</td>
                  <td className="num">
                    {n.peakKnown ? (n.peak > util.EPSILON_DOLLARS ? util.money(n.peak) + (n.peakAtLogStart ? "+" : "") : "-") : "?"}
                  </td>
                  <td className="num">
                    {n.peakKnown
                      ? n.peak > util.EPSILON_DOLLARS
                        ? `${n.handsAfterPeak} (${util.fixedText(n.minutesAfterPeak, 0)}m)`
                        : "-"
                      : "?"}
                  </td>
                  <td className="num">{n.rebuys > 0 ? String(n.rebuys) : ""}</td>
                  <td className="num">{n.cameBack > 0 ? String(n.cameBack) : ""}</td>
                  <td className="nowrap">{exit}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend
        lines={[
          "Sat at / Last = PokerNow hand numbers of their first and last hand.  Still to come = hands dealt after their last hand / hands dealt since they sat down (that share).  Peak = their best point of the night; After peak = hands (minutes) they played after reaching it.",
          ...(anyCut || anyEstimated
            ? [
                "~ = before the night's log begins (PokerNow cut its first hands off): placed by the ledger's times.",
                "A peak ending in + was reached where the log begins and may have been higher before it.",
              ]
            : []),
        ]}
      />
      <p className="small">
        <a href={href("style", "hitrun")}>All hit &amp; run</a>
        {data.profiles.some((h) => h.normalizedName === person) ? (
          <>
            {" · "}
            <a href={href("style", "profiles", person)}>Deep profile</a>
          </>
        ) : null}
      </p>
    </section>
  );
}
