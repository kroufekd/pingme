import { createHash } from 'node:crypto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The same tiny fake of Convex as page.test.tsx, recording query args by function name.
const h = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  queries: {} as Record<string, unknown>,
  queryArgs: {} as Record<string, unknown[]>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: {} as Record<string, unknown>,
  signIn: vi.fn(),
  signOut: vi.fn(),
}))

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server')
  return {
    useConvexAuth: () => h.auth,
    useQuery: (ref: never, args: unknown) => {
      const name = getFunctionName(ref)
      ;(h.queryArgs[name] ??= []).push(args)
      return args === 'skip' ? undefined : h.queries[name]
    },
    useMutation: (ref: never) => {
      const name = getFunctionName(ref)
      if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
      return h.mutations[name]
    },
  }
})

vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signIn: h.signIn, signOut: h.signOut }),
}))

const { App } = await import('@/components/app/app')

const PAIR_ID = 'AbCdEfGhIjKlMnOpQrStUv'
const SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'
const HASH = createHash('sha256').update(SECRET, 'utf8').digest('hex')
const CODE = '309365'

/** The six digits from the Mac's island, typed (or pasted with a space) into the field. */
async function typeCode(value = '309 365') {
  fireEvent.change(await screen.findByRole('textbox', { name: 'Code from your Mac' }), { target: { value } })
}

function mutation(name: string) {
  if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
  return h.mutations[name]
}

function member() {
  h.auth.isAuthenticated = true
  h.queries['senders:me'] = { status: 'member', name: 'Michal', email: 'michal@example.com', userId: 'u-mi', onboarded: true }
}

/** Every real (not skipped) call of a query. */
const calls = (name: string) => (h.queryArgs[name] ?? []).filter((a) => a !== 'skip')

beforeEach(() => {
  h.auth.isLoading = false
  h.auth.isAuthenticated = false
  h.queries = {}
  h.queryArgs = {}
  h.mutations = {}
  h.results = {}
  h.signIn.mockReset().mockResolvedValue({ signingIn: false })
  h.signOut.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', `/pair#${PAIR_ID}.${SECRET}`)
})

afterEach(() => cleanup())

