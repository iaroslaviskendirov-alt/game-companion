/**
 * The game companion itself: notices games starting and stopping, keeps the
 * session history, and decides when Astra should say something.
 *
 * Everything it touches outside itself comes in through `Deps`, so the tests
 * drive it with a fake clock and a fake process list.
 */

import { KNOWN_GAMES } from "./known-games";
import { CustomGame, Session, Store, sanitizeGame, sanitizeSettings } from "./store";
import type { SteamGame } from "./system";

export interface Deps {
  now(): number;
  listProcesses(): Promise<Set<string>>;
  runningAppId(): Promise<number>;
  scanSteam(): Promise<SteamGame[]>;
  /** Hand one message to Astra's AI; resolves with the reply text. */
  say(text: string, voice: boolean): Promise<string>;
  fireTrigger(type: string, payload: Record<string, unknown>): Promise<void>;
  fetchJson(url: string): Promise<unknown>;
  log(msg: string): void;
}

export interface Detected {
  game: string;
  /** Process name, or `steam:<appid>` when only Steam knew. */
  key: string;
  appId: number;
}

interface Current extends Detected {
  start: number;
  missed: number;
  breakAt: number | null;
  nightDone: boolean;
  achBaseline: Set<string> | null;
  achCheckedAt: number;
}

const MIN = 60_000;
/** Polls a game may be missing before its session ends (rides out restarts). */
const MISSES_TO_STOP = 2;
const RECORD_MIN_MS = 1 * MIN;
const SUMMARY_MIN_MS = 3 * MIN;
const BREAK_REPEAT_MS = 60 * MIN;
const ACH_POLL_MS = 2 * MIN;
const NIGHT_ENDS_MIN = 6 * 60;

export function fmtDuration(ms: number, ru: boolean): string {
  const total = Math.max(0, Math.round(ms / MIN));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (ru) {
    const parts = [];
    if (h) parts.push(`${h} ${plural(h, "час", "часа", "часов")}`);
    if (m || !h) parts.push(`${m} ${plural(m, "минута", "минуты", "минут")}`);
    return parts.join(" ");
  }
  const parts = [];
  if (h) parts.push(`${h} h`);
  if (m || !h) parts.push(`${m} min`);
  return parts.join(" ");
}

