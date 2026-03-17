// ═══════════════════════════════════════════════════════════════════
//  platform.js — environment-aware adapter
//
//  Used by ChannelStrip.jsx instead of calling browser or Electron
//  APIs directly. All platform differences are isolated here.
//
//  In web mode  → localStorage, File System Access API, <input> pickers
//  In Electron  → IPC calls to main process, native dialogs, fs module
// ═══════════════════════════════════════════════════════════════════

const STORAGE_KEY = 'idoru-p1-project'
const PRESET_KEY  = 'idoru-p1-presets'
const THEME_KEY   = 'cidoru-theme'

// ── Environment detection ─────────────────────────────────────────
export const isElectron = () =>
  typeof window !== 'undefined' && !!window.electronAPI?.isElectron

// ── Theme persistence ─────────────────────────────────────────────
export function getTheme () {
  // Electron: stored in session file or falls back to localStorage
  // Web: localStorage
  try { return localStorage.getItem(THEME_KEY) || 'dark' } catch { return 'dark' }
}

export function saveTheme (theme) {
  try { localStorage.setItem(THEME_KEY, theme) } catch {}
  // In Electron the same localStorage bridge works via the renderer;
  // no IPC needed — theme is purely a UI preference, not a session concern.
}

// ── Cached initial data (read once at startup) ────────────────────
let _initSessionCache = undefined
let _initPresetsCache = undefined

export function getInitialSession () {
  if (_initSessionCache !== undefined) return _initSessionCache
  if (isElectron()) {
    // First run migration: if Electron has no session file yet but localStorage does, migrate it
    if (window.electronAPI.needsMigration) {
      try {
        const raw = localStorage.getItem('idoru-p1-project')
        if (raw) {
          const data = JSON.parse(raw)
          // Save to file asynchronously — platform.saveSession will persist it
          window.electronAPI.session.save(data).then(() => {
            window.electronAPI.migrationComplete()
          })
          _initSessionCache = data
          return _initSessionCache
        }
      } catch (_) {}
      // No localStorage data either — mark migration done so we don't check again
      window.electronAPI.migrationComplete()
    }
    _initSessionCache = window.electronAPI.initialSession ?? null
  } else {
    try {
      const r = localStorage.getItem(STORAGE_KEY)
      _initSessionCache = r ? JSON.parse(r) : null
    } catch { _initSessionCache = null }
  }
  return _initSessionCache
}

export function getInitialPresets () {
  if (_initPresetsCache !== undefined) return _initPresetsCache
  if (isElectron()) {
    // Also migrate presets from localStorage on first run
    if (window.electronAPI.needsMigration) {
      try {
        const raw = localStorage.getItem('idoru-p1-presets')
        if (raw) {
          const data = JSON.parse(raw)
          window.electronAPI.presets.save(data)
          _initPresetsCache = data
          return _initPresetsCache
        }
      } catch (_) {}
    }
    _initPresetsCache = window.electronAPI.initialPresets ?? []
  } else {
    try {
      const r = localStorage.getItem(PRESET_KEY)
      _initPresetsCache = r ? JSON.parse(r) : []
    } catch { _initPresetsCache = [] }
  }
  return _initPresetsCache
}

// ── Session persistence ───────────────────────────────────────────
export async function saveSession (data) {
  _initSessionCache = data   // update in-memory cache immediately
  if (isElectron()) {
    return window.electronAPI.session.save(data)
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    return true
  } catch { return false }
}

export async function loadSession () {
  if (isElectron()) {
    return window.electronAPI.session.load()
  }
  try {
    const r = localStorage.getItem(STORAGE_KEY)
    return r ? JSON.parse(r) : null
  } catch { return null }
}

// ── Preset persistence ────────────────────────────────────────────
export async function savePresets (data) {
  _initPresetsCache = data   // update in-memory cache immediately
  if (isElectron()) {
    return window.electronAPI.presets.save(data)
  }
  try {
    localStorage.setItem(PRESET_KEY, JSON.stringify(data))
    return true
  } catch { return false }
}

