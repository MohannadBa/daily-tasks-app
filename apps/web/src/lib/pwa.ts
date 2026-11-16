'use client';
import { useEffect, useSyncExternalStore } from 'react';

/** Chromium's install prompt event (not in lib.dom). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type Platform = 'ios-safari' | 'ios-other' | 'android' | 'desktop';

export interface InstallState {
  /** Running as an installed Home Screen app (no browser UI). */
  standalone: boolean;
  platform: Platform;
  /** Chromium (Android / desktop) offered a native install prompt we can trigger. */
  canPrompt: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedNow = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let initialised = false;

/** Pure: exported for tests. */
export function detectPlatform(ua: string, maxTouchPoints = 0): Platform {
  const iPadOS = /Macintosh/.test(ua) && maxTouchPoints > 1; // iPadOS reports a desktop UA
  if (/iPhone|iPad|iPod/.test(ua) || iPadOS) {
    // Chrome/Firefox/Edge on iOS identify themselves; the user should use Safari's Share menu.
    return /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua) ? 'ios-other' : 'ios-safari';
  }
  return /Android/.test(ua) ? 'android' : 'desktop';
}

function isStandalone(): boolean {
  return (
    installedNow ||
    window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

let snapshot: InstallState = { standalone: false, platform: 'desktop', canPrompt: false };
const SERVER_SNAPSHOT: InstallState = snapshot;

function refresh() {
  const next: InstallState = { standalone: isStandalone(), platform: detectPlatform(navigator.userAgent, navigator.maxTouchPoints), canPrompt: !!deferred };
  if (next.standalone !== snapshot.standalone || next.platform !== snapshot.platform || next.canPrompt !== snapshot.canPrompt) {
    snapshot = next;
    emit();
  }
}

/** Registers the service worker and starts listening for install events. Idempotent; call once at startup. */
export function initPwa() {
  if (initialised || typeof window === 'undefined') return;
  initialised = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // show our own button instead of the mini-infobar
    deferred = e as BeforeInstallPromptEvent;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installedNow = true;
    refresh();
  });
  window.matchMedia('(display-mode: standalone)').addEventListener?.('change', refresh);
  refresh();

  // Dev builds change constantly; a service worker would only get in the way there.
  if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch((err) => console.warn('Service worker registration failed', err));
  }
}

/** Shows the native install dialog (Android / desktop Chromium). Returns true when the user accepted. */
export async function promptInstall(): Promise<boolean> {
  if (!deferred) return false;
  const e = deferred;
  deferred = null;
  await e.prompt();
  const { outcome } = await e.userChoice;
  refresh();
  return outcome === 'accepted';
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
    () => SERVER_SNAPSHOT,
  );
}

/** Mount once near the root. */
export function PwaInit() {
  useEffect(() => initPwa(), []);
  return null;
}

const DISMISS_KEY = 'dt_install_dismissed_at';
const DISMISS_MS = 14 * 24 * 3600 * 1000;

/** Per-device "not now" for the install banner. Storage can be unavailable (private mode) — fail open. */
export function installBannerDismissed(): boolean {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY));
    return !!at && Date.now() - at < DISMISS_MS;
  } catch {
    return false;
  }
}

export function dismissInstallBanner() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}
