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
  .replace(
    /^import \{[\s\S]*?\} from '\.\/lnbits-sdk\.js'\n/,
    ''
  )
  .replace(
    /^import \{[\s\S]*?\} from '\.\.\/\.\.\/static\/simulation\.js'\n/,
    ''
  )
  .replace(/^export function /gm, 'function ')

test('four players can ready, start, and submit server-validated turns', () => {
  const backend = createBackend()
  const created = ok(
    backend.api.createWormbitsRoom({
      name: 'Four-way test',
      playerName: 'Host',
      maxPlayers: 4,
      seed: 'four-way'
    })
  )
  const roomId = created.room.id
  const host = created.viewer
  const guests = ['Cyan', 'Lime', 'Gold'].map(name =>
    ok(
      backend.api.joinWormbitsRoom({
        roomId,
        playerName: name
      })
    ).viewer
  )

  const full = failed(
    backend.api.joinWormbitsRoom({
      roomId,
      playerName: 'Too many'
    })
  )
  assert.match(full.error, /full/)

  for (const player of [host, ...guests]) {
    ok(
      backend.api.setWormbitsReady({
        roomId,
        playerToken: player.token,
        ready: true
      })
    )
  }

  assert.match(
    failed(
      backend.api.startWormbitsMatch({
        roomId,
        playerToken: guests[0].token
      })
    ).error,
    /host/
  )
  const started = ok(
    backend.api.startWormbitsMatch({
      roomId,
      playerToken: host.token
    })
  )
  assert.equal(started.room.status, 'active')
  assert.equal(started.snapshot.teamCount, 4)
  assert.deepEqual(started.snapshot.teamNames, ['Host', 'Cyan', 'Lime', 'Gold'])

  const moved = ok(
    backend.api.submitWormbitsAction({
      roomId,
      playerToken: host.token,
      expectedRevision: started.room.revision,
      clientSeq: 1,
      tick: 0,
      command: {type: 'move', direction: 1}
    })
  )
  assert.equal(moved.accepted, true)

  assert.match(
    failed(
      backend.api.submitWormbitsAction({
        roomId,
        playerToken: guests[0].token,
        expectedRevision: moved.room.revision,
        clientSeq: 1,
        tick: 0,
        command: {type: 'skip'}
      })
    ).error,
    /turn/
  )

  const skipped = ok(
    backend.api.submitWormbitsAction({
      roomId,
      playerToken: host.token,
      expectedRevision: moved.room.revision,
      clientSeq: 2,
      tick: 0,
      command: {type: 'skip'}
    })
  )
  assert.equal(skipped.snapshot.activeTeam, 1)

  const guestTurn = ok(
    backend.api.submitWormbitsAction({
      roomId,
      playerToken: guests[0].token,
      expectedRevision: skipped.room.revision,
      clientSeq: 1,
      tick: 0,
      command: {type: 'skip'}
    })
  )
  assert.equal(guestTurn.snapshot.activeTeam, 2)

  const duplicate = ok(
    backend.api.submitWormbitsAction({
      roomId,
      playerToken: guests[0].token,
      expectedRevision: guestTurn.room.revision,
      clientSeq: 1,
      tick: 0,
      command: {type: 'skip'}
    })
  )
  assert.equal(duplicate.duplicate, true)

  assert.match(
    failed(
      backend.api.submitWormbitsAction({
        roomId,
        playerToken: guests[1].token,
        expectedRevision: 1,
        clientSeq: 1,
        tick: 0,
        command: {type: 'skip'}
      })
    ).error,
    /Synchronization required/
  )
})

test('spectators are read-only and durable snapshots recover exactly', () => {
  const backend = createStartedBackend(2)
  const watched = ok(
    backend.api.spectateWormbitsRoom({
      roomId: backend.roomId,
      playerName: 'Observer'
    })
  )
  assert.equal(watched.viewer.role, 'spectator')
  assert.equal(watched.snapshot.teamCount, 2)

  assert.match(
    failed(
      backend.api.submitWormbitsAction({
        roomId: backend.roomId,
        playerToken: watched.viewer.token,
        expectedRevision: watched.room.revision,
        clientSeq: 1,
        tick: 0,
        command: {type: 'skip'}
      })
    ).error,
    /participant token/
  )

  const recovered = ok(
    backend.api.getWormbitsRoom({
      roomId: backend.roomId,
      playerToken: backend.players[0].token
    })
  )
  assert.deepEqual(recovered.snapshot, watched.snapshot)
})

