// Display helpers. Money goes through the core's formatters so every amount prints
// exactly as the console app prints it.
import { money, moneyCents, moneySigned, moneySignedCents } from "@plr/core";

export { money, moneyCents, moneySigned, moneySignedCents };

// "up" / "down" / "even" for colouring a result (anything under a cent is even).
export type Tone = "up" | "down" | "even";

export function toneOf(dollars: number): Tone {
  if (dollars >= 0.005) return "up";
  if (dollars <= -0.005) return "down";
  return "even";
}

export function toneOfCents(cents: number): Tone {
  return cents > 0 ? "up" : cents < 0 ? "down" : "even";
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(options);
  let f = formatters.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { ...options, timeZone });
    formatters.set(key, f);
  }
  return f;
}

// "Oct 7" (epoch seconds, in the data's time zone).
export function shortDate(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "—";
  return formatter(timeZone, { month: "short", day: "numeric" }).format(new Date(epoch * 1000));
}

// "Tue, Oct 7, 2026".
export function longDate(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "no date";
  return formatter(timeZone, { weekday: "short", month: "short", day: "numeric", year: "numeric" }).format(
    new Date(epoch * 1000),
  );
}

// "8:15 PM".
export function clockTime(epoch: number | null, timeZone: string): string {
  if (epoch === null) return "—";
  return formatter(timeZone, { hour: "numeric", minute: "2-digit" }).format(new Date(epoch * 1000));
}

export function plural(n: number, one: string, many = one + "s"): string {
  return `${n} ${n === 1 ? one : many}`;
}
