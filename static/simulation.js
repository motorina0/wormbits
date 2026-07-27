export const FIXED_STEP = 1 / 60
export const WORLD_WIDTH = 1600
export const WORLD_HEIGHT = 820
export const WATER_LEVEL = 742
export const TURN_DURATION = 30

export const TEAM_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 0,
    name: 'Magenta',
    color: '#ff1fe1',
    accent: '#ffd5f8'
  }),
  Object.freeze({
    id: 1,
    name: 'Cyan',
    color: '#35e7ff',
    accent: '#d7fbff'
  })
])

export const WEAPONS = Object.freeze({
  launcher: Object.freeze({
    id: 'launcher',
    name: 'Bolt launcher',
    speedMin: 330,
    speedMax: 610,
    blastRadius: 58,
    maxDamage: 56,
    fuse: null
  }),
  grenade: Object.freeze({
    id: 'grenade',
    name: 'Pulse grenade',
    speedMin: 270,
    speedMax: 500,
    blastRadius: 65,
    maxDamage: 62,
    fuse: 2.5
  })
})

const UNIT_RADIUS = 16
const GRAVITY = 650
const MOVE_SPEED = 94
const JUMP_SPEED = 292
const MIN_POWER = 0.25
const COMMAND_VERSION = 1
const TERRAIN_START = 42
const TERRAIN_END = WORLD_WIDTH - 43
const TERRAIN_BOTTOM = WATER_LEVEL + 24
const SPAWN_X = Object.freeze([
  Object.freeze([190, 445, 705]),
  Object.freeze([1410, 1155, 895])
])

export class WormBitsSimulation {
  constructor(options = {}) {
    this.seed = normalizeSeed(options.seed)
    this.turnDuration = clampNumber(options.turnDuration, 1, 300, TURN_DURATION)
    this.charactersPerTeam = clampInteger(options.charactersPerTeam, 1, 3, 3)
    this.teamNames = TEAM_DEFINITIONS.map((team, index) =>
      cleanName(options.teamNames?.[index], team.name)
    )
    this.terrain = new Terrain(this.seed)
    this.units = this._createUnits()
    this.tick = 0
    this.phase = 'turn'
    this.turnNumber = 1
    this.activeTeam = 0
    this.teamCursor = [1, 0]
    this.activeUnitId = this.units.find(unit => unit.team === 0)?.id ?? null
    this.turnTime = this.turnDuration
    this.selectedWeapon = 'launcher'
    this.power = MIN_POWER
    this.charging = false
    this.controls = {move: 0, aim: 0}
    this.projectile = null
    this.winner = null
    this.commandLog = []
    this.events = []
    this.resolutionElapsed = 0
    this.resolutionTimer = 0
    this._emit('turn', this.turnSummary())
  }

  dispatch(command, options = {}) {
    if (!command || typeof command.type !== 'string') return false
    const record = options.record !== false
    let accepted = false

    switch (command.type) {
      case 'move':
        accepted = this._setMove(command.direction)
        break
      case 'aim':
        accepted = this._setAim(command.direction)
        break
      case 'jump':
        accepted = this._jump()
        break
      case 'select':
        accepted = this._selectWeapon(command.weapon)
        break
      case 'chargeStart':
        accepted = this._startCharge()
        break
      case 'fire':
        accepted = this._fire()
        break
      case 'skip':
        accepted = this._skipTurn()
        break
      default:
        accepted = false
    }

    if (accepted && record) {
      this.commandLog.push(normalizeReplayCommand(this.tick, command))
    }
    return accepted
  }

