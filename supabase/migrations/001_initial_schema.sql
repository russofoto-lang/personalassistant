create table if not exists public.telegram_users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  telegram_chat_id text not null unique,
  username text,
  first_name text,
  last_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.personal_memory (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text not null references public.telegram_users (telegram_chat_id) on delete cascade,
  original_text text not null,
  summary text not null,
  tags text[] not null default '{}',
  category text not null default 'generale',
  people text[] not null default '{}',
  places text[] not null default '{}',
  event_date date,
  created_at timestamptz not null default now()
);

create table if not exists public.personal_tasks (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text not null references public.telegram_users (telegram_chat_id) on delete cascade,
  original_text text not null,
  summary text not null,
  due_date date,
  status text not null default 'open' check (status in ('open', 'completed')),
  tags text[] not null default '{}',
  category text not null default 'generale',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.daily_briefings_log (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id text not null references public.telegram_users (telegram_chat_id) on delete cascade,
  briefing_date date not null,
  sent_at timestamptz not null default now(),
  status text not null default 'sent',
  error text,
  created_at timestamptz not null default now(),
  unique (telegram_chat_id, briefing_date)
);

create index if not exists personal_memory_chat_created_idx
  on public.personal_memory (telegram_chat_id, created_at desc);

create index if not exists personal_memory_event_date_idx
  on public.personal_memory (telegram_chat_id, event_date);

create index if not exists personal_memory_tags_idx
  on public.personal_memory using gin (tags);

create index if not exists personal_tasks_chat_created_idx
  on public.personal_tasks (telegram_chat_id, created_at desc);

create index if not exists personal_tasks_due_status_idx
  on public.personal_tasks (telegram_chat_id, due_date, status);

create index if not exists personal_tasks_tags_idx
  on public.personal_tasks using gin (tags);
