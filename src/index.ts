/**
 * Game Companion — an Astra plugin.
 *
 * Notices which game is running, keeps a local play history, and has Astra
 * react like a gamer friend: a word when a game starts, a break reminder,
 * a bedtime nudge, a summary at the end, and cheers for Steam achievements.
 *
 * The plugin is a VALUE, exported from this module, and it starts only when
 * this file is the process entrypoint, so the tests can drive it in-process.
 */

import { key, plugin, s, tool, UiContrib, type PluginContext } from "astra-plugin-sdk";
import { Companion, fmtDuration, type Deps } from "./companion";
import { KNOWN_GAMES } from "./known-games";
import { defaultDataDir, Store } from "./store";
import { listProcesses, scanSteamLibrary, steamRunningAppId } from "./system";

export { Companion, isNight } from "./companion";
export { Store } from "./store";

const POLL_MS = 5_000;
const STEAM_RESCAN_MS = 10 * 60_000;

let ctxRef: PluginContext | null = null;

const deps: Deps = {
  now: () => Date.now(),
  listProcesses,
  runningAppId: steamRunningAppId,
  scanSteam: scanSteamLibrary,
  async say(text, voice) {
    const ctx = ctxRef;
    if (!ctx) throw new Error("not connected to Astra yet");
    let reply = "";
    for await (const chunk of ctx.sendChatMessage(text, { voiceEnabled: voice })) {
      if (chunk.error) throw new Error(chunk.error);
      if (chunk.text) reply += chunk.text;
      if (chunk.done) break;
    }
    return reply;
  },
  async fireTrigger(type, payload) {
    if (ctxRef) await ctxRef.fireTrigger(type, payload);
  },
  async fetchJson(url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  },
  log(msg) {
    void ctxRef?.warn(msg).catch(() => {});
  },
};

/** `ASTRA_GAME_COMPANION_DATA=memory` keeps tests off the real history file. */
const dataEnv = process.env.ASTRA_GAME_COMPANION_DATA;
export const companion = new Companion(new Store(dataEnv === "memory" ? null : dataEnv || defaultDataDir()), deps);

let pollTimer: NodeJS.Timeout | null = null;
let steamTimer: NodeJS.Timeout | null = null;
let polling = false;

function startLoops(): void {
  if (pollTimer) return;
  void companion.refreshSteam().then(() => companion.tick());
  pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    void companion.tick().finally(() => (polling = false));
  }, POLL_MS);
  steamTimer = setInterval(() => void companion.refreshSteam(), STEAM_RESCAN_MS);
  pollTimer.unref();
  steamTimer.unref();
}

function stopLoops(): void {
  if (pollTimer) clearInterval(pollTimer);
  if (steamTimer) clearInterval(steamTimer);
  pollTimer = steamTimer = null;
}

function state() {
  const cur = companion.current;
  const now = Date.now();
  return {
    language: companion.language,
    now,
    current: cur ? { game: cur.game, start: cur.start, steam: cur.appId > 0 } : null,
    lastError: companion.lastError,
  };
}

function settingsView() {
  const d = companion.store.data;
  const ignored = new Set(d.ignored);
  return {
    settings: { ...d.settings, steamApiKey: "", hasSteamKey: d.settings.steamApiKey.length > 0 },
    custom: d.customGames,
    steam: companion.steam.map((g) => ({ key: `steam:${g.appId}`, name: g.name, ignored: ignored.has(`steam:${g.appId}`) })),
    builtinCount: new Set(Object.values(KNOWN_GAMES)).size,
    ignoredBuiltin: d.ignored.filter((k) => KNOWN_GAMES[k]).map((k) => ({ key: k, name: KNOWN_GAMES[k] })),
  };
}

const ICON =
  "<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>" +
  "<path d='M7 8h10a4 4 0 0 1 4 4v1.5a3.5 3.5 0 0 1-6.3 2.1L13.5 14h-3l-1.2 1.6A3.5 3.5 0 0 1 3 13.5V12a4 4 0 0 1 4-4z'/>" +
  "<path d='M7.5 10.5v3M6 12h3'/><circle cx='16' cy='11' r='.6' fill='currentColor'/><circle cx='17.5' cy='13' r='.6' fill='currentColor'/></svg>";

