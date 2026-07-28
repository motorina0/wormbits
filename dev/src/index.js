import {storage, system, websocket} from './lnbits-sdk.js'
import {
  FIXED_STEP,
  WEAPONS,
  WormBitsSimulation,
  normalizeSeed
} from '../../static/simulation.js'

const ROOMS_TABLE = 'wormbits_rooms'
const PARTICIPANTS_TABLE = 'wormbits_participants'
const ACTIONS_TABLE = 'wormbits_actions'
const MIN_PLAYERS = 2
const MAX_PLAYERS = 4
const MAX_SPECTATORS = 32
const DISCONNECT_SECONDS = 15
const FORFEIT_SECONDS = 75
const MAX_ACTIONS_PER_SECOND = 24
const MAX_ADVANCE_TICKS = 900
const CLOCK_GRACE_TICKS = 180

export function createWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    const now = system.now()
    const roomId = system.id('wormroom')
    const playerId = system.id('wormplayer')
    const token = system.id('wormtoken')
    const room = {
      id: roomId,
      name: wbCleanText(request.name, 64) || 'Worm Bits match',
      seed: normalizeSeed(request.seed || roomId),
      status: 'waiting',
      max_players: wbInteger(
        request.maxPlayers ?? request.max_players,
        MIN_PLAYERS,
        MAX_PLAYERS,
        MAX_PLAYERS
      ),
      player_count: 1,
      spectator_count: 0,
      host_player_id: playerId,
      snapshot_json: '',
      revision: 1,
      action_count: 0,
      winner_slot: -1,
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null
    }
    const host = wbNewParticipant({
      id: playerId,
      roomId,
      token,
      role: 'player',
      slot: 0,
      name: request.playerName ?? request.player_name,
      now
    })
    storage.set(ROOMS_TABLE, room)
    storage.set(PARTICIPANTS_TABLE, host)
    wbPublish(room, 'created')
    return {
      ...wbRoomView(room, token, [host]),
      publicUrl: `/ext/wormbits/rooms/${room.id}`
    }
  })
}

export function getWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    const room = wbRequiredRoom(request.roomId)
    const swept = wbSweepRoom(room, system.now())
    return wbRoomView(
      swept.room,
      wbCleanToken(request.playerToken ?? request.player_token),
      swept.participants
    )
  })
}

export function joinWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    const participants = swept.participants
    if (room.status !== 'waiting') {
      throw new Error('This Worm Bits match has already started.')
    }
    const players = wbPlayers(participants)
    if (players.length >= room.max_players) {
      throw new Error('This Worm Bits lobby is full.')
    }
    const usedSlots = new Set(players.map(player => player.slot))
    let slot = 0
    while (usedSlots.has(slot) && slot < MAX_PLAYERS) slot += 1
    const participant = wbNewParticipant({
      id: system.id('wormplayer'),
      roomId: room.id,
      token: system.id('wormtoken'),
      role: 'player',
      slot,
      name: request.playerName ?? request.player_name,
      now
    })
    storage.set(PARTICIPANTS_TABLE, participant)
    participants.push(participant)
    room = wbUpdateRoomCounts(room, participants, now)
    room.revision += 1
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'joined')
    return wbRoomView(room, participant.token, participants)
  })
}

export function spectateWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    const participants = swept.participants
    if (
      wbSpectators(participants).filter(
        participant => participant.connection_state === 'connected'
      ).length >= MAX_SPECTATORS
    ) {
      throw new Error('This Worm Bits spectator gallery is full.')
    }
    const spectator = wbNewParticipant({
      id: system.id('wormviewer'),
      roomId: room.id,
      token: system.id('wormtoken'),
      role: 'spectator',
      slot: -1,
      name:
        wbCleanText(request.playerName ?? request.player_name, 24) ||
        'Spectator',
      now
    })
    storage.set(PARTICIPANTS_TABLE, spectator)
    participants.push(spectator)
    room = wbUpdateRoomCounts(room, participants, now)
    room.revision += 1
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'spectator-joined')
    return wbRoomView(room, spectator.token, participants)
  })
}

