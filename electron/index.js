import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, basename } from 'path'
import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync,
  createWriteStream,
} from 'fs'
import { readFile, writeFile, mkdir } from 'fs/promises'
// electron-updater: must use default import in ESM context
import updater from 'electron-updater'
const { autoUpdater } = updater

// ── Paths ─────────────────────────────────────────────────────────
const userData      = () => app.getPath('userData')
const sessionPath   = () => join(userData(), 'session.json')
const presetsPath   = () => join(userData(), 'presets.json')
const fileCachePath = () => join(userData(), 'file-cache.json')

// ── WAV header reader (Node.js Buffer version) ────────────────────
function readWavInfoNode (buf) {
  if (buf.length < 12) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' &&
      buf.toString('ascii', 0, 4) !== 'RF64') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null

  let offset = 12
  while (offset + 8 <= buf.length) {
    const id        = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const dataOff   = offset + 8

    if (id === 'fmt ' && dataOff + 16 <= buf.length) {
      const numChannels = buf.readUInt16LE(dataOff + 2)
      const sampleRate  = buf.readUInt32LE(dataOff + 4)
      const bitDepth    = buf.readUInt16LE(dataOff + 14)
      const stereo      = numChannels >= 2
      const warnings    = []
      if (sampleRate !== 44100) warnings.push(`Sample rate ${sampleRate} Hz — P-1 requires 44100 Hz`)
      if (bitDepth  !== 16)     warnings.push(`Bit depth ${bitDepth}-bit — P-1 requires 16-bit`)
      return { stereo, sampleRate, bitDepth, numChannels, warnings }
    }

    const advance = 8 + chunkSize + (chunkSize & 1)
    if (advance <= 0) break
    offset += advance
  }
  return null
}

