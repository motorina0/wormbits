import {storage, system, wallet, websocket} from './lnbits-sdk.js'
import {
  FIXED_STEP,
  WEAPONS,
  WormBitsSimulation,
  normalizeSeed
} from '../../static/simulation.js'

const ROOMS_TABLE = 'wormbits_rooms'
const PARTICIPANTS_TABLE = 'wormbits_participants'
const ACTIONS_TABLE = 'wormbits_actions'
const PAYMENT_INTENTS_TABLE = 'wormbits_payment_intents'
const SETTLEMENTS_TABLE = 'wormbits_settlements'
const MIN_PLAYERS = 2
const MAX_PLAYERS = 4
const MAX_SPECTATORS = 32
const MAX_PENDING_PLAYERS = 12
const MAX_ENTRY_FEE_SATS = 1_000_000
const DISCONNECT_SECONDS = 15
const FORFEIT_SECONDS = 75
const MAX_ACTIONS_PER_SECOND = 24
const MAX_ADVANCE_TICKS = 900
const CLOCK_GRACE_TICKS = 180

export function listWormbitsWallets(_requestJson) {
  return wbRunJson(() => ({
    wallets: wallet.listUserWallets().map(item => ({
      id: item.id,
      name: item.name,
      currency: item.currency || ''
    }))
  }))
}

