/**
 * Push-to-talk shortcut matching, shared by the in-page bubble and the side
 * panel so the same chord works wherever the user's focus happens to be.
 */

export function shortcutParts(spec: string): string[] {
  return spec
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Does this keydown/keyup event match a shortcut spec like "Ctrl+Shift+Space"? */
export function matchesShortcut(event: KeyboardEvent, spec: string): boolean {
  const parts = shortcutParts(spec);
  if (parts.length === 0) return false;
  const main = parts[parts.length - 1];
  const mainOk = main === 'space' ? event.code === 'Space' : event.key.toLowerCase() === main;
  return (
    mainOk &&
    event.ctrlKey === parts.includes('ctrl') &&
    event.shiftKey === parts.includes('shift') &&
    event.altKey === parts.includes('alt')
  );
}

/** Is this key release part of the shortcut chord (so we should stop recording)? */
export function isChordRelease(event: KeyboardEvent, spec: string): boolean {
  const parts = shortcutParts(spec);
  const key = event.key.toLowerCase();
  if (parts.includes('ctrl') && key === 'control') return true;
  if (parts.includes('shift') && key === 'shift') return true;
  if (parts.includes('alt') && key === 'alt') return true;
  const main = parts[parts.length - 1];
  if (main === 'space') return event.code === 'Space';
  return key === main;
}