// ── SD card transfer (Node.js fs version) ─────────────────────────
function sanitizeName (s) {
  return (s || 'unnamed').replace(/[/\\:*?"<>|]/g, '_').slice(0, 31)
}

async function doTransfer (project, mixerStates, filePaths, sender) {
  const { filePaths: [root] = [] } = await dialog.showOpenDialog({
    title:       'Select SD card root folder',
    buttonLabel: 'Select',
    properties:  ['openDirectory'],
  })

  if (!root) throw new Error('Cancelled — no folder selected.')

  const listsDir = join(root, 'lists')
  await mkdir(listsDir, { recursive: true })
  await mkdir(join(root, 'update'), { recursive: true })

  const missing  = []
  const copied   = []
  const skipped  = []

  // ── Helper: write text only if content changed ───────────────────
  async function writeIfChanged (filePath, content) {
    try {
      const existing = readFileSync(filePath, 'utf-8')
      if (existing === content) return false
    } catch (_) {}
    await writeFile(filePath, content, 'utf-8')
    return true
  }

  // ── Helper: copy binary file, compare by SIZE not content ────────
  // Rationale: same-name backing tracks with edits will have different sizes.
  // Reading full file content for comparison is too slow for multi-GB sessions.
  async function copyIfSizeDiffers (srcPath, destPath, label) {
    try {
      const srcStat  = statSync(srcPath)
      try {
        const destStat = statSync(destPath)
        if (destStat.size === srcStat.size) {
          skipped.push(label)
          return false // same size — skip
        }
      } catch (_) {} // dest doesn't exist — will copy
      const bytes = await readFile(srcPath)
      await writeFile(destPath, bytes)
      copied.push(label)
      sender.send('transfer:progress', `  ✓ ${label}`)
      return true
    } catch (err) {
      sender.send('transfer:progress', `  ✗ ${label} — ${err.message}`)
      return false
    }
  }

  // ── Pre-flight: collect all required files and check what's missing
  // A file is "ok" if srcPath exists on disk, or if it's already on the SD card
  // with the correct size. Missing = srcPath absent AND not on SD card.
  const preflight = []
  for (const pl of project.playlists) {
    const songs  = project.songs.filter(s => s.playlistId === pl.id)
    const plName = sanitizeName(pl.name)
    for (const song of songs) {
      const sName   = sanitizeName(song.name)
      const songDir = join(listsDir, plName, sName)
      const slots   = song.audioSlots ?? []
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i]
        if (!sl?.fileName) continue
        const srcPath  = filePaths[`${song.id}_f${i}`]
        const destPath = join(songDir, `${sl.fileName}.wav`)
        const srcOk    = srcPath && existsSync(srcPath)
        const destOk   = existsSync(destPath)
        if (!srcOk && !destOk)
          preflight.push(`${song.name} — F${i + 1}: ${sl.fileName}.wav`)
        else if (!srcOk && destOk)
          preflight.push(`${song.name} — F${i + 1}: ${sl.fileName}.wav (on SD but not verified — relink recommended)`)
      }
      if (song.midiFile) {
        const srcPath  = filePaths[`${song.id}_midi`]
        const destPath = join(songDir, `${song.midiFile}.mid`)
        const srcOk    = srcPath && existsSync(srcPath)
        const destOk   = existsSync(destPath)
        if (!srcOk && !destOk)
          preflight.push(`${song.name} — MIDI: ${song.midiFile}.mid`)
      }
    }
  }

  const hardMissing = preflight.filter(p => !p.includes('relink recommended'))
  if (hardMissing.length > 0) {
    sender.send('transfer:progress', `⛔ Transfer aborted — ${hardMissing.length} file(s) missing from both cache and SD card. Use Scan & Relink first.`)
    return { missing: hardMissing, aborted: true }
  }

  // Warn about unverified files but continue
  const unverified = preflight.filter(p => p.includes('relink recommended'))
  if (unverified.length > 0) {
    sender.send('transfer:progress', `⚠ ${unverified.length} file(s) not in cache — will use existing SD card copy (not size-verified). Relink recommended.`)
  }

  // ── session.json ─────────────────────────────────────────────────
  const sessionUUID = project.sessionUUID || '00000000-0000-4000-8000-000000000000'
  await writeIfChanged(join(listsDir, 'session.json'),
    JSON.stringify({ id: sessionUUID, filePath: '', name: project.name || 'CIdoru Session', deviceImport: false }))

  const expectedPlFolders = new Set()

  for (const pl of project.playlists) {
    const songs  = project.songs.filter(s => s.playlistId === pl.id)
    const plName = sanitizeName(pl.name)
    expectedPlFolders.add(plName)
    const plDir  = join(listsDir, plName)
    await mkdir(plDir, { recursive: true })

    await writeIfChanged(join(plDir, 'setlist.json'),
      JSON.stringify({ id: pl.uuid || pl.id, songs: songs.map(s => s.uuid || s.id) }))

    const slTxtChanged = await writeIfChanged(join(plDir, `${plName}.txt`), generateSetlistFile(pl, songs, mixerStates))
    if (slTxtChanged) sender.send('transfer:progress', `✓ ${plName}.txt`)

    const expectedSongFolders = new Set()

    for (const song of songs) {
      const sName   = sanitizeName(song.name)
      expectedSongFolders.add(sName)
      const songDir = join(plDir, sName)
      await mkdir(songDir, { recursive: true })

      await writeIfChanged(join(songDir, 'song.json'),    JSON.stringify({ id: song.uuid || song.id }))
      await writeIfChanged(join(songDir, 'fileMap.json'), JSON.stringify(generateFileMap(song)))

      const sTxtChanged = await writeIfChanged(join(songDir, `${sName}.txt`), generateSongFile(song, mixerStates[song.id]))
      if (sTxtChanged) sender.send('transfer:progress', `  ✓ ${sName}.txt`)

      // WAV files
      const slots = song.audioSlots ?? []
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i]
        if (!sl?.fileName) continue
        const srcPath  = filePaths[`${song.id}_f${i}`]
        const destPath = join(songDir, `${sl.fileName}.wav`)
        if (srcPath && existsSync(srcPath)) {
          await copyIfSizeDiffers(srcPath, destPath, `${sl.fileName}.wav`)
        } else if (!existsSync(destPath)) {
          missing.push(`${song.name} — F${i + 1}: ${sl.fileName}.wav`)
          sender.send('transfer:progress', `  ⚠ ${sl.fileName}.wav — missing`)
        }
        // else: not in cache but exists on SD — leave as-is (warned in preflight)
      }

      // MIDI
      if (song.midiFile) {
        const srcPath  = filePaths[`${song.id}_midi`]
        const destPath = join(songDir, `${song.midiFile}.mid`)
        if (srcPath && existsSync(srcPath)) {
          await copyIfSizeDiffers(srcPath, destPath, `${song.midiFile}.mid`)
        } else if (!existsSync(destPath)) {
          missing.push(`${song.name} — MIDI: ${song.midiFile}.mid`)
          sender.send('transfer:progress', `  ⚠ ${song.midiFile}.mid — missing`)
        }
      }
    }

    // Delete removed song folders
    try {
        const existing = readdirSync(plDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
      for (const folder of existing) {
        if (!expectedSongFolders.has(folder)) {
          const { rm } = await import('fs/promises')
          await rm(join(plDir, folder), { recursive: true, force: true })
          sender.send('transfer:progress', `  🗑 deleted: ${folder}`)
        }
      }
    } catch (_) {}
  }

  // Delete removed playlist folders
  try {
    const existing = readdirSync(listsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    for (const folder of existing) {
      if (!expectedPlFolders.has(folder)) {
        const { rm } = await import('fs/promises')
        await rm(join(listsDir, folder), { recursive: true, force: true })
        sender.send('transfer:progress', `🗑 deleted playlist: ${folder}`)
      }
    }
  } catch (_) {}

  sender.send('transfer:progress', `\n── Summary ──────────────────────────────`)
  sender.send('transfer:progress', `  ✓ copied: ${copied.length} file(s)`)
  sender.send('transfer:progress', `  – skipped (unchanged): ${skipped.length} file(s)`)
  if (missing.length) sender.send('transfer:progress', `  ⚠ missing: ${missing.length} file(s)`)
  if (unverified.length) sender.send('transfer:progress', `  ⚠ unverified on SD: ${unverified.length} file(s)`)

  return { missing, copied: copied.length, skipped: skipped.length, aborted: false }
}

