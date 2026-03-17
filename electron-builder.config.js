/**
 * electron-builder configuration
 * Build targets: Windows (NSIS installer) + Linux (AppImage)
 *
 * Build commands:
 *   npm run build:win    → release/CIdoru Setup 1.0.0.exe
 *   npm run build:linux  → release/CIdoru-1.0.0.AppImage
 *   npm run build:all    → both (requires Linux host or CI)
 */

module.exports = {
  appId:       'com.cidoru.app',
  productName: 'CIdoru',
  copyright:   'Copyright © 2025 CIdoru',

  directories: {
    buildResources: 'resources',
    output:         'release',
  },

  // Files to include in the package
  files: [
    'out/**',         // electron-vite output (main, preload, renderer)
    'public/**',      // MANUAL.html and other static assets
    '!node_modules',
    '!src',
    '!electron',
  ],

  extraResources: [
    { from: 'public', to: 'public', filter: ['**/*'] },
  ],

  // ── Windows ───────────────────────────────────────────────────
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
    ],
    icon: 'resources/icon.ico',
    // No code signing configured — same as original Idoru app.
    // Windows will show an "Unknown Publisher" warning on first run.
  },

  nsis: {
    oneClick:                      false,
    allowToChangeInstallationDirectory: true,
    installerIcon:    'resources/icon.ico',
    uninstallerIcon:  'resources/icon.ico',
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName:     'CIdoru',
  },

  // ── Linux ─────────────────────────────────────────────────────
  linux: {
    target: [
      { target: 'AppImage', arch: ['x64'] },
    ],
    icon:     'resources/icon.png',   // 512×512 PNG
    category: 'Audio',
    synopsis: 'Alternative companion app for IDORU P-1',
    description: 'CIdoru — alternative companion application for the IDORU P-1 multi-track player',
  },
}