  update(step = FIXED_STEP) {
    if (this.phase === 'finished') return
    const dt = clampNumber(step, 0.001, 0.05, FIXED_STEP)

    if (this.phase === 'turn') {
      const active = this.activeUnit()
      if (!active?.alive) {
        this._advanceTurn()
      } else {
        active.aim = clamp(active.aim + this.controls.aim * 54 * dt, -85, 18)
        if (this.charging) {
          this.power = clamp(this.power + 0.56 * dt, MIN_POWER, 1)
        }
        this.turnTime = Math.max(0, this.turnTime - dt)
        if (this.turnTime <= 0) {
          this._emit('notice', {message: 'Turn timed out'})
          this._advanceTurn()
        }
      }
    }

    this._updateUnits(dt)
    this._updateProjectile(dt)
    this._eliminateLostUnits()

    if (this.phase === 'resolving') {
      this.resolutionElapsed += dt
      if (!this.projectile) {
        this.resolutionTimer -= dt
        if (
          (this.resolutionTimer <= 0 && this._unitsSettled()) ||
          this.resolutionElapsed >= 6
        ) {
          if (!this._finishIfWon()) this._advanceTurn()
        }
      }
    } else {
      this._finishIfWon()
    }

    this.tick += 1
  }

  activeUnit() {
    return this.units.find(unit => unit.id === this.activeUnitId) ?? null
  }

  teamSummary(teamId) {
    const units = this.units.filter(unit => unit.team === teamId)
    return {
      id: teamId,
      name: this.teamNames[teamId],
      health: units.reduce(
        (total, unit) => total + (unit.alive ? unit.health : 0),
        0
      ),
      alive: units.filter(unit => unit.alive).length,
      total: units.length
    }
  }

  turnSummary() {
    const unit = this.activeUnit()
    return {
      team: this.activeTeam,
      teamName: this.teamNames[this.activeTeam],
      unitId: unit?.id ?? null,
      unitName: unit?.name ?? '',
      turnNumber: this.turnNumber
    }
  }

  consumeEvents() {
    const events = this.events
    this.events = []
    return events
  }

  getReplay() {
    return {
      version: COMMAND_VERSION,
      seed: this.seed,
      teamNames: [...this.teamNames],
      charactersPerTeam: this.charactersPerTeam,
      turnDuration: this.turnDuration,
      commands: this.commandLog.map(command => ({
        tick: command.tick,
        type: command.type,
        ...(command.direction === undefined
          ? {}
          : {direction: command.direction}),
        ...(command.weapon === undefined ? {} : {weapon: command.weapon})
      }))
    }
  }

  stateDigest() {
    const units = this.units
      .map(unit =>
        [
          unit.id,
          unit.alive ? 1 : 0,
          unit.health,
          rounded(unit.x),
          rounded(unit.y),
          rounded(unit.vx),
          rounded(unit.vy),
          rounded(unit.aim)
        ].join(':')
      )
      .join('|')
    const projectile = this.projectile
      ? [
          this.projectile.weapon,
          rounded(this.projectile.x),
          rounded(this.projectile.y),
          rounded(this.projectile.vx),
          rounded(this.projectile.vy),
          rounded(this.projectile.fuse ?? -1)
        ].join(':')
      : '-'
    return [
      this.tick,
      this.phase,
      this.activeTeam,
      this.activeUnitId,
      this.turnNumber,
      rounded(this.turnTime),
      this.terrain.digest(),
      units,
      projectile,
      this.winner ?? '-'
    ].join('~')
  }

  _createUnits() {
    const units = []
    for (let team = 0; team < 2; team += 1) {
      for (let index = 0; index < this.charactersPerTeam; index += 1) {
        const x = SPAWN_X[team][index]
        let y = this.terrain.surfaceAt(x) - UNIT_RADIUS - 2
        while (
          y > 0 &&
          circleIntersectsTerrain(this.terrain, x, y, UNIT_RADIUS)
        ) {
          y -= 1
        }
        units.push({
          id: `team-${team}-bit-${index}`,
          name: `Bit ${index + 1}`,
          team,
          index,
          x,
          y,
          vx: 0,
          vy: 0,
          radius: UNIT_RADIUS,
          health: 100,
          alive: true,
          facing: team === 0 ? 1 : -1,
          aim: -38,
          grounded: true,
          fallDamageCooldown: 0
        })
      }
    }
    return units
  }

  _setMove(direction) {
    if (this.phase !== 'turn') return false
    this.controls.move = clampInteger(direction, -1, 1, 0)
    const active = this.activeUnit()
    if (active && this.controls.move !== 0) {
      active.facing = this.controls.move
    }
    return true
  }

