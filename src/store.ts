/**
 * Everything the plugin remembers, in one JSON file.
 *
 * Settings live here rather than in `[config]` because the user edits them on
 * the plugin's own «Games» tab, and a plugin cannot write its `[config]`.
 * The file sits outside the plugin directory so an update does not wipe the
 * play history.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CustomGame {
  /** Executable name, lowercase, with `.exe` — e.g. `eldenring.exe`. */
  process: string;
  name: string;
}

export interface Session {
  game: string;
  /** Epoch ms. */
  start: number;
  /** Epoch ms. */
  end: number;
}

export interface Settings {
  reactStart: boolean;
  reactBreak: boolean;
  reactNight: boolean;
  reactStop: boolean;
  reactAchievements: boolean;
  /** Speak the reactions aloud, not just write them. */
  voice: boolean;
  /** Minutes of play before the first break reminder. */
  breakAfterMin: number;
  /** "HH:MM", local time. Night lasts from here until 06:00. */
  nightTime: string;
  steamApiKey: string;
  steamId: string;
}

export interface StoreData {
  version: 1;
  settings: Settings;
  customGames: CustomGame[];
  /** Built-in or Steam games the user removed from tracking (process names). */
  ignored: string[];
  sessions: Session[];
  /** The last few spoken start comments, so the AI can avoid repeating them. */
  recentLines: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  reactStart: true,
  reactBreak: true,
  reactNight: true,
  reactStop: true,
  reactAchievements: true,
  voice: true,
  breakAfterMin: 120,
  nightTime: "01:00",
  steamApiKey: "",
  steamId: "",
};

/** Keep about a year of history; older sessions are dropped on save. */
const MAX_SESSIONS = 5000;

export function defaultDataDir(): string {
  const base = process.env.APPDATA || path.join(os.homedir(), ".config");
  return path.join(base, "astra-game-companion");
}

function emptyData(): StoreData {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    customGames: [],
    ignored: [],
    sessions: [],
    recentLines: [],
  };
}

/** Coerce whatever is on disk into a valid StoreData. Never throws. */
export function normalize(raw: unknown): StoreData {
  const d = emptyData();
  if (!raw || typeof raw !== "object") return d;
  const r = raw as Record<string, unknown>;
  d.settings = sanitizeSettings({ ...DEFAULT_SETTINGS }, r.settings);
  if (Array.isArray(r.customGames)) {
    for (const g of r.customGames) {
      const c = sanitizeGame(g);
      if (c) d.customGames.push(c);
    }
  }
  if (Array.isArray(r.ignored)) d.ignored = r.ignored.filter((x): x is string => typeof x === "string");
  if (Array.isArray(r.sessions)) {
    for (const s of r.sessions) {
      if (!s || typeof s !== "object") continue;
      const o = s as Record<string, unknown>;
      if (typeof o.game === "string" && Number.isFinite(o.start) && Number.isFinite(o.end)) {
        d.sessions.push({ game: o.game, start: Number(o.start), end: Number(o.end) });
      }
    }
  }
  if (Array.isArray(r.recentLines)) d.recentLines = r.recentLines.filter((x): x is string => typeof x === "string").slice(-5);
  return d;
}

export function sanitizeGame(g: unknown): CustomGame | null {
  if (!g || typeof g !== "object") return null;
  const o = g as Record<string, unknown>;
  let proc = typeof o.process === "string" ? o.process.trim().toLowerCase() : "";
  const name = typeof o.name === "string" ? o.name.trim().slice(0, 80) : "";
  proc = path.basename(proc.replace(/\\/g, "/"));
  if (!proc || !name) return null;
  if (!proc.endsWith(".exe")) proc += ".exe";
  return { process: proc, name };
}

/** Apply a partial settings object, keeping only valid, bounded values. */
export function sanitizeSettings(base: Settings, patch: unknown): Settings {
  const out = { ...base };
  if (!patch || typeof patch !== "object") return out;
  const p = patch as Record<string, unknown>;
  for (const k of ["reactStart", "reactBreak", "reactNight", "reactStop", "reactAchievements", "voice"] as const) {
    if (typeof p[k] === "boolean") out[k] = p[k] as boolean;
  }
  if (typeof p.breakAfterMin === "number" && Number.isFinite(p.breakAfterMin)) {
    out.breakAfterMin = Math.min(720, Math.max(15, Math.round(p.breakAfterMin)));
  }
  if (typeof p.nightTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(p.nightTime)) out.nightTime = p.nightTime;
  if (typeof p.steamApiKey === "string") out.steamApiKey = p.steamApiKey.trim().slice(0, 64);
  if (typeof p.steamId === "string") out.steamId = p.steamId.trim().replace(/\D/g, "").slice(0, 20);
  return out;
}

export class Store {
  data: StoreData;
  private readonly file: string | null;

  /** `dir = null` keeps everything in memory (tests). */
  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, "data.json") : null;
    this.data = emptyData();
    if (!this.file) return;
    try {
      this.data = normalize(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      // First run, or an unreadable file: start clean rather than fail.
    }
  }

  save(): void {
    if (this.data.sessions.length > MAX_SESSIONS) {
      this.data.sessions = this.data.sessions.slice(-MAX_SESSIONS);
    }
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
    } catch {
      // A failed save loses at most the last change; the next save retries.
    }
  }
}
