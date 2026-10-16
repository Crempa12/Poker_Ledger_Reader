// The hash router reads an address a person typed or edited by hand, such as "#/player/100%".
// A malformed percent sequence must not throw (a throw during the first render blanked the page).
import { describe, expect, it } from "vitest";

import { href, parseHash } from "../src/router.ts";

describe("reading the address bar", () => {
  it("reads a bare percent sign as the text it is, instead of throwing", () => {
    expect(() => parseHash("#/player/100%")).not.toThrow();
    expect(parseHash("#/player/100%")).toEqual(["player", "100%"]);
    expect(parseHash("#/%")).toEqual(["%"]);
  });

  it("still decodes an encoded segment", () => {
    expect(parseHash("#/player/100%25")).toEqual(["player", "100%"]);
    expect(parseHash(href("player", "a b/c"))).toEqual(["player", "a b/c"]);
  });

  it("keeps the other segments when one is malformed", () => {
    expect(parseHash("#/style/%E0%A4%A/x")).toEqual(["style", "%E0%A4%A", "x"]);
  });
});
