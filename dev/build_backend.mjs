import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const extensionRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sdkPath = resolve(extensionRoot, 'dev', 'src', 'lnbits-sdk.js')
const simulationPath = resolve(extensionRoot, 'static', 'simulation.js')
const entryPath = resolve(extensionRoot, 'dev', 'src', 'index.js')
const outputPath = resolve(extensionRoot, 'dev', 'dist', 'index.bundle.js')

const sdkSource = await readFile(sdkPath, 'utf8')
const simulationSource = await readFile(simulationPath, 'utf8')
let entrySource = await readFile(entryPath, 'utf8')

entrySource = entrySource
  .replace(
    /^import \{[\s\S]*?\} from '\.\/lnbits-sdk\.js'\n/,
    ''
  )
  .replace(
    /^import \{[\s\S]*?\} from '\.\.\/\.\.\/static\/simulation\.js'\n/,
    ''
  )

const bundledSdk = sdkSource.replace(/^export const /gm, 'const ')
const bundledSimulation = simulationSource.replace(
  /^export (const|class|function) /gm,
  '$1 '
)

await mkdir(dirname(outputPath), {recursive: true})
await writeFile(
  outputPath,
  `${bundledSdk.trimEnd()}\n\n${bundledSimulation.trimEnd()}\n\n${entrySource.trim()}\n`,
  'utf8'
)
console.log(
  `Built ${outputPath.slice(extensionRoot.length + 1)}`
)
