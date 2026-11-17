import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDeviceKey } from '@/lib/device-key'
import type { Contact, ContactsView, SentRow } from '@/lib/network'
import { resetVault, vaultGet, vaultSet } from '@/lib/vault'
import { DOMINIK, ME, VIKI, WEB, contact, contactsView, keys, openFor, sentRow } from './net-fixtures'

// A tiny fake of Convex and Convex Auth: tests set what the queries return and
// read what the mutations got, by function name ("messages:mine", "messages:send", ...).
const h = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  queries: {} as Record<string, unknown>,
  queryArgs: {} as Record<string, unknown>,
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
      if (args === 'skip') return undefined
      h.queryArgs[getFunctionName(ref)] = args
      return h.queries[getFunctionName(ref)]
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

function mutation(name: string) {
  if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
  return h.mutations[name]
}

let K: Awaited<ReturnType<typeof keys>>
beforeAll(async () => {
  K = await keys()
})

/** Dominik with his Mac, online. The default single contact. */
const dominik = () => contact({ userId: DOMINIK, name: 'Dominik' }, K.dominikMac)

/** A signed-in member, this browser registered as WEB with key K.me. */
function member(rows: SentRow[] = [], contacts: Contact[] = [dominik()], view?: ContactsView) {
  h.auth.isAuthenticated = true
  h.queries['senders:me'] = { status: 'member', name: 'Franta', userId: ME, onboarded: true }
  h.queries['contacts:list'] = view ?? contactsView(K.me, contacts, K.myMac)
  h.queries['messages:mine'] = { status: 'member', deviceActive: true, rows }
  h.results['devices:registerWeb'] ??= { ok: true, deviceId: WEB }
}

/** The word of each row's status right now. Rows show an icon only, the word is its tooltip. */
function shownWords(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.it')).map((li) => li.querySelector('.st')?.getAttribute('title'))
}

/** The sent list is closed until its small icon is pressed. */
function sentToggle() {
  return screen.getByRole('button', { name: /^Sent/ })
}

