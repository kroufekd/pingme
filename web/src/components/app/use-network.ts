import { useMutation, useQuery } from 'convex/react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { browserName, loadDeviceKey } from '@/lib/device-key'
import type { DeviceKey } from '@/lib/device-key'
import { isOnline, openRow, sendSealed } from '@/lib/network'
import type { ContactsView, MineView, SentRow } from '@/lib/network'
import { newRef } from '@/lib/seal'
import type { Kind } from '@/lib/seal'
import type { Row } from '@/lib/tasks'
import { vaultGet, vaultSet } from '@/lib/vault'
import type { NewTask, SendResult } from './task-form'

export type Device = { key: DeviceKey | null; deviceId: string | null; settled: boolean }
const NO_DEVICE: Device = { key: null, deviceId: null, settled: false }

/**
 * This browser as a device of the signed-in member: a key pair kept in IndexedDB and registered
 * on every load (the same key gives the same device). `ensure()` resolves once it is known.
 */
export function useDevice(enabled: boolean) {
  const register = useMutation(api.devices.registerWeb)
  const [state, setState] = useState<Device>(NO_DEVICE)
  const inflight = useRef<Promise<Device> | null>(null)
  const generation = useRef(0)

  const ensure = useCallback(
    (again = false): Promise<Device> => {
      if (inflight.current && !again) return inflight.current
      const gen = generation.current
      const p = (async (): Promise<Device> => {
        let key: DeviceKey | null = null
        let deviceId: string | null = null
        try {
          key = await loadDeviceKey()
          const res = await register({ publicKey: key.publicKey, name: browserName() })
          if (res.ok) deviceId = res.deviceId
        } catch {
          // Offline or storage trouble: sending still works, this browser just gets no copy.
        }
        const next = { key, deviceId, settled: true }
        if (gen === generation.current) setState(next)
        return next
      })()
      inflight.current = p
      // A failed registration is tried again by the next ensure(), for example on send.
      void p.then((d) => {
        if (!d.deviceId && inflight.current === p) inflight.current = null
      })
      return p
    },
    [register],
  )

  useEffect(() => {
    if (enabled) {
      void ensure()
      return
    }
    // Signed out: the next account registers this browser for itself.
    generation.current += 1
    inflight.current = null
    setState(NO_DEVICE)
  }, [enabled, ensure])

  return { ...state, ensure }
}

type Local = { ref: string; toUserId: string; row: Row }
const REPLIES = 'replies'
const MAX_KEPT = 200

/** Not scheduled: dueAt is the send time. Only a real plan shows its time. */
function planned(dueAt: number, createdAt: number) {
  return dueAt > createdAt + 60_000 ? dueAt : null
}

/**
 * The sent list over the network: sending seals the text, rows are opened on this device.
 * Opened texts are cached per ciphertext, since the query reruns on every status change.
 * A reply shown here is acked (the server drops this device's copy) and kept locally, so a
 * reload still shows it instead of "on another device".
 */