test('disconnects transfer the host, reconnect, and eventually forfeit', () => {
  const backend = createStartedBackend(2)
  const [host, guest] = backend.players

  backend.setNow(1_700_000_010)
  ok(
    backend.api.heartbeatWormbitsRoom({
      roomId: backend.roomId,
      playerToken: guest.token,
      tick: 0
    })
  )
  backend.setNow(1_700_000_016)
  const disconnected = ok(
    backend.api.getWormbitsRoom({
      roomId: backend.roomId,
      playerToken: host.token
    })
  )
  assert.equal(disconnected.viewer.connected, false)
  assert.equal(
    disconnected.participants.find(player => player.id === guest.id).host,
    true
  )

  const reconnected = ok(
    backend.api.heartbeatWormbitsRoom({
      roomId: backend.roomId,
      playerToken: host.token,
      tick: 0
    })
  )
  assert.equal(reconnected.viewer.connected, true)

  backend.setNow(1_700_000_080)
  ok(
    backend.api.heartbeatWormbitsRoom({
      roomId: backend.roomId,
      playerToken: guest.token,
      tick: 0
    })
  )
  backend.setNow(1_700_000_092)
  const forfeited = ok(
    backend.api.getWormbitsRoom({
      roomId: backend.roomId,
      playerToken: guest.token
    })
  )
  assert.equal(forfeited.room.status, 'completed')
  assert.equal(forfeited.room.winnerSlot, 1)
  assert.equal(
    forfeited.participants.find(player => player.id === host.id).forfeited,
    true
  )
})

test('persistent per-player action rate limiting rejects bursts', () => {
  const backend = createStartedBackend(2)
  const host = backend.players[0]
  let revision = backend.started.room.revision
  backend.setNow(1_700_000_001)

  for (let sequence = 1; sequence <= 24; sequence += 1) {
    const response = ok(
      backend.api.submitWormbitsAction({
        roomId: backend.roomId,
        playerToken: host.token,
        expectedRevision: revision,
        clientSeq: sequence,
        tick: 0,
        command: {type: 'move', direction: sequence % 2}
      })
    )
    revision = response.room.revision
  }
  assert.match(
    failed(
      backend.api.submitWormbitsAction({
        roomId: backend.roomId,
        playerToken: host.token,
        expectedRevision: revision,
        clientSeq: 25,
        tick: 0,
        command: {type: 'move', direction: 0}
      })
    ).error,
    /rate limit/
  )
})

function createStartedBackend(playerCount) {
  const backend = createBackend()
  const created = ok(
    backend.api.createWormbitsRoom({
      playerName: 'Host',
      maxPlayers: playerCount,
      seed: 'reliable-room'
    })
  )
  const players = [created.viewer]
  for (let slot = 1; slot < playerCount; slot += 1) {
    players.push(
      ok(
        backend.api.joinWormbitsRoom({
          roomId: created.room.id,
          playerName: `Player ${slot + 1}`
        })
      ).viewer
    )
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
  return {...backend, roomId: created.room.id, players, started}
}

function createBackend() {
  const rows = new Map()
  const published = []
  let timestamp = 1_700_000_000
  let idCounter = 0
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
      data = data.slice(
        options.offset || 0,
        (options.offset || 0) + (options.limit || 100)
      )
      return {data, total: data.length}
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
  const websocket = {
    publish(itemId, data) {
      published.push({itemId, data})
    }
  }
  const api = Function(
    'storage',
    'system',
    'websocket',
    `${simulationSource}\n${backendSource}\nreturn {
      createWormbitsRoom,
      getWormbitsRoom,
      joinWormbitsRoom,
      spectateWormbitsRoom,
      setWormbitsReady,
      startWormbitsMatch,
      submitWormbitsAction,
      heartbeatWormbitsRoom,
      forfeitWormbitsMatch
    }`
  )(storage, system, websocket)
  return {
    api: Object.fromEntries(
      Object.entries(api).map(([name, fn]) => [
        name,
        payload => fn(JSON.stringify(payload))
      ])
    ),
    published,
    rows,
    setNow(value) {
      timestamp = value
    }
  }
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
