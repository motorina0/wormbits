import {
  FIXED_STEP,
  ReplayDriver,
  TEAM_DEFINITIONS,
  WATER_LEVEL,
  WEAPONS,
  WORLD_HEIGHT,
  WORLD_WIDTH,
  WormBitsSimulation,
  normalizeSeed
} from './simulation.js'

const canvas = requiredElement('game-canvas')
const context = canvas.getContext('2d', {alpha: false})
const canvasWrap = requiredElement('canvas-wrap')
const setupOverlay = requiredElement('setup-overlay')
const handoffOverlay = requiredElement('handoff-overlay')
const resultOverlay = requiredElement('result-overlay')
const seedInput = requiredElement('seed-input')
const startButton = requiredElement('start-button')
const restartButton = requiredElement('restart-button')
const handoffButton = requiredElement('handoff-button')
const replayButton = requiredElement('replay-button')
const rematchButton = requiredElement('rematch-button')
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

const TEAM_ELEMENTS = [0, 1].map(team => ({
  card: requiredElement(`team-card-${team}`),
  name: requiredElement(`team-name-${team}`),
  health: requiredElement(`team-health-${team}`),
  alive: requiredElement(`team-alive-${team}`)
}))

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

startButton.addEventListener('click', () => {
  audio.unlock()
  startMatch(seedInput.value)
})

restartButton.addEventListener('click', () => {
  openSetup()
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

rematchButton.addEventListener('click', () => {
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
    teams: [simulation.teamSummary(0), simulation.teamSummary(1)]
  })
})

resizeCanvas()
rebuildTerrain()
updateInterface()
requestAnimationFrame(frame)

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
  const accepted = simulation.dispatch(command)
  if (accepted) {
    handleSimulationEvents()
    updateInterface()
  }
  return accepted
}

function canControl() {
  return (
    mode === 'live' &&
    !paused &&
    simulation.phase === 'turn' &&
    simulation.activeUnit()?.alive === true
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
    simulation.dispatch({type: 'move', direction: 0})
    simulation.dispatch({type: 'aim', direction: 0})
    if (shouldFire) simulation.dispatch({type: 'fire'})
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
  for (let team = 0; team < 2; team += 1) {
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
  } else {
    turnLabel.textContent =
      simulation.phase === 'resolving'
        ? 'Resolving action'
        : `Turn ${simulation.turnNumber}`
    activeUnitLabel.textContent =
      simulation.phase === 'finished'
        ? 'Match complete'
        : `${simulation.teamNames[simulation.activeTeam]} · ${active?.name ?? ''}`
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
      : 'Phase 1 · deterministic local play'

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
