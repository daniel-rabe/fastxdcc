/**
 * Typed access to the preload bridge, plus a helper that turns the `Result` envelope into
 * a thrown error so components can use ordinary try/catch.
 */

import type { FastxdccApi, Result } from '../electron/ipc.js';

declare global {
  interface Window {
    fastxdcc?: FastxdccApi;
  }
}

export const BRIDGE_MISSING =
  'The bridge to the app process is missing, so nothing can be loaded or started. ' +
  'This page only works inside the fastxdcc desktop app.';

/**
 * A stand-in used when `window.fastxdcc` is absent — which happens if the page is opened
 * directly in a browser instead of through Electron's preload. Every call fails with the
 * same explanation, so the UI reports the problem instead of dying on `undefined`.
 */
function missingBridge(): FastxdccApi {
  const fail = () => Promise.resolve({ ok: false as const, error: BRIDGE_MISSING });
  return new Proxy({} as FastxdccApi, {
    get(_target, property) {
      // Subscriptions must still hand back a working unsubscribe function.
      if (property === 'onState') return () => () => {};
      return fail;
    },
  });
}

export const bridgeAvailable = typeof window.fastxdcc === 'object' && window.fastxdcc !== null;

export const api: FastxdccApi = window.fastxdcc ?? missingBridge();

/** Unwrap a Result, throwing its error message. */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
