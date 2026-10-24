// The «Games» tab: what is running now, play statistics, and settings.
// All state lives in the plugin process; this page asks for it through
// astra.callBackend and polls, so it needs no push permission.

const container = document.getElementById('app');

const STRINGS = {
  ru: {
    tabs: { now: 'Сейчас', stats: 'Статистика', settings: 'Настройки' },
    tabsLabel: 'Разделы',
    idleTitle: 'Игра не запущена',
    idleText: 'Запусти игру — Астра заметит её в течение нескольких секунд.',
    playing: 'Сейчас играешь',
    session: 'Сессия',
    ask: 'Задать вопрос по игре',
    askPlaceholder: 'Как пройти этого босса? Какой билд лучше?',
    askSend: 'Спросить',
    askWaiting: 'Астра думает…',
    askFailed: 'Не удалось получить ответ',
    askHint: 'Ответ придёт и в чат плагина, а при включённом голосе — вслух.',
    today: 'Сегодня', week: 'Эта неделя',
    last7: 'Последние 7 дней', topWeek: 'Топ игр за неделю', recent: 'Последние сессии',
    noStats: 'Пока нет сыгранных сессий.',
    reactions: 'Реакции Астры',
    rStart: 'Комментарий при запуске игры', rBreak: 'Напоминание о перерыве',
    rNight: 'Намёк, что пора спать', rStop: 'Итог при закрытии игры',
    rAch: 'Радоваться ачивкам Steam', voice: 'Говорить вслух',
    voiceDesc: 'Иначе Астра только пишет в чат плагина',
    breakAfter: 'Перерыв через, минут', breakDesc: 'Повтор не чаще раза в час',
    nightAt: '«Ночное» время', nightDesc: 'Один раз за сессию, до 6:00',
    games: 'Отслеживаемые игры',
    custom: 'Добавленные вручную', noCustom: 'Пока ничего не добавлено.',
    process: 'Имя процесса', processPh: 'game.exe', title: 'Название', titlePh: 'Моя игра',
    add: 'Добавить', remove: 'Убрать', restore: 'Вернуть',
    steamLib: (n) => `Библиотека Steam (${n})`, steamNone: 'Steam-игры не найдены на этом компьютере.',
    rescan: 'Пересканировать', builtin: (n) => `Плюс ${n} популярных игр распознаются сами.`,
    ignoredBuiltin: 'Отключённые встроенные',
    steam: 'Ачивки Steam',
    steamDesc: 'Необязательно. С ключом и SteamID Астра раз в 2 минуты проверяет новые достижения в текущей игре. Профиль должен быть публичным.',
    apiKey: 'Steam Web API ключ', apiKeySet: 'Ключ сохранён — введи новый, чтобы заменить',
    apiKeyPh: 'steamcommunity.com/dev/apikey', steamId: 'SteamID64', steamIdPh: '7656119…',
    save: 'Сохранить', saved: 'Сохранено', clearKey: 'Удалить ключ',
    steamOn: 'Включено', steamOff: 'Выключено',
    loadError: 'Не удалось связаться с плагином.', retry: 'Повторить',
    min: 'мин', h: 'ч',
    days: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'],
  },
  en: {
    tabs: { now: 'Now', stats: 'Statistics', settings: 'Settings' },
    tabsLabel: 'Sections',
    idleTitle: 'No game running',
    idleText: 'Start a game — Astra notices it within a few seconds.',
    playing: 'Now playing',
    session: 'Session',
    ask: 'Ask about this game',
    askPlaceholder: 'How do I beat this boss? Which build is best?',
    askSend: 'Ask',
    askWaiting: 'Astra is thinking…',
    askFailed: 'Could not get an answer',
    askHint: 'The answer also lands in the plugin chat, and is spoken when voice is on.',
    today: 'Today', week: 'This week',
    last7: 'Last 7 days', topWeek: 'Top games this week', recent: 'Recent sessions',
    noStats: 'No sessions played yet.',
    reactions: 'Astra reactions',
    rStart: 'Comment when a game starts', rBreak: 'Break reminder',
    rNight: 'Bedtime hint', rStop: 'Summary when a game closes',
    rAch: 'Cheer Steam achievements', voice: 'Speak aloud',
    voiceDesc: 'Otherwise Astra only writes in the plugin chat',
    breakAfter: 'Break after, minutes', breakDesc: 'Repeats at most once an hour',
    nightAt: 'Night time', nightDesc: 'Once per session, until 6:00',
    games: 'Tracked games',
    custom: 'Added by you', noCustom: 'Nothing added yet.',
    process: 'Process name', processPh: 'game.exe', title: 'Name', titlePh: 'My game',
    add: 'Add', remove: 'Remove', restore: 'Restore',
    steamLib: (n) => `Steam library (${n})`, steamNone: 'No Steam games found on this computer.',
    rescan: 'Rescan', builtin: (n) => `Plus ${n} popular games recognised automatically.`,
    ignoredBuiltin: 'Disabled built-in games',
    steam: 'Steam achievements',
    steamDesc: 'Optional. With a key and SteamID, Astra checks the current game for new achievements every 2 minutes. Your profile must be public.',
    apiKey: 'Steam Web API key', apiKeySet: 'Key saved — enter a new one to replace it',
    apiKeyPh: 'steamcommunity.com/dev/apikey', steamId: 'SteamID64', steamIdPh: '7656119…',
    save: 'Save', saved: 'Saved', clearKey: 'Remove key',
    steamOn: 'On', steamOff: 'Off',
    loadError: 'Could not reach the plugin.', retry: 'Retry',
    min: 'min', h: 'h',
    days: ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'],
  },
};