export function setWormbitsReady(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    if (room.status !== 'waiting') {
      throw new Error('Ready state can only change in the lobby.')
    }
    const participant = wbRequireParticipant(
      swept.participants,
      request.playerToken ?? request.player_token,
      'player'
    )
    wbConsumeRate(participant, now)
    participant.ready = request.ready === true
    wbMarkConnected(participant, now)
    storage.set(PARTICIPANTS_TABLE, participant)
    room.revision += 1
    room.updated_at = now
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, participant.ready ? 'ready' : 'not-ready')
    return wbRoomView(room, participant.token, swept.participants)
  })
}

export function startWormbitsMatch(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    if (room.status !== 'waiting') {
      throw new Error('This Worm Bits match has already started.')
    }
    const host = wbRequireParticipant(
      swept.participants,
      request.playerToken ?? request.player_token,
      'player'
    )
    if (host.id !== room.host_player_id) {
      throw new Error('Only the lobby host can start the match.')
    }
    wbConsumeRate(host, now)
    const players = wbPlayers(swept.participants).sort(
      (left, right) => left.slot - right.slot
    )
    if (players.length < MIN_PLAYERS) {
      throw new Error('At least two players are required.')
    }
    if (players.some(player => !player.ready)) {
      throw new Error('Every player must be ready before the match starts.')
    }
    for (const [slot, player] of players.entries()) {
      player.slot = slot
      wbMarkConnected(player, now)
      storage.set(PARTICIPANTS_TABLE, player)
    }
    const simulation = new WormBitsSimulation({
      seed: room.seed,
      teamCount: players.length,
      teamNames: players.map(player => player.name)
    })
    simulation.consumeEvents()
    room = {
      ...room,
      status: 'active',
      player_count: players.length,
      snapshot_json: JSON.stringify(simulation.exportSnapshot()),
      revision: room.revision + 1,
      winner_slot: -1,
      updated_at: now,
      started_at: now,
      completed_at: null
    }
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'started')
    return wbRoomView(room, host.token, swept.participants)
  })
}

export function submitWormbitsAction(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    if (room.status !== 'active') {
      throw new Error('This Worm Bits match is not active.')
    }
    const participant = wbRequireParticipant(
      swept.participants,
      request.playerToken ?? request.player_token,
      'player'
    )
    if (participant.forfeited) throw new Error('This player has forfeited.')
    const expectedRevision = wbInteger(
      request.expectedRevision ?? request.expected_revision,
      0,
      Number.MAX_SAFE_INTEGER,
      -1
    )
    if (expectedRevision !== room.revision) {
      throw new Error(
        `Synchronization required: expected revision ${room.revision}.`
      )
    }
    const clientSeq = wbInteger(
      request.clientSeq ?? request.client_seq,
      1,
      Number.MAX_SAFE_INTEGER,
      -1
    )
    if (clientSeq === participant.last_client_seq) {
      return {
        accepted: true,
        duplicate: true,
        ...wbRoomView(room, participant.token, swept.participants)
      }
    }
    if (clientSeq < participant.last_client_seq) {
      throw new Error('The action sequence is stale.')
    }
    wbConsumeRate(participant, now)

    const simulation = wbSimulation(room)
    const targetTick = wbActionTick(request.tick, simulation.tick, room, now)
    wbAdvanceSimulation(simulation, targetTick)
    if (
      simulation.phase !== 'turn' ||
      simulation.activeTeam !== participant.slot
    ) {
      throw new Error('It is not this player’s turn.')
    }
    const command = wbCommand(request.command)
    if (!simulation.dispatch(command)) {
      throw new Error('The server rejected this action.')
    }
    simulation.consumeEvents()

    participant.last_client_seq = clientSeq
    wbMarkConnected(participant, now)
    storage.set(PARTICIPANTS_TABLE, participant)
    room = wbStoreSimulation(room, simulation, now)
    room.revision += 1
    room.action_count += 1
    storage.set(ROOMS_TABLE, room)
    storage.set(ACTIONS_TABLE, {
      id: `${room.id}-${room.revision}`,
      room_id: room.id,
      revision: room.revision,
      player_id: participant.id,
      slot: participant.slot,
      tick: targetTick,
      type: command.type,
      payload_json: JSON.stringify(command),
      created_at: now
    })
    wbPublish(room, 'action')
    return {
      accepted: true,
      duplicate: false,
      ...wbRoomView(room, participant.token, swept.participants)
    }
  })
}

