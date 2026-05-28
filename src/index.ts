type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    text?: string;
    date?: number;
  };
};

type MemoryKind = "note" | "task" | "calendar";

type ExtractedInfo = {
  summary: string;
  tags: string[];
  category: string;
  people: string[];
  places: string[];
  event_date: string | null;
  due_date: string | null;
};

type SearchItem = {
  kind: MemoryKind;
  id: string;
  original_text: string;
  summary: string | null;
  tags: string[] | null;
  category: string | null;
  date: string | null;
  score: number;
};

const GEMINI_FLASH_MODEL = "gemini-2.0-flash";
const GEMINI_EMBEDDING_MODEL = "text-embedding-004";
const EMBEDDING_DIMENSIONS = 768;
const MAX_TELEGRAM_LENGTH = 3900;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.TELEGRAM_SECRET_TOKEN || secret !== env.TELEGRAM_SECRET_TOKEN) {
        return new Response("Unauthorized", { status: 401 });
      }

      const update = (await request.json()) as TelegramUpdate;
      await handleTelegramUpdate(update, env);
      return json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    if (hourInTimezone(env) !== 8) return;
    await sendDailyBriefing(env);
  },
};

async function handleTelegramUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  const message = update.message;
  const text = message?.text?.trim();
  if (!message || !text) return;

  const chatId = String(message.chat.id);
  if (env.TELEGRAM_CHAT_ID && chatId !== env.TELEGRAM_CHAT_ID) {
    await sendTelegramMessage(env, chatId, "Questo bot e' configurato per una chat personale.");
    return;
  }

  await upsertTelegramUser(env, message);

  const [command, ...rest] = text.split(/\s+/);
  const body = rest.join(" ").trim();

  try {
    if (command === "/start") {
      await sendTelegramMessage(env, chatId, startText());
    } else if (command === "/help") {
      await sendTelegramMessage(env, chatId, helpText());
    } else if (command === "/nota") {
      await handleNote(env, chatId, body);
    } else if (command === "/task") {
      await handleTask(env, chatId, body);
    } else if (command === "/oggi") {
      await handleToday(env, chatId);
    } else if (command === "/cerca") {
      await handleSearch(env, chatId, body);
    } else {
      await sendTelegramMessage(env, chatId, "Comando non riconosciuto. Scrivi /help.");
    }
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(env, chatId, "Qualcosa non e' andato. Riprova tra poco.");
  }
}

async function handleNote(env: Env, chatId: string, text: string): Promise<void> {
  if (!text) {
    await sendTelegramMessage(env, chatId, "Uso: /nota testo della nota");
    return;
  }

  const today = todayInTimezone(env);
  const parsedDate = parseItalianDate(text, today);
  const info = await extractInfo(env, "note", text, parsedDate);
  const embedding = await createEmbedding(env, compactEmbeddingText(text, info));

  await supabaseInsert(env, "personal_memory", {
    telegram_chat_id: chatId,
    original_text: text,
    summary: info.summary,
    tags: info.tags,
    category: info.category,
    people: info.people,
    places: info.places,
    event_date: info.event_date,
    embedding,
  });

  await sendTelegramMessage(env, chatId, `Nota salvata.\n${formatSummaryLine(info)}`);
}

async function handleTask(env: Env, chatId: string, text: string): Promise<void> {
  if (!text) {
    await sendTelegramMessage(env, chatId, "Uso: /task testo del promemoria");
    return;
  }

  const today = todayInTimezone(env);
  const parsedDate = parseItalianDate(text, today);
  const info = await extractInfo(env, "task", text, parsedDate);
  const embedding = await createEmbedding(env, compactEmbeddingText(text, info));

  await supabaseInsert(env, "personal_tasks", {
    telegram_chat_id: chatId,
    original_text: text,
    summary: info.summary,
    due_date: info.due_date,
    status: "open",
    tags: info.tags,
    category: info.category,
    embedding,
  });

  const due = info.due_date ? `\nScadenza: ${formatDateIt(info.due_date)}` : "";
  await sendTelegramMessage(env, chatId, `Task salvato.${due}\n${formatSummaryLine(info)}`);
}