export function useSent({
  enabled,
  device,
  view,
  now,
}: {
  enabled: boolean
  device: Device & { ensure: (again?: boolean) => Promise<Device> }
  view: ContactsView | undefined
  now: number
}) {
  const sendMutation = useMutation(api.messages.send)
  const ackMutation = useMutation(api.messages.ackReply)
  const mine = useQuery(api.messages.mine, enabled && device.settled ? (device.deviceId ? { deviceId: device.deviceId } : {}) : 'skip') as
    | MineView
    | undefined

  const viewRef = useRef(view)
  viewRef.current = view
  const ensureRef = useRef(device.ensure)
  ensureRef.current = device.ensure

  // The browser was revoked or forgotten: register again, once per lost device id.
  const retried = useRef(new Set<string>())
  const inactive = mine?.status === 'member' && !mine.deviceActive && device.deviceId
  useEffect(() => {
    if (!inactive || !device.deviceId || retried.current.has(device.deviceId)) return
    retried.current.add(device.deviceId)
    void device.ensure(true)
  }, [inactive, device])

  // ---- opening what the server holds for this device ----
  const [opened, setOpened] = useState<Map<string, string | null>>(() => new Map())
  const pending = useRef(new Set<string>())
  const serverRows = useMemo(() => (mine?.status === 'member' ? mine.rows : []), [mine])
  const privateKey = device.key?.privateKey ?? null
  useEffect(() => {
    if (!privateKey) return
    for (const r of serverRows) {
      for (const kind of ['title', 'reply'] as Kind[]) {
        const sealed = r[kind]
        if (!sealed) continue
        const id = `${kind}|${r.ref}|${sealed.ct}`
        if (opened.has(id) || pending.current.has(id)) continue
        pending.current.add(id)
        void openRow(privateKey, r, kind, sealed).then((text) => {
          pending.current.delete(id)
          setOpened((m) => new Map(m).set(id, text))
        })
      }
    }
  }, [serverRows, privateKey, opened])

  // ---- replies already shown on this device ----
  const [kept, setKept] = useState<Record<string, string> | null>(null)
  const keptRef = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!enabled) return
    let alive = true
    vaultGet(REPLIES)
      .catch(() => undefined)
      .then((v) => {
        if (!alive) return
        const map = v && typeof v === 'object' ? (v as Record<string, string>) : {}
        keptRef.current = { ...map, ...keptRef.current }
        setKept(keptRef.current)
      })
    return () => {
      alive = false
    }
  }, [enabled])

  // ---- optimistic rows, keyed by the ref made here ----
  const [locals, setLocals] = useState<Local[]>([])
  const plain = useRef(new Map<string, string>())

  const lastSeenOf = useCallback(
    (userId: string): number | null | undefined => {
      if (view?.status !== 'member') return undefined
      if (userId === view.me.userId) {
        const macs = view.me.devices.filter((d) => d.kind === 'mac')
        return macs.length ? Math.max(...macs.map((d) => d.lastSeen)) : null
      }
      const c = view.contacts.find((x) => x.userId === userId)
      return c ? c.macLastSeen : undefined
    },
    [view],
  )
  // Unknown (contacts still loading) is not offline: no "čeká" flash.
  const offline = (userId: string) => {
    const seen = lastSeenOf(userId)
    return seen !== undefined && !isOnline(seen, now)
  }

  const replyTexts = useRef(new Map<string, string>())
  replyTexts.current = new Map()

  const toRow = (r: SentRow): Row => {
    const t = r.title ? opened.get(`title|${r.ref}|${r.title.ct}`) : null
    const mineText = plain.current.get(r.ref)
    let reply: string | undefined
    let replyMissing = false
    let replyPending = false
    if (r.reply) {
      const x = opened.get(`reply|${r.ref}|${r.reply.ct}`)
      if (typeof x === 'string') {
        reply = x
        replyPending = true
        replyTexts.current.set(r.ref, x)
      } else if (x === null) {
        replyMissing = true
        replyPending = true
      }
    } else if (r.replyAt !== null && kept !== null) {
      reply = kept[r.ref]
      replyMissing = reply === undefined
    }
    return {
      taskRef: r.ref,
      title: mineText ?? (typeof t === 'string' ? t : null),
      titleMissing: mineText === undefined && t === null,
      urgency: r.urgency,
      to: r.forAgent ? 'agent' : 'person',
      toName: r.toName,
      offline: r.status === 'queued' && offline(r.toUserId),
      dueAt: planned(r.dueAt, r.createdAt),
      repeat: (r.repeat ?? undefined) as Row['repeat'],
      status: r.status,
      statusAt: r.statusAt,
      snoozedUntil: r.snoozedUntil ?? undefined,
      typingUntil: r.typingUntil ?? undefined,
      reply,
      replyMissing,
      replyAt: r.replyAt ?? undefined,
      replyPending,
      createdAt: r.createdAt,
    }
  }

  const known = new Set(serverRows.map((r) => r.ref))
  const rows: Row[] = [
    ...locals.filter((l) => !known.has(l.ref)).map((l) => ({ ...l.row, offline: offline(l.toUserId) })),
    ...serverRows.map(toRow),
  ]

  // Drop optimistic rows once the server has them (same ref, so the DOM node stays).
  const matched = locals.some((l) => known.has(l.ref))
  useEffect(() => {
    if (matched) setLocals((l) => l.filter((x) => !known.has(x.ref)))
  })

  const send = useCallback(
    async (task: NewTask): Promise<SendResult> => {
      const ref = newRef()
      plain.current.set(ref, task.title)
      const at = Date.now()
      const v0 = viewRef.current
      const row: Row = {
        taskRef: ref,
        title: task.title,
        urgency: task.urgency,
        to: task.forAgent ? 'agent' : 'person',
        toName: v0?.status === 'member' ? v0.contacts.find((c) => c.userId === task.to)?.name : undefined,
        dueAt: planned(task.dueAt, at),
        repeat: task.repeat,
        status: 'queued',
        statusAt: at,
        replyPending: false,
        createdAt: at,
      }
      setLocals((l) => [{ ref, toUserId: task.to, row }, ...l])
      const drop = () => setLocals((l) => l.filter((x) => x.ref !== ref))
      try {
        const dev = await ensureRef.current()
        const v = viewRef.current
        if (v?.status !== 'member') {
          drop()
          return { ok: false, error: 'network' }
        }
        const contact = v.contacts.find((c) => c.userId === task.to)
        const res = await sendSealed(sendMutation, {
          text: task.title,
          ref,
          from: v.me.userId,
          to: task.to,
          forAgent: task.forAgent,
          urgency: task.urgency,
          dueAt: task.dueAt,
          repeat: task.repeat,
          recipientDevices: task.to === v.me.userId ? v.me.devices : (contact?.devices ?? []),
          myDevices: v.me.devices,
          own: dev.key && dev.deviceId ? { deviceId: dev.deviceId, publicKey: dev.key.publicKey } : null,
        })
        if (res.ok) return { ok: true }
        drop()
        return { ok: false, error: res.error }
      } catch {
        drop()
        return { ok: false, error: 'network' }
      }
    },
    [sendMutation],
  )

  const deviceId = device.deviceId
  const onAck = useCallback(
    async (ref: string) => {
      const text = replyTexts.current.get(ref)
      if (text !== undefined) {
        // Keep it before the server copy goes; prune to what the list can still show.
        const live = new Set([...serverRows.map((r) => r.ref), ref])
        const next: Record<string, string> = {}
        for (const [k, t] of Object.entries({ ...keptRef.current, [ref]: text })) if (live.has(k)) next[k] = t
        const trimmed = Object.fromEntries(Object.entries(next).slice(-MAX_KEPT))
        keptRef.current = trimmed
        setKept(trimmed)
        await vaultSet(REPLIES, trimmed).catch(() => {})
      }
      if (!deviceId) return false
      return ackMutation({ ref, deviceId })
    },
    [ackMutation, deviceId, serverRows],
  )

  return { loaded: mine !== undefined, rows, keyOf: rowKey, send, onAck }
}

function rowKey(r: Row) {
  return r.taskRef
}