export function createWormbitsRoom(requestJson) {
  return wbRunJson(() => {
    const request = wbParseObject(requestJson)
    const suppliedRequestId = wbCleanRequestId(
      request.requestId ?? request.request_id
    )
    if (suppliedRequestId) {
      const existing = wbParticipantByJoinRequest(suppliedRequestId)
      if (existing) {
        const existingRoom = wbRequiredRoom(existing.room_id)
        if (existing.id !== existingRoom.host_player_id) {
          throw new Error('This Worm Bits room request ID is already in use.')
        }
        return {
          ...wbRoomView(
            existingRoom,
            existing.token,
            wbParticipants(existingRoom.id)
          ),
          publicUrl: `/ext/wormbits/rooms/${existingRoom.id}`
        }
      }
    }
    const now = system.now()
    const roomId = system.id('wormroom')
    const playerId = system.id('wormplayer')
    const token = system.id('wormtoken')
    const maxPlayers = wbStrictInteger(
      request.maxPlayers ?? request.max_players,
      'maxPlayers',
      MIN_PLAYERS,
      MAX_PLAYERS,
      MAX_PLAYERS
    )
    const entryFeeSats = wbStrictInteger(
      request.entryFeeSats ?? request.entry_fee_sats,
      'entryFeeSats',
      0,
      MAX_ENTRY_FEE_SATS,
      0
    )
    const walletId =
      entryFeeSats > 0
        ? wbRequiredText(request.walletId ?? request.wallet_id, 'walletId', 128)
        : ''
    const selectedWallet =
      entryFeeSats > 0
        ? wallet.listUserWallets().find(item => item.id === walletId)
        : null
    if (entryFeeSats > 0 && !selectedWallet) {
      throw new Error('Select one of your LNbits wallets for the room pot.')
    }
    const lnAddress =
      entryFeeSats > 0
        ? wbNormalizeLnAddress(request.lnAddress ?? request.ln_address)
        : ''
    const room = {
      id: roomId,
      name: wbCleanText(request.name, 64) || 'Worm Bits match',
      seed: normalizeSeed(request.seed || roomId),
      status: 'waiting',
      max_players: maxPlayers,
      player_count: entryFeeSats > 0 ? 0 : 1,
      spectator_count: 0,
      host_player_id: playerId,
      snapshot_json: '',
      revision: 1,
      action_count: 0,
      winner_slot: -1,
      wallet_id: walletId,
      wallet_name: selectedWallet?.name || '',
      entry_fee_sats: entryFeeSats,
      pot_sats: 0,
      settlement_status: 'none',
      settlement_kind: '',
      created_at: now,
      updated_at: now,
      started_at: null,
      completed_at: null,
      settled_at: null
    }
    const host = wbNewParticipant({
      id: playerId,
      roomId,
      token,
      role: 'player',
      slot: 0,
      name: request.playerName ?? request.player_name,
      lnAddress,
      joinRequestId: suppliedRequestId || system.id('wormjoin'),
      paymentStatus: entryFeeSats > 0 ? 'pending' : 'free',
      now
    })
    storage.set(ROOMS_TABLE, room)
    storage.set(PARTICIPANTS_TABLE, host)
    if (entryFeeSats > 0) {
      try {
        wbCreateEntryInvoice(room, host, now)
      } catch (error) {
        storage.delete(PARTICIPANTS_TABLE, host.id)
        storage.delete(ROOMS_TABLE, room.id)
        throw error
      }
    }
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
    const paidRoom = Number(room.entry_fee_sats || 0) > 0
    const requestId =
      wbCleanRequestId(request.requestId ?? request.request_id) ||
      (paidRoom
        ? wbRequiredRequestId('')
        : system.id('wormjoin'))
    const existing = participants.find(
      participant =>
        participant.role === 'player' &&
        participant.join_request_id === requestId
    )
    if (existing) return wbRoomView(room, existing.token, participants)

    const players = wbPlayers(participants)
    if (players.length >= room.max_players) {
      throw new Error('This Worm Bits lobby is full.')
    }
    const pendingPlayers = participants.filter(
      participant =>
        participant.role === 'player' &&
        !participant.forfeited &&
        participant.payment_status === 'pending'
    )
    if (pendingPlayers.length >= MAX_PENDING_PLAYERS) {
      throw new Error('Too many entry payments are pending for this room.')
    }
    const slot = paidRoom ? -1 : wbAvailableSlot(participants)
    const participant = wbNewParticipant({
      id: system.id('wormplayer'),
      roomId: room.id,
      token: system.id('wormtoken'),
      role: 'player',
      slot,
      name: request.playerName ?? request.player_name,
      lnAddress: paidRoom
        ? wbNormalizeLnAddress(request.lnAddress ?? request.ln_address)
        : '',
      joinRequestId: requestId,
      paymentStatus: paidRoom ? 'pending' : 'free',
      now
    })
    storage.set(PARTICIPANTS_TABLE, participant)
    if (paidRoom) {
      try {
        wbCreateEntryInvoice(room, participant, now)
      } catch (error) {
        storage.delete(PARTICIPANTS_TABLE, participant.id)
        throw error
      }
    }
    participants.push(participant)
    room = wbUpdateRoomCounts(room, participants, now)
    room = wbTransferHost(room, participants)
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
    wbRequireEntryConfirmed(participant)
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
    wbRequireEntryConfirmed(host)
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
      pot_sats: Number(room.entry_fee_sats || 0) * players.length,
      settlement_status:
        Number(room.entry_fee_sats || 0) > 0 ? 'escrowed' : 'not-required',
      settlement_kind: '',
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
    if (
      room.status === 'waiting' &&
      wbPaymentStatus(participant) === 'paid'
    ) {
      participant.payment_status = 'refund-pending'
    }
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
    if (participant.payment_status === 'refund-pending') {
      const refund = wbEnsureSettlement(
        room,
        participant,
        'refund',
        Number(room.entry_fee_sats || 0),
        'pre-start-forfeit'
      )
      wbAttemptSettlement(room, participant, refund)
    }
    wbPublish(room, 'forfeit')
    return wbRoomView(room, participant.token, swept.participants)
  })
}