const call = (method, params = {}) => astra.callBackend(method, params);

try {
  const ui = await astra.loadUi({apiVersion: 1});
  const {h} = ui;
  const S = {
    tab: 'now', lang: 'ru', state: null, stats: null, cfg: null, error: '',
    question: '', ask: null, // {id, status, text}
    newProc: '', newName: '', apiKey: '', steamId: null, steamSaved: false, busy: '',
  };
  const t = () => STRINGS[S.lang.startsWith('ru') ? 'ru' : 'en'];
  let root;
  let skew = 0; // backend clock minus page clock

  const dur = (ms) => {
    const m = Math.round(ms / 60000);
    const hh = Math.floor(m / 60);
    return hh ? `${hh} ${t().h} ${m % 60} ${t().min}` : `${m} ${t().min}`;
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const pad = (n) => String(n).padStart(2, '0');
    return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
  };
  const when = (ts) => new Date(ts).toLocaleString(S.lang, {weekday: 'short', hour: '2-digit', minute: '2-digit'});

  async function load(what) {
    try {
      if (what === 'state' || what === 'all') {
        S.state = await call('getState');
        S.lang = S.state.language || S.lang;
        skew = S.state.now - Date.now();
      }
      if (what === 'stats' || what === 'all') S.stats = await call('getStats');
      if (what === 'settings' || what === 'all') {
        S.cfg = await call('getSettings');
        if (S.steamId === null) S.steamId = S.cfg.settings.steamId;
      }
      S.error = '';
    } catch (error) {
      S.error = String(error?.message || error);
    }
    render();
  }

  async function saveSettings(patch) {
    try {
      S.cfg = await call('saveSettings', patch);
      S.error = '';
    } catch (error) {
      S.error = String(error?.message || error);
    }
    render();
  }

  let numberTimer;
  function saveSoon(patch) {
    clearTimeout(numberTimer);
    numberTimer = setTimeout(() => saveSettings(patch), 500);
  }

  async function ask() {
    const q = S.question.trim();
    if (!q || S.ask?.status === 'pending') return;
    S.ask = {status: 'pending', text: ''};
    render();
    try {
      const {id} = await call('ask', {question: q});
      S.ask.id = id;
      const started = Date.now();
      while (S.ask?.id === id && Date.now() - started < 180000) {
        await new Promise((r) => setTimeout(r, 1000));
        const a = await call('answer', {id});
        if (a.status !== 'pending') {
          S.ask = {id, status: a.status, text: a.text};
          break;
        }
      }
      if (S.ask?.status === 'pending') S.ask = {status: 'error', text: ''};
    } catch (error) {
      S.ask = {status: 'error', text: String(error?.message || error)};
    }
    render();
  }

  // ---------- Now ----------
  function nowView() {
    const L = t();
    const cur = S.state?.current;
    if (!S.state) return h(ui.Spinner, null);
    const game = cur
      ? h(ui.Card, {padding: 'lg'},
          h('div', {className: 'stack'},
            h('div', {className: 'row'},
              h('span', {className: 'muted small'}, L.playing),
              cur.steam ? h(ui.Badge, {tone: 'info', size: 'sm'}, 'Steam') : null),
            h('div', {className: 'now-game'}, cur.game),
            h('div', null,
              h('div', {className: 'muted small'}, L.session),
              h('div', {className: 'timer', role: 'timer', 'aria-label': L.session}, clock(Date.now() + skew - cur.start)))))
      : h(ui.EmptyState, {icon: h(ui.Icon, {name: 'play', size: 28}), title: L.idleTitle, subtitle: L.idleText});

    const a = S.ask;
    const askCard = h(ui.Card, {padding: 'md'},
      h('div', {className: 'stack'},
        h('label', {htmlFor: 'q', style: {fontWeight: 600}}, L.ask),
        h('form', {className: 'row', onSubmit: (e) => { e.preventDefault(); ask(); }},
          h(ui.Input, {id: 'q', className: 'grow', value: S.question, placeholder: L.askPlaceholder, maxLength: 500,
            onChange: (v) => { S.question = v; render(); }}),
          h(ui.Button, {type: 'submit', variant: 'primary', loading: a?.status === 'pending',
            disabled: !S.question.trim() || a?.status === 'pending', iconLeft: h(ui.Icon, {name: 'send', size: 16})}, L.askSend)),
        h('div', {'aria-live': 'polite'},
          !a ? h('div', {className: 'muted small'}, L.askHint)
          : a.status === 'pending' ? h('div', {className: 'row muted'}, h(ui.Spinner, null), L.askWaiting)
          : a.status === 'done' ? h('div', {className: 'answer'}, a.text)
          : h('div', {role: 'alert', style: {color: 'var(--color-danger, var(--color-warning))'}}, L.askFailed + (a.text ? `: ${a.text}` : '')))));
    return h('div', {className: 'stack'}, game, askCard);
  }

  // ---------- Stats ----------
  function statsView() {
    const L = t();
    const st = S.stats;
    if (!st) return h(ui.Spinner, null);
    const empty = !st.weekMs && !st.recent.length;
    const max = Math.max(1, ...st.days.map((d) => d.ms));
    const topMax = Math.max(1, ...st.top.map((x) => x.ms));
    return h('div', {className: 'stack'},
      h('div', {className: 'metrics'},
        h(ui.Card, {padding: 'md'}, h('div', {className: 'muted small'}, L.today), h('div', {className: 'metric-value'}, dur(st.todayMs))),
        h(ui.Card, {padding: 'md'}, h('div', {className: 'muted small'}, L.week), h('div', {className: 'metric-value'}, dur(st.weekMs)))),
      empty ? h(ui.EmptyState, {icon: h(ui.Icon, {name: 'chart', size: 28}), title: L.noStats}) : [
        h(ui.Card, {padding: 'md', key: 'days'},
          h('div', {className: 'muted small', style: {marginBottom: 8}}, L.last7),
          h('div', {className: 'days', role: 'list', 'aria-label': L.last7},
            st.days.map((d) => {
              const dow = (new Date(d.date).getDay() + 6) % 7;
              return h('div', {className: 'day', role: 'listitem', key: d.date, title: dur(d.ms), 'aria-label': `${L.days[dow]}: ${dur(d.ms)}`},
                h('div', {className: 'day-bar' + (d.ms ? '' : ' zero'), style: {height: `${Math.max(2, (d.ms / max) * 80)}px`}}),
                h('div', {className: 'day-label'}, L.days[dow]));
            }))),
        st.top.length ? h(ui.Card, {padding: 'md', key: 'top'},
          h('div', {className: 'muted small', style: {marginBottom: 8}}, L.topWeek),
          h('ol', {className: 'top'}, st.top.map((g) => h('li', {key: g.game},
            h('span', {className: 'name', title: g.game}, g.game),
            h('span', {className: 'muted small'}, dur(g.ms)),
            h('div', {className: 'track', 'aria-hidden': 'true'}, h('div', {className: 'fill', style: {width: `${(g.ms / topMax) * 100}%`}})))))) : null,
        st.recent.length ? h(ui.Card, {padding: 'md', key: 'recent'},
          h('div', {className: 'muted small', style: {marginBottom: 4}}, L.recent),
          h('ul', {className: 'list'}, st.recent.map((s) => h('li', {key: s.start},
            h('span', {className: 'name', title: s.game}, s.game),
            h('span', {className: 'meta'}, when(s.start)),
            h('span', {className: 'meta'}, dur(s.end - s.start)))))) : null,
      ]);
  }

  // ---------- Settings ----------
  function settingsView() {
    const L = t();
    const c = S.cfg;
    if (!c) return h(ui.Spinner, null);
    const st = c.settings;
    const toggle = (k, label, desc) => h(ui.SettingRow, {label, description: desc,
      control: h(ui.Toggle, {ariaLabel: label, checked: st[k], onChange: (v) => { st[k] = v; render(); saveSettings({[k]: v}); }})});
    const canAdd = S.newProc.trim() && S.newName.trim();
    const steamReady = c.settings.hasSteamKey && c.settings.steamId;

    return h('div', {className: 'stack'},
      h(ui.Section, {title: L.reactions},
        toggle('reactStart', L.rStart),
        toggle('reactBreak', L.rBreak),
        h(ui.SettingRow, {label: L.breakAfter, description: L.breakDesc, htmlFor: 'brk',
          control: h(ui.NumberInput, {id: 'brk', value: st.breakAfterMin, min: 15, max: 720, step: 15, disabled: !st.reactBreak,
            onChange: (v) => { st.breakAfterMin = v; render(); saveSoon({breakAfterMin: v}); }})}),
        toggle('reactNight', L.rNight),
        h(ui.SettingRow, {label: L.nightAt, description: L.nightDesc, htmlFor: 'night',
          control: h(ui.Input, {id: 'night', type: 'time', value: st.nightTime, disabled: !st.reactNight, style: {width: 120},
            onChange: (v) => { st.nightTime = v; render(); if (/^\d\d:\d\d$/.test(v)) saveSoon({nightTime: v}); }})}),
        toggle('reactStop', L.rStop),
        toggle('reactAchievements', L.rAch),
        toggle('voice', L.voice, L.voiceDesc)),

      h(ui.Section, {title: L.games, description: L.builtin(c.builtinCount)},
        h('div', {className: 'stack'},
          h('div', null,
            h('div', {className: 'muted small'}, L.custom),
            c.custom.length
              ? h('ul', {className: 'list'}, c.custom.map((g) => h('li', {key: g.process},
                  h('span', {className: 'name'}, g.name),
                  h('span', {className: 'meta'}, g.process),
                  h(ui.IconButton, {label: `${L.remove}: ${g.name}`, size: 'sm', onClick: async () => { S.cfg = await call('removeGame', {key: g.process}); render(); }},
                    h(ui.Icon, {name: 'trash', size: 16})))))
              : h('div', {className: 'muted small', style: {padding: '6px 0'}}, L.noCustom)),
          h('form', {className: 'row', onSubmit: async (e) => {
              e.preventDefault();
              if (!canAdd) return;
              try {
                S.cfg = await call('addGame', {process: S.newProc, name: S.newName});
                S.newProc = ''; S.newName = ''; S.error = '';
              } catch (error) { S.error = String(error?.message || error); }
              render();
            }},
            h(ui.Input, {className: 'grow', 'aria-label': L.process, placeholder: L.processPh, value: S.newProc, onChange: (v) => { S.newProc = v; render(); }}),
            h(ui.Input, {className: 'grow', 'aria-label': L.title, placeholder: L.titlePh, value: S.newName, onChange: (v) => { S.newName = v; render(); }}),
            h(ui.Button, {type: 'submit', disabled: !canAdd, iconLeft: h(ui.Icon, {name: 'plus', size: 16})}, L.add)),

          h(ui.Advanced, {variant: 'whole', alwaysCollapsible: true, label: L.steamLib(c.steam.length)},
            h('div', {className: 'stack'},
              c.steam.length
                ? h(ui.ScrollArea, {className: 'scroll', orientation: 'vertical', scrollbar: true, 'aria-label': L.steamLib(c.steam.length), style: {maxHeight: 260}},
                    h('ul', {className: 'list'}, c.steam.map((g) => h('li', {key: g.key},
                      h('span', {className: 'name', style: g.ignored ? {opacity: .55} : null}, g.name),
                      h(ui.Toggle, {ariaLabel: g.name, checked: !g.ignored,
                        onChange: async (v) => { S.cfg = await call(v ? 'restoreGame' : 'removeGame', {key: g.key}); render(); }})))))
                : h('div', {className: 'muted small'}, L.steamNone),
              h('div', null, h(ui.Button, {size: 'sm', variant: 'secondary', loading: S.busy === 'rescan',
                iconLeft: h(ui.Icon, {name: 'refresh', size: 14}),
                onClick: async () => { S.busy = 'rescan'; render(); try { S.cfg = await call('rescanSteam'); } finally { S.busy = ''; render(); } }}, L.rescan)))),

          c.ignoredBuiltin.length ? h('div', null,
            h('div', {className: 'muted small'}, L.ignoredBuiltin),
            h('ul', {className: 'list'}, c.ignoredBuiltin.map((g) => h('li', {key: g.key},
              h('span', {className: 'name'}, g.name),
              h(ui.Button, {size: 'sm', variant: 'ghost', onClick: async () => { S.cfg = await call('restoreGame', {key: g.key}); render(); }}, L.restore))))) : null)),

      h(ui.Section, {title: L.steam, description: L.steamDesc,
          actions: h(ui.Badge, {tone: steamReady ? 'success' : 'neutral', size: 'sm'}, steamReady ? L.steamOn : L.steamOff)},
        h('form', {className: 'stack', onSubmit: async (e) => {
            e.preventDefault();
            await saveSettings({steamApiKey: S.apiKey, steamId: S.steamId ?? ''});
            S.apiKey = ''; S.steamSaved = true; render();
            setTimeout(() => { S.steamSaved = false; render(); }, 2500);
          }},
          h(ui.SettingRow, {label: L.apiKey, htmlFor: 'key', description: c.settings.hasSteamKey ? L.apiKeySet : null,
            control: h(ui.Input, {id: 'key', type: 'password', autoComplete: 'off', value: S.apiKey,
              placeholder: c.settings.hasSteamKey ? '••••••••••••' : L.apiKeyPh, onChange: (v) => { S.apiKey = v; render(); }})}),
          h(ui.SettingRow, {label: L.steamId, htmlFor: 'sid',
            control: h(ui.Input, {id: 'sid', inputMode: 'numeric', value: S.steamId ?? '', placeholder: L.steamIdPh,
              onChange: (v) => { S.steamId = v; render(); }})}),
          h('div', {className: 'row'},
            h(ui.Button, {type: 'submit', variant: 'primary'}, L.save),
            c.settings.hasSteamKey ? h(ui.Button, {type: 'button', variant: 'ghost', tone: 'danger',
              onClick: () => saveSettings({clearSteamKey: true})}, L.clearKey) : null,
            S.steamSaved ? h('span', {className: 'muted small', role: 'status'}, L.saved) : null))));
  }

  function render() {
    const L = t();
    const tree = h('div', null,
      h(ui.SegmentedControl, {className: 'tabs', mode: 'tabs', id: 'gc-tabs', panelId: 'gc-panel', ariaLabel: L.tabsLabel, value: S.tab,
        options: [{value: 'now', label: L.tabs.now}, {value: 'stats', label: L.tabs.stats}, {value: 'settings', label: L.tabs.settings}],
        onChange: (v) => { S.tab = v; render(); load(v === 'now' ? 'state' : v); }}),
      S.error ? h(ui.Card, {padding: 'sm', variant: 'subtle', role: 'alert', style: {marginBottom: 12}},
        h('div', {className: 'row'}, h(ui.Icon, {name: 'alert-triangle', size: 16}), h('span', {className: 'grow'}, `${L.loadError} ${S.error}`),
          h(ui.Button, {size: 'sm', variant: 'secondary', onClick: () => load('all')}, L.retry))) : null,
      h('div', {id: 'gc-panel', role: 'tabpanel'},
        S.tab === 'now' ? nowView() : S.tab === 'stats' ? statsView() : settingsView()));
    if (root) root.render(tree); else root = ui.mount(container, tree);
  }

  render();
  await load('all');
  // The timer ticks locally; the backend is asked every 5 s whether the game changed.
  const tick = setInterval(() => { if (S.tab === 'now' && S.state?.current) render(); }, 1000);
  const poll = setInterval(() => load(S.tab === 'now' ? 'state' : S.tab === 'stats' ? 'stats' : 'none'), 5000);
  window.addEventListener('pagehide', () => { clearInterval(tick); clearInterval(poll); root.unmount(); }, {once: true});
} catch (error) {
  container.textContent = 'Update Astra to use this interface. ' + error.message;
}
