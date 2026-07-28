import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'

const simulationSource = (
  await readFile(new URL('../../static/simulation.js', import.meta.url), 'utf8')
).replace(/^export (const|class|function) /gm, '$1 ')
let backendSource = await readFile(
  new URL('../src/index.js', import.meta.url),
  'utf8'
)
backendSource = backendSource
  .replace(/^import \{[\s\S]*?\} from '\.\/lnbits-sdk\.js'\n/, '')
  .replace(
    /^import \{[\s\S]*?\} from '\.\.\/\.\.\/static\/simulation\.js'\n/,
    ''
  )
  .replace(/^export function /gm, 'function ')

test('paid entry invoices admit exactly once and reject spoofed metadata', () => {
  const backend = createBackend()
  const request = {
    name: 'Competitive room',
    playerName: 'Host',
    maxPlayers: 3,
    seed: 'paid-entry',
    entryFeeSats: 25,
    walletId: 'wallet_1',
    lnAddress: 'host@example.com',
    requestId: requestId('host')
  }
  const created = ok(backend.api.createWormbitsRoom(request))
  assert.equal(created.room.playerCount, 0)
  assert.equal(created.room.potSats, 0)
  assert.equal(created.viewer.paymentStatus, 'pending')
  assert.equal(created.invoice.amountSats, 25)

  const repeated = ok(backend.api.createWormbitsRoom(request))
  assert.equal(repeated.room.id, created.room.id)
  assert.equal(repeated.invoice.paymentHash, created.invoice.paymentHash)
  assert.equal(backend.invoices.length, 1)

  assert.match(
    failed(
      backend.api.setWormbitsReady({
        roomId: created.room.id,
        playerToken: created.viewer.token,
        ready: true
      })
    ).error,
    /payment/
  )

  const spoofed = failed(
    backend.recordPayment(created.invoice, {
      participantId: 'wormplayer_attacker'
    })
  )
  assert.match(spoofed.error, /metadata mismatch/)
  assert.equal(backend.payouts.length, 0)

  const paid = ok(backend.recordPayment(created.invoice))
  assert.equal(paid.room.playerCount, 1)
  assert.equal(paid.room.potSats, 25)
  assert.equal(paid.viewer.paymentStatus, 'paid')

  const duplicate = ok(backend.recordPayment(created.invoice))
  assert.equal(duplicate.room.playerCount, 1)
  assert.equal(duplicate.room.potSats, 25)
  assert.equal(backend.payouts.length, 0)

  assert.match(
    failed(
      backend.api.createWormbitsRoom({
        ...request,
        requestId: requestId('wrong-wallet'),
        walletId: 'wallet_not_owned'
      })
    ).error,
    /your LNbits wallets/
  )
})

test('server-validated winner receives the pot once despite repeated calls', () => {
  const backend = createPaidBackend(2, 20)
  backend.complete(1)

  assert.match(
    failed(
      backend.api.settleWormbitsRoom({
        roomId: backend.roomId,
        playerToken: 'forged-token',
        winnerSlot: 0
      })
    ).error,
    /participant token/
  )
  assert.equal(backend.payouts.length, 0)

  const settled = ok(
    backend.api.settleWormbitsRoom({
      roomId: backend.roomId,
      playerToken: backend.players[0].token,
      winnerSlot: 0
    })
  )
  assert.equal(settled.room.winnerSlot, 1)
  assert.equal(settled.room.settlementStatus, 'paid')
  assert.equal(backend.payouts.length, 1)
  assert.equal(backend.payouts[0].amount, 40)
  assert.equal(backend.payouts[0].lnurl, 'player2@example.com')

  const repeated = ok(
    backend.api.settleWormbitsRoom({
      roomId: backend.roomId,
      playerToken: backend.players[1].token
    })
  )
  assert.equal(repeated.room.settlementStatus, 'paid')
  assert.equal(backend.payouts.length, 1)
})

test('draws split the pot and definite payout failures recover safely', () => {
  const backend = createPaidBackend(3, 17)
  backend.complete(null)
  backend.queuePayout({ok: false, error: 'temporary route failure'})

  const failedPayout = ok(
    backend.api.settleWormbitsRoom({
      roomId: backend.roomId,
      playerToken: backend.players[0].token
    })
  )
  assert.equal(failedPayout.room.settlementStatus, 'failed')
  assert.equal(backend.payouts.length, 1)

  for (let index = 0; index < 3; index += 1) {
    ok(
      backend.api.settleWormbitsRoom({
        roomId: backend.roomId,
        playerToken: backend.players[1].token
      })
    )
  }
  const recovered = ok(
    backend.api.getWormbitsRoom({
      roomId: backend.roomId,
      playerToken: backend.players[2].token
    })
  )
  assert.equal(recovered.room.settlementKind, 'draw')
  assert.equal(recovered.room.settlementStatus, 'paid')
  assert.deepEqual(
    backend.payouts.map(payout => payout.amount),
    [17, 17, 17, 17]
  )
  assert.deepEqual(
    backend.payouts.slice(1).map(payout => payout.lnurl),
    [
      'host@example.com',
      'player2@example.com',
      'player3@example.com'
    ]
  )
  assert.equal(
    recovered.settlements.reduce(
      (total, settlement) =>
        settlement.kind === 'payout'
          ? total + settlement.amountSats
          : total,
      0
    ),
    51
  )
})

