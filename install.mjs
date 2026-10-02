#!/usr/bin/env node
/**
 * Install (or uninstall) this plugin into a dsh profile without pnpm.
 *
 * The dsh profile is `<DSH_HOME>/profiles/<name>`: a `package.json` whose
 * `dsh.profile.bundles` list selects bundle patch layers, plus the packages in
 * `node_modules`. The in-app plugin manager and `dsh plugin add file:<dir>`
 * both do this for you; this script is the fallback for when neither is
 * available (a local path the GUI refuses, or no `dsh` command on PATH).
 *
 * Usage:
 *   node install.mjs --profile desktop            # into the desktop profile
 *   node install.mjs --profile desktop --dry-run
 *   node install.mjs --profile desktop --uninstall
 *   node install.mjs --home /tmp/dsh --profile web
 *
 * Quit DeepSeek Harness first: the profile is composed at boot, so the plugin
 * takes effect on the next launch.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_NAME = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8')).name

/** Files that make up the installed package (test/ and scratch stay behind). */
const SHIPPED = ['package.json', 'src', 'cordis.patch.yml', 'README.md', 'LICENSE']

function parseArgs(argv) {
  const options = { home: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), profile: 'desktop', uninstall: false, dryRun: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--home') options.home = argv[++index]
    else if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--dry-run') options.dryRun = true
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (options.home === undefined || options.profile === undefined) throw new Error('--home and --profile need values')
  return options
}

function readManifest(filename) {
  if (!fs.existsSync(filename)) {
    throw new Error(`${filename} not found: launch DeepSeek Harness once to initialize this profile`)
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}

function writeManifest(filename, manifest, dryRun) {
  const body = JSON.stringify(manifest, undefined, 2) + '\n'
  if (dryRun) {
    console.log(`--- would write ${filename} ---\n${body}`)
    return
  }
  fs.copyFileSync(filename, `${filename}.bak-${Date.now()}`)
  fs.writeFileSync(filename, body)
  console.log(`updated ${filename} (backup kept beside it)`)
}

function copyPackage(target, dryRun) {
  if (dryRun) {
    console.log(`--- would copy ${PLUGIN_DIR} -> ${target} ---`)
    return
  }
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  for (const entry of SHIPPED) {
    const source = path.join(PLUGIN_DIR, entry)
    if (fs.existsSync(source)) fs.cpSync(source, path.join(target, entry), { recursive: true })
  }
  console.log(`installed ${PLUGIN_NAME} -> ${target}`)
}

const options = parseArgs(process.argv.slice(2))
const profileDir = path.join(options.home, 'profiles', options.profile)
const manifestPath = path.join(profileDir, 'package.json')
const target = path.join(profileDir, 'node_modules', PLUGIN_NAME)

console.log(`plugin  : ${PLUGIN_DIR}`)
console.log(`profile : ${profileDir}`)
console.log(`mode    : ${options.uninstall ? 'uninstall' : 'install'}${options.dryRun ? ' (dry run)' : ''}`)

const manifest = readManifest(manifestPath)
const dependencies = { ...(manifest.dependencies ?? {}) }
const bundles = [...(manifest.dsh?.profile?.bundles ?? [])]

if (options.uninstall) {
  delete dependencies[PLUGIN_NAME]
  const next = bundles.filter((name) => name !== PLUGIN_NAME)
  manifest.dependencies = dependencies
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: next } }
  writeManifest(manifestPath, manifest, options.dryRun)
  if (!options.dryRun) fs.rmSync(target, { recursive: true, force: true })
  console.log(`removed ${PLUGIN_NAME}; restart DeepSeek Harness. The shipped http provider is active again.`)
} else {
  copyPackage(target, options.dryRun)
  dependencies[PLUGIN_NAME] = `file:${PLUGIN_DIR}`
  if (!bundles.includes(PLUGIN_NAME)) bundles.push(PLUGIN_NAME)
  manifest.dependencies = dependencies
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
  writeManifest(manifestPath, manifest, options.dryRun)
  console.log(`\nbundles: ${bundles.join(', ')}`)
  console.log('\nnext: start DeepSeek Harness, then fetch any URL (web_fetch). Revert with --uninstall.')
}
