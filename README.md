# PWA Wikimedia Commons Uploader

[![Quality Gate Status](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Coverage](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=coverage)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Bugs](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=bugs)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Vulnerabilities](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=vulnerabilities)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Code Smells](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=code_smells)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Duplicated Lines](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=duplicated_lines_density)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Maintainability](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=sqale_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Reliability](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=reliability_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Security](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=security_rating)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Lines of Code](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=ncloc)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)
[![Technical Debt](https://sonarcloud.io/api/project_badges/measure?project=vitaly-zdanevich_PWAWikimediaCommonsUploader&metric=sqale_index)](https://sonarcloud.io/summary/new_code?id=vitaly-zdanevich_PWAWikimediaCommonsUploader)

A small, fast, framework-free PWA that uploads photos and videos to
[Wikimedia Commons](https://commons.wikimedia.org/). Works offline, installs to the
home screen (full screen), survives app/device restarts mid-upload, and runs fully
in the browser — the only server involved is Wikimedia itself (plus an optional
conversion endpoint for formats Commons rejects).

**App:** https://vitaly-zdanevich.github.io/PWAWikimediaCommonsUploader/

> You can usually upload only media you created yourself (own work) under a free
> license. Photos of buildings, monuments and artworks may be restricted in some
> countries (no or limited [Freedom of Panorama](https://commons.wikimedia.org/wiki/Commons:Freedom_of_panorama)) —
> check before uploading.

## Features

- OAuth 2.0 login (PKCE, no server), multiple accounts with switching
- Select many images/videos, or take a photo/video with the camera (iOS and Android)
- Receive photos shared from other apps: on Android the installed PWA appears in the
  system share sheet; iOS never lets PWAs into its share sheet, so there use
  Photos → Copy → 📋 Paste (also Ctrl/Cmd+V on desktop)
- Per-file optional name, description, license and categories, with a full-width photo preview before the edit controls; global categories and file-name prefix
- Category autocompletion (your saved categories + Commons prefix search); a click on an added category chip opens it on Commons
- 📍 Nearby: finds the closest Commons categories via Wikidata (geolocation), with direction arrow and distance in meters, ordered by distance
- When photos are added, EXIF GPS from the first photo alone proposes the closest available categories within 25 km as one-tap chips; 📍 Nearby uses that same location when available
- ✨ Namify: renames all GPS-tagged files to `2026july_46_54_76_to_26_55_56_iphone7plus`
  (date, coordinates and camera from EXIF), adds "Feel free to rename to something
  more descriptive." to the description, and files them into the hidden
  [Category:Files with coordinate-based names uploaded by PWA](https://commons.wikimedia.org/wiki/Category:Files_with_coordinate-based_names_uploaded_by_PWA)
  so they stay findable for future renaming
- Default license CC BY 4.0 (changeable); prefixes and categories are saved for reuse
- Generic file names that Commons rejects (`IMG_*`, `DSC*`, `PXL_*`, UUID-style
  `05998DD7-…`, `20230101_123456`, digits-only, …) are highlighted in orange
  until they are renamed or given a prefix
- Chunked, resumable uploads: continues after switching apps, going offline, or a device restart (queue and file bytes persist in IndexedDB)
- Clear red errors from Commons, including links when the file name is taken or an identical file (same SHA1) already exists — after a rename, retry republishes instantly without re-uploading
- Text-only list with ✅ when uploaded (thumbnails can be enabled in Preferences)
- Uploaded files stay editable: change description/categories/license and push with
  "Update on Commons" — refused if anyone else edited the page since, to never
  overwrite their work (renaming is excluded: it needs the filemover right)
- After uploading: copy the list of direct file URLs or Commons page URLs (one per line)
- HEIC / H.264 / H.265 files are sent to a configurable conversion endpoint (AWS Lambda)
- Dark mode with pure `#000` background (`prefers-color-scheme`)
- Every upload gets the hidden tracking category `Uploaded by PWA from Vitaly Zdanevich` on the last line of the wikitext

## Setup (one-time)

1. **Register an OAuth 2.0 client**: go to
   [Special:OAuthConsumerRegistration/propose/oauth2](https://meta.wikimedia.org/wiki/Special:OAuthConsumerRegistration/propose/oauth2)
   on Meta-Wiki and propose a consumer with:
   - OAuth protocol: **OAuth 2.0**
   - **This consumer is for use only by <you>**: leave unchecked if other accounts should log in
     (note: until an OAuth admin approves the consumer, only the proposing account can use it)
   - Callback URL: `https://vitaly-zdanevich.github.io/PWAWikimediaCommonsUploader/` (exactly, with the trailing slash)
   - Applicable project: restricting the consumer to `commons.wikimedia.org` is fine and is
     the least-privilege choice — the app talks only to Commons (login still happens via
     Meta, which works regardless of this restriction)
   - **Client is confidential: leave unchecked.** This PWA is a "web app without a server
     component": it runs entirely in your browser from GitHub Pages, so there is nowhere to
     store a client secret — any secret shipped in the JavaScript would be public anyway.
     Instead of a secret the app uses PKCE (`code_challenge` at login, `code_verifier` at the
     token exchange). If you check it by mistake, the token endpoint will require a
     `client_secret` the app never sends, login will fail with an "invalid client" error, and
     the setting cannot be changed afterwards — you would have to register a new consumer.
     After submitting, only the **client ID** matters — Meta-Wiki shows it using OAuth 1.0a
     wording as the "consumer key" (or "client application key"). The "consumer secret"
     displayed next to it is the client secret; ignore it.
   - Allowed OAuth2 grant types — check:
     - Authorization code
     - Refresh token

     *Authorization code* is the login flow itself (with PKCE). *Refresh token* is needed
     because access tokens expire after about 4 hours and the app refreshes them silently —
     otherwise you would sign in again every 4 hours and interrupted uploads could not resume
     unattended. *Client credentials* stays unchecked: it is a machine-to-machine flow where
     the app itself authenticates with a client secret (confidential clients only); this app
     always acts as the signed-in user.
   - Applicable grants — check exactly these three, nothing more:
     - Basic rights
     - Create, edit, and move pages
     - Upload new files

   "Create, edit, and move pages" is required because publishing an upload creates the
   file description page (`createpage`/`edit`). "Upload, replace, and move files" is **not**
   needed: the app never overwrites or moves existing files — a taken name or duplicate
   is reported as an error instead.
2. Open the app → ⚙ Preferences → paste the **client ID** (or set `DEFAULT_OAUTH_CLIENT_ID` in `src/config.ts`).
3. Sign in.

## Conversion endpoint contract (AWS Lambda, to be developed)

The app `POST`s `multipart/form-data` to the URL set in Preferences:

| field      | value                                            |
| ---------- | ------------------------------------------------ |
| `file`     | the original file (HEIC/MP4/MOV/…)               |
| `filename` | desired Commons file name (extension may change) |
| `text`     | ready wikitext for the file page                 |
| `comment`  | upload comment                                   |
| `token`    | the user's OAuth 2 access token (Bearer)         |

The Lambda converts (HEIC→JPEG, H.264/H.265→WebM/VP9), uploads to Commons with the
token, and replies `200 {"pageUrl": "...", "fileUrl": "..."}` or `{"error": "message"}`.

## Development

```sh
npm install
npm run dev        # local dev server
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # vite build + HTML minification + service worker generation
npm run icons      # regenerate PNG/ICO icons from public/icons/icon.svg
```

No runtime dependencies; TypeScript, built with Vite targeting Safari 14+ (works on iOS 15).

## Versioning and deployment

- Every commit bumps `version` in `package.json`: **minor** for a new feature,
  **patch** for a fix.
- CI (GitHub Actions) runs lint, typecheck, tests and build on every push;
  it deploys to GitHub Pages only when the commit changed the version.

## Adding it to Telegram

Yes — this PWA can be attached to an existing Telegram bot as a
[Mini App](https://core.telegram.org/bots/webapps): in @BotFather use
*Bot Settings → Menu Button* (or `web_app` inline buttons) and point it to the
GitHub Pages URL. Caveats: inside Telegram's webview the OAuth redirect works as a
normal navigation, but storage may be isolated from your regular browser, so you
sign in once inside Telegram too; iOS Telegram may not keep long uploads running in
the background as reliably as the installed PWA.

## Rate limits

Commons allows regular users **380 upload API requests per 72 minutes** (each 16 MB
chunk and each publish counts as one). When throttled (HTTP 429), the app pauses the
queue and retries automatically; large batches may take a while. Users in the
`autopatrolled` group on Commons are effectively unlimited.

## Notes on iOS

- Install via Safari → Share → *Add to Home Screen* for full-screen mode.
- iOS suspends web apps when the screen locks or you switch away — there is no
  background-upload API in iOS Safari. While uploading, the app keeps the screen
  awake: via the Wake Lock API where available (Android, iOS 16.4+), or on older
  iOS by playing a hidden video with a silent audio track (muted playback does
  not prevent sleep there — a side effect is that starting an upload may pause
  your background music). The lock button still suspends the app; reopen it and
  the upload continues automatically from the last uploaded chunk.

Category: https://commons.wikimedia.org/wiki/Category:Uploaded_by_PWA_from_Vitaly_Zdanevich

Wikidata: https://www.wikidata.org/wiki/Q140522959

See also https://commons.wikimedia.org/wiki/Commons:Upload_tools