describe('/pair', () => {
  it('signed out: the normal sign-in first, then the pairing, on the same page', async () => {
    const view = render(<App view="pair" />)
    const email = await screen.findByLabelText('Email')
    expect(email.closest('form')).toHaveClass('on')
    expect(calls('devices:pairing')).toHaveLength(0)

    fireEvent.change(email, { target: { value: 'michal@example.com' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'michal@example.com' }))

    // Signed in: the address still carries the link, the page asks with the hash only.
    member()
    h.queries['devices:pairing'] = { status: 'pending', name: 'MacBook Michala', expiresAt: Date.now() + 600_000 }
    view.rerender(<App view="pair" />)
    expect(await screen.findByText('MacBook Michala')).toBeInTheDocument()
    expect(calls('devices:pairing').at(-1)).toEqual({ pairId: PAIR_ID, secretHash: HASH })
    expect(JSON.stringify(h.queryArgs)).not.toContain(SECRET)
    // Only the pairing: no form, no device key, no contacts on this page.
    expect(screen.queryByRole('textbox', { name: 'Ping' })).toBeNull()
    expect(calls('contacts:list')).toHaveLength(0)
    expect(mutation('devices:registerWeb')).not.toHaveBeenCalled()
  })

  it('the code from the Mac and one button approve it; done stays when the request expires', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'pending', name: 'MacBook Michala', expiresAt: Date.now() + 600_000 }
    h.results['devices:approvePairing'] = { ok: true }
    const view = render(<App view="pair" />)
    const button = await screen.findByRole('button', { name: 'Connect this Mac' })
    expect(screen.getAllByRole('button').filter((b) => !b.closest('[inert]'))).toHaveLength(1)
    // The field takes the keyboard, and the page warns against a code that is not on your Mac.
    const field = screen.getByRole('textbox', { name: 'Code from your Mac' })
    await waitFor(() => expect(field).toHaveFocus())
    expect(screen.getByText("Don't see this code on your Mac? Don't connect.")).toBeInTheDocument()
    // It says which account the Mac joins, before the code is typed.
    expect(screen.getByText('michal@example.com').closest('p')).toHaveTextContent('This Mac joins michal@example.com.')

    await typeCode()
    expect(field).toHaveValue(CODE)
    fireEvent.click(button)
    await waitFor(() => expect(mutation('devices:approvePairing')).toHaveBeenCalledWith({ pairId: PAIR_ID, secretHash: HASH, code: CODE }))
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('MacBook Michala')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect this Mac' })).toBeNull()
    // The secret leaves the address bar.
    expect(window.location.hash).toBe('')

    // Later the request expires: still done, no more reading.
    const before = calls('devices:pairing').length
    h.queries['devices:pairing'] = { status: 'invalid' }
    view.rerender(<App view="pair" />)
    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.queryByText('This link has expired.')).toBeNull()
    expect(calls('devices:pairing')).toHaveLength(before)
    expect(mutation('devices:approvePairing')).toHaveBeenCalledTimes(1)

    // A link for another Mac pasted into this same tab only changes the fragment: start over.
    const pairId2 = 'ZyXwVuTsRqPoNmLkJiHgFe'
    const hash2 = createHash('sha256').update(SECRET.toUpperCase(), 'utf8').digest('hex')
    h.queries['devices:pairing'] = { status: 'pending', name: 'iMac Viki', expiresAt: Date.now() + 600_000 }
    await act(async () => {
      window.location.hash = `${pairId2}.${SECRET.toUpperCase()}`
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(await screen.findByText('iMac Viki')).toBeInTheDocument()
    expect(screen.queryByText('Connected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect this Mac' })).toBeInTheDocument()
    await waitFor(() => expect(calls('devices:pairing').at(-1)).toEqual({ pairId: pairId2, secretHash: hash2 }))
  })

  it('already approved by this account (a reload before the Mac claimed) shows done', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'approved' }
    render(<App view="pair" />)
    expect(await screen.findByText('Connected')).toBeInTheDocument()
  })

  it('an expired, used or foreign request says the link is dead', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'invalid' }
    render(<App view="pair" />)
    expect(await screen.findByText('This link has expired.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Connect this Mac' })).toBeNull()
  })

  it('a refused approval says the link is dead too', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'pending', name: 'MacBook', expiresAt: Date.now() + 600_000 }
    h.results['devices:approvePairing'] = { ok: false, error: 'invalid' }
    render(<App view="pair" />)
    await typeCode()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect this Mac' }))
    expect(await screen.findByText('This link has expired.')).toBeInTheDocument()
  })

  it('without the code nothing is sent; a wrong code says so and clears the field', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'pending', name: 'MacBook Pro', expiresAt: Date.now() + 600_000 }
    h.results['devices:approvePairing'] = { ok: false, error: 'bad-code' }
    render(<App view="pair" />)
    const button = await screen.findByRole('button', { name: 'Connect this Mac' })
    fireEvent.click(button)
    expect(await screen.findByText('The code has 6 digits.')).toBeInTheDocument()
    expect(mutation('devices:approvePairing')).not.toHaveBeenCalled()

    await typeCode('123456')
    fireEvent.click(button)
    expect(await screen.findByText("That code doesn't match.")).toBeInTheDocument()
    expect(mutation('devices:approvePairing')).toHaveBeenCalledWith({ pairId: PAIR_ID, secretHash: HASH, code: '123456' })
    const field = screen.getByRole('textbox', { name: 'Code from your Mac' })
    expect(field).toHaveValue('')
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveFocus()
    // Still pending: the person can type the right code.
    expect(screen.getByRole('button', { name: 'Connect this Mac' })).not.toBeDisabled()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('a network error keeps the button and asks to try again', async () => {
    member()
    h.queries['devices:pairing'] = { status: 'pending', name: 'MacBook', expiresAt: Date.now() + 600_000 }
    h.mutations['devices:approvePairing'] = vi.fn(async () => {
      throw new Error('offline')
    })
    render(<App view="pair" />)
    await typeCode()
    fireEvent.click(await screen.findByRole('button', { name: 'Connect this Mac' }))
    expect(await screen.findByText("That didn't work. Try again.")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Connect this Mac' })).not.toBeDisabled()
  })

  it('a malformed link never reaches the server', async () => {
    member()
    window.history.replaceState(null, '', '/pair#nope.short')
    render(<App view="pair" />)
    expect(await screen.findByText('This link has expired.')).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(calls('devices:pairing')).toHaveLength(0)
  })
})