// ── File generators (Node.js versions — duplicated from renderer) ──
function dbToNorm (db, min = -60, max = 10) {
  if (db <= min) return 0
  if (db >= max) return 1
  return (db - min) / (max - min)
}

function generateSongFile (song, state) {
  const mat  = (state?.matrix?.length === 7) ? state.matrix : Array.from({ length: 7 }, () => Array(7).fill(0))
  const lf   = state?.leftMutes  ?? Array(7).fill(false)
  const mod  = state?.modifierDb ?? 0
  const slots = song?.audioSlots ?? []
  const CRLF = '\r\n'

  const atEnd = { queue_next: 'QueueNext', play_next: 'PlayNext', loop: 'Loop' }[song.queueBehavior] ?? 'QueueNext'
  const IN_KEYS  = ['F1','F2','F3','F4','F5','F6','AN']
  const SECTIONS = ['HeadPhone','Output1','Output2','Output3','Output4','Output5','Output6']

  let txt = 'Global sets' + CRLF
  txt += `Level- ${Math.round(mod)}` + CRLF
  txt += `BPM- ${song.bpm ?? 120}` + CRLF
  txt += `AtEnd- ${atEnd}` + CRLF + CRLF

  txt += 'Input Files' + CRLF
  for (let i = 0; i < 6; i++) {
    const sl        = slots[i] ?? {}
    const shortName = sl.shortName || `F${i+1}`
    const fileName  = sl.fileName  || ''
    txt += `F${i+1}- "${shortName}" "${fileName}"` + CRLF
  }
  txt += `MIDI- ${song.midiFile ? `"${song.midiFile}"` : ''}` + CRLF + CRLF

  SECTIONS.forEach((section, colIdx) => {
    txt += section + CRLF
    for (let inIdx = 0; inIdx < 7; inIdx++) {
      const level = mat[inIdx][colIdx]
      const mute  = lf[inIdx] ? ' MUTE' : ''
      txt += `IN${inIdx+1}- ${IN_KEYS[inIdx]} ${level}${mute}` + CRLF
    }
    txt += CRLF
  })
  return txt
}

