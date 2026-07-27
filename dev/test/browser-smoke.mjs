import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {readFile, stat} from 'node:fs/promises'
import {extname, resolve, sep} from 'node:path'
import {fileURLToPath} from 'node:url'

import {chromium} from '@playwright/test'

const devDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const extensionRoot = resolve(devDirectory, '..')
const staticRoot = resolve(extensionRoot, 'static')
const entrypoint = resolve(extensionRoot, 'ui', 'index.html')
const errors = []

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    let filePath = entrypoint
    if (url.pathname.startsWith('/ext-assets/wormbits/')) {
      const assetPath = url.pathname.slice('/ext-assets/wormbits/'.length)
      filePath = resolve(staticRoot, assetPath)
      if (!filePath.startsWith(`${staticRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
    } else if (url.pathname !== '/') {
      response.writeHead(404).end('Not found')
      return
    }

    await stat(filePath)
    const content = await readFile(filePath)
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Content-Security-Policy': [
        'sandbox allow-scripts',
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "img-src 'self' data:",
        "media-src 'self'",
        "connect-src 'none'",
        "font-src 'self'",
        "worker-src 'none'"
      ].join('; ')
    })
    response.end(content)
  } catch (error) {
    response.writeHead(404).end('Not found')
  }
})

await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const browser = await chromium.launch({headless: true})

try {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}})
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))

  await page.goto(`http://127.0.0.1:${address.port}/`)
  await page.getByRole('heading', {name: 'Worm Bits'}).waitFor()
  await page.getByLabel('Terrain seed').fill('browser-smoke')
  await page.getByRole('button', {name: 'Start local match'}).click()

  try {
    await page.waitForFunction(
      () =>
        window.wormbitsDebug?.getState().mode === 'live' &&
        window.wormbitsDebug?.getState().paused === false
    )
  } catch (error) {
    throw new Error(
      `Worm Bits did not start. Browser errors: ${JSON.stringify(errors)}`,
      {cause: error}
    )
  }
  const started = await page.evaluate(() => window.wormbitsDebug.getState())
  assert.equal(started.seed, 'browser-smoke')
  assert.equal(started.phase, 'turn')
  assert.equal(started.teams[0].alive, 3)
  assert.equal(started.teams[1].alive, 3)

  const canvasHasArtwork = await page
    .locator('#game-canvas')
    .evaluate(canvas => {
      const context = canvas.getContext('2d')
      const samples = new Set()
      const widthStep = Math.max(1, Math.floor(canvas.width / 12))
      const heightStep = Math.max(1, Math.floor(canvas.height / 8))
      for (let y = 0; y < canvas.height; y += heightStep) {
        for (let x = 0; x < canvas.width; x += widthStep) {
          samples.add([...context.getImageData(x, y, 1, 1).data].join(','))
        }
      }
      return samples.size > 8
    })
  assert.equal(canvasHasArtwork, true)

  await page.keyboard.down('Space')
  await page.waitForTimeout(350)
  await page.keyboard.up('Space')
  await page.waitForFunction(
    () => {
      const state = window.wormbitsDebug?.getState()
      return state?.turnNumber === 2 && state?.paused === true
    },
    {timeout: 15_000}
  )
  await page.getByRole('button', {name: 'Begin turn'}).click()

  const secondTurn = await page.evaluate(() => window.wormbitsDebug.getState())
  assert.equal(secondTurn.activeTeam, 1)
  assert.equal(secondTurn.phase, 'turn')
  assert.equal(secondTurn.paused, false)

  await page.getByRole('button', {name: /Route around/}).click()
  await page.waitForFunction(
    () => window.wormbitsDebug?.getState().turnNumber === 3
  )
  if (process.env.WORMBITS_SCREENSHOT_PATH) {
    await page.screenshot({
      path: process.env.WORMBITS_SCREENSHOT_PATH,
      fullPage: true
    })
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
}

function contentType(filePath) {
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml'
    }[extname(filePath)] ?? 'application/octet-stream'
  )
}