async function typeEmail(email: string) {
  const input = await screen.findByLabelText('Email')
  fireEvent.change(input, { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
}

/** The code field, once it takes typing (it is read-only while the code is being sent). */
async function codeField() {
  const code = await screen.findByRole('textbox', { name: '6-digit code' })
  await waitFor(() => expect(code).not.toHaveAttribute('readonly'))
  return code
}

beforeEach(async () => {
  h.auth.isLoading = false
  h.auth.isAuthenticated = false
  h.queries = {}
  h.queryArgs = {}
  h.mutations = {}
  h.results = {}
  // This browser's stored key; jsdom has no IndexedDB, so the vault is the in-memory one.
  resetVault()
  resetDeviceKey()
  await vaultSet('deviceKey', K.me)
  h.signIn.mockReset().mockResolvedValue({ signingIn: false })
  h.signOut.mockReset().mockResolvedValue(undefined)
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

afterEach(() => cleanup())

describe('sign-in is a state of the same screen', () => {
  it('goes from email to code and signs in with the 6 digits', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@example.com' }))

    const code = await codeField()
    expect(code).toHaveAttribute('placeholder', 'Code from the email')
    expect(code.closest('form')).toHaveClass('on')
    expect(screen.getByRole('button', { name: 'Use a different email than franta@example.com' })).toBeInTheDocument()
    h.signIn.mockResolvedValueOnce({ signingIn: true })
    fireEvent.change(code, { target: { value: '419275' } })
    await waitFor(() => expect(h.signIn).toHaveBeenLastCalledWith('resend-otp', { email: 'franta@example.com', code: '419275' }))
  })

  it('says so when the code is wrong and clears the boxes', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    const code = await codeField()
    h.signIn.mockRejectedValueOnce(new Error('Could not verify code'))
    fireEvent.change(code, { target: { value: '000000' } })
    expect(await screen.findByText("That code doesn't match.")).toBeInTheDocument()
    expect(code).toHaveValue('')
  })

  it('stays on the email state with a quiet hint when the email is not invited', async () => {
    h.signIn.mockRejectedValueOnce(new Error('NOT_INVITED'))
    render(<App />)
    await typeEmail('nekdo@example.com')
    // The note is a polite live region that is always there; the hint is its text.
    const note = await screen.findByText("Couldn't send a code to this email.")
    expect(note).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-describedby', note.id)
    expect(screen.getByLabelText('Email')).toHaveValue('nekdo@example.com')
    expect(screen.getByLabelText('Email').closest('form')).toHaveClass('on')
  })

  it('signs out a signed-in person who is not a sender', async () => {
    h.auth.isAuthenticated = true
    h.queries['senders:me'] = { status: 'notMember', email: 'stary@example.com' }
    render(<App />)
    await waitFor(() => expect(h.signOut).toHaveBeenCalledTimes(1))
  })
})

describe('invite link', () => {
  async function signInWithLink() {
    window.history.replaceState(null, '', '/?i=tok123')
    h.queries['inviteLinks:check'] = { ok: true, name: 'Franta' }
    h.results['inviteLinks:start'] = { ok: true }
    const view = render(<App />)
    await typeEmail('franta@example.com')
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@example.com' }))
    expect(mutation('inviteLinks:start')).toHaveBeenCalledWith({ token: 'tok123', email: 'franta@example.com' })
    expect(localStorage.getItem('pingme.invite')).toBe('tok123')

    h.signIn.mockResolvedValueOnce({ signingIn: true })
    fireEvent.change(await codeField(), { target: { value: '419275' } })
    await waitFor(() => expect(h.signIn).toHaveBeenCalledTimes(2))
    return view
  }

  it('keeps the token while the claim is not ok', async () => {
    h.results['inviteLinks:claim'] = { ok: false, error: 'wrong-email' }
    const view = await signInWithLink()
    h.auth.isAuthenticated = true
    h.queries['senders:me'] = { status: 'notMember', email: 'franta@example.com' }
    view.rerender(<App />)
    await waitFor(() => expect(mutation('inviteLinks:claim')).toHaveBeenCalledWith({ token: 'tok123' }))
    await waitFor(() => expect(h.signOut).toHaveBeenCalled())
    expect(localStorage.getItem('pingme.invite')).toBe('tok123')
    expect(window.location.search).toBe('?i=tok123')
  })

  it('asks a member before adding whoever sent the link, and adds only on yes', async () => {
    member()
    window.history.replaceState(null, '', '/?i=tok9')
    h.mutations['inviteLinks:claim'] = vi.fn(async (args: { addContact?: boolean }) =>
      args.addContact ? { ok: true, name: 'Franta' } : { ok: false, error: 'confirm', inviterName: 'Mallory' },
    )
    render(<App />)
    const ask = await screen.findByRole('group', { name: 'Add Mallory to your contacts?' })
    expect(mutation('inviteLinks:claim')).toHaveBeenCalledWith({ token: 'tok9' })
    expect(localStorage.getItem('pingme.invite')).toBe('tok9')
    fireEvent.click(within(ask).getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(mutation('inviteLinks:claim')).toHaveBeenLastCalledWith({ token: 'tok9', addContact: true }))
    await waitFor(() => expect(screen.queryByRole('group', { name: /to your contacts/ })).toBeNull())
    expect(localStorage.getItem('pingme.invite')).toBeNull()
  })

  it('"No" drops the link without adding anyone', async () => {
    member()
    window.history.replaceState(null, '', '/?i=tok9')
    h.results['inviteLinks:claim'] = { ok: false, error: 'confirm', inviterName: 'Mallory' }
    render(<App />)
    const ask = await screen.findByRole('group', { name: 'Add Mallory to your contacts?' })
    fireEvent.click(within(ask).getByRole('button', { name: 'No' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: /to your contacts/ })).toBeNull())
    expect(mutation('inviteLinks:claim')).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('pingme.invite')).toBeNull()
  })

  it('drops the token and the ?i param once the claim is ok', async () => {
    // Like Convex: when the claim resolves, senders.me already says member.
    h.mutations['inviteLinks:claim'] = vi.fn(async () => {
      member()
      return { ok: true, name: 'Franta' }
    })
    const view = await signInWithLink()
    h.auth.isAuthenticated = true
    h.queries['senders:me'] = { status: 'notMember', email: 'franta@example.com' }
    view.rerender(<App />)
    await waitFor(() => expect(localStorage.getItem('pingme.invite')).toBeNull())
    expect(window.location.search).toBe('')
    expect(mutation('inviteLinks:claim')).toHaveBeenCalledTimes(1)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    await waitFor(() => expect(title).toHaveFocus())
    expect(h.signOut).not.toHaveBeenCalled()
  })
})