function generateFileMap (song) {
  const map   = {}
  const slots = song?.audioSlots ?? []
  for (const sl of slots) {
    if (sl?.fileName && sl?.fileUUID) map[sl.fileUUID] = `${sl.fileName}.wav`
  }
  if (song?.midiFile && song?.midiFileUUID) map[song.midiFileUUID] = `${song.midiFile}.mid`
  return map
}

function generateSetlistFile (playlist, songs, mixerStates) {
  const first = songs.length > 0 ? (mixerStates[songs[0].id] ?? {}) : {}
  const rf    = first.rightFaders ?? Array(7).fill({ db: 0 })
  const lp    = first.linkedPairs ?? [false, false, false]
  const lvl   = (i) => Math.round(dbToNorm(rf[i]?.db ?? 0) * 100)
  const links = lp.map((on, i) => on ? `${i * 2 + 1}-${i * 2 + 2}` : null).filter(Boolean).join(' ')
  const CRLF  = '\r\n'

  let txt = 'SetList file' + CRLF + CRLF
  txt += 'Global sets' + CRLF
  if (links) txt += `StereoLinks- ${links}` + CRLF
  txt += `HeadPhone- ${lvl(6)}` + CRLF
  for (let i = 0; i < 6; i++) txt += `Output${i+1}- ${lvl(i)}` + CRLF
  txt += CRLF + 'Songs' + CRLF
  songs.forEach(s => { txt += `"${s.name}"` + CRLF })
  txt += CRLF
  return txt
}

// ── Window ────────────────────────────────────────────────────────
let mainWindow

function createWindow () {
  mainWindow = new BrowserWindow({
    width:  1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'CIdoru',
    backgroundColor: '#07080d',
    show: false,
    webPreferences: {
      preload:         join(__dirname, '../preload/preload.mjs'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,
    },
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow.maximize()
    mainWindow.show()
  })

  // Dev: load Vite dev server; Prod: load built index.html
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // ── Auto-updater ──────────────────────────────────────────────
  // Only run in packaged app (not dev mode)
  if (app.isPackaged) {
    autoUpdater.autoDownload    = true   // download silently in background
    autoUpdater.autoInstallOnAppQuit = false // we prompt the user

    autoUpdater.on('update-available', (info) => {
      mainWindow?.webContents.send('updater:update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
      })
    })

    autoUpdater.on('download-progress', (progress) => {
      mainWindow?.webContents.send('updater:download-progress', Math.round(progress.percent))
    })

    autoUpdater.on('update-downloaded', (info) => {
      mainWindow?.webContents.send('updater:update-downloaded', { version: info.version })
    })

    autoUpdater.on('error', (err) => {
      // Silent — don't bother the user with update check failures
      console.error('Auto-updater error:', err.message)
    })

    // Check silently 3s after window shows (non-blocking)
    setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}) }, 3000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── IPC Handlers ──────────────────────────────────────────────────

// Updater — install downloaded update immediately
ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall(false, true) // silent=false, forceRunAfter=true
})

// Provide userData path synchronously (used by preload)
ipcMain.on('get-user-data-path', (e) => {
  e.returnValue = userData()
})

// Session
ipcMain.handle('session:save', async (_, data) => {
  try {
    writeFileSync(sessionPath(), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch { return false }
})

ipcMain.handle('session:load', async () => {
  try {
    const raw = readFileSync(sessionPath(), 'utf-8')
    return JSON.parse(raw)
  } catch { return null }
})

// File path cache — persisted so Electron remembers paths between launches
ipcMain.handle('filecache:save', async (_, cacheObj) => {
  try { writeFileSync(fileCachePath(), JSON.stringify(cacheObj), 'utf-8'); return true }
  catch { return false }
})

ipcMain.handle('filecache:load', async () => {
  try { return JSON.parse(readFileSync(fileCachePath(), 'utf-8')) }
  catch { return null }
})

// Recursive folder scan — returns { nameNoExt: absolutePath } for all WAV/MIDI found
ipcMain.handle('scan:folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:      'Select folder to scan for audio files',
    buttonLabel:'Scan this folder',
    properties: ['openDirectory'],
  })
  if (canceled || !filePaths[0]) return null

  const result = {}

  function walk (dir) {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        if (/\.(wav|mid|midi)$/i.test(entry.name)) {
          const nameNoExt = entry.name.replace(/\.(wav|mid|midi)$/i, '')
          if (!result[nameNoExt]) result[nameNoExt] = full
        }
      }
    }
  }

  walk(filePaths[0])
  return result
})

