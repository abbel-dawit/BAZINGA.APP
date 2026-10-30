# ⚡ BAZINGA!

Turn your Spotify Liked Songs and playlists into YouTube music-video **and** audio playlists — with a full music player, albums, artists, queue, filters, sharing, offline files and automatic backups. Everything is stored on the user's own device. No server, no database, no sign-up.

## Put it online with GitHub Pages (free)

1. Create a new **public** repository on GitHub (e.g. `bazinga`).
2. Upload everything in this folder to the repository root (drag-and-drop on the GitHub website works). Keep the folder structure: `index.html`, `sw.js`, `manifest.webmanifest`, `favicon.ico`, `.nojekyll`, `css/`, `js/`, `icons/` (and `src/` + `build.py` if you want to edit later). `index.html` must be at the top level of the repo, not inside another folder.
3. Repository → **Settings → Pages** → Source: *Deploy from a branch* → Branch: `main`, folder `/ (root)` → Save.
4. After a minute your app is live at `https://<your-username>.github.io/bazinga/`.

Users can install it like an app: browser menu → **Install** / **Add to Home Screen**.

You can also just double-click `index.html` to try it on your computer — your library and offline files work, but YouTube playback, Spotify login and share links need the hosted GitHub Pages address.

## Editing the code

The readable source is in `src/`. After changing it, run `python3 build.py` to regenerate `js/bazinga.js` (the single file the app loads).

To ship an update, edit the files and bump `VERSION` in `sw.js` (currently `bazinga-v41`) so phones fetch the new version.

## Features

- **No login**: open it and press *Let's go*. An optional name + picture live on the device (Settings). *Erase this device* wipes everything.
- **Sync your devices (no account)**: Settings → Sync your devices → *Link a device* shows a QR code, a link and an 8-character short code. Scan / open / type it on another phone, computer or another browser on the same phone, and they stay in sync automatically.
- **Import**: Apple Music (library `.xml` or playlist `.txt` exported from the Music app on Mac/Windows — playlists, Favorite songs, genres, years), Spotify Liked Songs & playlists (each user connects with their own free Spotify developer Client ID, so there is no shared rate limit), CSV files (e.g. from exportify.net — no Spotify key needed), pasted "Artist - Title" lists, and music files/folders on the device.
- **YouTube**: finds an official **music video** and an **audio** version (Topic channel / official audio) for every song. Switch between Video and Audio any time in the player. "Open on YouTube" turns any playlist into YouTube playlist links (50 songs per link). Any match can be fixed by pasting a link.
- **Player**: play/pause, next/prev, seek, shuffle, repeat (all/one), volume, lock-screen controls, Add to queue, Play next, drag-to-reorder queue.
- **Library**: Songs, Liked, Playlists, Albums, **Artists list** (everyone in your music), genre pages.
- **Filters**: by genre, release decade or exact year range, liked-only, offline-only, plus sorting by date added / title / artist / album / release date.
- **Albums**: search any album, open the album of any song, **save full albums** to your library.
- **Artists**: "Go to artist" from any song → popular songs, full discography, and your songs by them.
- **Sharing**: share a song, playlist or album as a link. The whole list is packed inside the link — nothing is uploaded. The receiver can play it and save it into their own library.
- **Offline**: add music files you own; they're matched to your songs automatically, grouped into albums, and play without internet. The app itself also opens offline.
- **Backups (auto-updating, on device)**: rolling snapshots after every change (last 5), plus on Chrome/Edge desktop a linked backup **file** that rewrites itself automatically. On every browser: one-tap download and restore of a backup file.


