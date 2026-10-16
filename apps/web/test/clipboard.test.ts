// "Copy for the group chat" must work on a page that is not a secure context (a phone opening the
// site over the Wi-Fi address is plain http, where navigator.clipboard does not exist). Browser objects
// are stubbed here: the test runs in Node.
import { afterEach, describe, expect, it, vi } from "vitest";

import { copyToClipboard } from "../src/clipboard.ts";

// A stand-in for a textarea that records what was selected and copied.
function fakeDocument(copyWorks: boolean) {
  const log = { value: "", selected: false, copied: 0, appended: 0, removed: 0 };
  const area = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute() {},
    select() {
      log.selected = true;
      log.value = area.value;
    },
    remove() {
      log.removed++;
    },
  };
  const doc = {
    body: {
      appendChild() {
        log.appended++;
        return area;
      },
    },
    createElement() {
      return area;
    },
    execCommand(name: string) {
      if (name === "copy") log.copied++;
      return copyWorks;
    },
  };
  return { doc, log };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copying text for the group chat", () => {
  it("uses the clipboard when the page is a secure context", async () => {
    const writes: string[] = [];
    vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => void writes.push(t) } });
    vi.stubGlobal("isSecureContext", true);
    expect(await copyToClipboard("sheet text")).toBe(true);
    expect(writes).toEqual(["sheet text"]);
  });

  it("copies with a selected text box when there is no clipboard (a plain http page on a phone)", async () => {
    const { doc, log } = fakeDocument(true);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("document", doc);
    expect(await copyToClipboard("sheet text")).toBe(true);
    expect(log.selected).toBe(true);
    expect(log.value).toBe("sheet text");
    expect(log.copied).toBe(1);
    expect(log.removed).toBe(1);
  });

  it("falls back to the text box when the clipboard refuses", async () => {
    const { doc, log } = fakeDocument(true);
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => Promise.reject(new Error("denied")) } });
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("document", doc);
    expect(await copyToClipboard("sheet text")).toBe(true);
    expect(log.copied).toBe(1);
  });

  it("says so when nothing can copy, and leaves no text box behind", async () => {
    const { doc, log } = fakeDocument(false);
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal("document", doc);
    expect(await copyToClipboard("sheet text")).toBe(false);
    expect(log.removed).toBe(1);
  });

  it("answers false, and does not throw, when there is no page at all", async () => {
    vi.stubGlobal("navigator", undefined);
    vi.stubGlobal("document", undefined);
    expect(await copyToClipboard("sheet text")).toBe(false);
  });
});
