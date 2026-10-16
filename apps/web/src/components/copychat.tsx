// A "Copy for the group chat" button. Where the browser will not copy (a phone on the Wi-Fi address is
// on plain http), the text is shown to select and copy by hand.
import { useState } from "react";

import { copyToClipboard } from "../clipboard.ts";

export function CopyForChat({ text, label = "Copy for the group chat", what }: { text: string; label?: string; what: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = (): void => {
    setFailed(false);
    void copyToClipboard(text).then((ok) => {
      setCopied(ok);
      setFailed(!ok);
      if (ok) setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <>
      <div className="controls">
        <button onClick={copy}>{copied ? "Copied" : label}</button>
      </div>
      {failed ? (
        <>
          <p className="down small">This browser would not copy it. Select the text below and copy it by hand.</p>
          <textarea
            className="links"
            readOnly
            rows={Math.min(12, text.split("\n").length + 1)}
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={`${what} to copy`}
          />
        </>
      ) : null}
    </>
  );
}