async function handleToday(env: Env, chatId: string): Promise<void> {
  const today = todayInTimezone(env);
  const [events, tasks, notes] = await Promise.all([
    fetchCalendarEvents(env, today),
    fetchTasksByDate(env, chatId, today),
    fetchNotesByDate(env, chatId, today),
  ]);

  await sendTelegramMessage(env, chatId, buildTodayText(today, events, tasks, notes));
}

async function handleSearch(env: Env, chatId: string, query: string): Promise<void> {
  if (!query) {
    await sendTelegramMessage(env, chatId, "Uso: /cerca testo da cercare");
    return;
  }

  const embedding = await createEmbedding(env, query);
  const [keyword, vector] = await Promise.all([
    searchKeyword(env, chatId, query),
    searchVector(env, chatId, embedding),
  ]);
  const candidates = mergeSearchResults([...keyword, ...vector]).slice(0, 10);

  if (candidates.length === 0) {
    await sendTelegramMessage(env, chatId, "Non ho trovato nulla di rilevante nella memoria.");
    return;
  }

  const answer = await summarizeSearch(env, query, candidates);
  await sendTelegramMessage(env, chatId, answer);
}

async function sendDailyBriefing(env: Env): Promise<void> {
  const chatId = env.TELEGRAM_CHAT_ID;
  const today = todayInTimezone(env);
  const alreadySent = await supabaseSelect(env, "daily_briefings_log", {
    telegram_chat_id: `eq.${chatId}`,
    briefing_date: `eq.${today}`,
    select: "id",
    limit: "1",
  });
  if (alreadySent.length > 0) return;

  const [weather, localNews, nationalNews, events, tasks, memories] = await Promise.all([
    fetchWeather(env),
    fetchNews(env, "Foggia OR provincia di Foggia OR Puglia", 5),
    fetchNews(env, "Italia", 5),
    fetchCalendarEvents(env, today),
    fetchTasksByDate(env, chatId, today),
    fetchOneYearAgo(env, chatId, today),
  ]);

  const briefing = await synthesizeBriefing(env, {
    today,
    weather,
    localNews,
    nationalNews,
    events,
    tasks,
    memories,
  });

  await sendTelegramMessage(env, chatId, briefing);
  await supabaseInsert(env, "daily_briefings_log", {
    telegram_chat_id: chatId,
    briefing_date: today,
    sent_at: new Date().toISOString(),
    status: "sent",
  });
}

async function extractInfo(
  env: Env,
  kind: "note" | "task",
  text: string,
  parsedDate: string | null,
): Promise<ExtractedInfo> {
  const cheap = cheapExtract(text, parsedDate);
  const needsAi =
    cheap.summary.length > 120 ||
    cheap.tags.length === 0 ||
    hasEntitySignals(text) ||
    (!parsedDate && /\b(domani|dopodomani|lunedi|lunedì|martedi|martedì|mercoledi|mercoledì|giovedi|giovedì|venerdi|venerdì|sabato|domenica|\d{1,2}\s+\w+)/i.test(text));

  if (!needsAi) {
    return kind === "task" ? { ...cheap, event_date: null, due_date: parsedDate } : { ...cheap, event_date: parsedDate, due_date: null };
  }

  const schema = kind === "task" ? "due_date" : "event_date";
  const prompt = [
    "Estrai dati da questo testo italiano per un assistente personale.",
    "Rispondi solo JSON valido, senza markdown.",
    `Campo data principale: ${schema}. Se assente usa null. Date in formato YYYY-MM-DD.`,
    "Campi: summary breve, tags massimo 5, category breve, people array, places array, event_date, due_date.",
    `Data gia' riconosciuta dal parser locale: ${parsedDate ?? "null"}.`,
    `Testo: ${text.slice(0, 1200)}`,
  ].join("\n");

  const raw = await generateGemini(env, prompt, 0.1, 900);
  const data = parseJsonObject(raw);
  return {
    summary: asString(data.summary) || cheap.summary,
    tags: asStringArray(data.tags).slice(0, 5),
    category: asString(data.category) || cheap.category,
    people: asStringArray(data.people).slice(0, 8),
    places: asStringArray(data.places).slice(0, 8),
    event_date: kind === "note" ? normalizeNullableDate(asString(data.event_date) || parsedDate) : null,
    due_date: kind === "task" ? normalizeNullableDate(asString(data.due_date) || parsedDate) : null,
  };
}

