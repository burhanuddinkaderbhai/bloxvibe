# BloxVibe

A Roblox-inspired fan community MVP with:
- Email/password accounts
- User profiles and avatars
- Status posts
- Picture posts
- Direct messages
- Browser-to-browser video/audio calls
- Supabase realtime messaging/signaling

## Setup

1. Create a free Supabase project.
2. Open SQL Editor and run `schema.sql`.
3. In Storage, create two PUBLIC buckets:
   - `posts`
   - `avatars`
4. Open `app.js` and replace:
   `PASTE_YOUR_SUPABASE_URL`
   `PASTE_YOUR_SUPABASE_ANON_KEY`
5. For email/password signup, configure Supabase Auth > URL Configuration with your deployed site URL.
6. Upload these files to a static host such as GitHub Pages, Netlify, or Cloudflare Pages.

## Important production upgrades

Before opening this to a large public audience:
- Add storage RLS policies.
- Add rate limits / anti-spam.
- Add report, block, mute and moderation tools.
- Add age-appropriate safety controls and community rules.
- Add pagination/infinite scroll instead of loading 80 posts at once.
- Use a TURN server for reliable calls behind restrictive networks.
- Add call permissions/error handling and call notifications.
- Consider a backend/serverless function for moderation and abuse prevention.

BloxVibe is an independent fan community and is not affiliated with Roblox Corporation.
