import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Row } from '@/lib/tasks'

// A tiny fake of Convex and Convex Auth: tests set what the queries return and
// read what the mutations got, by function name ("tasks:mine", "relay:create", ...).
const h = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  queries: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
  results: {} as Record<string, unknown>,
  signIn: vi.fn(),
  signOut: vi.fn(),
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
  useAuthActions: () => ({ signIn: h.signIn, signOut: h.signOut }),
}))

const { App } = await import('@/components/app/app')

function mutation(name: string) {
  if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => h.results[name])
  return h.mutations[name]
}

function member(rows: Row[]) {
  h.auth.isAuthenticated = true
  h.queries['senders:me'] = { status: 'member', name: 'Franta', senderId: 's1' }
  h.queries['tasks:mine'] = { status: 'member', name: 'Franta', macLastSeen: null, snapshotAt: null, rows }
}

function row(over: Partial<Row>): Row {
  return {
    taskRef: 't1',
    title: 'Pošli mi fotky z hor',
    urgency: 'orange',
    dueAt: Date.now(),
    status: 'queued',
    statusAt: Date.now(),
    replyPending: false,
    createdAt: Date.now(),
    ...over,
  }
}

/** The word of each row's status right now. Rows show an icon only, the word is its tooltip. */
function shownWords(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.it')).map((li) => li.querySelector('.st')?.getAttribute('title'))
}

/** The sent list is closed until its small icon is pressed. */
function sentToggle() {
  return screen.getByRole('button', { name: /^Odeslané/ })
}

async function typeEmail(email: string) {
  const input = await screen.findByLabelText('E-mail')
  fireEvent.change(input, { target: { value: email } })
  fireEvent.click(screen.getByRole('button', { name: 'Poslat kód' }))
}

/** The code field, once it takes typing (it is read-only while the code is being sent). */
async function codeField() {
  const code = await screen.findByRole('textbox', { name: 'Šestimístný kód' })
  await waitFor(() => expect(code).not.toHaveAttribute('readonly'))
  return code
}

beforeEach(() => {
  h.auth.isLoading = false
  h.auth.isAuthenticated = false
  h.queries = {}
  h.mutations = {}
  h.results = {}
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
    expect(code).toHaveAttribute('placeholder', 'Kód z e-mailu')
    expect(code.closest('form')).toHaveClass('on')
    expect(screen.getByRole('button', { name: 'Jiný e-mail než franta@example.com' })).toBeInTheDocument()
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
    expect(await screen.findByText('Kód nesedí.')).toBeInTheDocument()
    expect(code).toHaveValue('')
  })

  it('stays on the email state with a quiet hint when the email is not invited', async () => {
    h.signIn.mockRejectedValueOnce(new Error('NOT_INVITED'))
    render(<App />)
    await typeEmail('nekdo@example.com')
    // The note is a polite live region that is always there; the hint is its text.
    const note = await screen.findByText('Na tenhle e-mail kód nepřijde.')
    expect(note).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('aria-describedby', note.id)
    expect(screen.getByLabelText('E-mail')).toHaveValue('nekdo@example.com')
    expect(screen.getByLabelText('E-mail').closest('form')).toHaveClass('on')
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

  it('drops the token and the ?i param once the claim is ok', async () => {
    // Like Convex: when the claim resolves, senders.me already says member.
    h.mutations['inviteLinks:claim'] = vi.fn(async () => {
      member([])
      return { ok: true, name: 'Franta' }
    })
    const view = await signInWithLink()
    h.auth.isAuthenticated = true
    h.queries['senders:me'] = { status: 'notMember', email: 'franta@example.com' }
    view.rerender(<App />)
    await waitFor(() => expect(localStorage.getItem('pingme.invite')).toBeNull())
    expect(window.location.search).toBe('')
    expect(mutation('inviteLinks:claim')).toHaveBeenCalledTimes(1)
    const title = await screen.findByRole('textbox', { name: 'Úkol' })
    await waitFor(() => expect(title).toHaveFocus())
    expect(h.signOut).not.toHaveBeenCalled()
  })
})

