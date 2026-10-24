/**
 * What the plugin reads from Windows: running processes, and the local Steam
 * library. Nothing here writes anything or talks to the network.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { NOT_A_GAME } from "./known-games";

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : String(stdout));
    });
  });
}

/** Lowercase executable names of every running process. */
export async function listProcesses(): Promise<Set<string>> {
  const names = new Set<string>();
  if (process.platform !== "win32") return names;
  const out = await run("tasklist", ["/fo", "csv", "/nh"]);
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

async function regValue(key: string, value: string): Promise<string> {
  if (process.platform !== "win32") return "";
  const out = await run("reg", ["query", key, "/v", value]);
  const m = new RegExp(`${value}\\s+REG_\\w+\\s+(.*)`, "i").exec(out);
  return m ? m[1].trim() : "";
}

/** The app id Steam says is running right now, or 0. */
export async function steamRunningAppId(): Promise<number> {
  const v = await regValue("HKCU\\Software\\Valve\\Steam", "RunningAppID");
  const n = v.startsWith("0x") ? parseInt(v, 16) : parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

export interface SteamGame {
  appId: number;
  name: string;
  /** Lowercase executable names found in the install folder. */
  exes: string[];
}

/**
 * App ids that are Steam tooling or always-on desktop apps, not games: a
 * desktop pet or a wallpaper app "running" all day is not a gaming session.
 */
const STEAM_NOT_GAMES = new Set([
  228980, 1070560, 1391110, 1493710, 1628350, 2180100, 2805730, 3658110, // runtimes, redistributables
  3419430, // Bongo Cat
  431960, // Wallpaper Engine
  993090, // Lossless Scaling
  629520, // Soundpad
  1486350, // VRoid Studio
  250820, // SteamVR
  365670, // Blender
  388080, // Borderless Gaming
]);

/** Every installed Steam game in every library folder, with its executables. */
export async function scanSteamLibrary(): Promise<SteamGame[]> {
  let steam = await regValue("HKCU\\Software\\Valve\\Steam", "SteamPath");
  if (!steam) steam = "C:/Program Files (x86)/Steam";
  // Keyed case-insensitively: the registry and the .vdf spell the same folder differently.
  const libraries = new Map<string, string>();
  const addLib = (p: string) => libraries.set(path.normalize(p).toLowerCase(), path.normalize(p));
  addLib(steam);
  try {
    const vdf = fs.readFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8");
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) addLib(m[1].replace(/\\\\/g, "\\"));
  } catch {
    // No Steam, or no library file: the built-in list still works.
  }

  const games: SteamGame[] = [];
  const seen = new Set<number>();
  for (const lib of libraries.values()) {
    const apps = path.join(lib, "steamapps");
    let files: string[] = [];
    try {
      files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const acf = fs.readFileSync(path.join(apps, f), "utf8");
        const appId = Number(/"appid"\s+"(\d+)"/.exec(acf)?.[1] ?? 0);
        const name = /"name"\s+"([^"]+)"/.exec(acf)?.[1] ?? "";
        const dir = /"installdir"\s+"([^"]+)"/.exec(acf)?.[1] ?? "";
        if (!appId || !name || !dir || seen.has(appId) || STEAM_NOT_GAMES.has(appId) || /redistributable|proton|steamworks|steam linux runtime/i.test(name)) continue;
        seen.add(appId);
        games.push({ appId, name, exes: findExes(path.join(apps, "common", dir)) });
      } catch {
        // One broken manifest should not hide the others.
      }
    }
  }
  return games;
}

/** Game executables up to three folders deep, skipping launchers and tools. */
function findExes(root: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const lower = e.name.toLowerCase();
      if (e.isDirectory()) {
        if (depth < 3 && !/^(_commonredist|redist|directx|vcredist|support|tools|engine\\extras)$/.test(lower)) {
          walk(path.join(dir, e.name), depth + 1);
        }
      } else if (lower.endsWith(".exe") && !NOT_A_GAME.some((w) => lower.includes(w))) {
        found.add(lower);
      }
    }
  };
  walk(root, 0);
  return [...found].slice(0, 20);
}