/** Types a title and presses send. */
async function sendTitle(text: string, label = 'Ping') {
  const title = await screen.findByRole('textbox', { name: label })
  fireEvent.change(title, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  return title
}

const sends = () => mutation('messages:send').mock.calls.map((c) => c[0])

describe('sending is end-to-end encrypted', () => {
  it('seals the title for the recipient Macs and my devices, and sends no plaintext', async () => {
    member()
    h.results['messages:send'] = { ok: true, ref: 'x' }
    const view = render(<App />)
    await waitFor(() => expect(mutation('devices:registerWeb')).toHaveBeenCalledWith({ publicKey: K.me.publicKey, name: expect.any(String) }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Now' }))
    const title = await sendTitle('Vyndej prádlo z pračky')

    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(1))
    const args = sends()[0]
    expect(args).toMatchObject({ to: DOMINIK, forAgent: false, urgency: 'red' })
    expect(args.ref).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(typeof args.dueAt).toBe('number')
    expect(args.repeat).toBeUndefined()
    // The server only ever sees ciphertext.
    expect(JSON.stringify(args)).not.toContain('prádlo')
    expect(args).not.toHaveProperty('title')

    // One envelope per Mac of Dominik; the sender's copy for this browser and my Mac.
    expect(args.envelopes.map((e: { deviceId: string }) => e.deviceId)).toEqual([`mac-${DOMINIK}`])
    expect(args.titleEnvelopes.map((e: { deviceId: string }) => e.deviceId).sort()).toEqual(['mac-me', WEB])
    expect(await openFor(K.dominikMac.privateKey, 'title', args.ref, args.envelopes[0])).toBe('Vyndej prádlo z pračky')
    const mine = args.titleEnvelopes.find((e: { deviceId: string }) => e.deviceId === WEB)
    expect(await openFor(K.me.privateKey, 'title', args.ref, mine)).toBe('Vyndej prádlo z pračky')
    const onMyMac = args.titleEnvelopes.find((e: { deviceId: string }) => e.deviceId === 'mac-me')
    expect(await openFor(K.myMac.privateKey, 'title', args.ref, onMyMac)).toBe('Vyndej prádlo z pračky')
    // Bound to its ref and both people: another ref or recipient does not open.
    await expect(openFor(K.dominikMac.privateKey, 'title', 'AAAAAAAAAAAAAAAAAAAAAA', args.envelopes[0])).rejects.toThrow()
    await expect(openFor(K.dominikMac.privateKey, 'title', args.ref, args.envelopes[0], VIKI)).rejects.toThrow()

    // The row is there right away, behind the sent icon with its count.
    expect(title).toHaveValue('')
    expect(sentToggle()).toHaveAccessibleName('Sent: 1')
    fireEvent.click(sentToggle())
    expect(screen.getByText('Vyndej prádlo z pračky')).toBeInTheDocument()
    expect(shownWords(view.container)).toEqual(['sending'])
  })

  it('seals for this browser even before the contact list knows it', async () => {
    const view = contactsView(K.me, [dominik()])
    if (view.status === 'member') view.me.devices = []
    member([], [], view)
    h.results['messages:send'] = { ok: true, ref: 'x' }
    render(<App />)
    await sendTitle('Ahoj')
    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(1))
    expect(sends()[0].titleEnvelopes.map((e: { deviceId: string }) => e.deviceId)).toEqual([WEB])
  })

  it('on stale devices seals again for the lists the server sent, once, with the same ref', async () => {
    member()
    const fresh = [{ deviceId: 'mac-new', kind: 'mac', publicKey: K.vikiMac.publicKey }]
    h.mutations['messages:send'] = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'stale-devices', devices: fresh, myDevices: [{ deviceId: WEB, kind: 'web', publicKey: K.me.publicKey }] })
      .mockResolvedValueOnce({ ok: true, ref: 'x' })
    render(<App />)
    await sendTitle('Zalij kytky')
    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(2))
    const [first, second] = sends()
    expect(second.ref).toBe(first.ref)
    expect(second.envelopes.map((e: { deviceId: string }) => e.deviceId)).toEqual(['mac-new'])
    expect(second.titleEnvelopes.map((e: { deviceId: string }) => e.deviceId)).toEqual([WEB])
    expect(await openFor(K.vikiMac.privateKey, 'title', second.ref, second.envelopes[0])).toBe('Zalij kytky')
  })

  it('a failed send puts the text back and says so', async () => {
    member()
    h.results['messages:send'] = { ok: false, error: 'rate-limited' }
    render(<App />)
    const title = await sendTitle('Pojď na oběd')
    expect(await screen.findByText('Too many pings. Try again in a moment.')).toBeInTheDocument()
    expect(title).toHaveValue('Pojď na oběd')
  })

  it('sends to the agent: no "later", forAgent, and the row is marked', async () => {
    member()
    h.results['messages:send'] = { ok: true, ref: 'x' }
    render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    expect(screen.getByRole('radio', { name: 'Dominik' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Agent' }))
    const title = screen.getByRole('textbox', { name: 'Message for the agent' })
    expect(title).toHaveAttribute('placeholder', 'Give the agent a job…')
    expect(screen.queryByRole('button', { name: 'Send later' })).toBeNull()
    await sendTitle('Mrkni na pozvánky', 'Message for the agent')

    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(1))
    expect(sends()[0]).toMatchObject({ to: DOMINIK, forAgent: true })
    expect(sends()[0]).not.toHaveProperty('dueAt')
    fireEvent.click(sentToggle())
    expect(screen.getByText('Agent', { selector: '.it-to .vh' })).toBeInTheDocument()
    // The choice stays for the next message.
    expect(screen.getByRole('radio', { name: 'Agent' })).toBeChecked()
  })

  it('registers again when the server no longer knows this browser', async () => {
    member()
    h.queries['messages:mine'] = { status: 'member', deviceActive: false, rows: [] }
    render(<App />)
    await waitFor(() => expect(mutation('devices:registerWeb')).toHaveBeenCalledTimes(2))
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(mutation('devices:registerWeb')).toHaveBeenCalledTimes(2)
    expect(h.queryArgs['messages:mine']).toEqual({ deviceId: WEB })
  })
})