describe('the form and the sent list', () => {
  it('sends with urgency and no token, and shows the row as "letí" right away', async () => {
    member([])
    h.results['relay:create'] = { ok: true, id: 'cmd1' }
    const view = render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Úkol' })
    fireEvent.click(screen.getByRole('radio', { name: 'Hned' }))
    fireEvent.change(title, { target: { value: 'Vyndej prádlo z pračky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Poslat' }))

    await waitFor(() => expect(mutation('relay:create')).toHaveBeenCalledTimes(1))
    const args = mutation('relay:create').mock.calls[0][0]
    expect(args).toMatchObject({ title: 'Vyndej prádlo z pračky', urgency: 'red', repeat: undefined })
    expect(typeof args.dueAt).toBe('number')
    expect(args).not.toHaveProperty('token')
    expect(mutation('relay:ping')).toHaveBeenCalledWith({})
    // The row is there right away, behind the sent icon with its count.
    expect(screen.queryByText('Vyndej prádlo z pračky')).toBeNull()
    expect(sentToggle()).toHaveAccessibleName('Odeslané: 1')
    expect(sentToggle()).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(sentToggle())
    expect(sentToggle()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Vyndej prádlo z pračky')).toBeInTheDocument()
    expect(shownWords(view.container)).toEqual(['letí'])
    expect(title).toHaveValue('')
  })

  it('sends to the agent: no "later", to=agent, and the row is marked', async () => {
    member([])
    h.results['relay:create'] = { ok: true, id: 'cmd2' }
    render(<App />)
    await screen.findByRole('textbox', { name: 'Úkol' })
    expect(screen.getByRole('radio', { name: 'Dominik' })).toBeChecked()
    fireEvent.click(screen.getByRole('radio', { name: 'Agent' }))
    const title = screen.getByRole('textbox', { name: 'Zpráva pro agenta' })
    expect(title).toHaveAttribute('placeholder', 'Zadej práci agentovi…')
    expect(screen.queryByRole('button', { name: 'Poslat později' })).toBeNull()
    fireEvent.change(title, { target: { value: 'Mrkni na pozvánky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Poslat' }))

    await waitFor(() => expect(mutation('relay:create')).toHaveBeenCalledTimes(1))
    expect(mutation('relay:create').mock.calls[0][0]).toMatchObject({ title: 'Mrkni na pozvánky', to: 'agent', repeat: undefined })
    fireEvent.click(sentToggle())
    expect(screen.getByText('Agent', { selector: '.it-to .vh' })).toBeInTheDocument()
    // The choice stays for the next message.
    expect(screen.getByRole('radio', { name: 'Agent' })).toBeChecked()
  })

  it('opens "later" with day, time and the six repeat options', async () => {
    member([])
    render(<App />)
    const when = await screen.findByRole('button', { name: 'Poslat později' })
    expect(when).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('combobox', { name: 'Opakování' })).toBeNull()
    fireEvent.click(when)
    expect(when).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText('Den')).toBeVisible()
    expect(screen.getByLabelText('Čas')).toBeVisible()
    const repeat = screen.getByRole('combobox', { name: 'Opakování' })
    expect(Array.from((repeat as HTMLSelectElement).options).map((o) => [o.value, o.text])).toEqual([
      ['', 'Jednou'],
      ['daily', 'Každý den'],
      ['weekdays', 'Pracovní dny'],
      ['weekly', 'Každý týden'],
      ['biweekly', 'Po 14 dnech'],
      ['monthly', 'Každý měsíc'],
    ])
  })

  it('shows the status word of every row', async () => {
    const now = Date.now()
    member([
      row({ taskRef: 'a', status: 'queued' }),
      row({ taskRef: 'b', status: 'popped' }),
      row({ taskRef: 'c', status: 'seen' }),
      row({ taskRef: 'd', status: 'seen', typingUntil: now + 5000 }),
      row({ taskRef: 'e', status: 'replied', reply: 'Jdu na to' }),
      row({ taskRef: 'f', status: 'done' }),
      row({ taskRef: 'g', status: 'snoozed', snoozedUntil: now + 10 * 60_000 - 1000 }),
      row({ taskRef: 'h', status: 'waiting', dueAt: null }),
      row({ taskRef: 'i', status: 'queued', title: null }),
    ])
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Úkol' })
    expect(view.container.querySelectorAll('.it')).toHaveLength(0)
    expect(sentToggle()).toHaveAccessibleName('Odeslané: 9')
    fireEvent.click(sentToggle())
    await waitFor(() => expect(view.container.querySelectorAll('.it')).toHaveLength(9))
    // Icon only: no status word is on screen, it is the tooltip and the spoken text.
    expect(view.container.querySelectorAll('.st small')).toHaveLength(0)
    expect(shownWords(view.container)).toEqual(['letí', 'vyskočilo', 'viděl', 'píše', 'odpověď', 'hotovo', 'za 10 min', 'čeká', 'letí'])
    expect(screen.getByText('Jdu na to')).toBeInTheDocument()
    expect(view.container.querySelectorAll('.it.gone')).toHaveLength(1)
    expect(view.container.querySelectorAll('.it-ph')).toHaveLength(1)
  })

  it('acks a pending reply once, and keeps showing it after the server forgets it', async () => {
    const pending = row({ taskRef: 'r1', status: 'replied', reply: 'Za chvíli', replyAt: 111, replyPending: true })
    member([pending])
    h.results['tasks:ackReply'] = true
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Úkol' })

    // Closed list: the reply is not on screen, so it is not acked. The icon wears a badge instead.
    expect(sentToggle()).toHaveAccessibleName('Odeslané: 1, nová odpověď')
    expect(screen.getByTestId('reply-badge')).toBeInTheDocument()
    expect(screen.queryByText('Za chvíli')).toBeNull()
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(mutation('tasks:ackReply')).not.toHaveBeenCalled()

    fireEvent.click(sentToggle())
    await screen.findByText('Za chvíli')
    await waitFor(() => expect(mutation('tasks:ackReply')).toHaveBeenCalledWith({ taskRef: 'r1' }))
    expect(screen.queryByTestId('reply-badge')).toBeNull()

    member([{ ...pending }])
    view.rerender(<App />)
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    member([{ ...pending, reply: undefined, replyAt: undefined, replyPending: false }])
    view.rerender(<App />)

    expect(mutation('tasks:ackReply')).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Za chvíli')).toBeInTheDocument()

    // Closing and opening again keeps the reply, and does not ack it twice.
    fireEvent.click(sentToggle())
    expect(screen.queryByText('Za chvíli')).toBeNull()
    fireEvent.click(sentToggle())
    expect(screen.getByText('Za chvíli')).toBeInTheDocument()
    expect(mutation('tasks:ackReply')).toHaveBeenCalledTimes(1)
  })
})