// ── File picking ──────────────────────────────────────────────────
//
//  Both functions return the same shape:
//  {
//    nameNoExt: string,
//    stereo:    boolean,          (WAV only)
//    sampleRate: number,          (WAV only)
//    bitDepth:  number,           (WAV only)
//    warnings:  string[],         (WAV only)
//    file?:     File,             (web only — for in-memory cache)
//    filePath?: string,           (Electron only — persisted path)
//  }
//  Returns null if cancelled.

export function pickWav () {
  if (isElectron()) {
    return window.electronAPI.pick.wav()
    // Returns {nameNoExt, stereo, sampleRate, bitDepth, warnings, filePath} or null
  }
  // Web: wrap <input> in a Promise
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.wav'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) { resolve(null); return }
      // Dynamically import readWavInfo from ChannelStrip context
      // (it's re-exported from platform for this purpose)
      const info      = await _readWavInfo(file)
      const nameNoExt = file.name.replace(/\.wav$/i, '')
      resolve({
        nameNoExt,
        stereo:     info?.stereo     ?? false,
        sampleRate: info?.sampleRate ?? 0,
        bitDepth:   info?.bitDepth   ?? 0,
        warnings:   info?.warnings   ?? [],
        file,     // web only
      })
    }
    input.onclick = () => { /* allow re-picking same file */ input.value = '' }
    input.click()
  })
}

export function pickMidi () {
  if (isElectron()) {
    return window.electronAPI.pick.midi()
    // Returns {nameNoExt, filePath} or null
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.mid,.midi'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) { resolve(null); return }
      const nameNoExt = file.name.replace(/\.midi?$/i, '')
      resolve({ nameNoExt, file })
    }
    input.click()
  })
}

export function pickRelink (isMidi) {
  if (isElectron()) {
    return window.electronAPI.pick.relink(isMidi)
    // Returns {nameNoExt, filePath, stereo?, warnings?} or null
  }
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = isMidi ? '.mid,.midi' : '.wav'
    input.onchange = async (e) => {
      const file = e.target.files?.[0]
      if (!file) { resolve(null); return }
      const nameNoExt = file.name.replace(/\.(wav|midi?)$/i, '')
      if (!isMidi) {
        const info = await _readWavInfo(file)
        resolve({ nameNoExt, stereo: info?.stereo ?? false, warnings: info?.warnings ?? [], file })
      } else {
        resolve({ nameNoExt, file })
      }
    }
    input.click()
  })
}

// ── File cache ────────────────────────────────────────────────────
//  In web mode  → stores File objects (in-memory, lost on reload)
//  In Electron  → stores file paths (strings, survive reload)
//
//  The App passes this cache to platform.transfer().

export function cacheFileFromPickResult (cacheMap, key, result) {
  if (!result) return
  if (result.filePath) cacheMap.set(key, result.filePath) // Electron
  else if (result.file) cacheMap.set(key, result.file)    // Web
}

// ── Scan ──────────────────────────────────────────────────────────
//  In Electron: actually verify paths exist on disk.
//  In web: can't check — always returns all as unverifiable.

export async function scanVerify (fileCache) {
  if (!isElectron()) return null  // null = "can't verify"
  const pathMap = {}
  for (const [key, val] of fileCache) {
    if (typeof val === 'string') pathMap[key] = val
  }
  // If nothing is cached, we can't verify anything — return null not {}
  // {} would mean "verified empty" which falsely marks all files as OK
  if (Object.keys(pathMap).length === 0) return null
  return window.electronAPI.scan.verify(pathMap)
}

// ── SD Card Transfer ──────────────────────────────────────────────
export async function transfer (project, mixerStates, fileCache, onProgress) {
  if (isElectron()) {
    // Convert cache to {key: path} — only string paths go to main process
    const filePaths = {}
    for (const [key, val] of fileCache) {
      if (typeof val === 'string') filePaths[key] = val
    }
    const cleanup = window.electronAPI.transfer.onProgress(onProgress)
    try {
      const result = await window.electronAPI.transfer.start(project, mixerStates, filePaths)
      if (!result.ok) throw new Error(result.error || 'Transfer failed')
      return result.missing ?? []
    } finally {
      cleanup()
    }
  }
  // Web: File System Access API
  return webTransfer(project, mixerStates, fileCache, onProgress)
}

