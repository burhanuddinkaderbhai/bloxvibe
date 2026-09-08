# BloxVibe

BloxVibe is a static front-end community app backed by Supabase.

## Included

- Supabase email/password accounts
- Automatic profile creation for new Auth users
- Existing-user profile backfill in `schema.sql`
- Public profiles
- Profile editing
- Text/status posts
- Picture posts with captions
- JPG, PNG, WebP and GIF uploads
- 8 MB image limit enforced by the app and Storage bucket
- 500-character caption limit enforced by the app and database
- Picture preview before posting
- Home composer and New Post modal
- Direct messages
- Supabase Realtime message updates
- In-app and browser message notifications
- Audio calls with WebRTC
- Video calls with WebRTC

## Setup

1. Replace the files in your GitHub Pages repository with the files in this folder.
2. In Supabase, open **SQL Editor → New query**.
3. Copy the entire `schema.sql` into the SQL Editor and click **Run**.
4. Confirm `profiles`, `posts`, `messages`, and `notifications` exist in Table Editor.
5. Confirm the `posts` Storage bucket exists and is public.
6. Open the GitHub Pages HTTPS URL.
7. Create a test account.
8. Test from two separate accounts/browsers.

## Realtime

The SQL script adds `messages` and `notifications` to the `supabase_realtime` publication. Supabase Realtime Postgres Changes requires the relevant tables to be in that publication and access to be allowed by RLS.

## Calls

Calls use WebRTC for media and Supabase Realtime Broadcast for signaling. HTTPS and browser microphone/camera permission are required. The included STUN server helps establish peer connections; some restrictive networks still require a TURN server for reliable connectivity.

## Security

Never put an `sb_secret_...` key in this front-end. The site uses the Supabase `sb_publishable_...` key.
