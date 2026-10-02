#!/usr/bin/env node
/**
 * Build three throwaway dsh profiles under <work>/homes, each booting the REAL
 * harness from the installed application with this plugin (and a probe that
 * calls ctx.web.fetch at startup):
 *
 *   baseline  shipped providers only            -> every URL is WEB_BLOCKED_URL
 *   fakeip    plugin, mode fake-ip              -> external OK, 127.0.0.1 blocked
 *   off       plugin, mode off (user layer)     -> external OK, 127.0.0.1 OK
 *
 * Usage: node mkhomes.mjs <workDir> <pluginDir> <probeDir> <loopbackPort>
 */
import fs from 'node:fs'
import path from 'node:path'

const [work, pluginDir, probeDir, port] = process.argv.slice(2)
if (work === undefined || pluginDir === undefined || probeDir === undefined) {
  console.error('usage: node mkhomes.mjs <workDir> <pluginDir> <probeDir> <loopbackPort>')
  process.exit(2)
}

const PLUGIN = 'dsh-plugin-web-fetch-fake-ip'
const PROBE = 'dsh-plugin-fakeip-probe'
const URLS = ['https://example.com/', `http://127.0.0.1:${port}/`]

function writeProfile(name, bundles, profilePatch) {
  const root = path.join(work, 'homes', name)
  const dir = path.join(root, 'profiles', 'web')
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true })

  // Probe copy with this run's URLs in its own bundle patch.
  const probeCopy = path.join(root, 'probe')
  fs.cpSync(probeDir, probeCopy, { recursive: true })
  fs.writeFileSync(path.join(probeCopy, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: fakeip-probe`,
    `      name: ${PROBE}`,
    '      config:',
    '        urls:',
    ...URLS.map((url) => `          - ${url}`),
    ''
  ].join('\n'))

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', PROBE, ...bundles] } }
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), profilePatch)
  fs.symlinkSync(probeCopy, path.join(dir, 'node_modules', PROBE), 'dir')
  if (bundles.includes(PLUGIN)) {
    fs.symlinkSync(pluginDir, path.join(dir, 'node_modules', PLUGIN), 'dir')
  }
  console.log(`built ${name}: ${path.join(dir, 'package.json')}`)
}

writeProfile('baseline', [], '# user patch layer (empty)\n[]\n')
writeProfile('fakeip', [PLUGIN], '# user patch layer (empty)\n[]\n')
writeProfile('off', [PLUGIN], [
  '# user patch layer: flip the plugin to mode off.',
  '# A patch replaces the targeted row whole config, so allowCidrs is restated.',
  '- id: web-fetch-fake-ip',
  '  config:',
  '    mode: off',
  '    allowCidrs:',
  '      - 198.18.0.0/15',
  ''
].join('\n'))
