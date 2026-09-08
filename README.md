# BloxVibe 2.0

Instagram-inspired Roblox community social platform backed by Supabase.

## Features
- Persistent Supabase login/session
- Profiles, avatars, bios, public profile pages
- Follow/unfollow, followers/following counts and Following feed
- Home feed, Explore/Search and hashtags
- Text, photo, GIF, WebP, MP4 and WebM posts; multi-file posting and previews
- Captions up to 500 characters; media up to 8 MB per file
- Likes, comments, comment deletion, save/unsave, share to DM
- Hashtag and @mention indexing/display
- Stories with 24-hour expiry, image/video upload, captions, viewer navigation and views
- Direct messages, realtime updates, read receipts, typing indicator, delete message
- Notifications for messages, likes, comments and follows
- Browser notifications
- Audio/video WebRTC calls with incoming accept/decline
- Online status and last seen fields
- Block and report tools
- Saved posts
- Responsive desktop/tablet/mobile UI with mobile bottom navigation
- Instagram-inspired smooth feed UI and touch/double-tap liking
- Basic profile data export

## Setup
1. Put `index.html`, `app.js`, `style.css` in your GitHub Pages repository root.
2. Open Supabase SQL Editor and run the entire `schema.sql` once against your BloxVibe project. It is designed to be rerunnable.
3. Confirm the `posts` and `stories` Storage buckets exist.
4. Open the GitHub Pages HTTPS site and test with two accounts/browsers.

## Notes
- Keep the `sb_publishable_...` key in the frontend. Never expose an `sb_secret_...` key.
- WebRTC calls may need a TURN server on restrictive networks.
- Browser notifications require user permission. True closed-browser push notifications need a service worker/push provider.
- Supabase Realtime is used for database changes and Broadcast signaling.
