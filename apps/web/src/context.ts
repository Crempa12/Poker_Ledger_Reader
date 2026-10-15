// Everything a page needs for the current scope, worked out once per scope change.
import {
  boardFor,
  formatLocalDate,
  parseLocalDate,
  players,
  viewOf,
  type Game,
  type PlayerStats,
  type Scope,
  type World,
  type WorldView,
} from "@plr/core";

import { toScope, type Payload, type ScopeChoice } from "./data.ts";

export interface Ctx {
  payload: Payload;
  world: World;
  tz: string;
  choice: ScopeChoice;
  scope: Scope;
  view: WorldView;
  everyone: PlayerStats[]; // every game, for names and for links outside the scope
  me: string; // normalized "me" from the console app's settings ("" = not set)
  nameOf: (normalized: string) => string;
}

const EVERY_GAME: Scope = { folder: "", from: null, to: null };

export function buildCtx(payload: Payload, world: World, choice: ScopeChoice): Ctx {
  const scope = toScope(choice, world.timeZone);
  const everyone = boardFor(world, world.games, EVERY_GAME);
  return {
    payload,
    world,
    tz: world.timeZone,
    choice,
    scope,
    view: viewOf(world, scope),
    everyone,
    me: world.settings.me,
    nameOf: (normalized) => players.displayName(everyone, normalized),
  };
}

// The scope the console app uses when you settle one game (menu 5, option 1): the
// game's folder and its local day, so only that day's payments and corrections count.
export function dayScope(game: Game, timeZone: string): Scope {
  const day = formatLocalDate(game.start, timeZone);
  return {
    folder: game.folder,
    from: parseLocalDate(day, false, timeZone),
    to: parseLocalDate(day, true, timeZone),
  };
}

// Poker results only, oldest first (what the console app's charts use).
export function nightsOf(p: PlayerStats): PlayerStats["history"] {
  return p.history.filter((h) => !h.adjustment);
}

export function upDown(p: PlayerStats): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const h of nightsOf(p)) {
    if (h.netCents > 0) up++;
    else if (h.netCents < 0) down++;
  }
  return { up, down };
}
