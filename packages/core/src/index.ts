// Public entry point of the ledger math (the package's "exports" points here).
//
// A website calls the facade (loadWorld, then viewOf) and gets everything the app
// computes. The module namespaces below give one part at a time. They exist because
// generic names such as find, apply, filter and calculate would collide if flattened:
// seats.apply, adjustments.filter, players.find and settlement.calculateSheet read
// the way the C++ names them. Helpers that are only for the package itself (the
// libc++ sort port, the text scanners) are not exported.
//
// Pure: nothing here reads files, the clock or the machine's time zone.

// The facade: the whole startup, and the figures for one screen.
export { loadWorld, boardFor, sheetFor, viewOf } from "./world.ts";
export type { World, WorldInput, WorldView } from "./world.ts";

// Shared data shapes and the small rules on them (types, averagePerGameDollars,
// scopeContains and the like). Names here do not collide with anything above.
export * from "./models.ts";

// Money formatting and parsing, dates and time zones: names unique across the package.
export {
  centsOfDollars,
  dollarsToCents,
  fixed2,
  fixed2Cents,
  formatLocalDate,
  isValidTimeZone,
  money,
  moneyCents,
  moneySigned,
  moneySignedCents,
  parseCents,
  parseISO8601UTC,
  parseLocalDate,
  zonedTimeToEpoch,
  wallClock,
  type WallClock,
  toDoubleSafe,
  readNumber,
  type NumberReading,
} from "./util.ts";

// One module at a time, for the parts a caller uses by name.
export * as ledger from "./ledger.ts";
export * as players from "./players.ts";
export * as seats from "./seats.ts";
export * as adjustments from "./adjustments.ts";
export * as settlement from "./settlement.ts";
export * as sessions from "./sessions.ts";
export * as util from "./util.ts";