export function settleWormbitsRoom(requestJson) {
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
    wbConsumeRate(participant, now)

    if (room.status === 'waiting') {
      if (
        !participant.forfeited ||
        !['refund-pending', 'refund-failed'].includes(
          wbPaymentStatus(participant)
        )
      ) {
        throw new Error('This player does not have a pending refund.')
      }
      const refund = wbEnsureSettlement(
        room,
        participant,
        'refund',
        Number(room.entry_fee_sats || 0),
        'pre-start-forfeit'
      )
      wbAttemptSettlement(room, participant, refund)
      room.revision += 1
      room.updated_at = system.now()
      storage.set(ROOMS_TABLE, room)
      wbPublish(room, 'refund')
      return wbRoomView(room, participant.token, swept.participants)
    }

    if (room.status !== 'completed') {
      throw new Error('Only completed Worm Bits matches can be settled.')
    }
    wbValidateCompletedRoom(room, swept.participants)
    room = wbEnsureFinalSettlements(room, swept.participants)
    const pending = wbSettlements(room.id)
      .filter(settlement => settlement.kind === 'payout')
      .find(settlement => ['pending', 'failed'].includes(settlement.status))
    if (pending) {
      const payee = swept.participants.find(
        item => item.id === pending.participant_id
      )
      if (!payee) throw new Error('Settlement participant is missing.')
      wbAttemptSettlement(room, payee, pending)
    }
    room = wbRefreshFinalSettlementStatus(room)
    room.revision += 1
    room.updated_at = system.now()
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'settlement')
    return wbRoomView(room, participant.token, swept.participants)
  })
}

export function recordWormbitsPayment(eventJson) {
  return wbRunJson(() => {
    const event = wbParseObject(eventJson)
    const paymentHash = wbEventPaymentHash(event)
    if (!paymentHash) throw new Error('paymentHash is required.')
    const intent = storage.get(PAYMENT_INTENTS_TABLE, paymentHash, null)
    if (!intent) throw new Error('Worm Bits payment intent not found.')
    let room = wbRequiredRoom(intent.room_id)
    const participants = wbParticipants(room.id)
    const participant = participants.find(
      item => item.id === intent.participant_id
    )
    if (!participant || participant.payment_hash !== paymentHash) {
      throw new Error('Worm Bits payment participant mismatch.')
    }
    const eventWalletId = wbCleanText(
      event.walletId ?? event.wallet_id ?? event.payment?.wallet_id,
      128
    )
    if (eventWalletId && eventWalletId !== room.wallet_id) {
      throw new Error('Worm Bits payment wallet mismatch.')
    }
    const extra =
      event.extra?.extra_wormbits ||
      event.payment?.extra?.extra_wormbits ||
      {}
    const eventRoomId = wbCleanText(
      extra.room_id ||
        event.extra?.source_id ||
        event.payment?.extra?.source_id,
      128
    )
    const eventParticipantId = wbCleanText(extra.participant_id, 128)
    if (
      (eventRoomId && eventRoomId !== room.id) ||
      (eventParticipantId && eventParticipantId !== participant.id)
    ) {
      throw new Error('Worm Bits payment metadata mismatch.')
    }
    if (
      intent.status === 'paid' &&
      wbPaymentStatus(participant) === 'paid'
    ) {
      const reconciled = wbUpdateRoomCounts(room, participants, system.now())
      if (
        reconciled.player_count !== room.player_count ||
        reconciled.pot_sats !== room.pot_sats
      ) {
        room = {...reconciled, revision: room.revision + 1}
        storage.set(ROOMS_TABLE, room)
        wbPublish(room, 'payment-reconciled')
      }
      return wbRoomView(room, participant.token, participants)
    }

    const now = system.now()
    const amountSats = wbPaidAmountSats(event)
    intent.status = 'paid'
    intent.settled_at = now
    storage.set(PAYMENT_INTENTS_TABLE, intent)

    const expectedAmount = Number(room.entry_fee_sats || 0)
    const canAdmit =
      room.status === 'waiting' &&
      !participant.forfeited &&
      wbPlayers(participants).length < Number(room.max_players) &&
      amountSats === expectedAmount
    if (canAdmit) {
      participant.payment_status = 'paid'
      participant.paid_at = now
      participant.slot =
        participant.slot >= 0
          ? participant.slot
          : wbAvailableSlot(participants)
      wbMarkConnected(participant, now)
      storage.set(PARTICIPANTS_TABLE, participant)
      room = wbUpdateRoomCounts(room, participants, now)
      room = wbTransferHost(room, participants)
      room.revision += 1
      storage.set(ROOMS_TABLE, room)
      wbPublish(room, 'payment-confirmed')
      return wbRoomView(room, participant.token, participants)
    }

    participant.ready = false
    participant.forfeited = true
    participant.connection_state = 'disconnected'
    participant.payment_status = 'refund-pending'
    participant.paid_at = now
    storage.set(PARTICIPANTS_TABLE, participant)
    const reason =
      amountSats !== expectedAmount ? 'amount-mismatch' : 'room-unavailable'
    const refund = wbEnsureSettlement(
      room,
      participant,
      'refund',
      amountSats,
      reason
    )
    wbAttemptSettlement(room, participant, refund)
    room = wbUpdateRoomCounts(room, participants, now)
    room.revision += 1
    storage.set(ROOMS_TABLE, room)
    wbPublish(room, 'payment-refund')
    return wbRoomView(room, participant.token, participants)
  })
}

