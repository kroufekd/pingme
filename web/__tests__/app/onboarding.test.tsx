import { readFileSync } from 'node:fs'
import path from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding, introLine, needsOnboarding } from '@/components/app/onboarding'

// The same tiny fake of Convex as page.test.tsx: queries and mutations by function name.
const h = vi.hoisted(() => ({
  auth: { isLoading: false, isAuthenticated: false },
  queries: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}))

vi.mock('convex/react', async () => {
  const { getFunctionName } = await import('convex/server')
  return {
    useConvexAuth: () => h.auth,
    useQuery: (ref: never, args: unknown) => (args === 'skip' ? undefined : h.queries[getFunctionName(ref)]),
    useMutation: (ref: never) => {
      const name = getFunctionName(ref)
      if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => null)
      return h.mutations[name]
    },
  }
})

vi.mock('@convex-dev/auth/react', () => ({
  useAuthActions: () => ({ signIn: vi.fn(), signOut: vi.fn(async () => undefined) }),
}))

const { App } = await import('@/components/app/app')

function mutation(name: string) {
  if (!h.mutations[name]) h.mutations[name] = vi.fn(async () => null)
  return h.mutations[name]
}

const person = (userId: string, name: string) => ({ userId, name, hasMac: true, online: true, macLastSeen: Date.now(), devices: [] })

function member(onboarded: boolean | undefined, extra: { inviterName?: string; contacts?: { userId: string; name: string }[] | null } = {}) {
  const { inviterName = 'Dominik', contacts = [{ userId: 'u-dom', name: 'Dominik' }] } = extra
  h.auth.isAuthenticated = true
  const base = { status: 'member', name: 'Franta', userId: 'u-me', ...(inviterName ? { inviterName } : {}) }
  h.queries['senders:me'] = onboarded === undefined ? base : { ...base, onboarded }
  if (contacts) h.queries['contacts:list'] = { status: 'member', me: { userId: 'u-me', name: 'Franta', devices: [] }, contacts: contacts.map((c) => person(c.userId, c.name)) }
  else delete h.queries['contacts:list']
  h.queries['messages:mine'] = { status: 'member', deviceActive: true, rows: [] }
}

/** The intro the app shows now: encrypted, naming who invited them. */
const APP_LINE = 'This offers Pretty Good Privacy, for you, me and our agents.'
/** The component's default (phase 1) line. */
const LINE = "Goes straight to Dominik's Mac."
const finished = () => mutation('senders:finishOnboarding')

// jsdom has no showModal/close: the smallest stand-in that behaves like a browser (close fires later, as a task).
const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>
beforeAll(() => {
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  proto.close = function (this: HTMLDialogElement) {
    if (!this.open) return
    this.removeAttribute('open')
    setTimeout(() => this.dispatchEvent(new Event('close')), 0)
  }
})
afterAll(() => {
  delete proto.showModal
  delete proto.close
})

function reduceMotion(on: boolean) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia
}

beforeEach(() => {
  h.auth.isLoading = false
  h.auth.isAuthenticated = false
  h.queries = {}
  h.mutations = {}
  localStorage.clear()
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('when the intro shows', () => {
  it('shows for a member who has not seen it, with the focus on its one button', async () => {
    member(false)
    render(<App />)
    const dialog = await screen.findByRole('dialog', { name: APP_LINE })
    expect(dialog).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Got it' })).toHaveFocus()
    expect(finished()).not.toHaveBeenCalled()
  })

  it('stays away once seen, from an older server without the flag, and when signed out', async () => {
    member(true)
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    expect(view.container.querySelector('dialog')).toBeNull()

    member(undefined)
    view.rerender(<App />)
    expect(view.container.querySelector('dialog')).toBeNull()

    h.auth.isAuthenticated = false
    h.queries = {}
    view.rerender(<App />)
    await screen.findByLabelText('Email')
    expect(view.container.querySelector('dialog')).toBeNull()
  })

  it('is encrypted, and waits until contacts are known', async () => {
    member(false, { inviterName: 'Michal', contacts: null })
    const view = render(<App />)
    await screen.findByRole('textbox', { name: 'Ping' })
    // No contacts yet: no dialog, so no default name flashes.
    expect(view.container.querySelector('dialog')).toBeNull()

    member(false, { inviterName: 'Michal', contacts: [{ userId: 'u-viki', name: 'Viki' }, { userId: 'u-mi', name: 'Michal' }] })
    view.rerender(<App />)
    const dialog = await screen.findByRole('dialog', { name: APP_LINE })
    expect(dialog.querySelectorAll('.ob-lock')).toHaveLength(2)
    cleanup()

    member(false, { inviterName: '', contacts: [{ userId: 'u-viki', name: 'Viki' }] })
    render(<App />)
    expect(await screen.findByRole('dialog', { name: APP_LINE })).toBeInTheDocument()
  })

  it('needsOnboarding is strict about the flag', () => {
    expect(needsOnboarding({ status: 'member', onboarded: false })).toBe(true)
    expect(needsOnboarding({ status: 'member', onboarded: true })).toBe(false)
    expect(needsOnboarding({ status: 'member' })).toBe(false)
    expect(needsOnboarding({ status: 'notMember' })).toBe(false)
    expect(needsOnboarding(undefined)).toBe(false)
  })
})

describe('closing it marks the account once', () => {
  it('"Got it" closes it, marks once, and hands the keyboard to the title field', async () => {
    member(false)
    const view = render(<App />)
    const dialog = await screen.findByRole('dialog', { name: APP_LINE })
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }))
    expect(finished()).toHaveBeenCalledTimes(1)
    expect(finished()).toHaveBeenCalledWith({})
    expect(dialog).not.toHaveAttribute('open')
    expect(screen.getByRole('textbox', { name: 'Ping' })).toHaveFocus()

    // The browser's own close event, and a second press, change nothing.
    await act(() => new Promise((r) => setTimeout(r, 5)))
    fireEvent.click(screen.getByRole('button', { name: 'Got it', hidden: true }))
    expect(finished()).toHaveBeenCalledTimes(1)

    // The flag still says false until the mutation lands: a re-render must not open it again.
    view.rerender(<App />)
    expect(dialog).not.toHaveAttribute('open')

    member(true)
    view.rerender(<App />)
    expect(view.container.querySelector('dialog')).toBeNull()
  })

  it('Esc closes it and marks once (keydown and the cancel event the browser sends)', async () => {
    member(false)
    render(<App />)
    const dialog = await screen.findByRole('dialog', { name: APP_LINE })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Got it' }), { key: 'Escape' })
    expect(finished()).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveAttribute('open')

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await act(() => new Promise((r) => setTimeout(r, 5)))
    expect(finished()).toHaveBeenCalledTimes(1)
  })

  it('the browser cancel event alone (Esc, back gesture) closes it too', async () => {
    member(false)
    render(<App />)
    const dialog = await screen.findByRole('dialog', { name: APP_LINE })
    const cancel = new Event('cancel', { cancelable: true })
    fireEvent(dialog, cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect(finished()).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveAttribute('open')
  })

  it('a click outside closes it, a drag that only ends outside does not', () => {
    const onDone = vi.fn()
    render(<Onboarding onDone={onDone} />)
    const dialog = screen.getByRole('dialog')

    fireEvent.pointerDown(screen.getByText(LINE))
    fireEvent.click(dialog)
    expect(onDone).not.toHaveBeenCalled()
    expect(dialog).toHaveAttribute('open')

    fireEvent.pointerDown(dialog)
    fireEvent.click(dialog)
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(dialog).not.toHaveAttribute('open')
  })
})

