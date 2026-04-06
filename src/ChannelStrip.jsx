import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import "./ChannelStrip.css";
import { APP_VERSION } from "./version.js";
import * as platform from "./platform.js";

// ═══════════════════════════════════════════════════════════════════
//  CONFIGS
// ═══════════════════════════════════════════════════════════════════
export const CONFIG = {
  FADER_TRACK_HEIGHT: 360, RIDER_HEIGHT: 52, RIDER_WIDTH: 32,
  DB_MIN: -60, DB_MAX: 10, UNITY_GAIN_DB: 0, FADER_TAPER: 1.0,
  SCALE_MARKS: [10, 5, 0, -5, -10, -20, -30, -40, -60], VU_DECAY_MS: 80,
};

// Left bank when routing mode active — linear 0-100
const ROUTING_CFG = {
  FADER_TRACK_HEIGHT: 360,
  RIDER_HEIGHT: 52, RIDER_WIDTH: 32,
  DB_MIN: 0, DB_MAX: 100, UNITY_GAIN_DB: 90, FADER_TAPER: 1.0,
  SCALE_MARKS: [100, 90, 75, 50, 25, 0], VU_DECAY_MS: 80,
};

export const MODIFIER_CONFIG = { DB_MIN: -20, DB_MAX: 20, DEFAULT_DB: 0 };

export const IDORU_SCENE_CONFIG = {
  leftBank: {
    bankId: "INPUT BANK", title: "AUDIO FILES",
    channels: [
      { label: "AF 01", initialDb: 0 }, { label: "AF 02", initialDb: 0 },
      { label: "AF 03", initialDb: 0 }, { label: "AF 04", initialDb: 0 },
      { label: "AF 05", initialDb: 0 }, { label: "AF 06", initialDb: 0 },
      { label: "AUX IN", initialDb: 0 },
    ],
  },
  rightBank: {
    bankId: "OUTPUT BANK", title: "HW OUTPUTS",
    channels: [
      { label: "OUT 1", initialDb: 0 }, { label: "OUT 2", initialDb: 0 },
      { label: "OUT 3", initialDb: 0 }, { label: "OUT 4", initialDb: 0 },
      { label: "OUT 5", initialDb: 0 }, { label: "OUT 6", initialDb: 0 },
      { label: "PHONES", initialDb: -6 },
    ],
    modifier: { label: "M.TRIM", initialDb: 0 },
  },
};

// ═══════════════════════════════════════════════════════════════════
//  MATRIX LAYOUT
//
//  matrix[inIdx][colIdx]  — level 0-100
//
//  Inputs (rows 0-6):
//    0-5 → F1-F6 (audio file slots)
//    6   → AUX IN
//
//  Outputs (cols 0-6):
//    0   → HeadPhone
//    1-6 → Output1-Output6
//
//  Right bank strip → matrix column:
//    strip 0 (OUT 1)  → col 1
//    strip 1 (OUT 2)  → col 2
//    ...
//    strip 5 (OUT 6)  → col 6
//    strip 6 (PHONES) → col 0
// ═══════════════════════════════════════════════════════════════════
const RIGHT_TO_COL  = [1, 2, 3, 4, 5, 6, 0];
const COL_LABEL     = ["HP", "OUT1", "OUT2", "OUT3", "OUT4", "OUT5", "OUT6"];

const defaultMatrix = () => Array.from({ length: 7 }, () => Array(7).fill(0));

// ═══════════════════════════════════════════════════════════════════
//  CONNECTION COUNTER
//  Rules (from manual):
//    mono→mono output            = 1 connection
//    mono→HP or mono→linked pair = 2 connections
//    stereo source→any           = 2 connections
//    muted source                = 0 connections
// ═══════════════════════════════════════════════════════════════════
function countConnections(matrix, audioSlots, linkedPairs, leftMutes) {
  let total = 0;
  for (let inIdx = 0; inIdx < 7; inIdx++) {
    if (leftMutes?.[inIdx]) continue;
    const isStereoSrc = inIdx < 6 ? (audioSlots?.[inIdx]?.stereo ?? false) : false;
    for (let colIdx = 0; colIdx < 7; colIdx++) {
      if ((matrix?.[inIdx]?.[colIdx] ?? 0) <= 0) continue;
      // For linked pairs only count the even strip (first of pair) to avoid double-counting
      const rightIdx = RIGHT_TO_COL.indexOf(colIdx);
      if (rightIdx >= 0 && rightIdx < 6) {
        const pairIdx = Math.floor(rightIdx / 2);
        if (linkedPairs?.[pairIdx] && rightIdx % 2 === 1) continue; // skip odd strip of linked pair
      }
      const isHP      = colIdx === 0;
      const rIdx      = RIGHT_TO_COL.indexOf(colIdx);
      const pIdx      = rIdx >= 0 && rIdx < 6 ? Math.floor(rIdx / 2) : -1;
      const isLinked  = pIdx >= 0 && (linkedPairs?.[pIdx] ?? false);
      const usesTwoConn = isStereoSrc || isHP || isLinked;
      total += usesTwoConn ? 2 : 1;
    }
  }
  return total;
}

// ═══════════════════════════════════════════════════════════════════
//  WAV HEADER READER
//
//  WAV is a RIFF container — chunks can appear in any order.
//  Many tools insert JUNK/PAD/bext chunks before "fmt ", so reading
//  at a hardcoded byte offset returns 0 for many real-world files.
//  We scan the chunk list and find "fmt " by its 4-byte ID.
//
//  RIFF layout:
//    0-3   "RIFF" | "RF64"
//    4-7   file size - 8 (uint32 LE)
//    8-11  "WAVE"
//    12+   repeated: [4-byte ID][uint32 LE size][data bytes][pad if odd]
//
//  fmt chunk data (PCM, AudioFormat=1):
//    +0   AudioFormat   uint16
//    +2   NumChannels   uint16
//    +4   SampleRate    uint32
//    +8   ByteRate      uint32
//    +12  BlockAlign    uint16
//    +14  BitsPerSample uint16
//
//  Returns { stereo, sampleRate, bitDepth, numChannels, warnings[] }
//  Returns null if file is not a valid WAV or fmt not found.
// ═══════════════════════════════════════════════════════════════════
async function readWavInfo(file) {
  try {
    const SCAN_BYTES = 2048;
    const buf  = await file.slice(0, SCAN_BYTES).arrayBuffer();
    const view = new DataView(buf);
    const len  = buf.byteLength;

    const fourCC = (off) =>
      String.fromCharCode(view.getUint8(off),   view.getUint8(off+1),
                          view.getUint8(off+2), view.getUint8(off+3));

    if (fourCC(0) !== "RIFF" && fourCC(0) !== "RF64") return null;
    if (fourCC(8) !== "WAVE") return null;

    let offset = 12;
    while (offset + 8 <= len) {
      const id        = fourCC(offset);
      const chunkSize = view.getUint32(offset + 4, true);
      const dataOff   = offset + 8;

      if (id === "fmt " && dataOff + 16 <= len) {
        const numChannels = view.getUint16(dataOff + 2,  true);
        const sampleRate  = view.getUint32(dataOff + 4,  true);
        const bitDepth    = view.getUint16(dataOff + 14, true);

        const stereo   = numChannels >= 2;
        const warnings = [];
        if (sampleRate !== 44100)
          warnings.push(`Sample rate ${sampleRate} Hz — P-1 requires 44100 Hz`);
        if (bitDepth !== 16)
          warnings.push(`Bit depth ${bitDepth}-bit — P-1 requires 16-bit`);

        return { stereo, sampleRate, bitDepth, numChannels, warnings };
      }

      const advance = 8 + chunkSize + (chunkSize & 1);
      if (advance <= 0) break;
      offset += advance;
    }
    return null;
  } catch { return null; }
}
// Register browser WAV reader with platform adapter
platform.setPlatformWavReader(readWavInfo);