  _setAim(direction) {
    if (this.phase !== 'turn') return false
    this.controls.aim = clampInteger(direction, -1, 1, 0)
    return true
  }

  _jump() {
    const active = this.activeUnit()
    if (
      this.phase !== 'turn' ||
      !active?.alive ||
      !isUnitGrounded(this.terrain, active)
    ) {
      return false
    }
    active.vy = -JUMP_SPEED
    active.vx += active.facing * 43
    active.grounded = false
    this._emit('jump', {unitId: active.id, x: active.x, y: active.y})
    return true
  }

  _selectWeapon(weapon) {
    if (this.phase !== 'turn' || !WEAPONS[weapon]) return false
    this.selectedWeapon = weapon
    this.power = MIN_POWER
    this.charging = false
    this._emit('weapon', {weapon})
    return true
  }

  _startCharge() {
    if (this.phase !== 'turn' || this.charging) return false
    this.charging = true
    this.power = MIN_POWER
    return true
  }

  _fire() {
    const active = this.activeUnit()
    if (this.phase !== 'turn' || !active?.alive) return false
    const weapon = WEAPONS[this.selectedWeapon]
    const angle = (active.aim * Math.PI) / 180
    const speed =
      weapon.speedMin + (weapon.speedMax - weapon.speedMin) * this.power
    const directionX = Math.cos(angle) * active.facing
    const directionY = Math.sin(angle)
    const muzzleDistance = active.radius + 11

    this.projectile = {
      weapon: weapon.id,
      ownerId: active.id,
      ownerTeam: active.team,
      x: active.x + directionX * muzzleDistance,
      y: active.y + directionY * muzzleDistance,
      vx: directionX * speed,
      vy: directionY * speed,
      radius: weapon.id === 'grenade' ? 7 : 5,
      age: 0,
      fuse: weapon.fuse,
      bounces: 0,
      bounceCooldown: 0,
      resting: false
    }
    this.phase = 'resolving'
    this.resolutionElapsed = 0
    this.resolutionTimer = 0.9
    this.charging = false
    this.controls.move = 0
    this.controls.aim = 0
    this._emit('fire', {
      unitId: active.id,
      weapon: weapon.id,
      power: this.power,
      x: this.projectile.x,
      y: this.projectile.y
    })
    return true
  }

  _skipTurn() {
    if (this.phase !== 'turn') return false
    this._emit('notice', {
      message: `${this.activeUnit()?.name ?? 'Bit'} routed around`
    })
    this._advanceTurn()
    return true
  }

  _updateUnits(dt) {
    for (const unit of this.units) {
      if (!unit.alive) continue
      unit.fallDamageCooldown = Math.max(0, unit.fallDamageCooldown - dt)
      const controllable =
        this.phase === 'turn' && unit.id === this.activeUnitId
      const grounded = isUnitGrounded(this.terrain, unit)

      if (controllable && this.controls.move !== 0 && grounded) {
        unit.vx = this.controls.move * MOVE_SPEED
        unit.facing = this.controls.move
      } else if (grounded) {
        unit.vx *= controllable ? 0.58 : 0.74
        if (Math.abs(unit.vx) < 0.5) unit.vx = 0
      } else {
        unit.vx *= 0.998
      }

      if (!grounded || unit.vy < 0) {
        unit.vy += GRAVITY * dt
      } else if (unit.vy > 0) {
        unit.vy = 0
      }

      this._integrateUnit(unit, dt, controllable)
      unit.grounded = isUnitGrounded(this.terrain, unit)
    }
  }