// Presets
ipcMain.handle('presets:save', async (_, data) => {
  try {
    writeFileSync(presetsPath(), JSON.stringify(data, null, 2), 'utf-8')
    return true
  } catch { return false }
})

// File picking — WAV
ipcMain.handle('pick:wav', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Select WAV file',
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null

  const filePath  = filePaths[0]
  const name      = basename(filePath)
  const nameNoExt = name.replace(/\.wav$/i, '')

  try {
    const buf  = readFileSync(filePath).slice(0, 2048)
    const info = readWavInfoNode(buf)
    return {
      filePath, nameNoExt,
      stereo:     info?.stereo     ?? false,
      sampleRate: info?.sampleRate ?? 0,
      bitDepth:   info?.bitDepth   ?? 0,
      warnings:   info?.warnings   ?? [],
    }
  } catch {
    return { filePath, nameNoExt, stereo: false, sampleRate: 0, bitDepth: 0, warnings: [] }
  }
})

// File picking — MIDI
ipcMain.handle('pick:midi', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Select MIDI file',
    filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  const filePath  = filePaths[0]
  const nameNoExt = basename(filePath).replace(/\.midi?$/i, '')
  return { filePath, nameNoExt }
})

// File picking — generic relink (wav or midi)
ipcMain.handle('pick:relink', async (_, isMidi) => {
  const filters = isMidi
    ? [{ name: 'MIDI', extensions: ['mid', 'midi'] }]
    : [{ name: 'WAV Audio', extensions: ['wav'] }]
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: isMidi ? 'Relink MIDI file' : 'Relink WAV file',
    filters, properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  const filePath  = filePaths[0]
  const nameNoExt = basename(filePath).replace(/\.(wav|midi?)$/i, '')
  if (!isMidi) {
    try {
      const buf  = readFileSync(filePath).slice(0, 2048)
      const info = readWavInfoNode(buf)
      return { filePath, nameNoExt, stereo: info?.stereo ?? false, warnings: info?.warnings ?? [] }
    } catch { return { filePath, nameNoExt, stereo: false, warnings: [] } }
  }
  return { filePath, nameNoExt }
})

// Scan — check if cached paths still exist on disk
ipcMain.handle('scan:verify', async (_, filePaths) => {
  // filePaths: { [cacheKey]: path }
  const results = {}
  for (const [key, p] of Object.entries(filePaths)) {
    results[key] = existsSync(p)
  }
  return results
})

// Transfer
ipcMain.handle('transfer:start', async (event, project, mixerStates, filePaths) => {
  try {
    const result = await doTransfer(project, mixerStates, filePaths, event.sender)
    return { ok: !result.aborted, ...result }
  } catch (err) {
    return { ok: false, error: err.message, missing: [], aborted: false }
  }
})

// Export JSON — native save dialog
ipcMain.handle('export:json', async (_, jsonStr) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title:       'Export Session',
    defaultPath: `idoru-session-${Date.now()}.json`,
    filters:     [{ name: 'JSON', extensions: ['json'] }],
  })
  if (canceled || !filePath) return false
  try {
    writeFileSync(filePath, jsonStr, 'utf-8')
    return true
  } catch { return false }
})

// Import JSON — native open dialog
ipcMain.handle('import:json', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Import Session',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  try {
    return readFileSync(filePaths[0], 'utf-8')
  } catch { return null }
})