export function heartbeatWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    const participant = wbRequireParticipant(
      swept.participants,
      request.playerToken ?? request.player_token
    )
    if (participant.forfeited) throw new Error('This participant has forfeited.')
    wbConsumeRate(participant, now)
    wbMarkConnected(participant, now)
    storage.set(PARTICIPANTS_TABLE, participant)

    let advanced = false
    if (room.status === 'active' && room.snapshot_json) {
      const simulation = wbSimulation(room)
      const activeParticipant = wbPlayers(swept.participants).find(
        player => player.slot === simulation.activeTeam
      )
      const mayAdvance =
        participant.slot === simulation.activeTeam ||
        !activeParticipant ||
        activeParticipant.connection_state === 'disconnected'
      if (mayAdvance) {
        const targetTick = wbActionTick(
          request.tick,
          simulation.tick,
          room,
          now
        )
        if (targetTick > simulation.tick) {
          wbAdvanceSimulation(simulation, targetTick)
          room = wbStoreSimulation(room, simulation, now)
          room.revision += 1
          storage.set(ROOMS_TABLE, room)
          advanced = true
        }
      }
    }
    if (advanced) wbPublish(room, 'snapshot')
    return wbRoomView(room, participant.token, swept.participants)
  })
}

export function forfeitWormbitsMatch(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    let room = wbRequiredRoom(request.roomId)
    const now = system.now()
    const swept = wbSweepRoom(room, now)
    room = swept.room
    const participant = wbRequireParticipant(
      swept.participants,
      request.playerToken ?? request.player_token,
      'player'
    )
    if (participant.forfeited) {
      return wbRoomView(room, participant.token, swept.participants)
    }
    wbConsumeRate(participant, now)
    participant.forfeited = true
    participant.ready = false
    participant.connection_state = 'disconnected'
    participant.disconnected_at = now
    participant.last_seen_at = now
    storage.set(PARTICIPANTS_TABLE, participant)

    if (room.status === 'active' && room.snapshot_json) {
      const simulation = wbSimulation(room)
      simulation.forfeitTeam(participant.slot)
      simulation.consumeEvents()
      room = wbStoreSimulation(room, simulation, now)
    }
    room = wbUpdateRoomCounts(room, swept.participants, now)
    room = wbTransferHost(room, swept.participants)
    room.revision += 1
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'forfeit')
    return wbRoomView(room, participant.token, swept.participants)
  })
}

function wbSweepRoom(room, now) {
  const participants = wbParticipants(room.id)
  let participantsChanged = false
  let simulation = null
  let simulationChanged = false

  for (const participant of [...participants]) {
    if (participant.forfeited) continue
    const idleSeconds = Math.max(0, now - Number(participant.last_seen_at || 0))
    if (
      participant.role === 'spectator' &&
      idleSeconds >= FORFEIT_SECONDS
    ) {
      storage.delete(PARTICIPANTS_TABLE, participant.id)
      participants.splice(participants.indexOf(participant), 1)
      participantsChanged = true
      continue
    }
    if (
      idleSeconds >= DISCONNECT_SECONDS &&
      participant.connection_state !== 'disconnected'
    ) {
      participant.connection_state = 'disconnected'
      participant.disconnected_at = now
      storage.set(PARTICIPANTS_TABLE, participant)
      participantsChanged = true
    }
    if (
      participant.role === 'player' &&
      idleSeconds >= FORFEIT_SECONDS &&
      ['waiting', 'active'].includes(room.status)
    ) {
      participant.forfeited = true
      participant.ready = false
      storage.set(PARTICIPANTS_TABLE, participant)
      participantsChanged = true
      if (room.status === 'active' && room.snapshot_json) {
        simulation ||= wbSimulation(room)
        simulationChanged =
          simulation.forfeitTeam(participant.slot) || simulationChanged
      }
    }
  }

  const previousHost = room.host_player_id
  room = wbTransferHost(room, participants)
  const hostChanged = previousHost !== room.host_player_id
  const previousPlayerCount = room.player_count
  const previousSpectatorCount = room.spectator_count
  room = wbUpdateRoomCounts(room, participants, now)
  const countsChanged =
    previousPlayerCount !== room.player_count ||
    previousSpectatorCount !== room.spectator_count

  if (simulationChanged && simulation) {
    simulation.consumeEvents()
    room = wbStoreSimulation(room, simulation, now)
  }
  if (participantsChanged || hostChanged || countsChanged || simulationChanged) {
    room.revision += 1
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, simulationChanged ? 'timeout-forfeit' : 'presence')
  }
  return {room, participants, changed: participantsChanged || simulationChanged}
}