function wbCreateEntryInvoice(room, participant, now) {
  const invoice = wallet.createInvoicePublic({
    sourceId: room.id,
    amount: Number(room.entry_fee_sats),
    currency: 'sat',
    memo: `Worm Bits entry for ${room.name}`,
    extra: {
      room_id: room.id,
      participant_id: participant.id,
      join_request_id: participant.join_request_id
    }
  })
  const paymentHash = wbRequiredText(
    invoice.paymentHash,
    'paymentHash',
    128
  )
  participant.payment_hash = paymentHash
  participant.payment_request = wbRequiredText(
    invoice.paymentRequest,
    'paymentRequest',
    8192
  )
  storage.set(PARTICIPANTS_TABLE, participant)
  storage.set(PAYMENT_INTENTS_TABLE, {
    id: paymentHash,
    room_id: room.id,
    participant_id: participant.id,
    amount_sats: Number(room.entry_fee_sats),
    status: 'pending',
    created_at: now,
    settled_at: null
  })
  return invoice
}

function wbEnsureSettlement(room, participant, kind, amountSats, reason) {
  if (!['payout', 'refund'].includes(kind)) {
    throw new Error('Unknown Worm Bits settlement kind.')
  }
  if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
    throw new Error('Settlement amount must be a positive integer.')
  }
  const id = `${room.id}-${kind}-${participant.id}`
  const existing = storage.get(SETTLEMENTS_TABLE, id, null)
  if (existing) {
    if (
      existing.participant_id !== participant.id ||
      Number(existing.amount_sats) !== amountSats ||
      existing.kind !== kind
    ) {
      throw new Error('Stored Worm Bits settlement does not match.')
    }
    return existing
  }
  const now = system.now()
  const settlement = {
    id,
    room_id: room.id,
    participant_id: participant.id,
    kind,
    reason: wbCleanText(reason, 64),
    amount_sats: amountSats,
    status: 'pending',
    attempt_count: 0,
    checking_id: '',
    payment_hash: '',
    error: '',
    created_at: now,
    updated_at: now,
    completed_at: null
  }
  storage.set(SETTLEMENTS_TABLE, settlement)
  return settlement
}

