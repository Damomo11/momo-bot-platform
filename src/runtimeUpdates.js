const fs = require('node:fs')
const path = require('node:path')

function readJsonFile (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function normalizeRelease (entry) {
  const version = String(entry?.version || '').trim()
  if (!version) return null
  const title = String(entry?.title || '').trim()
  const summary = String(entry?.summary || '').trim()
  const date = String(entry?.date || '').trim()
  const highlights = Array.isArray(entry?.highlights)
    ? entry.highlights.map(item => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : []
  return { version, title, summary, date, highlights }
}

function runtimeDirFor (root, mode) {
  // admin 模式（管理专用 Bot）跑 admin-runtime；其余按原有映射。
  return path.join(root, mode === 'signin' ? 'signin-runtime' : mode === 'admin' ? 'admin-runtime' : 'smart-runtime')
}

function readRuntimeUpdates (root, mode = 'smart') {
  const runtimeDir = runtimeDirFor(root, mode)
  const packageJson = readJsonFile(path.join(runtimeDir, 'package.json')) || {}
  const releaseJson = readJsonFile(path.join(runtimeDir, 'releases.json'))
  const rawReleases = Array.isArray(releaseJson)
    ? releaseJson
    : Array.isArray(releaseJson?.releases)
      ? releaseJson.releases
      : []
  const releases = rawReleases.map(normalizeRelease).filter(Boolean)
  const currentVersion = String(packageJson.version || '').trim()
  const latestRelease = releases.find(entry => entry.version === currentVersion) || releases[0] || null
  return { mode, version: currentVersion, latestRelease, releases }
}

module.exports = { normalizeRelease, readRuntimeUpdates, runtimeDirFor }
