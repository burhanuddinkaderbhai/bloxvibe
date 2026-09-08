-- BloxVibe production-ish starter schema for profiles, posts, pictures, DMs,
-- realtime messages, notifications, automatic profiles and Storage.

create extension if not exists pgcrypto;

-- -------------------- TABLES --------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  avatar_url text,
  bio text,
  created_at timestamptz not null default now(),
  constraint profiles_username_length check (char_length(username) between 3 and 24)
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text,
  image_url text,
  created_at timestamptz not null default now(),
  constraint posts_caption_length check (content is null or char_length(content) <= 500),
  constraint posts_not_empty check (nullif(trim(coalesce(content, '')), '') is not null or image_url is not null)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  receiver_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  type text not null check (type in ('message','call')),
  message_id uuid references public.messages(id) on delete cascade,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists messages_sender_receiver_created_idx
  on public.messages(sender_id, receiver_id, created_at);
create index if not exists messages_receiver_created_idx
  on public.messages(receiver_id, created_at);
create index if not exists notifications_user_created_idx
  on public.notifications(user_id, created_at desc);

-- -------------------- PRIVILEGES + RLS --------------------
grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.posts to authenticated;
grant select, insert on public.messages to authenticated;
grant select, update on public.notifications to authenticated;

alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.messages enable row level security;
alter table public.notifications enable row level security;

-- Drop only the BloxVibe policies we own, so the script is safe to rerun.
drop policy if exists "bv_profiles_select" on public.profiles;
drop policy if exists "bv_profiles_insert" on public.profiles;
drop policy if exists "bv_profiles_update" on public.profiles;
create policy "bv_profiles_select" on public.profiles
  for select to authenticated using (true);
create policy "bv_profiles_insert" on public.profiles
  for insert to authenticated with check (auth.uid() = id);
create policy "bv_profiles_update" on public.profiles
  for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "bv_posts_select" on public.posts;
drop policy if exists "bv_posts_insert" on public.posts;
drop policy if exists "bv_posts_delete" on public.posts;
create policy "bv_posts_select" on public.posts
  for select to authenticated using (true);
create policy "bv_posts_insert" on public.posts
  for insert to authenticated with check (auth.uid() = user_id);
create policy "bv_posts_delete" on public.posts
  for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "bv_messages_select" on public.messages;
drop policy if exists "bv_messages_insert" on public.messages;
create policy "bv_messages_select" on public.messages
  for select to authenticated using (auth.uid() = sender_id or auth.uid() = receiver_id);
create policy "bv_messages_insert" on public.messages
  for insert to authenticated with check (auth.uid() = sender_id);

drop policy if exists "bv_notifications_select" on public.notifications;
drop policy if exists "bv_notifications_update" on public.notifications;
create policy "bv_notifications_select" on public.notifications
  for select to authenticated using (auth.uid() = user_id);
create policy "bv_notifications_update" on public.notifications
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- -------------------- AUTOMATIC PROFILE CREATION --------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  base_username text;
  candidate text;
  suffix integer := 0;
begin
  base_username := lower(regexp_replace(
    coalesce(new.raw_user_meta_data->>'username', split_part(coalesce(new.email,''), '@', 1), 'player'),
    '[^a-zA-Z0-9_]', '', 'g'
  ));
  base_username := left(nullif(base_username, ''), 18);
  if base_username is null then base_username := 'player'; end if;

  candidate := left(base_username, 24);
  while exists (select 1 from public.profiles where username = candidate) loop
    suffix := suffix + 1;
    candidate := left(base_username, 24 - length(suffix::text) - 1) || '_' || suffix::text;
  end loop;

  insert into public.profiles(id, username)
  values (new.id, candidate)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

-- Backfill any Auth users that existed before this trigger was installed.
do $$
declare
  u record;
  base_username text;
  candidate text;
  suffix integer;
begin
  for u in select au.id, au.email, au.raw_user_meta_data from auth.users au
    left join public.profiles p on p.id = au.id
    where p.id is null
  loop
    base_username := lower(regexp_replace(
      coalesce(u.raw_user_meta_data->>'username', split_part(coalesce(u.email,''), '@', 1), 'player'),
      '[^a-zA-Z0-9_]', '', 'g'
    ));
    base_username := left(nullif(base_username, ''), 18);
    if base_username is null then base_username := 'player'; end if;
    candidate := left(base_username, 24);
    suffix := 0;
    while exists (select 1 from public.profiles where username = candidate) loop
      suffix := suffix + 1;
      candidate := left(base_username, 24 - length(suffix::text) - 1) || '_' || suffix::text;
    end loop;
    insert into public.profiles(id, username) values (u.id, candidate) on conflict do nothing;
  end loop;
end $$;

-- -------------------- NOTIFICATIONS --------------------
create or replace function public.create_message_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications(user_id, actor_id, type, message_id, title, body)
  values (new.receiver_id, new.sender_id, 'message', new.id,
          'New message', left(new.body, 160));
  return new;
end;
$$;

drop trigger if exists on_message_created_notification on public.messages;
create trigger on_message_created_notification
after insert on public.messages
for each row execute procedure public.create_message_notification();

-- -------------------- REALTIME --------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;

-- -------------------- POST IMAGE STORAGE --------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'posts', 'posts', true, 8388608,
  array['image/jpeg','image/png','image/webp','image/gif']::text[]
)
on conflict (id) do update set
  public = true,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif']::text[];

drop policy if exists "bv_post_images_select" on storage.objects;
drop policy if exists "bv_post_images_insert" on storage.objects;
drop policy if exists "bv_post_images_delete" on storage.objects;
create policy "bv_post_images_select"
on storage.objects for select to public
using (bucket_id = 'posts');
create policy "bv_post_images_insert"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'posts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
create policy "bv_post_images_delete"
on storage.objects for delete to authenticated
using (
  bucket_id = 'posts'
  and (storage.foldername(name))[1] = auth.uid()::text
);
