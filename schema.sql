-- BloxVibe Supabase database
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now()
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  image_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.messages enable row level security;

create policy "profiles readable" on public.profiles for select using (true);
create policy "users insert own profile" on public.profiles for insert with check (auth.uid() = id);
create policy "users update own profile" on public.profiles for update using (auth.uid() = id);

create policy "posts readable" on public.posts for select using (true);
create policy "users create posts" on public.posts for insert with check (auth.uid() = user_id);
create policy "users delete own posts" on public.posts for delete using (auth.uid() = user_id);

create policy "messages participants read" on public.messages for select
using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "users send messages" on public.messages for insert
with check (auth.uid() = sender_id);

-- Realtime
alter publication supabase_realtime add table public.messages;

-- Storage:
-- In Supabase Dashboard > Storage, create PUBLIC buckets:
--   posts
--   avatars
-- For a production deployment, add storage RLS policies restricting uploads
-- to folders beginning with auth.uid().