function wbAttemptSettlement(room, participant, settlement) {
  if (
    settlement.status === 'paid' &&
    settlement.kind === 'refund' &&
    wbPaymentStatus(participant) !== 'refunded'
  ) {
    participant.payment_status = 'refunded'
    storage.set(PARTICIPANTS_TABLE, participant)
  }
  if (
    ['paid', 'processing', 'manual-review'].includes(settlement.status)
  ) {
    return settlement
  }
  if (!['pending', 'failed'].includes(settlement.status)) {
    throw new Error('This Worm Bits settlement cannot be retried.')
  }
  const processing = {
    ...settlement,
    status: 'processing',
    attempt_count: Number(settlement.attempt_count || 0) + 1,
    error: '',
    updated_at: system.now()
  }
  storage.set(SETTLEMENTS_TABLE, processing)

  let response
  try {
    response = wallet.payLnurl({
      walletId: room.wallet_id,
      lnurl: participant.ln_address,
      amount: Number(processing.amount_sats),
      currency: 'sat',
      comment:
        processing.kind === 'refund'
          ? 'Worm Bits refund'
          : 'Worm Bits winnings',
      maxSat: Number(processing.amount_sats),
      description:
        processing.kind === 'refund'
          ? `Worm Bits refund for ${room.name}`
          : `Worm Bits winnings for ${room.name}`,
      extra: {
        wormbits_room_id: room.id,
        wormbits_participant_id: participant.id,
        wormbits_settlement_id: processing.id,
        wormbits_settlement_kind: processing.kind
      }
    })
  } catch (error) {
    const ambiguous = {
      ...processing,
      status: 'manual-review',
      error: wbCleanText(wbError(error), 240),
      updated_at: system.now()
    }
    storage.set(SETTLEMENTS_TABLE, ambiguous)
    if (processing.kind === 'refund') {
      participant.payment_status = 'refund-review'
      storage.set(PARTICIPANTS_TABLE, participant)
    }
    return ambiguous
  }

  const paid = response.ok === true && response.success === true
  const pending = response.ok === true && response.pending === true
  const updated = {
    ...processing,
    status: paid ? 'paid' : pending ? 'processing' : 'failed',
    checking_id: wbCleanText(response.checkingId, 256),
    payment_hash: wbCleanText(response.paymentHash, 128),
    error:
      paid || pending
        ? ''
        : wbCleanText(response.error || 'Lightning payment failed.', 240),
    updated_at: system.now(),
    completed_at: paid ? system.now() : null
  }
  storage.set(SETTLEMENTS_TABLE, updated)
  if (processing.kind === 'refund') {
    participant.payment_status = paid
      ? 'refunded'
      : pending
        ? 'refund-processing'
        : 'refund-failed'
    storage.set(PARTICIPANTS_TABLE, participant)
  }
  return updated
}

function wbEnsureFinalSettlements(room, participants) {
  const potSats = Number(room.pot_sats || 0)
  if (potSats <= 0) {
    const freeRoom = {
      ...room,
      settlement_status: 'not-required',
      settlement_kind: '',
      settled_at: room.settled_at || system.now()
    }
    storage.set(ROOMS_TABLE, freeRoom)
    return freeRoom
  }
  const existing = wbSettlements(room.id).filter(
    settlement => settlement.kind === 'payout'
  )
  if (existing.length) return room

  const paidPlayers = participants
    .filter(
      participant =>
        participant.role === 'player' &&
        wbPaymentStatus(participant) === 'paid' &&
        participant.slot >= 0
    )
    .sort((left, right) => left.slot - right.slot)
  const expectedPot = Number(room.entry_fee_sats || 0) * paidPlayers.length
  if (potSats !== expectedPot) {
    throw new Error('The stored Worm Bits pot does not match paid entrants.')
  }

  if (Number(room.winner_slot) >= 0) {
    const winner = paidPlayers.find(
      participant => participant.slot === Number(room.winner_slot)
    )
    if (!winner) throw new Error('The server-validated winner is missing.')
    wbEnsureSettlement(room, winner, 'payout', potSats, 'winner')
    room = {
      ...room,
      settlement_kind: 'winner',
      settlement_status: 'pending'
    }
  } else {
    if (!paidPlayers.length) {
      throw new Error('A draw has no paid players to settle.')
    }
    const base = Math.floor(potSats / paidPlayers.length)
    const remainder = potSats % paidPlayers.length
    paidPlayers.forEach((participant, index) => {
      wbEnsureSettlement(
        room,
        participant,
        'payout',
        base + (index < remainder ? 1 : 0),
        'draw'
      )
    })
    room = {
      ...room,
      settlement_kind: 'draw',
      settlement_status: 'pending'
    }
  }
  storage.set(ROOMS_TABLE, room)
  return room
}

function wbRefreshFinalSettlementStatus(room) {
  const settlements = wbSettlements(room.id).filter(
    settlement => settlement.kind === 'payout'
  )
  if (!settlements.length) return room
  const statuses = new Set(settlements.map(settlement => settlement.status))
  let status = 'pending'
  if ([...statuses].some(value => ['processing', 'manual-review'].includes(value))) {
    status = 'processing'
  } else if (statuses.has('failed')) {
    status = 'failed'
  } else if (settlements.every(settlement => settlement.status === 'paid')) {
    status = 'paid'
  }
  return {
    ...room,
    settlement_status: status,
    settled_at: status === 'paid' ? room.settled_at || system.now() : null
  }
}