test('pre-start refunds retry definite failures but not ambiguous payments', () => {
  const retryable = createBackend()
  const created = createAndPayHost(retryable, 30)
  retryable.queuePayout({ok: false, error: 'wallet temporarily unavailable'})
  const forfeited = ok(
    retryable.api.forfeitWormbitsMatch({
      roomId: created.room.id,
      playerToken: created.viewer.token
    })
  )
  assert.equal(forfeited.viewer.paymentStatus, 'refund-failed')
  assert.equal(forfeited.room.potSats, 0)
  assert.equal(retryable.payouts.length, 1)

  const refunded = ok(
    retryable.api.settleWormbitsRoom({
      roomId: created.room.id,
      playerToken: created.viewer.token
    })
  )
  assert.equal(refunded.viewer.paymentStatus, 'refunded')
  assert.equal(retryable.payouts.length, 2)

  const ambiguous = createBackend()
  const ambiguousCreated = createAndPayHost(ambiguous, 30)
  ambiguous.queuePayout(new Error('runtime interrupted'))
  const held = ok(
    ambiguous.api.forfeitWormbitsMatch({
      roomId: ambiguousCreated.room.id,
      playerToken: ambiguousCreated.viewer.token
    })
  )
  assert.equal(held.viewer.paymentStatus, 'refund-review')
  assert.equal(held.settlements[0].needsReview, true)
  assert.equal(ambiguous.payouts.length, 1)

  assert.match(
    failed(
      ambiguous.api.settleWormbitsRoom({
        roomId: ambiguousCreated.room.id,
        playerToken: ambiguousCreated.viewer.token
      })
    ).error,
    /pending refund/
  )
  assert.equal(ambiguous.payouts.length, 1)
})

test('tampered completed snapshots cannot trigger a payout', () => {
  const backend = createPaidBackend(2, 20)
  backend.complete(0)
  const room = backend.room()
  room.winner_slot = 1
  backend.storeRoom(room)

  assert.match(
    failed(
      backend.api.settleWormbitsRoom({
        roomId: backend.roomId,
        playerToken: backend.players[0].token
      })
    ).error,
    /winner does not match/
  )
  assert.equal(backend.payouts.length, 0)
})

function createPaidBackend(playerCount, entryFeeSats) {
  const backend = createBackend()
  const created = createAndPayHost(backend, entryFeeSats, playerCount)
  const players = [created.viewer]
  for (let slot = 1; slot < playerCount; slot += 1) {
    const joined = ok(
      backend.api.joinWormbitsRoom({
        roomId: created.room.id,
        playerName: `Player ${slot + 1}`,
        lnAddress: `player${slot + 1}@example.com`,
        requestId: requestId(`player-${slot + 1}`)
      })
    )
    players.push(ok(backend.recordPayment(joined.invoice)).viewer)
  }
  for (const player of players) {
    ok(
      backend.api.setWormbitsReady({
        roomId: created.room.id,
        playerToken: player.token,
        ready: true
      })
    )
  }
  const started = ok(
    backend.api.startWormbitsMatch({
      roomId: created.room.id,
      playerToken: players[0].token
    })
  )
  backend.roomId = created.room.id
  return {
    ...backend,
    roomId: created.room.id,
    players,
    started
  }
}

function createAndPayHost(backend, entryFeeSats, maxPlayers = 2) {
  const created = ok(
    backend.api.createWormbitsRoom({
      playerName: 'Host',
      maxPlayers,
      seed: 'paid-room',
      entryFeeSats,
      walletId: 'wallet_1',
      lnAddress: 'host@example.com',
      requestId: requestId(`host-${entryFeeSats}-${maxPlayers}`)
    })
  )
  return ok(backend.recordPayment(created.invoice))
}

