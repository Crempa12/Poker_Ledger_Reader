// Number and label formats for the hand-log pages. The numbers are the console app's: util.fixedText
// is its printf rounding (never toFixed), and the rules for "-", "(brackets)" and "inf" are the
// console's (handlog.cpp pct1 / af1 / hr1, playstyle.cpp rateCell, hitrun.cpp factorCell).
import { handlog, hitrun, playstyle, util } from "@plr/core";

import type { ScopeChoice } from "./data.ts";
import type { HandProfile, HandScopePayload } from "./handtypes.ts";

// A percentage that is already in percent: "56%".
export function pctText(percent: number): string {
  return util.fixedText(percent, 0) + "%";
}

// A share from 0 to 1, shown as a percentage: "12%". The console multiplies by 100 first.
export function pctOfShare(share: number): string {
  return pctText(100 * share);
}

// Postflop aggression for the style table: "inf" from 99 (no calls), one decimal otherwise.
export function afText(af: number): string {
  return af >= 99 ? "inf" : util.fixedText(af, 1);
}

// A hit & run factor: "-" with no nights to judge, "(42)" when there are too few winning nights.
export function hrText(factor: number, reliable: boolean): string {
  if (factor < 0) return "-";
  const text = util.fixedText(factor, 0);
  return reliable ? text : `(${text})`;
}

// A rate with its opportunities: "-" with none, "(33)" under 25 opportunities (not a tendency), "33%" otherwise.
export function rateText(r: playstyle.Rate): string {
  if (r.opportunities === 0) return "-";
  const text = util.fixedText(playstyle.ratePct(r), 0);
  return r.opportunities < playstyle.kMinOpportunities ? `(${text})` : `${text}%`;
}

// The factor for a menu 22 row: "-" with no winning night, "(9)" when not reliable.
export function factorText(s: hitrun.Summary): string {
  if (s.upNights === 0) return "-";
  return hrText(s.factor, hitrun.reliable(s));
}

// The colour the console gives a hit & run row: red from 40 (a hit & runner), yellow from 25,
// grey when there are too few winning nights to trust the factor. The same test for its tag.
export function factorTone(s: hitrun.Summary): "hitter" | "runs" | "quiet" | "" {
  if (!hitrun.reliable(s)) return "quiet";
  const rounded = Math.round(s.factor);
  if (rounded >= 40) return "hitter";
  if (rounded >= 25) return "runs";
  return "";
}

// The style label as the console's style table shows it: the part before " (" is left out.
export function styleName(s: handlog.StyleStats): string {
  const label = handlog.styleLabel(s);
  const at = label.indexOf(" (");
  return at === -1 ? label : label.slice(0, at);
}

// "folder "May games", 2031-05-01 to now" or "all folders": the console's Scope::describe.
export function scopeWords(choice: ScopeChoice): string {
  const place = choice.folder === "" ? "all folders" : `folder "${choice.folder}"`;
  if (choice.from === "" && choice.to === "") return place;
  return `${place}, ${choice.from === "" ? "start" : choice.from} to ${choice.to === "" ? "now" : choice.to}`;
}

// A profile as the core takes it: its showdown hand classes back in a Map.
export function profileOf(h: HandProfile): playstyle.Profile {
  return { ...h, showdownHandClass: new Map(h.showdownHandClass) };
}

// The menu 21 profiles with their hit & run columns, as the console annotates them (hitrun.cpp annotate):
// the facts come from the scope's summaries, so the tables agree with menu 22 whatever the payload holds.
export function profilesOf(data: HandScopePayload): playstyle.Profile[] {
  const facts = hitrun.hitRunFacts(data.hitRun.summaries);
  return data.profiles.map((h) => {
    const p = profileOf(h);
    const f = facts.get(p.normalizedName);
    if (f === undefined) return p;
    return { ...p, hitRun: f.hitRun, hitRunReliable: f.hitRunReliable, hitRunTag: f.hitRunTag, hitRunLine: f.hitRunLine };
  });
}

// 1234 -> "1,234" (whole numbers only, as the console prints its hand counts).
export function withCommas(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// "1 night", "3 nights".
export function nightWord(n: number): string {
  return n === 1 ? "night" : "nights";
}

// The entry under a name in one of the payload's records, or undefined. Only the record's own names
// count: a name such as "constructor" is not an entry of a plain object, so it finds nothing.
export function entryOf<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

// A label cut to a table column the way the console cuts it (util.cpp padRight): the first width-1
// characters and an ellipsis, when it is longer than the column. A shorter label is left whole.
export function cutCell(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}
