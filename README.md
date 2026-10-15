# Poker Ledger Web

The web version of the Poker Ledger Reader, so the group can open it on any phone or laptop.

This is the `web-app` branch. It has its own history and holds no game data. The console app
lives on `master` and is unchanged. Step 2 (the ledger math in TypeScript, matched to the console
app to the cent) is what this branch holds now. The website itself is step 3.

## What is here

- `packages/core/src` is the ledger math in plain TypeScript. It reads no files, no clock and no
  machine time zone. Money is whole cents and times are epoch seconds.
- `packages/core/src/world.ts` is the entry point for a caller. `loadWorld` takes the raw texts
  (ledger CSVs, Saved_Data CSVs and an IANA time zone) and returns what the app computes. `viewOf`
  gives one scope's board, settlement sheet, what is owed, merge suggestions and seats to check.
- `tools/` holds the parity check, the privacy check, the made-up data generator and a loader that
  reads a data folder from disk (Node only).
- `reference/` runs the C++ app to produce the expected output. `fixtures/` holds the made-up data
  and that output.

## Requirements

Node 22.18 or newer. Run `npm install` once. TypeScript runs directly, with no build step.

## Run the tests

    npm run typecheck
    npm test

## Parity with the console app

Made-up data, which runs anywhere:

    npm run parity

The last line should read `PASS: 0 mismatch(es)`. The TypeScript core recomputes every committed
export and printed total from the made-up data, and compares it with what the C++ app wrote.

Real data, which stays on this machine:

1. Run the C++ reference on your own data, writing into `local/` (git ignores it). The C++ repo
   sits beside this one; the harness reads the data and never writes to it.

       npm run reference -- --code ../Poker_Ledger_Reader --data ../Poker_Ledger_Reader --out local/reference-real

2. Compare:

       npm run parity:real

A `MISMATCH` line names the file or step that differs. Players are named by their normalized name,
never by their display name, and no file name is shown. Nothing is written to a file.

## Privacy check

    npm run check:privacy

It reads the real data at run time, in memory only, and checks every file git would commit, and the
history of the checked-out branch, for real names, ids, timestamps and notes. It prints counts only.
It exits non-zero on any hit, and when it cannot check (no real values, or a game file it cannot
read). It takes a few minutes. Run it before every push to the public repo.

Ordinary words that happen to be someone's nickname, and text the app itself writes, are
allow-listed by their SHA-256 only, in `tools/check-privacy.ts`. The words themselves are never
stored.

## Made-up data

    npm run fixtures

regenerates `fixtures/synthetic`. Do not edit those files by hand. To rerun the C++ reference on
the made-up data into a new folder:

    npm run reference -- --code ../Poker_Ledger_Reader --data fixtures/synthetic --out <a new folder>

The committed reference is `fixtures/synthetic-reference`. Change it only when the fixtures change.