describe('who it goes to', () => {
  it('one contact: the form as before, their name in the placeholder, a dot while online', async () => {
    member()
    const view = render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    expect(title).toHaveAttribute('placeholder', 'Ping Dominik…')
    expect(screen.queryByRole('button', { name: /^To:/ })).toBeNull()
    const person = screen.getByRole('radio', { name: 'Dominik' })
    expect(person.closest('label')?.querySelector('.on-dot')).not.toBeNull()
    expect(view.container.querySelectorAll('.face')).toHaveLength(0)
  })

  it('one contact offline: no dot, sending still works and the row waits', async () => {
    member([], [contact({ userId: DOMINIK, name: 'Dominik', macLastSeen: Date.now() - 20 * 60_000, online: false }, K.dominikMac)])
    h.results['messages:send'] = { ok: true, ref: 'x' }
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    expect(screen.getByRole('radio', { name: 'Dominik' }).closest('label')?.querySelector('.on-dot')).toBeNull()
    expect(screen.getByRole('button', { name: 'Send' })).not.toHaveAttribute('aria-disabled')
    await sendTitle('Až budeš u Macu')
    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(1))
    fireEvent.click(sentToggle())
    expect(shownWords(view.container)).toEqual(['waiting'])
  })

  it('a contact without the app: grey, "No app yet", and nothing is sent', async () => {
    member([], [contact({ userId: DOMINIK, name: 'Dominik' })])
    render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    const person = screen.getByRole('radio', { name: 'Dominik, no app yet' })
    expect(person.closest('label')).toHaveClass('nomac')
    expect(person.closest('label')).toHaveAttribute('title', 'No app yet')
    const go = screen.getByRole('button', { name: 'Send' })
    expect(go).toHaveAttribute('aria-disabled', 'true')
    expect(go).toHaveAttribute('title', 'No app yet')
    await sendTitle('Ahoj')
    expect(await screen.findByText('No app yet.')).toBeInTheDocument()
    expect(title).toHaveValue('Ahoj')
    await act(() => new Promise((r) => setTimeout(r, 10)))
    expect(mutation('messages:send')).not.toHaveBeenCalled()
  })

  it('two or more contacts: a picker of initials with online dots, sending to the one picked', async () => {
    const viki = contact({ userId: VIKI, name: 'Viki' }, K.vikiMac)
    const offline = contact({ userId: 'u-off', name: 'Michal Novák', macLastSeen: Date.now() - 3_600_000, online: false }, K.stranger)
    const noApp = contact({ userId: 'u-none', name: 'Jana' })
    member([], [dominik(), noApp, offline, viki])
    h.results['messages:send'] = { ok: true, ref: 'x' }
    const view = render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    // The first contact with the app is chosen; the old person/agent pair is gone.
    const picker = screen.getByRole('button', { name: 'To: Dominik' })
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(title).toHaveAttribute('placeholder', 'Ping Dominik…')
    expect(screen.queryByRole('radio', { name: 'Dominik' })).toBeNull()

    fireEvent.click(picker)
    expect(picker).toHaveAttribute('aria-expanded', 'true')
    const list = screen.getByRole('group', { name: 'To' })
    const faces = Array.from(list.querySelectorAll('.face')).map((f) => [f.textContent, f.classList.contains('nomac'), !!f.querySelector('.on-dot')])
    expect(faces).toEqual([
      ['D', false, true],
      ['J', true, false],
      ['MN', false, false],
      ['V', false, true],
    ])
    expect(within(list).getByText('No app yet')).toBeInTheDocument()

    fireEvent.click(within(list).getByRole('radio', { name: 'Viki' }), { detail: 1 })
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'To: Viki' })).toBeInTheDocument()
    expect(title).toHaveAttribute('placeholder', 'Ping Viki…')

    await sendTitle('Máš chvilku?')
    await waitFor(() => expect(mutation('messages:send')).toHaveBeenCalledTimes(1))
    expect(sends()[0].to).toBe(VIKI)
    expect(sends()[0].envelopes.map((e: { deviceId: string }) => e.deviceId)).toEqual([`mac-${VIKI}`])
    expect(await openFor(K.vikiMac.privateKey, 'title', sends()[0].ref, sends()[0].envelopes[0], VIKI)).toBe('Máš chvilku?')

    // Picking the one without the app greys out sending.
    fireEvent.click(screen.getByRole('button', { name: 'To: Viki' }))
    fireEvent.click(within(list).getByRole('radio', { name: 'Jana, no app yet' }), { detail: 1 })
    expect(screen.getByRole('button', { name: 'To: Jana, no app yet' })).toHaveAttribute('title', 'No app yet')
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true')

    // The agent is a toggle next to the picker. With 2+ contacts each row says who it went to.
    expect(screen.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(sentToggle())
    expect(view.container.querySelector('.it-who')).toHaveAttribute('title', 'Viki')
  })

  it('the picker closes with Escape and a press outside, and Enter does not send', async () => {
    member([], [dominik(), contact({ userId: VIKI, name: 'Viki' }, K.vikiMac)])
    render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    const picker = screen.getByRole('button', { name: 'To: Dominik' })
    fireEvent.click(picker)
    const viki = within(screen.getByRole('group', { name: 'To' })).getByRole('radio', { name: 'Viki' })
    fireEvent.keyDown(viki, { key: 'Enter' })
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(picker).toHaveFocus()
    fireEvent.click(picker)
    fireEvent.keyDown(viki, { key: 'Escape' })
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(picker)
    fireEvent.pointerDown(document.body)
    expect(picker).toHaveAttribute('aria-expanded', 'false')
    expect(mutation('messages:send')).not.toHaveBeenCalled()
  })
})

