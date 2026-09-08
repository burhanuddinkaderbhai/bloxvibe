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

-- -------------------- POST LIKES + COMMENTS + SHARING --------------------
create table if not exists public.post_likes (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.post_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (char_length(trim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);

alter table public.messages add column if not exists shared_post_id uuid references public.posts(id) on delete set null;
create index if not exists post_likes_post_idx on public.post_likes(post_id);
create index if not exists post_comments_post_created_idx on public.post_comments(post_id, created_at);
create index if not exists messages_shared_post_idx on public.messages(shared_post_id);

grant select, insert, delete on public.post_likes to authenticated;
grant select, insert, delete on public.post_comments to authenticated;

alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;

drop policy if exists "bv_post_likes_select" on public.post_likes;
drop policy if exists "bv_post_likes_insert" on public.post_likes;
drop policy if exists "bv_post_likes_delete" on public.post_likes;
create policy "bv_post_likes_select" on public.post_likes for select to authenticated using (true);
create policy "bv_post_likes_insert" on public.post_likes for insert to authenticated with check (auth.uid() = user_id);
create policy "bv_post_likes_delete" on public.post_likes for delete to authenticated using (auth.uid() = user_id);

drop policy if exists "bv_post_comments_select" on public.post_comments;
drop policy if exists "bv_post_comments_insert" on public.post_comments;
drop policy if exists "bv_post_comments_delete" on public.post_comments;
create policy "bv_post_comments_select" on public.post_comments for select to authenticated using (true);
create policy "bv_post_comments_insert" on public.post_comments for insert to authenticated with check (auth.uid() = user_id);
create policy "bv_post_comments_delete" on public.post_comments for delete to authenticated using (auth.uid() = user_id);

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
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'post_likes'
  ) then
    alter publication supabase_realtime add table public.post_likes;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'post_comments'
  ) then
    alter publication supabase_realtime add table public.post_comments;
  end if;
end $$;

-- -------------------- POST IMAGE STORAGE --------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'posts', 'posts', true, 8388608,
  array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']::text[]
)
on conflict (id) do update set
  public = true,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']::text[];

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

-- ============================================================
-- BloxVibe Social Expansion: follows, stories, saves, blocks,
-- reports, hashtags, mentions, media, read receipts and presence
-- ============================================================

alter table public.posts add column if not exists media_type text not null default 'image' check (media_type in ('image','video','text'));
alter table public.posts add column if not exists location_text text;

create table if not exists public.post_media (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts(id) on delete cascade,
  media_url text not null,
  media_type text not null check (media_type in ('image','video')),
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists post_media_post_idx on public.post_media(post_id, sort_order);


create table if not exists public.follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  following_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);
create index if not exists follows_following_idx on public.follows(following_id);

create table if not exists public.stories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  media_url text not null,
  media_type text not null default 'image' check (media_type in ('image','video')),
  caption text check (caption is null or char_length(caption) <= 500),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);
create index if not exists stories_active_idx on public.stories(expires_at, created_at desc);