describe('copy', () => {
  it('phase 1: straight to the Mac, with the first name as given', () => {
    expect(introLine('Dominik', false)).toBe(LINE)
    expect(introLine('Michal', false)).toBe("Goes straight to Michal's Mac.")
    expect(introLine('Dominik Kroufek', false)).toBe("Goes straight to Dominik Kroufek's Mac.")
    expect(introLine('  ', false)).toBe(LINE)
  })

  it('encrypted: its own line and a lock on the ping and on the island', () => {
    const view = render(<Onboarding name="Viki" encrypted onDone={() => {}} />)
    expect(screen.getByRole('dialog', { name: APP_LINE })).toBeInTheDocument()
    expect(view.container.querySelectorAll('.ob-p.lk .ob-lock')).toHaveLength(1)
    expect(view.container.querySelectorAll('.ob-isl .ob-lock')).toHaveLength(1)
  })

  it('not encrypted: the default line and no lock anywhere', () => {
    const view = render(<Onboarding onDone={() => {}} />)
    expect(screen.getByRole('dialog', { name: LINE })).toBeInTheDocument()
    expect(view.container.querySelector('.ob-lock')).toBeNull()
    expect(view.container.querySelector('.ob-p')).not.toHaveClass('lk')
  })
})

describe('motion', () => {
  it('plays the loop by default: the ping is there to fly', () => {
    reduceMotion(false)
    const view = render(<Onboarding onDone={() => {}} />)
    const scene = view.container.querySelector('.ob-scene')
    expect(scene).not.toHaveAttribute('data-still')
    expect(scene).toHaveAttribute('aria-hidden', 'true')
    expect(view.container.querySelector('.ob-ping')).not.toBeNull()
  })

  it('reduced motion: the static last frame, the ping already in the open island', () => {
    reduceMotion(true)
    const view = render(<Onboarding encrypted onDone={() => {}} />)
    expect(view.container.querySelector('.ob-scene')).toHaveAttribute('data-still')
    expect(view.container.querySelector('.ob-ping')).toBeNull()
    expect(view.container.querySelector('.ob-isl .ob-dot')).not.toBeNull()
    expect(view.container.querySelector('.ob-isl .ob-lock')).not.toBeNull()
  })

  it('the stylesheet stops every scene animation, so its base styles (the last frame) show', () => {
    const css = readFileSync(path.resolve(__dirname, '../../src/styles.css'), 'utf8')
    const section = css.slice(css.indexOf('/* ==== Onboarding'), css.indexOf('/* ==== end onboarding'))
    const still = /\.ob-scene\[data-still\] \*,[^{]*\{\s*animation: none !important;/
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{\s*\.ob-scene \*,[^{]*\{\s*animation: none !important;/
    expect(section).toMatch(still)
    expect(section).toMatch(reduced)
    // The flying ping is hidden at rest; it only shows inside its keyframes.
    expect(section).toMatch(/\.ob-p \{[^}]*opacity: 0;/)
  })
})