  _integrateUnit(unit, dt, canStep) {
    const dx = unit.vx * dt
    if (dx !== 0) {
      const horizontalSteps = Math.max(1, Math.ceil(Math.abs(dx) / 3))
      const stepX = dx / horizontalSteps
      for (let step = 0; step < horizontalSteps; step += 1) {
        const nextX = unit.x + stepX
        if (
          !circleIntersectsTerrain(this.terrain, nextX, unit.y, unit.radius)
        ) {
          unit.x = nextX
          continue
        }

        let stepped = false
        if (canStep && isUnitGrounded(this.terrain, unit)) {
          for (let rise = 1; rise <= 9; rise += 1) {
            if (
              !circleIntersectsTerrain(
                this.terrain,
                nextX,
                unit.y - rise,
                unit.radius
              )
            ) {
              unit.x = nextX
              unit.y -= rise
              stepped = true
              break
            }
          }
        }
        if (!stepped) {
          unit.vx = 0
          break
        }
      }
    }

    const dy = unit.vy * dt
    if (dy === 0) return
    const impactSpeed = unit.vy
    const verticalSteps = Math.max(1, Math.ceil(Math.abs(dy) / 3))
    const stepY = dy / verticalSteps

    for (let step = 0; step < verticalSteps; step += 1) {
      const nextY = unit.y + stepY
      if (!circleIntersectsTerrain(this.terrain, unit.x, nextY, unit.radius)) {
        unit.y = nextY
        continue
      }

      if (stepY > 0 && impactSpeed > 345 && unit.fallDamageCooldown <= 0) {
        const damage = Math.min(45, Math.floor((impactSpeed - 320) * 0.11))
        if (damage > 0) {
          this._damageUnit(unit, damage, 'fall')
          unit.fallDamageCooldown = 0.4
        }
      }
      unit.vy = 0
      break
    }
  }

  _updateProjectile(dt) {
    const projectile = this.projectile
    if (!projectile) return
    projectile.age += dt
    if (projectile.fuse !== null) projectile.fuse -= dt
    projectile.bounceCooldown = Math.max(0, projectile.bounceCooldown - dt)
    if (projectile.resting) {
      if (projectile.fuse !== null && projectile.fuse <= 0) {
        this._explode(projectile.x, projectile.y, projectile.weapon)
      }
      return
    }
    projectile.vy += GRAVITY * dt

    const travel = Math.hypot(projectile.vx, projectile.vy) * dt
    const steps = Math.max(1, Math.ceil(travel / 4))
    const substep = dt / steps

    for (let step = 0; step < steps; step += 1) {
      const oldX = projectile.x
      const oldY = projectile.y
      const nextX = oldX + projectile.vx * substep
      const nextY = oldY + projectile.vy * substep

      const hitUnit = this._projectileHitUnit(projectile, nextX, nextY)
      if (hitUnit) {
        this._explode(projectile.x, projectile.y, projectile.weapon)
        return
      }

      if (
        circleIntersectsTerrain(this.terrain, nextX, nextY, projectile.radius)
      ) {
        if (projectile.weapon === 'launcher') {
          this._explode(projectile.x, projectile.y, projectile.weapon)
          return
        }
        this._bounceGrenade(projectile, oldX, oldY, nextX, nextY)
        break
      }

      projectile.x = nextX
      projectile.y = nextY
    }

    if (projectile.fuse !== null && projectile.fuse <= 0) {
      this._explode(projectile.x, projectile.y, projectile.weapon)
      return
    }

    if (
      projectile.y > WATER_LEVEL + 30 ||
      projectile.x < -120 ||
      projectile.x > WORLD_WIDTH + 120 ||
      projectile.y < -280 ||
      projectile.age > 12
    ) {
      this._emit('splash', {x: projectile.x, y: projectile.y})
      this.projectile = null
      this.resolutionTimer = 0.7
    }
  }

  _projectileHitUnit(projectile, x, y) {
    if (projectile.age < 0.13) return null
    return (
      this.units.find(unit => {
        if (!unit.alive) return false
        const distance = Math.hypot(unit.x - x, unit.y - y)
        return distance <= unit.radius + projectile.radius
      }) ?? null
    )
  }