function wbValidateCompletedRoom(room, participants) {
  const simulation = wbSimulation(room)
  if (simulation.phase !== 'finished') {
    throw new Error('The authoritative Worm Bits snapshot is not finished.')
  }
  const winnerSlot =
    simulation.winner === null ? -1 : Number(simulation.winner)
  if (winnerSlot !== Number(room.winner_slot)) {
    throw new Error('The authoritative Worm Bits winner does not match.')
  }
  const entrants = participants.filter(
    participant =>
      participant.role === 'player' &&
      wbPaymentStatus(participant) === 'paid' &&
      participant.slot >= 0
  )
  if (
    Number(room.pot_sats || 0) > 0 &&
    entrants.length !== Number(simulation.teamCount)
  ) {
    throw new Error('The authoritative entrant count does not match the pot.')
  }
  if (
    winnerSlot >= 0 &&
    !entrants.some(participant => participant.slot === winnerSlot)
  ) {
    throw new Error('The authoritative winner is not a paid entrant.')
  }
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
      if (
        room.status === 'waiting' &&
        wbPaymentStatus(participant) === 'paid'
      ) {
        participant.payment_status = 'refund-pending'
        wbEnsureSettlement(
          room,
          participant,
          'refund',
          Number(room.entry_fee_sats || 0),
          'waiting-timeout'
        )
      }
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
    updated.settlement_status =
      Number(updated.pot_sats || 0) > 0 ? 'pending' : 'not-required'
    updated.settlement_kind = ''
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
  const players = wbPlayers(participants)
  return {
    ...room,
    player_count: players.length,
    pot_sats:
      room.status === 'waiting'
        ? Number(room.entry_fee_sats || 0) * players.length
        : Number(room.pot_sats || 0),
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
      walletName: room.wallet_name || '',
      entryFeeSats: Number(room.entry_fee_sats || 0),
      potSats: Number(room.pot_sats || 0),
      settlementStatus: room.settlement_status || 'none',
      settlementKind: room.settlement_kind || '',
      createdAt: Number(room.created_at),
      updatedAt: Number(room.updated_at),
      startedAt: Number(room.started_at || 0),
      completedAt: Number(room.completed_at || 0),
      settledAt: Number(room.settled_at || 0)
    },
    participants: participants
      .filter(participant => !participant.forfeited || participant.role === 'player')
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === 'player' ? -1 : 1
        return left.slot - right.slot || left.joined_at - right.joined_at
      })
      .map(participant => wbPublicParticipant(participant, room)),
    viewer: viewer ? wbPrivateParticipant(viewer, room) : null,
    invoice:
      viewer && wbPaymentStatus(viewer) === 'pending'
        ? {
            paymentHash: viewer.payment_hash || '',
            paymentRequest: viewer.payment_request || '',
            amountSats: Number(room.entry_fee_sats || 0)
          }
        : null,
    settlements: wbSettlements(room.id).map(wbPublicSettlement),
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
    paymentStatus: wbPaymentStatus(participant),
    payoutAddress: wbMaskLnAddress(participant.ln_address || ''),
    host: participant.id === room.host_player_id,
    joinedAt: Number(participant.joined_at)
  }
}

function wbPrivateParticipant(participant, room) {
  return {
    ...wbPublicParticipant(participant, room),
    token: participant.token,
    paymentHash: participant.payment_hash || '',
    paymentRequest:
      wbPaymentStatus(participant) === 'pending'
        ? participant.payment_request || ''
        : '',
    lastClientSeq: Number(participant.last_client_seq || 0)
  }
}

function wbNewParticipant({
  id,
  roomId,
  token,
  role,
  slot,
  name,
  lnAddress = '',
  joinRequestId = '',
  paymentStatus = 'free',
  now
}) {
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
    ln_address: lnAddress,
    join_request_id: joinRequestId,
    payment_hash: '',
    payment_request: '',
    payment_status: paymentStatus,
    paid_at: null,
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
    participant =>
      participant.role === 'player' &&
      !participant.forfeited &&
      wbEntryConfirmed(participant)
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
    limit: MAX_PENDING_PLAYERS + MAX_PLAYERS + MAX_SPECTATORS
  }).data
}