function cheapExtract(text: string, parsedDate: string | null): ExtractedInfo {
  const clean = text.replace(/\s+/g, " ").trim();
  const tags = Array.from(
    new Set(
      clean
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !ITALIAN_STOPWORDS.has(w))
        .slice(0, 5),
    ),
  );

  return {
    summary: clean.length > 150 ? `${clean.slice(0, 147)}...` : clean,
    tags,
    category: inferCategory(clean),
    people: [],
    places: [],
    event_date: parsedDate,
    due_date: parsedDate,
  };
}

function parseItalianDate(text: string, today: string): string | null {
  const base = parseDateOnly(today);
  const lower = text.toLowerCase();

  if (/\bdomani\b/.test(lower)) return addDays(base, 1);
  if (/\bdopodomani\b/.test(lower)) return addDays(base, 2);
  if (/\boggi\b/.test(lower)) return today;

  const numeric = lower.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (numeric) return buildDate(Number(numeric[1]), Number(numeric[2]), numeric[3], base);

  const textual = lower.match(/\b(?:il\s+)?(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)(?:\s+(\d{4}))?\b/);
  if (textual) return buildDate(Number(textual[1]), MONTHS[textual[2]], textual[3], base);

  const weekday = lower.match(/\b(lunedi|lunedì|martedi|martedì|mercoledi|mercoledì|giovedi|giovedì|venerdi|venerdì|sabato|domenica)\b/);
  if (weekday) {
    const target = WEEKDAYS[weekday[1]];
    const current = base.getUTCDay();
    const delta = (target - current + 7) % 7 || 7;
    return addDays(base, delta);
  }

  return null;
}

async function createEmbedding(env: Env, text: string): Promise<number[]> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:embedContent?key=${env.GEMINI_API_KEY}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: text.slice(0, 3000) }] },
      outputDimensionality: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) throw new Error(`Gemini embedding failed: ${response.status}`);
  const data = (await response.json()) as { embedding?: { values?: number[] } };
  return data.embedding?.values ?? [];
}

async function generateGemini(env: Env, prompt: string, temperature = 0.2, maxOutputTokens = 1200): Promise<string> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FLASH_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature, maxOutputTokens },
    }),
  });

  if (!response.ok) throw new Error(`Gemini generate failed: ${response.status}`);
  const data = (await response.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() ?? "";
}

async function summarizeSearch(env: Env, query: string, items: SearchItem[]): Promise<string> {
  const compact = items.map((item, index) => ({
    n: index + 1,
    tipo: item.kind,
    testo: item.original_text.slice(0, 350),
    sintesi: item.summary,
    tags: item.tags,
    categoria: item.category,
    data: item.date,
  }));

  const prompt = [
    "Rispondi in italiano in modo sintetico a una ricerca nella memoria personale.",
    "Usa solo i risultati forniti. Se fai collegamenti, falli esplicitamente tra questi elementi.",
    "Massimo 5 frasi. Non inventare dati.",
    `Domanda: ${query}`,
    `Risultati: ${JSON.stringify(compact)}`,
  ].join("\n");

  return generateGemini(env, prompt, 0.2, 700);
}