create table if not exists public.story_views (
  story_id uuid not null references public.stories(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key (story_id, user_id)
);

create table if not exists public.saved_posts (
  user_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid not null references public.posts(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  post_id uuid references public.posts(id) on delete cascade,
  reported_user_id uuid references public.profiles(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  check (post_id is not null or reported_user_id is not null)
);

create table if not exists public.post_hashtags (
  post_id uuid not null references public.posts(id) on delete cascade,
  tag text not null,
  primary key (post_id, tag)
);
create index if not exists post_hashtags_tag_idx on public.post_hashtags(tag);

create table if not exists public.post_mentions (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  primary key (post_id, user_id)
);

alter table public.messages add column if not exists read_at timestamptz;
alter table public.messages add column if not exists is_deleted boolean not null default false;

alter table public.profiles add column if not exists last_seen_at timestamptz default now();
alter table public.profiles add column if not exists is_online boolean not null default false;

create index if not exists messages_read_idx on public.messages(receiver_id, read_at);

-- Realtime tables

do $$
declare
  t record;
begin
  for t in select unnest(array['follows','stories','story_views','saved_posts','post_media','post_hashtags','post_mentions']) as tab loop
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t.tab) then
      execute format('alter publication supabase_realtime add table public.%I', t.tab);
    end if;
  end loop;
end $$;

-- Grants
 grant select, insert, delete on public.post_media to authenticated;
grant select, insert, delete on public.follows to authenticated;
grant select, insert, delete on public.stories to authenticated;
grant select, insert, delete on public.story_views to authenticated;
grant select, insert, delete on public.saved_posts to authenticated;
grant select, insert, delete on public.blocks to authenticated;
grant select, insert on public.reports to authenticated;
grant select, insert, delete on public.post_hashtags to authenticated;
grant select, insert, delete on public.post_mentions to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.messages to authenticated;

-- RLS
alter table public.post_media enable row level security;
alter table public.follows enable row level security;
alter table public.stories enable row level security;
alter table public.story_views enable row level security;
alter table public.saved_posts enable row level security;
alter table public.blocks enable row level security;
alter table public.reports enable row level security;
alter table public.post_hashtags enable row level security;
alter table public.post_mentions enable row level security;

drop policy if exists bv_media_select on public.post_media; create policy bv_media_select on public.post_media for select to authenticated using (true);
drop policy if exists bv_media_insert on public.post_media; create policy bv_media_insert on public.post_media for insert to authenticated with check (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));
drop policy if exists bv_media_delete on public.post_media; create policy bv_media_delete on public.post_media for delete to authenticated using (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));

drop policy if exists bv_follows_select on public.follows; create policy bv_follows_select on public.follows for select to authenticated using (true);
drop policy if exists bv_follows_insert on public.follows; create policy bv_follows_insert on public.follows for insert to authenticated with check (auth.uid()=follower_id);
drop policy if exists bv_follows_delete on public.follows; create policy bv_follows_delete on public.follows for delete to authenticated using (auth.uid()=follower_id);

drop policy if exists bv_stories_select on public.stories; create policy bv_stories_select on public.stories for select to authenticated using (expires_at > now() or user_id=auth.uid());
drop policy if exists bv_stories_insert on public.stories; create policy bv_stories_insert on public.stories for insert to authenticated with check (auth.uid()=user_id);
drop policy if exists bv_stories_delete on public.stories; create policy bv_stories_delete on public.stories for delete to authenticated using (auth.uid()=user_id);

drop policy if exists bv_story_views_select on public.story_views; create policy bv_story_views_select on public.story_views for select to authenticated using (user_id=auth.uid() or exists(select 1 from public.stories s where s.id=story_id and s.user_id=auth.uid()));
drop policy if exists bv_story_views_insert on public.story_views; create policy bv_story_views_insert on public.story_views for insert to authenticated with check (auth.uid()=user_id);
drop policy if exists bv_story_views_delete on public.story_views; create policy bv_story_views_delete on public.story_views for delete to authenticated using (auth.uid()=user_id);

drop policy if exists bv_saved_select on public.saved_posts; create policy bv_saved_select on public.saved_posts for select to authenticated using (auth.uid()=user_id);
drop policy if exists bv_saved_insert on public.saved_posts; create policy bv_saved_insert on public.saved_posts for insert to authenticated with check (auth.uid()=user_id);
drop policy if exists bv_saved_delete on public.saved_posts; create policy bv_saved_delete on public.saved_posts for delete to authenticated using (auth.uid()=user_id);

drop policy if exists bv_blocks_select on public.blocks; create policy bv_blocks_select on public.blocks for select to authenticated using (auth.uid()=blocker_id);
drop policy if exists bv_blocks_insert on public.blocks; create policy bv_blocks_insert on public.blocks for insert to authenticated with check (auth.uid()=blocker_id);
drop policy if exists bv_blocks_delete on public.blocks; create policy bv_blocks_delete on public.blocks for delete to authenticated using (auth.uid()=blocker_id);

drop policy if exists bv_reports_insert on public.reports; create policy bv_reports_insert on public.reports for insert to authenticated with check (auth.uid()=reporter_id);
drop policy if exists bv_reports_select on public.reports; create policy bv_reports_select on public.reports for select to authenticated using (auth.uid()=reporter_id);