describe('the sent list opens on this device', () => {
  it('opens the later options with day, time and the six repeat options', async () => {
    member()
    render(<App />)
    const when = await screen.findByRole('button', { name: 'Send later' })
    expect(when).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox', { name: 'Repeat' })).toBeNull()
    fireEvent.click(when)
    expect(when).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Day')).toBeVisible()
    expect(screen.getByLabelText('Time')).toBeVisible()
    const repeat = screen.getByRole('combobox', { name: 'Repeat' })
    expect(Array.from((repeat as HTMLSelectElement).options).map((o) => [o.value, o.text])).toEqual([
      ['', 'Once'],
      ['daily', 'Every day'],
      ['weekdays', 'Weekdays'],
      ['weekly', 'Every week'],
      ['biweekly', 'Every 2 weeks'],
      ['monthly', 'Every month'],
    ])
  })

  it('decrypts every row and shows its status word', async () => {
    const now = Date.now()
    const rows = [
      await sentRow(K.me, { status: 'queued' }),
      await sentRow(K.me, { status: 'popped' }),
      await sentRow(K.me, { status: 'seen' }),
      await sentRow(K.me, { status: 'seen', typingUntil: now + 5000 }),
      await sentRow(K.me, { status: 'replied', replyText: 'Jdu na to' }),
      await sentRow(K.me, { status: 'done' }),
      await sentRow(K.me, { status: 'snoozed', snoozedUntil: now + 10 * 60_000 - 1000 }),
      await sentRow(K.me, { status: 'waiting' }),
      await sentRow(K.me, { status: 'waiting', dueAt: new Date(new Date(now + 86_400_000).setHours(9, 30, 0, 0)).getTime() }),
    ]
    member(rows)
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    expect(view.container.querySelectorAll('.it')).toHaveLength(0)
    await waitFor(() => expect(sentToggle()).toHaveAccessibleName('Sent: 9, new reply'))
    fireEvent.click(sentToggle())
    await waitFor(() => expect(screen.getAllByText('Pošli mi fotky z hor')).toHaveLength(9))
    expect(shownWords(view.container)).toEqual(['sending', 'popped up', 'seen', 'typing', 'reply', 'done', 'in 10 min', 'waiting', 'tomorrow 9:30'])
    expect(screen.getByText('Jdu na to')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.it.gone')).toHaveLength(1)
  })

  it('a text sealed for another device says so instead of failing', async () => {
    member([
      await sentRow(K.me, { text: null, status: 'seen' }),
      await sentRow(K.stranger, { text: 'Cizí klíč', status: 'replied', replyText: 'Taky cizí' }),
      { ...(await sentRow(K.me, { text: 'Ráno', status: 'replied' })), replyAt: Date.now() },
    ])
    h.results['messages:ackReply'] = true
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    fireEvent.click(sentToggle())
    await waitFor(() => expect(screen.getAllByText('Text is on another device.')).toHaveLength(2))
    expect(screen.getByText('Ráno')).toBeInTheDocument()
    expect(screen.getAllByText('Reply is on another device.')).toHaveLength(2)
    expect(screen.queryByText('Cizí klíč')).toBeNull()
    expect(screen.queryByText('Taky cizí')).toBeNull()
    expect(view.container.querySelectorAll('.it-ph')).toHaveLength(0)
  })

  it('acks a shown reply once and keeps it here after the server drops this copy', async () => {
    const pending = await sentRow(K.me, { status: 'replied', replyText: 'Za chvíli' })
    member([pending])
    h.results['messages:ackReply'] = true
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })

    // Closed list: the reply is not on screen, so it is not acked. The icon wears a badge instead.
    await waitFor(() => expect(sentToggle()).toHaveAccessibleName('Sent: 1, new reply'))
    expect(screen.getByTestId('reply-badge')).toBeInTheDocument()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mutation('messages:ackReply')).not.toHaveBeenCalled()

    fireEvent.click(sentToggle())
    await screen.findByText('Za chvíli')
    await waitFor(() => expect(mutation('messages:ackReply')).toHaveBeenCalledWith({ ref: pending.ref, deviceId: WEB }))
    expect(await vaultGet('replies')).toEqual({ [pending.ref]: 'Za chvíli' })

    // The server dropped this device's copy: the row keeps the text, not "another device".
    member([{ ...pending, reply: null }])
    view.rerender(<App />)
    expect(mutation('messages:ackReply')).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Za chvíli')).toBeInTheDocument()
    expect(screen.queryByText('Reply is on another device.')).toBeNull()
    expect(screen.queryByTestId('reply-badge')).toBeNull()

    // A reload: the reply comes back from this browser's own store.
    cleanup()
    resetDeviceKey()
    render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    fireEvent.click(sentToggle())
    expect(await screen.findByText('Za chvíli')).toBeInTheDocument()
    expect(mutation('messages:ackReply')).toHaveBeenCalledTimes(1)
  })
})

