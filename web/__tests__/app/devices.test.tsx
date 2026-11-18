import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { NOTICE_MS, newMacs } from '@/components/app/devices'
import { resetDeviceKey } from '@/lib/device-key'
import type { ContactsView, MyDevice } from '@/lib/network'
import { resetVault, vaultGet, vaultSet } from '@/lib/vault'
import { setLeaving } from '@/lib/forget'
import { RENAME, SAVE, SIGN_OUT, SIGN_OUT_SURE, NAME_LABEL } from '@/components/app/account'
import { DOMINIK, ME, WEB, contact, contactsView, keys } from './net-fixtures'

// Pair phishing regression, the web side: every device on the account is visible and removable,
// and a Mac that joins later is announced on the browsers that were already there.

const h = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  queries: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: {} as Record<string, unknown>,
  signOut: vi.fn(async () => {}),
}))

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server')
  return {
    useConvexAuth: () => h.auth,
    useQuery: (ref: never, args: unknown) => (args === 'skip' ? undefined : h.queries[getFunctionName(ref)]),
    useMutation: (ref: never) => {
      const name = getFunctionName(ref)
      if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
      return h.mutations[name]
    },
  }
})

vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signIn: vi.fn(), signOut: h.signOut }),
}))

const { App } = await import('@/components/app/app')

function mutation(name: string) {
  if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
  return h.mutations[name]
}

let K: Awaited<ReturnType<typeof keys>>
beforeAll(async () => {
  K = await keys()
})

const HOUR = 3_600_000
const DAY = 24 * HOUR

function dev(over: Partial<MyDevice> & { deviceId: string; name: string }): MyDevice {
  return { kind: 'mac', publicKey: K.myMac.publicKey, createdAt: Date.now() - 30 * DAY, lastSeen: Date.now(), ...over }
}

/** A member whose account has exactly `devices`; this browser is WEB. */
function member(devices: MyDevice[]) {
  h.auth.isAuthenticated = true
  h.queries['senders:me'] = { status: 'member', name: 'Viki', userId: ME, onboarded: true }
  const view = contactsView(K.me, [contact({ userId: DOMINIK, name: 'Dominik' }, K.dominikMac)]) as Extract<ContactsView, { status: 'member' }>
  h.queries['contacts:list'] = { ...view, me: { ...view.me, devices } }
  h.queries['messages:mine'] = { status: 'member', deviceActive: true, rows: [] }
  h.results['devices:registerWeb'] = { ok: true, deviceId: WEB }
  h.results['devices:revoke'] = true
}

const browser = (createdAt = Date.now() - 10 * DAY) => dev({ deviceId: WEB, kind: 'web', name: 'Chrome · Mac', publicKey: K.me.publicKey, createdAt })

