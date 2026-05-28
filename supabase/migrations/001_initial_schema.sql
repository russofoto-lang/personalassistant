create extension if not exists vector;

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
  created_at timestamptz not null default now(),
  embedding vector(768) not null
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
  completed_at timestamptz,
  embedding vector(768) not null
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

create index if not exists personal_memory_embedding_idx
  on public.personal_memory using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists personal_tasks_embedding_idx
  on public.personal_tasks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create or replace function public.match_personal_memory(
  query_embedding vector(768),
  match_chat_id text,
  match_count int default 8,
  similarity_threshold float default 0.55
)
returns table (
  id uuid,
  original_text text,
  summary text,
  tags text[],
  category text,
  people text[],
  places text[],
  event_date date,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    pm.id,
    pm.original_text,
    pm.summary,
    pm.tags,
    pm.category,
    pm.people,
    pm.places,
    pm.event_date,
    pm.created_at,
    1 - (pm.embedding <=> query_embedding) as similarity
  from public.personal_memory pm
  where pm.telegram_chat_id = match_chat_id
    and 1 - (pm.embedding <=> query_embedding) >= similarity_threshold
  order by pm.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function public.match_personal_tasks(
  query_embedding vector(768),
  match_chat_id text,
  match_count int default 8,
  similarity_threshold float default 0.55
)
returns table (
  id uuid,
  original_text text,
  summary text,
  due_date date,
  status text,
  tags text[],
  category text,
  created_at timestamptz,
  similarity float
)
language sql
stable
as $$
  select
    pt.id,
    pt.original_text,
    pt.summary,
    pt.due_date,
    pt.status,
    pt.tags,
    pt.category,
    pt.created_at,
    1 - (pt.embedding <=> query_embedding) as similarity
  from public.personal_tasks pt
  where pt.telegram_chat_id = match_chat_id
    and 1 - (pt.embedding <=> query_embedding) >= similarity_threshold
  order by pt.embedding <=> query_embedding
  limit match_count;
$$;
