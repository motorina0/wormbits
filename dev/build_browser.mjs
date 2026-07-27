import {readFile, writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const extensionRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const simulationPath = resolve(extensionRoot, 'static', 'simulation.js')
const gamePath = resolve(extensionRoot, 'static', 'game.js')
const bundlePath = resolve(extensionRoot, 'static', 'game.bundle.js')

const simulationSource = await readFile(simulationPath, 'utf8')
const gameSource = await readFile(gamePath, 'utf8')
const importEnd = gameSource.indexOf("} from './simulation.js'")

if (!gameSource.startsWith('import {') || importEnd < 0) {
  throw new Error('Could not find the simulation import in static/game.js.')
}

const gameWithoutImport = gameSource.slice(
  gameSource.indexOf('\n', importEnd) + 1
)
const simulationWithoutExports = simulationSource.replace(
  /^export (const|class|function) /gm,
  '$1 '
)
const bundle = `'use strict'

${simulationWithoutExports.trimEnd()}

${gameWithoutImport.trim()}
`

await writeFile(bundlePath, bundle, 'utf8')
console.log(
  `Built ${bundlePath.slice(extensionRoot.length + 1)} (${Buffer.byteLength(bundle)} bytes)`
)