beforeEach(async () => {
  h.auth.isLoading = false
  h.auth.isAuthenticated = false
  h.queries = {}
  h.mutations = {}
  h.results = {}
  setLeaving(false)
  resetVault()
  resetDeviceKey()
  await vaultSet('deviceKey', K.me)
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => cleanup())

describe('devices on the account', () => {
  it('lists every other device; removing one takes two clicks', async () => {
    member([browser(), dev({ deviceId: 'mac-me', name: 'Vikin Mac' }), dev({ deviceId: 'mac-evil', name: 'MacBook Pro', createdAt: Date.now() - 20 * DAY })])
    const view = render(<App />)
    const toggle = await screen.findByRole('button', { name: /^Devices/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    // Two Macs, both synced just now; this browser is not counted.
    expect(toggle).toHaveAccessibleName('Devices 2, Connected')
    // In one row with "Connect your agent"; the panel opens under that row, last on the page.
    expect(toggle.closest('.cn-bar')).toContainElement(screen.getByRole('button', { name: 'Connect your agent' }))
    fireEvent.click(toggle)
    const list = screen.getByRole('list', { name: 'Devices' })
    expect(view.container.querySelector('.cn')?.lastElementChild).toContainElement(list)
    const rows = within(list).getAllByRole('listitem')
    // Newest first, so an unknown Mac is near the top.
    expect(rows.map((r) => r.querySelector('.dv-name')?.textContent)).toEqual(['MacBook Pro', 'Vikin Mac'])
    expect(within(rows[0]).getByText('Connected')).toBeInTheDocument()
    // This browser is named once under the list, not as a device to remove.
    expect(screen.getByText('This browser:')).toBeInTheDocument()
    expect(within(list).queryByText('Chrome · Mac')).toBeNull()

    const remove = within(list).getByRole('button', { name: 'Remove MacBook Pro' })
    fireEvent.click(remove)
    expect(mutation('devices:revoke')).not.toHaveBeenCalled()
    expect(remove).toHaveAccessibleName('Confirm: Remove MacBook Pro')
    expect(remove).toHaveTextContent('Remove')
    fireEvent.click(remove)
    await waitFor(() => expect(mutation('devices:revoke')).toHaveBeenCalledWith({ deviceId: 'mac-evil' }))
    expect(mutation('devices:revoke')).toHaveBeenCalledTimes(1)
  })

  it('another browser on the account stays a row that can be removed', async () => {
    member([browser(), dev({ deviceId: 'web-2', kind: 'web', name: 'Safari · iPhone', lastSeen: Date.now() - 3 * DAY })])
    render(<App />)
    const toggle = await screen.findByRole('button', { name: /^Devices/ })
    // A browser is never "connected": no dot on the toggle.
    expect(toggle).toHaveAccessibleName('Devices 1')
    fireEvent.click(toggle)
    const list = screen.getByRole('list', { name: 'Devices' })
    expect(within(list).getByText('Safari · iPhone')).toBeInTheDocument()
    expect(within(list).getByText(/^Seen /)).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Remove Safari · iPhone' })).toBeInTheDocument()
  })

  it('a Mac that has not synced for a while shows when it was last seen', async () => {
    member([browser(), dev({ deviceId: 'mac-me', name: 'Vikin Mac', lastSeen: Date.now() - 2 * HOUR })])
    render(<App />)
    const toggle = await screen.findByRole('button', { name: /^Devices/ })
    expect(toggle).toHaveAccessibleName('Devices 1')
    fireEvent.click(toggle)
    expect(within(screen.getByRole('list', { name: 'Devices' })).queryByText('Connected')).toBeNull()
  })

  it('with only this browser it says there is no Mac yet', async () => {
    member([browser()])
    render(<App />)
    const toggle = await screen.findByRole('button', { name: /^Devices/ })
    expect(toggle).toHaveAccessibleName('Devices 0')
    fireEvent.click(toggle)
    expect(within(screen.getByRole('list', { name: 'Devices' })).getByText(/^No Mac yet/)).toBeInTheDocument()
  })

  it('announces a Mac that joined after this browser until it is confirmed', async () => {
    member([browser(), dev({ deviceId: 'mac-me', name: 'Vikin Mac' }), dev({ deviceId: 'mac-new', name: 'MacBook Pro', createdAt: Date.now() - HOUR })])
    const view = render(<App />)
    const notice = await screen.findByRole('status', { name: 'New Mac' })
    expect(notice).toHaveTextContent('MacBook Pro')
    // First in reading order, above the form.
    expect(view.container.querySelector('main > .notices > .dv-new')).toBe(notice)

    fireEvent.click(within(notice).getByRole('button', { name: "It's mine" }))
    await waitFor(() => expect(screen.queryByRole('status', { name: 'New Mac' })).toBeNull())
    expect(mutation('devices:revoke')).not.toHaveBeenCalled()
    // Remembered in this browser.
    cleanup()
    render(<App />)
    await screen.findByRole('button', { name: /^Devices/ })
    expect(screen.queryByRole('status', { name: 'New Mac' })).toBeNull()
  })

  it('removes the new Mac straight from the notice', async () => {
    member([browser(), dev({ deviceId: 'mac-new', name: 'MacBook Pro', createdAt: Date.now() - HOUR })])
    render(<App />)
    const notice = await screen.findByRole('status', { name: 'New Mac' })
    fireEvent.click(within(notice).getByRole('button', { name: 'Remove MacBook Pro' }))
    await waitFor(() => expect(mutation('devices:revoke')).toHaveBeenCalledWith({ deviceId: 'mac-new' }))
    await waitFor(() => expect(screen.queryByRole('status', { name: 'New Mac' })).toBeNull())
  })

  it('only Macs newer than this browser and less than a week old are announced', () => {
    const now = Date.now()
    const self = browser(now - 10 * DAY)
    const fresh = dev({ deviceId: 'a', name: 'A', createdAt: now - HOUR })
    const older = dev({ deviceId: 'b', name: 'B', createdAt: now - 11 * DAY })
    const stale = dev({ deviceId: 'c', name: 'C', createdAt: now - NOTICE_MS - 1 })
    const web = dev({ deviceId: 'd', name: 'Safari', kind: 'web', createdAt: now - HOUR })
    const all = [self, fresh, older, stale, web]
    expect(newMacs(all, WEB, now, new Set()).map((d) => d.deviceId)).toEqual(['a'])
    expect(newMacs(all, WEB, now, new Set(['a']))).toEqual([])
    // A browser the server does not list yet announces nothing.
    expect(newMacs(all, null, now, new Set())).toEqual([])
    expect(newMacs(all, 'unknown', now, new Set())).toEqual([])
  })
})

describe('your account', () => {
  it('says who is signed in, renames, and signing out forgets this browser', async () => {
    member([browser()])
    h.queries['senders:me'] = { status: 'member', name: 'Viki', email: 'viki@example.com', userId: ME, onboarded: true }
    h.results['senders:rename'] = true
    h.results['devices:revoke'] = true
    // The revoke makes this browser look lost on the server, as it does live.
    mutation('devices:revoke').mockImplementation(async () => {
      h.queries['messages:mine'] = { status: 'member', deviceActive: false, rows: [] }
      return true
    })
    h.signOut.mockClear()
    localStorage.setItem('pingme.contacts-known', '{"people":{}}')
    localStorage.setItem('pingme.no-mac-later', '1')
    await vaultSet('replies', { r1: 'Jdu na to' })
    const view = render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: /^Devices/ }))
    expect(screen.getByText('viki@example.com')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: RENAME }))
    const field = screen.getByRole('textbox', { name: NAME_LABEL })
    expect(field).toHaveValue('Viki')
    fireEvent.change(field, { target: { value: '  Viktorie ' } })
    fireEvent.click(screen.getByRole('button', { name: SAVE }))
    await waitFor(() => expect(h.mutations['senders:rename']).toHaveBeenCalledWith({ name: 'Viktorie' }))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: NAME_LABEL })).toBeNull())

    // One slip does not sign out: the first click only says what it will do.
    fireEvent.click(screen.getByRole('button', { name: SIGN_OUT }))
    expect(h.signOut).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: SIGN_OUT_SURE }))
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1))
    expect(h.mutations['devices:revoke']).toHaveBeenCalledWith({ deviceId: WEB })
    expect(localStorage.getItem('pingme.contacts-known')).toBeNull()
    expect(localStorage.getItem('pingme.no-mac-later')).toBeNull()
    expect(await vaultGet('replies')).toBeUndefined()
    expect(await vaultGet('deviceKey')).toBeUndefined()
    // Signing out never registers this browser again on the account it leaves.
    await new Promise((r) => setTimeout(r, 20))
    expect(mutation('devices:registerWeb')).toHaveBeenCalledTimes(1)
    expect(await vaultGet('deviceKey')).toBeUndefined()

    // The session ends; the next sign-in in the same tab registers this browser with a new key.
    h.auth.isAuthenticated = false
    view.rerender(<App />)
    await screen.findByRole('textbox', { name: /email/i })
    h.auth.isAuthenticated = true
    h.queries['messages:mine'] = { status: 'member', deviceActive: true, rows: [] }
    view.rerender(<App />)
    await waitFor(() => expect(mutation('devices:registerWeb')).toHaveBeenCalledTimes(2))
    expect(await vaultGet('deviceKey')).toBeDefined()
  })
})