  _bounceGrenade(projectile, oldX, oldY, nextX, nextY) {
    const hitHorizontal = circleIntersectsTerrain(
      this.terrain,
      nextX,
      oldY,
      projectile.radius
    )
    const hitVertical = circleIntersectsTerrain(
      this.terrain,
      oldX,
      nextY,
      projectile.radius
    )
    projectile.x = oldX
    projectile.y = oldY
    if (hitHorizontal) projectile.vx *= -0.52
    else projectile.vx *= 0.78
    if (hitVertical || !hitHorizontal) projectile.vy *= -0.48
    else projectile.vy *= 0.74
    projectile.bounces += 1
    if (Math.abs(projectile.vy) < 25) projectile.vy = -25
    if (
      projectile.bounces >= 4 &&
      Math.hypot(projectile.vx, projectile.vy) < 180
    ) {
      projectile.vx = 0
      projectile.vy = 0
      projectile.resting = true
    }
    if (projectile.bounceCooldown <= 0) {
      projectile.bounceCooldown = 0.075
      this._emit('bounce', {x: oldX, y: oldY})
    }
  }

  _explode(x, y, weaponId) {
    const weapon = WEAPONS[weaponId]
    this.terrain.carveCircle(x, y, weapon.blastRadius)
    this._emit('explosion', {
      x,
      y,
      radius: weapon.blastRadius,
      weapon: weaponId
    })

    for (const unit of this.units) {
      if (!unit.alive) continue
      const dx = unit.x - x
      const dy = unit.y - y
      const distance = Math.hypot(dx, dy)
      const reach = weapon.blastRadius + unit.radius
      if (distance >= reach) continue
      const intensity = clamp(
        1 - Math.max(0, distance - unit.radius) / weapon.blastRadius,
        0,
        1
      )
      const damage = Math.max(1, Math.round(weapon.maxDamage * intensity))
      this._damageUnit(unit, damage, weaponId)

      const safeDistance = Math.max(distance, 1)
      const impulse = 265 * intensity
      unit.vx += (dx / safeDistance) * impulse
      unit.vy += (dy / safeDistance) * impulse - 165 * intensity
      unit.grounded = false
    }

    this.projectile = null
    this.resolutionTimer = 1.15
  }

  _damageUnit(unit, damage, cause) {
    if (!unit.alive || damage <= 0) return
    unit.health = Math.max(0, unit.health - Math.round(damage))
    this._emit('damage', {
      unitId: unit.id,
      team: unit.team,
      amount: Math.round(damage),
      cause,
      health: unit.health
    })
    if (unit.health <= 0) this._eliminateUnit(unit, cause)
  }

  _eliminateLostUnits() {
    for (const unit of this.units) {
      if (!unit.alive) continue
      if (
        unit.y > WATER_LEVEL + 34 ||
        unit.x < -60 ||
        unit.x > WORLD_WIDTH + 60
      ) {
        this._eliminateUnit(unit, 'water')
      }
    }
  }

  _eliminateUnit(unit, cause) {
    if (!unit.alive) return
    unit.alive = false
    unit.health = 0
    unit.vx = 0
    unit.vy = 0
    this._emit('eliminated', {
      unitId: unit.id,
      team: unit.team,
      cause,
      x: unit.x,
      y: unit.y
    })
  }

  _unitsSettled() {
    return this.units
      .filter(unit => unit.alive)
      .every(
        unit =>
          isUnitGrounded(this.terrain, unit) &&
          Math.abs(unit.vx) < 2 &&
          Math.abs(unit.vy) < 2
      )
  }

  _finishIfWon() {
    const livingTeams = [0, 1].filter(team =>
      this.units.some(unit => unit.team === team && unit.alive)
    )
    if (livingTeams.length > 1) return false
    this.phase = 'finished'
    this.winner = livingTeams.length === 1 ? livingTeams[0] : null
    this.projectile = null
    this.controls.move = 0
    this.controls.aim = 0
    this.charging = false
    this._emit('winner', {
      team: this.winner,
      teamName: this.winner === null ? 'No team' : this.teamNames[this.winner]
    })
    return true
  }