// ── Web transfer (File System Access API) ─────────────────────────
async function webTransfer (project, mixerStates, fileCache, onProgress) {
  if (!window.showDirectoryPicker)
    throw new Error('File System Access API not supported. Use Chrome or Edge.')

  const root     = await window.showDirectoryPicker({ mode: 'readwrite' })
  const listsDir = await root.getDirectoryHandle('lists', { create: true })
  const missing  = []

  for (const pl of project.playlists) {
    const songs  = project.songs.filter(s => s.playlistId === pl.id)
    const plName = _sanitizeName(pl.name)
    const plDir  = await listsDir.getDirectoryHandle(plName, { create: true })

    const slTxt = _genSetlist(pl, songs, mixerStates)
    const slFH  = await plDir.getFileHandle(`${plName}.txt`, { create: true })
    const slW   = await slFH.createWritable(); await slW.write(slTxt); await slW.close()
    onProgress?.(`✓ ${plName}/${plName}.txt`)

    for (const song of songs) {
      const sName   = _sanitizeName(song.name)
      const songDir = await plDir.getDirectoryHandle(sName, { create: true })

      const sTxt = _genSong(song, mixerStates[song.id])
      const sFH  = await songDir.getFileHandle(`${sName}.txt`, { create: true })
      const sW   = await sFH.createWritable(); await sW.write(sTxt); await sW.close()
      onProgress?.(`  ✓ ${plName}/${sName}/${sName}.txt`)

      // WAV files
      const slots = song.audioSlots ?? []
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i]
        if (!sl?.fileName) continue
        const f = fileCache?.get(`${song.id}_f${i}`)
        if (f instanceof File) {
          const fh = await songDir.getFileHandle(`${sl.fileName}.wav`, { create: true })
          const fw = await fh.createWritable()
          await fw.write(await f.arrayBuffer()); await fw.close()
          onProgress?.(`  ✓ ${sl.fileName}.wav`)
        } else {
          missing.push(`${song.name} — F${i + 1}: ${sl.fileName}.wav`)
          onProgress?.(`  ⚠ ${sl.fileName}.wav — not in cache`)
        }
      }

      // MIDI
      if (song.midiFile) {
        const mf = fileCache?.get(`${song.id}_midi`)
        if (mf instanceof File) {
          const mh = await songDir.getFileHandle(`${song.midiFile}.mid`, { create: true })
          const mw = await mh.createWritable()
          await mw.write(await mf.arrayBuffer()); await mw.close()
          onProgress?.(`  ✓ ${song.midiFile}.mid`)
        } else {
          missing.push(`${song.name} — MIDI: ${song.midiFile}.mid`)
          onProgress?.(`  ⚠ ${song.midiFile}.mid — not in cache`)
        }
      }
    }
  }
  return missing
}

// ── Export / Import JSON ──────────────────────────────────────────
export async function exportJson (data) {
  const jsonStr = JSON.stringify({ ...data, exportedAt: new Date().toISOString() }, null, 2)
  if (isElectron()) {
    const ok = await window.electronAPI.exportJson(jsonStr)
    return ok
  }
  // Web: blob download
  const blob = new Blob([jsonStr], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url; a.download = `idoru-session-${Date.now()}.json`
  a.click(); URL.revokeObjectURL(url)
  return true
}

export async function importJson () {
  if (isElectron()) {
    const raw = await window.electronAPI.importJson()
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }
  // Web: FileReader
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.json'
    input.onchange = (e) => {
      const file = e.target.files?.[0]
      if (!file) { resolve(null); return }
      const reader = new FileReader()
      reader.onload = (ev) => {
        try { resolve(JSON.parse(ev.target.result)) }
        catch { resolve(null) }
      }
      reader.readAsText(file)
    }
    input.click()
  })
}

