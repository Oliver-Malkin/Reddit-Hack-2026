/**
 * Copy text to the clipboard, resilient to the Devvit webview.
 *
 * The app runs inside a cross-origin iframe, where `navigator.clipboard.writeText` is blocked
 * by Permissions-Policy (no `clipboard-write` grant) and rejects — or is missing entirely in a
 * non-secure context. The legacy `document.execCommand('copy')` path works in more of those
 * restricted contexts because it copies a real DOM selection made inside the user gesture,
 * which doesn't go through the Permissions API. We try the modern API first and fall back.
 *
 * Must be called synchronously from within a user gesture (click/tap) for the fallback to work.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Blocked by the iframe's permissions policy — drop to the execCommand fallback below.
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement('textarea');
  ta.value = text;
  // Keep it off-screen but still selectable; `readonly` stops the mobile keyboard popping up.
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length); // iOS ignores select() alone
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