// Import .idoru — native open dialog, returns raw file content
ipcMain.handle('import:idoru', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Import from Idoru session (.idoru)',
    filters: [{ name: 'Idoru Session', extensions: ['idoru'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  try {
    return readFileSync(filePaths[0], 'utf-8')
  } catch { return null }
})

// Audio preview — read file into buffer for Web Audio API decoding
ipcMain.handle('audio:readBuffer', async (_, filePath) => {
  try {
    if (!filePath || typeof filePath !== 'string') return null
    if (!existsSync(filePath)) return null
    // Return Buffer directly — Electron IPC serializes it as Uint8Array (zero-copy path)
    // Array.from(buf) would serialize 100MB WAV as 100M JSON numbers — catastrophically slow
    return await readFile(filePath)
  } catch { return null }
})

// ── Firmware ──────────────────────────────────────────────────────
const firmwareCachePath = () => join(userData(), 'firmware-cache.json')
const firmwareBinDir    = () => join(userData(), 'firmware')

function readFirmwareCache () {
  try { return JSON.parse(readFileSync(firmwareCachePath(), 'utf-8')) }
  catch { return null }
}

function writeFirmwareCache (data) {
  try { writeFileSync(firmwareCachePath(), JSON.stringify(data, null, 2), 'utf-8') }
  catch {}
}

// Parse version string from filename like "ver03_17.bin" → "3.17"
function parseFirmwareVersion (filename) {
  const m = filename.match(/ver(\d+)_(\d+)(?:_(\d+))?\.bin/i)
  if (!m) return null
  return m[3] ? `${parseInt(m[1])}.${parseInt(m[2])}.${parseInt(m[3])}`
              : `${parseInt(m[1])}.${parseInt(m[2])}`
}

// Compare version strings like "3.17" > "3.16"
function versionGt (a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0, nb = pb[i] ?? 0
    if (na !== nb) return na > nb
  }
  return false
}

async function httpFetch (url, method = 'GET') {
  const https = await import('https')
  const http  = await import('http')
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https.default ?? https : http.default ?? http
    const req = mod.request(url, { method, headers: { 'User-Agent': 'CIdoru/1.4' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://idoru.live${res.headers.location}`
        httpFetch(loc, method).then(resolve).catch(reject)
        return
      }
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.on('error', reject)
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })
}

// Strategy 1: scrape downloads page for known URL pattern
// Strategy 2: probe HEAD requests on incrementing versions
ipcMain.handle('firmware:check', async () => {
  const BASE = 'https://idoru.live/downloads/firmware/'
  const firmwares = []

  // ── Strategy 1: scrape the downloads page ────────────────────────
  try {
    const res = await httpFetch('https://idoru.live/downloads')
    if (res.status === 200) {
      const re = /(?:href|src)=["']([^"']*\/firmware\/ver\d+_\d+(?:_\d+)?\.bin)[^"']*["']/gi
      for (const m of res.body.matchAll(re)) {
        let url = m[1]
        if (!url.startsWith('http')) url = 'https://idoru.live' + url
        const filename = url.split('/').pop()
        const version  = parseFirmwareVersion(filename)
        if (version && !firmwares.find(f => f.version === version)) {
          firmwares.push({ url, filename, version })
        }
      }
    }
  } catch (_) {}

  // ── Strategy 2: probe HEAD on incrementing versions ───────────────
  // Find candidates by probing versions around any we already found,
  // or starting from a reasonable baseline if we found nothing.
  // We probe up to 10 minor versions ahead of the highest known.
  const knownHigh = firmwares.length > 0
    ? firmwares.reduce((best, f) => versionGt(f.version, best) ? f.version : best, firmwares[0].version)
    : null

  // Parse baseline: if we know ver3.17 was latest before, start probing from there
  let probeStart = knownHigh ? knownHigh.split('.').map(Number) : [0, 1]

  const probed = new Set(firmwares.map(f => f.version))

  // Probe 15 minor versions ahead, check if they exist
  const probePromises = []
  for (let offset = 0; offset <= 15; offset++) {
    const minor = probeStart[1] + offset
    const major = probeStart[0]
    const pad   = (n) => n.toString().padStart(2, '0')
    const filename = `ver${pad(major)}_${pad(minor)}.bin`
    const url      = BASE + filename
    const version  = parseFirmwareVersion(filename)
    if (version && !probed.has(version)) {
      probed.add(version)
      probePromises.push(
        httpFetch(url, 'HEAD')
          .then(res => res.status === 200 ? { url, filename, version } : null)
          .catch(() => null)
      )
    }
  }

  const probeResults = await Promise.all(probePromises)
  for (const r of probeResults) {
    if (r) firmwares.push(r)
  }

  // Sort descending by version, return highest first
  firmwares.sort((a, b) => versionGt(a.version, b.version) ? -1 : 1)

  if (firmwares.length === 0) {
    return { found: false, error: 'No firmware files found. Check idoru.live/downloads manually.' }
  }

  return { found: true, firmwares }
})

// Download a firmware .bin to local cache
ipcMain.handle('firmware:download', async (event, url, version) => {
  try { mkdirSync(firmwareBinDir(), { recursive: true }) } catch {}

  const filename = url.split('/').pop()
  const destPath = join(firmwareBinDir(), filename)

  const https = await import('https')
  const http  = await import('http')

  const downloadStream = (url, dest) => new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https.default ?? https : http.default ?? http
    const req = mod.request(url, { headers: { 'User-Agent': 'CIdoru/1.4' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://idoru.live${res.headers.location}`
        downloadStream(loc, dest).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return }

      const total = parseInt(res.headers['content-length'] || '0', 10)
      let received = 0
      const chunks = []

      res.on('data', chunk => {
        chunks.push(chunk)
        received += chunk.length
        if (total > 0) event.sender.send('firmware:progress', Math.round(received / total * 100))
      })
      res.on('end', () => {
        writeFileSync(dest, Buffer.concat(chunks))
        resolve(dest)
      })
    })
    req.on('error', reject)
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')) })
    req.end()
  })

  try {
    await downloadStream(url, destPath)
    const cache = { version, filename, path: destPath, downloadedAt: new Date().toISOString(), url }
    writeFirmwareCache(cache)
    return { ok: true, path: destPath, version }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})

// Pick an already-downloaded .bin from disk manually
ipcMain.handle('firmware:pick', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title:   'Select Firmware .bin file',
    filters: [{ name: 'Firmware', extensions: ['bin'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return null
  const name    = basename(filePaths[0])
  const verMatch = name.match(/(\d+\.\d+(?:\.\d+)?)/)
  const version  = verMatch ? verMatch[1] : 'unknown'
  const cache    = { version, path: filePaths[0], downloadedAt: new Date().toISOString(), manual: true }
  writeFirmwareCache(cache)
  return cache
})

// Get currently cached firmware info
ipcMain.handle('firmware:getCached', async () => {
  const cache = readFirmwareCache()
  if (!cache) return null
  // Verify file still exists
  if (!existsSync(cache.path)) { writeFirmwareCache(null); return null }
  return cache
})

// Clear cached firmware
ipcMain.handle('firmware:clearCache', async () => {
  try { writeFileSync(firmwareCachePath(), JSON.stringify(null), 'utf-8') } catch {}
  return true
})

// Open Manual
ipcMain.handle('open:manual', async () => {
  const devPath  = join(__dirname, '../../public/MANUAL.html')
  const prodPath = join(process.resourcesPath, 'public/MANUAL.html')
  const manualPath = existsSync(devPath) ? devPath : prodPath
  if (existsSync(manualPath)) await shell.openPath(manualPath)
  else await shell.openExternal('https://idoru.live')
  return true
})

// Open downloads page in default browser
ipcMain.handle('firmware:openPage', async () => {
  await shell.openExternal('https://idoru.live/downloads')
  return true
})

// Pick SD card root folder for firmware writing
ipcMain.handle('firmware:pickSdRoot', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title:      'Select SD card root folder',
    buttonLabel:'Select SD card root',
    properties: ['openDirectory'],
  })
  if (canceled || !filePaths[0]) return null
  return filePaths[0]
})

// Write firmware to SD card update/ folder (called separately from main transfer)
ipcMain.handle('firmware:writeToSd', async (_, sdRootPath, firmwarePath) => {
  try {
    const updateDir = join(sdRootPath, 'update')
    mkdirSync(updateDir, { recursive: true })

    // Clear any existing files in update/ (P-1 requires only one .bin)
    const { readdirSync, unlinkSync } = await import('fs')
    const existing = readdirSync(updateDir)
    for (const f of existing) {
      try { unlinkSync(join(updateDir, f)) } catch {}
    }

    const bytes = readFileSync(firmwarePath)
    const destName = basename(firmwarePath)
    writeFileSync(join(updateDir, destName), bytes)
    return { ok: true, path: join(updateDir, destName) }
  } catch (err) {
    return { ok: false, error: err.message }
  }
})