function wbSettlements(roomId) {
  return storage.list(SETTLEMENTS_TABLE, {
    filters: {room_id: roomId},
    sortBy: 'created_at',
    descending: false,
    limit: 64
  }).data
}

function wbPublicSettlement(settlement) {
  return {
    id: settlement.id,
    participantId: settlement.participant_id,
    kind: settlement.kind,
    reason: settlement.reason,
    amountSats: Number(settlement.amount_sats),
    status: settlement.status,
    attemptCount: Number(settlement.attempt_count || 0),
    recoverable: settlement.status === 'failed',
    needsReview: settlement.status === 'manual-review',
    createdAt: Number(settlement.created_at || 0),
    updatedAt: Number(settlement.updated_at || 0),
    completedAt: Number(settlement.completed_at || 0)
  }
}

function wbParticipantByJoinRequest(requestId) {
  return (
    storage.list(PARTICIPANTS_TABLE, {
      filters: {join_request_id: requestId},
      sortBy: 'joined_at',
      descending: false,
      limit: 1
    }).data[0] || null
  )
}

function wbAvailableSlot(participants) {
  const usedSlots = new Set(
    participants
      .filter(
        participant =>
          participant.role === 'player' &&
          !participant.forfeited &&
          participant.slot >= 0
      )
      .map(participant => Number(participant.slot))
  )
  for (let slot = 0; slot < MAX_PLAYERS; slot += 1) {
    if (!usedSlots.has(slot)) return slot
  }
  throw new Error('This Worm Bits lobby has no available player slot.')
}

function wbPaymentStatus(participant) {
  return participant.payment_status || 'free'
}

function wbEntryConfirmed(participant) {
  return ['free', 'paid'].includes(wbPaymentStatus(participant))
}

function wbRequireEntryConfirmed(participant) {
  if (!wbEntryConfirmed(participant)) {
    throw new Error('Confirm the Worm Bits entry payment before readying.')
  }
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

function wbStrictInteger(value, field, minimum, maximum, fallback) {
  const candidate = value === undefined || value === null ? fallback : value
  const number = Number(candidate)
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${field} must be an integer.`)
  }
  if (number < minimum || number > maximum) {
    throw new Error(`${field} must be between ${minimum} and ${maximum}.`)
  }
  return number
}

function wbCleanToken(value) {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
    : ''
}

function wbCleanRequestId(value) {
  return typeof value === 'string'
    ? value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
    : ''
}

function wbRequiredRequestId(value) {
  const requestId = wbCleanRequestId(value)
  if (requestId.length < 16) {
    throw new Error('A secure join request ID is required.')
  }
  return requestId
}

function wbCleanText(value, maximum) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, maximum)
    : ''
}

function wbNormalizeLnAddress(value) {
  const lnAddress = wbCleanText(value, 180).toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lnAddress)) {
    throw new Error('A valid Lightning address is required.')
  }
  return lnAddress
}

function wbMaskLnAddress(value) {
  const [name, domain] = String(value || '').split('@')
  if (!name || !domain) return ''
  const visible = name.slice(0, Math.min(2, name.length))
  return `${visible}${name.length > 2 ? '…' : ''}@${domain}`
}

function wbEventPaymentHash(event) {
  return wbCleanText(
    event.paymentHash ||
      event.payment_hash ||
      event.extra?.paymentHash ||
      event.payment?.payment_hash ||
      event.payment?.paymentHash,
    128
  )
}

function wbPaidAmountSats(event) {
  const amountMsat = Math.abs(
    Number(event.amount ?? event.payment?.amount ?? 0)
  )
  if (
    !Number.isSafeInteger(amountMsat) ||
    amountMsat <= 0 ||
    amountMsat % 1000 !== 0
  ) {
    throw new Error('The paid Worm Bits amount is invalid.')
  }
  return amountMsat / 1000
}

function wbRequiredText(value, field, maximum) {
  const text = wbCleanText(value, maximum)
  if (!text) throw new Error(`${field} is required.`)
  return text
}

function wbError(error) {
  return error instanceof Error ? error.message : String(error)
}