export const app = plugin({
  tools: {
    // Astra lists most plugin tools in a searchable catalog rather than showing
    // them to the model, so the name and the first sentence must say on their
    // own when to reach for the tool — in Russian too, the user's language.
    get_current_game: tool({
      description:
        "Во что пользователь играет прямо сейчас (игра запущена на ПК) / What game the user is playing right now. " +
        "Call it BEFORE answering any question that could be about a game, even if no game is named: bosses, builds, " +
        "mods, items, quests, characters, weapons, vehicles, money, 'how do I pass…', 'where do I find…', 'which truck / " +
        "car / weapon is best', «как пройти», «какой билд», «где найти», «какие есть моды», «что лучше взять». " +
        "Then search the web with the game's name and answer in 2–4 spoken-friendly sentences, without story spoilers " +
        "unless the user asked for them.",
      run: (_args, ctx) => {
        companion.language = ctx.language || companion.language;
        const cur = companion.current;
        if (!cur) {
          return { playing: false, note: "No tracked game is running. Ask the user which game they mean." };
        }
        return {
          playing: true,
          game: cur.game,
          playing_for: fmtDuration(Date.now() - cur.start, companion.ru),
          how_to_answer:
            `Put "${cur.game}" into the web search query. Keep the answer short and spoken-friendly; no plot spoilers unless asked.`,
        };
      },
    }),
    get_gaming_stats: tool({
      description:
        "Сколько пользователь играл в игры и во что: сегодня, за неделю, за месяц / How long the user played games and which " +
        "ones, from the local play history. For «сколько я сегодня играл», «во что я больше всего играл на этой неделе», " +
        "'how much did I play today', 'what did I play most this week'.",
      input: s.object({
        period: s.enum(["today", "week", "month"], { description: "today, this calendar week (from Monday), or this month" }),
      }),
      run: ({ period }, ctx) => {
        companion.language = ctx.language || companion.language;
        return companion.statsText(period);
      },
    }),
  },

  triggers: {
    game_started: { label: "$trigger.game_started.label", iconSvg: ICON, fields: [] },
    game_stopped: { label: "$trigger.game_stopped.label", iconSvg: ICON, fields: [] },
    achievement_unlocked: { label: "$trigger.achievement_unlocked.label", iconSvg: ICON, fields: [] },
  },

  ui: {
    contributions: [{ ...UiContrib.page("games", key("ui.games.label"), "index.html", { iconSvg: ICON }), transparent: true }],
    onCall: {
      getState: () => state(),
      getStats: () => ({ language: companion.language, ...companion.stats() }),
      getSettings: () => settingsView(),
      saveSettings: (params) => {
        const p = (params ?? {}) as Record<string, unknown>;
        // An empty key field means "leave the stored key alone"; `clearSteamKey` removes it.
        const patch = { ...p };
        if (p.clearSteamKey === true) patch.steamApiKey = "";
        else if (typeof p.steamApiKey !== "string" || !p.steamApiKey.trim()) delete patch.steamApiKey;
        companion.updateSettings(patch);
        return settingsView();
      },
      addGame: (params) => {
        companion.addGame(params);
        return settingsView();
      },
      removeGame: (params) => {
        const k = String((params as { key?: unknown })?.key ?? "");
        if (k) companion.removeGame(k);
        return settingsView();
      },
      restoreGame: (params) => {
        const k = String((params as { key?: unknown })?.key ?? "");
        if (k) companion.restoreGame(k);
        return settingsView();
      },
      rescanSteam: async () => {
        await companion.refreshSteam();
        return settingsView();
      },
      ask: (params) => {
        const q = String((params as { question?: unknown })?.question ?? "").trim();
        if (!q) throw new Error("empty question");
        return { id: companion.ask(q) };
      },
      answer: (params) => companion.answer(String((params as { id?: unknown })?.id ?? "")),
    },
  },

  onStart: (ctx) => {
    ctxRef = ctx;
    companion.language = ctx.language || "en";
    if (process.env.ASTRA_GAME_COMPANION_NO_POLL !== "1") startLoops();
  },
  onLanguageChanged: (language) => {
    companion.language = language;
  },
  onShutdown: () => {
    stopLoops();
    // Close an open session so the time already played is not lost.
    if (companion.current && Date.now() - companion.current.start >= 60_000) {
      companion.store.data.sessions.push({ game: companion.current.game, start: companion.current.start, end: Date.now() });
      companion.store.save();
    }
  },
});

if (require.main === module) app.run();