async function synthesizeBriefing(env: Env, input: {
  today: string;
  weather: string;
  localNews: string[];
  nationalNews: string[];
  events: CalendarEvent[];
  tasks: TaskRow[];
  memories: SearchItem[];
}): Promise<string> {
  const prompt = [
    "Crea un briefing mattutino Telegram in italiano. Tono pratico, breve, ordinato.",
    "Se una sezione e' vuota scrivi 'Nessun elemento'. Non inventare notizie o eventi.",
    "Sezioni obbligatorie: Meteo Foggia, Notizie locali, Notizie Italia, Calendario, Task, Un anno fa oggi.",
    `Data: ${input.today}`,
    JSON.stringify({
      meteo: input.weather,
      notizie_locali: input.localNews,
      notizie_italia: input.nationalNews,
      calendario: input.events.map((e) => `${e.time ?? "Tutto il giorno"} ${e.summary}`),
      task: input.tasks.map((t) => t.summary ?? t.original_text),
      un_anno_fa: input.memories.slice(0, 3),
    }),
  ].join("\n");

  return generateGemini(env, prompt, 0.3, 1400);
}

async function fetchCalendarEvents(env: Env, day: string): Promise<CalendarEvent[]> {
  const token = await getGoogleAccessToken(env);
  const offset = timezoneOffset(day, env.TIMEZONE || "Europe/Rome");
  const start = `${day}T00:00:00${offset}`;
  const end = `${day}T23:59:59${offset}`;
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("timeMin", start);
  url.searchParams.set("timeMax", end);
  url.searchParams.set("timeZone", env.TIMEZONE || "Europe/Rome");

  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Google Calendar failed: ${response.status}`);
  const data = (await response.json()) as { items?: GoogleCalendarItem[] };
  return (data.items ?? []).map((item) => ({
    id: item.id,
    summary: item.summary ?? "(senza titolo)",
    date: (item.start?.dateTime ?? item.start?.date ?? day).slice(0, 10),
    time: item.start?.dateTime ? item.start.dateTime.slice(11, 16) : null,
  }));
}

async function getGoogleAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CALENDAR_CLIENT_ID,
    client_secret: env.GOOGLE_CALENDAR_CLIENT_SECRET,
    refresh_token: env.GOOGLE_CALENDAR_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) throw new Error(`Google token failed: ${response.status}`);
  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Google token missing");
  return data.access_token;
}

async function fetchWeather(env: Env): Promise<string> {
  if (!env.WEATHER_API_KEY) return "Meteo non configurato.";
  const city = env.DEFAULT_CITY || "Foggia";
  const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},IT&units=metric&lang=it&appid=${env.WEATHER_API_KEY}`;
  const response = await fetch(url);
  if (!response.ok) return "Meteo non disponibile.";
  const data = (await response.json()) as {
    weather?: Array<{ description?: string }>;
    main?: { temp?: number; feels_like?: number };
  };
  const desc = data.weather?.[0]?.description ?? "n/d";
  return `${city}: ${Math.round(data.main?.temp ?? 0)}°C, percepita ${Math.round(data.main?.feels_like ?? 0)}°C, ${desc}.`;
}

async function fetchNews(env: Env, query: string, pageSize: number): Promise<string[]> {
  if (!env.NEWS_API_KEY) return ["News API non configurata."];
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("language", "it");
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", String(pageSize));
  const response = await fetch(url, { headers: { "x-api-key": env.NEWS_API_KEY } });
  if (!response.ok) return ["Notizie non disponibili."];
  const data = (await response.json()) as { articles?: Array<{ title?: string; source?: { name?: string } }> };
  return (data.articles ?? []).slice(0, pageSize).map((a) => `${a.title ?? "Senza titolo"} (${a.source?.name ?? "fonte"})`);
}

async function fetchTasksByDate(env: Env, chatId: string, day: string): Promise<TaskRow[]> {
  return supabaseSelect(env, "personal_tasks", {
    telegram_chat_id: `eq.${chatId}`,
    due_date: `eq.${day}`,
    status: "eq.open",
    select: "id,original_text,summary,due_date,tags,category,status",
    order: "created_at.asc",
  }) as Promise<TaskRow[]>;
}

