import { describe, expect, it } from 'vitest';
import { detectPlatform } from './pwa';

const UA = {
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1',
  ipadOS: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36',
};

describe('detectPlatform', () => {
  it('detects iOS Safari vs other iOS browsers', () => {
    expect(detectPlatform(UA.iphoneSafari)).toBe('ios-safari');
    expect(detectPlatform(UA.iphoneChrome)).toBe('ios-other');
  });
  it('treats a touch "Macintosh" as iPadOS, a mouse one as desktop', () => {
    expect(detectPlatform(UA.ipadOS, 5)).toBe('ios-safari');
    expect(detectPlatform(UA.ipadOS, 0)).toBe('desktop');
  });
  it('detects Android', () => {
    expect(detectPlatform(UA.android)).toBe('android');
  });
});
