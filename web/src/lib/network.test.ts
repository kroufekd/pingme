import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserName, loadDeviceKey, resetDeviceKey } from './device-key'
import { ONLINE_MS, isOnline, openRow, sendSealed } from './network'
import type { SendArgs, SendReply } from './network'
import { parsePairHash, secretHash } from './pair'
import { initials, pingPlaceholder } from './people'
import { aadFor, generateKeyPair, open, seal } from './seal'
import { resetVault, vaultGet, vaultInMemory, vaultSet } from './vault'

describe('names', () => {
  it('initials: first letters of up to two words', () => {
    expect(initials('Dominik')).toBe('D')
    expect(initials('dominik kroufek')).toBe('DK')
    expect(initials('  Šárka   Nová Dvořáková ')).toBe('ŠN')
    expect(initials('')).toBe('?')
  })

  it('the placeholder names the first name only', () => {
    expect(pingPlaceholder('Dominik')).toBe('Ping Dominik…')
    expect(pingPlaceholder('Jiří Novák')).toBe('Ping Jiří…')
    expect(pingPlaceholder(null)).toBe('Ping…')
  })
})

describe('online', () => {
  it('a Mac seen in the last 5 minutes', () => {
    const now = 1_000_000_000
    expect(isOnline(now - ONLINE_MS + 1, now)).toBe(true)
    expect(isOnline(now - ONLINE_MS, now)).toBe(false)
    expect(isOnline(null, now)).toBe(false)
  })
})

describe('pairing link', () => {
  const pairId = 'AbCdEfGhIjKlMnOpQrStUv'
  const secret = 'abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE'

  it('reads #<pairId>.<secret> and nothing else', () => {
    expect(parsePairHash(`#${pairId}.${secret}`)).toEqual({ pairId, secret })
    expect(parsePairHash(`${pairId}.${secret}`)).toEqual({ pairId, secret })
    expect(parsePairHash(`#${pairId}`)).toBeNull()
    expect(parsePairHash(`#${pairId}.${secret}x`)).toBeNull()
    expect(parsePairHash(`#${pairId}.${secret.slice(0, -1)}+`)).toBeNull()
    expect(parsePairHash('')).toBeNull()
  })

  it('hashes the secret string as written (lowercase hex SHA-256 of its UTF-8)', async () => {
    expect(await secretHash(secret)).toBe(createHash('sha256').update(secret, 'utf8').digest('hex'))
  })
})

describe('vault and the device key', () => {
  beforeEach(() => {
    resetVault()
    resetDeviceKey()
  })
  afterEach(() => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB
    resetVault()
  })

  it('makes a key once and reuses it on the next load', async () => {
    const first = await loadDeviceKey()
    expect(first.publicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/)
    expect(await vaultGet('deviceKey')).toEqual(first)
    resetDeviceKey()
    expect(await loadDeviceKey()).toEqual(first)
  })

  it('one key even when two parts of the page ask at once', async () => {
    const [a, b] = await Promise.all([loadDeviceKey(), loadDeviceKey()])
    expect(a).toBe(b)
  })

  it('a broken stored value is replaced by a fresh key', async () => {
    await vaultSet('deviceKey', { publicKey: 'nope', privateKey: 1 })
    const k = await loadDeviceKey()
    expect(k.privateKey).toMatch(/^[A-Za-z0-9+/]{43}=$/)
  })

  it('IndexedDB that throws (private mode) falls back to memory for the session', async () => {
    ;(globalThis as { indexedDB?: unknown }).indexedDB = {
      open: () => {
        throw new Error('SecurityError')
      },
    }
    resetVault()
    expect(vaultInMemory()).toBe(false)
    const k = await loadDeviceKey()
    expect(vaultInMemory()).toBe(true)
    resetDeviceKey()
    expect(await loadDeviceKey()).toEqual(k)
  })

  it('names the browser for the device list', () => {
    expect(browserName('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1')).toBe('Safari · iPhone')
    expect(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36')).toBe('Chrome · Mac')
    expect(browserName('')).toBe('Web')
  })
})

