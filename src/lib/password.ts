/**
 * Site access password (static hosting, GitHub Pages — client-side only:
 * the password lives in the JS bundle, so this is an entry barrier, not
 * real server-side security). The unlock flag persists in localStorage
 * so a reload or a shared deep link doesn't ask again.
 */
export const ACCESS_PASSWORD = '7758258';

const UNLOCK_KEY = 'unvideo.unlocked';

export function isUnlocked(): boolean {
  try {
    return localStorage.getItem(UNLOCK_KEY) === '1';
  } catch {
    return false;
  }
}

export function unlock(): void {
  try {
    localStorage.setItem(UNLOCK_KEY, '1');
  } catch {
    /* storage unavailable (e.g. private mode): gate just won't persist */
  }
}
