import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FIXED_STEP,
  ReplayDriver,
  WATER_LEVEL,
  WormBitsSimulation,
  terrainDigest
} from '../../static/simulation.js'

test('terrain generation is deterministic and seed-sensitive', () => {
  assert.equal(terrainDigest('same-seed'), terrainDigest('same-seed'))
  assert.notEqual(terrainDigest('same-seed'), terrainDigest('different-seed'))
})

test('a match starts with two healthy teams and grounded characters', () => {
  const simulation = new WormBitsSimulation({seed: 'starting-state'})

  assert.equal(simulation.phase, 'turn')
  assert.equal(simulation.activeTeam, 0)
  assert.equal(simulation.teamSummary(0).health, 300)
  assert.equal(simulation.teamSummary(1).health, 300)
  assert.equal(simulation.teamSummary(0).alive, 3)
  assert.equal(simulation.teamSummary(1).alive, 3)
  assert.ok(simulation.units.every(unit => unit.grounded))
})

test('skip alternates teams and rotates through living characters', () => {
  const simulation = new WormBitsSimulation({seed: 'turn-order'})

  assert.equal(simulation.activeUnitId, 'team-0-bit-0')
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeUnitId, 'team-1-bit-0')
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeUnitId, 'team-0-bit-1')
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeUnitId, 'team-1-bit-1')
  assert.equal(simulation.turnNumber, 4)
})

test('a charged launcher shot deforms terrain and advances the turn', () => {
  const simulation = new WormBitsSimulation({seed: 'launcher-test'})
  const terrainBefore = simulation.terrain.digest()

  assert.equal(simulation.dispatch({type: 'chargeStart'}), true)
  updateTicks(simulation, 42)
  assert.equal(simulation.dispatch({type: 'fire'}), true)
  updateUntil(simulation, candidate => candidate.phase === 'turn', 900)

  assert.notEqual(simulation.terrain.digest(), terrainBefore)
  assert.ok(simulation.terrain.craters.length >= 1)
  assert.equal(simulation.turnNumber, 2)
  assert.equal(simulation.activeTeam, 1)
})

test('a pulse grenade bounces, respects its fuse, and explodes once', () => {
  const simulation = new WormBitsSimulation({seed: 'grenade-test'})
  simulation.consumeEvents()
  const terrainBefore = simulation.terrain.digest()

  assert.equal(simulation.dispatch({type: 'select', weapon: 'grenade'}), true)
  assert.equal(simulation.dispatch({type: 'chargeStart'}), true)
  updateTicks(simulation, 20)
  assert.equal(simulation.dispatch({type: 'fire'}), true)

  const events = []
  for (let tick = 0; tick < 900 && simulation.turnNumber === 1; tick += 1) {
    simulation.update(FIXED_STEP)
    events.push(...simulation.consumeEvents())
  }

  assert.ok(events.some(event => event.type === 'bounce'))
  assert.equal(events.filter(event => event.type === 'explosion').length, 1)
  assert.ok(events.filter(event => event.type === 'bounce').length < 20)
  assert.notEqual(simulation.terrain.digest(), terrainBefore)
  assert.equal(simulation.turnNumber, 2)
})

test('water eliminates a character and ends a one-character match', () => {
  const simulation = new WormBitsSimulation({
    seed: 'water-test',
    charactersPerTeam: 1
  })
  const cyan = simulation.units.find(unit => unit.team === 1)
  cyan.y = WATER_LEVEL + 50

  simulation.update(FIXED_STEP)

  assert.equal(cyan.alive, false)
  assert.equal(simulation.phase, 'finished')
  assert.equal(simulation.winner, 0)
  assert.ok(
    simulation
      .consumeEvents()
      .some(event => event.type === 'winner' && event.team === 0)
  )
})

test('recorded commands replay to the same deterministic state', () => {
  const live = new WormBitsSimulation({
    seed: 'replay-test',
    turnDuration: 8
  })

  live.dispatch({type: 'move', direction: 1})
  updateTicks(live, 24)
  live.dispatch({type: 'move', direction: 0})
  live.dispatch({type: 'aim', direction: -1})
  updateTicks(live, 18)
  live.dispatch({type: 'aim', direction: 0})
  live.dispatch({type: 'chargeStart'})
  updateTicks(live, 35)
  live.dispatch({type: 'fire'})
  updateTicks(live, 260)

  const replay = live.getReplay()
  const driver = new ReplayDriver(replay)
  while (driver.simulation.tick < live.tick) driver.update(FIXED_STEP)

  assert.deepEqual(driver.simulation.getReplay().commands, [])
  assert.equal(driver.simulation.stateDigest(), live.stateDigest())
})

test('three and four player matches rotate across every living team', () => {
  const simulation = new WormBitsSimulation({
    seed: 'four-teams',
    teamCount: 4,
    teamNames: ['One', 'Two', 'Three', 'Four']
  })

  assert.equal(simulation.units.length, 12)
  assert.equal(simulation.teamCount, 4)
  assert.deepEqual(simulation.teamNames, ['One', 'Two', 'Three', 'Four'])
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeTeam, 1)
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeTeam, 2)
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeTeam, 3)
  assert.equal(simulation.dispatch({type: 'skip'}), true)
  assert.equal(simulation.activeTeam, 0)
})

test('durable snapshots restore exact state and forfeits remove one team', () => {
  const live = new WormBitsSimulation({
    seed: 'snapshot-test',
    teamCount: 3
  })
  live.dispatch({type: 'move', direction: 1})
  updateTicks(live, 40)
  live.dispatch({type: 'move', direction: 0})
  live.dispatch({type: 'chargeStart'})
  updateTicks(live, 15)

  const restored = WormBitsSimulation.fromSnapshot(live.exportSnapshot())
  assert.equal(restored.stateDigest(), live.stateDigest())
  assert.equal(restored.forfeitTeam(1), true)
  assert.equal(restored.teamSummary(1).alive, 0)
  assert.equal(restored.phase, 'turn')
})

function updateTicks(simulation, count) {
  for (let tick = 0; tick < count; tick += 1) {
    simulation.update(FIXED_STEP)
  }
}

function updateUntil(simulation, predicate, maximumTicks) {
  for (let tick = 0; tick < maximumTicks; tick += 1) {
    simulation.update(FIXED_STEP)
    if (predicate(simulation)) return
  }
  assert.fail(`Condition was not reached after ${maximumTicks} ticks.`)
}