describe('connect your agent', () => {
  it('a small button under the form opens one sentence to copy and the repo link', async () => {
    member()
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = render(<App />)
    const button = await screen.findByRole('button', { name: 'Connect your agent' })
    expect(view.container.querySelectorAll('.cn-faces .ico')).toHaveLength(3)
    expect(button).toHaveAttribute('aria-expanded', 'false')
    const sentence = 'Install pingme from https://github.com/kroufekd/pingme and connect it to my account.'
    // Closed, the panel is out of reach (the stylesheet also takes it out of the layout).
    const panel = screen.getByText(sentence).closest('.cn-p')
    expect(panel).toHaveAttribute('aria-hidden', 'true')
    expect(panel).not.toHaveClass('on')
    // It is the last thing on the page, after the sent list: opening it moves nothing above.
    expect(view.container.querySelector('main')?.lastElementChild).toHaveClass('cn')

    fireEvent.click(button)
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel).not.toHaveAttribute('aria-hidden')
    expect(panel).toHaveClass('on')
    expect(screen.getByRole('link', { name: /github\.com\/kroufekd\/pingme/ })).toHaveAttribute('href', 'https://github.com/kroufekd/pingme')
    // Says why it is safe before anyone pastes it.
    expect(panel).toHaveTextContent('End-to-end encrypted.')
    expect(panel).toHaveTextContent('You connect the Mac.')

    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(sentence))
    // One copy per click, though the button sits inside the card that also copies.
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    // A click anywhere on the prompt copies it too.
    fireEvent.click(screen.getByText(sentence))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))

    fireEvent.keyDown(panel!, { key: 'Escape' })
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button).toHaveFocus()
  })

  it('opens one panel at a time: Devices closes the agent panel', async () => {
    member()
    render(<App />)
    const agent = await screen.findByRole('button', { name: 'Connect your agent' })
    const devices = screen.getByRole('button', { name: /^Devices/ })
    fireEvent.click(agent)
    expect(agent).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(devices)
    expect(devices).toHaveAttribute('aria-expanded', 'true')
    expect(agent).toHaveAttribute('aria-expanded', 'false')
  })

  it('without a clipboard it selects the sentence instead of failing', async () => {
    member()
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => Promise.reject(new Error('denied'))) }, configurable: true })
    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Connect your agent' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
    await waitFor(() => expect(window.getSelection()?.toString()).toContain('Install pingme'))
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument()
  })
})