// ── Internal helpers (duplicated from ChannelStrip to avoid circular deps) ──
function _sanitizeName (s) {
  return (s || 'unnamed').replace(/[/\\:*?"<>|]/g, '_').slice(0, 31)
}

function _dbToNorm (db, min = -60, max = 10) {
  if (db <= min) return 0
  if (db >= max) return 1
  return (db - min) / (max - min)
}

function _genSong (song, state) {
  const mat = (state?.matrix?.length === 7) ? state.matrix : Array.from({ length: 7 }, () => Array(7).fill(0))
  const lf  = state?.leftMutes  ?? Array(7).fill(false)
  const lp  = state?.linkedPairs ?? [false, false, false]
  const mod = state?.modifierDb  ?? 0
  const IN_KEYS  = ['FileL', 'FileL', 'FileL', 'FileL', 'FileL', 'FileL', 'AuxIn']
  const COL_KEYS = ['HeadPhone', 'Output1', 'Output2', 'Output3', 'Output4', 'Output5', 'Output6']
  let txt = `"${song.name}"\n`
  txt += `Level- ${Math.round(_dbToNorm(mod, -20, 20) * 100)}\n`
  txt += `BPM- ${song.bpm ?? 120}\n`
  const atEnd = { queue_next: 'Queue', play_next: 'Next', loop: 'Loop' }[song.queueBehavior] ?? 'Queue'
  txt += `AtEnd- ${atEnd}\n`
  const slots = song.audioSlots ?? []
  const links = lp.map((on, i) => on ? `${i * 2 + 1}-${i * 2 + 2}` : null).filter(Boolean).join(' ')
  if (links) txt += `StereoLinks- ${links}\n`
  txt += '\nInput Files\n'
  for (let i = 0; i < 6; i++) {
    const sl = slots[i]
    if (sl?.fileName) {
      const label = sl.shortName || sl.fileName.slice(0, 2).toUpperCase()
      txt += `"${sl.fileName}" ${label} ${sl.stereo ? 'Stereo' : 'Mono'}\n`
    }
  }
  if (song.midiFile) txt += `\nMIDI\n"${song.midiFile}"\n`
  const nonZeroCols = [0, 1, 2, 3, 4, 5, 6].filter(c => mat.some(row => row[c] > 0))
  nonZeroCols.forEach(colIdx => {
    txt += `\n${COL_KEYS[colIdx]}\n`
    for (let inIdx = 0; inIdx < 7; inIdx++) {
      const level = mat[inIdx][colIdx]
      const mute  = lf[inIdx] ? ' MUTE' : ''
      txt += `IN${inIdx + 1}- ${IN_KEYS[inIdx]} ${level}${mute}\n`
    }
  })
  return txt
}

function _genSetlist (playlist, songs, mixerStates) {
  const first = songs.length > 0 ? (mixerStates[songs[0].id] ?? {}) : {}
  const rf    = first.rightFaders ?? Array(7).fill({ db: 0 })
  const lp    = first.linkedPairs ?? [false, false, false]
  const lvl   = (i) => Math.round(_dbToNorm(rf[i]?.db ?? 0) * 100)
  const links = lp.map((on, i) => on ? `${i * 2 + 1}-${i * 2 + 2}` : null).filter(Boolean).join(' ')
  let txt = 'Global sets\n'
  if (links) txt += `StereoLinks- ${links}\n`
  txt += `HeadPhone- ${lvl(6)}\n`
  for (let i = 0; i < 6; i++) txt += `Output${i + 1}- ${lvl(i)}\n`
  txt += '\nSongs\n'
  songs.forEach(s => { txt += `"${s.name}"\n` })
  return txt
}

// ── WAV info (browser version, used by web-mode pickers) ─────────
//  This is injected at runtime by ChannelStrip.jsx via setPlatformWavReader()
let _readWavInfo = async () => null

export function setPlatformWavReader (fn) {
  _readWavInfo = fn
}
