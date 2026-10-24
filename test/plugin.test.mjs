/**
 * Tests for Game Companion.
 *
 * `pretest` bundles `src/index.ts` with the SDK left EXTERNAL, so the plugin
 * under test and the harness testing it share one copy of the SDK.
 *
 * The companion itself is driven with a fake clock and a fake process list,
 * so these tests never touch the real history file or the real processes.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

process.env.ASTRA_GAME_COMPANION_DATA = "memory";
process.env.ASTRA_GAME_COMPANION_NO_POLL = "1";

const require = createRequire(import.meta.url);
const { app, Companion, Store, isNight } = require("../dist/plugin.cjs");
const { Harness } = require("astra-plugin-sdk/testing");

const MIN = 60_000;

/** A companion whose world is entirely in our hands. */
function rig({ steam = [], appId = 0 } = {}) {
  const world = {
    t: new Date(2026, 9, 24, 18, 0).getTime(),
    procs: new Set(["explorer.exe"]),
    appId,
    said: [],
    triggers: [],
    fetched: [],
    fetchReply: null,
  };
  const c = new Companion(new Store(null), {
    now: () => world.t,
    listProcesses: async () => world.procs,
    runningAppId: async () => world.appId,
    scanSteam: async () => steam,
    say: async (text) => {
      world.said.push(text);
      return `reply ${world.said.length}`;
    },
    fireTrigger: async (type, payload) => void world.triggers.push({ type, payload }),
    fetchJson: async (url) => {
      world.fetched.push(url);
      return world.fetchReply;
    },
    log: () => {},
  });
  c.language = "ru";
  const settle = () => new Promise((r) => setTimeout(r, 10));
  const step = async (minutes) => {
    world.t += minutes * MIN;
    await c.tick();
    await settle();
  };
  return { c, world, step, settle };
}

test("a known game is detected, commented on, and summarised when it closes", async () => {
  const { c, world, step } = rig();
  await step(0);
  assert.equal(c.current, null);
  assert.equal(world.said.length, 0);

  world.procs.add("dota2.exe");
  await step(0);
  assert.equal(c.current.game, "Dota 2");
  assert.equal(world.triggers[0].type, "game_started");
  assert.match(world.said[0], /Dota 2/);

  await step(135);
  world.procs.delete("dota2.exe");
  await step(0.1); // one missed poll is not the end: it could be a restart
  assert.ok(c.current);
  await step(0.1);
  assert.equal(c.current, null);
  const summary = world.said.at(-1);
  assert.match(summary, /2 часа 15 минут/);
  assert.equal(c.store.data.sessions.length, 1);
  assert.equal(world.triggers.at(-1).type, "game_stopped");
});

test("the start line avoids repeating earlier replies", async () => {
  const { c, world, step } = rig();
  world.procs.add("dota2.exe");
  await step(0);
  world.procs.delete("dota2.exe");
  await step(1);
  await step(1);
  world.procs.add("dota2.exe");
  await step(1);
  assert.match(world.said.at(-1), /Не повторяй эти фразы: «reply 1»/);
});

test("break reminders: after the threshold, then at most hourly", async () => {
  const { c, world, step } = rig();
  c.updateSettings({ breakAfterMin: 120, reactStart: false, reactNight: false });
  world.procs.add("eldenring.exe");
  await step(0);
  await step(119);
  assert.equal(world.said.length, 0);
  await step(1);
  assert.equal(world.said.length, 1);
  assert.match(world.said[0], /размяться/);
  await step(30);
  assert.equal(world.said.length, 1);
  await step(30);
  assert.equal(world.said.length, 2);
});

test("late night hint fires once per session", async () => {
  const { c, world, step } = rig();
  c.updateSettings({ reactStart: false, reactBreak: false, nightTime: "01:00" });
  world.t = new Date(2026, 9, 25, 0, 30).getTime();
  world.procs.add("cs2.exe");
  await step(0);
  assert.equal(world.said.length, 0);
  await step(31); // 01:01
  assert.equal(world.said.length, 1);
  assert.match(world.said[0], /спать/);
  await step(60);
  assert.equal(world.said.length, 1);
});