describe('validation', () => {
  it('never leaves validation to the browser', async () => {
    member()
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    const forms = Array.from(view.container.querySelectorAll('form'))
    expect(forms).toHaveLength(3)
    for (const form of forms) expect(form.noValidate).toBe(true)
    expect(view.container.querySelectorAll('[required], [pattern]')).toHaveLength(0)
    expect(screen.getByLabelText('Email', { selector: 'input' })).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('Email', { selector: 'input' })).toHaveAttribute('autocomplete', 'email')
    expect(view.container.querySelector('#u-code')).toHaveAttribute('autocomplete', 'one-time-code')
    expect(view.container.querySelector('#u-code')).toHaveAttribute('inputmode', 'numeric')
  })

  it('email: quiet until the first failed submit, then checks while typing', async () => {
    render(<App />)
    const input = await screen.findByLabelText('Email')
    const send = screen.getByRole('button', { name: 'Send code' })

    fireEvent.change(input, { target: { value: 'franta' } })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Missing the @.')).toBeNull()

    fireEvent.click(send)
    expect(screen.getByText('Missing the @.')).toHaveAttribute('aria-live', 'polite')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()
    expect(input.closest('form')).toHaveClass('bad')
    expect(h.signIn).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'franta@' } })
    expect(screen.getByText('Missing the domain.')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'fran ta@example.com' } })
    expect(screen.getByText('No spaces in an email.')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('Enter your email.')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'franta@example.com' } })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input.closest('form')).not.toHaveClass('bad')
    fireEvent.click(send)
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@example.com' }))
  })

  it('email: an empty submit says so and sends nothing', async () => {
    render(<App />)
    await screen.findByLabelText('Email')
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    expect(screen.getByText('Enter your email.')).toBeInTheDocument()
    expect(h.signIn).not.toHaveBeenCalled()
  })

  it('email: a likely typo holds the first submit and one tap sends the fixed address', async () => {
    render(<App />)
    await typeEmail('franta@gmial.com')
    const fix = screen.getByRole('button', { name: 'Fix to franta@gmail.com' })
    expect(fix).toHaveTextContent('franta@gmail.com')
    expect(screen.getByLabelText('Email')).not.toHaveAttribute('aria-invalid')
    expect(h.signIn).not.toHaveBeenCalled()

    fireEvent.click(fix)
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@gmail.com' }))
    expect(h.signIn).toHaveBeenCalledTimes(1)
  })

  it('email: sending the same address again goes through as typed', async () => {
    render(<App />)
    await typeEmail('franta@gmial.com')
    expect(h.signIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }))
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@gmial.com' }))
  })

  it('email: a server hint goes away once the address is edited', async () => {
    h.signIn.mockRejectedValueOnce(new Error('NOT_INVITED'))
    render(<App />)
    await typeEmail('nekdo@example.com')
    await screen.findByText("Couldn't send a code to this email.")
    expect(screen.getByLabelText('Email').closest('form')).toHaveClass('bad')
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'nekdo.jiny@example.com' } })
    expect(screen.queryByText("Couldn't send a code to this email.")).toBeNull()
    expect(screen.getByLabelText('Email').closest('form')).not.toHaveClass('bad')
  })

  it('code: takes a pasted code with spaces, drops letters, and says when it is short', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    const code = await codeField()
    expect(code).not.toHaveAttribute('maxlength')

    fireEvent.change(code, { target: { value: '41a9' } })
    expect(code).toHaveValue('419')
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(screen.getByText('The code has 6 digits.')).toHaveAttribute('aria-live', 'polite')
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(h.signIn).toHaveBeenCalledTimes(1)

    h.signIn.mockResolvedValueOnce({ signingIn: true })
    fireEvent.change(code, { target: { value: ' 419 275 ' } })
    expect(screen.queryByText('The code has 6 digits.')).toBeNull()
    await waitFor(() => expect(h.signIn).toHaveBeenLastCalledWith('resend-otp', { email: 'franta@example.com', code: '419275' }))
  })

  it('code: a wrong code is marked until the next digit', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    const code = await codeField()
    h.signIn.mockRejectedValueOnce(new Error('Could not verify code'))
    fireEvent.change(code, { target: { value: '000000' } })
    await screen.findByText("That code doesn't match.")
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(code.closest('form')).toHaveClass('bad')
    await waitFor(() => expect(code).not.toHaveAttribute('readonly'))
    fireEvent.change(code, { target: { value: '4' } })
    expect(screen.queryByText("That code doesn't match.")).toBeNull()
    expect(code).not.toHaveAttribute('aria-invalid')
  })

  it('task: sending nothing nudges the field without a visible message', async () => {
    member()
    render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(title).toHaveFocus()
    expect(title.closest('.line')).toHaveClass('nudge-a')
    expect(screen.getByText('Write what you need.')).toHaveClass('vh')
    expect(mutation('messages:send')).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(title.closest('.line')).toHaveClass('nudge-b')
    fireEvent.change(title, { target: { value: 'A' } })
    expect(title).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Write what you need.')).toBeNull()
  })

  it('task: the count shows only near the limit', async () => {
    member()
    const view = render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    const count = view.container.querySelector('#u-count')
    fireEvent.change(title, { target: { value: 'a'.repeat(169) } })
    expect(count).not.toHaveClass('on')
    expect(title).toHaveAttribute('aria-describedby', 'u-form-note')
    fireEvent.change(title, { target: { value: 'a'.repeat(188) } })
    expect(count).toHaveClass('on')
    expect(count).toHaveTextContent('12')
    expect(screen.getByText('12 characters left')).toBeInTheDocument()
    expect(title).toHaveAttribute('aria-describedby', 'u-form-note u-count')
    fireEvent.change(title, { target: { value: 'a'.repeat(200) } })
    expect(count).toHaveClass('full')
  })

  it('task: "later" in the past is marked at once and is not sent', async () => {
    member()
    render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Ping' })
    fireEvent.click(screen.getByRole('button', { name: 'Send later' }))
    const day = screen.getByLabelText('Day')
    expect(day).not.toHaveAttribute('aria-invalid')

    fireEvent.change(day, { target: { value: '2020-01-01' } })
    expect(screen.getByText('That time has passed.')).toHaveAttribute('aria-live', 'polite')
    expect(day).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Time')).toHaveAttribute('aria-invalid', 'true')
    expect(day.closest('.pf-later')).toHaveClass('bad')

    fireEvent.change(title, { target: { value: 'Zalij kytky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(mutation('messages:send')).not.toHaveBeenCalled()
    expect(title).toHaveValue('Zalij kytky')

    fireEvent.change(day, { target: { value: '2999-01-01' } })
    expect(screen.getByText("That time doesn't work.")).toBeInTheDocument()
    fireEvent.change(day, { target: { value: '' } })
    expect(screen.getByText('Pick a day and time.')).toBeInTheDocument()
  })
})