### New in v1.6
- **Theme colors**: Volt (the original yellow), Mint, Violet, Indigo, Ocean, Cyan, Gold, Sunset, Rose and Crimson. Pick one on the welcome card or in Settings → You. Buttons, glows, the logo bolt, the wordmark shadow, the tab icon and the Home Screen icon all follow it, and it's remembered on the device. (Recolored icons live in `icons/theme/`; `build.py` writes one install manifest per color.)
- **Splash screen** in your theme color while the app starts, with fun lines under the logo that change every few seconds ("Charging the lightning ⚡", "Warming up the speakers 🔊"…).
- **"When the queue finishes"** options evenly spaced.
- **Sleep timer**: timer icon in the full-screen player's top bar (left of ⋯). 5 min to 1.5 hours, or the end of this song. The music fades out gently and pauses; the icon lights up while it's set and the menu shows the time left.
- **BAZINGA! button** on Home (replaces "Ask BAZINGA!" there): builds a fresh mix (it plays from the queue; it's only saved as a playlist if you tap + in the queue) of songs you don't have yet from your top 50 artists (taking turns, #1 first), then today's top songs in your top genres. The music starts as soon as the first few artists are in; the rest fills in behind it. New listeners pick favorite genres, then favorite artists (top 10 per genre) first.
- **Music video is the default** playback version (Audio is still one tap away and remembered).
- **Video dock (computers)**: the full-screen button uses the expand icon; the resize button is an arrow that points up when the video is small and down when it's big (size remembered). A soft loading veil shows while a song starts. Back to top sits to the left of the video.
- **Home**: the clock sits in the top-right corner of the card (on phones, on the same line as the date).
- **Search**: songs are listed first under All.
- **Sort** opens an on-screen list like Filters instead of the system picker.
- **"Do you love BAZINGA!?"** popup: every 10th time the app is opened. Thumbs up → a thank you and Buy Me a Coffee (big theme-bordered "Not now"); thumbs down → a sad face and it closes.
- **Home buttons**: BAZINGA! is the main button (then Search and Import with an empty library; then Play Liked Songs and Shuffle everything once you have music).
- **New from your top artists**: 10 in a sideways row with *See more*, which opens the full list 25 at a time (top 6 artists looked up first, the next 14 in the background).
- **Mic buttons** always go back to normal when the assistant closes (Safari kept the tap/hover look stuck).
- **No more "Hey Bazinga" background listening**: the microphone is only on while the assistant is open.
- **Pull down to close** the full-screen player from anywhere at the top of it (top bar, cover, song info, controls, or the top part of the video). It follows your finger and springs back if you don't pull far enough.
- **Save the queue as a playlist** (+ in the queue card), only for a BAZINGA! mix or a shuffled queue.
- **Phones turned sideways**: the sidebar is a single column of normal-sized icons that scrolls up and down, song times sit together on the right ("1:19 / 3:49"), a compact home card, a smaller corner video, and a full-screen player with the video on the left and the title, like, artist, timeline and controls on the right (no scrolling needed). Phones upright: the normal video size. Smaller clock on small screens; evenly spaced top-bar icons; back to top sits above the corner video again; the BAZINGA! button's bolt stays still.
- **Settings tabs** follow you as you scroll (the section you're on is highlighted; none at the top).
- **Phone menus** (the song ⋯ sheet and others) have a handle and close when you pull them down.
- **No more previews**: YouTube matching skips previews, snippets, teasers and Shorts (by title and by length compared with the real song), and earlier matches that were previews are looked up again.
- **Search**: one row per song (single/album/deluxe, explicit/clean, "feat." and remaster duplicates merged; remixes and live versions kept), and songs already shown under "In your library" aren't repeated.
- **Sideways phones**: the genre / year / length pills sit at the far right under the heart, next to the album.
- **Big libraries sync reliably**: ntfy.sh's free tier only accepts files up to 2 MB. The library is always compressed (gzip where the browser has it, BAZINGA!'s own LZ compression otherwise, e.g. iPhones before iOS 16.4), YouTube matches travel as ids only, and anything over 1.5 MB goes in parts that download side by side. If the relay still says "too big", the parts shrink automatically (down to 64 KB); if its storage is full, sync quietly retries later. The unchanged library is re-sent only every ~2.3 h, using less of the relay's storage.
- **Playlist page**: one ⋯ menu (on phones it also holds Find YouTube matches / Save to YouTube).
- **Live sync between devices**: a like/unlike, playlist change, new song or setting goes to your other devices within seconds, as a small change (usually a few hundred bytes) instead of the whole library; open devices hear about it straight away over a live connection to the relay. The full library is re-sent every couple of hours so devices that were closed catch up.
- **Continue on another device**: the song, the spot in it and the queue go to your other devices when you pause, switch songs (at most every 3 minutes) or leave the app. A device that isn't playing anything picks it up and offers "Continue … ▶".
- **Covers**: the song's letter on its own colour shows until the picture arrives, then it fades in; pictures that loaded once show instantly afterwards (remembered, and kept in the offline picture cache).
- **BAZINGA! button**: the bolt is drawn in the page (no picture to load), so it never flickers when you come back to Home.
- **Sync now includes settings and connections**: API keys, tokens, servers, theme, playback options, Spotify/YouTube connections, YouTube playlist links and your taste picks. Each setting remembers when you changed it and the newest change wins. A device that never set something can't wipe it, and removals only spread when you disconnect on purpose.
- **Voice assistant**: loud chime when it starts listening; music stays silent until the assistant closes; closes after ~3.5 s if it hears nothing; mic buttons show a theme-colored ring while it's open and go back to normal after. iPhone now speaks with the phone's own (Siri-quality) voice instead of Apple's robotic "compact" voices, in one smooth sentence, after switching audio back from "phone call" mode.

### New in v1.5
- **No more logins.** Google / Discord / email sign-in is gone. The welcome screen is one tap (accept the terms → *Let's go*), with *I use BAZINGA! on another device* for joining an existing library.
- **Sync with a QR code, link or short code.** Settings → *Sync your devices* → *Link a device*. Scan the QR code with the other phone's camera, open the link in any browser (another browser on the same phone counts too), or type the short code (e.g. `K7M2-Q9XA`, works once for 15 minutes; short link `…/#/c/K7M2Q9XA`). After that, songs, likes, playlists, albums, YouTube matches and your name/photo sync automatically. The library is **encrypted on the device** before it leaves; the relay only carries unreadable bytes. *Stop syncing this device* / *Turn off sync everywhere* are under Settings. No setup: it uses the free ntfy.sh relay (see below).
- **Screen lock**: lock button in the phone top bar, the sidebar and the full-screen player, or tap an empty spot 3 times quickly. Tap 3 times anywhere to unlock; music keeps playing. On/off in Settings → Playback.
- **Home**: the device's time (its own time zone and 12/24-hour format) sits beside the date and updates every minute.
- **Artist pages**: *Top 10 albums* card grid under the top 10 songs (albums holding the most popular songs first).
- **Sort button**: label centred with the arrow right next to it.
- **No more zooming**: pinch/double-tap zoom and the iPhone zoom-in when tapping a search box are off.
- **Progress bar fix**: the yellow timeline could freeze while music kept playing (after a drag that got interrupted by scrolling, or when the next song started mid-drag). Fixed, plus the timer now always restarts when playback starts.
- **"Couldn't start" fix**: the old 4-second check showed an error on slow connections even while the app was still downloading. Now the app retries the script, then repairs its cached files once by itself, and only then shows a friendly *Sorry* screen with *Try again* and *Help* (step-by-step fixes + *Repair app*). The service worker also falls back to the saved copy after 4 s on a slow network.
- **Home Screen app**: the bottom menu sits right on the bottom edge (no gap), and the page snaps back if the phone leaves it scrolled after the keyboard closes.
- **Popups**: "Add to Home Screen" on the first visit, then every 5th visit until installed or *Don't show this again*. Buy Me a Coffee every 10th visit until *Don't show this again*. Both close with the × or by tapping outside.
- **Auto-update on launch** (see below). **Account card**: the four counters are smaller and on one line (2×2 on very narrow phones). **Logo glow** sized so it's never cut off.
- **Removed**: the Top 5 tippers board and live Phase 2 totals (they needed a database).
- **Android / Samsung Internet**: its installer makes an app Google Play Protect blocks, so the Add-to-Home-Screen popup there suggests installing from another browser (Chrome, Firefox, Edge, Brave or Opera) with a *Copy link* button.
- **iPhone Home Screen app (iOS 26)**: fixed the gap / cut-off bottom menu (WebKit bug where the page gets a too-short viewport).
- **Safari & blocked networks**: YouTube search no longer depends only on the free Invidious/Piped servers — if they're slow or blocked (e.g. iCloud Private Relay), BAZINGA! reads YouTube's own results page through free public relays.
- **Search**: results that don't match what you typed are dropped and the best matches come first (one typo allowed); the top results are looked up on YouTube straight away so they start faster.
- **Voice assistant** always closes itself: right after a finished task, or ~8 s after it couldn't help.
- **CSV import**: choose several CSV files at once — each becomes its own playlist (same-named files get "(2)"), only a file named "Liked Songs" goes into Liked Songs, and a summary lists every file imported.
- **Sync progress popup** with a progress bar and **Cancel** (linking, "Sync now"); cancelling leaves the device untouched.
- **Album pages on phones** fit on one line; **Offline files** moved into the ⋯ menu.
- Smaller logo text; the backup notice's × sits top-right on phones.
- Removed the "Tap the video once to start" notice and the Siri voice explanation text. Bigger bolt on the Home Screen app icon.

### New in v1.3
- **Logo** in Bungee; yellow search buttons have a black magnifying glass; Settings' section bar starts with Account (same order as the page).
- **More natural voice**: BAZINGA! ranks every voice your device has and uses the most human-sounding one (Apple Premium/Enhanced, Edge "Natural", Google voices), skips robotic/novelty voices and speaks sentence by sentence at a natural pace. Pick or preview a voice in Settings → Voice assistant. (Web apps can't use Siri's own voice; on iPhone/Mac download a Premium voice for the best result.)
- **"Hey Bazinga" hands-free** (Settings → Voice assistant, off by default): while the app is open, say "Hey Bazinga" or "Bazinga" — or the whole thing, "Hey Bazinga, play my liked songs". The mic buttons glow while it's listening. Needs Chrome, Edge, Safari or Samsung Internet.
- **Tablet / medium screens**: sidebar icons and buttons perfectly centred; the player bar keeps shuffle, previous, play, next, repeat, the progress bar and the video/audio switch.
- **Backup YouTube search**: if the free search servers are down ("Couldn't reach YouTube search"), add a YouTube Data API key as `youtubeApiKey` in `index.html` — it's only used when the free servers fail. Restrict the key to your site's address in Google Cloud Console.

### New in v1.2
- **Phones: songs play again.** The hidden video player is back to YouTube's minimum size (200×200), and if a browser (mostly iPhone Safari) still refuses to start YouTube without a tap on the video itself, the full-screen player opens with a "Tap the video once to start playing" hint — after that one tap everything plays normally for the rest of the visit.
- **Full screen**: no more stuck/floating video (lyrics & queue no longer shift the frame, and leaving the page always puts the video back), the phone's Back button/gesture closes full screen, smoother scrolling (queue renders 100 songs at a time and only when it changes; decorative animations pause).
- **Spotify import via Exportify (default)**: Settings → Import music → From Spotify → *Open Exportify* → *Export All* → come back and choose the file (BAZINGA! asks for it automatically when you return). Reads Exportify's `.zip` (all playlists + Liked Songs) or single `.csv` files. The developer-key connection is still there under "Advanced". Spotify doesn't allow its login page inside other apps, so Exportify opens in a small window / new tab.
- **Top 5 tippers leaderboard** (removed in v1.5 — it needed a database).
- **Voice assistant** understands your library: typo- and sound-alike-tolerant matching against your playlists, artists, albums and songs (checks every way the browser heard you), asks "Did you mean …?" when it isn't sure (Yes/No by voice or buttons; on No it offers the next best match, then asks again).
- **Logo**: Quicksand Bold wordmark centred on the bolt; no version number; taller phone top bar so the glow isn't cut off.
- **App icon & Add to Home Screen**: new black app icon with a glowing bolt (`icons/app-*.png`), and a one-time "Add to Home Screen" pop-up (real install button on Chrome/Edge/Samsung/Brave; step-by-step for iPhone/iPad and Firefox). Also in Settings → Playback.
- **More**: "New from your top artists" follows the artists you have the most songs by; Artists and Albums show 100 at a time with "Show more"; stronger hover highlight; tablet layout (icon-only sidebar, compact player bar); floating back-to-top button; Offline in the phone tab bar; immersive account card in Settings (centred on phones, Support right under it); Playback options on one line; on phones "Find YouTube matches"/"Save to YouTube" live in a ⋯ menu; filter search box with a yellow search button, Filters + sort on one line; Jump back in with a bigger cover (YouTube thumbnails no longer show black bars) and both buttons on one line; the playing song no longer overlaps the next row.
- **Browsers**: checked for Safari 15+ (iPhone/iPad/Mac), Chrome/Edge/Brave/Samsung, and Firefox 102+. Older-Safari fixes: no regex look-behind, `vh` fallbacks, `-webkit-` backdrop blur. Brave/Firefox use the typed voice box (they can't do speech recognition).

### New in v1.1
- **Logo**: glowing bolt that gently grows and shrinks next to the wordmark.
- **Full-screen player**: the video/cover stays still while everything else scrolls (swipe or mouse-wheel anywhere, including over the top bar), the queue scrolls inside its own window, and the lag is gone. Subtitles are off by default.
- **Voice assistant** closes by itself when it's done (stays open if it couldn't help), never leaves the music quieter, and hands the phone's audio back to music mode after using the microphone.
- **Background play**: if the phone pauses YouTube when you switch apps or lock the screen, BAZINGA! starts it again straight away, with lock-screen controls (play/pause/next/previous/seek). See "Honest limits" below.
- **Autoplay**: when the queue finishes it starts your Liked Songs (or replays the queue — Settings → Playback).
- **Refresh / reopen** lands on the same page, scroll position, song and spot in the song.
- **Faster song switching**: the YouTube player loads at start-up, songs are looked up when you rest on/touch them, and the next 3 (and previous) songs are prepared in advance.
- **YouTube backup**: Settings → YouTube backup → "Save playlists to YouTube" creates all the playlists you tick (and Liked Songs) on your YouTube account in one go; later runs only add new songs. Import goes the other way. Without the Google key it gives ready-made YouTube playlist links instead.
- **Import moved into Settings** (Settings → Import music); the Import tab is gone.
- **Library**: broad genres only (Hip-Hop/Rap, Afrobeats, Pop, R&B, Soul, Rock, Country, Jazz, Classical, Electronic, Latin, Reggae, Gospel…) with the top 10 in the filter and no "Unknown"; year filter is multi-select chips (no from/to dates); artists sorted by most songs with search, A–Z letters still work, yellow play buttons; un-liking a song on the Liked page leaves it for a few seconds so you can re-like it; hearts react instantly everywhere; "Undo" on removed-from-playlist and removed-from-Liked.
- **Home**: Jump back in first, then your top 6 playlists as cards with "See all", consistent spacing.
- **Phones**: no mini video pop-up, song rows are the same size liked or not, previous-track button in the mini player, taller solid top bar.
- **Other**: yellow search button, bigger letters on playlists without covers, the playing song pops out with a long 3D yellow shadow, cover art on the minimised video window (desktop), tab title "BAZINGA! - Music Made For You".

### Earlier
- **Voice assistant ("Ask BAZINGA!")**: tap the mic and say things like "play my liked songs", "play Tapout by Rich Gang", "add Essence to the queue", "play my road trip playlist", "search for Burna Boy", "go to my artists", "show the lyrics", "switch to music video", "what's playing?". It answers out loud with the most natural voice the device has. Browsers without speech recognition (e.g. Firefox) get a text box instead.
- **YouTube search** on the Search page (own tab, plus a "From YouTube" section under All). Tapping a result plays that exact video.
- **New from your artists** on Home: latest albums, EPs and singles from the artists you listen to most (refreshed every 12 hours).
- **Lyrics** in the full-screen player via Genius's official lyrics widget. If Genius blocks the lookup from the browser, a one-tap "Open lyrics on Genius" button appears; adding a free Genius access token in Settings → Lyrics lets them load inside the app.
- **Faster everything**: one YouTube search per song (two only when needed), several songs matched at once on different servers, fastest servers used first, upcoming songs looked up in advance, all lookups cached on the device, right-sized images, and a rate limiter that stays under Apple's limits so your IP never gets blocked.
- **Optional accounts & cross-device sync** (replaced by no-login QR/link sync in v1.5): Google, Discord or email + password (with email verification and password reset), powered by Supabase (removed). Guests can keep using the app without an account and upgrade any time; their music is merged in.
- **YouTube account sync**: save any playlist, album or your Liked Songs to your YouTube account (music videos or audio, private/unlisted/public, updates add only new songs), and import your YouTube playlists and Liked videos back in.
- **Better covers**: Deezer and the song's YouTube thumbnail fill in any missing cover art; artists get real photos.



## Device sync — nothing to set up

Sync works as soon as the site is on GitHub Pages. There's no database and nothing to sign up for: devices pass the library to each other through the free public relay **ntfy.sh**, encrypted on the device first (ntfy.sh only sees unreadable bytes under a random topic name).

Good to know:
- Copies on ntfy.sh expire after about **3 hours**. Every open device re-posts its library at least once an hour, and the full library always stays on each device. A device that's been closed longer catches up the next time it's open around the same time as another linked device.
- ntfy.sh is a free community service with fair-use limits (15 MB per file, ~100 MB per visitor). A big library is well under that.
- Want your own relay instead? Run an ntfy server and put its address in `index.html` → `syncRelay`.

## Updates reach users automatically

After editing `src/`, run `python3 build.py` and upload **everything** (including the new `version.json`). Every time someone opens BAZINGA! (or comes back to it), the app compares its version with `version.json` on your site and reloads into the new one straight away. If music is playing, it waits for the next pause.

## Set up YouTube account sync (one time, by the app owner)

"Save to YouTube" and "Sign in with YouTube" need a free Google sign-in key (OAuth Client ID) for your copy of BAZINGA!. Without it, everything else still works, including importing public YouTube playlist links and the no-sign-in "open as a temporary YouTube playlist" option.

1. Go to https://console.cloud.google.com → create a project (e.g. "BAZINGA").
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - User type **External**, app name **BAZINGA!**, your support email, logo (`icons/icon-512.png`).
   - App home page: `https://<your-username>.github.io/bazinga/`
   - Privacy policy: `https://<your-username>.github.io/bazinga/privacy.html` (this file is included and generated by `build.py`).
   - Scope: `https://www.googleapis.com/auth/youtube`.
4. **Credentials → Create credentials → OAuth client ID → Web application.**
   Authorized JavaScript origins: `https://<your-username>.github.io` (no path, no trailing slash).
5. Copy the Client ID (ends in `.apps.googleusercontent.com`) and paste it into `index.html`:
   `window.BAZINGA_CONFIG = { googleClientId: 'YOUR-ID.apps.googleusercontent.com' };`
6. Push to GitHub. Done.

**Limits to know about (set by Google, not BAZINGA!):**
- While the app is in **Testing**, only Google accounts you add as test users can sign in. Switch it to **In production** to open it up: until Google *verifies* the app, users see an "unverified app" warning and at most **100 users** can connect. Submit it for verification in the console to remove both (Google asks for a short screen recording showing what the app does with YouTube access).
- Each Client ID gets **10,000 YouTube units per day**, shared by everyone using it. Creating a playlist costs 50, adding each song costs 50, so roughly **200 songs per day in total**. Uploads that hit the limit pause and can be resumed the next day. Heavy users can paste **their own** Client ID in Settings → YouTube account to get their own daily allowance. You can also request a higher quota from Google.

## Support & socials

- Tips: https://buymeacoffee.com/bazinga.app (Support tab, sidebar, footer, a pop-up every 10th visit until dismissed for good, and Settings). The QR code is `icons/bmc-qr.png`.
- Footer links: Instagram `@bazinga.app`, X/Twitter `@bazinga_app`.

## Honest limits

- **YouTube audio/video can't be downloaded.** Saving YouTube streams breaks YouTube's terms of service and rips copyrighted music, so BAZINGA doesn't do it. Offline playback works from music files the user owns.
- **Keyless YouTube search** goes through free public Invidious/Piped servers, which are sometimes slow or down. For reliable matching, a user can paste their own free YouTube Data API key in Settings. Every match is cached on the device so each song is only searched once.
- **Spotify (2026 rules)**: Spotify requires the developer account to have Premium and only lets apps read playlists the user owns or collaborates on. Users without Premium can use the CSV import instead.
- **Background play on phones**: BAZINGA! restarts YouTube right away when the phone pauses it, and that works on most Android phones. iPhones (Safari) don't allow a web page to play YouTube video with the screen locked, whatever the app does; songs with an offline file always keep playing. Installing BAZINGA! to the Home Screen helps on both.
- Genres, release dates, artwork, albums and artist pages come from Apple's free iTunes Search API (no key).

## Privacy & Terms

Users accept the Privacy Policy & Terms of Use (in `src/legal.js`) on the welcome screen; if you change the text, bump `TERMS_VERSION` and everyone is asked to accept again. The text is a template, not legal advice.


Profile, library, tokens and backups live in the browser's IndexedDB on the user's device. There's no server of our own; optional device sync passes encrypted copies through ntfy.sh. The app only talks directly to Spotify (if connected), YouTube / Invidious / Piped (to find and play videos) and Apple's iTunes Search API (for music info).

---
© 2026 Abbel Dawit