test("night window wraps past midnight and ends at 06:00", () => {
  const at = (h, m) => new Date(2026, 9, 24, h, m).getTime();
  assert.equal(isNight(at(23, 30), "23:00"), true);
  assert.equal(isNight(at(3, 0), "23:00"), true);
  assert.equal(isNight(at(6, 0), "23:00"), false);
  assert.equal(isNight(at(0, 59), "01:00"), false);
  assert.equal(isNight(at(1, 0), "01:00"), true);
  assert.equal(isNight(at(12, 0), "01:00"), false);
});

test("every reaction can be switched off", async () => {
  const { c, world, step } = rig();
  c.updateSettings({ reactStart: false, reactBreak: false, reactNight: false, reactStop: false, breakAfterMin: 15 });
  world.procs.add("dota2.exe");
  await step(0);
  await step(300);
  world.procs.delete("dota2.exe");
  await step(1);
  await step(1);
  assert.deepEqual(world.said, []);
  assert.equal(c.store.data.sessions.length, 1, "the history is still kept");
});

test("custom games win, and removed games stop being tracked", async () => {
  const { c, world, step } = rig();
  c.addGame({ process: "C:\\Games\\MyGame\\MyGame", name: "My Game" });
  assert.equal(c.store.data.customGames[0].process, "mygame.exe");
  world.procs.add("mygame.exe").add("dota2.exe");
  await step(0);
  assert.equal(c.current.game, "My Game");

  c.removeGame("mygame.exe");
  c.removeGame("dota2.exe");
  await step(1);
  await step(1);
  assert.equal(c.current, null);
  c.restoreGame("dota2.exe");
  await step(1);
  assert.equal(c.current.game, "Dota 2");
});

test("Steam library games are found by exe and by Steam's running app id", async () => {
  const steam = [
    { appId: 1245620, name: "ELDEN RING", exes: ["eldenring.exe", "start_protected_game.exe"] },
    { appId: 105600, name: "Terraria", exes: ["terraria.exe"] },
  ];
  const { c, world, step } = rig({ steam });
  await c.refreshSteam();
  world.procs.add("start_protected_game.exe");
  await step(0);
  assert.equal(c.current.game, "ELDEN RING");
  assert.equal(c.current.appId, 1245620);

  const r2 = rig({ steam, appId: 105600 });
  r2.world.procs.add("steam.exe");
  await r2.c.refreshSteam();
  await r2.step(0);
  assert.equal(r2.c.current.game, "Terraria");
});

test("new Steam achievements are cheered for; the ones already held are not", async () => {
  const steam = [{ appId: 1245620, name: "ELDEN RING", exes: ["eldenring.exe"] }];
  const { c, world, step } = rig({ steam });
  await c.refreshSteam();
  c.updateSettings({ reactStart: false, steamApiKey: "KEY123", steamId: "76561198000000000" });
  const ach = (list) => ({ playerstats: { achievements: list } });
  world.fetchReply = ach([{ apiname: "A", achieved: 1, name: "Старое" }, { apiname: "B", achieved: 0, name: "Новое" }]);
  world.procs.add("eldenring.exe");
  await step(0);
  assert.equal(world.fetched.length, 1);
  assert.match(world.fetched[0], /appid=1245620/);
  assert.equal(world.said.length, 0, "the baseline is silent");

  world.fetchReply = ach([{ apiname: "A", achieved: 1, name: "Старое" }, { apiname: "B", achieved: 1, name: "Новое" }]);
  await step(2);
  assert.equal(world.said.length, 1);
  assert.match(world.said[0], /«Новое»/);
  assert.doesNotMatch(world.said[0], /Старое/);
  assert.equal(world.triggers.at(-1).type, "achievement_unlocked");
});

