'use strict'

const FIXED_STEP = 1 / 60
const WORLD_WIDTH = 1600
const WORLD_HEIGHT = 820
const WATER_LEVEL = 742
const TURN_DURATION = 30

const TEAM_DEFINITIONS = Object.freeze([
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
  }),
  Object.freeze({
    id: 2,
    name: 'Lime',
    color: '#8dff70',
    accent: '#e5ffdd'
  }),
  Object.freeze({
    id: 3,
    name: 'Gold',
    color: '#ffe45c',
    accent: '#fff6bd'
  })
])

const WEAPONS = Object.freeze({
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
  Object.freeze([160, 640, 1120]),
  Object.freeze([1440, 960, 480]),
  Object.freeze([320, 800, 1280]),
  Object.freeze([560, 1040, 1360])
])
const SNAPSHOT_VERSION = 1

class WormBitsSimulation {
  constructor(options = {}) {
    this.seed = normalizeSeed(options.seed)
    this.turnDuration = clampNumber(options.turnDuration, 1, 300, TURN_DURATION)
    this.charactersPerTeam = clampInteger(options.charactersPerTeam, 1, 3, 3)
    this.teamCount = clampInteger(options.teamCount, 2, 4, 2)
    this.teamNames = TEAM_DEFINITIONS.slice(0, this.teamCount).map(
      (team, index) => cleanName(options.teamNames?.[index], team.name)
    )
    this.terrain = new Terrain(this.seed)
    this.units = this._createUnits()
    this.tick = 0
    this.phase = 'turn'
    this.turnNumber = 1
    this.activeTeam = 0
    this.teamCursor = Array(this.teamCount).fill(0)
    this.teamCursor[0] = 1
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
      teamCount: this.teamCount,
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

  exportSnapshot() {
    return {
      version: SNAPSHOT_VERSION,
      seed: this.seed,
      teamNames: [...this.teamNames],
      teamCount: this.teamCount,
      charactersPerTeam: this.charactersPerTeam,
      turnDuration: this.turnDuration,
      tick: this.tick,
      phase: this.phase,
      turnNumber: this.turnNumber,
      activeTeam: this.activeTeam,
      teamCursor: [...this.teamCursor],
      activeUnitId: this.activeUnitId,
      turnTime: this.turnTime,
      selectedWeapon: this.selectedWeapon,
      power: this.power,
      charging: this.charging,
      controls: {...this.controls},
      projectile: this.projectile ? {...this.projectile} : null,
      winner: this.winner,
      resolutionElapsed: this.resolutionElapsed,
      resolutionTimer: this.resolutionTimer,
      terrain: {
        craters: this.terrain.craters.map(crater => ({...crater}))
      },
      units: this.units.map(unit => ({...unit}))
    }
  }

  static fromSnapshot(snapshot) {
    if (
      !snapshot ||
      snapshot.version !== SNAPSHOT_VERSION ||
      !Array.isArray(snapshot.units) ||
      !Array.isArray(snapshot.terrain?.craters)
    ) {
      throw new Error('Unsupported Worm Bits snapshot.')
    }
    const simulation = new WormBitsSimulation({
      seed: snapshot.seed,
      teamNames: snapshot.teamNames,
      teamCount: snapshot.teamCount,
      charactersPerTeam: snapshot.charactersPerTeam,
      turnDuration: snapshot.turnDuration
    })
    simulation.terrain = new Terrain(simulation.seed)
    for (const crater of snapshot.terrain.craters) {
      simulation.terrain.carveCircle(
        clampNumber(crater.x, -WORLD_WIDTH, WORLD_WIDTH * 2, 0),
        clampNumber(crater.y, -WORLD_HEIGHT, WORLD_HEIGHT * 2, 0),
        clampNumber(crater.radius, 1, 200, 1)
      )
    }
    simulation.units = snapshot.units.map(unit => ({
      ...unit,
      team: clampInteger(unit.team, 0, simulation.teamCount - 1, 0),
      radius: clampNumber(unit.radius, 1, 40, UNIT_RADIUS),
      health: clampInteger(unit.health, 0, 100, 0),
      alive: unit.alive === true
    }))
    simulation.tick = clampInteger(
      snapshot.tick,
      0,
      Number.MAX_SAFE_INTEGER,
      0
    )
    simulation.phase = ['turn', 'resolving', 'finished'].includes(
      snapshot.phase
    )
      ? snapshot.phase
      : 'turn'
    simulation.turnNumber = clampInteger(
      snapshot.turnNumber,
      1,
      Number.MAX_SAFE_INTEGER,
      1
    )
    simulation.activeTeam = clampInteger(
      snapshot.activeTeam,
      0,
      simulation.teamCount - 1,
      0
    )
    simulation.teamCursor = Array.from(
      {length: simulation.teamCount},
      (_, team) =>
        clampInteger(
          snapshot.teamCursor?.[team],
          0,
          simulation.charactersPerTeam,
          0
        )
    )
    simulation.activeUnitId =
      typeof snapshot.activeUnitId === 'string'
        ? snapshot.activeUnitId
        : null
    simulation.turnTime = clampNumber(
      snapshot.turnTime,
      0,
      simulation.turnDuration,
      simulation.turnDuration
    )
    simulation.selectedWeapon = WEAPONS[snapshot.selectedWeapon]
      ? snapshot.selectedWeapon
      : 'launcher'
    simulation.power = clampNumber(snapshot.power, MIN_POWER, 1, MIN_POWER)
    simulation.charging = snapshot.charging === true
    simulation.controls = {
      move: clampInteger(snapshot.controls?.move, -1, 1, 0),
      aim: clampInteger(snapshot.controls?.aim, -1, 1, 0)
    }
    simulation.projectile = snapshot.projectile
      ? {...snapshot.projectile}
      : null
    simulation.winner =
      snapshot.winner === null
        ? null
        : clampInteger(
            snapshot.winner,
            0,
            simulation.teamCount - 1,
            null
          )
    simulation.resolutionElapsed = clampNumber(
      snapshot.resolutionElapsed,
      0,
      30,
      0
    )
    simulation.resolutionTimer = clampNumber(
      snapshot.resolutionTimer,
      -30,
      30,
      0
    )
    simulation.commandLog = []
    simulation.events = []
    return simulation
  }

  forfeitTeam(teamId) {
    const team = clampInteger(teamId, 0, this.teamCount - 1, -1)
    if (team < 0 || this.phase === 'finished') return false
    let changed = false
    for (const unit of this.units) {
      if (unit.team !== team || !unit.alive) continue
      this._eliminateUnit(unit, 'forfeit')
      changed = true
    }
    if (!changed) return false
    if (!this._finishIfWon() && this.activeTeam === team) this._advanceTurn()
    return true
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
    for (let team = 0; team < this.teamCount; team += 1) {
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
          facing: x < WORLD_WIDTH / 2 ? 1 : -1,
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
    const livingTeams = Array.from(
      {length: this.teamCount},
      (_, team) => team
    ).filter(team =>
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
    let nextTeam = null
    for (let offset = 1; offset <= this.teamCount; offset += 1) {
      const candidate = (this.activeTeam + offset) % this.teamCount
      if (this.units.some(unit => unit.team === candidate && unit.alive)) {
        nextTeam = candidate
        break
      }
    }
    if (nextTeam === null) {
      this._finishIfWon()
      return
    }
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

class ReplayDriver {
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
      teamCount: replay.teamCount,
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

function terrainDigest(seed) {
  return new Terrain(seed).digest()
}

function normalizeSeed(value) {
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

const canvas = requiredElement('game-canvas')
const context = canvas.getContext('2d', {alpha: false})
const canvasWrap = requiredElement('canvas-wrap')
const setupOverlay = requiredElement('setup-overlay')
const lobbyOverlay = requiredElement('lobby-overlay')
const handoffOverlay = requiredElement('handoff-overlay')
const resultOverlay = requiredElement('result-overlay')
const seedInput = requiredElement('seed-input')
const startButton = requiredElement('start-button')
const playerNameInput = requiredElement('player-name-input')
const roomNameInput = requiredElement('room-name-input')
const maxPlayersInput = requiredElement('max-players-input')
const entryFeeInput = requiredElement('entry-fee-input')
const walletInput = requiredElement('wallet-input')
const createPayoutField = requiredElement('create-payout-field')
const createPayoutInput = requiredElement('create-payout-input')
const paymentSetupNote = requiredElement('payment-setup-note')
const createRoomButton = requiredElement('create-room-button')
const roomCodeInput = requiredElement('room-code-input')
const openRoomButton = requiredElement('open-room-button')
const onlineSetup = requiredElement('online-setup')
const onlineUnavailable = requiredElement('online-unavailable')
const lobbyConnection = requiredElement('lobby-connection')
const lobbyTitle = requiredElement('lobby-title')
const lobbySummary = requiredElement('lobby-summary')
const lobbyRoomCode = requiredElement('lobby-room-code')
const lobbyPaymentSummary = requiredElement('lobby-payment-summary')
const lobbyParticipants = requiredElement('lobby-participants')
const lobbyJoinControls = requiredElement('lobby-join-controls')
const lobbyPlayerControls = requiredElement('lobby-player-controls')
const lobbyNameInput = requiredElement('lobby-name-input')
const lobbyPayoutField = requiredElement('lobby-payout-field')
const lobbyPayoutInput = requiredElement('lobby-payout-input')
const joinRoomButton = requiredElement('join-room-button')
const spectateRoomButton = requiredElement('spectate-room-button')
const lobbyPaymentState = requiredElement('lobby-payment-state')
const lobbyPaymentButton = requiredElement('lobby-payment-button')
const lobbyReadyButton = requiredElement('lobby-ready-button')
const lobbyStartButton = requiredElement('lobby-start-button')
const copyInviteButton = requiredElement('copy-invite-button')
const leaveRoomButton = requiredElement('leave-room-button')
const restartButton = requiredElement('restart-button')
const handoffButton = requiredElement('handoff-button')
const replayButton = requiredElement('replay-button')
const rematchButton = requiredElement('rematch-button')
const settleButton = requiredElement('settle-button')
const resultSettlementStatus = requiredElement('result-settlement-status')
const paymentOverlay = requiredElement('payment-overlay')
const paymentStatus = requiredElement('payment-status')
const paymentAmount = requiredElement('payment-amount')
const paymentRequest = requiredElement('payment-request')
const paymentCopyButton = requiredElement('payment-copy-button')
const paymentOpenButton = requiredElement('payment-open-button')
const paymentCloseButton = requiredElement('payment-close-button')
const skipButton = requiredElement('skip-button')
const soundToggle = requiredElement('sound-toggle')
const announcement = requiredElement('announcement')
const turnLabel = requiredElement('turn-label')
const activeUnitLabel = requiredElement('active-unit-label')
const turnTimer = requiredElement('turn-timer')
const turnMeterFill = requiredElement('turn-meter-fill')
const powerValue = requiredElement('power-value')
const powerMeterFill = requiredElement('power-meter-fill')
const seedLabel = requiredElement('seed-label')
const modeLabel = requiredElement('mode-label')
const handoffTitle = requiredElement('handoff-title')
const handoffCopy = requiredElement('handoff-copy')
const resultTitle = requiredElement('result-title')
const resultSummary = requiredElement('result-summary')
const weaponButtons = [...document.querySelectorAll('[data-weapon]')]
const holdButtons = [...document.querySelectorAll('[data-hold]')]
const actionButtons = [...document.querySelectorAll('[data-action]')]

const TEAM_ELEMENTS = TEAM_DEFINITIONS.map(team => ({
  card: requiredElement(`team-card-${team.id}`),
  name: requiredElement(`team-name-${team.id}`),
  health: requiredElement(`team-health-${team.id}`),
  alive: requiredElement(`team-alive-${team.id}`)
}))

for (const team of TEAM_DEFINITIONS) {
  TEAM_ELEMENTS[team.id].card.style.setProperty('--team-color', team.color)
}

const terrainCanvas = document.createElement('canvas')
terrainCanvas.width = WORLD_WIDTH
terrainCanvas.height = WORLD_HEIGHT
const terrainContext = terrainCanvas.getContext('2d')

let audio
const pressedKeys = new Set()
const effects = []
const camera = {x: WORLD_WIDTH / 2, shake: 0}

let simulation = new WormBitsSimulation({seed: seedInput.value})
let replayDriver = null
let lastReplay = null
let mode = 'preview'
let paused = true
let terrainRevision = -1
let renderedTerrain = null
let accumulator = 0
let previousFrame = performance.now()
let announcementTimer = null
const multiplayerClient = window.createWormbitsClient?.() ?? null
const online = {
  available: false,
  context: null,
  room: null,
  participants: [],
  viewer: null,
  wallets: [],
  invoice: null,
  settlements: [],
  token: '',
  revision: 0,
  websocket: null,
  pollTimer: null,
  heartbeatTimer: null,
  refreshTimer: null,
  requestQueue: Promise.resolve(),
  clientSeq: 0,
  applying: false,
  settling: false,
  createRequestId: '',
  joinRequestId: ''
}

startButton.addEventListener('click', () => {
  audio.unlock()
  startMatch(seedInput.value)
})

createRoomButton.addEventListener('click', () => {
  runOnlineUiAction(createOnlineRoom)
})

entryFeeInput.addEventListener('input', updatePaymentSetup)

openRoomButton.addEventListener('click', () => {
  runOnlineUiAction(() => enterOnlineRoom(roomCodeInput.value))
})

joinRoomButton.addEventListener('click', () => {
  runOnlineUiAction(joinOnlineRoom)
})

spectateRoomButton.addEventListener('click', () => {
  runOnlineUiAction(spectateOnlineRoom)
})

lobbyReadyButton.addEventListener('click', () => {
  runOnlineUiAction(toggleOnlineReady)
})

lobbyPaymentButton.addEventListener('click', () => {
  if (online.viewer?.paymentStatus === 'pending' && online.invoice) {
    showPaymentInvoice(online.invoice)
    return
  }
  runOnlineUiAction(settleOnlineRoom)
})

lobbyStartButton.addEventListener('click', () => {
  runOnlineUiAction(startOnlineMatch)
})

copyInviteButton.addEventListener('click', () => {
  runOnlineUiAction(copyOnlineInvite)
})

leaveRoomButton.addEventListener('click', () => {
  runOnlineUiAction(leaveOrForfeitOnlineRoom)
})

restartButton.addEventListener('click', async () => {
  if (mode === 'online' && online.viewer?.role === 'player') {
    await runOnlineUiAction(forfeitOnlineMatch)
    return
  }
  if (online.room) leaveOnlineRoom()
  else openSetup()
})

handoffButton.addEventListener('click', () => {
  audio.unlock()
  handoffOverlay.hidden = true
  paused = false
  announce(`${simulation.teamNames[simulation.activeTeam]} begins`)
})

replayButton.addEventListener('click', () => {
  if (!lastReplay) return
  startReplay(lastReplay)
})

settleButton.addEventListener('click', () => {
  runOnlineUiAction(settleOnlineRoom)
})

rematchButton.addEventListener('click', () => {
  if (mode === 'online') {
    leaveOnlineRoom()
    return
  }
  const newSeed = `wormbits-${Date.now().toString(36)}`
  seedInput.value = newSeed
  startMatch(newSeed)
})

skipButton.addEventListener('click', () => {
  sendCommand({type: 'skip'})
})

soundToggle.addEventListener('click', () => {
  audio.setMuted(!audio.muted)
  updateSoundButton()
})

paymentCopyButton.addEventListener('click', () => {
  runOnlineUiAction(copyPaymentInvoice)
})

paymentOpenButton.addEventListener('click', () => {
  openPaymentWallet()
})

paymentCloseButton.addEventListener('click', () => {
  paymentOverlay.hidden = true
})

for (const button of weaponButtons) {
  button.addEventListener('click', () => {
    sendCommand({type: 'select', weapon: button.dataset.weapon})
  })
}

for (const button of actionButtons) {
  button.addEventListener('click', () => {
    if (button.dataset.action === 'jump') sendCommand({type: 'jump'})
  })
}

for (const button of holdButtons) {
  const stop = event => {
    if (!button.classList.contains('is-held')) return
    event.preventDefault()
    button.classList.remove('is-held')
    releaseHoldAction(button.dataset.hold)
  }
  button.addEventListener('pointerdown', event => {
    if (!canControl()) return
    event.preventDefault()
    button.setPointerCapture?.(event.pointerId)
    button.classList.add('is-held')
    pressHoldAction(button.dataset.hold)
  })
  button.addEventListener('pointerup', stop)
  button.addEventListener('pointercancel', stop)
  button.addEventListener('lostpointercapture', stop)
}

window.addEventListener('keydown', event => {
  const key = normalizeKey(event.key)
  if (isGameKey(key)) event.preventDefault()
  if (!canControl() || pressedKeys.has(key)) return
  pressedKeys.add(key)

  if (key === 'w' || key === 'shift') sendCommand({type: 'jump'})
  if (key === ' ') sendCommand({type: 'chargeStart'})
  if (key === '1') sendCommand({type: 'select', weapon: 'launcher'})
  if (key === '2') sendCommand({type: 'select', weapon: 'grenade'})
  if (key === 'x') sendCommand({type: 'skip'})
  syncDirectionalControls()
})

window.addEventListener('keyup', event => {
  const key = normalizeKey(event.key)
  if (isGameKey(key)) event.preventDefault()
  const wasPressed = pressedKeys.delete(key)
  if (!wasPressed || !canControl()) return
  if (key === ' ') sendCommand({type: 'fire'})
  syncDirectionalControls()
})

window.addEventListener('blur', releaseAllControls)
window.addEventListener('beforeunload', stopOnlineRealtime)
window.addEventListener('resize', resizeCanvas)
new ResizeObserver(resizeCanvas).observe(canvasWrap)

window.wormbitsDebug = Object.freeze({
  getState: () => ({
    seed: simulation.seed,
    tick: simulation.tick,
    phase: simulation.phase,
    mode,
    paused,
    turnNumber: simulation.turnNumber,
    activeTeam: simulation.activeTeam,
    activeUnitId: simulation.activeUnitId,
    terrainDigest: simulation.terrain.digest(),
    commandCount: simulation.commandLog.length,
    teams: Array.from({length: simulation.teamCount}, (_, team) =>
      simulation.teamSummary(team)
    ),
    roomId: online.room?.id ?? null,
    roomStatus: online.room?.status ?? null,
    entryFeeSats: online.room?.entryFeeSats ?? 0,
    settlementStatus: online.room?.settlementStatus ?? '',
    revision: online.revision,
    viewer: online.viewer
      ? {
          role: online.viewer.role,
          slot: online.viewer.slot,
          connected: online.viewer.connected,
          paymentStatus: online.viewer.paymentStatus
        }
      : null
  })
})

resizeCanvas()
rebuildTerrain()
updatePaymentSetup()
updateInterface()
requestAnimationFrame(frame)
initializeMultiplayer().catch(showOnlineError)

function startMatch(seed) {
  releaseAllControls()
  simulation = new WormBitsSimulation({seed: normalizeSeed(seed)})
  simulation.consumeEvents()
  replayDriver = null
  mode = 'live'
  paused = false
  lastReplay = null
  effects.length = 0
  setupOverlay.hidden = true
  lobbyOverlay.hidden = true
  handoffOverlay.hidden = true
  resultOverlay.hidden = true
  camera.x = simulation.activeUnit()?.x ?? WORLD_WIDTH / 2
  camera.shake = 0
  renderedTerrain = null
  terrainRevision = -1
  seedInput.value = simulation.seed
  accumulator = 0
  announce(`${simulation.teamNames[0]} opens the match`)
  updateInterface()
}

function startReplay(replay) {
  releaseAllControls()
  replayDriver = new ReplayDriver(replay)
  simulation = replayDriver.simulation
  simulation.consumeEvents()
  mode = 'replay'
  paused = false
  effects.length = 0
  setupOverlay.hidden = true
  lobbyOverlay.hidden = true
  handoffOverlay.hidden = true
  resultOverlay.hidden = true
  camera.x = simulation.activeUnit()?.x ?? WORLD_WIDTH / 2
  camera.shake = 0
  renderedTerrain = null
  terrainRevision = -1
  accumulator = 0
  announce('Replaying recorded commands')
  updateInterface()
}

function openSetup() {
  releaseAllControls()
  const previewSeed = normalizeSeed(seedInput.value)
  simulation = new WormBitsSimulation({seed: previewSeed})
  simulation.consumeEvents()
  replayDriver = null
  mode = 'preview'
  paused = true
  effects.length = 0
  setupOverlay.hidden = false
  lobbyOverlay.hidden = true
  handoffOverlay.hidden = true
  resultOverlay.hidden = true
  renderedTerrain = null
  terrainRevision = -1
  camera.x = WORLD_WIDTH / 2
  updateInterface()
  seedInput.focus()
  seedInput.select()
}

function frame(now) {
  const elapsed = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000))
  previousFrame = now

  if (!paused && simulation.phase !== 'finished') {
    accumulator += elapsed
    while (accumulator >= FIXED_STEP) {
      if (mode === 'replay') replayDriver.update(FIXED_STEP)
      else simulation.update(FIXED_STEP)
      handleSimulationEvents()
      accumulator -= FIXED_STEP
    }
  }

  updateEffects(elapsed)
  updateCamera(elapsed)
  updateInterface()
  render()
  requestAnimationFrame(frame)
}

function sendCommand(command) {
  if (!canControl()) return false
  const tick = simulation.tick
  const accepted = simulation.dispatch(command)
  if (accepted) {
    handleSimulationEvents()
    updateInterface()
    if (mode === 'online') queueOnlineCommand(command, tick)
  }
  return accepted
}

function canControl() {
  if (
    paused ||
    simulation.phase !== 'turn' ||
    simulation.activeUnit()?.alive !== true
  ) {
    return false
  }
  if (mode === 'live') return true
  if (mode !== 'online') return false
  return (
    online.room?.status === 'active' &&
    online.viewer?.role === 'player' &&
    online.viewer.forfeited !== true &&
    online.viewer.slot === simulation.activeTeam
  )
}

function pressHoldAction(action) {
  if (action === 'move-left' || action === 'move-right') {
    sendCommand({
      type: 'move',
      direction: action === 'move-left' ? -1 : 1
    })
  }
  if (action === 'aim-up' || action === 'aim-down') {
    sendCommand({
      type: 'aim',
      direction: action === 'aim-up' ? -1 : 1
    })
  }
  if (action === 'fire') sendCommand({type: 'chargeStart'})
}

function releaseHoldAction(action) {
  if (action === 'move-left' || action === 'move-right') {
    sendCommand({type: 'move', direction: 0})
  }
  if (action === 'aim-up' || action === 'aim-down') {
    sendCommand({type: 'aim', direction: 0})
  }
  if (action === 'fire') sendCommand({type: 'fire'})
}

function syncDirectionalControls() {
  const left = pressedKeys.has('a') || pressedKeys.has('arrowleft')
  const right = pressedKeys.has('d') || pressedKeys.has('arrowright')
  const up = pressedKeys.has('arrowup')
  const down = pressedKeys.has('arrowdown')
  sendCommand({type: 'move', direction: Number(right) - Number(left)})
  sendCommand({type: 'aim', direction: Number(down) - Number(up)})
}

function releaseAllControls() {
  const shouldFire = pressedKeys.has(' ') && canControl()
  pressedKeys.clear()
  for (const button of holdButtons) button.classList.remove('is-held')
  if (canControl()) {
    sendCommand({type: 'move', direction: 0})
    sendCommand({type: 'aim', direction: 0})
    if (shouldFire) sendCommand({type: 'fire'})
  }
}

function handleSimulationEvents() {
  for (const event of simulation.consumeEvents()) {
    if (event.type === 'turn') {
      audio.play('turn')
      if (mode === 'live' && event.turnNumber > 1) {
        paused = true
        handoffTitle.textContent = `${event.teamName} is up`
        handoffCopy.textContent = `${event.unitName} is ready for turn ${event.turnNumber}.`
        handoffOverlay.hidden = false
      }
    }
    if (event.type === 'weapon') {
      audio.play('select')
    }
    if (event.type === 'jump') {
      audio.play('jump')
    }
    if (event.type === 'fire') {
      audio.play(event.weapon === 'grenade' ? 'grenade' : 'launch')
      announce(
        `${WEAPONS[event.weapon].name} · ${Math.round(event.power * 100)}%`
      )
    }
    if (event.type === 'bounce') {
      audio.play('bounce')
    }
    if (event.type === 'explosion') {
      effects.push({
        type: 'explosion',
        x: event.x,
        y: event.y,
        radius: event.radius,
        age: 0,
        duration: 0.72
      })
      camera.shake = Math.max(camera.shake, 13)
      audio.play('explosion')
    }
    if (event.type === 'damage') {
      const unit = simulation.units.find(
        candidate => candidate.id === event.unitId
      )
      if (unit) {
        effects.push({
          type: 'damage',
          x: unit.x,
          y: unit.y - 30,
          text: `-${event.amount}`,
          color: TEAM_DEFINITIONS[event.team].accent,
          age: 0,
          duration: 1
        })
      }
      audio.play('damage')
    }
    if (event.type === 'eliminated') {
      effects.push({
        type: 'splash',
        x: event.x,
        y: Math.min(event.y, WATER_LEVEL),
        age: 0,
        duration: 0.9
      })
      announce(`${unitName(event.unitId)} was discharged`)
      audio.play('splash')
    }
    if (event.type === 'splash') {
      effects.push({
        type: 'splash',
        x: event.x,
        y: WATER_LEVEL,
        age: 0,
        duration: 0.9
      })
      audio.play('splash')
    }
    if (event.type === 'notice') {
      announce(event.message)
    }
    if (event.type === 'winner') {
      finishMatch(event)
    }
  }
}

function finishMatch(event) {
  releaseAllControls()
  paused = true
  if (mode === 'live') lastReplay = simulation.getReplay()
  const isDraw = event.team === null
  resultTitle.textContent = isDraw
    ? 'The current wins'
    : `${event.teamName} wins`
  resultSummary.textContent = isDraw
    ? 'No bits remain on the island.'
    : `${event.teamName} controls the final channel after ${simulation.turnNumber} turns.`
  replayButton.hidden = mode === 'replay' || !lastReplay
  renderOnlineSettlement()
  resultOverlay.hidden = false
  audio.play('winner')
}

function updateEffects(dt) {
  for (const effect of effects) effect.age += dt
  for (let index = effects.length - 1; index >= 0; index -= 1) {
    if (effects[index].age >= effects[index].duration) effects.splice(index, 1)
  }
  camera.shake *= Math.pow(0.03, dt)
  if (camera.shake < 0.05) camera.shake = 0
}

function updateCamera(dt) {
  const target = simulation.projectile ?? simulation.activeUnit()
  const desired = target?.x ?? WORLD_WIDTH / 2
  const smoothing = 1 - Math.pow(0.001, dt)
  camera.x += (desired - camera.x) * smoothing
}

function updateInterface() {
  for (let team = 0; team < TEAM_DEFINITIONS.length; team += 1) {
    TEAM_ELEMENTS[team].card.hidden = team >= simulation.teamCount
    if (team >= simulation.teamCount) continue
    const summary = simulation.teamSummary(team)
    const elements = TEAM_ELEMENTS[team]
    elements.name.textContent = summary.name
    elements.health.textContent = String(summary.health)
    elements.alive.textContent = `${summary.alive} / ${summary.total} bits`
    elements.card.classList.toggle(
      'is-active',
      simulation.phase !== 'finished' && simulation.activeTeam === team
    )
  }

  const active = simulation.activeUnit()
  if (mode === 'preview') {
    turnLabel.textContent = 'Ready to deploy'
    activeUnitLabel.textContent = 'Local hot-seat'
  } else if (mode === 'replay') {
    turnLabel.textContent = 'Recorded match'
    activeUnitLabel.textContent =
      simulation.phase === 'finished'
        ? 'Replay complete'
        : `${simulation.teamNames[simulation.activeTeam]} · ${active?.name ?? ''}`
  } else if (mode === 'online-lobby') {
    turnLabel.textContent = 'Multiplayer lobby'
    activeUnitLabel.textContent = online.room
      ? `${online.room.playerCount} / ${online.room.maxPlayers} players`
      : 'Connecting'
  } else {
    turnLabel.textContent =
      simulation.phase === 'resolving'
        ? 'Resolving action'
        : `Turn ${simulation.turnNumber}`
    activeUnitLabel.textContent =
      simulation.phase === 'finished'
        ? 'Match complete'
        : `${simulation.teamNames[simulation.activeTeam]} · ${active?.name ?? ''}${
            mode === 'online' &&
            online.viewer?.slot !== simulation.activeTeam
              ? ' · waiting'
              : ''
          }`
  }

  turnTimer.textContent = simulation.turnTime.toFixed(1)
  turnMeterFill.style.transform = `scaleX(${clampUi(
    simulation.turnTime / simulation.turnDuration,
    0,
    1
  )})`
  powerValue.textContent = `${Math.round(simulation.power * 100)}%`
  powerMeterFill.style.width = `${Math.round(simulation.power * 100)}%`
  seedLabel.textContent = `Seed: ${simulation.seed}`
  modeLabel.textContent =
    mode === 'replay'
      ? 'Replaying deterministic command log'
      : mode === 'online' || mode === 'online-lobby'
        ? `Online · ${
            online.websocket?.active ? 'WebSocket connected' : 'polling recovery'
          } · revision ${online.revision}`
        : 'Local · deterministic hot-seat play'
  restartButton.textContent =
    mode === 'online' && online.viewer?.role === 'player'
      ? 'Forfeit'
      : 'New match'

  for (const button of weaponButtons) {
    const selected = button.dataset.weapon === simulation.selectedWeapon
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-pressed', String(selected))
    button.disabled = !canControl()
  }
  skipButton.disabled = !canControl()
  for (const button of holdButtons) button.disabled = !canControl()
  for (const button of actionButtons) button.disabled = !canControl()
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const width = Math.max(320, Math.round(rect.width))
  const height = Math.max(390, Math.round(rect.height))
  const pixelWidth = Math.round(width * ratio)
  const pixelHeight = Math.round(height * ratio)
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth
    canvas.height = pixelHeight
  }
}

function render() {
  const ratio = Math.min(window.devicePixelRatio || 1, 2)
  const viewportWidth = canvas.width / ratio
  const viewportHeight = canvas.height / ratio
  const scale = viewportHeight / WORLD_HEIGHT
  const visibleWorldWidth = viewportWidth / scale
  const cameraCenter =
    visibleWorldWidth >= WORLD_WIDTH
      ? WORLD_WIDTH / 2
      : clampUi(
          camera.x,
          visibleWorldWidth / 2,
          WORLD_WIDTH - visibleWorldWidth / 2
        )
  const shakeX = camera.shake
    ? Math.sin(performance.now() * 0.07) * camera.shake
    : 0
  const shakeY = camera.shake
    ? Math.cos(performance.now() * 0.09) * camera.shake * 0.55
    : 0
  const cameraLeft = cameraCenter - visibleWorldWidth / 2 - shakeX / scale

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  drawSky(viewportWidth, viewportHeight, cameraLeft, scale)
  context.save()
  context.scale(scale, scale)
  context.translate(-cameraLeft, shakeY / scale)
  drawWorld()
  context.restore()
}

function drawSky(width, height, cameraLeft, scale) {
  const gradient = context.createLinearGradient(0, 0, 0, height)
  gradient.addColorStop(0, '#15162d')
  gradient.addColorStop(0.58, '#292247')
  gradient.addColorStop(1, '#ff62cf')
  context.fillStyle = gradient
  context.fillRect(0, 0, width, height)

  context.fillStyle = 'rgba(255,255,255,0.55)'
  for (let index = 0; index < 32; index += 1) {
    const worldX = (index * 277 + 91) % WORLD_WIDTH
    const x = (worldX - cameraLeft * 0.18) * scale
    const y = 34 + ((index * 97) % 245) * scale
    const radius = index % 5 === 0 ? 1.5 : 0.8
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
  }

  const moonX = width - 115 - cameraLeft * scale * 0.025
  const moonY = 100
  const moonGradient = context.createRadialGradient(
    moonX,
    moonY,
    8,
    moonX,
    moonY,
    56
  )
  moonGradient.addColorStop(0, 'rgba(255,255,255,0.9)')
  moonGradient.addColorStop(0.22, 'rgba(255,228,92,0.75)')
  moonGradient.addColorStop(1, 'rgba(255,228,92,0)')
  context.fillStyle = moonGradient
  context.beginPath()
  context.arc(moonX, moonY, 56, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = '#ffe45c'
  context.beginPath()
  context.arc(moonX, moonY, 22, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = 'rgba(19, 16, 36, 0.46)'
  for (let layer = 0; layer < 3; layer += 1) {
    context.beginPath()
    context.moveTo(0, height)
    for (let x = 0; x <= width + 80; x += 80) {
      const y =
        height * (0.68 + layer * 0.07) +
        Math.sin(x * 0.008 + layer * 1.7 + cameraLeft * 0.001) *
          (22 + layer * 6)
      context.lineTo(x, y)
    }
    context.lineTo(width, height)
    context.closePath()
    context.fill()
  }
}

function drawWorld() {
  if (
    renderedTerrain !== simulation.terrain ||
    terrainRevision !== simulation.terrain.revision
  ) {
    rebuildTerrain()
  }

  context.drawImage(terrainCanvas, 0, 0)
  drawDecorations()
  for (const unit of simulation.units) drawUnit(unit)
  if (simulation.projectile) drawProjectile(simulation.projectile)
  for (const effect of effects) drawEffect(effect)
  drawWater()
}

function rebuildTerrain() {
  renderedTerrain = simulation.terrain
  terrainRevision = simulation.terrain.revision
  terrainContext.clearRect(0, 0, WORLD_WIDTH, WORLD_HEIGHT)

  const terrainGradient = terrainContext.createLinearGradient(
    0,
    300,
    0,
    WATER_LEVEL + 30
  )
  terrainGradient.addColorStop(0, '#8dff70')
  terrainGradient.addColorStop(0.035, '#47cf77')
  terrainGradient.addColorStop(0.09, '#285f50')
  terrainGradient.addColorStop(0.58, '#392a42')
  terrainGradient.addColorStop(1, '#211927')
  terrainContext.fillStyle = terrainGradient
  terrainContext.beginPath()
  terrainContext.moveTo(42, simulation.terrain.surfaceAt(42))
  for (let x = 43; x < WORLD_WIDTH - 42; x += 1) {
    terrainContext.lineTo(x, simulation.terrain.surfaceAt(x))
  }
  terrainContext.lineTo(WORLD_WIDTH - 43, WATER_LEVEL + 24)
  terrainContext.lineTo(42, WATER_LEVEL + 24)
  terrainContext.closePath()
  terrainContext.fill()

  terrainContext.strokeStyle = '#b3ff78'
  terrainContext.lineWidth = 3
  terrainContext.beginPath()
  terrainContext.moveTo(42, simulation.terrain.surfaceAt(42))
  for (let x = 43; x < WORLD_WIDTH - 42; x += 3) {
    terrainContext.lineTo(x, simulation.terrain.surfaceAt(x))
  }
  terrainContext.stroke()

  terrainContext.save()
  terrainContext.globalCompositeOperation = 'destination-out'
  for (const crater of simulation.terrain.craters) {
    const gradient = terrainContext.createRadialGradient(
      crater.x,
      crater.y,
      crater.radius * 0.78,
      crater.x,
      crater.y,
      crater.radius
    )
    gradient.addColorStop(0, 'rgba(0,0,0,1)')
    gradient.addColorStop(0.82, 'rgba(0,0,0,1)')
    gradient.addColorStop(1, 'rgba(0,0,0,0)')
    terrainContext.fillStyle = gradient
    terrainContext.beginPath()
    terrainContext.arc(crater.x, crater.y, crater.radius + 2, 0, Math.PI * 2)
    terrainContext.fill()
  }
  terrainContext.restore()
}

function drawDecorations() {
  for (let x = 115; x < WORLD_WIDTH - 90; x += 185) {
    const y = simulation.terrain.surfaceAt(x)
    context.save()
    context.translate(x, y - 4)
    context.globalAlpha = 0.55
    context.strokeStyle = x % 2 === 0 ? '#ff75ec' : '#35e7ff'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(-5, -12)
    context.lineTo(1, -9)
    context.lineTo(7, -21)
    context.stroke()
    context.restore()
  }
}

function drawUnit(unit) {
  if (!unit.alive) return
  const team = TEAM_DEFINITIONS[unit.team]
  const active =
    unit.id === simulation.activeUnitId && simulation.phase !== 'finished'
  const bob =
    active && simulation.phase === 'turn'
      ? Math.sin(performance.now() * 0.005) * 0.7
      : 0
  context.save()
  context.translate(unit.x, unit.y + bob)

  context.fillStyle = 'rgba(0,0,0,0.25)'
  context.beginPath()
  context.ellipse(-2, unit.radius + 8, 24, 6, 0, 0, Math.PI * 2)
  context.fill()

  if (active) {
    context.strokeStyle = team.color
    context.lineWidth = 3
    context.globalAlpha = 0.36 + Math.sin(performance.now() * 0.006) * 0.12
    context.beginPath()
    context.ellipse(0, -2, 28, 32, 0, 0, Math.PI * 2)
    context.stroke()
    context.globalAlpha = 1
  }

  if (active && simulation.phase === 'turn') drawWormAim(unit, team)

  context.save()
  context.scale(unit.facing, 1)
  drawWormBody(team)
  drawWormHeadband(team)
  drawWormBadge(team)
  if (active && simulation.phase === 'turn') drawWormWeapon(unit, team)
  drawWormFace(active)
  context.restore()

  if (active) {
    context.fillStyle = team.color
    context.beginPath()
    context.moveTo(0, -45)
    context.lineTo(-7, -55)
    context.lineTo(7, -55)
    context.closePath()
    context.fill()
  }

  context.font = '800 11px system-ui, sans-serif'
  context.textAlign = 'center'
  context.fillStyle = '#ffffff'
  context.fillText(unit.name, 0, -38)
  context.fillStyle = 'rgba(17,14,20,0.82)'
  context.fillRect(-22, -33, 44, 5)
  context.fillStyle =
    unit.health > 50 ? '#74ff83' : unit.health > 25 ? '#ffe45c' : '#ff5d73'
  context.fillRect(-22, -33, 44 * (unit.health / 100), 5)
  context.restore()
}

function drawWormBody(team) {
  const bodyGradient = context.createLinearGradient(-17, -24, 17, 18)
  bodyGradient.addColorStop(0, '#ffe0c9')
  bodyGradient.addColorStop(0.38, '#f7a08e')
  bodyGradient.addColorStop(0.78, '#e46f73')
  bodyGradient.addColorStop(1, '#a93f5c')
  context.fillStyle = bodyGradient
  context.beginPath()
  context.moveTo(-15, 17)
  context.bezierCurveTo(-21, 13, -19, 6, -11, 2)
  context.bezierCurveTo(-8, 0, -10, -8, -7, -15)
  context.bezierCurveTo(-4, -23, 5, -27, 14, -23)
  context.bezierCurveTo(22, -19, 25, -10, 22, -2)
  context.bezierCurveTo(20, 5, 15, 9, 10, 11)
  context.bezierCurveTo(8, 15, 3, 18, -4, 19)
  context.bezierCurveTo(-9, 20, -13, 19, -15, 17)
  context.closePath()
  context.fill()
  context.strokeStyle = '#6e3148'
  context.lineWidth = 2
  context.stroke()

  context.strokeStyle = 'rgba(255, 230, 215, 0.65)'
  context.lineWidth = 1.4
  context.beginPath()
  context.moveTo(-10, 12)
  context.bezierCurveTo(-3, 16, 4, 15, 8, 11)
  context.stroke()

  context.fillStyle = team.color
  context.beginPath()
  context.ellipse(-11, 15, 5, 2.7, -0.2, 0, Math.PI * 2)
  context.fill()
}

function drawWormHeadband(team) {
  context.fillStyle = team.color
  context.beginPath()
  context.moveTo(-5, -18)
  context.bezierCurveTo(2, -20, 11, -20, 19, -15)
  context.lineTo(20, -10)
  context.bezierCurveTo(10, -15, 2, -15, -6, -13)
  context.closePath()
  context.fill()

  context.fillStyle = team.accent
  context.beginPath()
  context.ellipse(18, -13, 2.3, 2.8, 0, 0, Math.PI * 2)
  context.fill()

  context.fillStyle = team.color
  context.beginPath()
  context.moveTo(-5, -16)
  context.bezierCurveTo(-13, -20, -18, -19, -23, -15)
  context.bezierCurveTo(-17, -14, -13, -11, -8, -8)
  context.closePath()
  context.fill()
  context.beginPath()
  context.moveTo(-6, -15)
  context.bezierCurveTo(-14, -13, -18, -9, -20, -4)
  context.bezierCurveTo(-14, -7, -10, -7, -6, -9)
  context.closePath()
  context.fill()
}

function drawWormBadge(team) {
  context.fillStyle = '#28212d'
  context.beginPath()
  context.arc(-2, 6, 6, 0, Math.PI * 2)
  context.fill()
  context.fillStyle = team.color
  context.beginPath()
  context.moveTo(-2, 1)
  context.lineTo(-6, 7)
  context.lineTo(-2, 7)
  context.lineTo(-4, 12)
  context.lineTo(3, 5)
  context.lineTo(0, 5)
  context.lineTo(3, 1)
  context.closePath()
  context.fill()
}

function drawWormFace(active) {
  context.fillStyle = '#ffffff'
  context.strokeStyle = '#6e3148'
  context.lineWidth = 1
  context.beginPath()
  context.ellipse(7, -10, 5, 7, -0.08, 0, Math.PI * 2)
  context.ellipse(15, -9, 4.5, 6.5, 0.08, 0, Math.PI * 2)
  context.fill()
  context.stroke()

  context.fillStyle = '#221923'
  context.beginPath()
  context.arc(9, -9, 1.8, 0, Math.PI * 2)
  context.arc(17, -8, 1.8, 0, Math.PI * 2)
  context.fill()

  context.strokeStyle = '#653044'
  context.lineWidth = 1.7
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(5, -17)
  context.lineTo(10, -16)
  context.moveTo(13, -15)
  context.lineTo(18, -14)
  context.stroke()

  context.fillStyle = '#c95869'
  context.beginPath()
  context.ellipse(22, -3, 3.5, 2.7, 0, 0, Math.PI * 2)
  context.fill()
  context.strokeStyle = '#6e3148'
  context.lineWidth = 1
  context.stroke()

  context.strokeStyle = '#5f2940'
  context.lineWidth = 2
  context.beginPath()
  if (active) {
    context.arc(14, 0, 5, 0.18, Math.PI - 0.1)
  } else {
    context.arc(14, -1, 4.5, 0.15, Math.PI - 0.05)
  }
  context.stroke()
}

function drawWormAim(unit, team) {
  const angle = (unit.aim * Math.PI) / 180
  const aimLength = 68
  const directionX = Math.cos(angle) * unit.facing
  const directionY = Math.sin(angle)
  context.strokeStyle = '#ffe45c'
  context.lineWidth = 2
  context.setLineDash([5, 5])
  context.beginPath()
  context.moveTo(directionX * 27, directionY * 27)
  context.lineTo(directionX * aimLength, directionY * aimLength)
  context.stroke()
  context.setLineDash([])

  context.fillStyle = team.color
  context.beginPath()
  context.arc(directionX * aimLength, directionY * aimLength, 3, 0, Math.PI * 2)
  context.fill()
}

function drawWormWeapon(unit, team) {
  const angle = (unit.aim * Math.PI) / 180
  context.save()
  context.translate(6, 0)
  context.rotate(angle)

  context.strokeStyle = '#f19a87'
  context.lineWidth = 7
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(0, 0)
  context.lineTo(13, 0)
  context.stroke()

  if (simulation.selectedWeapon === 'grenade') {
    context.shadowColor = team.color
    context.shadowBlur = 8
    context.fillStyle = team.color
    context.beginPath()
    context.arc(18, 0, 6, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#26202b'
    context.beginPath()
    context.moveTo(17, -4)
    context.lineTo(20, -4)
    context.lineTo(18, 0)
    context.lineTo(21, 0)
    context.lineTo(16, 5)
    context.lineTo(17, 1)
    context.lineTo(14, 1)
    context.closePath()
    context.fill()
  } else {
    context.fillStyle = '#302936'
    context.beginPath()
    context.roundRect(10, -5, 23, 10, 4)
    context.fill()
    context.fillStyle = team.color
    context.fillRect(15, -4, 11, 8)
    context.fillStyle = '#17131c'
    context.fillRect(29, -6, 6, 12)
  }
  context.restore()
}

function drawProjectile(projectile) {
  context.save()
  context.translate(projectile.x, projectile.y)
  if (projectile.weapon === 'launcher') {
    context.shadowColor = '#ff1fe1'
    context.shadowBlur = 18
    context.fillStyle = '#ffffff'
    context.beginPath()
    context.arc(0, 0, 5, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = '#ff75ec'
    context.lineWidth = 3
    context.beginPath()
    context.moveTo(0, 0)
    context.lineTo(-projectile.vx * 0.055, -projectile.vy * 0.055)
    context.stroke()
  } else {
    context.rotate(projectile.age * 7)
    context.shadowColor = '#35e7ff'
    context.shadowBlur = 14
    context.fillStyle = '#35e7ff'
    context.beginPath()
    context.arc(0, 0, 8, 0, Math.PI * 2)
    context.fill()
    context.fillStyle = '#17131c'
    context.beginPath()
    context.moveTo(-2, -5)
    context.lineTo(3, -5)
    context.lineTo(0, 0)
    context.lineTo(4, 0)
    context.lineTo(-3, 6)
    context.lineTo(-1, 1)
    context.lineTo(-5, 1)
    context.closePath()
    context.fill()
  }
  context.restore()
}

function drawEffect(effect) {
  const progress = clampUi(effect.age / effect.duration, 0, 1)
  context.save()
  if (effect.type === 'explosion') {
    const radius = effect.radius * (0.35 + progress * 0.95)
    context.globalAlpha = 1 - progress
    const gradient = context.createRadialGradient(
      effect.x,
      effect.y,
      2,
      effect.x,
      effect.y,
      radius
    )
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(0.2, '#ffe45c')
    gradient.addColorStop(0.52, '#ff1fe1')
    gradient.addColorStop(1, 'rgba(84,22,97,0)')
    context.fillStyle = gradient
    context.beginPath()
    context.arc(effect.x, effect.y, radius, 0, Math.PI * 2)
    context.fill()
  }
  if (effect.type === 'damage') {
    context.globalAlpha = 1 - progress
    context.fillStyle = effect.color
    context.font = '900 18px system-ui, sans-serif'
    context.textAlign = 'center'
    context.fillText(effect.text, effect.x, effect.y - progress * 38)
  }
  if (effect.type === 'splash') {
    context.globalAlpha = 1 - progress
    context.strokeStyle = '#bff8ff'
    context.lineWidth = 4
    for (let index = 0; index < 5; index += 1) {
      const offset = (index - 2) * 11
      context.beginPath()
      context.arc(
        effect.x + offset,
        effect.y - Math.sin(progress * Math.PI) * (20 + index * 3),
        5 + progress * 5,
        Math.PI,
        Math.PI * 2
      )
      context.stroke()
    }
  }
  context.restore()
}

function drawWater() {
  const time = performance.now() * 0.002
  const gradient = context.createLinearGradient(0, WATER_LEVEL, 0, WORLD_HEIGHT)
  gradient.addColorStop(0, 'rgba(53,231,255,0.78)')
  gradient.addColorStop(0.16, 'rgba(19,98,157,0.88)')
  gradient.addColorStop(1, '#11182d')
  context.fillStyle = gradient
  context.beginPath()
  context.moveTo(-100, WATER_LEVEL)
  for (let x = -100; x <= WORLD_WIDTH + 100; x += 18) {
    context.lineTo(x, WATER_LEVEL + Math.sin(x * 0.04 + time) * 4)
  }
  context.lineTo(WORLD_WIDTH + 100, WORLD_HEIGHT)
  context.lineTo(-100, WORLD_HEIGHT)
  context.closePath()
  context.fill()
  context.strokeStyle = 'rgba(215,251,255,0.72)'
  context.lineWidth = 2
  context.beginPath()
  for (let x = -100; x <= WORLD_WIDTH + 100; x += 12) {
    const y = WATER_LEVEL + Math.sin(x * 0.04 + time) * 4
    if (x === -100) context.moveTo(x, y)
    else context.lineTo(x, y)
  }
  context.stroke()
}

async function initializeMultiplayer() {
  if (!multiplayerClient) {
    disableOnlineSetup()
    return
  }
  try {
    online.context = await multiplayerClient.context()
    online.available = true
    onlineUnavailable.hidden = true
    const roomId = online.context?.routeParams?.roomId
    if (roomId) await enterOnlineRoom(roomId)
    else await loadOnlineWallets()
  } catch (error) {
    if (
      String(error?.message || error).includes(
        'extension bridge is not available'
      )
    ) {
      disableOnlineSetup()
      return
    }
    throw error
  }
}

function disableOnlineSetup() {
  online.available = false
  onlineUnavailable.hidden = false
  for (const control of onlineSetup.querySelectorAll('button, input, select')) {
    control.disabled = true
  }
}

async function loadOnlineWallets() {
  try {
    const response = await multiplayerClient.listWallets()
    online.wallets = response.wallets || []
  } catch (error) {
    online.wallets = []
    showOnlineError(error)
  }
  walletInput.replaceChildren(
    new Option('Free room', ''),
    ...online.wallets.map(wallet => new Option(wallet.name || wallet.id, wallet.id))
  )
  updatePaymentSetup()
}

function updatePaymentSetup() {
  const entryFeeSats = Number(entryFeeInput.value || 0)
  const paid = Number.isFinite(entryFeeSats) && entryFeeSats > 0
  walletInput.disabled = !paid
  createPayoutField.hidden = !paid
  paymentSetupNote.textContent = paid
    ? online.wallets.length
      ? 'The selected wallet holds the pot and pays server-validated winnings or refunds.'
      : 'No eligible LNbits wallet is available for a paid room.'
    : 'Free room. Set an entry fee to create a competitive pot.'
}

function paymentEntryFee() {
  const amount = Number(entryFeeInput.value || 0)
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 1_000_000) {
    throw new Error('Entry fee must be a whole number from 0 to 1,000,000 sats.')
  }
  return amount
}

async function createOnlineRoom() {
  requireOnline()
  const entryFeeSats = paymentEntryFee()
  const maxPlayers = Number(maxPlayersInput.value)
  if (entryFeeSats > 0) {
    if (!walletInput.value) {
      throw new Error('Select an LNbits wallet for the room pot.')
    }
    await multiplayerClient.requestBackgroundPaymentPermission({
      walletId: walletInput.value,
      maxAmount: entryFeeSats * maxPlayers,
      destinationPolicy: 'external_allowed'
    })
  }
  online.createRequestId ||= secureRequestId()
  const response = await multiplayerClient.createRoom({
    name: roomNameInput.value,
    playerName: playerNameInput.value,
    maxPlayers,
    seed: seedInput.value,
    entryFeeSats,
    walletId: entryFeeSats > 0 ? walletInput.value : '',
    lnAddress: entryFeeSats > 0 ? createPayoutInput.value : '',
    requestId: online.createRequestId
  })
  online.createRequestId = ''
  await saveOnlineToken(response.room.id, response.viewer.token)
  applyOnlineView(response, {forceSnapshot: true})
  startOnlineRealtime()
  if (response.invoice) {
    showPaymentInvoice(response.invoice)
    announce('Lobby created · pay the entry invoice')
  } else {
    announce('Multiplayer lobby created')
  }
}

async function enterOnlineRoom(value) {
  requireOnline()
  const roomId = normalizeRoomId(value)
  if (!roomId) throw new Error('Enter a valid Worm Bits room code.')
  stopOnlineRealtime()
  const token = (await readOnlineToken(roomId)) || ''
  let response = await multiplayerClient.getRoom(roomId, token)
  if (token && !response.viewer) {
    await saveOnlineToken(roomId, '')
    response = await multiplayerClient.getRoom(roomId)
  }
  applyOnlineView(response, {forceSnapshot: true})
  startOnlineRealtime()
  if (response.viewer && !response.viewer.forfeited) {
    queueOnlineHeartbeat()
  }
}

async function joinOnlineRoom() {
  requireRoom()
  if (online.room.status !== 'waiting') {
    throw new Error('This match has already started. Join as a spectator.')
  }
  online.joinRequestId ||= secureRequestId()
  const response = await multiplayerClient.joinRoom(online.room.id, {
    playerName: lobbyNameInput.value,
    lnAddress:
      Number(online.room.entryFeeSats || 0) > 0
        ? lobbyPayoutInput.value
        : '',
    requestId: online.joinRequestId
  })
  online.joinRequestId = ''
  await saveOnlineToken(online.room.id, response.viewer.token)
  applyOnlineView(response, {forceSnapshot: true})
  if (response.invoice) {
    showPaymentInvoice(response.invoice)
    announce('Entry invoice ready')
  } else {
    announce('Joined the lobby')
  }
}

async function spectateOnlineRoom() {
  requireRoom()
  const response = await multiplayerClient.spectateRoom(online.room.id, {
    playerName: lobbyNameInput.value
  })
  await saveOnlineToken(online.room.id, response.viewer.token)
  applyOnlineView(response, {forceSnapshot: true})
  announce('Spectator mode enabled')
}

async function toggleOnlineReady() {
  requireOnlinePlayer()
  const response = await multiplayerClient.setReady(online.room.id, {
    playerToken: online.token,
    ready: !online.viewer.ready
  })
  applyOnlineView(response)
}

async function startOnlineMatch() {
  requireOnlinePlayer()
  const response = await multiplayerClient.startMatch(online.room.id, {
    playerToken: online.token
  })
  applyOnlineView(response, {forceSnapshot: true})
  announce('Match started')
}

async function forfeitOnlineMatch() {
  requireOnlinePlayer()
  const response = await multiplayerClient.forfeit(online.room.id, {
    playerToken: online.token
  })
  applyOnlineView(response, {forceSnapshot: true})
  announce('Your team forfeited')
}

async function leaveOrForfeitOnlineRoom() {
  if (
    online.room?.status === 'waiting' &&
    online.viewer?.role === 'player' &&
    !online.viewer.forfeited
  ) {
    const response = await multiplayerClient.forfeit(online.room.id, {
      playerToken: online.token
    })
    applyOnlineView(response, {forceSnapshot: true})
    const refundStatus = online.viewer?.paymentStatus
    if (
      ['refund-failed', 'refund-processing', 'refund-review'].includes(
        refundStatus
      )
    ) {
      announce({
        'refund-failed': 'Refund failed · retry before leaving',
        'refund-processing': 'Refund is processing · keep this room token',
        'refund-review': 'Refund needs manual review · keep this room token'
      }[refundStatus])
      return
    }
  }
  const roomId = online.room?.id || ''
  if (roomId) await saveOnlineToken(roomId, '')
  leaveOnlineRoom()
}

async function settleOnlineRoom() {
  requireOnlinePlayer()
  if (online.settling) return
  online.settling = true
  renderOnlineSettlement()
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await multiplayerClient.settleRoom(online.room.id, {
        playerToken: online.token
      })
      applyOnlineView(response, {forceSnapshot: true})
      const retryable = online.settlements.filter(
        settlement =>
          settlement.kind === 'payout' &&
          ['pending', 'failed'].includes(settlement.status)
      )
      const failed = retryable.some(
        settlement => settlement.status === 'failed'
      )
      if (!retryable.length || failed || online.room.status === 'waiting') {
        break
      }
    }
    const status = online.room?.settlementStatus
    if (status === 'paid') announce('Worm Bits pot settled')
    else if (status === 'failed') announce('Payout failed · retry is available')
    else if (online.viewer?.paymentStatus === 'refunded') {
      announce('Entry fee refunded')
    }
  } finally {
    online.settling = false
    renderOnlineSettlement()
  }
}

async function copyOnlineInvite() {
  requireRoom()
  const invite = new URL(
    `/ext/wormbits/rooms/${encodeURIComponent(online.room.id)}`,
    window.location.href
  ).toString()
  await navigator.clipboard.writeText(invite)
  announce('Invite copied')
}

function queueOnlineCommand(command, tick) {
  const sequence = ++online.clientSeq
  enqueueOnlineRequest(async () => {
    try {
      const response = await multiplayerClient.submitAction(online.room.id, {
        playerToken: online.token,
        expectedRevision: online.revision,
        clientSeq: sequence,
        tick,
        command
      })
      applyOnlineView(response, {applySnapshot: false})
    } catch (error) {
      showOnlineError(error)
      await refreshOnlineRoom(true)
    }
  })
}

function queueOnlineHeartbeat() {
  if (!online.room || !online.viewer || online.viewer.forfeited) return
  enqueueOnlineRequest(async () => {
    try {
      const viewerWasActive =
        mode === 'online' &&
        online.viewer?.slot === simulation.activeTeam &&
        online.viewer?.role === 'player'
      const response = await multiplayerClient.heartbeat(online.room.id, {
        playerToken: online.token,
        tick: mode === 'online' ? simulation.tick : 0
      })
      applyOnlineView(response, {applySnapshot: !viewerWasActive})
    } catch (error) {
      showOnlineError(error)
      await refreshOnlineRoom(true)
    }
  })
}

function enqueueOnlineRequest(operation) {
  online.requestQueue = online.requestQueue.then(operation, operation)
  return online.requestQueue
}

async function refreshOnlineRoom(forceSnapshot = false) {
  if (!online.room || online.applying) return
  online.applying = true
  try {
    const response = await multiplayerClient.getRoom(
      online.room.id,
      online.token
    )
    applyOnlineView(response, {forceSnapshot})
    await ensureOnlineWebsocket()
  } finally {
    online.applying = false
  }
}

function applyOnlineView(
  response,
  {forceSnapshot = false, applySnapshot = true} = {}
) {
  if (!response?.room) throw new Error('Worm Bits room response is invalid.')
  const responseRevision = Number(response.room.revision || 0)
  if (
    online.room?.id === response.room.id &&
    responseRevision < online.revision
  ) {
    return
  }
  const previousRevision = online.revision
  online.room = response.room
  online.participants = response.participants || []
  online.viewer = response.viewer || null
  online.invoice = response.invoice || null
  online.settlements = response.settlements || []
  online.token = online.viewer?.token || online.token || ''
  online.revision = responseRevision
  online.clientSeq = Math.max(
    online.clientSeq,
    Number(online.viewer?.lastClientSeq || 0)
  )
  roomCodeInput.value = response.room.id
  lobbyNameInput.value =
    online.viewer?.name || playerNameInput.value || 'Anonymous Bit'
  if (
    online.viewer &&
    !['pending', 'refund-pending'].includes(online.viewer.paymentStatus)
  ) {
    paymentOverlay.hidden = true
  }

  const shouldRestore =
    response.snapshot &&
    applySnapshot &&
    (forceSnapshot ||
      mode !== 'online' ||
      online.revision > previousRevision)

  if (shouldRestore) {
    restoreOnlineSnapshot(
      response.snapshot,
      response.serverTime,
      response.room.startedAt
    )
  }

  if (
    response.room.status !== 'waiting' &&
    (!online.viewer || !onlineEntryConfirmed(online.viewer))
  ) {
    mode = 'online-lobby'
    paused = true
    setupOverlay.hidden = true
    lobbyOverlay.hidden = false
    handoffOverlay.hidden = true
    resultOverlay.hidden = true
  } else if (response.room.status === 'waiting') {
    mode = 'online-lobby'
    paused = true
    setupOverlay.hidden = true
    lobbyOverlay.hidden = false
    handoffOverlay.hidden = true
    resultOverlay.hidden = true
    if (simulation.seed !== response.room.seed || simulation.teamCount !== 2) {
      simulation = new WormBitsSimulation({seed: response.room.seed})
      simulation.consumeEvents()
      renderedTerrain = null
      terrainRevision = -1
    }
  } else if (response.snapshot) {
    mode = 'online'
    paused = response.room.status === 'completed'
    setupOverlay.hidden = true
    lobbyOverlay.hidden = true
    handoffOverlay.hidden = true
    if (response.room.status === 'completed') {
      const winner =
        response.room.winnerSlot >= 0
          ? {
              team: response.room.winnerSlot,
              teamName:
                simulation.teamNames[response.room.winnerSlot] || 'A team'
            }
          : {team: null, teamName: 'No team'}
      finishMatch(winner)
    } else {
      resultOverlay.hidden = true
    }
  }
  renderOnlineLobby()
  renderOnlineSettlement()
  updateInterface()
}

function restoreOnlineSnapshot(snapshot, serverTime = 0, startedAt = 0) {
  paused = true
  releaseAllControls()
  simulation = WormBitsSimulation.fromSnapshot(snapshot)
  if (serverTime > 0 && startedAt > 0 && simulation.phase !== 'finished') {
    const clientClockOffset = Date.now() / 1000 - serverTime
    const elapsed = Math.max(0, serverTime + clientClockOffset - startedAt)
    const targetTick = Math.min(
      simulation.tick + 600,
      Math.max(simulation.tick, Math.floor(elapsed / FIXED_STEP))
    )
    while (simulation.tick < targetTick && simulation.phase !== 'finished') {
      simulation.update(FIXED_STEP)
    }
  }
  simulation.consumeEvents()
  replayDriver = null
  lastReplay = null
  effects.length = 0
  renderedTerrain = null
  terrainRevision = -1
  accumulator = 0
  camera.x = simulation.activeUnit()?.x ?? WORLD_WIDTH / 2
  camera.shake = 0
}

function renderOnlineLobby() {
  if (!online.room) return
  lobbyConnection.textContent = online.viewer
    ? online.viewer.connected
      ? 'Connected'
      : 'Reconnecting'
    : 'Spectator access'
  lobbyTitle.textContent = online.room.name
  lobbyRoomCode.textContent = online.room.id
  const players = online.participants.filter(
    participant => participant.role === 'player' && !participant.forfeited
  )
  const confirmedPlayers = players.filter(onlineEntryConfirmed)
  const pendingPlayers = players.filter(
    participant => participant.paymentStatus === 'pending'
  )
  const readyPlayers = confirmedPlayers.filter(
    participant => participant.ready
  )
  lobbySummary.textContent =
    online.room.status === 'waiting'
      ? `${confirmedPlayers.length} / ${online.room.maxPlayers} confirmed · ${readyPlayers.length} ready${
          pendingPlayers.length ? ` · ${pendingPlayers.length} paying` : ''
        }`
      : `${confirmedPlayers.length} players · ${online.room.spectatorCount} watching`
  lobbyPaymentSummary.textContent =
    Number(online.room.entryFeeSats || 0) > 0
      ? `${online.room.entryFeeSats} sats per player · ${online.room.potSats} sats currently in the pot`
      : 'Free room · no Lightning payment required'
  lobbyPayoutField.hidden = Number(online.room.entryFeeSats || 0) <= 0
  lobbyParticipants.replaceChildren(
    ...online.participants.map(participant => {
      const row = document.createElement('div')
      row.className = `lobby-participant${
        participant.connected ? '' : ' is-disconnected'
      }`
      const color = document.createElement('span')
      color.className = 'lobby-participant__color'
      color.style.setProperty(
        '--participant-color',
        participant.role === 'player'
          ? TEAM_DEFINITIONS[participant.slot]?.color || '#817b88'
          : '#817b88'
      )
      const identity = document.createElement('span')
      const name = document.createElement('strong')
      name.textContent = participant.name
      const role = document.createElement('small')
      role.textContent =
        participant.role === 'spectator'
          ? 'Spectator'
          : `Team ${participant.slot + 1}${participant.host ? ' · host' : ''}`
      identity.append(name, role)
      const state = document.createElement('span')
      state.className = 'lobby-participant__state'
      state.textContent = participant.forfeited
        ? participant.paymentStatus === 'refund-failed'
          ? 'Refund retry'
          : participant.paymentStatus === 'refund-review'
            ? 'Refund review'
          : participant.paymentStatus === 'refund-processing'
            ? 'Refund processing'
            : participant.paymentStatus === 'refunded'
              ? 'Refunded'
              : 'Forfeited'
        : !participant.connected
          ? 'Offline'
          : participant.role === 'spectator'
            ? 'Watching'
            : participant.paymentStatus === 'pending'
              ? 'Payment pending'
            : participant.ready
              ? 'Ready'
              : 'Not ready'
      row.append(color, identity, state)
      return row
    })
  )

  const refundNeedsAttention =
    online.viewer?.forfeited === true &&
    [
      'refund-pending',
      'refund-failed',
      'refund-processing',
      'refund-review'
    ].includes(online.viewer?.paymentStatus)
  const retryableRefund =
    refundNeedsAttention &&
    ['refund-pending', 'refund-failed'].includes(
      online.viewer?.paymentStatus
    )
  lobbyJoinControls.hidden =
    !!online.viewer && (!online.viewer.forfeited || refundNeedsAttention)
  joinRoomButton.hidden =
    online.room.status !== 'waiting' ||
    confirmedPlayers.length >= online.room.maxPlayers
  lobbyPlayerControls.hidden =
    !online.viewer ||
    online.viewer.role !== 'player' ||
    (online.viewer.forfeited && !refundNeedsAttention)
  lobbyPaymentState.textContent = onlinePaymentState()
  lobbyPaymentButton.hidden =
    online.viewer?.paymentStatus !== 'pending' && !retryableRefund
  lobbyPaymentButton.textContent =
    online.viewer?.paymentStatus === 'pending'
      ? 'Pay entry invoice'
      : 'Retry refund'
  lobbyReadyButton.hidden =
    online.room.status !== 'waiting' ||
    !onlineEntryConfirmed(online.viewer) ||
    refundNeedsAttention
  lobbyReadyButton.textContent = online.viewer?.ready
    ? 'Cancel ready'
    : 'Ready up'
  const host = online.viewer?.host === true
  lobbyStartButton.hidden = online.room.status !== 'waiting' || !host
  lobbyStartButton.disabled =
    confirmedPlayers.length < 2 ||
    confirmedPlayers.some(player => !player.ready)
  leaveRoomButton.textContent =
    online.room.status === 'waiting' &&
    online.viewer?.paymentStatus === 'paid'
      ? 'Leave & refund'
      : 'Leave'
}

function renderOnlineSettlement() {
  const paidRoom = Number(online.room?.entryFeeSats || 0) > 0
  if (mode !== 'online' || online.room?.status !== 'completed' || !paidRoom) {
    resultSettlementStatus.textContent = ''
    settleButton.hidden = true
    return
  }
  const status = online.room.settlementStatus
  const retryable = online.settlements.some(
    settlement =>
      settlement.kind === 'payout' &&
      ['pending', 'failed'].includes(settlement.status)
  )
  resultSettlementStatus.textContent =
    {
      pending: `${online.room.potSats} sat pot is ready for settlement.`,
      failed: 'A Lightning payout failed. It can be retried safely.',
      processing:
        'A payout is processing or needs manual review. Worm Bits will not retry it blindly.',
      paid:
        online.room.settlementKind === 'draw'
          ? 'The pot was split and paid.'
          : 'The winner was paid.',
      'not-required': 'No payout is required.'
    }[status] || 'Settlement state is being synchronized.'
  settleButton.hidden =
    !retryable || online.viewer?.role !== 'player'
  settleButton.disabled = online.settling
  settleButton.textContent =
    status === 'failed' ? 'Retry payout' : 'Settle pot'
}

function onlinePaymentState() {
  if (!online.viewer || online.viewer.role !== 'player') return ''
  return (
    {
      free: 'No entry payment is required.',
      pending: `Pay the ${online.room.entryFeeSats} sat invoice before readying.`,
      paid: `Entry confirmed · ${online.room.entryFeeSats} sats added to the pot.`,
      'refund-pending': 'Your entry refund is ready to send.',
      'refund-failed': 'Your refund failed. Retry is available.',
      'refund-processing':
        'Your refund is processing and will not be retried blindly.',
      'refund-review':
        'Your refund outcome needs manual review and will not be retried blindly.',
      refunded: 'Your entry fee was refunded.'
    }[online.viewer.paymentStatus] || ''
  )
}

function onlineEntryConfirmed(participant) {
  return !!participant && ['free', 'paid'].includes(participant.paymentStatus)
}

function showPaymentInvoice(invoice) {
  if (!invoice?.paymentRequest) {
    throw new Error('The Worm Bits entry invoice is unavailable.')
  }
  online.invoice = invoice
  paymentAmount.textContent = `${Number(invoice.amountSats || 0)} sats`
  paymentRequest.textContent = invoice.paymentRequest
  paymentStatus.textContent = 'Waiting for payment confirmation.'
  paymentOverlay.hidden = false
}

async function copyPaymentInvoice() {
  if (!online.invoice?.paymentRequest) {
    throw new Error('The Worm Bits entry invoice is unavailable.')
  }
  await navigator.clipboard.writeText(online.invoice.paymentRequest)
  announce('Entry invoice copied')
}

function openPaymentWallet() {
  if (!online.invoice?.paymentRequest) {
    showOnlineError(new Error('The Worm Bits entry invoice is unavailable.'))
    return
  }
  window.location.assign(`lightning:${online.invoice.paymentRequest}`)
}

function startOnlineRealtime() {
  stopOnlineRealtime()
  ensureOnlineWebsocket().catch(showOnlineError)
  online.pollTimer = window.setInterval(() => {
    refreshOnlineRoom().catch(showOnlineError)
  }, 3000)
  online.heartbeatTimer = window.setInterval(queueOnlineHeartbeat, 2000)
}

async function ensureOnlineWebsocket() {
  if (!online.room || online.websocket?.active) return
  try {
    online.websocket = await multiplayerClient.subscribeWebsocket(
      `room:${online.room.id}`,
      event => {
        if (event.event === 'websocket.error') {
          online.websocket = null
          return
        }
        window.clearTimeout(online.refreshTimer)
        online.refreshTimer = window.setTimeout(() => {
          refreshOnlineRoom().catch(showOnlineError)
        }, 40)
      }
    )
  } catch (error) {
    online.websocket = null
    showOnlineError(error)
  }
}

function stopOnlineRealtime() {
  online.websocket?.unsubscribe?.()
  online.websocket = null
  window.clearInterval(online.pollTimer)
  window.clearInterval(online.heartbeatTimer)
  window.clearTimeout(online.refreshTimer)
  online.pollTimer = null
  online.heartbeatTimer = null
  online.refreshTimer = null
}

function leaveOnlineRoom() {
  stopOnlineRealtime()
  paused = true
  releaseAllControls()
  online.room = null
  online.participants = []
  online.viewer = null
  online.invoice = null
  online.settlements = []
  online.token = ''
  online.revision = 0
  online.clientSeq = 0
  online.joinRequestId = ''
  online.settling = false
  online.requestQueue = Promise.resolve()
  paymentOverlay.hidden = true
  openSetup()
}

async function saveOnlineToken(roomId, token) {
  online.token = token
  if (!multiplayerClient) return
  await multiplayerClient.sessionSet(`room.${roomId}.token`, token)
}

async function readOnlineToken(roomId) {
  if (!multiplayerClient) return ''
  return (await multiplayerClient.sessionGet(`room.${roomId}.token`)) || ''
}

function normalizeRoomId(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    return (
      url.pathname
        .split('/')
        .filter(Boolean)
        .at(-1)
        ?.replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 128) || ''
    )
  } catch (_error) {
    return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128)
  }
}

function secureRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replaceAll('-', '')
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('')
}

function requireOnline() {
  if (!online.available || !multiplayerClient) {
    throw new Error('Multiplayer is only available inside LNbits.')
  }
}

function requireRoom() {
  requireOnline()
  if (!online.room) throw new Error('Open a Worm Bits room first.')
}

function requireOnlinePlayer() {
  requireRoom()
  if (online.viewer?.role !== 'player' || !online.token) {
    throw new Error('Join this room as a player first.')
  }
}

function runOnlineUiAction(operation) {
  return Promise.resolve()
    .then(operation)
    .catch(showOnlineError)
}

function showOnlineError(error) {
  const message = String(error?.message || error || 'Multiplayer error.')
  console.warn('[wormbits multiplayer]', message)
  const permissionWarning = onlinePermissionWarning(message)
  announce(permissionWarning || message)
  if (permissionWarning) {
    void multiplayerClient
      ?.notify(permissionWarning, 'warning')
      .catch(() => {})
  }
}

function onlinePermissionWarning(message) {
  const permission = message.match(
    /missing permission ['"]([^'"]+)['"]/i
  )?.[1]
  if (!permission) return ''
  return `Worm Bits could not complete that multiplayer request because the LNbits permission "${permission}" has not been granted. Ask an LNbits administrator to review the installed extension permissions.`
}

function announce(message) {
  if (!message) return
  announcement.textContent = message
  announcement.classList.add('is-visible')
  clearTimeout(announcementTimer)
  announcementTimer = setTimeout(() => {
    announcement.classList.remove('is-visible')
  }, 1800)
}

function updateSoundButton() {
  soundToggle.setAttribute('aria-pressed', String(audio.muted))
  soundToggle.setAttribute(
    'aria-label',
    audio.muted ? 'Unmute sound' : 'Mute sound'
  )
  soundToggle.title = audio.muted ? 'Unmute sound' : 'Mute sound'
  soundToggle.querySelector('span').textContent = audio.muted ? '×' : '♪'
}

function unitName(unitId) {
  return simulation.units.find(unit => unit.id === unitId)?.name ?? 'A bit'
}

function requiredElement(id) {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing Worm Bits element: ${id}`)
  return element
}

function normalizeKey(key) {
  return String(key).toLowerCase()
}

function isGameKey(key) {
  return [
    'a',
    'd',
    'w',
    'x',
    'shift',
    ' ',
    '1',
    '2',
    'arrowleft',
    'arrowright',
    'arrowup',
    'arrowdown'
  ].includes(key)
}

function clampUi(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value))
}

class GameAudio {
  constructor() {
    this.context = null
    this.muted = false
  }

  unlock() {
    if (this.muted) return
    const AudioContext = window.AudioContext ?? window.webkitAudioContext
    if (!AudioContext) return
    if (!this.context) this.context = new AudioContext()
    if (this.context.state === 'suspended') this.context.resume()
  }

  setMuted(muted) {
    this.muted = muted
    if (!muted) this.unlock()
  }

  play(type) {
    if (this.muted) return
    this.unlock()
    if (!this.context) return
    if (type === 'explosion') {
      this._noise(0.24, 0.18)
      this._tone(72, 0.27, 'sawtooth', 0.13, 0.45)
      return
    }
    if (type === 'winner') {
      this._tone(392, 0.12, 'triangle', 0.09)
      window.setTimeout(() => this._tone(523, 0.16, 'triangle', 0.1), 110)
      window.setTimeout(() => this._tone(659, 0.24, 'triangle', 0.11), 230)
      return
    }
    const sounds = {
      turn: [440, 0.09, 'sine', 0.055],
      select: [620, 0.05, 'square', 0.035],
      jump: [280, 0.09, 'square', 0.045, 1.7],
      launch: [150, 0.15, 'sawtooth', 0.07, 2.1],
      grenade: [230, 0.12, 'triangle', 0.065, 0.68],
      bounce: [190, 0.05, 'square', 0.035],
      damage: [92, 0.07, 'sawtooth', 0.04],
      splash: [130, 0.13, 'sine', 0.04, 0.6]
    }
    const sound = sounds[type]
    if (sound) this._tone(...sound)
  }

  _tone(frequency, duration, wave, volume, sweep = 1) {
    if (!this.context) return
    const now = this.context.currentTime
    const oscillator = this.context.createOscillator()
    const gain = this.context.createGain()
    oscillator.type = wave
    oscillator.frequency.setValueAtTime(frequency, now)
    oscillator.frequency.exponentialRampToValueAtTime(
      Math.max(20, frequency * sweep),
      now + duration
    )
    gain.gain.setValueAtTime(volume, now)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration)
    oscillator.connect(gain).connect(this.context.destination)
    oscillator.start(now)
    oscillator.stop(now + duration)
  }

  _noise(duration, volume) {
    if (!this.context) return
    const length = Math.round(this.context.sampleRate * duration)
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate)
    const data = buffer.getChannelData(0)
    for (let index = 0; index < length; index += 1) {
      data[index] = (Math.random() * 2 - 1) * (1 - index / length)
    }
    const source = this.context.createBufferSource()
    const gain = this.context.createGain()
    source.buffer = buffer
    gain.gain.value = volume
    source.connect(gain).connect(this.context.destination)
    source.start()
  }
}

audio = new GameAudio()
updateSoundButton()