describe('sealing for send', () => {
  it('only Macs get the ping, duplicates are sealed once, and the AAD binds ref and both people', async () => {
    const [mac, web, mine] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()])
    const send = vi.fn(async (_: SendArgs): Promise<SendReply> => ({ ok: true, ref: 'r' }))
    const ref = 'AAAAAAAAAAAAAAAAAAAAAA'
    await sendSealed(send, {
      text: 'Ahoj',
      ref,
      from: 'u-a',
      to: 'u-b',
      forAgent: true,
      urgency: 'green',
      dueAt: 123,
      recipientDevices: [
        { deviceId: 'm1', kind: 'mac', publicKey: mac.publicKey },
        { deviceId: 'w1', kind: 'web', publicKey: web.publicKey },
      ],
      myDevices: [{ deviceId: 'me', kind: 'web', publicKey: mine.publicKey }],
      own: { deviceId: 'me', publicKey: mine.publicKey },
    })
    const args = send.mock.calls[0][0]
    expect(args.envelopes.map((e) => e.deviceId)).toEqual(['m1'])
    expect(args.titleEnvelopes.map((e) => e.deviceId)).toEqual(['me'])
    // The agent gets it now: no time or repeat goes along.
    expect(args).not.toHaveProperty('dueAt')
    expect(await open(mac.privateKey, args.envelopes[0], aadFor({ kind: 'title', ref, from: 'u-a', to: 'u-b' }))).toBe('Ahoj')
  })

  it('on stale devices the retry trusts the server lists, also when this browser is no longer in them', async () => {
    const [mac, mine, other] = await Promise.all([generateKeyPair(), generateKeyPair(), generateKeyPair()])
    const send = vi
      .fn(async (_: SendArgs): Promise<SendReply> => ({ ok: true, ref: 'r' }))
      .mockResolvedValueOnce({ ok: false, error: 'stale-devices', devices: [{ deviceId: 'm2', kind: 'mac', publicKey: mac.publicKey }], myDevices: [{ deviceId: 'mac-me', kind: 'mac', publicKey: other.publicKey }] })
    await sendSealed(send, {
      text: 'x',
      ref: 'AAAAAAAAAAAAAAAAAAAAAA',
      from: 'u-a',
      to: 'u-b',
      forAgent: false,
      urgency: 'green',
      recipientDevices: [{ deviceId: 'm1', kind: 'mac', publicKey: mac.publicKey }],
      myDevices: [],
      own: { deviceId: 'web-revoked', publicKey: mine.publicKey },
    })
    expect(send.mock.calls[0][0].titleEnvelopes.map((e) => e.deviceId)).toEqual(['web-revoked'])
    const retry = send.mock.calls[1][0]
    expect(retry.envelopes.map((e) => e.deviceId)).toEqual(['m2'])
    expect(retry.titleEnvelopes.map((e) => e.deviceId)).toEqual(['mac-me'])
  })

  it('stale devices without lists retries once with what it had', async () => {
    const mac = await generateKeyPair()
    const send = vi.fn(async (): Promise<SendReply> => ({ ok: false, error: 'stale-devices' }))
    const res = await sendSealed(send, {
      text: 'x',
      ref: 'AAAAAAAAAAAAAAAAAAAAAA',
      from: 'u-a',
      to: 'u-b',
      forAgent: false,
      urgency: 'green',
      recipientDevices: [{ deviceId: 'm1', kind: 'mac', publicKey: mac.publicKey }],
      myDevices: [],
    })
    expect(send).toHaveBeenCalledTimes(2)
    expect(res).toEqual({ ok: false, error: 'stale-devices' })
  })

  it('openRow: a reply opens with the same sender and recipient, never swapped', async () => {
    const k = await generateKeyPair()
    const row = { ref: 'AAAAAAAAAAAAAAAAAAAAAA', fromUserId: 'u-a', toUserId: 'u-b' }
    const sealed = await seal(k.publicKey, 'Jo', aadFor({ kind: 'reply', ref: row.ref, from: 'u-a', to: 'u-b' }))
    expect(await openRow(k.privateKey, row, 'reply', sealed)).toBe('Jo')
    expect(await openRow(k.privateKey, { ...row, fromUserId: 'u-b', toUserId: 'u-a' }, 'reply', sealed)).toBeNull()
    expect(await openRow(k.privateKey, row, 'title', sealed)).toBeNull()
    expect(await openRow(k.privateKey, { ...row, ref: 'bad|ref' }, 'reply', sealed)).toBeNull()
  })
})
