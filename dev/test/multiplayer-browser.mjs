import assert from 'node:assert/strict'
import {readFile, stat} from 'node:fs/promises'
import {createServer} from 'node:http'
import {extname, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

import {chromium} from '@playwright/test'

import {WormBitsSimulation} from '../../static/simulation.js'

const devDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const extensionRoot = resolve(devDirectory, '..')
const staticRoot = resolve(extensionRoot, 'static')
const entrypoint = resolve(extensionRoot, 'ui', 'index.html')
const errors = []
const mock = createMockBackend()

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/mock-api') {
      const payload = JSON.parse((await readBody(request)) || '{}')
      const result = mock.request(payload)
      response.writeHead(200, {'Content-Type': 'application/json'})
      response.end(JSON.stringify(result))
      return
    }
    if (url.pathname === '/harness.js') {
      response.writeHead(200, {'Content-Type': 'text/javascript; charset=utf-8'})
      response.end(harnessSource())
      return
    }
    if (['/host', '/guest'].includes(url.pathname)) {
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'})
      response.end(harnessHtml())
      return
    }

    let filePath = entrypoint
    if (url.pathname.startsWith('/ext-assets/wormbits/')) {
      const assetPath = url.pathname.slice('/ext-assets/wormbits/'.length)
      filePath = resolve(staticRoot, assetPath)
      if (!filePath.startsWith(`${staticRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
    } else if (url.pathname !== '/frame') {
      response.writeHead(404).end('Not found')
      return
    }

    await stat(filePath)
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'self'",
        "font-src 'self'"
      ].join('; ')
    })
    response.end(await readFile(filePath))
  } catch (_error) {
    response.writeHead(404).end('Not found')
  }
})

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch({headless: true})

try {
  const hostPage = await browser.newPage({viewport: {width: 1280, height: 900}})
  collectErrors(hostPage)
  await hostPage.goto(`${origin}/host`)
  const host = hostPage.frameLocator('#game-frame')
  await host.getByRole('heading', {name: 'Worm Bits'}).waitFor()
  await host.getByLabel('Display name').first().fill('Host')
  await host.getByLabel('Players').selectOption('2')
  await host.getByRole('button', {name: 'Create multiplayer lobby'}).click()
  await host.getByText('wormroom_1').waitFor()

  const guestPage = await browser.newPage({viewport: {width: 1280, height: 900}})
  collectErrors(guestPage)
  await guestPage.goto(`${origin}/guest?room=wormroom_1`)
  const guest = guestPage.frameLocator('#game-frame')
  await guest.getByRole('button', {name: 'Join match'}).waitFor()
  await guest.getByLabel('Display name').last().fill('Guest')
  await guest.getByRole('button', {name: 'Join match'}).click()
  await host.getByText('Guest').waitFor()

  await host.getByRole('button', {name: 'Ready up'}).click()
  await guest.getByRole('button', {name: 'Ready up'}).click()
  const startButton = host.getByRole('button', {name: 'Start match'})
  await startButton.waitFor()
  await startButton.click()

  await waitForOnline(hostPage)
  await waitForOnline(guestPage)
  assert.equal(
    await hostPage
      .frameLocator('#game-frame')
      .locator('body')
      .evaluate(() => window.wormbitsDebug.getState().teams.length),
    2
  )

  await host.getByRole('button', {name: /Route around/}).click()
  await guestPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Guest did not receive the synchronized turn.')),
          8000
        )
        const timer = setInterval(() => {
          if (window.wormbitsDebug.getState().activeTeam !== 1) return
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }, 50)
      })
    )

  await guestPage.reload()
  await waitForOnline(guestPage)
  const reconnectedGuest = guestPage.frameLocator('#game-frame')
  const reconnected = await guestPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() => window.wormbitsDebug.getState())
  assert.equal(reconnected.viewer.role, 'player')
  assert.equal(reconnected.viewer.slot, 1)
  assert.equal(reconnected.activeTeam, 1)

  const spectatorPage = await browser.newPage({
    viewport: {width: 1280, height: 900}
  })
  collectErrors(spectatorPage)
  await spectatorPage.goto(`${origin}/guest?room=wormroom_1&viewer=spectator`)
  const spectator = spectatorPage.frameLocator('#game-frame')
  await spectator.getByRole('button', {name: 'Watch'}).waitFor()
  await spectator.getByRole('button', {name: 'Watch'}).click()
  await waitForOnline(spectatorPage)
  const spectatorState = await spectatorPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() => window.wormbitsDebug.getState())
  assert.equal(spectatorState.viewer.role, 'spectator')
  assert.equal(
    await spectator.getByRole('button', {name: /Route around/}).isDisabled(),
    true
  )

  const spectatorRevision = mock.revision()
  await guestPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(
      (_body, expectedRevision) =>
        new Promise((resolve, reject) => {
          const timeout = setTimeout(
            () => reject(new Error('Player did not receive spectator revision.')),
            8000
          )
          const timer = setInterval(() => {
            if (
              window.wormbitsDebug.getState().revision < expectedRevision
            ) {
              return
            }
            clearInterval(timer)
            clearTimeout(timeout)
            resolve()
          }, 50)
        }),
      spectatorRevision
    )
  const guestBeforeAction = await guestPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() => window.wormbitsDebug.getState())
  assert.equal(guestBeforeAction.revision, spectatorRevision)
  await reconnectedGuest.getByRole('button', {name: /Route around/}).click()
  await waitForMockTeam(mock, 0)
  await spectatorPage
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Spectator did not recover the latest snapshot.')),
          8000
        )
        const timer = setInterval(() => {
          if (window.wormbitsDebug.getState().activeTeam !== 0) return
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }, 50)
      })
    )

  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}

function createMockBackend() {
  let room = null
  let simulation = null
  let participantCounter = 0
  const participants = []
  const history = []

  return {
    activeTeam() {
      return simulation?.activeTeam ?? null
    },
    revision() {
      return room?.revision ?? 0
    },
    history() {
      return history
    },
    request({method, path, body = {}}) {
      const url = new URL(path, 'http://wormbits.test')
      const parts = url.pathname.split('/').filter(Boolean)
      const suffix = parts.slice(parts.indexOf('rooms') + 1)

      if (method === 'POST' && suffix.length === 0) {
        participantCounter += 1
        const host = participant({
          id: `player_${participantCounter}`,
          token: 'host_token',
          name: body.playerName || 'Host',
          slot: 0
        })
        participants.push(host)
        room = {
          id: 'wormroom_1',
          name: body.name || 'Browser room',
          seed: body.seed || 'browser-multiplayer',
          status: 'waiting',
          maxPlayers: Number(body.maxPlayers || 2),
          playerCount: 1,
          spectatorCount: 0,
          hostPlayerId: host.id,
          revision: 1,
          actionCount: 0,
          winnerSlot: -1,
          createdAt: 1,
          updatedAt: 1,
          startedAt: 0,
          completedAt: 0
        }
        return wrapped(view(host.token))
      }

      if (!room || suffix[0] !== room.id) {
        return {ok: false, error: 'Room not found.'}
      }
      const action = suffix[1] || ''
      if (method === 'GET' && !action) {
        return wrapped(view(url.searchParams.get('playerToken') || ''))
      }
      if (method === 'POST' && action === 'join') {
        participantCounter += 1
        const player = participant({
          id: `player_${participantCounter}`,
          token: `player_token_${participantCounter}`,
          name: body.playerName || 'Guest',
          slot: participants.filter(item => item.role === 'player').length
        })
        participants.push(player)
        room.playerCount += 1
        room.revision += 1
        return wrapped(view(player.token))
      }
      if (method === 'POST' && action === 'spectate') {
        participantCounter += 1
        const spectator = participant({
          id: `viewer_${participantCounter}`,
          token: `viewer_token_${participantCounter}`,
          name: body.playerName || 'Spectator',
          role: 'spectator',
          slot: -1
        })
        participants.push(spectator)
        room.spectatorCount += 1
        room.revision += 1
        return wrapped(view(spectator.token))
      }
      const viewer = participants.find(item => item.token === body.playerToken)
      if (!viewer) return {ok: false, error: 'Participant token required.'}
      if (method === 'POST' && action === 'ready') {
        viewer.ready = body.ready === true
        room.revision += 1
        return wrapped(view(viewer.token))
      }
      if (method === 'POST' && action === 'start') {
        const players = participants.filter(item => item.role === 'player')
        if (
          viewer.id !== room.hostPlayerId ||
          players.length < 2 ||
          players.some(player => !player.ready)
        ) {
          return {ok: false, error: 'Players are not ready.'}
        }
        simulation = new WormBitsSimulation({
          seed: room.seed,
          teamCount: players.length,
          teamNames: players.map(player => player.name)
        })
        simulation.consumeEvents()
        room.status = 'active'
        room.startedAt = Math.floor(Date.now() / 1000)
        room.revision += 1
        return wrapped(view(viewer.token))
      }
      if (method === 'POST' && action === 'actions') {
        history.push({
          type: 'action',
          expectedRevision: body.expectedRevision,
          roomRevision: room.revision,
          playerSlot: viewer.slot,
          activeTeam: simulation.activeTeam,
          command: body.command
        })
        if (
          body.expectedRevision !== room.revision ||
          viewer.slot !== simulation.activeTeam
        ) {
          return {ok: false, error: 'Synchronization required.'}
        }
        if (!simulation.dispatch(body.command)) {
          return {ok: false, error: 'Action rejected.'}
        }
        simulation.consumeEvents()
        viewer.lastClientSeq = body.clientSeq
        room.revision += 1
        room.actionCount += 1
        return wrapped({accepted: true, ...view(viewer.token)})
      }
      if (method === 'POST' && action === 'heartbeat') {
        viewer.connected = true
        return wrapped(view(viewer.token))
      }
      return {ok: false, error: 'Unsupported mock route.'}
    }
  }

  function view(token) {
    const viewer = participants.find(item => item.token === token) || null
    return {
      room,
      participants: participants.map(item => publicParticipant(item)),
      viewer: viewer
        ? {...publicParticipant(viewer), token: viewer.token}
        : null,
      snapshot: simulation?.exportSnapshot() || null,
      serverTime: Math.floor(Date.now() / 1000),
      publicUrl: room ? `/ext/wormbits/rooms/${room.id}` : ''
    }
  }

  function wrapped(data) {
    return {ok: true, data}
  }

  function participant({
    id,
    token,
    name,
    role = 'player',
    slot = 0
  }) {
    return {
      id,
      token,
      name,
      role,
      slot,
      ready: false,
      connected: true,
      forfeited: false,
      host: false,
      joinedAt: participantCounter,
      lastClientSeq: 0
    }
  }

  function publicParticipant(item) {
    return {
      id: item.id,
      name: item.name,
      role: item.role,
      slot: item.slot,
      ready: item.ready,
      connected: item.connected,
      forfeited: item.forfeited,
      host: item.id === room.hostPlayerId,
      joinedAt: item.joinedAt,
      lastClientSeq: item.lastClientSeq
    }
  }
}

function harnessHtml() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Worm Bits harness</title></head>
  <body>
    <iframe id="game-frame" src="/frame" sandbox="allow-scripts"></iframe>
    <script src="/harness.js"></script>
  </body>
</html>`
}

function harnessSource() {
  return `(() => {
    const frame = document.querySelector('#game-frame')
    const query = new URLSearchParams(location.search)
    const roomId = query.get('room')
    const channel = new BroadcastChannel('wormbits-multiplayer-test')
    const subscriptions = new Map()

    channel.addEventListener('message', () => {
      for (const [subscriptionId, value] of subscriptions) {
        value.port.postMessage({
          type: 'lnbits-extension:event',
          event: 'websocket.message',
          subscriptionId,
          itemId: value.itemId,
          data: {event: 'mock-update'}
        })
      }
    })

    window.addEventListener('message', event => {
      if (event.source !== frame.contentWindow) return
      if (event.data?.type !== 'lnbits-extension:connect') return
      const port = event.ports?.[0]
      if (!port) return
      port.addEventListener('message', message => {
        handle(port, message.data)
      })
      port.start()
      port.postMessage({
        type: 'lnbits-extension:connected',
        id: event.data.id
      })
    })

    async function handle(port, message) {
      try {
        let data
        if (message.action === 'context') {
          data = {
            routeParams: roomId ? {roomId} : {},
            query: Object.fromEntries(query)
          }
        } else if (message.action === 'storage.session.get') {
          data = {value: sessionStorage.getItem(message.key)}
        } else if (message.action === 'storage.session.set') {
          if (message.value) sessionStorage.setItem(message.key, message.value)
          else sessionStorage.removeItem(message.key)
          data = {ok: true}
        } else if (message.action === 'websocket.subscribe') {
          subscriptions.set(message.subscriptionId, {
            itemId: message.itemId,
            port
          })
          data = {ok: true}
        } else if (message.action === 'websocket.unsubscribe') {
          subscriptions.delete(message.subscriptionId)
          data = {ok: true}
        } else if (message.action === 'ui.notify') {
          data = {ok: true}
        } else if (message.action === 'api') {
          const response = await fetch('/mock-api', {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
              method: message.method,
              path: message.path,
              body: message.body || {}
            })
          })
          data = await response.json()
          if (message.method !== 'GET') channel.postMessage({type: 'update'})
        } else {
          throw new Error('Unsupported bridge action: ' + message.action)
        }
        port.postMessage({
          type: 'lnbits-extension:response',
          id: message.id,
          ok: true,
          data
        })
      } catch (error) {
        port.postMessage({
          type: 'lnbits-extension:response',
          id: message.id,
          ok: false,
          error: String(error?.message || error)
        })
      }
    }
  })()`
}

function collectErrors(page) {
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
}

async function waitForOnline(page) {
  await page
    .frameLocator('#game-frame')
    .locator('body')
    .evaluate(() =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Worm Bits did not enter online mode.')),
          8000
        )
        const timer = setInterval(() => {
          if (window.wormbitsDebug?.getState().mode !== 'online') return
          clearInterval(timer)
          clearTimeout(timeout)
          resolve()
        }, 50)
      })
    )
}

async function waitForMockTeam(mockBackend, team) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    if (mockBackend.activeTeam() === team) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.equal(
    mockBackend.activeTeam(),
    team,
    JSON.stringify(mockBackend.history().slice(-5))
  )
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function contentType(filePath) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png'
    }[extname(filePath)] ?? 'application/octet-stream'
  )
}
