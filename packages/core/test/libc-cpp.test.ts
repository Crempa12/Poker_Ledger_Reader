// Regression tests for what the TypeScript ports take from the C++ library on the app's machine:
// libc++ std::sort (the libcppSort port, with ties and with the EPSILON comparator the app's
// showdown and hit & run sorts use), std::pow (the hit & run peak fade) and iostream std::fixed
// (the num() text, with printf's round-half-to-even on exact ties).
//
// The expected values are records the C++ library wrote for made-up inputs (see
// fixtures/libc-cpp-records.ts). Nothing here is real data: the inputs are small integers and
// doubles from a fixed generator.

import { describe, expect, it } from "vitest";

import { libcppSort } from "../src/libcpp-sort.ts";
import { EPSILON_DOLLARS, fixed2, fixedText } from "../src/util.ts";
import {
  AMOUNT_SORT_RECORDS,
  FIXED_RECORDS,
  KEY_SORT_RECORDS,
  POW_RECORDS,
} from "./fixtures/libc-cpp-records.ts";

const view = new DataView(new ArrayBuffer(8));

function doubleOfBits(hex: string): number {
  view.setBigUint64(0, BigInt("0x" + hex));
  return view.getFloat64(0);
}

function bitsOfDouble(x: number): string {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
}

describe("libcppSort: the order libc++ std::sort leaves equal keys in", () => {
  it("matches the C++ permutation for every recorded key case", () => {
    const mismatches: string[] = [];
    for (const r of KEY_SORT_RECORDS) {
      const items = r.keys.map((key, id) => ({ key, id }));
      libcppSort(items, 0, r.n, (a, b) => a.key < b.key);
      const got = items.map((x) => x.id).join(",");
      if (got !== r.ids.join(",")) mismatches.push(`n=${r.n} range=${r.range} seed=${r.seed}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the C++ permutation for the EPSILON comparator (a tie band that is not transitive)", () => {
    const mismatches: string[] = [];
    for (const r of AMOUNT_SORT_RECORDS) {
      const items = r.bits.map((hex, id) => ({ amount: doubleOfBits(hex), id }));
      libcppSort(items, 0, r.n, (a, b) => {
        if (Math.abs(a.amount - b.amount) > EPSILON_DOLLARS) return a.amount > b.amount;
        return a.id < b.id;
      });
      const got = items.map((x) => x.id).join(",");
      if (got !== r.ids.join(",")) mismatches.push(`n=${r.n} seed=${r.seed}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("is not trivially matching: the recorded C++ sorts really reorder ties", () => {
    expect(KEY_SORT_RECORDS.some((r) => r.ids.some((id, i) => id !== i))).toBe(true);
    expect(AMOUNT_SORT_RECORDS.some((r) => r.ids.some((id, i) => id !== i))).toBe(true);
  });
});

describe("std::pow(0.5, h / 20.0): the hit & run peak fade", () => {
  it("returns the same bits as the C++ library for every recorded hand count", () => {
    const mismatches: number[] = [];
    for (const [h, hex] of POW_RECORDS) {
      if (bitsOfDouble(Math.pow(0.5, h / 20.0)) !== hex) mismatches.push(h);
    }
    expect(mismatches).toEqual([]);
  });

  it("is exact at whole halvings", () => {
    expect(Math.pow(0.5, 0 / 20)).toBe(1);
    expect(Math.pow(0.5, 20 / 20)).toBe(0.5);
    expect(Math.pow(0.5, 100 / 20)).toBe(1 / 32);
  });
});

describe("fixedText: iostream std::fixed (the app's num() helper)", () => {
  it("matches the C++ text for every recorded value at 0 to 4 places", () => {
    const mismatches: string[] = [];
    for (const r of FIXED_RECORDS) {
      const x = doubleOfBits(r.bits);
      for (let dp = 0; dp <= 4; dp++) {
        if (fixedText(x, dp) !== r.text[dp]) mismatches.push(`${r.bits} dp${dp}`);
      }
      // fixed2 is the dollar text the files are written with; it has its own rounding path.
      if (fixed2(x) !== r.text[2]) mismatches.push(`${r.bits} fixed2`);
    }
    expect(mismatches).toEqual([]);
  });

  it("fixed2, the two-place dollar text the files use, rounds exact ties the same way", () => {
    expect(fixed2(0.125)).toBe("0.12");
    expect(fixed2(0.375)).toBe("0.38");
    expect(fixed2(-0)).toBe("-0.00");
    expect(fixed2(-0.001)).toBe("-0.00");
  });

  it("rounds exact ties to the even digit, as printf does", () => {
    expect(fixedText(0.125, 2)).toBe("0.12");
    expect(fixedText(0.375, 2)).toBe("0.38");
    expect(fixedText(0.5, 0)).toBe("0");
    expect(fixedText(1.5, 0)).toBe("2");
    expect(fixedText(2.5, 0)).toBe("2");
  });

  it("keeps the sign of negative zero and of a value that rounds to zero", () => {
    expect(fixedText(-0, 0)).toBe("-0");
    expect(fixedText(-0, 2)).toBe("-0.00");
    expect(fixedText(-0.001, 2)).toBe("-0.00");
  });
});
