import { forgetDeviceKey } from './device-key'
import { vaultDelete } from './vault'

/** What this browser remembers about the signed-in member, besides the session itself. */
const LOCAL = ['pingme.contacts-known', 'pingme.no-mac-later', 'pingme.notify-asked', 'pingme.invite', 'pingme.otp']
/** Replies already shown here, kept in the vault by use-network.ts. */
export const REPLIES = 'replies'

/**
 * Signing out forgets this browser: its key (pings sealed to it can no longer be opened here),
 * the replies kept here and the small notes, so the next account starts clean.
 */
export async function forgetBrowser() {
  for (const k of LOCAL) {
    try {
      localStorage.removeItem(k)
    } catch {
      // Blocked storage held nothing.
    }
  }
  await vaultDelete(REPLIES).catch(() => {})
  await forgetDeviceKey()
}