// ═══════════════════════════════════════════════════════════════════
//  P-1 NAME VALIDATION
//  Allowed: a-z, A-Z, 0-9, space, and: ! @ # $ % ^ _ = + - & ( )
//  Max 32 characters.
//  Returns { valid: bool, error: string | null }
// ═══════════════════════════════════════════════════════════════════
const P1_NAME_RE = /^[a-zA-Z0-9 !@#$%^_=+\-&()]{1,32}$/;
const P1_ALLOWED_CHARS = "a-z  A-Z  0-9  ! @ # $ % ^ _ = + - & ( )";

export function validateP1Name(s) {
  if (!s || s.trim().length === 0) return { valid: false, error: "Name cannot be empty" };
  if (s.length > 32) return { valid: false, error: "Max 32 characters" };
  if (!P1_NAME_RE.test(s)) {
    const bad = [...new Set(s.split("").filter(c => !/[a-zA-Z0-9 !@#$%^_=+\-&()]/.test(c)))];
    return { valid: false, error: `Invalid character(s): ${bad.map(c => `"${c}"`).join(" ")}` };
  }
  return { valid: true, error: null };
}

// ═══════════════════════════════════════════════════════════════════
//  P-1 FILE GENERATION
// ═══════════════════════════════════════════════════════════════════
function sanitizeName(s) {
  return (s || "unnamed").replace(/[/\\:*?"<>|]/g, "_").slice(0, 31);
}

// Right bank dB fader → 0-100 P-1 level
function dbToFileLevel(db, cfg = CONFIG) {
  return Math.round(dbToNorm(db, cfg) * 100);
}

export function generateSongFile(song, state) {
  const mat   = (state?.matrix?.length === 7) ? state.matrix : defaultMatrix();
  const lf    = state?.leftMutes ?? Array(7).fill(false);
  const mod   = state?.modifierDb ?? 0;
  const slots = song?.audioSlots ?? defaultAudioSlots();

  const atEnd = song?.queueBehavior === "loop"      ? "Loop"
    :           song?.queueBehavior === "play_next"  ? "PlayNext"
    :                                                  "QueueNext";

  const IN_KEYS = ["F1","F2","F3","F4","F5","F6","AN"];
  const SECTIONS = ["HeadPhone","Output1","Output2","Output3","Output4","Output5","Output6"];
  const CRLF = "\r\n";

  let txt = "Global sets" + CRLF;
  txt += `Level- ${Math.round(mod)}` + CRLF;
  txt += `BPM- ${song?.bpm ?? 120}` + CRLF;
  txt += `AtEnd- ${atEnd}` + CRLF + CRLF;

  txt += "Input Files" + CRLF;
  // All 6 slots always written — empty string if no file assigned
  for (let i = 0; i < 6; i++) {
    const sl        = slots[i] ?? {};
    const shortName = sl.shortName || `F${i+1}`;
    const fileName  = sl.fileName  || "";
    txt += `F${i+1}- "${shortName}" "${fileName}"` + CRLF;
  }
  txt += `MIDI- ${song?.midiFile ? `"${song.midiFile}"` : ""}` + CRLF + CRLF;

  SECTIONS.forEach((section, colIdx) => {
    txt += section + CRLF;
    for (let inIdx = 0; inIdx < 7; inIdx++) {
      const level = mat[inIdx][colIdx];
      const mute  = lf[inIdx] ? " MUTE" : "";
      txt += `IN${inIdx+1}- ${IN_KEYS[inIdx]} ${level}${mute}` + CRLF;
    }
    txt += CRLF;
  });
  return txt;
}

// Generate fileMap.json — maps stable file UUIDs to filenames
// UUIDs are stored in audioSlots as sl.fileUUID and midiFileUUID on the song
export function generateFileMap(song) {
  const map = {};
  const slots = song?.audioSlots ?? [];
  for (const sl of slots) {
    if (sl?.fileName && sl?.fileUUID) map[sl.fileUUID] = `${sl.fileName}.wav`;
  }
  if (song?.midiFile && song?.midiFileUUID) map[song.midiFileUUID] = `${song.midiFile}.mid`;
  return map;
}

export function generateSetlistFile(playlist, songs, mixerStates) {
  const first = songs.length > 0 ? (mixerStates[songs[0].id] ?? {}) : {};
  const rf  = first.rightFaders ?? IDORU_SCENE_CONFIG.rightBank.channels.map(c => ({ db: c.initialDb ?? 0 }));
  const lp  = first.linkedPairs ?? [false, false, false];

  const links = lp.map((on, i) => on ? `${i*2+1}-${i*2+2}` : null).filter(Boolean).join(" ");
  const lvl = (i) => dbToFileLevel(rf[i]?.db ?? 0);
  const CRLF = "\r\n";

  let txt = "SetList file" + CRLF + CRLF;
  txt += "Global sets" + CRLF;
  if (links) txt += `StereoLinks- ${links}` + CRLF;
  txt += `HeadPhone- ${lvl(6)}` + CRLF;
  for (let i = 0; i < 6; i++) txt += `Output${i+1}- ${lvl(i)}` + CRLF;
  txt += CRLF + "Songs" + CRLF;
  songs.forEach(s => { txt += `"${s.name}"` + CRLF; });
  txt += CRLF;
  return txt;
}

// ═══════════════════════════════════════════════════════════════════
//  SD CARD TRANSFER
// ═══════════════════════════════════════════════════════════════════
// SD CARD TRANSFER moved to platform.js
export const transferToSdCard = null;

// ═══════════════════════════════════════════════════════════════════
//  PROJECT STORAGE
// ═══════════════════════════════════════════════════════════════════
const STORAGE_KEY = "idoru-p1-project";
const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function genUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

export function defaultAudioSlots() {
  return Array.from({ length: 6 }, () => ({ shortName: "", fileName: "", stereo: false }));
}

function emptyProject() { return { playlists: [], songs: [], mixerStates: {} }; }
// Storage delegated to platform.js (localStorage in web, file in Electron)
const readStorage  = () => platform.getInitialSession();

// ── Presets — delegated to platform.js ───────────────────────────
const PRESET_KEY   = "idoru-p1-presets"; // kept for reference only
const readPresets  = () => platform.getInitialPresets();

// ═══════════════════════════════════════════════════════════════════
//  dB MATH
// ═══════════════════════════════════════════════════════════════════
export function dbToNorm(db, cfg = CONFIG) {
  if (db <= cfg.DB_MIN) return 0;
  if (db >= cfg.DB_MAX) return 1;
  return Math.pow((db - cfg.DB_MIN) / (cfg.DB_MAX - cfg.DB_MIN), 1 / cfg.FADER_TAPER);
}
export function normToDb(norm, cfg = CONFIG) {
  return cfg.DB_MIN + Math.pow(Math.max(0, Math.min(1, norm)), cfg.FADER_TAPER) * (cfg.DB_MAX - cfg.DB_MIN);
}
function normToPixel(norm, cfg = CONFIG) {
  return (cfg.FADER_TRACK_HEIGHT - cfg.RIDER_HEIGHT) * (1 - norm);
}
function modDbToNorm(db, mc = MODIFIER_CONFIG) {
  return (db - mc.DB_MIN) / (mc.DB_MAX - mc.DB_MIN);
}
function fmt(db) { return db > 0 ? `+${db.toFixed(1)}` : db.toFixed(1); }

// ═══════════════════════════════════════════════════════════════════
//  HOOKS
// ═══════════════════════════════════════════════════════════════════
function useEditableText(initial) {
  const [text, setText]     = useState(initial);
  const [editing, setEdit]  = useState(false);
  const [draft, setDraft]   = useState("");
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const open      = ()  => { setDraft(text); setEdit(true); };
  const cancel    = ()  => setEdit(false);
  const commit    = (v) => { const t = (v ?? draft).trim(); if (t) setText(t); setEdit(false); };
  const onKeyDown = (e) => { if (e.key === "Enter") commit(draft); if (e.key === "Escape") cancel(); };
  return { text, setText, editing, draft, setDraft, inputRef, open, commit, cancel, onKeyDown };
}

function useEditableDb(dbMin, dbMax, onCommit) {
  const [editing, setEdit] = useState(false);
  const [draft, setDraft]  = useState("");
  const inputRef = useRef(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  const open      = (cur)  => { setDraft(cur <= dbMin ? String(dbMin) : cur.toFixed(1)); setEdit(true); };
  const cancel    = ()     => setEdit(false);
  const commit    = (v)    => {
    const p = parseFloat((v ?? draft).replace(",", "."));
    if (!isNaN(p)) onCommit(Math.max(dbMin, Math.min(dbMax, p)));
    setEdit(false);
  };
  const onKeyDown = (e) => { if (e.key === "Enter") commit(draft); if (e.key === "Escape") cancel(); };
  return { editing, draft, setDraft, inputRef, open, commit, cancel, onKeyDown };
}

// ═══════════════════════════════════════════════════════════════════
//  ScaleMark
// ═══════════════════════════════════════════════════════════════════
function ScaleMark({ db, cfg }) {
  const top     = normToPixel(dbToNorm(db, cfg), cfg) + cfg.RIDER_HEIGHT / 2 - 4;
  const isUnity = db === cfg.UNITY_GAIN_DB;
  const isPos   = db > 0 && cfg.DB_MAX <= 10;
  const label   = cfg.DB_MAX === 100
    ? String(db)
    : (db > 0 ? `+${db}` : db === cfg.DB_MIN ? "-∞" : String(db));
  return (
    <div className="scale-mark" style={{ top }}>
      <span className={`scale-label${isUnity ? " scale-label--unity" : isPos ? " scale-label--pos" : ""}`}>{label}</span>
      <div className={`scale-tick${isUnity ? " scale-tick--unity" : isPos ? " scale-tick--pos" : ""}`} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  VuMeter
// ═══════════════════════════════════════════════════════════════════
function VuMeter({ level, cfg }) {
  const SEG = 24, ge = Math.floor(SEG * 0.65), ye = Math.floor(SEG * 0.85);
  return (
    <div className="vu-meter" style={{ height: cfg.FADER_TRACK_HEIGHT }}>
      {Array.from({ length: SEG }, (_, i) => {
        const active = level >= i / SEG, isRed = i >= ye, isYellow = i >= ge && !isRed;
        const bg = isRed ? (active ? "var(--cs-vu-red-on)" : "var(--cs-vu-red-off)")
          : isYellow    ? (active ? "var(--cs-vu-yellow-on)" : "var(--cs-vu-yellow-off)")
                        : (active ? "var(--cs-vu-green-on)"  : "var(--cs-vu-green-off)");
        const shadow = active && isRed ? "var(--cs-vu-red-glow)" : active && isYellow ? "var(--cs-vu-yellow-glow)" : "none";
        return <div key={i} className="vu-segment"
          style={{ background: bg, boxShadow: shadow, transition: `background ${cfg.VU_DECAY_MS}ms ease` }} />;
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Mono / Stereo Indicator
// ═══════════════════════════════════════════════════════════════════
function MonoStereoIndicator({ stereo }) {
  return (
    <div className="top-control-slot ms-slot" title={stereo ? "Stereo source" : "Mono source"}>
      {stereo ? (
        <svg className="ms-icon ms-icon--stereo" viewBox="0 0 26 14">
          <circle cx="9"  cy="7" r="5.5" />
          <circle cx="17" cy="7" r="5.5" />
        </svg>
      ) : (
        <svg className="ms-icon ms-icon--mono" viewBox="0 0 14 14">
          <circle cx="7" cy="7" r="5.5" />
        </svg>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  LinkBtn
// ═══════════════════════════════════════════════════════════════════
function LinkBtn({ active, onToggle }) {
  return (
    <div className="top-control-slot">
      <button className={`link-btn${active ? " link-btn--active" : ""}`}
        onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
        title={active ? "Unlink stereo pair" : "Link as stereo pair"}>
        <span className="link-btn-icon">{active ? "⊟" : "⊞"}</span>
        <span className="link-btn-label">{active ? "LINKED" : "LINK"}</span>
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Modifier Knob + Strip
// ═══════════════════════════════════════════════════════════════════
function ModifierKnob({ db, onChange, mc = MODIFIER_CONFIG }) {
  const drag = useRef(false), sy = useRef(0), sd = useRef(0);
  const onMouseDown = (e) => { drag.current = true; sy.current = e.clientY; sd.current = db; e.preventDefault(); };
  useEffect(() => {
    const span = mc.DB_MAX - mc.DB_MIN;
    const move = (e) => { if (!drag.current) return; onChange(Math.max(mc.DB_MIN, Math.min(mc.DB_MAX, sd.current - (e.clientY - sy.current) / 120 * span))); };
    const up   = ()  => { drag.current = false; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [onChange, mc]);
  const angle = (modDbToNorm(db, mc) - 0.5) * 280;
  return (
    <div className="modifier-knob-ring" style={{ width: 66, height: 66 }}>
      <div className="modifier-knob" onMouseDown={onMouseDown}
        onDoubleClick={() => onChange(mc.DEFAULT_DB ?? 0)} title="Double-click to reset"
        style={{ transform: `rotate(${angle}deg)` }}>
        <div className="modifier-knob-indicator" />
      </div>
    </div>
  );
}

export function ModifierStrip({ label = "MODIFIER", initialDb = 0, bank = null,
  mc = MODIFIER_CONFIG, cfg = CONFIG, isActive = false, onActivate, onValueChange, syncDb = null }) {
  const [db, setDb] = useState(initialDb);
  const le  = useEditableText(label);
  const dbe = useEditableDb(mc.DB_MIN, mc.DB_MAX, (v) => { setDb(v); onValueChange?.({ bank, value: v, label: le.text }); });
  const handleKnob = useCallback((v) => { setDb(v); onValueChange?.({ bank, value: v, label: le.text }); onActivate?.(); }, [bank, le.text, onValueChange, onActivate]);

  useEffect(() => {
    if (syncDb !== null && syncDb !== undefined) setDb(syncDb);
  }, [syncDb]);

  const displayDb = db === 0 ? "0.0 dB" : db > 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`;
  return (
    <div className={`modifier-strip${isActive ? " modifier-strip--active" : ""}`} onMouseDown={onActivate}>
      {le.editing
        ? <input ref={le.inputRef} className="channel-label-input" value={le.draft} maxLength={12}
            onChange={(e) => le.setDraft(e.target.value)} onBlur={() => le.commit(le.draft)} onKeyDown={le.onKeyDown} />
        : <div className="modifier-label" onDoubleClick={le.open}>{le.text}</div>
      }
      <div className="top-control-slot top-control-slot--empty" aria-hidden="true" />
      <div className="modifier-knob-area" style={{ height: cfg.FADER_TRACK_HEIGHT }}>
        <span className="modifier-sub-label">GAIN OFFSET</span>
        <ModifierKnob db={db} onChange={handleKnob} mc={mc} />
        <span className="modifier-sub-label">{mc.DB_MIN} → +{mc.DB_MAX} dB</span>
      </div>
      {dbe.editing
        ? <input ref={dbe.inputRef} className="db-readout-input" value={dbe.draft} placeholder="e.g. +3"
            onChange={(e) => dbe.setDraft(e.target.value)} onBlur={() => dbe.commit(dbe.draft)} onKeyDown={dbe.onKeyDown} />
        : <div className="db-readout" onDoubleClick={() => dbe.open(db)}>{displayDb}</div>
      }
      <div className="modifier-btn-placeholder" aria-hidden="true">
        <div className="channel-btn-placeholder" aria-hidden="true" />
      </div>
      <div className="strip-file-dot strip-file-dot--placeholder" aria-hidden="true" />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Channel Strip
//
//  stereoMode: null | 'mono' | 'stereo'
//    Left bank only. When set, shows M/S indicator in top-control-slot.
//
//  Routing mode (left bank, output selected):
//    cfg = ROUTING_CFG, values 0-100 integer, no VU.
//    initialDb = matrix value for the primary selected output.
// ═══════════════════════════════════════════════════════════════════
export default function ChannelStrip({
  label = "CH 1", initialDb = 0, initialMuted = false,
  bank = null, isActive = false, onActivate,
  onFaderChange, onMuteChange,
  cfg = CONFIG, showVu = true, vuLevel = null,
  showLinkBtn = false, linkActive = false, onLinkToggle,
  syncDb = null, syncMuted = null, stereoMode = null,
  onFilePick = null,
  fileName = null,
  shortName = null,
  onReset = null,
}) {
  const [db,        setDb]        = useState(initialDb);
  const [muted,     setMuted]     = useState(initialMuted);
  const [demoLevel, setDemoLevel] = useState(0.5);
  const isRouting = cfg.DB_MAX === 100;

  const le  = useEditableText(label);
  const dbe = useEditableDb(cfg.DB_MIN, cfg.DB_MAX, (v) => {
    setDb(v); onFaderChange?.({ bank, value: v, norm: dbToNorm(v, cfg), label: le.text });
  });

  const drag = useRef(false), trackRef = useRef(null), sy = useRef(0), sn = useRef(0);

  const payload = useCallback((d, n) => ({ bank, value: d, norm: n, label: le.text }), [bank, le.text]);

  useEffect(() => {
    if (syncDb !== null && syncDb !== undefined && !drag.current) setDb(syncDb);
  }, [syncDb]);

  useEffect(() => {
    if (syncMuted !== null && syncMuted !== undefined) setMuted(syncMuted);
  }, [syncMuted]);

  useEffect(() => {
    if (isRouting || vuLevel !== null) return;
    let raf;
    const tick = () => {
      setDemoLevel(p => { const t = muted ? 0 : dbToNorm(db, cfg) * (0.7 + Math.random() * 0.3); return p + (t - p) * 0.15; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [db, muted, cfg, vuLevel, isRouting]);

  const handleMouseDown = useCallback((e) => {
    drag.current = true; sy.current = e.clientY; sn.current = dbToNorm(db, cfg); e.preventDefault();
  }, [db, cfg]);

  useEffect(() => {
    const move = (e) => {
      if (!drag.current || !trackRef.current) return;
      const travel = cfg.FADER_TRACK_HEIGHT - cfg.RIDER_HEIGHT;
      const nn = Math.max(0, Math.min(1, sn.current - (e.clientY - sy.current) / travel));
      const nd = normToDb(nn, cfg);
      setDb(nd); onFaderChange?.(payload(nd, nn));
    };
    const up = () => { drag.current = false; };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [cfg, payload, onFaderChange]);

  const handleRiderDblClick = () => {
    const n = dbToNorm(cfg.UNITY_GAIN_DB, cfg);
    setDb(cfg.UNITY_GAIN_DB); onFaderChange?.(payload(cfg.UNITY_GAIN_DB, n));
  };
  const handleMute = () => {
    const n = !muted; setMuted(n); onMuteChange?.({ bank, muted: n, label: le.text });
  };

  const riderTop   = normToPixel(dbToNorm(db, cfg), cfg);
  const railTop    = cfg.RIDER_HEIGHT / 2;
  const railHeight = cfg.FADER_TRACK_HEIGHT - cfg.RIDER_HEIGHT;
  const unityTop   = normToPixel(dbToNorm(cfg.UNITY_GAIN_DB, cfg), cfg) + cfg.RIDER_HEIGHT / 2 - 1;
  const activeVu   = vuLevel !== null ? vuLevel : demoLevel;

  const displayVal = isRouting
    ? String(Math.round(Math.max(0, Math.min(100, db))))
    : db <= cfg.DB_MIN ? "-∞ dB" : db > 0 ? `+${db.toFixed(1)} dB` : `${db.toFixed(1)} dB`;

  const readoutMod = isRouting
    ? (db >= 85 ? "db-readout--hot" : db > 0 ? "db-readout--routing" : "db-readout--muted")
    : muted ? "db-readout--muted" : db > 0 ? "db-readout--hot" : db > -6 ? "db-readout--warm" : "";

  const topSlot = stereoMode !== null
    ? <MonoStereoIndicator stereo={stereoMode === "stereo"} />
    : showLinkBtn
      ? <LinkBtn active={linkActive} onToggle={() => { onLinkToggle?.(); onActivate?.(); }} />
      : <div className="top-control-slot top-control-slot--empty" aria-hidden="true" />;

  return (
    <div className={`channel-strip${isActive ? " channel-strip--active" : ""}${isRouting ? " channel-strip--routing" : ""}`}
      onMouseDown={onActivate}>
      {le.editing
        ? <input ref={le.inputRef} className="channel-label-input" value={le.draft} maxLength={8}
            onChange={(e) => le.setDraft(e.target.value)} onBlur={() => le.commit(le.draft)} onKeyDown={le.onKeyDown} />
        : <div className="channel-label" onDoubleClick={le.open}>{le.text}</div>
      }
      {topSlot}
      <div className="fader-area">
        {showVu && !isRouting && <VuMeter level={activeVu} cfg={cfg} />}
        <div className="scale-container" style={{ width: 38, height: cfg.FADER_TRACK_HEIGHT }}>
          {cfg.SCALE_MARKS.map(d => <ScaleMark key={d} db={d} cfg={cfg} />)}
        </div>
        <div ref={trackRef} className="fader-track" style={{ width: cfg.RIDER_WIDTH, height: cfg.FADER_TRACK_HEIGHT }}>
          <div className="fader-rail"       style={{ top: railTop, height: railHeight }} />
          <div className="fader-unity-mark" style={{ top: unityTop }} />
          <div className="fader-rider" onMouseDown={handleMouseDown} onDoubleClick={handleRiderDblClick}
            title="Double-click to reset to unity"
            style={{ top: riderTop, width: cfg.RIDER_WIDTH, height: cfg.RIDER_HEIGHT }}>
            <div className="rider-grip" />
            <div className="rider-grip rider-grip--center" />
            <div className="rider-grip" />
          </div>
        </div>
      </div>
      {dbe.editing
        ? <input ref={dbe.inputRef} className="db-readout-input" value={dbe.draft}
            placeholder={isRouting ? "0–100" : "e.g. -12"}
            onChange={(e) => dbe.setDraft(e.target.value)} onBlur={() => dbe.commit(dbe.draft)} onKeyDown={dbe.onKeyDown} />
        : <div className={`db-readout ${readoutMod}`} onDoubleClick={() => dbe.open(db)}>{displayVal}</div>
      }
      <div className="channel-buttons">
        <button className={`channel-btn channel-btn--mute${muted ? " channel-btn--active" : ""}`}
          onClick={() => { handleMute(); onActivate?.(); }}>M</button>
        {onFilePick && (
          <button className="channel-btn channel-btn--pick"
            onClick={(e) => { e.stopPropagation(); onFilePick(); }}
            title={fileName ? `${fileName}.wav — click to reassign` : "Assign WAV file to this strip"}>↑</button>
        )}
        {onReset
          ? <button className="channel-btn channel-btn--reset"
              onClick={(e) => { e.stopPropagation(); onReset(); }}
              title="Reset strip — removes file, resets fader, mute and mode">R</button>
          : <div className="channel-btn-placeholder" aria-hidden="true" />
        }
      </div>
      {/* File occupancy indicator — always rendered for uniform strip height */}
      {onFilePick
        ? <div className={`strip-file-dot${fileName ? " strip-file-dot--assigned" : " strip-file-dot--empty"}`}
            title={fileName ? `${shortName ? shortName + ": " : ""}${fileName}.wav` : "No file assigned"}>
            <span className="strip-file-dot-pip" />
            {fileName && <span className="strip-file-dot-name">{shortName || fileName.slice(0, 4)}</span>}
          </div>
        : <div className="strip-file-dot strip-file-dot--placeholder" aria-hidden="true" />
      }
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Routing Tree  — info only, assembled from matrix
// ═══════════════════════════════════════════════════════════════════
function RoutingTree({ matrix, audioSlots, linkedPairs, selectedCols }) {
  const mat = (matrix?.length === 7) ? matrix : defaultMatrix();
  const slots = audioSlots ?? defaultAudioSlots();

  const inLabels = [
    ...slots.map((s, i) => s.shortName || `F${i+1}`),
    "AN",
  ];

  // Build per-output listing
  const outputs = COL_LABEL.map((outLabel, colIdx) => {
    const rIdx = RIGHT_TO_COL.indexOf(colIdx);
    const pIdx = rIdx >= 0 && rIdx < 6 ? Math.floor(rIdx / 2) : -1;
    const linked = pIdx >= 0 && (linkedPairs?.[pIdx] ?? false);
    const isSelected = selectedCols?.includes(colIdx);
    const inputs = mat.map((row, inIdx) => ({
      inIdx, level: row[colIdx], label: inLabels[inIdx],
      stereo: inIdx < 6 ? (slots[inIdx]?.stereo ?? false) : false,
    })).filter(x => x.level > 0);
    return { colIdx, outLabel, inputs, linked, isSelected };
  }).filter(o => o.inputs.length > 0);

  if (outputs.length === 0) {
    return (
      <div className="routing-tree routing-tree--empty">
        No routing yet. Select an output on the right, then adjust input gains on the left.
      </div>
    );
  }

  return (
    <div className="routing-tree">
      <div className="routing-tree-title">Routing Map</div>
      <div className="routing-tree-body">
        {outputs.map(({ colIdx, outLabel, inputs, linked, isSelected }) => (
          <div key={colIdx} className={`rt-out${isSelected ? " rt-out--sel" : ""}`}>
            <span className="rt-out-label">
              {outLabel}{linked ? <span className="rt-linked-badge"> ⊟</span> : null}
            </span>
            <div className="rt-inputs">
              {inputs.map(({ inIdx, level, label, stereo }) => (
                <span key={inIdx} className={`rt-in${level >= 85 ? " rt-in--hot" : level >= 50 ? " rt-in--mid" : " rt-in--low"}`}>
                  {stereo ? "⊚" : "○"}{label}
                  <span className="rt-level">{level}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Matrix View  — full 7×7 input/output grid, TAB-navigable
// ═══════════════════════════════════════════════════════════════════
export function MatrixView({ song, matrix, onChange, disabled, linkedPairs }) {
  const mat   = (matrix?.length === 7) ? matrix : defaultMatrix();
  const slots = song?.audioSlots ?? defaultAudioSlots();

  const rowHeaders = useMemo(() => [
    ...slots.map((s, i) => ({ short: s.shortName || `F${i+1}`, full: s.fileName || `—`, stereo: s.stereo })),
    { short: "AN", full: "Aux Input", stereo: false },
  ], [slots]);

  const handleCell = (row, col, raw) => {
    const v = Math.max(0, Math.min(100, parseInt(raw, 10) || 0));
    const next = mat.map(r => [...r]);
    next[row][col] = v;
    // Mirror to linked partner column
    const rIdx = RIGHT_TO_COL.indexOf(col);
    if (rIdx >= 0 && rIdx < 6) {
      const pIdx = Math.floor(rIdx / 2);
      if (linkedPairs?.[pIdx]) {
        const ptnrRIdx = rIdx % 2 === 0 ? rIdx + 1 : rIdx - 1;
        next[row][RIGHT_TO_COL[ptnrRIdx]] = v;
      }
    }
    onChange?.(next);
  };

  return (
    <div className={`matrix-view${disabled ? " matrix-view--disabled" : ""}`}>
      <div className="matrix-hint">TAB between cells · 0–100 · 0 = no routing · 90 = unity</div>
      <div className="matrix-scroll">
        <table className="matrix-table">
          <thead>
            <tr>
              <th className="matrix-corner">IN \ OUT</th>
              {COL_LABEL.map((o, ci) => {
                const ri = RIGHT_TO_COL.indexOf(ci);
                const pi = ri >= 0 && ri < 6 ? Math.floor(ri / 2) : -1;
                const linked = pi >= 0 && (linkedPairs?.[pi] ?? false);
                return <th key={ci} className={`matrix-col-header${linked ? " matrix-col--linked" : ""}`}>{o}</th>;
              })}
            </tr>
          </thead>
          <tbody>
            {rowHeaders.map((row, rIdx) => (
              <tr key={rIdx}>
                <td className="matrix-row-header">
                  {row.stereo
                    ? <svg className="ms-icon--stereo" viewBox="0 0 26 14" style={{width:18,height:10,flexShrink:0}}><circle cx="9" cy="7" r="5" fill="none" stroke="var(--cs-ms-stereo-color)" strokeWidth="2"/><circle cx="17" cy="7" r="5" fill="none" stroke="var(--cs-ms-stereo-color)" strokeWidth="2"/></svg>
                    : <svg className="ms-icon--mono"   viewBox="0 0 14 14" style={{width:10,height:10,flexShrink:0}}><circle cx="7" cy="7" r="5" fill="none" stroke="var(--cs-ms-mono-color)"   strokeWidth="2"/></svg>
                  }
                  <span className="matrix-row-short">{row.short}</span>
                  <span className="matrix-row-full">{row.full}</span>
                </td>
                {COL_LABEL.map((_, cIdx) => (
                  <td key={cIdx} className="matrix-cell-td">
                    <input type="number" min={0} max={100}
                      className={`matrix-cell${mat[rIdx][cIdx] > 0 ? " matrix-cell--active" : ""}`}
                      value={mat[rIdx][cIdx]}
                      onChange={e => handleCell(rIdx, cIdx, e.target.value)}
                      disabled={disabled}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  Connection Counter Badge
// ═══════════════════════════════════════════════════════════════════
function ConnectionCounter({ count }) {
  const MAX = 32;
  const pct = Math.min(1, count / MAX);
  const cls = count >= MAX ? "conn-badge--full" : count >= 28 ? "conn-badge--warn" : "conn-badge--ok";
  return (
    <div className={`conn-badge ${cls}`}>
      <span className="conn-badge-label">CONNECTIONS</span>
      <span className="conn-badge-count">{count}<span className="conn-badge-max">/{MAX}</span></span>
      <div className="conn-badge-bar">
        <div className="conn-badge-fill" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  IDORU Scene  — classic fader view
//
//  Routing model:
//    • Right bank: click to SELECT output(s) for routing.
//      Click again to deselect. Multiple can be selected.
//      Shift-click on right bank to add to selection.
//    • Left bank: in routing mode when ≥1 output selected.
//      Fader = GAIN for that source into selected output(s).
//      Shows value from first selected output column.
//      Moving writes to ALL selected output columns.
//    • Linked pair: selecting one strip auto-includes the partner.
//      Left fader changes mirror to both columns.
//    • No output selected → left bank dimmed, non-interactive.
// ═══════════════════════════════════════════════════════════════════
export function IdoruScene({
  onEvent, sceneCfg = IDORU_SCENE_CONFIG,
  initialLinkedPairs = [false, false, false],
  initialMatrix = null,
  onStateChange, audioSlots = null,
  onSlotUpdate = null,
  kbDisabled = false,
}) {
  const { leftBank, rightBank } = sceneCfg;

  // Indices of selected right-bank strips
  const [selectedRightIndices, setSelectedRightIndices] = useState([]);
  const [linkedPairs,   setLinkedPairs]   = useState(initialLinkedPairs);
  const [syncDbs,       setSyncDbs]       = useState(Array(7).fill(null));
  const [leftSyncDbs,   setLeftSyncDbs]   = useState(Array(7).fill(null));
  const [leftSyncMutes, setLeftSyncMutes] = useState(Array(7).fill(null));
  const [rightSyncMutes,setRightSyncMutes]= useState(Array(7).fill(null));
  const [modSyncDb,     setModSyncDb]     = useState(null);
  const [matrix,        setMatrix]        = useState(() => initialMatrix ?? defaultMatrix());
  const [modifierDb,    setModifierDb]    = useState(rightBank.modifier?.initialDb ?? 0);
  const [leftMutes,     setLeftMutes]     = useState(Array(7).fill(false));

  // Keyboard / wheel focus: { side: 'left'|'right', idx: 0-6 }
  const [kbFocus, setKbFocus] = useState(null);
  const sceneRef = useRef(null);

  const linkedPairsRef  = useRef([...initialLinkedPairs]);
  const rightFadersRef  = useRef(rightBank.channels.map(ch => ({ db: ch.initialDb ?? 0, muted: false })));
  const rightDbsRef     = useRef(rightBank.channels.map(ch => ch.initialDb ?? 0));
  const modifierDbRef   = useRef(rightBank.modifier?.initialDb ?? 0);
  const matrixRef       = useRef(matrix);
  const leftMutesRef    = useRef(Array(7).fill(false));

  useEffect(() => { matrixRef.current = matrix; }, [matrix]);

  // Columns corresponding to current selection (including linked partners)
  const selectedCols = useMemo(() => {
    const cols = new Set();
    for (const si of selectedRightIndices) {
      cols.add(RIGHT_TO_COL[si]);
      if (si < 6) {
        const pi = Math.floor(si / 2);
        if (linkedPairsRef.current[pi]) {
          const ptnr = si % 2 === 0 ? si + 1 : si - 1;
          cols.add(RIGHT_TO_COL[ptnr]);
        }
      }
    }
    return [...cols];
  }, [selectedRightIndices]);

  // Primary column (for left bank display)
  const primaryCol = selectedCols[0] ?? null;

  // Connection count
  const connCount = useMemo(() =>
    countConnections(matrix, audioSlots, linkedPairsRef.current, leftMutesRef.current),
    [matrix, audioSlots, selectedRightIndices]
  );

  // ── State reporting ──────────────────────────────────────────
  const reportTimer = useRef(null);
  const reportState = useCallback(() => {
    clearTimeout(reportTimer.current);
    reportTimer.current = setTimeout(() => {
      onStateChange?.({
        rightFaders:  rightFadersRef.current.map(f => ({ ...f })),
        linkedPairs:  [...linkedPairsRef.current],
        modifierDb:   modifierDbRef.current,
        matrix:       matrixRef.current.map(r => [...r]),
        leftMutes:    [...leftMutesRef.current],
      });
    }, 200);
  }, [onStateChange]);

  // ── Right bank: output selection ─────────────────────────────
  const handleRightActivate = useCallback((stripIdx, shiftKey = false) => {
    setSelectedRightIndices(prev => {
      if (shiftKey) {
        // Add/remove from multi-selection
        return prev.includes(stripIdx) ? prev.filter(i => i !== stripIdx) : [...prev, stripIdx];
      } else {
        // Toggle: click same → deselect, click different → select only this
        if (prev.length === 1 && prev[0] === stripIdx) return [];
        return [stripIdx];
      }
    });
  }, []);

  // ── Link toggle ──────────────────────────────────────────────
  const togglePair = useCallback((pIdx) => {
    const next = [...linkedPairsRef.current];
    next[pIdx] = !next[pIdx];
    linkedPairsRef.current = next;
    setLinkedPairs([...next]);
    if (next[pIdx]) {
      const aIdx = pIdx * 2, bIdx = aIdx + 1;
      const aVal = rightDbsRef.current[aIdx];
      rightDbsRef.current[bIdx] = aVal;
      rightFadersRef.current[bIdx] = { ...rightFadersRef.current[bIdx], db: aVal };
      setSyncDbs(prev => { const n = [...prev]; n[bIdx] = aVal; return n; });
      // Also mirror matrix column
      setMatrix(prev => {
        const m = prev.map(r => [...r]);
        const colA = RIGHT_TO_COL[aIdx], colB = RIGHT_TO_COL[bIdx];
        for (let inIdx = 0; inIdx < 7; inIdx++) m[inIdx][colB] = m[inIdx][colA];
        return m;
      });
    }
    reportState();
  }, [reportState]);

  // ── Left bank: routing fader ──────────────────────────────────
  const handleFaderLeft = useCallback((e, inIdx) => {
    if (selectedCols.length === 0) return;
    const val = Math.max(0, Math.min(100, Math.round(e.value)));
    setMatrix(prev => {
      const m = prev.map(r => [...r]);
      for (const col of selectedCols) m[inIdx][col] = val;
      return m;
    });
    reportState();
    const outNames = selectedCols.map(c => COL_LABEL[c]).join(", ");
    onEvent?.(`Route: ${e.label} → [${outNames}] = ${val}`);
  }, [selectedCols, onEvent, reportState]);

  const handleMuteLeft = useCallback((e, inIdx) => {
    leftMutesRef.current[inIdx] = e.muted;
    setLeftMutes(prev => { const n = [...prev]; n[inIdx] = e.muted; return n; });
    reportState();
    onEvent?.(`${e.label}: ${e.muted ? "● MUTED" : "○ LIVE"}`);
  }, [onEvent, reportState]);

  // ── Right bank: volume faders ─────────────────────────────────
  const handleFaderRight = useCallback((e, chIdx) => {
    rightDbsRef.current[chIdx] = e.value;
    rightFadersRef.current[chIdx] = { ...rightFadersRef.current[chIdx], db: e.value };
    if (chIdx < 6) {
      const pi = Math.floor(chIdx / 2), pt = chIdx % 2 === 0 ? chIdx + 1 : chIdx - 1;
      if (linkedPairsRef.current[pi]) {
        rightDbsRef.current[pt] = e.value;
        rightFadersRef.current[pt] = { ...rightFadersRef.current[pt], db: e.value };
        setSyncDbs(prev => { const n = [...prev]; n[pt] = e.value; return n; });
      }
    }
    reportState();
    onEvent?.(`VOL: ${e.label} → ${fmt(e.value)} dB`);
  }, [onEvent, reportState]);

  const handleMuteRight = useCallback((e, chIdx) => {
    rightFadersRef.current[chIdx] = { ...rightFadersRef.current[chIdx], muted: e.muted };
    reportState();
    onEvent?.(`${e.label}: ${e.muted ? "● MUTED" : "○ LIVE"}`);
  }, [onEvent, reportState]);

  const handleModifier = useCallback((e) => {
    modifierDbRef.current = e.value; setModifierDb(e.value); reportState();
    onEvent?.(`LEVEL ADJ: ${fmt(e.value)} dB`);
  }, [onEvent, reportState]);

  // ── Keyboard + mouse wheel ────────────────────────────────────
  // Arrow L/R  → navigate strips (left bank 0-6, then right bank 0-6)
  // Arrow U/D  → nudge focused fader ±1 dB (or ±1 in routing mode)
  // M          → mute focused strip
  // Wheel      → same as arrow U/D on hovered strip (set via onMouseEnter)
  const TOTAL_STRIPS = 15; // 7 left + 7 right + 1 modifier

  const nudgeFader = useCallback((side, idx, delta) => {
    if (side === "left") {
      const col = selectedCols.length > 0 ? selectedCols[0] : null;
      if (col === null) return;
      const cur = matrixRef.current[idx]?.[col] ?? 0;
      const nv  = Math.max(0, Math.min(100, cur + delta));
      setMatrix(prev => { const m = prev.map(r => [...r]); for (const c of selectedCols) m[idx][c] = nv; return m; });
      setLeftSyncDbs(prev => { const n = [...prev]; n[idx] = nv; return n; });
      reportState();
      onEvent?.(`Route: ${leftBank.channels[idx]?.label} → [${selectedCols.map(c => COL_LABEL[c]).join(",")}] = ${nv}`);
    } else if (idx === 7) {
      // Modifier knob — nudge in 0.5 dB steps
      const mc = MODIFIER_CONFIG;
      const cur = modifierDbRef.current;
      const nv  = Math.max(mc.DB_MIN, Math.min(mc.DB_MAX, cur + delta * 0.5));
      modifierDbRef.current = nv;
      setModifierDb(nv);
      setModSyncDb(nv);
      reportState();
      onEvent?.(`LEVEL ADJ: ${fmt(nv)} dB`);
    } else {
      const cur = rightDbsRef.current[idx] ?? 0;
      const nv  = Math.max(CONFIG.DB_MIN, Math.min(CONFIG.DB_MAX, cur + delta));
      rightDbsRef.current[idx] = nv;
      rightFadersRef.current[idx] = { ...rightFadersRef.current[idx], db: nv };
      setSyncDbs(prev => { const n = [...prev]; n[idx] = nv; return n; });
      if (idx < 6) {
        const pi = Math.floor(idx / 2), pt = idx % 2 === 0 ? idx + 1 : idx - 1;
        if (linkedPairsRef.current[pi]) {
          rightDbsRef.current[pt] = nv;
          rightFadersRef.current[pt] = { ...rightFadersRef.current[pt], db: nv };
          setSyncDbs(prev => { const n = [...prev]; n[idx] = nv; n[pt] = nv; return n; });
        }
      }
      reportState();
      onEvent?.(`VOL: ${rightBank.channels[idx]?.label} → ${fmt(nv)} dB`);
    }
  }, [selectedCols, onEvent, reportState, leftBank, rightBank]);

  const muteFocused = useCallback((side, idx) => {
    if (side === "left") {
      const n = !leftMutesRef.current[idx];
      leftMutesRef.current[idx] = n;
      setLeftMutes(prev => { const a = [...prev]; a[idx] = n; return a; });
      // Push mute state to strip via syncMuted
      setLeftSyncMutes(prev => { const a = [...prev]; a[idx] = n; return a; });
      reportState();
      onEvent?.(`${leftBank.channels[idx]?.label}: ${n ? "● MUTED" : "○ LIVE"}`);
    } else {
      const n = !rightFadersRef.current[idx]?.muted;
      rightFadersRef.current[idx] = { ...rightFadersRef.current[idx], muted: n };
      // Push mute state to right strip via syncMuted
      setRightSyncMutes(prev => { const a = [...prev]; a[idx] = n; return a; });
      reportState();
      onEvent?.(`${rightBank.channels[idx]?.label}: ${n ? "● MUTED" : "○ LIVE"}`);
    }
  }, [leftBank, rightBank, onEvent, reportState]);

  useEffect(() => {
    const el = sceneRef.current;
    if (!el) return;

    const onKey = (e) => {
      // Suppress when shortcuts are globally disabled (modal open) or a text field is focused
      if (kbDisabled) return;
      if (["INPUT","SELECT","TEXTAREA"].includes(document.activeElement?.tagName)) return;

      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        setKbFocus(prev => {
          const dir = e.key === "ArrowRight" ? 1 : -1;
          if (!prev) return { side: "left", idx: 0 };
          // flat: 0-6 = left, 7-13 = right 0-6, 14 = modifier
          let flat = prev.side === "left" ? prev.idx
                   : prev.idx === 7       ? 14
                                          : prev.idx + 7;
          flat = Math.max(0, Math.min(TOTAL_STRIPS - 1, flat + dir));
          if (flat < 7)  return { side: "left",  idx: flat };
          if (flat === 14) return { side: "right", idx: 7 };   // modifier
          return { side: "right", idx: flat - 7 };
        });
      }

      if ((e.key === "ArrowUp" || e.key === "ArrowDown") && kbFocus) {
        e.preventDefault();
        const delta = e.key === "ArrowUp" ? 1 : -1;
        nudgeFader(kbFocus.side, kbFocus.idx, delta);
      }

      if ((e.key === "m" || e.key === "M") && kbFocus) {
        muteFocused(kbFocus.side, kbFocus.idx);
      }

      // Space — toggle routing selection on focused right strip.
      // Always preventDefault when kbFocus is set so spacebar doesn't
      // scroll the page or trigger a click on the currently focused button.
      if (e.key === " " && kbFocus) {
        e.preventDefault();
        if (kbFocus.side === "right") {
          handleRightActivate(kbFocus.idx, e.shiftKey);
        }
      }
    };

    const onWheel = (e) => {
      if (!kbFocus) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      nudgeFader(kbFocus.side, kbFocus.idx, delta);
    };

    // Listen on document so shortcuts fire regardless of which element has focus.
    // The scene div still captures wheel events (keeps scroll behaviour local).
    document.addEventListener("keydown", onKey);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      document.removeEventListener("keydown", onKey);
      el.removeEventListener("wheel", onWheel);
    };
  }, [kbDisabled, kbFocus, nudgeFader, muteFocused]);

  // ── Stereo modes from audio slots ─────────────────────────────
  const leftStereoModes = useMemo(() => [
    ...(audioSlots ?? defaultAudioSlots()).map(s => s.stereo ? "stereo" : "mono"),
    "mono",  // AUX IN is always mono
  ], [audioSlots]);

  // ── WAV picker from left bank strip (F1-F6 only) ──────────────
  const handleLeftFilePick = useCallback(async (slotIdx) => {
    const result = await platform.pickWav();
    if (!result) return;
    const existing = audioSlots?.[slotIdx] ?? {};
    const updated  = {
      fileName:  result.nameNoExt,
      shortName: existing.shortName || result.nameNoExt.slice(0, 2).toUpperCase(),
      stereo:    result.stereo,
      warnings:  result.warnings ?? [],
      file:      result.file     ?? null,
      filePath:  result.filePath ?? null,
    };
    onSlotUpdate?.(slotIdx, updated);
    if (updated.warnings.length > 0) {
      onEvent?.(`⚠ ${result.nameNoExt}: ${updated.warnings.join(" · ")}`);
    } else {
      onEvent?.(`✓ F${slotIdx + 1}: ${result.nameNoExt} (${updated.stereo ? "stereo" : "mono"})`);
    }
  }, [audioSlots, onSlotUpdate, onEvent]);

  // ── Reset left bank strip (F1-F6 only) ───────────────────────
  const handleResetLeft = useCallback((slotIdx) => {
    // Zero all matrix columns for this input row
    setMatrix(prev => {
      const m = prev.map(r => [...r]);
      for (let col = 0; col < 7; col++) m[slotIdx][col] = 0;
      return m;
    });
    // Unmute
    leftMutesRef.current[slotIdx] = false;
    setLeftMutes(prev => { const n = [...prev]; n[slotIdx] = false; return n; });
    setLeftSyncMutes(prev => { const n = [...prev]; n[slotIdx] = false; return n; });
    // Reset fader to 0 (routing mode: 0 = no signal)
    setLeftSyncDbs(prev => { const n = [...prev]; n[slotIdx] = 0; return n; });
    // Reset slot metadata — empty file, default label, mono
    onSlotUpdate?.(slotIdx, {
      fileName:  "",
      shortName: "",
      stereo:    false,
      warnings:  [],
      file:      null,
      filePath:  null,
    });
    reportState();
    onEvent?.(`F${slotIdx + 1}: strip reset`);
  }, [onSlotUpdate, onEvent, reportState]);

  const rch = rightBank.channels;

  const rightStrip = (ch, i, extra = {}) => (
    <ChannelStrip key={i}
      label={ch.label} initialDb={ch.initialDb ?? 0} initialMuted={ch.initialMuted ?? false}
      bank={rightBank.bankId}
      isActive={selectedRightIndices.includes(i) || (kbFocus?.side === "right" && kbFocus.idx === i)}
      onActivate={(e) => { handleRightActivate(i, e?.shiftKey); setKbFocus({ side: "right", idx: i }); }}
      onFaderChange={(e) => handleFaderRight(e, i)}
      onMuteChange={(e)  => handleMuteRight(e, i)}
      syncDb={syncDbs[i]}
      syncMuted={rightSyncMutes[i]}
      showVu={false}
      {...extra}
    />
  );

  const isRoutingMode = selectedCols.length > 0;

  // Status bar text
  const statusText = isRoutingMode
    ? `GAIN mode — routing to: ${selectedCols.map(c => COL_LABEL[c]).join(", ")} · shift+click or shift+space to multi-select`
    : "VOLUME mode — click or focus+Space an output to start routing";

  return (
    <div className="idoru-scene" ref={sceneRef} tabIndex={0}
      onFocus={() => {}} style={{ outline: "none" }}>
      <div className="scene-status-bar">
        <span className={`scene-status-text${isRoutingMode ? " scene-status-text--active" : ""}`}>
          {isRoutingMode ? "▸ " : "○ "}{statusText}
        </span>
        <ConnectionCounter count={connCount} />
      </div>

      <div className="idoru-body">
        <div className="idoru-console">

        {/* Left bank — GAIN / routing */}
        <div className="bank bank--theme-left">
          <div className="bank-header">
            <span className="bank-number">{leftBank.bankId}</span>
            <span className="bank-label">{leftBank.title}</span>
            <span className="bank-fader-count">{leftBank.channels.length} ch</span>
            <span className="bank-mode-badge">{isRoutingMode ? "GAIN" : "—"}</span>
          </div>
          <div className={`bank-strips${!isRoutingMode ? " bank-strips--dimmed" : ""}`}>
            {leftBank.channels.map((ch, i) => (
              <ChannelStrip
                key={`left-${primaryCol ?? "idle"}-${i}`}
                label={ch.label}
                initialDb={primaryCol !== null ? (matrix[i]?.[primaryCol] ?? 0) : 0}
                initialMuted={leftMutes[i]}
                bank={leftBank.bankId}
                isActive={kbFocus?.side === "left" && kbFocus.idx === i}
                onActivate={() => setKbFocus({ side: "left", idx: i })}
                cfg={isRoutingMode ? ROUTING_CFG : CONFIG}
                showVu={false}
                onFaderChange={(e) => handleFaderLeft(e, i)}
                onMuteChange={(e)  => handleMuteLeft(e, i)}
                stereoMode={leftStereoModes[i]}
                onFilePick={i < 6 && onSlotUpdate ? () => handleLeftFilePick(i) : null}
                onReset={i < 6 && onSlotUpdate ? () => handleResetLeft(i) : null}
                syncDb={leftSyncDbs[i]}
                syncMuted={leftSyncMutes[i]}
                fileName={i < 6 ? (audioSlots?.[i]?.fileName || null) : null}
                shortName={i < 6 ? (audioSlots?.[i]?.shortName || null) : null}
              />
            ))}
          </div>
        </div>

        {/* Right bank — VOLUME */}
        <div className="bank bank--theme-right">
          <div className="bank-header">
            <span className="bank-number">{rightBank.bankId}</span>
            <span className="bank-label">{rightBank.title}</span>
            <span className="bank-fader-count">{rch.length} ch{rightBank.modifier ? " + mod" : ""}</span>
            <span className="bank-mode-badge bank-mode-badge--right">VOL</span>
          </div>
          <div className="bank-strips bank-strips--grouped">
            {[0, 1, 2].map(pIdx => {
              const aIdx = pIdx * 2, bIdx = aIdx + 1, linked = linkedPairs[pIdx];
              return (
                <div key={pIdx} className={`strip-pair${linked ? " strip-pair--linked" : ""}`}>
                  {rightStrip(rch[aIdx], aIdx)}
                  {rightStrip(rch[bIdx], bIdx, {
                    showLinkBtn: true, linkActive: linked, onLinkToggle: () => togglePair(pIdx),
                  })}
                </div>
              );
            })}
            <div className="strip-solo">{rightStrip(rch[6], 6)}</div>
            {rightBank.modifier && (
              <div className="strip-solo">
                <ModifierStrip
                  label={rightBank.modifier.label} initialDb={rightBank.modifier.initialDb ?? 0}
                  bank={rightBank.bankId} cfg={CONFIG}
                  isActive={kbFocus?.side === "right" && kbFocus.idx === 7}
                  onActivate={() => setKbFocus({ side: "right", idx: 7 })}
                  onValueChange={handleModifier}
                  syncDb={modSyncDb}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <RoutingTree matrix={matrix} audioSlots={audioSlots} linkedPairs={linkedPairs} selectedCols={selectedCols} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  TOOLBAR
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  TOOLBAR
// ═══════════════════════════════════════════════════════════════════
function ToolBar({ onSave, onLoad, onTransfer, onSwitchView, viewMode, dirty,
  onExport, onImport, onNewSession, onSavePreset, onScan, onFirmware,
  theme, onToggleTheme }) {
  return (
    <div className="toolbar">
      <span className="toolbar-logo">
        CIDORU <span className="toolbar-logo-version">v. {APP_VERSION}</span>
        <span className="toolbar-logo-sub">:: alternative app for Idoru P-1</span>
      </span>
      <div className="toolbar-divider" />

      {/* Session */}
      <button className="toolbar-btn toolbar-btn--new" onClick={onNewSession} title="New session — resets all state">
        <span className="toolbar-btn-icon">◻</span> NEW
      </button>
      <button className={`toolbar-btn${dirty ? " toolbar-btn--dirty" : ""}`} onClick={onSave}
        title={dirty ? "Unsaved changes" : "Save session"}>
        <span className="toolbar-btn-icon">▣</span> SAVE
      </button>
      <button className="toolbar-btn" onClick={onLoad} title="Reload from storage">
        <span className="toolbar-btn-icon">▤</span> LOAD
      </button>

      <div className="toolbar-divider" />

      {/* Import / Export */}
      <button className="toolbar-btn" onClick={onExport} title="Export session as JSON file">
        <span className="toolbar-btn-icon">↓</span> EXPORT
      </button>
      <button className="toolbar-btn" onClick={onImport} title="Import session from JSON file">
        <span className="toolbar-btn-icon">↑</span> IMPORT
      </button>

      <div className="toolbar-divider" />

      {/* Preset + Scan */}
      <button className="toolbar-btn toolbar-btn--preset" onClick={onSavePreset}
        title="Save current mixer state as a reusable preset">
        <span className="toolbar-btn-icon">★</span> PRESET
      </button>
      <button className="toolbar-btn" onClick={onScan} title="Scan for missing audio files">
        <span className="toolbar-btn-icon">⌕</span> SCAN
      </button>

      <div className="toolbar-divider" />

      {/* SD card */}
      <button className="toolbar-btn toolbar-btn--transfer" onClick={onTransfer}
        title="Write P-1 config files and audio to SD card">
        <span className="toolbar-btn-icon">⏏</span> TRANSFER
      </button>
      <button className="toolbar-btn toolbar-btn--firmware" onClick={onFirmware}
        title="Check for firmware updates at idoru.live">
        <span className="toolbar-btn-icon">⬆</span> FIRMWARE
      </button>

      <div className="toolbar-divider" />

      {/* View */}
      <button className={`toolbar-btn${viewMode === "matrix" ? " toolbar-btn--view-active" : ""}`}
        onClick={onSwitchView} title="Switch fader / matrix view">
        <span className="toolbar-btn-icon">{viewMode === "classic" ? "⊞" : "⊟"}</span>
        {viewMode === "classic" ? "MATRIX" : "FADERS"}
      </button>

      <div className="toolbar-spacer" />

      {/* Theme toggle */}
      <button className={`toolbar-btn toolbar-btn--theme${theme === "light" ? " toolbar-btn--theme-light" : ""}`}
        onClick={onToggleTheme}
        title={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}>
        <span className="toolbar-btn-icon">{theme === "light" ? "☾" : "☀"}</span>
        {theme === "light" ? "DARK" : "LIGHT"}
      </button>

      {/* Manual — always on the far right */}
      <button className="toolbar-btn toolbar-btn--manual"
        onClick={() => {
          if (window.electronAPI?.openManual) window.electronAPI.openManual();
          else window.open('/MANUAL.html', '_blank');
        }}
        title="Open user manual">
        <span className="toolbar-btn-icon">?</span> MANUAL
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  PANES
// ═══════════════════════════════════════════════════════════════════
function PlaylistPane({ playlists, selectedId, onSelect, onAdd, onEdit, onDelete, onDuplicate, onMoveUp, onMoveDown }) {
  return (
    <div className="pane playlist-pane">
      <div className="pane-header">
        <span className="pane-title">Playlists</span>
        <span className="pane-subtitle">{playlists.length}/7</span>
        <button className="pane-add-btn" onClick={onAdd} disabled={playlists.length >= 7} title="New playlist (max 7)">+</button>
      </div>
      <div className="pane-list">
        {playlists.length === 0 && <div className="pane-empty">No playlists yet</div>}
        {playlists.map((pl, idx) => (
          <div key={pl.id} className={`pane-item${selectedId === pl.id ? " pane-item--selected" : ""}`}
            onClick={() => onSelect(pl.id)}>
            <span className="pane-item-index">{idx + 1}</span>
            <span className="pane-item-name">{pl.name}</span>
            <div className="pane-item-actions">
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onMoveUp(idx); }} disabled={idx === 0} title="Move up">↑</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onMoveDown(idx); }} disabled={idx === playlists.length - 1} title="Move down">↓</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onEdit(pl); }} title="Edit">✎</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onDuplicate(pl.id); }} title="Duplicate">⧉</button>
              <button className="pane-action-btn pane-action-btn--delete" onClick={e => { e.stopPropagation(); onDelete(pl.id); }} title="Delete">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const QUEUE_LABELS = { queue_next: "Queue", play_next: "Next", loop: "Loop" };

function SongsPane({ songs, selectedId, disabled, onSelect, onAdd, onEdit, onDelete, onDuplicate, onMoveUp, onMoveDown }) {
  return (
    <div className={`pane songs-pane${disabled ? " pane--disabled" : ""}`}>
      <div className="pane-header">
        <span className="pane-title">Songs</span>
        <span className="pane-subtitle">{songs.length}/40</span>
        <button className="pane-add-btn" onClick={onAdd} disabled={disabled || songs.length >= 40} title="New song (max 40 per playlist)">+</button>
      </div>
      <div className="pane-list">
        {disabled  && <div className="pane-empty">← Select a playlist</div>}
        {!disabled && songs.length === 0 && <div className="pane-empty">No songs yet</div>}
        {songs.map((s, idx) => (
          <div key={s.id} className={`pane-item${selectedId === s.id ? " pane-item--selected" : ""}`}
            onClick={() => onSelect(s.id)}>
            <span className="pane-item-index">{idx + 1}</span>
            <div className="pane-item-body">
              <span className="pane-item-name">{s.name}</span>
              <span className="pane-item-meta">
                {s.bpm} BPM · {QUEUE_LABELS[s.queueBehavior] ?? s.queueBehavior}
                {s.midiFile ? " · MIDI" : ""}
              </span>
            </div>
            <div className="pane-item-actions">
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onMoveUp(idx); }} disabled={idx === 0} title="Move up">↑</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onMoveDown(idx); }} disabled={idx === songs.length - 1} title="Move down">↓</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onEdit(s); }} title="Edit">✎</button>
              <button className="pane-action-btn" onClick={e => { e.stopPropagation(); onDuplicate(s.id); }} title="Duplicate">⧉</button>
              <button className="pane-action-btn pane-action-btn--delete" onClick={e => { e.stopPropagation(); onDelete(s.id); }} title="Delete">✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HelpPane({ context, viewMode }) {
  const content = useMemo(() => {
    if (viewMode === "matrix") return {
      title: "Matrix view",
      lines: ["Each row = audio source.","Each col = hardware output.","","Enter 0–100 per cell.","0 = not routed.","90 = unity gain.","","TAB to move between","cells quickly.","","Linked pairs share","the same column value."],
    };
    if (context.type === "song") return {
      title: "Routing model",
      lines: ["RIGHT = output volumes","(drag to set level)","","Click an output to","enter GAIN mode.","Shift+click = multi.","","LEFT = source gain","for selected output(s).","","M = mute source","(frees connections).","","32 connections max."],
    };
    if (context.type === "playlist") return {
      title: "Songs", lines: ["Add songs.","Each song has its","own routing matrix."],
    };
    return {
      title: "Start here",
      lines: ["1. Create a playlist","2. Add songs","3. Click a song","4. Click an output","5. Set input gains","6. Save & Transfer"],
    };
  }, [context, viewMode]);

  return (
    <div className="pane help-pane">
      <div className="pane-header"><span className="pane-title">Help</span></div>
      <div className="help-content">
        <div className="help-section-title">{content.title}</div>
        {content.lines.map((line, i) => <div key={i} className="help-line">{line || <>&nbsp;</>}</div>)}
      </div>
    </div>
  );
}

function InfoBar({ message }) {
  return (
    <div className={`info-bar${message ? ` info-bar--${message.type}` : ""}`}>
      <span className="info-bar-dot">●</span>
      <span className="info-bar-text">{message ? message.text : "Ready"}</span>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  CONFIRM MODAL  — generic yes/no
// ═══════════════════════════════════════════════════════════════════
function ConfirmModal({ title, message, confirmLabel = "Confirm", danger = false, onConfirm, onCancel }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{title}</span>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="confirm-message">{message}</div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className={`modal-btn${danger ? " modal-btn--danger" : " modal-btn--primary"}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SAVE PRESET MODAL
// ═══════════════════════════════════════════════════════════════════
function SavePresetModal({ onSave, onCancel }) {
  const [name,    setName]    = useState("");
  const [comment, setComment] = useState("");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const filterP1  = (s) => s.replace(/[^a-zA-Z0-9 !@#$%^_=+\-&()]/g, "").slice(0, 32);
  const nameVal   = validateP1Name(name);
  const canSave   = nameVal.valid;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Save as Preset</span>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Name</label>
            <div className="form-field-wrap">
              <input ref={ref} className={`form-input${!nameVal.valid && name.length > 0 ? " form-input--error" : ""}`}
                value={name} maxLength={32} onChange={e => setName(filterP1(e.target.value))}
                placeholder="My routing preset" />
              <div className="form-char-count">{name.length}/32</div>
            </div>
          </div>
          {!nameVal.valid && name.length > 0 && <div className="form-error">{nameVal.error}</div>}
          <div className="form-row">
            <label className="form-label">Comment</label>
            <textarea className="form-input form-textarea" value={comment} maxLength={200}
              onChange={e => setComment(e.target.value)}
              placeholder="Optional notes about this preset…" />
          </div>
          <div className="form-allowed-chars">
            Presets capture: routing matrix · fader levels · mute states · stereo links.<br/>
            Audio file assignments and song metadata are NOT stored.
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={() => onSave({ name, comment })} disabled={!canSave}>Save Preset</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  SCAN MODAL  — shows missing files with Relink option
// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  TRANSFER MODAL — progress log + result
// ═══════════════════════════════════════════════════════════════════
function TransferModal({ lines, done, result, onClose }) {
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const hasErrors  = result?.missing?.length > 0 || result?.aborted;
  const statusIcon = !done ? "⏳" : hasErrors ? "⚠" : "✓";
  const statusText = !done
    ? "Transferring…"
    : result?.aborted
      ? `Aborted — ${result.missing?.length ?? 0} file(s) missing. Use Scan & Relink first.`
      : result?.missing?.length > 0
        ? `Done with warnings — ${result.missing.length} file(s) not copied.`
        : `Transfer complete. ${result?.copied ?? 0} file(s) copied, ${result?.skipped ?? 0} unchanged.`;

  return (
    <div className="modal-overlay" onClick={done ? onClose : undefined}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>SD Card Transfer</span>
          {done && <button className="modal-close" onClick={onClose}>✕</button>}
        </div>
        <div className="modal-body">
          <div className={`transfer-status${!done ? " transfer-status--busy" : hasErrors ? " transfer-status--warn" : " transfer-status--ok"}`}>
            <span className="transfer-status-icon">{statusIcon}</span>
            <span>{statusText}</span>
          </div>
          <div className="transfer-log" ref={logRef}>
            {lines.map((line, i) => (
              <div key={i} className={`transfer-log-line${line.startsWith("  ⚠") || line.startsWith("⛔") ? " transfer-log-line--warn" : line.startsWith("  ✓") || line.startsWith("✓") ? " transfer-log-line--ok" : line.startsWith("🗑") || line.startsWith("  🗑") ? " transfer-log-line--del" : ""}`}>
                {line}
              </div>
            ))}
            {!done && <div className="transfer-log-cursor">▌</div>}
          </div>
        </div>
        <div className="modal-footer">
          {done
            ? <button className="modal-btn modal-btn--primary" onClick={onClose}>Close</button>
            : <span className="transfer-wait-note">Please wait — do not close the application.</span>
          }
        </div>
      </div>
    </div>
  );
}

function ScanModal({ results, onRelink, onScanFolder, onClose }) {
  const missing    = results.filter(r => r.missing);
  const unverified = results.filter(r => r.unverified && !r.missing);
  const ok         = results.filter(r => !r.missing && !r.unverified);

  const slotLabel = (r) => r.slotIdx < 0 ? "MIDI" : `F${r.slotIdx + 1}`;
  const fileLabel = (r) => r.slotIdx < 0 ? `${r.fileName}.mid` : `${r.fileName}.wav`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Scan Results — {missing.length} missing · {unverified.length} unverified · {ok.length} ok</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {missing.length === 0 && unverified.length === 0 && (
            <div className="scan-ok">✓ All {ok.length} assigned file(s) verified on disk.</div>
          )}

          {missing.length > 0 && (
            <>
              <div className="scan-warning">
                ⚠ {missing.length} file(s) confirmed missing from disk. Use <strong>Relink</strong> to reassign.
              </div>
              <div className="scan-list">
                {missing.map((r, i) => (
                  <div key={i} className="scan-item scan-item--missing">
                    <div className="scan-item-info">
                      <span className="scan-item-song">{r.songName}</span>
                      <span className="scan-item-slot">{slotLabel(r)}</span>
                      <span className="scan-item-file">{fileLabel(r)}</span>
                    </div>
                    <button className="scan-relink-btn" onClick={() => onRelink(r)}>Relink</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {unverified.length > 0 && (
            <>
              <div className="scan-warning" style={{marginTop: missing.length > 0 ? 12 : 0}}>
                ⚠ {unverified.length} file(s) not yet picked in this session — their paths are not in memory.
                Use <strong>Relink</strong> to pick each file, or open each song and use the <strong>↑ WAV</strong> button.
                These files will not be copied during Transfer until picked.
              </div>
              <div className="scan-list">
                {unverified.map((r, i) => (
                  <div key={i} className="scan-item scan-item--missing">
                    <div className="scan-item-info">
                      <span className="scan-item-song">{r.songName}</span>
                      <span className="scan-item-slot">{slotLabel(r)}</span>
                      <span className="scan-item-file">{fileLabel(r)}</span>
                    </div>
                    <button className="scan-relink-btn" onClick={() => onRelink(r)}>Pick</button>
                  </div>
                ))}
              </div>
            </>
          )}

          {ok.length > 0 && (missing.length > 0 || unverified.length > 0) && (
            <div className="scan-ok-list">{ok.length} file(s) verified ok.</div>
          )}
        </div>
        <div className="modal-footer">
          {onScanFolder && (missing.length > 0 || unverified.length > 0) && (
            <button className="modal-btn" onClick={onScanFolder}
              title="Recursively scan a folder and auto-link files by filename">
              ⌕ Choose Folder
            </button>
          )}
          <button className="modal-btn modal-btn--primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  FIRMWARE MODAL
// ═══════════════════════════════════════════════════════════════════
function FirmwareModal({ onClose }) {
  const isElectron = !!window.electronAPI?.firmware;

  const [phase,    setPhase]    = useState("idle");    // idle|checking|found|downloading|done|error|manual
  const [firmwares,setFirmwares]= useState([]);
  const [cached,   setCached]   = useState(null);
  const [progress, setProgress] = useState(0);
  const [errMsg,   setErrMsg]   = useState("");
  const [writingFw,setWritingFw]= useState(false);
  const [writeMsg, setWriteMsg] = useState("");

  // On open: check if we already have a cached firmware
  useEffect(() => {
    if (!isElectron) return;
    window.electronAPI.firmware.getCached().then(c => {
      if (c) setCached(c);
    });
  }, [isElectron]);

  const handleCheck = async () => {
    setPhase("checking"); setErrMsg("");
    const result = await window.electronAPI.firmware.check();
    if (result.found && result.firmwares?.length > 0) {
      setFirmwares(result.firmwares);
      setPhase("found");
    } else {
      setPhase("error");
      setErrMsg(result.error || "No firmware found. Try downloading manually from idoru.live/downloads.");
    }
  };

  const handleDownload = async (fw) => {
    setPhase("downloading"); setProgress(0);
    const cleanup = window.electronAPI.firmware.onProgress(pct => setProgress(pct));
    const result  = await window.electronAPI.firmware.download(fw.url, fw.version);
    cleanup();
    if (result.ok) {
      setCached({ version: result.version, path: result.path });
      setPhase("done");
    } else {
      setPhase("error");
      setErrMsg(result.error || "Download failed.");
    }
  };

  const handlePickManual = async () => {
    const result = await window.electronAPI.firmware.pick();
    if (result) { setCached(result); setPhase("done"); }
  };

  const handleClearCache = async () => {
    await window.electronAPI.firmware.clearCache();
    setCached(null); setPhase("idle");
  };

  const handleOpenPage = () => window.electronAPI.firmware.openPage();

  const handleWriteToSd = async () => {
    if (!cached) return;
    setWritingFw(true); setWriteMsg("");
    const root = await window.electronAPI.firmware.pickSdRoot();
    if (!root) { setWritingFw(false); return; }
    const result = await window.electronAPI.firmware.writeToSd(root, cached.path);
    setWritingFw(false);
    if (result.ok) setWriteMsg(`✓ Written to ${result.path}`);
    else setWriteMsg(`✗ ${result.error}`);
  };

  // For SD path picking we use the transfer dialog approach
  // ── Web version: static instructions ─────────────────────────────
  if (!isElectron) return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Firmware Update</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="firmware-note">
            Browser security prevents direct download from idoru.live.<br/>
            Follow these steps manually:
          </div>
          <ol className="firmware-steps">
            <li>Visit <a href="https://idoru.live/downloads" target="_blank" rel="noreferrer" className="firmware-link">idoru.live/downloads</a> and download the latest <code>.bin</code> firmware file.</li>
            <li>Make sure your SD card has at least one setlist and song.</li>
            <li>Create a folder called <code>update</code> on the root of the SD card.</li>
            <li>Place the <code>.bin</code> file into the <code>update</code> folder (no other files).</li>
            <li>With the pedal <strong>off</strong>, insert the SD card.</li>
            <li>Hold the <strong>Play</strong> footswitch and connect power. Keep holding until the firmware message appears.</li>
            <li>Release footswitch, then unplug and replug to restart.</li>
          </ol>
          <div className="firmware-note" style={{marginTop:12}}>
            💡 The desktop version of CIdoru can auto-download firmware and write it to the SD card for you.
          </div>
        </div>
        <div className="modal-footer">
          <a href="https://idoru.live/downloads" target="_blank" rel="noreferrer"
            className="modal-btn modal-btn--primary firmware-open-btn">Open idoru.live/downloads</a>
          <button className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );

  // ── Electron version: smart firmware manager ──────────────────────
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>Firmware Manager</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* Cached firmware status */}
          <div className="firmware-status-box">
            {cached
              ? <><span className="firmware-status-dot firmware-status-dot--ok">●</span>
                  <span>Firmware <strong>v{cached.version}</strong> ready
                  {cached.manual ? " (manually added)" : " (downloaded)"}
                  </span>
                  <button className="modal-btn firmware-clear-btn" onClick={handleClearCache}>✕ Clear</button>
                </>
              : <><span className="firmware-status-dot firmware-status-dot--none">○</span>
                  <span>No firmware cached</span>
                </>
            }
          </div>

          {/* Step 1: Get firmware */}
          <div className="firmware-section-title">Step 1 — Get firmware</div>
          <div className="firmware-btn-row">
            <button className="modal-btn modal-btn--primary" onClick={handleCheck}
              disabled={phase === "checking" || phase === "downloading"}>
              {phase === "checking" ? "Checking…" : "⌕ Check for latest on idoru.live"}
            </button>
            <button className="modal-btn" onClick={handlePickManual}
              disabled={phase === "downloading"}>
              ↑ Pick .bin from disk
            </button>
            <button className="modal-btn" onClick={handleOpenPage}>
              ↗ Open idoru.live/downloads
            </button>
          </div>

          {phase === "found" && firmwares.length > 0 && (
            <div className="firmware-found-list">
              {firmwares.map((fw, i) => (
                <div key={i} className="firmware-found-item">
                  <span className="firmware-found-ver">v{fw.version}</span>
                  <span className="firmware-found-url">{fw.url.split('/').pop()}</span>
                  <button className="modal-btn modal-btn--primary"
                    onClick={() => handleDownload(fw)}>↓ Download</button>
                </div>
              ))}
            </div>
          )}

          {phase === "downloading" && (
            <div className="firmware-progress-wrap">
              <div className="firmware-progress-bar">
                <div className="firmware-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span className="firmware-progress-label">{progress}%</span>
            </div>
          )}

          {phase === "done" && (
            <div className="firmware-ok-msg">✓ Firmware ready. Proceed to Step 2.</div>
          )}

          {phase === "error" && errMsg && (
            <div className="firmware-err-msg">
              ⚠ {errMsg}
            </div>
          )}

          {/* Step 2: Write to SD card */}
          <div className={`firmware-section-title${!cached ? " firmware-section-disabled" : ""}`}>
            Step 2 — Write to SD card
          </div>
          {cached
            ? <>
                <div className="firmware-note">
                  Click the button below to select your SD card root folder. CIdoru will create
                  an <code>update/</code> folder and place the <code>.bin</code> file inside it
                  (any existing files in <code>update/</code> will be cleared first).
                </div>
                <div className="firmware-btn-row" style={{marginTop:8}}>
                  <button className="modal-btn modal-btn--primary"
                    onClick={handleWriteToSd} disabled={writingFw}>
                    {writingFw ? "Writing…" : "⏏ Select SD card & write firmware"}
                  </button>
                </div>
                {writeMsg && (
                  <div className={writeMsg.startsWith("✓") ? "firmware-ok-msg" : "firmware-err-msg"}>
                    {writeMsg}
                  </div>
                )}
              </>
            : <div className="firmware-note firmware-note--dim">
                Complete Step 1 first.
              </div>
          }

          {/* Step 3: Install */}
          <div className="firmware-section-title">Step 3 — Install on device</div>
          <ol className="firmware-steps">
            <li>Make sure your SD card has at least one setlist and song (required by P-1).</li>
            <li>With the pedal <strong>off</strong>, insert the SD card.</li>
            <li>Hold the <strong>Play</strong> footswitch and connect power. Keep holding.</li>
            <li>Release when the firmware update message appears on the display.</li>
            <li>Unplug and replug power to restart. Done.</li>
          </ol>
          <div className="firmware-note" style={{marginTop:6}}>
            The current firmware version is shown at boot as <code>SW x.x.x</code>.
            The P-1 will only install a version different from the currently installed one.
          </div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MODALS
// ═══════════════════════════════════════════════════════════════════
function PlaylistForm({ data, onSave, onCancel }) {
  const [name, setName] = useState(data.name ?? "");
  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  const validation = validateP1Name(name);
  const canSave    = validation.valid;

  const save  = () => { if (canSave) onSave({ id: data.id, name: name.trim() }); };
  const onKey = (e) => { if (e.key === "Enter") save(); if (e.key === "Escape") onCancel(); };

  // Strip disallowed characters on input
  const handleChange = (e) => {
    const filtered = e.target.value.replace(/[^a-zA-Z0-9 !@#$%^_=+\-&()]/g, "");
    setName(filtered.slice(0, 32));
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{data.id ? "Edit Playlist" : "New Playlist"}</span>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <label className="form-label">Name</label>
            <div className="form-field-wrap">
              <input ref={ref}
                className={`form-input${!canSave && name.length > 0 ? " form-input--error" : ""}`}
                value={name} maxLength={32}
                onChange={handleChange} onKeyDown={onKey}
                placeholder="a-z  A-Z  0-9  ! @ # …" />
              <div className="form-char-count">{name.length}/32</div>
            </div>
          </div>
          {!canSave && name.length > 0 && (
            <div className="form-error">{validation.error}</div>
          )}
          <div className="form-allowed-chars">Allowed: {P1_ALLOWED_CHARS}</div>
        </div>
        <div className="modal-footer">
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={save} disabled={!canSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function SongForm({ song, onSave, onCancel, allPlaylists = [], currentPlaylistId = null }) {
  const filterP1 = (s) => s.replace(/[^a-zA-Z0-9 !@#$%^_=+\-&()]/g, "").slice(0, 32);

  // Load presets for the dropdown
  const [presets] = useState(() => platform.getInitialPresets());
  const [selectedPresetId, setSelectedPresetId] = useState("");

  const [name,         setName]         = useState(song?.name         ?? "");
  const [bpm,          setBpm]          = useState(song?.bpm          ?? 120);
  const [queue,        setQueue]        = useState(song?.queueBehavior ?? "queue_next");
  const [midi,         setMidi]         = useState(song?.midiFile      ?? "");
  const [slots,        setSlots]        = useState(song?.audioSlots    ?? defaultAudioSlots());
  const [slotWarnings, setSlotWarnings] = useState(Array(6).fill(null));

  // Multi-playlist: start with current playlist pre-selected
  const [selectedPlaylistIds, setSelectedPlaylistIds] = useState(
    () => currentPlaylistId ? [currentPlaylistId] : []
  );

  const ref = useRef(null);
  useEffect(() => { ref.current?.focus(); }, []);

  // Apply preset (routing/levels only — not song metadata or files)
  const handleApplyPreset = (presetId) => {
    setSelectedPresetId(presetId);
    // Preset doesn't affect name/bpm/queue/midi/slots
    // Those are stored in mixerStates in the parent — parent will apply on save
  };

  const nameValidation = validateP1Name(name);
  const midiValidation = midi.trim() ? validateP1Name(midi.trim()) : { valid: true, error: null };
  const canSave = nameValidation.valid && midiValidation.valid && selectedPlaylistIds.length > 0;

  // Keep raw File refs in a parallel array — not stored in state (not serialisable)
  const slotFilesRef = useRef(Array(6).fill(null));
  const midiFileRef  = useRef(null);

  const handleFilePick = async (idx) => {
    const result = await platform.pickWav();
    if (!result) return;
    slotFilesRef.current[idx] = result.file ?? result.filePath ?? null;
    setSlots(prev => prev.map((s, i) => i !== idx ? s : {
      ...s, fileName: result.nameNoExt,
      shortName: s.shortName || result.nameNoExt.slice(0, 2).toUpperCase(),
      stereo: result.stereo,
    }));
    setSlotWarnings(prev => {
      const next = [...prev];
      next[idx] = result.warnings?.length > 0 ? result.warnings : null;
      return next;
    });
  };

  const handleMidiPick = async () => {
    const result = await platform.pickMidi();
    if (!result) return;
    midiFileRef.current = result.file ?? result.filePath ?? null;
    setMidi(result.nameNoExt);
  };

  const togglePlaylist = (plId) => {
    setSelectedPlaylistIds(prev =>
      prev.includes(plId) ? prev.filter(id => id !== plId) : [...prev, plId]
    );
  };

  const save = () => {
    if (!canSave) return;
    onSave({
      ...song,
      name: name.trim(), bpm: Number(bpm) || 120, queueBehavior: queue,
      midiFile: midi.trim() || null, audioSlots: slots,
      playlistIds: selectedPlaylistIds,
      presetId: selectedPresetId || null,
      // Raw File objects for transfer cache — stripped before persisting
      _slotFiles: slotFilesRef.current,
      _midiFile:  midiFileRef.current,
    });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>{song?.id ? "Edit Song" : "New Song"}</span>
          <button className="modal-close" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">

          {/* Playlist assignment (multi-select) */}
          {!song?.id && allPlaylists.length > 0 && (
            <>
              <div className="form-section-divider">Assign to Playlist(s)</div>
              <div className="playlist-multiselect">
                {allPlaylists.map(pl => (
                  <label key={pl.id} className={`pl-check${selectedPlaylistIds.includes(pl.id) ? " pl-check--active" : ""}`}>
                    <input type="checkbox" checked={selectedPlaylistIds.includes(pl.id)}
                      onChange={() => togglePlaylist(pl.id)} />
                    {pl.name}
                  </label>
                ))}
              </div>
              {selectedPlaylistIds.length === 0 && (
                <div className="form-error">Select at least one playlist</div>
              )}
              {selectedPlaylistIds.length > 1 && (
                <div className="form-allowed-chars">Song will be duplicated into each selected playlist.</div>
              )}
            </>
          )}

          {/* Preset selector (optional) */}
          {!song?.id && presets.length > 0 && (
            <>
              <div className="form-section-divider">Start from Preset (optional)</div>
              <div className="form-row">
                <label className="form-label">Preset</label>
                <select className="form-select" value={selectedPresetId}
                  onChange={e => handleApplyPreset(e.target.value)}>
                  <option value="">— None (use defaults) —</option>
                  {presets.map(p => (
                    <option key={p.id} value={p.id}>{p.name}{p.comment ? ` (${p.comment.slice(0, 30)})` : ""}</option>
                  ))}
                </select>
              </div>
              {selectedPresetId && (
                <div className="form-allowed-chars">
                  Routing and fader levels from preset will be applied. Audio files will be empty.
                </div>
              )}
            </>
          )}

          <div className="form-section-divider">Song Details</div>

          <div className="form-row">
            <label className="form-label">Name</label>
            <div className="form-field-wrap">
              <input ref={ref}
                className={`form-input${!nameValidation.valid && name.length > 0 ? " form-input--error" : ""}`}
                value={name} maxLength={32} onChange={e => setName(filterP1(e.target.value))} />
              <div className="form-char-count">{name.length}/32</div>
            </div>
          </div>
          {!nameValidation.valid && name.length > 0 && <div className="form-error">{nameValidation.error}</div>}

          <div className="form-row">
            <label className="form-label">BPM</label>
            <input className="form-input form-input--short" type="number" min={1} max={999}
              value={bpm} onChange={e => setBpm(e.target.value)} />
          </div>

          <div className="form-row">
            <label className="form-label">Queue</label>
            <select className="form-select" value={queue} onChange={e => setQueue(e.target.value)}>
              <option value="queue_next">Queue Next</option>
              <option value="play_next">Play Next</option>
              <option value="loop">Loop</option>
            </select>
          </div>

          <div className="form-section-divider">Audio &amp; MIDI Files</div>
          <div className="form-allowed-chars">
            Names: a-z A-Z 0-9 ! @ # $ % ^ _ = + - &amp; ( ) · max 32 chars · WAV: 44.1 kHz / 16-bit only
          </div>

          <div className="audio-slots">
            {slots.map((slot, idx) => (
              <div key={idx} className="audio-slot-group">
                <div className="audio-slot">
                  <span className="slot-index">F{idx+1}</span>
                  <button className={`slot-ms-btn${slot.stereo ? " slot-ms-btn--stereo" : " slot-ms-btn--mono"}`}
                    onClick={() => setSlots(prev => prev.map((s, i) => i !== idx ? s : { ...s, stereo: !s.stereo }))}
                    title={slot.stereo ? "Stereo — click to force mono" : "Mono — click to force stereo"}>
                    {slot.stereo
                      ? <svg viewBox="0 0 26 14" className="slot-ms-icon"><circle cx="9" cy="7" r="5.5"/><circle cx="17" cy="7" r="5.5"/></svg>
                      : <svg viewBox="0 0 14 14" className="slot-ms-icon"><circle cx="7" cy="7" r="5.5"/></svg>
                    }
                  </button>
                  <input className="form-input form-input--short slot-shortname"
                    value={slot.shortName} placeholder="BG" maxLength={2}
                    onChange={e => setSlots(prev => prev.map((s, i) => i !== idx ? s : { ...s, shortName: e.target.value.toUpperCase() }))}
                    title="2-char fader name on P-1 display" />
                  <input className={`form-input slot-filename${slotWarnings[idx] ? " form-input--warn" : ""}`}
                    value={slot.fileName} placeholder="filename without .wav"
                    onChange={e => setSlots(prev => prev.map((s, i) => i !== idx ? s : { ...s, fileName: filterP1(e.target.value) }))} />
                  <button className="slot-pick-btn" onClick={() => handleFilePick(idx)}
                    title="Browse WAV — reads header for stereo, 44.1 kHz and 16-bit checks">↑ WAV</button>
                </div>
                {slotWarnings[idx] && (
                  <div className="slot-warnings">
                    {slotWarnings[idx].map((w, wi) => <span key={wi} className="slot-warning">⚠ {w}</span>)}
                  </div>
                )}
              </div>
            ))}

            {/* MIDI slot — same visual row style as F1-F6 */}
            <div className="audio-slot-group">
              <div className="audio-slot">
                <span className="slot-index slot-index--midi">MIDI</span>
                {/* spacer to align with M/S button column */}
                <div className="slot-ms-btn slot-ms-btn--placeholder" aria-hidden="true" />
                {/* no short-name for MIDI */}
                <div className="form-input form-input--short slot-shortname slot-shortname--placeholder" aria-hidden="true" />
                <input
                  className={`form-input slot-filename${!midiValidation.valid && midi.length > 0 ? " form-input--error" : ""}`}
                  value={midi} placeholder="filename without .mid"
                  onChange={e => setMidi(filterP1(e.target.value))} maxLength={32} />
                <button className="slot-pick-btn slot-pick-btn--midi" onClick={handleMidiPick}
                  title="Browse .mid file">↑ MID</button>
              </div>
              {!midiValidation.valid && midi.length > 0 && (
                <div className="slot-warnings">
                  <span className="slot-warning">⚠ {midiValidation.error}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="modal-btn" onClick={onCancel}>Cancel</button>
          <button className="modal-btn modal-btn--primary" onClick={save} disabled={!canSave}>
            {selectedPlaylistIds.length > 1 ? `Save to ${selectedPlaylistIds.length} Playlists` : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  WEB WELCOME MODAL — shown once on load in web mode only
// ═══════════════════════════════════════════════════════════════════
function WebWelcomeModal({ onClose }) {
  const winUrl   = '/CIdoru-Setup-1.4.0.exe';
  const linuxUrl = '/CIdoru-Setup-1.4.0.AppImage';
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--wide" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <span>⚠ Please Read Before Using</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="welcome-lead">
            You are using the <strong>web version</strong> of CIdoru — intended for quick demos
            and emergency situations only.
          </p>
          <p className="welcome-body">
            As a browser-based application, it has significant limitations imposed by browser
            security restrictions:
          </p>
          <ul className="welcome-list">
            <li>WAV and MIDI files must be re-picked every session — paths cannot be remembered between page loads.</li>
            <li>SD card transfer requires Chrome or Edge and copies files only if they were picked in the current session.</li>
            <li>The file scan cannot verify whether files actually exist on disk.</li>
            <li>Firmware auto-download and SD card write are not available.</li>
          </ul>
          <p className="welcome-body">
            For the full experience, please download and install the <strong>CIdoru Desktop
            Application</strong>. The installer is not code-signed — Windows will display an
            "Unknown Publisher" warning. Simply click <em>More info → Run anyway</em> to proceed,
            exactly as you would with the original Idoru software.
          </p>
          <div className="welcome-download-row">
            <a href={winUrl} download className="modal-btn modal-btn--primary welcome-dl-btn">
              ⬇ Download for Windows (.exe)
            </a>
            <a href={linuxUrl} download className="modal-btn welcome-dl-btn">
              ⬇ Download for Linux (.AppImage)
            </a>
          </div>
          <p className="welcome-sig">
            Thank you for your attention.<br/>
            <em>Barney Estrada, CIdoru developer</em>
          </p>
        </div>
        <div className="modal-footer">
          <button className="modal-btn modal-btn--primary" onClick={onClose}>
            I understand — continue with web version
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  APP
// ═══════════════════════════════════════════════════════════════════
export function App() {
  const [project,       setProject]      = useState(() => {
    const s = platform.getInitialSession() || emptyProject();
    // Migrate: ensure all playlists and songs have UUIDs (for existing sessions)
    return {
      ...s,
      playlists: (s.playlists || []).map(pl => ({ uuid: genUUID(), ...pl })),
      songs:     (s.songs     || []).map(sg => ({
        uuid:         genUUID(),
        midiFileUUID: sg.midiFile ? genUUID() : null,
        ...sg,
        audioSlots: (sg.audioSlots || defaultAudioSlots()).map(sl => ({
          fileUUID: sl.fileName ? genUUID() : null,
          ...sl,
        })),
      })),
    };
  });
  const [mixerStates,   setMixerStates]  = useState(() => (platform.getInitialSession() || {}).mixerStates || {});
  const [dirtyIds,      setDirtyIds]     = useState(() => new Set());
  const [selectedPlId,  setSelectedPlId] = useState(null);
  const [selectedSongId,setSongId]       = useState(null);
  const [viewMode,      setViewMode]     = useState("classic");
  const [theme,         setTheme]        = useState(() => platform.getTheme());

  useEffect(() => {
    document.documentElement.dataset.theme = theme === 'light' ? 'light' : '';
    platform.saveTheme(theme);
  }, [theme]);

  // Auto-scan on startup if session has file references
  // Use a ref so we can call handleScan after it's defined without circular dep
  const handleScanRef = useRef(null);
  useEffect(() => {
    const hasFiles = project.songs?.some(s =>
      s.audioSlots?.some(sl => sl?.fileName) || s.midiFile
    );
    if (!hasFiles) return;
    // Wait for loadFileCache to populate, then do a silent background scan.
    // Only open the scan modal if there are confirmed missing files (not just unverified).
    const t = setTimeout(async () => {
      if (!handleScanRef.current) return;
      await handleScanRef.current({ silent: true });
    }, 800);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // only on mount

  const handleToggleTheme = useCallback(() => {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }, []);
  const [infoMsg,       setInfoMsg]      = useState(null);

  // Modal states
  const [playlistForm,  setPlForm]       = useState(null);
  const [songForm,      setSongForm]     = useState(null);
  const [presetForm,    setPresetForm]   = useState(false);
  const [scanModal,     setScanModal]    = useState(null);   // null | results[]
  const [confirmModal,  setConfirmModal] = useState(null);   // null | { title, message, onConfirm }
  const [firmwareModal, setFirmwareModal] = useState(false);
  const [transferModal, setTransferModal] = useState(null); // null | { lines, done, result }
  // Web-only welcome modal — shown once per session, never in Electron
  const [welcomeModal,  setWelcomeModal] = useState(() => !window.electronAPI?.isElectron);

  const infoTimer  = useRef(null);
  // File cache: Map<cacheKey, File|path> — persisted to disk in Electron, lost on reload in web.
  // Keys: `${songId}_f${slotIdx}` for WAV slots, `${songId}_midi` for MIDI.
  const fileCache  = useRef(new Map());

  // Restore file paths from disk on startup (Electron only — no-op in web)
  useEffect(() => {
    platform.loadFileCache(fileCache.current);
  }, []);
  const showInfo = useCallback((text, type = "info") => {
    clearTimeout(infoTimer.current);
    setInfoMsg({ text, type });
    infoTimer.current = setTimeout(() => setInfoMsg(null), 5000);
  }, []);

  const selectedSong    = project.songs.find(s => s.id === selectedSongId) ?? null;
  const songsInPlaylist = project.songs.filter(s => s.playlistId === selectedPlId);

  // ── Save ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const ok = await platform.saveSession({ playlists: project.playlists, songs: project.songs, mixerStates });
    if (ok) {
      setDirtyIds(new Set());
      platform.saveFileCache(fileCache.current); // persist file paths (no-op in web)
      showInfo("Saved.", "success");
    } else {
      showInfo("Save failed — storage may be full.", "error");
    }
  }, [project, mixerStates, showInfo]);

  // ── Load ─────────────────────────────────────────────────────────
  const handleLoad = useCallback(async () => {
    const data = await platform.loadSession();
    if (!data) { showInfo("Nothing saved yet.", "info"); return; }
    setProject(data); setMixerStates(data.mixerStates || {}); setDirtyIds(new Set());
    setSelectedPlId(null); setSongId(null);
    showInfo("Session loaded. Running file scan…", "success");
    setTimeout(() => handleScanRef.current?.({ silent: true }), 300);
  }, [showInfo]);

  // ── New Session ───────────────────────────────────────────────────
  const handleNewSession = useCallback(() => {
    const proceed = () => {
      setProject(emptyProject()); setMixerStates({}); setDirtyIds(new Set());
      setSelectedPlId(null); setSongId(null);
      showInfo("New session started.", "info");
    };
    if (dirtyIds.size > 0) {
      setConfirmModal({
        title: "Unsaved Changes",
        message: "You have unsaved changes. Starting a new session will discard them. The saved data in storage is not affected — you can reload it. Continue?",
        confirmLabel: "Discard & Start New",
        danger: true,
        onConfirm: () => { setConfirmModal(null); proceed(); },
      });
    } else { proceed(); }
  }, [dirtyIds, showInfo]);

  // ── Export JSON ───────────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    await platform.exportJson({ ...project, mixerStates });
    showInfo("Session exported as JSON.", "success");
  }, [project, mixerStates, showInfo]);

  // ── Import JSON ───────────────────────────────────────────────────
  const handleImport = useCallback(async () => {
    try {
      const data = await platform.importJson();
      if (!data) return;
      if (!Array.isArray(data.playlists) || !Array.isArray(data.songs))
        throw new Error("Invalid session file — missing playlists or songs.");
      setProject({ playlists: data.playlists, songs: data.songs });
      setMixerStates(data.mixerStates || {});
      setDirtyIds(new Set(["__imported"]));
      setSelectedPlId(null); setSongId(null);
      showInfo(`Imported: ${data.playlists.length} playlist(s), ${data.songs.length} song(s).`, "success");
    } catch (err) { showInfo(`Import failed: ${err.message}`, "error"); }
  }, [showInfo]);

  // ── Save Preset ───────────────────────────────────────────────────
  const handleSavePreset = useCallback(() => {
    if (!selectedSongId) { showInfo("Select a song first to capture its mixer state.", "info"); return; }
    setPresetForm(true);
  }, [selectedSongId, showInfo]);

  const handleConfirmPreset = useCallback(async ({ name, comment }) => {
    const state = mixerStates[selectedSongId] ?? {};
    const preset = {
      id: genId(), name, comment, createdAt: new Date().toISOString(),
      matrix:       state.matrix       ?? defaultMatrix(),
      leftMutes:    state.leftMutes    ?? Array(7).fill(false),
      rightFaders:  state.rightFaders  ?? IDORU_SCENE_CONFIG.rightBank.channels.map(c => ({ db: c.initialDb ?? 0, muted: false })),
      linkedPairs:  state.linkedPairs  ?? [false, false, false],
      modifierDb:   state.modifierDb   ?? 0,
    };
    const existing = platform.getInitialPresets();
    await platform.savePresets([...existing, preset]);
    setPresetForm(false);
    showInfo(`Preset "${name}" saved.`, "success");
  }, [selectedSongId, mixerStates, showInfo]);

  // ── Scan ─────────────────────────────────────────────────────────
  // silent: true = only open modal if confirmed missing (not just unverified)
  const handleScan = useCallback(async ({ silent = false } = {}) => {
    const results = [];
    for (const song of project.songs) {
      const slots = song.audioSlots ?? [];
      for (let i = 0; i < slots.length; i++) {
        const sl = slots[i];
        if (sl?.fileName)
          results.push({ songId: song.id, songName: song.name, slotIdx: i, fileName: sl.fileName, missing: false, unverified: false });
      }
      if (song.midiFile)
        results.push({ songId: song.id, songName: song.name, slotIdx: -1, fileName: song.midiFile, missing: false, unverified: false, isMidi: true });
    }
    const verified = await platform.scanVerify(fileCache.current);
    if (verified) {
      results.forEach(r => {
        const key = r.slotIdx >= 0 ? `${r.songId}_f${r.slotIdx}` : `${r.songId}_midi`;
        if (key in verified) {
          r.missing = !verified[key];
        } else {
          r.unverified = true;
        }
      });
    } else {
      results.forEach(r => { r.unverified = true; });
    }
    const missingCount    = results.filter(r => r.missing).length;
    const unverifiedCount = results.filter(r => r.unverified).length;

    // In silent mode, only open modal if there are confirmed missing files
    if (!silent || missingCount > 0) {
      setScanModal(results.length > 0 ? results : []);
    }

    if (missingCount > 0)
      showInfo(`Scan: ${missingCount} file(s) confirmed missing — use Scan to relink.`, "error");
    else if (unverifiedCount > 0 && !silent)
      showInfo(`Scan: ${unverifiedCount} file(s) not in cache — use ↑ WAV or Scan → Choose Folder.`, "error");
    else if (!silent)
      showInfo(`Scan complete. All ${results.length} file(s) verified on disk.`, "success");
  }, [project.songs, showInfo]);
  // Keep ref in sync so startup auto-scan can call this after it's defined
  handleScanRef.current = handleScan;

  // ── Scan folder — bulk relink by filename ─────────────────────────
  const handleScanFolder = useCallback(async () => {
    const folderMap = await platform.scanFolder();
    if (!folderMap) return; // user cancelled

    let matched = 0;
    setScanModal(prev => {
      if (!prev) return prev;
      return prev.map(r => {
        if (!r.missing && !r.unverified) return r; // already ok
        const nameNoExt = r.fileName;
        if (folderMap[nameNoExt]) {
          const cacheKey = r.slotIdx >= 0
            ? `${r.songId}_f${r.slotIdx}`
            : `${r.songId}_midi`;
          fileCache.current.set(cacheKey, folderMap[nameNoExt]);
          matched++;
          return { ...r, missing: false, unverified: false };
        }
        return r;
      });
    });

    // Persist the newly found paths
    platform.saveFileCache(fileCache.current);

    if (matched > 0) showInfo(`Folder scan: ${matched} file(s) matched and linked.`, "success");
    else showInfo(`Folder scan complete — no matches found for remaining files.`, "info");
  }, [showInfo]);

  const handleRelink = useCallback(async (scanEntry) => {
    const isMidi = scanEntry.slotIdx < 0;
    const result = await platform.pickRelink(isMidi);
    if (!result) return;
    const { nameNoExt, stereo, warnings } = result;
    const cacheKey = isMidi ? `${scanEntry.songId}_midi` : `${scanEntry.songId}_f${scanEntry.slotIdx}`;
    platform.cacheFileFromPickResult(fileCache.current, cacheKey, result);
    if (!isMidi) {
      setProject(prev => ({
        ...prev,
        songs: prev.songs.map(s => {
          if (s.id !== scanEntry.songId) return s;
          const slots = s.audioSlots ? [...s.audioSlots] : defaultAudioSlots();
          slots[scanEntry.slotIdx] = { ...slots[scanEntry.slotIdx], fileName: nameNoExt, stereo: stereo ?? slots[scanEntry.slotIdx].stereo };
          return { ...s, audioSlots: slots };
        }),
      }));
      if (warnings?.length) showInfo(`Relinked with warnings: ${warnings.join(" · ")}`, "error");
      else showInfo(`Relinked F${scanEntry.slotIdx + 1} in "${scanEntry.songName}".`, "success");
    } else {
      setProject(prev => ({
        ...prev,
        songs: prev.songs.map(s => s.id !== scanEntry.songId ? s : { ...s, midiFile: nameNoExt }),
      }));
      showInfo(`Relinked MIDI in "${scanEntry.songName}".`, "success");
    }
    setDirtyIds(prev => new Set([...prev, scanEntry.songId]));
    // Update the scan modal results to mark this entry as resolved
    setScanModal(prev => prev
      ? prev.map(r =>
          r.songId === scanEntry.songId && r.slotIdx === scanEntry.slotIdx
            ? { ...r, missing: false, unverified: false, fileName: nameNoExt }
            : r
        )
      : prev
    );
  }, [showInfo]);

  // ── Transfer ─────────────────────────────────────────────────────
  const handleTransfer = useCallback(async () => {
    // Open modal in busy state immediately
    setTransferModal({ lines: ["Waiting for folder selection…"], done: false, result: null });

    const appendLine = (line) => {
      setTransferModal(prev => prev ? { ...prev, lines: [...prev.lines, line] } : prev);
    };

    try {
      const result = await platform.transfer(
        project, mixerStates, fileCache.current,
        (msg) => appendLine(msg)
      );
      setTransferModal(prev => prev ? { ...prev, done: true, result } : prev);
    } catch (err) {
      appendLine(`⛔ ${err.message}`);
      setTransferModal(prev => prev ? { ...prev, done: true, result: { missing: [], aborted: false, copied: 0, skipped: 0, error: err.message } } : prev);
    }
  }, [project, mixerStates]);

  // ── Mixer state from scene ────────────────────────────────────────
  const handleMixerStateChange = useCallback((state) => {
    if (!selectedSongId) return;
    setMixerStates(prev => ({ ...prev, [selectedSongId]: state }));
    setDirtyIds(prev => new Set([...prev, selectedSongId]));
  }, [selectedSongId]);

  const handleMatrixChange = useCallback((newMatrix) => {
    if (!selectedSongId) return;
    setMixerStates(prev => ({
      ...prev, [selectedSongId]: { ...(prev[selectedSongId] ?? {}), matrix: newMatrix },
    }));
    setDirtyIds(prev => new Set([...prev, selectedSongId]));
  }, [selectedSongId]);

  const handleSlotUpdate = useCallback((slotIdx, slotData) => {
    if (!selectedSongId) return;
    const cacheKey = `${selectedSongId}_f${slotIdx}`;
    if (slotData.fileName === "" || slotData.fileName == null) {
      fileCache.current.delete(cacheKey);
    } else {
      platform.cacheFileFromPickResult(fileCache.current, cacheKey, slotData);
    }
    const { file: _file, filePath: _fp, ...serializableData } = slotData;
    setProject(prev => ({
      ...prev,
      songs: prev.songs.map(s => {
        if (s.id !== selectedSongId) return s;
        const slots = s.audioSlots ? [...s.audioSlots] : defaultAudioSlots();
        const existing = slots[slotIdx] ?? {};
        slots[slotIdx] = {
          ...existing,
          ...serializableData,
          fileUUID: serializableData.fileName
            ? (existing.fileUUID || genUUID())
            : null,
        };
        return { ...s, audioSlots: slots };
      }),
    }));
    setDirtyIds(prev => new Set([...prev, selectedSongId]));
    if (slotData.fileName === "" || slotData.fileName == null) {
      showInfo(`F${slotIdx + 1}: slot cleared.`, "info");
    } else if (slotData.warnings?.length > 0) {
      showInfo(`F${slotIdx + 1}: ${slotData.warnings.join(" · ")}`, "error");
    } else {
      showInfo(`F${slotIdx + 1}: ${slotData.fileName} (${slotData.stereo ? "stereo" : "mono"})`, "success");
    }
  }, [selectedSongId, showInfo]);

  // ── Scene config with saved state ────────────────────────────────
  const effectiveSceneCfg = useMemo(() => {
    const saved = selectedSongId ? mixerStates[selectedSongId] : null;
    if (!saved) return IDORU_SCENE_CONFIG;
    return {
      ...IDORU_SCENE_CONFIG,
      rightBank: {
        ...IDORU_SCENE_CONFIG.rightBank,
        channels: IDORU_SCENE_CONFIG.rightBank.channels.map((ch, i) => ({
          ...ch,
          initialDb:    saved.rightFaders?.[i]?.db    ?? ch.initialDb,
          initialMuted: saved.rightFaders?.[i]?.muted ?? false,
        })),
        modifier: { ...IDORU_SCENE_CONFIG.rightBank.modifier, initialDb: saved.modifierDb ?? 0 },
      },
    };
  }, [selectedSongId, mixerStates]);

  const savedState        = selectedSongId ? mixerStates[selectedSongId] : null;
  const initialLinkedPairs = savedState?.linkedPairs ?? [false, false, false];
  const initialMatrix      = savedState?.matrix      ?? null;

  // ── CRUD — Playlists ──────────────────────────────────────────────
  const handleSelectPlaylist = (id) => { setSelectedPlId(id); setSongId(null); };

  const handleSavePlaylist = ({ id, name }) => {
    setProject(p => ({
      ...p,
      playlists: id ? p.playlists.map(pl => pl.id === id ? { ...pl, name } : pl)
                    : [...p.playlists, { id: genId(), uuid: genUUID(), name }],
    }));
    setPlForm(null);
    setDirtyIds(prev => new Set([...prev, "__meta"]));
  };

  const handleDeletePlaylist = (id) => {
    setConfirmModal({
      title: "Delete Playlist",
      message: "This will delete the playlist and all its songs. This cannot be undone.",
      confirmLabel: "Delete", danger: true,
      onConfirm: () => {
        setProject(p => ({ ...p, playlists: p.playlists.filter(pl => pl.id !== id), songs: p.songs.filter(s => s.playlistId !== id) }));
        if (selectedPlId === id) { setSelectedPlId(null); setSongId(null); }
        setDirtyIds(prev => new Set([...prev, "__meta"]));
        setConfirmModal(null); showInfo("Playlist deleted.", "info");
      },
    });
  };

  const handleDuplicatePlaylist = (id) => {
    const src = project.playlists.find(p => p.id === id);
    if (!src || project.playlists.length >= 7) { showInfo("Max 7 playlists.", "error"); return; }
    const newPlId = genId();
    const srcSongs = project.songs.filter(s => s.playlistId === id);
    const newSongs = srcSongs.map(s => ({ ...s, id: genId(), playlistId: newPlId, name: `${s.name} copy` }));
    setProject(p => ({
      ...p,
      playlists: [...p.playlists, { id: newPlId, name: `${src.name} copy` }],
      songs:     [...p.songs, ...newSongs],
    }));
    setDirtyIds(prev => new Set([...prev, "__meta"]));
    showInfo(`Duplicated "${src.name}".`, "success");
  };

  const handleMovePlaylists = (idx, dir) => {
    setProject(p => {
      const pls  = [...p.playlists];
      const swap = idx + dir;
      if (swap < 0 || swap >= pls.length) return p;
      [pls[idx], pls[swap]] = [pls[swap], pls[idx]];
      return { ...p, playlists: pls };
    });
    setDirtyIds(prev => new Set([...prev, "__meta"]));
  };

  // ── CRUD — Songs ──────────────────────────────────────────────────
  const handleSaveSong = useCallback((songData) => {
    const { playlistIds = [selectedPlId], presetId, _slotFiles, _midiFile, ...rest } = songData;
    const isNew = !rest.id;

    // Resolve preset mixer state if selected
    let presetMixerState = null;
    if (isNew && presetId) {
      const preset = platform.getInitialPresets().find(p => p.id === presetId);
      if (preset) {
        presetMixerState = {
          matrix:      preset.matrix,
          leftMutes:   preset.leftMutes,
          rightFaders: preset.rightFaders,
          linkedPairs: preset.linkedPairs,
          modifierDb:  preset.modifierDb,
        };
      }
    }

    if (isNew) {
      // Helper to ensure each audio slot has a stable fileUUID
      const slotsWithUUIDs = (rest.audioSlots ?? defaultAudioSlots()).map(sl => ({
        ...sl,
        fileUUID: sl.fileUUID || (sl.fileName ? genUUID() : null),
      }));

      const newSongs = playlistIds.map(() => ({
        ...rest,
        id:         genId(),
        uuid:       genUUID(),
        playlistId: playlistIds[0],
        audioSlots: slotsWithUUIDs,
        midiFileUUID: rest.midiFile ? genUUID() : null,
      })).map((s, i) => ({ ...s, playlistId: playlistIds[i] }));

      // Cache file references for each new song
      newSongs.forEach(s => {
        if (_slotFiles) {
          _slotFiles.forEach((f, idx) => {
            if (f) platform.cacheFileFromPickResult(fileCache.current, `${s.id}_f${idx}`,
              { file: f instanceof File ? f : null, filePath: typeof f === "string" ? f : null });
          });
        }
        if (_midiFile) platform.cacheFileFromPickResult(fileCache.current, `${s.id}_midi`,
          { file: _midiFile instanceof File ? _midiFile : null, filePath: typeof _midiFile === "string" ? _midiFile : null });
      });

      setProject(p => ({ ...p, songs: [...p.songs, ...newSongs] }));
      if (presetMixerState) {
        const updates = {};
        newSongs.forEach(s => { updates[s.id] = presetMixerState; });
        setMixerStates(prev => ({ ...prev, ...updates }));
      }
      setDirtyIds(prev => {
        const next = new Set([...prev, "__meta"]);
        newSongs.forEach(s => next.add(s.id));
        return next;
      });
      // Auto-select the first new song so mixer strips show immediately
      setSongId(newSongs[0].id);
      if (newSongs[0].playlistId) setSelectedPlId(newSongs[0].playlistId);
    } else {
      // Editing existing song — update file cache
      if (_slotFiles) {
        _slotFiles.forEach((f, idx) => {
          if (f) platform.cacheFileFromPickResult(fileCache.current, `${rest.id}_f${idx}`,
            { file: f instanceof File ? f : null, filePath: typeof f === "string" ? f : null });
        });
      }
      if (_midiFile) platform.cacheFileFromPickResult(fileCache.current, `${rest.id}_midi`,
        { file: _midiFile instanceof File ? _midiFile : null, filePath: typeof _midiFile === "string" ? _midiFile : null });
      // Ensure uuid and file UUIDs are preserved/assigned on edit
      setProject(p => ({ ...p, songs: p.songs.map(s => {
        if (s.id !== rest.id) return s;
        const updatedSlots = (rest.audioSlots ?? s.audioSlots ?? defaultAudioSlots()).map((sl, i) => ({
          ...sl,
          fileUUID: sl.fileUUID || (sl.fileName ? (s.audioSlots?.[i]?.fileUUID || genUUID()) : null),
        }));
        return {
          ...rest,
          uuid:         s.uuid || genUUID(),
          playlistId:   s.playlistId,
          audioSlots:   updatedSlots,
          midiFileUUID: rest.midiFile ? (s.midiFileUUID || genUUID()) : null,
        };
      })}));
      setDirtyIds(prev => new Set([...prev, rest.id]));
    }
    setSongForm(null);
    showInfo(isNew ? `Song added to ${playlistIds.length} playlist(s).` : "Song updated.", "success");
  }, [selectedPlId, showInfo, setSongId, setSelectedPlId]);

  const handleDeleteSong = (id) => {
    setProject(p => ({ ...p, songs: p.songs.filter(s => s.id !== id) }));
    if (selectedSongId === id) setSongId(null);
    setDirtyIds(prev => new Set([...prev, id]));
    showInfo("Song deleted.", "info");
  };

  const handleDuplicateSong = (id) => {
    const src = project.songs.find(s => s.id === id);
    if (!src) return;
    const sibs = project.songs.filter(s => s.playlistId === src.playlistId);
    if (sibs.length >= 40) { showInfo("Max 40 songs per playlist.", "error"); return; }
    const newId = genId();
    setProject(p => ({ ...p, songs: [...p.songs, { ...src, id: newId, name: `${src.name} copy` }] }));
    if (mixerStates[id]) setMixerStates(prev => ({ ...prev, [newId]: { ...mixerStates[id] } }));
    setDirtyIds(prev => new Set([...prev, newId, "__meta"]));
    showInfo(`Duplicated "${src.name}".`, "success");
  };

  const handleMoveSongs = (idx, dir) => {
    setProject(p => {
      const songs      = [...p.songs];
      const inPlaylist = songs.filter(s => s.playlistId === selectedPlId);
      const absIdx     = songs.indexOf(inPlaylist[idx]);
      const swapLocal  = idx + dir;
      if (swapLocal < 0 || swapLocal >= inPlaylist.length) return p;
      const absSwap    = songs.indexOf(inPlaylist[swapLocal]);
      [songs[absIdx], songs[absSwap]] = [songs[absSwap], songs[absIdx]];
      return { ...p, songs };
    });
    setDirtyIds(prev => new Set([...prev, "__meta"]));
  };

  const helpContext   = selectedSongId ? { type: "song" } : selectedPlId ? { type: "playlist" } : { type: "none" };
  const dirty         = dirtyIds.size > 0;
  const currentMixerState = selectedSongId ? (mixerStates[selectedSongId] ?? {}) : {};

  return (
    <div className="idoru-app">
      <ToolBar
        onSave={handleSave} onLoad={handleLoad} onTransfer={handleTransfer}
        onSwitchView={() => setViewMode(v => v === "classic" ? "matrix" : "classic")}
        viewMode={viewMode} dirty={dirty}
        onExport={handleExport} onImport={handleImport}
        onNewSession={handleNewSession} onSavePreset={handleSavePreset}
        onScan={handleScan} onFirmware={() => setFirmwareModal(true)}
        theme={theme} onToggleTheme={handleToggleTheme}
      />
      <div className="disclaimer-bar">
        THIS IS 3RD-PARTY SOFTWARE UNRELATED TO IDORU LIVE UG. IN CASE OF ANY ISSUES WITH THIS APPLICATION, DO NOT CONTACT IDORU LIVE UG TEAM — CONTACT&nbsp;
        <a href="mailto:barney.estrada@bastardizer.cz" className="disclaimer-link">barney.estrada@bastardizer.cz</a>.
        FOR MORE INFO ABOUT CIDORU APP PLEASE VISIT <a href="https://dev.grinware.cz" target="_blank" className="disclaimer-link">DEV.GRINWARE.CZ</a>.
      </div>

      <div className="main-layout">
        <div className="left-column">
          <PlaylistPane playlists={project.playlists} selectedId={selectedPlId}
            onSelect={handleSelectPlaylist}
            onAdd={() => setPlForm({ id: null, name: "" })}
            onEdit={(pl) => setPlForm({ ...pl })}
            onDelete={handleDeletePlaylist}
            onDuplicate={handleDuplicatePlaylist}
            onMoveUp={(idx) => handleMovePlaylists(idx, -1)}
            onMoveDown={(idx) => handleMovePlaylists(idx, 1)}
          />

          <SongsPane songs={songsInPlaylist} selectedId={selectedSongId} disabled={!selectedPlId}
            onSelect={setSongId}
            onAdd={() => setSongForm({ _new: true })}
            onEdit={(s) => setSongForm({ ...s })}
            onDelete={handleDeleteSong}
            onDuplicate={handleDuplicateSong}
            onMoveUp={(idx) => handleMoveSongs(idx, -1)}
            onMoveDown={(idx) => handleMoveSongs(idx, 1)}
          />
        </div>

        <div className={`mixer-pane${!selectedSongId ? " mixer-pane--disabled" : ""}`}>
          {!selectedSongId && <div className="mixer-disabled-msg">Select a song to activate the mixer</div>}

          {viewMode === "classic" && (
            <IdoruScene
              key={selectedSongId ?? "__default"}
              sceneCfg={effectiveSceneCfg}
              initialLinkedPairs={initialLinkedPairs}
              initialMatrix={initialMatrix}
              onStateChange={handleMixerStateChange}
              audioSlots={selectedSong?.audioSlots ?? null}
              onSlotUpdate={selectedSongId ? handleSlotUpdate : null}
              kbDisabled={!!(playlistForm || songForm || presetForm || scanModal || confirmModal || firmwareModal || transferModal)}
            />
          )}

          {viewMode === "matrix" && (
            <MatrixView
              song={selectedSong}
              matrix={currentMixerState.matrix ?? null}
              linkedPairs={initialLinkedPairs}
              onChange={handleMatrixChange}
              disabled={!selectedSongId}
            />
          )}
        </div>

        <HelpPane context={helpContext} viewMode={viewMode} />
      </div>

      <InfoBar message={infoMsg} />

      {/* Modals */}
      {playlistForm   && <PlaylistForm data={playlistForm} onSave={handleSavePlaylist} onCancel={() => setPlForm(null)} />}
      {songForm       && (
        <SongForm
          song={songForm.id ? songForm : null}
          allPlaylists={project.playlists}
          currentPlaylistId={selectedPlId}
          onSave={handleSaveSong}
          onCancel={() => setSongForm(null)}
        />
      )}
      {transferModal  && <TransferModal lines={transferModal.lines} done={transferModal.done} result={transferModal.result} onClose={() => setTransferModal(null)} />}
      {presetForm     && <SavePresetModal onSave={handleConfirmPreset} onCancel={() => setPresetForm(false)} />}
      {scanModal      && <ScanModal results={scanModal} onRelink={handleRelink} onScanFolder={handleScanFolder} onClose={() => setScanModal(null)} />}
      {firmwareModal  && <FirmwareModal onClose={() => setFirmwareModal(false)} />}
      {welcomeModal   && <WebWelcomeModal onClose={() => setWelcomeModal(false)} />}
      {confirmModal   && (
        <ConfirmModal
          title={confirmModal.title} message={confirmModal.message}
          confirmLabel={confirmModal.confirmLabel} danger={confirmModal.danger}
          onConfirm={confirmModal.onConfirm} onCancel={() => setConfirmModal(null)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
//  MixConsole — generic (kept for non-Idoru use)
// ═══════════════════════════════════════════════════════════════════
const NAME_POOL = ["KICK","SNARE","HH","BASS","GTR L","GTR R","VOX","AUX","CH 9","CH10","CH11","CH12","CH13","CH14","CH15","CH16"];
function autoNames(n) { return Array.from({ length: n }, (_, i) => NAME_POOL[i] ?? `CH${i+1}`); }

export function MixConsole({ banks = [], onFaderChange, onMuteChange, cfg = CONFIG, showVu = true }) {
  const [activeKey, setActiveKey] = useState(null);
  return (
    <div className="mix-console">
      {banks.map((bDef, bIdx) => {
        const chDefs = bDef.channels ?? autoNames(8).map(l => ({ label: l, initialDb: 0 }));
        return (
          <div key={bIdx} className="bank">
            <div className="bank-header">
              <span className="bank-number">B{bIdx+1}</span>
              {bDef.label && <span className="bank-label">{bDef.label}</span>}
              <span className="bank-fader-count">{chDefs.length} ch</span>
            </div>
            <div className="bank-strips">
              {chDefs.map((ch, cIdx) => (
                <ChannelStrip key={cIdx} label={ch.label} initialDb={ch.initialDb ?? 0}
                  bank={bIdx+1} cfg={cfg} showVu={showVu}
                  isActive={activeKey === `${bIdx}-${cIdx}`}
                  onActivate={() => setActiveKey(`${bIdx}-${cIdx}`)}
                  onFaderChange={onFaderChange} onMuteChange={onMuteChange} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