describe('validation', () => {
  it('never leaves validation to the browser', async () => {
    member([])
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Úkol' })
    const forms = Array.from(view.container.querySelectorAll('form'))
    expect(forms).toHaveLength(3)
    for (const form of forms) expect(form.noValidate).toBe(true)
    expect(view.container.querySelectorAll('[required], [pattern]')).toHaveLength(0)
    expect(screen.getByLabelText('E-mail', { selector: 'input' })).toHaveAttribute('type', 'email')
    expect(screen.getByLabelText('E-mail', { selector: 'input' })).toHaveAttribute('autocomplete', 'email')
    expect(view.container.querySelector('#u-code')).toHaveAttribute('autocomplete', 'one-time-code')
    expect(view.container.querySelector('#u-code')).toHaveAttribute('inputmode', 'numeric')
  })

  it('email: quiet until the first failed submit, then checks while typing', async () => {
    render(<App />)
    const input = await screen.findByLabelText('E-mail')
    const send = screen.getByRole('button', { name: 'Poslat kód' })

    fireEvent.change(input, { target: { value: 'franta' } })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Chybí zavináč.')).toBeNull()

    fireEvent.click(send)
    expect(screen.getByText('Chybí zavináč.')).toHaveAttribute('aria-live', 'polite')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveFocus()
    expect(input.closest('form')).toHaveClass('bad')
    expect(h.signIn).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: 'franta@' } })
    expect(screen.getByText('Chybí doména.')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'fran ta@example.com' } })
    expect(screen.getByText('E-mail nemá mezery.')).toBeInTheDocument()
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('Napiš e-mail.')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'franta@example.com' } })
    expect(input).not.toHaveAttribute('aria-invalid')
    expect(input.closest('form')).not.toHaveClass('bad')
    fireEvent.click(send)
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@example.com' }))
  })

  it('email: an empty submit says so and sends nothing', async () => {
    render(<App />)
    await screen.findByLabelText('E-mail')
    fireEvent.click(screen.getByRole('button', { name: 'Poslat kód' }))
    expect(screen.getByText('Napiš e-mail.')).toBeInTheDocument()
    expect(h.signIn).not.toHaveBeenCalled()
  })

  it('email: a likely typo holds the first submit and one tap sends the fixed address', async () => {
    render(<App />)
    await typeEmail('franta@gmial.com')
    const fix = screen.getByRole('button', { name: 'Opravit na franta@gmail.com' })
    expect(fix).toHaveTextContent('franta@gmail.com')
    expect(screen.getByLabelText('E-mail')).not.toHaveAttribute('aria-invalid')
    expect(h.signIn).not.toHaveBeenCalled()

    fireEvent.click(fix)
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@gmail.com' }))
    expect(h.signIn).toHaveBeenCalledTimes(1)
  })

  it('email: sending the same address again goes through as typed', async () => {
    render(<App />)
    await typeEmail('franta@gmial.com')
    expect(h.signIn).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Poslat kód' }))
    await waitFor(() => expect(h.signIn).toHaveBeenCalledWith('resend-otp', { email: 'franta@gmial.com' }))
  })

  it('email: a server hint goes away once the address is edited', async () => {
    h.signIn.mockRejectedValueOnce(new Error('NOT_INVITED'))
    render(<App />)
    await typeEmail('nekdo@example.com')
    await screen.findByText('Na tenhle e-mail kód nepřijde.')
    expect(screen.getByLabelText('E-mail').closest('form')).toHaveClass('bad')
    fireEvent.change(screen.getByLabelText('E-mail'), { target: { value: 'nekdo.jiny@example.com' } })
    expect(screen.queryByText('Na tenhle e-mail kód nepřijde.')).toBeNull()
    expect(screen.getByLabelText('E-mail').closest('form')).not.toHaveClass('bad')
  })

  it('code: takes a pasted code with spaces, drops letters, and says when it is short', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    const code = await codeField()
    expect(code).not.toHaveAttribute('maxlength')

    fireEvent.change(code, { target: { value: '41a9' } })
    expect(code).toHaveValue('419')
    fireEvent.click(screen.getByRole('button', { name: 'Přihlásit' }))
    expect(screen.getByText('Kód má 6 číslic.')).toHaveAttribute('aria-live', 'polite')
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(h.signIn).toHaveBeenCalledTimes(1)

    h.signIn.mockResolvedValueOnce({ signingIn: true })
    fireEvent.change(code, { target: { value: ' 419 275 ' } })
    expect(screen.queryByText('Kód má 6 číslic.')).toBeNull()
    await waitFor(() => expect(h.signIn).toHaveBeenLastCalledWith('resend-otp', { email: 'franta@example.com', code: '419275' }))
  })

  it('code: a wrong code is marked until the next digit', async () => {
    render(<App />)
    await typeEmail('franta@example.com')
    const code = await codeField()
    h.signIn.mockRejectedValueOnce(new Error('Could not verify code'))
    fireEvent.change(code, { target: { value: '000000' } })
    await screen.findByText('Kód nesedí.')
    expect(code).toHaveAttribute('aria-invalid', 'true')
    expect(code.closest('form')).toHaveClass('bad')
    await waitFor(() => expect(code).not.toHaveAttribute('readonly'))
    fireEvent.change(code, { target: { value: '4' } })
    expect(screen.queryByText('Kód nesedí.')).toBeNull()
    expect(code).not.toHaveAttribute('aria-invalid')
  })

  it('task: sending nothing nudges the field without a visible message', async () => {
    member([])
    render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Úkol' })
    fireEvent.click(screen.getByRole('button', { name: 'Poslat' }))
    expect(title).toHaveAttribute('aria-invalid', 'true')
    expect(title).toHaveFocus()
    expect(title.closest('.line')).toHaveClass('nudge-a')
    expect(screen.getByText('Napiš, co je potřeba.')).toHaveClass('vh')
    expect(mutation('relay:create')).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Poslat' }))
    expect(title.closest('.line')).toHaveClass('nudge-b')
    fireEvent.change(title, { target: { value: 'A' } })
    expect(title).not.toHaveAttribute('aria-invalid')
    expect(screen.queryByText('Napiš, co je potřeba.')).toBeNull()
  })

  it('task: the count shows only near the limit', async () => {
    member([])
    const view = render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Úkol' })
    const count = view.container.querySelector('#u-count')
    fireEvent.change(title, { target: { value: 'a'.repeat(169) } })
    expect(count).not.toHaveClass('on')
    expect(title).toHaveAttribute('aria-describedby', 'u-form-note')
    fireEvent.change(title, { target: { value: 'a'.repeat(188) } })
    expect(count).toHaveClass('on')
    expect(count).toHaveTextContent('12')
    expect(screen.getByText('Zbývá znaků: 12')).toBeInTheDocument()
    expect(title).toHaveAttribute('aria-describedby', 'u-form-note u-count')
    fireEvent.change(title, { target: { value: 'a'.repeat(200) } })
    expect(count).toHaveClass('full')
  })

  it('task: "later" in the past is marked at once and is not sent', async () => {
    member([])
    render(<App />)
    const title = await screen.findByRole('textbox', { name: 'Úkol' })
    fireEvent.click(screen.getByRole('button', { name: 'Poslat později' }))
    const day = screen.getByLabelText('Den')
    expect(day).not.toHaveAttribute('aria-invalid')

    fireEvent.change(day, { target: { value: '2020-01-01' } })
    expect(screen.getByText('Tenhle čas už byl.')).toHaveAttribute('aria-live', 'polite')
    expect(day).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByLabelText('Čas')).toHaveAttribute('aria-invalid', 'true')
    expect(day.closest('.pf-later')).toHaveClass('bad')

    fireEvent.change(title, { target: { value: 'Zalij kytky' } })
    fireEvent.click(screen.getByRole('button', { name: 'Poslat' }))
    expect(mutation('relay:create')).not.toHaveBeenCalled()
    expect(title).toHaveValue('Zalij kytky')

    fireEvent.change(day, { target: { value: '2999-01-01' } })
    expect(screen.getByText('Tenhle čas nejde.')).toBeInTheDocument()
    fireEvent.change(day, { target: { value: '' } })
    expect(screen.getByText('Vyber den a čas.')).toBeInTheDocument()
  })
})