async function fetchNotesByDate(env: Env, chatId: string, day: string): Promise<NoteRow[]> {
  return supabaseSelect(env, "personal_memory", {
    telegram_chat_id: `eq.${chatId}`,
    event_date: `eq.${day}`,
    select: "id,original_text,summary,event_date,tags,category",
    order: "created_at.asc",
  }) as Promise<NoteRow[]>;
}

async function fetchOneYearAgo(env: Env, chatId: string, today: string): Promise<SearchItem[]> {
  const base = parseDateOnly(today);
  base.setUTCFullYear(base.getUTCFullYear() - 1);
  const from = addDays(base, -3);
  const to = addDays(base, 3);
  const calendarDays = Array.from({ length: 7 }, (_, i) => addDays(parseDateOnly(from), i));

  const [notes, tasks, calendarResults] = await Promise.all([
    supabaseSelect(env, "personal_memory", {
      telegram_chat_id: `eq.${chatId}`,
      event_date: `gte.${from}`,
      event_date_lte: `lte.${to}`,
      select: "id,original_text,summary,event_date,tags,category",
      limit: "5",
    }, { event_date_lte: "event_date" }),
    supabaseSelect(env, "personal_tasks", {
      telegram_chat_id: `eq.${chatId}`,
      due_date: `gte.${from}`,
      due_date_lte: `lte.${to}`,
      select: "id,original_text,summary,due_date,tags,category",
      limit: "5",
    }, { due_date_lte: "due_date" }),
    Promise.all(calendarDays.map((day) => fetchCalendarEvents(env, day).catch(() => []))),
  ]);

  return [
    ...notes.map((n) => rowToSearchItem("note", n, n.event_date, 0.8)),
    ...tasks.map((t) => rowToSearchItem("task", t, t.due_date, 0.7)),
    ...calendarResults.flat().map((e) => ({
      kind: "calendar" as const,
      id: e.id ?? `${e.date}:${e.summary}`,
      original_text: e.summary,
      summary: e.summary,
      tags: ["calendario"],
      category: "calendario",
      date: e.date,
      score: 0.65,
    })),
  ].slice(0, 3);
}

async function searchKeyword(env: Env, chatId: string, query: string): Promise<SearchItem[]> {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 5);
  if (terms.length === 0) return [];

  const pattern = `%${terms.join("%")}%`;
  const [notes, tasks] = await Promise.all([
    supabaseSelect(env, "personal_memory", {
      telegram_chat_id: `eq.${chatId}`,
      or: `(original_text.ilike.${pattern},summary.ilike.${pattern},tags.cs.{${terms.join(",")}})`,
      select: "id,original_text,summary,event_date,tags,category",
      limit: "10",
      order: "created_at.desc",
    }),
    supabaseSelect(env, "personal_tasks", {
      telegram_chat_id: `eq.${chatId}`,
      or: `(original_text.ilike.${pattern},summary.ilike.${pattern},tags.cs.{${terms.join(",")}})`,
      select: "id,original_text,summary,due_date,tags,category",
      limit: "10",
      order: "created_at.desc",
    }),
  ]);

  return [
    ...notes.map((n) => rowToSearchItem("note", n, n.event_date, 0.75)),
    ...tasks.map((t) => rowToSearchItem("task", t, t.due_date, 0.75)),
  ];
}

async function searchVector(env: Env, chatId: string, embedding: number[]): Promise<SearchItem[]> {
  const [notes, tasks] = await Promise.all([
    supabaseRpc(env, "match_personal_memory", {
      query_embedding: embedding,
      match_chat_id: chatId,
      match_count: 8,
      similarity_threshold: 0.55,
    }),
    supabaseRpc(env, "match_personal_tasks", {
      query_embedding: embedding,
      match_chat_id: chatId,
      match_count: 8,
      similarity_threshold: 0.55,
    }),
  ]);

  return [
    ...notes.map((n) => rowToSearchItem("note", n, n.event_date, n.similarity ?? 0)),
    ...tasks.map((t) => rowToSearchItem("task", t, t.due_date, t.similarity ?? 0)),
  ];
}