  _advanceTurn() {
    if (this._finishIfWon()) return
    const nextTeam = this.activeTeam === 0 ? 1 : 0
    const candidates = this.units.filter(
      unit => unit.team === nextTeam && unit.alive
    )
    if (candidates.length === 0) {
      this._finishIfWon()
      return
    }

    const cursor = this.teamCursor[nextTeam] % candidates.length
    const nextUnit = candidates[cursor]
    this.teamCursor[nextTeam] = (cursor + 1) % candidates.length
    this.activeTeam = nextTeam
    this.activeUnitId = nextUnit.id
    this.turnNumber += 1
    this.turnTime = this.turnDuration
    this.phase = 'turn'
    this.selectedWeapon = 'launcher'
    this.power = MIN_POWER
    this.charging = false
    this.controls.move = 0
    this.controls.aim = 0
    this.projectile = null
    this.resolutionElapsed = 0
    this.resolutionTimer = 0
    this._emit('turn', this.turnSummary())
  }

  _emit(type, detail = {}) {
    this.events.push({type, ...detail})
  }
}

export class ReplayDriver {
  constructor(replay) {
    if (!replay || replay.version !== COMMAND_VERSION) {
      throw new Error('Unsupported Worm Bits replay.')
    }
    this.replay = {
      ...replay,
      commands: [...(replay.commands ?? [])].sort(
        (left, right) => left.tick - right.tick
      )
    }
    this.simulation = new WormBitsSimulation({
      seed: replay.seed,
      teamNames: replay.teamNames,
      charactersPerTeam: replay.charactersPerTeam,
      turnDuration: replay.turnDuration
    })
    this.commandIndex = 0
  }

  update(step = FIXED_STEP) {
    while (
      this.commandIndex < this.replay.commands.length &&
      this.replay.commands[this.commandIndex].tick === this.simulation.tick
    ) {
      this.simulation.dispatch(this.replay.commands[this.commandIndex], {
        record: false
      })
      this.commandIndex += 1
    }
    this.simulation.update(step)
  }

  get complete() {
    return (
      this.simulation.phase === 'finished' ||
      (this.commandIndex >= this.replay.commands.length &&
        this.simulation.tick >
          (this.replay.commands.at(-1)?.tick ?? 0) +
            Math.ceil(this.simulation.turnDuration / FIXED_STEP) * 2)
    )
  }
}

export function terrainDigest(seed) {
  return new Terrain(seed).digest()
}

export function normalizeSeed(value) {
  const seed = String(value ?? '')
    .trim()
    .slice(0, 48)
  return seed || 'wormbits-genesis'
}

class Terrain {
  constructor(seed) {
    this.seed = normalizeSeed(seed)
    this.width = WORLD_WIDTH
    this.height = WORLD_HEIGHT
    this.mask = new Uint8Array(this.width * this.height)
    this.surface = new Int16Array(this.width)
    this.craters = []
    this.revision = 0
    this._digest = null
    this._generate()
  }

  _generate() {
    const random = seededRandom(this.seed)
    const phases = [
      random() * Math.PI * 2,
      random() * Math.PI * 2,
      random() * Math.PI * 2
    ]
    const amplitudes = [
      58 + random() * 24,
      25 + random() * 18,
      12 + random() * 10
    ]
    const frequencies = [
      0.006 + random() * 0.002,
      0.013 + random() * 0.004,
      0.027 + random() * 0.007
    ]
    const raw = new Float64Array(this.width)

    for (let x = 0; x < this.width; x += 1) {
      if (x < TERRAIN_START || x > TERRAIN_END) {
        raw[x] = TERRAIN_BOTTOM + 1
        continue
      }
      const edgeDistance = Math.min(x - TERRAIN_START, TERRAIN_END - x)
      const edgeLift = edgeDistance < 115 ? (115 - edgeDistance) * 1.45 : 0
      raw[x] =
        500 +
        Math.sin(x * frequencies[0] + phases[0]) * amplitudes[0] +
        Math.sin(x * frequencies[1] + phases[1]) * amplitudes[1] +
        Math.sin(x * frequencies[2] + phases[2]) * amplitudes[2] +
        edgeLift
    }

    let previous = TERRAIN_BOTTOM
    for (let x = 0; x < this.width; x += 1) {
      const desired = clamp(Math.round(raw[x]), 310, TERRAIN_BOTTOM + 1)
      const limited = clamp(desired, previous - 2, previous + 2)
      this.surface[x] = limited
      previous = limited
      if (x < TERRAIN_START || x > TERRAIN_END) continue
      for (let y = limited; y <= TERRAIN_BOTTOM; y += 1) {
        this.mask[y * this.width + x] = 1
      }
    }
  }

