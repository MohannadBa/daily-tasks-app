'use client';
import { api } from './api';
import { detectPlatform, type Platform } from './pwa';

export type PermissionState = NotificationPermission | 'unsupported';

export interface PushSupport {
  platform: Platform;
  /** Installed Home Screen app / standalone window. */
  standalone: boolean;
  secureContext: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  notifications: boolean;
  /** Everything needed to subscribe is available here. */
  supported: boolean;
  /**
   * iPhone/iPad in a Safari tab: Web Push only exists inside the installed Home Screen app
   * (iOS/iPadOS 16.4+). The user has to Add to Home Screen first.
   */
  iosNeedsInstall: boolean;
}

function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function getPushSupport(): PushSupport {
  const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints);
  const standalone = isStandalone();
  const secureContext = window.isSecureContext;
  const serviceWorker = 'serviceWorker' in navigator;
  const pushManager = 'PushManager' in window;
  const notifications = 'Notification' in window;
  const ios = platform === 'ios-safari' || platform === 'ios-other';
  return {
    platform,
    standalone,
    secureContext,
    serviceWorker,
    pushManager,
    notifications,
    supported: secureContext && serviceWorker && pushManager && notifications,
    iosNeedsInstall: ios && !standalone,
  };
}

export function getPermission(): PermissionState {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

/** The service worker registration (registers it if needed, e.g. in `next dev`). */
async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
  return navigator.serviceWorker.ready;
}

export async function getBrowserSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** sha256(endpoint) prefix, matching PushSubscriptionDto.endpointHash, to recognise this device's row. */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export class PushSetupError extends Error {
  constructor(
    readonly code: 'unsupported' | 'ios-install' | 'denied' | 'dismissed' | 'server-disabled' | 'subscribe-failed',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Enable notifications on this device. MUST be called directly from a user gesture (button click):
 * iOS only shows the permission prompt for a user interaction, and we never prompt automatically.
 */
export async function enablePush(): Promise<{ id: string; endpointHash: string }> {
  const support = getPushSupport();
  if (support.iosNeedsInstall) throw new PushSetupError('ios-install', 'Add Al-Rasiyat to your Home Screen first');
  if (!support.supported) throw new PushSetupError('unsupported', 'This browser does not support push notifications');

  // First await in the handler, so the user-activation is still valid for the prompt.
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission === 'denied') throw new PushSetupError('denied', 'Notifications are blocked for this site');
  if (permission !== 'granted') throw new PushSetupError('dismissed', 'Permission was not granted');

  const { enabled, publicKey } = await api.push.vapidPublicKey();
  if (!enabled || !publicKey) throw new PushSetupError('server-disabled', 'Push notifications are not configured on the server');
  const key = urlBase64ToUint8Array(publicKey);

  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  // Subscribed with an old VAPID key (key rotation): replace it.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  try {
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (e) {
    throw new PushSetupError('subscribe-failed', (e as Error).message || 'Could not create a push subscription');
  }
  return api.push.subscribe(sub.toJSON() as { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } });
}

/** Turn notifications off on this device (server row + browser subscription). */
export async function disablePush(): Promise<void> {
  const sub = await getBrowserSubscription();
  if (!sub) return;
  await api.push.unsubscribe({ endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

/**
 * On app start (signed in): re-register an existing browser subscription. This refreshes keys,
 * reactivates it if the server had marked it expired, and binds it to whoever is signed in now.
 * Never prompts.
 */
export async function syncPushSubscription(): Promise<void> {
  try {
    if (getPermission() !== 'granted') return;
    const sub = await getBrowserSubscription();
    if (!sub) return;
    await api.push.subscribe(sub.toJSON() as { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } });
  } catch {
    /* offline / push disabled: try again next launch */
  }
}

/**
 * Before signing out: stop this device receiving the user's notifications, and drop the browser
 * subscription so the next person to sign in here has to opt in themselves.
 */
export async function removePushOnSignOut(timeoutMs = 2500): Promise<void> {
  await Promise.race([disablePush().catch(() => undefined), new Promise((r) => setTimeout(r, timeoutMs))]);
}