async function upsertTelegramUser(env: Env, message: NonNullable<TelegramUpdate["message"]>): Promise<void> {
  const from = message.from;
  await supabaseUpsert(env, "telegram_users", {
    telegram_user_id: from?.id ?? message.chat.id,
    telegram_chat_id: String(message.chat.id),
    username: from?.username ?? null,
    first_name: from?.first_name ?? null,
    last_name: from?.last_name ?? null,
    updated_at: new Date().toISOString(),
  }, "telegram_chat_id");
}

async function supabaseInsert(env: Env, table: string, row: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(env, { Prefer: "return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`Supabase insert ${table} failed: ${response.status} ${await response.text()}`);
}

async function supabaseUpsert(env: Env, table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: supabaseHeaders(env, { Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new Error(`Supabase upsert ${table} failed: ${response.status} ${await response.text()}`);
}

async function supabaseSelect(
  env: Env,
  table: string,
  params: Record<string, string>,
  aliases: Record<string, string> = {},
): Promise<any[]> {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.append(aliases[key] ?? key, value);
  }
  const response = await fetch(url, { headers: supabaseHeaders(env) });
  if (!response.ok) throw new Error(`Supabase select ${table} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function supabaseRpc(env: Env, fn: string, payload: Record<string, unknown>): Promise<any[]> {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: supabaseHeaders(env),
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`Supabase rpc ${fn} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

function supabaseHeaders(env: Env, extra: Record<string, string> = {}): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function sendTelegramMessage(env: Env, chatId: string, text: string): Promise<void> {
  const chunks = chunkText(text, MAX_TELEGRAM_LENGTH);
  for (const chunk of chunks) {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) throw new Error(`Telegram send failed: ${response.status}`);
  }
}

function buildTodayText(today: string, events: CalendarEvent[], tasks: TaskRow[], notes: NoteRow[]): string {
  return [
    `Oggi, ${formatDateIt(today)}`,
    "",
    "Calendario",
    events.length ? events.map((e) => `- ${e.time ?? "Tutto il giorno"} ${e.summary}`).join("\n") : "- Nessun evento",
    "",
    "Task",
    tasks.length ? tasks.map((t) => `- ${t.summary ?? t.original_text}`).join("\n") : "- Nessun task",
    "",
    "Note collegate",
    notes.length ? notes.map((n) => `- ${n.summary ?? n.original_text}`).join("\n") : "- Nessuna nota collegata",
  ].join("\n");
}

function startText(): string {
  return [
    "Assistente personale attivo.",
    "",
    "Comandi principali:",
    "/nota testo",
    "/task testo",
    "/oggi",
    "/cerca testo",
    "/help",
  ].join("\n");
}

function helpText(): string {
  return [
    "Esempi:",
    "/nota Ho parlato con Rossi della revisione macchina",
    "/task martedi 3 giugno devo pagare il bollo",
    "/oggi",
    "/cerca bollo macchina",
  ].join("\n");
}

function mergeSearchResults(items: SearchItem[]): SearchItem[] {
  const seen = new Map<string, SearchItem>();
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    const existing = seen.get(key);
    if (!existing || item.score > existing.score) seen.set(key, item);
  }
  return Array.from(seen.values()).sort((a, b) => b.score - a.score);
}

function rowToSearchItem(kind: MemoryKind, row: any, date: string | null, score: number): SearchItem {
  return {
    kind,
    id: String(row.id),
    original_text: row.original_text,
    summary: row.summary ?? null,
    tags: row.tags ?? null,
    category: row.category ?? null,
    date,
    score,
  };
}

function compactEmbeddingText(text: string, info: ExtractedInfo): string {
  return [text, info.summary, info.category, info.tags.join(" ")].filter(Boolean).join("\n").slice(0, 3000);
}

function hasEntitySignals(text: string): boolean {
  return /\b[A-ZÀ-Ý][a-zà-ÿ]{2,}\b/.test(text) || /\b(via|piazza|corso|dott|avv|ing)\b/i.test(text);
}

function inferCategory(text: string): string {
  const lower = text.toLowerCase();
  if (/\b(auto|macchina|bollo|revisione|assicurazione)\b/.test(lower)) return "auto";
  if (/\b(pagare|fattura|bonifico|soldi|bolletta)\b/.test(lower)) return "finanze";
  if (/\b(medico|visita|farmacia|salute)\b/.test(lower)) return "salute";
  if (/\b(casa|spesa|famiglia)\b/.test(lower)) return "casa";
  if (/\b(lavoro|cliente|riunione)\b/.test(lower)) return "lavoro";
  return "generale";
}

function todayInTimezone(env: Env): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: env.TIMEZONE || "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date());
}

function hourInTimezone(env: Env): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: env.TIMEZONE || "Europe/Rome",
    hour: "2-digit",
    hour12: false,
  });
  return Number(formatter.format(new Date()));
}

