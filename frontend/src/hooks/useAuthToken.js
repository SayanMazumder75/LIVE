import { useSyncExternalStore } from "react";
import { getToken, subscribe } from "../auth.js";

/**
 * useAuthToken
 * ------------
 * React subscription to the auth.js token store.
 *
 * Returns the current JWT (or null) and re-renders the component
 * whenever the token changes — most importantly, when MeetMind
 * sends a fresh token via postMessage AFTER the React tree has
 * already mounted. Without this hook the History UI would only
 * notice a token change on the next user interaction.
 *
 * Implementation note: `useSyncExternalStore` is the React 18
 * primitive purpose-built for "subscribe to a singleton store and
 * read its snapshot". It guarantees concurrent-mode-safe reads
 * (no torn UI between two renders that disagree on whether we're
 * authenticated).
 *
 *   const token         = useAuthToken();
 *   const isAuthed      = Boolean(token);
 */
export function useAuthToken() {
  // The third argument is the SSR snapshot — we have no SSR here,
  // but returning `null` keeps useSyncExternalStore happy if a
  // build flag ever flips it on.
  return useSyncExternalStore(subscribe, getToken, () => null);
}
