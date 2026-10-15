// One game's results per person (seats folded through the merge rules and seat
// owners, as the console app counts them).
import { players, type Game } from "@plr/core";

export interface PersonResult {
  person: string; // normalized
  netCents: number;
  buyInCents: number;
  cashOutCents: number; // cashed out plus what was still on the table
  seats: number;
}

export function resultsOf(game: Game, rules: ReadonlyMap<string, string>): PersonResult[] {
  const byPerson = new Map<string, PersonResult>();
  for (const row of game.rows) {
    const person = players.personOf(rules, row);
    const r = byPerson.get(person) ?? { person, netCents: 0, buyInCents: 0, cashOutCents: 0, seats: 0 };
    r.netCents += row.netCents;
    r.buyInCents += row.buyInCents;
    r.cashOutCents += row.buyOutCents + row.stackCents;
    r.seats += 1;
    byPerson.set(person, r);
  }
  return [...byPerson.values()].sort((a, b) => b.netCents - a.netCents || (a.person < b.person ? -1 : 1));
}