function wbStoreSimulation(room, simulation, now) {
  const updated = {
    ...room,
    snapshot_json: JSON.stringify(simulation.exportSnapshot()),
    updated_at: now
  }
  if (simulation.phase === 'finished') {
    updated.status = 'completed'
    updated.winner_slot =
      simulation.winner === null ? -1 : Number(simulation.winner)
    updated.completed_at = updated.completed_at || now
  }
  return updated
}

function wbSimulation(room) {
  if (!room.snapshot_json) throw new Error('The room has no durable snapshot.')
  return WormBitsSimulation.fromSnapshot(JSON.parse(room.snapshot_json))
}

function wbAdvanceSimulation(simulation, targetTick) {
  let remaining = targetTick - simulation.tick
  if (remaining > MAX_ADVANCE_TICKS) {
    throw new Error('Synchronization window exceeded; fetch a new snapshot.')
  }
  while (remaining > 0 && simulation.phase !== 'finished') {
    simulation.update(FIXED_STEP)
    remaining -= 1
  }
  simulation.consumeEvents()
}

function wbActionTick(value, currentTick, room, now) {
  const target = wbInteger(
    value,
    currentTick,
    Number.MAX_SAFE_INTEGER,
    currentTick
  )
  if (target < currentTick) {
    throw new Error('Synchronization required: the client tick is stale.')
  }
  if (target - currentTick > MAX_ADVANCE_TICKS) {
    throw new Error('Synchronization window exceeded; fetch a new snapshot.')
  }
  const elapsedSeconds = Math.max(0, now - Number(room.started_at || now))
  const maximumClockTick =
    Math.floor(elapsedSeconds / FIXED_STEP) + CLOCK_GRACE_TICKS
  if (target > maximumClockTick) {
    throw new Error('The client clock is too far ahead of the server.')
  }
  return target
}

function wbCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('A command object is required.')
  }
  const type = wbCleanText(value.type, 24)
  if (['move', 'aim'].includes(type)) {
    return {
      type,
      direction: wbInteger(value.direction, -1, 1, 0)
    }
  }
  if (type === 'select') {
    const weapon = wbCleanText(value.weapon, 24)
    if (!WEAPONS[weapon]) throw new Error('Unknown Worm Bits weapon.')
    return {type, weapon}
  }
  if (['jump', 'chargeStart', 'fire', 'skip'].includes(type)) return {type}
  throw new Error('Unknown Worm Bits command.')
}

function wbConsumeRate(participant, now) {
  if (Number(participant.rate_window_at || 0) !== now) {
    participant.rate_window_at = now
    participant.rate_count = 1
  } else {
    participant.rate_count = Number(participant.rate_count || 0) + 1
  }
  storage.set(PARTICIPANTS_TABLE, participant)
  if (participant.rate_count > MAX_ACTIONS_PER_SECOND) {
    throw new Error('Action rate limit exceeded.')
  }
}

function wbUpdateRoomCounts(room, participants, now) {
  return {
    ...room,
    player_count: wbPlayers(participants).length,
    spectator_count: wbSpectators(participants).filter(
      participant => participant.connection_state === 'connected'
    ).length,
    updated_at: now
  }
}

function wbTransferHost(room, participants) {
  const currentHost = participants.find(
    participant => participant.id === room.host_player_id
  )
  if (
    currentHost &&
    !currentHost.forfeited &&
    currentHost.connection_state === 'connected'
  ) {
    return room
  }
  const replacement = wbPlayers(participants)
    .filter(player => player.connection_state === 'connected')
    .sort(
      (left, right) =>
        Number(left.joined_at || 0) - Number(right.joined_at || 0)
    )[0]
  return replacement ? {...room, host_player_id: replacement.id} : room
}