test("without a Steam key the achievement check never runs", async () => {
  const steam = [{ appId: 1245620, name: "ELDEN RING", exes: ["eldenring.exe"] }];
  const { c, world, step } = rig({ steam });
  await c.refreshSteam();
  world.procs.add("eldenring.exe");
  await step(0);
  await step(10);
  assert.equal(world.fetched.length, 0);
});

test("stats: today, this week, the top game, and an ongoing session", async () => {
  const { c, world, step } = rig();
  c.updateSettings({ reactStart: false, reactStop: false });
  const day = new Date(2026, 9, 24).getTime(); // Saturday
  c.store.data.sessions.push(
    { game: "Dota 2", start: day - 2 * 24 * 60 * MIN + 10 * 60 * MIN, end: day - 2 * 24 * 60 * MIN + 12 * 60 * MIN },
    { game: "Elden Ring", start: day + 9 * 60 * MIN, end: day + 10 * 60 * MIN },
    { game: "Dota 2", start: day - 10 * 24 * 60 * MIN, end: day - 10 * 24 * 60 * MIN + 60 * MIN },
  );
  world.procs.add("eldenring.exe");
  await step(0);
  await step(30);
  const st = c.stats();
  assert.equal(st.todayMs, 90 * MIN);
  assert.equal(st.weekMs, 210 * MIN);
  assert.equal(st.top[0].game, "Dota 2");
  assert.equal(st.days.length, 7);
  assert.match(c.statsText("today"), /Всего сегодня: 1 час 30 минут/);
  assert.match(c.statsText("week"), /Dota 2: 2 часа/);
});

test("settings are bounded and validated", () => {
  const { c } = rig();
  c.updateSettings({ breakAfterMin: 1, nightTime: "25:99", steamId: "id 7656 x", reactStart: "yes" });
  const s = c.store.data.settings;
  assert.equal(s.breakAfterMin, 15);
  assert.equal(s.nightTime, "01:00");
  assert.equal(s.steamId, "7656");
  assert.equal(s.reactStart, true);
});

test("tools: get_current_game and get_gaming_stats", async () => {
  const h = await Harness.create(app).start();
  assert.deepEqual((await h.toolNames()).sort(), ["get_current_game", "get_gaming_stats"]);
  await h.assertSchemaAccepts("get_gaming_stats", { period: "week" });
  await h.assertSchemaRejects("get_gaming_stats", { period: "year" });

  const cur = await h.callTool("get_current_game", {});
  assert.equal(cur.success, true);
  assert.match(cur.result, /"playing":\s*false/);

  const stats = await h.callTool("get_gaming_stats", { period: "today" });
  assert.equal(stats.success, true);
});

test("the Games tab can read and change everything it shows", async () => {
  const h = await Harness.create(app).start();
  const settings = await h.callFromUi("getSettings", {});
  const view = typeof settings === "string" ? JSON.parse(settings) : settings;
  assert.ok(JSON.stringify(view).includes("builtinCount"));

  const added = await h.callFromUi("addGame", { process: "hades.exe", name: "Hades" });
  assert.match(JSON.stringify(added), /Hades/);
  const saved = await h.callFromUi("saveSettings", { steamApiKey: "SECRET", breakAfterMin: 90 });
  assert.doesNotMatch(JSON.stringify(saved), /SECRET/, "the key is never sent back to the page");
  assert.match(JSON.stringify(saved), /hasSteamKey\\?":\s*true/);
  assert.match(JSON.stringify(await h.callFromUi("getState", {})), /current/);
  assert.match(JSON.stringify(await h.callFromUi("getStats", {})), /todayMs/);
});

test("no config the daemon can deliver crashes this plugin", async () => {
  const h = await Harness.create(app).start();
  assert.deepEqual(await h.fuzzConfig(), []);
});