function timezoneOffset(day: string, timeZone: string): string {
  const date = new Date(`${day}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+1";
  const match = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return "+01:00";
  const sign = match[1];
  const hours = match[2].padStart(2, "0");
  const minutes = match[3] ?? "00";
  return `${sign}${hours}:${minutes}`;
}

function formatDateIt(date: string): string {
  return new Intl.DateTimeFormat("it-IT", { dateStyle: "full", timeZone: "Europe/Rome" }).format(parseDateOnly(date));
}

function parseDateOnly(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(date: Date, days: number): string {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

function buildDate(day: number, month: number, rawYear: string | undefined, base: Date): string | null {
  let year = rawYear ? Number(rawYear) : base.getUTCFullYear();
  if (year < 100) year += 2000;
  let date = new Date(Date.UTC(year, month - 1, day));
  if (!rawYear && date < stripTime(base)) {
    date = new Date(Date.UTC(year + 1, month - 1, day));
  }
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return date.toISOString().slice(0, 10);
}

function stripTime(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function normalizeNullableDate(value: string | null): string | null {
  if (!value || value === "null") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim());
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
}

function formatSummaryLine(info: ExtractedInfo): string {
  const tags = info.tags.length ? `\nTag: ${info.tags.join(", ")}` : "";
  return `Sintesi: ${info.summary}${tags}`;
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const MONTHS: Record<string, number> = {
  gennaio: 1,
  febbraio: 2,
  marzo: 3,
  aprile: 4,
  maggio: 5,
  giugno: 6,
  luglio: 7,
  agosto: 8,
  settembre: 9,
  ottobre: 10,
  novembre: 11,
  dicembre: 12,
};

const WEEKDAYS: Record<string, number> = {
  domenica: 0,
  lunedi: 1,
  lunedì: 1,
  martedi: 2,
  martedì: 2,
  mercoledi: 3,
  mercoledì: 3,
  giovedi: 4,
  giovedì: 4,
  venerdi: 5,
  venerdì: 5,
  sabato: 6,
};

const ITALIAN_STOPWORDS = new Set([
  "alla",
  "allo",
  "alle",
  "della",
  "delle",
  "degli",
  "devo",
  "fare",
  "fatto",
  "oggi",
  "domani",
  "sono",
  "con",
  "per",
  "che",
  "una",
  "uno",
  "del",
  "dei",
  "nel",
  "nei",
  "sul",
  "sui",
  "tra",
  "fra",
]);

type CalendarEvent = { id?: string; summary: string; date: string; time: string | null };
type GoogleCalendarItem = { id?: string; summary?: string; start?: { date?: string; dateTime?: string } };
type TaskRow = { id: string; original_text: string; summary: string | null; due_date: string | null; tags: string[] | null; category: string | null; status: string };
type NoteRow = { id: string; original_text: string; summary: string | null; event_date: string | null; tags: string[] | null; category: string | null };