function wbRoomView(room, token, participants = wbParticipants(room.id)) {
  const viewer = token
    ? participants.find(participant => participant.token === token) || null
    : null
  let snapshot = null
  if (room.snapshot_json && ['active', 'completed'].includes(room.status)) {
    snapshot = JSON.parse(room.snapshot_json)
  }
  return {
    room: {
      id: room.id,
      name: room.name,
      seed: room.seed,
      status: room.status,
      maxPlayers: Number(room.max_players),
      playerCount: Number(room.player_count),
      spectatorCount: Number(room.spectator_count),
      hostPlayerId: room.host_player_id,
      revision: Number(room.revision),
      actionCount: Number(room.action_count),
      winnerSlot: Number(room.winner_slot),
      createdAt: Number(room.created_at),
      updatedAt: Number(room.updated_at),
      startedAt: Number(room.started_at || 0),
      completedAt: Number(room.completed_at || 0)
    },
    participants: participants
      .filter(participant => !participant.forfeited || participant.role === 'player')
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === 'player' ? -1 : 1
        return left.slot - right.slot || left.joined_at - right.joined_at
      })
      .map(participant => wbPublicParticipant(participant, room)),
    viewer: viewer ? wbPrivateParticipant(viewer, room) : null,
    snapshot,
    serverTime: system.now()
  }
}

function wbPublicParticipant(participant, room) {
  return {
    id: participant.id,
    role: participant.role,
    slot: Number(participant.slot),
    name: participant.name,
    ready: participant.ready === true,
    connected: participant.connection_state === 'connected',
    forfeited: participant.forfeited === true,
    host: participant.id === room.host_player_id,
    joinedAt: Number(participant.joined_at)
  }
}

function wbPrivateParticipant(participant, room) {
  return {
    ...wbPublicParticipant(participant, room),
    token: participant.token,
    lastClientSeq: Number(participant.last_client_seq || 0)
  }
}

function wbNewParticipant({id, roomId, token, role, slot, name, now}) {
  return {
    id,
    room_id: roomId,
    token,
    role,
    slot,
    name: wbCleanText(name, 24) || (role === 'player' ? 'Anonymous Bit' : 'Spectator'),
    ready: false,
    connection_state: 'connected',
    forfeited: false,
    last_seen_at: now,
    disconnected_at: null,
    joined_at: now,
    rate_window_at: now,
    rate_count: 0,
    last_client_seq: 0
  }
}

function wbMarkConnected(participant, now) {
  participant.connection_state = 'connected'
  participant.last_seen_at = now
  participant.disconnected_at = null
}

function wbPlayers(participants) {
  return participants.filter(
    participant => participant.role === 'player' && !participant.forfeited
  )
}

function wbSpectators(participants) {
  return participants.filter(
    participant => participant.role === 'spectator' && !participant.forfeited
  )
}

function wbParticipants(roomId) {
  return storage.list(PARTICIPANTS_TABLE, {
    filters: {room_id: roomId},
    sortBy: 'joined_at',
    descending: false,
    limit: MAX_PLAYERS + MAX_SPECTATORS
  }).data
}

function wbRequiredRoom(value) {
  const roomId = wbRequiredText(value, 'roomId', 128)
  const room = storage.get(ROOMS_TABLE, roomId, null)
  if (!room) throw new Error('Worm Bits room not found.')
  return room
}

function wbRequireParticipant(participants, tokenValue, role = '') {
  const token = wbCleanToken(tokenValue)
  const participant = participants.find(candidate => candidate.token === token)
  if (!participant || (role && participant.role !== role)) {
    throw new Error('A valid Worm Bits participant token is required.')
  }
  return participant
}

function wbPublish(room, event) {
  try {
    websocket.publish(`room:${room.id}`, {
      type: 'server',
      event,
      roomId: room.id,
      revision: Number(room.revision),
      status: room.status
    })
  } catch (error) {
    system.log(`wormbits websocket publish failed: ${wbError(error)}`, 'warning')
  }
}

function wbRunJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    return JSON.stringify({ok: false, error: wbError(error)})
  }
}

function wbParseObject(value) {
  if (!value) return {}
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request must be a JSON object.')
  }
  return parsed
}

function wbInteger(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isInteger(number)) return fallback
  return Math.min(maximum, Math.max(minimum, number))
}

function wbCleanToken(value) {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
    : ''
}

function wbCleanText(value, maximum) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximum)
    : ''
}

function wbRequiredText(value, field, maximum) {
  const text = wbCleanText(value, maximum)
  if (!text) throw new Error(`${field} is required.`)
  return text
}

function wbError(error) {
  return error instanceof Error ? error.message : String(error)
}