function createBackend() {
  const rows = new Map()
  const published = []
  const invoices = []
  const payouts = []
  const payoutResults = []
  let timestamp = 1_700_000_000
  let idCounter = 0
  let invoiceCounter = 0

  const storage = {
    get(table, id, fallback = null) {
      return rows.get(`${table}:${id}`) || fallback
    },
    set(table, row) {
      rows.set(`${table}:${row.id}`, row)
      return row
    },
    delete(table, id) {
      rows.delete(`${table}:${id}`)
    },
    list(table, options = {}) {
      let data = [...rows.entries()]
        .filter(([key]) => key.startsWith(`${table}:`))
        .map(([, row]) => row)
        .filter(row =>
          Object.entries(options.filters || {}).every(
            ([field, expected]) => row[field] === expected
          )
        )
      if (options.sortBy) {
        data.sort((left, right) => {
          const order =
            left[options.sortBy] < right[options.sortBy]
              ? -1
              : left[options.sortBy] > right[options.sortBy]
                ? 1
                : 0
          return options.descending ? -order : order
        })
      }
      const total = data.length
      data = data.slice(
        options.offset || 0,
        (options.offset || 0) + (options.limit || 100)
      )
      return {data, total}
    }
  }
  const system = {
    id(prefix) {
      idCounter += 1
      return `${prefix}_${idCounter}`
    },
    now() {
      return timestamp
    },
    log() {}
  }
  const wallet = {
    listUserWallets() {
      return [{id: 'wallet_1', name: 'Competition wallet', currency: 'sat'}]
    },
    createInvoicePublic(request) {
      invoiceCounter += 1
      const invoice = {
        ...request,
        paymentHash: `invoice_hash_${invoiceCounter}`,
        paymentRequest: `lnbc${request.amount}n1invoice${invoiceCounter}`,
        checkingId: `checking_${invoiceCounter}`
      }
      invoices.push(invoice)
      return invoice
    },
    payLnurl(request) {
      payouts.push(request)
      const result = payoutResults.shift()
      if (result instanceof Error) throw result
      return (
        result || {
          ok: true,
          success: true,
          pending: false,
          checkingId: `payout_${payouts.length}`,
          paymentHash: `payout_hash_${payouts.length}`,
          status: 'success'
        }
      )
    }
  }
  const websocket = {
    publish(itemId, data) {
      published.push({itemId, data})
    }
  }
  const api = Function(
    'storage',
    'system',
    'wallet',
    'websocket',
    `${simulationSource}\n${backendSource}\nreturn {
      createWormbitsRoom,
      getWormbitsRoom,
      joinWormbitsRoom,
      setWormbitsReady,
      startWormbitsMatch,
      forfeitWormbitsMatch,
      settleWormbitsRoom,
      recordWormbitsPayment
    }`
  )(storage, system, wallet, websocket)

  const backend = {
    api: Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [
        name,
        payload => fn(JSON.stringify(payload))
      ])
    ),
    invoices,
    payouts,
    published,
    recordPayment(invoice, overrides = {}) {
      const issued = invoices.find(
        candidate => candidate.paymentHash === invoice.paymentHash
      )
      assert.ok(issued, 'The payment invoice must have been issued.')
      return api.recordWormbitsPayment(
        JSON.stringify({
          paymentHash: invoice.paymentHash,
          walletId: 'wallet_1',
          amount: -(overrides.amountSats || issued.amount) * 1000,
          extra: {
            source_id: issued.sourceId,
            extra_wormbits: {
              room_id: overrides.roomId || issued.extra.room_id,
              participant_id:
                overrides.participantId || issued.extra.participant_id
            }
          }
        })
      )
    },
    queuePayout(result) {
      payoutResults.push(result)
    },
    room() {
      return rows.get(`wormbits_rooms:${backend.roomId}`)
    },
    storeRoom(room) {
      rows.set(`wormbits_rooms:${room.id}`, room)
    },
    complete(winner) {
      const room = backend.room()
      const snapshot = JSON.parse(room.snapshot_json)
      snapshot.phase = 'finished'
      snapshot.winner = winner
      room.snapshot_json = JSON.stringify(snapshot)
      room.status = 'completed'
      room.winner_slot = winner === null ? -1 : winner
      room.settlement_status = 'pending'
      room.completed_at = timestamp
      rows.set(`wormbits_rooms:${room.id}`, room)
    },
    setNow(value) {
      timestamp = value
    }
  }
  return backend
}

function requestId(label) {
  return `${label.replace(/[^a-z0-9]/gi, '')}0123456789abcdef0123456789abcdef`
}

function ok(value) {
  const response = JSON.parse(value)
  assert.equal(response.ok, true, response.error)
  return response.data
}

function failed(value) {
  const response = JSON.parse(value)
  assert.equal(response.ok, false, 'Expected the request to fail.')
  return response
}
