# Telegram Personal Assistant V1

Assistente personale Telegram economico nei token, basato su:

- Cloudflare Worker in TypeScript
- Telegram Bot via webhook
- Supabase Postgres
- Google Calendar API
- Gemini Flash
- Cron Cloudflare ogni giorno alle 08:00 Europe/Rome

La V1 non ha dashboard o frontend. Tutto passa da Telegram.

## Funzioni

- `/start` attiva e mostra i comandi.
- `/nota testo` salva una nota libera con sintesi, tag, categoria, persone, luoghi ed eventuale data.
- `/task testo` salva un promemoria con eventuale data, stato `open`, tag e categoria.
- `/oggi` mostra eventi Google Calendar di oggi, task di oggi e note collegate alla data.
- `/cerca testo` cerca nella memoria con keyword Supabase, deduplica e manda a Gemini solo i 10 risultati migliori.
- Briefing automatico alle 08:00 Europe/Rome con meteo Foggia, notizie locali, notizie italiane, calendario, task e “Un anno fa oggi”.

## Struttura

```text
src/index.ts
supabase/migrations/001_initial_schema.sql
wrangler.toml
.env.example
```

## Setup locale

Installa le dipendenze:

```bash
npm install
```

Copia il file di esempio:

```bash
cp .env.example .dev.vars
```

Compila `.dev.vars` con:

```bash
TELEGRAM_BOT_TOKEN=
TELEGRAM_SECRET_TOKEN=
TELEGRAM_CHAT_ID=
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
GEMINI_API_KEY=
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REFRESH_TOKEN=
WEATHER_API_KEY=
NEWS_API_KEY=
TIMEZONE=Europe/Rome
DEFAULT_CITY=Foggia
```

Avvio locale:

```bash
npm run dev
```

## Supabase

1. Crea un progetto Supabase.
2. Apri SQL Editor.
3. Esegui `supabase/migrations/001_initial_schema.sql`.
La migration crea:

- `telegram_users`
- `personal_memory`
- `personal_tasks`
- `daily_briefings_log`
- indici keyword/date/tag

Il Worker usa la service role key perché gira server-side su Cloudflare. Non esporla mai lato client.

## Telegram

Crea il bot con BotFather e prendi `TELEGRAM_BOT_TOKEN`.

Per ricavare `TELEGRAM_CHAT_ID`, scrivi un messaggio al bot e chiama:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates"
```

Imposta un valore casuale per `TELEGRAM_SECRET_TOKEN`, per esempio una stringa lunga generata da password manager.

Dopo il deploy, configura il webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker-url>/telegram/webhook",
    "secret_token": "<TELEGRAM_SECRET_TOKEN>"
  }'
```

## Gemini

Serve una API key Google AI Studio.

La V1 usa:

- `gemini-2.0-flash` per estrazione, sintesi briefing e risposta finale di `/cerca`.

Non genera vettori semantici con Google.

## Google Calendar

Serve un OAuth client con accesso a Google Calendar API e un refresh token.

Valori richiesti:

- `GOOGLE_CALENDAR_CLIENT_ID`
- `GOOGLE_CALENDAR_CLIENT_SECRET`
- `GOOGLE_CALENDAR_REFRESH_TOKEN`

Il Worker legge il calendario `primary`.

## Meteo e notizie

La V1 usa:

- OpenWeatherMap per il meteo.
- NewsAPI.org per le notizie.

Configura:

- `WEATHER_API_KEY`
- `NEWS_API_KEY`

Le query del briefing sono:

- Locali: `Foggia OR provincia di Foggia OR Puglia`
- Nazionali: `Italia`

## Deploy Cloudflare

Autenticati con Wrangler, poi imposta i secret:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_SECRET_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GOOGLE_CALENDAR_CLIENT_ID
npx wrangler secret put GOOGLE_CALENDAR_CLIENT_SECRET
npx wrangler secret put GOOGLE_CALENDAR_REFRESH_TOKEN
npx wrangler secret put WEATHER_API_KEY
npx wrangler secret put NEWS_API_KEY
npx wrangler secret put TIMEZONE
npx wrangler secret put DEFAULT_CITY
```

Deploy:

```bash
npm run deploy
```

Il file `wrangler.toml` contiene:

```toml
[triggers]
crons = ["0 6,7 * * *"]
```

Cloudflare usa cron in UTC. Il Worker controlla internamente l'ora locale e invia il briefing solo quando in `Europe/Rome` sono le 08:00. Questo copre sia ora solare sia ora legale.

## Esempi Telegram

```text
/nota Ho parlato con Rossi della revisione macchina fatta il 10 maggio
/task martedi 3 giugno devo pagare il bollo
/task domani chiama Rossi
/task il 10 maggio revisione macchina
/oggi
/cerca bollo macchina
```

## Regola token

La memoria completa non viene mai inviata a Gemini.

Flusso di `/cerca`:

1. cerca keyword in `original_text`, `summary`, `tags`;
2. unisce e deduplica;
3. prende massimo 10 risultati;
4. manda solo quei risultati a Gemini;
5. Gemini collega informazioni simili semanticamente e produce una risposta breve.

Per `/nota` e `/task`, il Worker prova prima a estrarre date, tag e categoria con codice locale. Gemini viene usato solo se il testo è più ambiguo o contiene segnali di persone/luoghi/date non banali.

Per contenere i costi:

- testi troncati prima di Gemini;
- massimo 5 tag;
- massimo 10 risultati per `/cerca`;
- briefing sintetizzato da liste già compatte;
- nessuna scansione completa della memoria;
- daily briefing log per evitare invii doppi nello stesso giorno.

## Limiti V1

- I task possono essere creati ma non completati da comando Telegram.
- Il calendario Google viene letto, non modificato.
- News e meteo dipendono dai provider configurati.
- Il parser date locale copre casi comuni italiani; Gemini interviene quando serve.