  isSolid(x, y) {
    const px = Math.round(x)
    const py = Math.round(y)
    if (px < 0 || px >= this.width || py < 0 || py >= this.height) {
      return false
    }
    return this.mask[py * this.width + px] === 1
  }

  surfaceAt(x) {
    const px = clampInteger(x, 0, this.width - 1, 0)
    return this.surface[px]
  }

  carveCircle(centerX, centerY, radius) {
    const minX = clampInteger(
      Math.floor(centerX - radius),
      0,
      this.width - 1,
      0
    )
    const maxX = clampInteger(
      Math.ceil(centerX + radius),
      0,
      this.width - 1,
      this.width - 1
    )
    const minY = clampInteger(
      Math.floor(centerY - radius),
      0,
      this.height - 1,
      0
    )
    const maxY = clampInteger(
      Math.ceil(centerY + radius),
      0,
      this.height - 1,
      this.height - 1
    )
    const radiusSquared = radius * radius

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const dx = x - centerX
        const dy = y - centerY
        if (dx * dx + dy * dy <= radiusSquared) {
          this.mask[y * this.width + x] = 0
        }
      }
    }
    this.craters.push({x: centerX, y: centerY, radius})
    this.revision += 1
    this._digest = null
  }

  digest() {
    if (this._digest !== null) return this._digest
    let hash = 2166136261
    for (let index = 0; index < this.mask.length; index += 17) {
      hash ^= this.mask[index]
      hash = Math.imul(hash, 16777619)
    }
    hash ^= this.craters.length
    this._digest = (hash >>> 0).toString(16).padStart(8, '0')
    return this._digest
  }
}

function circleIntersectsTerrain(terrain, centerX, centerY, radius) {
  if (terrain.isSolid(centerX, centerY + radius)) return true
  if (terrain.isSolid(centerX - radius * 0.55, centerY + radius * 0.84)) {
    return true
  }
  if (terrain.isSolid(centerX + radius * 0.55, centerY + radius * 0.84)) {
    return true
  }
  for (let index = 0; index < 20; index += 1) {
    const angle = (index / 20) * Math.PI * 2
    const x = centerX + Math.cos(angle) * radius
    const y = centerY + Math.sin(angle) * radius
    if (terrain.isSolid(x, y)) return true
  }
  return false
}

function isUnitGrounded(terrain, unit) {
  return (
    terrain.isSolid(unit.x, unit.y + unit.radius + 2) ||
    terrain.isSolid(unit.x - unit.radius * 0.5, unit.y + unit.radius + 1) ||
    terrain.isSolid(unit.x + unit.radius * 0.5, unit.y + unit.radius + 1)
  )
}

function seededRandom(seed) {
  let value = hashString(seed)
  return () => {
    value += 0x6d2b79f5
    let result = value
    result = Math.imul(result ^ (result >>> 15), result | 1)
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61)
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(value) {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function normalizeReplayCommand(tick, command) {
  return {
    tick,
    type: command.type,
    ...(command.direction === undefined
      ? {}
      : {direction: clampInteger(command.direction, -1, 1, 0)}),
    ...(command.weapon === undefined
      ? {}
      : {weapon: WEAPONS[command.weapon] ? command.weapon : 'launcher'})
  }
}

function cleanName(value, fallback) {
  const name = String(value ?? '')
    .trim()
    .slice(0, 24)
  return name || fallback
}

function clampInteger(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.round(clamp(number, minimum, maximum))
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return clamp(number, minimum, maximum)
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

function rounded(value) {
  return Math.round(Number(value) * 1000) / 1000
}