drop policy if exists bv_tags_select on public.post_hashtags; create policy bv_tags_select on public.post_hashtags for select to authenticated using (true);
drop policy if exists bv_tags_insert on public.post_hashtags; create policy bv_tags_insert on public.post_hashtags for insert to authenticated with check (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));
drop policy if exists bv_tags_delete on public.post_hashtags; create policy bv_tags_delete on public.post_hashtags for delete to authenticated using (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));

drop policy if exists bv_mentions_select on public.post_mentions; create policy bv_mentions_select on public.post_mentions for select to authenticated using (true);
drop policy if exists bv_mentions_insert on public.post_mentions; create policy bv_mentions_insert on public.post_mentions for insert to authenticated with check (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));
drop policy if exists bv_mentions_delete on public.post_mentions; create policy bv_mentions_delete on public.post_mentions for delete to authenticated using (exists(select 1 from public.posts p where p.id=post_id and p.user_id=auth.uid()));

-- Storage bucket for stories and videos
insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values
('stories','stories',true,8388608,array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']::text[])
on conflict (id) do update set public=true,file_size_limit=8388608,allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','video/mp4','video/webm']::text[];

drop policy if exists bv_story_media_select on storage.objects;
drop policy if exists bv_story_media_insert on storage.objects;
drop policy if exists bv_story_media_delete on storage.objects;
create policy bv_story_media_select on storage.objects for select to public using(bucket_id='stories');
create policy bv_story_media_insert on storage.objects for insert to authenticated with check(bucket_id='stories' and (storage.foldername(name))[1]=auth.uid()::text);
create policy bv_story_media_delete on storage.objects for delete to authenticated using(bucket_id='stories' and (storage.foldername(name))[1]=auth.uid()::text);

-- Basic message read-receipt policy already covered by message select/update; constrain updates to recipient or sender.
drop policy if exists bv_messages_update on public.messages;
create policy bv_messages_update on public.messages for update to authenticated
using (auth.uid()=sender_id or auth.uid()=receiver_id)
with check (auth.uid()=sender_id or auth.uid()=receiver_id);

-- Social activity notifications
create or replace function public.notify_post_like() returns trigger language plpgsql security definer set search_path=public as $$
declare owner_id uuid; actor_name text;
begin
 select user_id into owner_id from public.posts where id=new.post_id;
 select username into actor_name from public.profiles where id=new.user_id;
 if owner_id is not null and owner_id <> new.user_id then
  insert into public.notifications(user_id,actor_id,type,title,body) values(owner_id,new.user_id,'like','New like',coalesce(actor_name,'Someone')||' liked your post.');
 end if; return new; end; $$;
drop trigger if exists on_post_like_notification on public.post_likes;
create trigger on_post_like_notification after insert on public.post_likes for each row execute procedure public.notify_post_like();

create or replace function public.notify_post_comment() returns trigger language plpgsql security definer set search_path=public as $$
declare owner_id uuid; actor_name text;
begin
 select user_id into owner_id from public.posts where id=new.post_id;
 select username into actor_name from public.profiles where id=new.user_id;
 if owner_id is not null and owner_id <> new.user_id then
  insert into public.notifications(user_id,actor_id,type,title,body) values(owner_id,new.user_id,'comment','New comment',coalesce(actor_name,'Someone')||' commented on your post.');
 end if; return new; end; $$;
drop trigger if exists on_post_comment_notification on public.post_comments;
create trigger on_post_comment_notification after insert on public.post_comments for each row execute procedure public.notify_post_comment();

create or replace function public.notify_follow() returns trigger language plpgsql security definer set search_path=public as $$
declare actor_name text;
begin
 select username into actor_name from public.profiles where id=new.follower_id;
 insert into public.notifications(user_id,actor_id,type,title,body) values(new.following_id,new.follower_id,'follow','New follower',coalesce(actor_name,'Someone')||' started following you.');
 return new; end; $$;
drop trigger if exists on_follow_notification on public.follows;
create trigger on_follow_notification after insert on public.follows for each row execute procedure public.notify_follow();