function plural(n: number, one: string, few: string, many: string): string {
  const a = n % 10;
  const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

/** Is `t` inside the night window, from `nightTime` until 06:00? */
export function isNight(t: number, nightTime: string): boolean {
  const d = new Date(t);
  const minute = d.getHours() * 60 + d.getMinutes();
  const [h, m] = nightTime.split(":").map(Number);
  const from = h * 60 + m;
  if (from < NIGHT_ENDS_MIN) return minute >= from && minute < NIGHT_ENDS_MIN;
  return minute >= from || minute < NIGHT_ENDS_MIN;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeek(t: number): number {
  const d = new Date(startOfDay(t));
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

export type Period = "today" | "week" | "month";

export interface Stats {
  todayMs: number;
  weekMs: number;
  top: { game: string; ms: number }[];
  days: { date: number; ms: number }[];
  recent: Session[];
}

export class Companion {
  readonly store: Store;
  private readonly deps: Deps;
  language = "en";
  current: Current | null = null;
  steam: SteamGame[] = [];
  private steamByExe = new Map<string, SteamGame>();
  private steamById = new Map<number, SteamGame>();
  private queue: Promise<unknown> = Promise.resolve();
  private answers = new Map<string, { status: "pending" | "done" | "error"; text: string }>();
  private nextAsk = 1;
  lastError = "";

  constructor(store: Store, deps: Deps) {
    this.store = store;
    this.deps = deps;
  }

  get ru(): boolean {
    return this.language.toLowerCase().startsWith("ru");
  }

  async refreshSteam(): Promise<void> {
    try {
      this.steam = await this.deps.scanSteam();
    } catch (e) {
      this.deps.log(`steam scan failed: ${e}`);
      this.steam = [];
    }
    this.steamByExe.clear();
    this.steamById.clear();
    for (const g of this.steam) {
      this.steamById.set(g.appId, g);
      for (const exe of g.exes) {
        // An exe name two games share says nothing about which one is running.
        if (this.steamByExe.has(exe)) this.steamByExe.set(exe, { ...g, appId: -1 });
        else this.steamByExe.set(exe, g);
      }
    }
    for (const [exe, g] of this.steamByExe) if (g.appId === -1) this.steamByExe.delete(exe);
  }

  /** Which tracked game is running, if any, in priority order. */
  detect(procs: Set<string>, appId: number): Detected | null {
    const ignored = new Set(this.store.data.ignored);
    for (const g of this.store.data.customGames) {
      if (procs.has(g.process)) return { game: g.name, key: g.process, appId: 0 };
    }
    // Steam's own "running app" is trusted only while Steam itself runs: a
    // crashed client leaves the last value behind.
    const byId = appId && procs.has("steam.exe") ? this.steamById.get(appId) : undefined;
    if (byId && !ignored.has(`steam:${byId.appId}`)) {
      return { game: byId.name, key: `steam:${byId.appId}`, appId: byId.appId };
    }
    for (const p of procs) {
      const g = this.steamByExe.get(p);
      if (g && !ignored.has(`steam:${g.appId}`) && !ignored.has(p)) return { game: g.name, key: `steam:${g.appId}`, appId: g.appId };
    }
    for (const p of procs) {
      const name = KNOWN_GAMES[p];
      if (name && !ignored.has(p)) {
        const steam = this.steam.find((s) => s.name === name);
        return { game: name, key: p, appId: steam?.appId ?? 0 };
      }
    }
    return null;
  }

  /** One poll. Safe to call on a timer; never throws. */
  async tick(): Promise<void> {
    try {
      const [procs, appId] = await Promise.all([this.deps.listProcesses(), this.deps.runningAppId()]);
      const found = this.detect(procs, appId);
      const now = this.deps.now();
      const cur = this.current;

      if (cur && found && found.game === cur.game) {
        cur.missed = 0;
        if (!cur.appId && found.appId) cur.appId = found.appId;
      } else if (cur && found) {
        await this.stop(now);
        await this.begin(found, now);
      } else if (cur) {
        cur.missed += 1;
        if (cur.missed >= MISSES_TO_STOP) await this.stop(now);
      } else if (found) {
        await this.begin(found, now);
      }

      if (this.current) await this.during(now);
    } catch (e) {
      this.lastError = String(e);
      this.deps.log(`tick failed: ${e}`);
    }
  }

  private async begin(found: Detected, now: number): Promise<void> {
    const s = this.store.data.settings;
    const night = isNight(now, s.nightTime);
    this.current = {
      ...found,
      start: now,
      missed: 0,
      breakAt: null,
      nightDone: night && s.reactNight && s.reactStart,
      achBaseline: null,
      achCheckedAt: 0,
    };
    void this.deps.fireTrigger("game_started", { game: found.game, process: found.key }).catch(() => {});
    if (!s.reactStart) return;
    const playedBefore = this.store.data.sessions.some((x) => x.game === found.game);
    const recent = this.store.data.recentLines;
    const lateNote = night && s.reactNight;
    const text = this.ru
      ? `[Игровой компаньон] Я только что запустил игру «${found.game}»${playedBefore ? " (уже играл в неё раньше)" : " (впервые с тобой)"}. ` +
        `Скажи одну короткую живую фразу, как подруга-геймер рядом: поприветствуй игру, можно пошутить про неё. ` +
        (lateNote ? "Уже поздняя ночь — мягко, заботливо намекни, что стоит не засиживаться. " : "") +
        `Не больше 15 слов, без списков.` +
        (recent.length ? ` Не повторяй эти фразы: ${recent.map((r) => `«${r}»`).join("; ")}.` : "")
      : `[Game companion] I just launched "${found.game}"${playedBefore ? " (played it before)" : " (first time with you)"}. ` +
        `Say one short, lively line like a gamer friend sitting next to me: greet the game, a light joke is fine. ` +
        (lateNote ? "It is already late at night — gently, caringly hint that I shouldn't stay up too long. " : "") +
        `At most 15 words, no lists.` +
        (recent.length ? ` Do not repeat these lines: ${recent.map((r) => `"${r}"`).join("; ")}.` : "");
    void this.speak(text).then((reply) => {
      const line = reply.trim().replace(/\s+/g, " ").slice(0, 160);
      if (!line) return;
      this.store.data.recentLines = [...this.store.data.recentLines, line].slice(-5);
      this.store.save();
    });
  }

  private async stop(now: number): Promise<void> {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const ms = now - cur.start;
    const s = this.store.data.settings;
    if (ms >= RECORD_MIN_MS) {
      this.store.data.sessions.push({ game: cur.game, start: cur.start, end: now });
      this.store.save();
    }
    void this.deps.fireTrigger("game_stopped", { game: cur.game, minutes: Math.round(ms / MIN) }).catch(() => {});
    if (!s.reactStop || ms < SUMMARY_MIN_MS) return;
    const dur = fmtDuration(ms, this.ru);
    const today = this.stats(now).todayMs;
    const text = this.ru
      ? `[Игровой компаньон] Я закрыл «${cur.game}», сессия длилась ${dur} (за сегодня всего ${fmtDuration(today, true)}). ` +
        `Подведи итог одной короткой тёплой фразой, например «${dur} в ${cur.game}, неплохо». Не больше 15 слов.`
      : `[Game companion] I closed "${cur.game}" after ${dur} (${fmtDuration(today, false)} today in total). ` +
        `Sum it up in one short warm line, like "${dur} of ${cur.game}, not bad". At most 15 words.`;
    void this.speak(text);
  }

  private async during(now: number): Promise<void> {
    const cur = this.current!;
    const s = this.store.data.settings;
    const elapsed = now - cur.start;

    if (s.reactBreak && elapsed >= s.breakAfterMin * MIN && (cur.breakAt === null || now - cur.breakAt >= BREAK_REPEAT_MS)) {
      cur.breakAt = now;
      const dur = fmtDuration(elapsed, this.ru);
      void this.speak(
        this.ru
          ? `[Игровой компаньон] Я играю в «${cur.game}» уже ${dur} без перерыва. Мягко и по-дружески напомни размяться и попить воды. Одна-две короткие фразы, без нотаций.`
          : `[Game companion] I've been playing "${cur.game}" for ${dur} straight. Gently, like a friend, remind me to stretch and drink some water. One or two short sentences, no lecturing.`,
      );
    }

    if (s.reactNight && !cur.nightDone && isNight(now, s.nightTime)) {
      cur.nightDone = true;
      const clock = new Date(now).toTimeString().slice(0, 5);
      void this.speak(
        this.ru
          ? `[Игровой компаньон] Уже ${clock}, а я всё ещё играю в «${cur.game}». Заботливо и с юмором намекни, что пора бы спать. Одна короткая фраза.`
          : `[Game companion] It's ${clock} and I'm still playing "${cur.game}". Caringly, with a bit of humour, hint that it's time to sleep. One short sentence.`,
      );
    }

    if (s.reactAchievements && s.steamApiKey && s.steamId && cur.appId > 0 && now - cur.achCheckedAt >= ACH_POLL_MS) {
      cur.achCheckedAt = now;
      await this.checkAchievements(cur);
    }
  }

  private async checkAchievements(cur: Current): Promise<void> {
    const s = this.store.data.settings;
    const url =
      `https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?appid=${cur.appId}` +
      `&key=${encodeURIComponent(s.steamApiKey)}&steamid=${encodeURIComponent(s.steamId)}&l=${this.ru ? "russian" : "english"}`;
    let body: unknown;
    try {
      body = await this.deps.fetchJson(url);
    } catch (e) {
      this.deps.log(`achievements: ${String(e).replace(s.steamApiKey, "***")}`);
      return;
    }
    const list = (body as { playerstats?: { achievements?: unknown[] } })?.playerstats?.achievements;
    if (!Array.isArray(list)) return; // A game without achievements, or a private profile.
    const unlocked = new Map<string, string>();
    for (const a of list) {
      const o = a as Record<string, unknown>;
      if (o.achieved === 1 && typeof o.apiname === "string") unlocked.set(o.apiname, typeof o.name === "string" ? o.name : o.apiname);
    }
    if (!this.current || this.current !== cur) return;
    if (cur.achBaseline === null) {
      cur.achBaseline = new Set(unlocked.keys());
      return;
    }
    const fresh = [...unlocked].filter(([k]) => !cur.achBaseline!.has(k));
    for (const [k] of fresh) cur.achBaseline.add(k);
    if (!fresh.length) return;
    const names = fresh.map(([, n]) => n);
    for (const n of names) void this.deps.fireTrigger("achievement_unlocked", { game: cur.game, achievement: n }).catch(() => {});
    void this.speak(
      this.ru
        ? `[Игровой компаньон] Я только что получил ${names.length > 1 ? "достижения" : "достижение"} в «${cur.game}»: ${names.map((n) => `«${n}»`).join(", ")}. Порадуйся за меня вслух, коротко и искренне.`
        : `[Game companion] I just unlocked ${names.length > 1 ? "achievements" : "an achievement"} in "${cur.game}": ${names.map((n) => `"${n}"`).join(", ")}. Cheer for me, short and genuine.`,
    );
  }

  /** Messages go out one at a time: each waits for the previous reply. */
  private speak(text: string, voice = this.store.data.settings.voice): Promise<string> {
    const next = this.queue.then(() => this.deps.say(text, voice)).catch((e) => {
      this.lastError = String(e);
      this.deps.log(`say failed: ${e}`);
      return "";
    });
    this.queue = next;
    return next;
  }

  /** A question from the «Games» tab. Returns an id to poll with `answer()`. */
  ask(question: string): string {
    const q = question.trim().slice(0, 500);
    const id = String(this.nextAsk++);
    const game = this.current?.game;
    const text = this.ru
      ? `[Игровой компаньон] Вопрос${game ? ` по игре «${game}»` : ""}: ${q}\n` +
        `Если нужно — поищи в интернете${game ? ` с названием игры` : ""}. Ответь коротко (2–4 предложения), разговорно, ` +
        `без спойлеров сюжета, если я о них не просил.`
      : `[Game companion] Question${game ? ` about "${game}"` : ""}: ${q}\n` +
        `Search the web if needed${game ? " including the game's name" : ""}. Answer briefly (2–4 sentences), conversationally, ` +
        `with no story spoilers unless I asked for them.`;
    this.answers.set(id, { status: "pending", text: "" });
    void this.speak(text).then((reply) => {
      this.answers.set(id, reply ? { status: "done", text: reply } : { status: "error", text: this.lastError });
    });
    // Keep the map small: only the latest answers matter to the UI.
    if (this.answers.size > 20) this.answers.delete(this.answers.keys().next().value!);
    return id;
  }

  answer(id: string): { status: string; text: string } {
    return this.answers.get(id) ?? { status: "error", text: "unknown question" };
  }

  stats(now = this.deps.now()): Stats {
    const sessions = [...this.store.data.sessions];
    if (this.current) sessions.push({ game: this.current.game, start: this.current.start, end: now });
    const overlap = (s: Session, from: number, to: number) => Math.max(0, Math.min(s.end, to) - Math.max(s.start, from));
    const day0 = startOfDay(now);
    const week0 = startOfWeek(now);
    const per = new Map<string, number>();
    let todayMs = 0;
    let weekMs = 0;
    for (const s of sessions) {
      todayMs += overlap(s, day0, now);
      const w = overlap(s, week0, now);
      weekMs += w;
      if (w > 0) per.set(s.game, (per.get(s.game) ?? 0) + w);
    }
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(day0);
      d.setDate(d.getDate() - i);
      const from = d.getTime();
      const e = new Date(from);
      e.setDate(e.getDate() + 1);
      days.push({ date: from, ms: sessions.reduce((a, s) => a + overlap(s, from, Math.min(e.getTime(), now)), 0) });
    }
    return {
      todayMs,
      weekMs,
      top: [...per].map(([game, ms]) => ({ game, ms })).sort((a, b) => b.ms - a.ms).slice(0, 8),
      days,
      recent: this.store.data.sessions.slice(-10).reverse(),
    };
  }

  /** Plain-text stats for the assistant. */
  statsText(period: Period, now = this.deps.now()): string {
    const ru = this.ru;
    const sessions = [...this.store.data.sessions];
    if (this.current) sessions.push({ game: this.current.game, start: this.current.start, end: now });
    let from = startOfDay(now);
    if (period === "week") from = startOfWeek(now);
    if (period === "month") {
      const d = new Date(from);
      d.setDate(1);
      from = d.getTime();
    }
    const per = new Map<string, { ms: number; n: number }>();
    let total = 0;
    for (const s of sessions) {
      const ms = Math.max(0, Math.min(s.end, now) - Math.max(s.start, from));
      if (ms <= 0) continue;
      total += ms;
      const e = per.get(s.game) ?? { ms: 0, n: 0 };
      e.ms += ms;
      e.n += 1;
      per.set(s.game, e);
    }
    const label = ru ? { today: "сегодня", week: "на этой неделе", month: "в этом месяце" }[period] : { today: "today", week: "this week", month: "this month" }[period];
    if (!total) return ru ? `Игровых сессий ${label} не было.` : `No gaming sessions ${label}.`;
    const lines = [...per]
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([g, e]) => `- ${g}: ${fmtDuration(e.ms, ru)} (${e.n} ${ru ? plural(e.n, "сессия", "сессии", "сессий") : e.n === 1 ? "session" : "sessions"})`);
    const head = ru ? `Всего ${label}: ${fmtDuration(total, true)}.` : `Total ${label}: ${fmtDuration(total, false)}.`;
    const now_ = this.current ? (ru ? `\nСейчас идёт: ${this.current.game}.` : `\nPlaying now: ${this.current.game}.`) : "";
    return `${head}\n${lines.join("\n")}${now_}`;
  }

  addGame(input: unknown): CustomGame {
    const g = sanitizeGame(input);
    if (!g) throw new Error("bad game");
    const list = this.store.data.customGames.filter((x) => x.process !== g.process);
    list.push(g);
    this.store.data.customGames = list;
    this.store.data.ignored = this.store.data.ignored.filter((x) => x !== g.process);
    this.store.save();
    return g;
  }

  /** Stop tracking: deletes a custom game, or ignores a Steam/built-in one. */
  removeGame(key: string): void {
    const before = this.store.data.customGames.length;
    this.store.data.customGames = this.store.data.customGames.filter((x) => x.process !== key);
    if (this.store.data.customGames.length === before && !this.store.data.ignored.includes(key)) {
      this.store.data.ignored.push(key);
    }
    this.store.save();
  }

  restoreGame(key: string): void {
    this.store.data.ignored = this.store.data.ignored.filter((x) => x !== key);
    this.store.save();
  }

  updateSettings(patch: unknown): void {
    this.store.data.settings = sanitizeSettings(this.store.data.settings, patch);
    this.store.save();
  }
}
