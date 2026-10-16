// Copies text for the group chat. navigator.clipboard exists only on a secure page (https, or
// localhost); a phone that opens the site over the Wi-Fi address is on plain http, so there a
// read-only text box is selected and the copy command is used instead. Resolves true when the text
// was copied, and false when neither way worked (the caller then shows the text to copy by hand).
export async function copyToClipboard(text: string): Promise<boolean> {
  const secure = (globalThis as { isSecureContext?: boolean }).isSecureContext === true;
  const clipboard = (globalThis as { navigator?: Navigator }).navigator?.clipboard;
  if (secure && clipboard !== undefined) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Refused (the browser asked, or the page lost focus): the copy command below is tried.
    }
  }
  return copyWithTextBox(text);
}

// A read-only text box, selected and copied with the copy command (it works without the Clipboard API).
function copyWithTextBox(text: string): boolean {
  const doc = (globalThis as { document?: Document }).document;
  if (doc === undefined || doc === null) return false;
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  doc.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange?.(0, text.length);
    return doc.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
