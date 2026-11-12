# KittyMart source

React 19 app (create-react-app). A cat-themed port of the PuppyMart game code.

- `src/App.js` – the game. `src/catData.js` – cat breeds, zones, names and the cartoon cat art generator.
- `src/backend.js` – data layer. With no server configured (`KM_SUPABASE_URL` empty) KittyMart runs fully offline:
  accounts, cats, points and races are stored in this browser's localStorage (`km_*`). Online features
  (other players, live race rooms, friends, trades, shared leaderboard) need a KittyMart server; set
  `KM_SUPABASE_URL` / `KM_SUPABASE_KEY` in `backend.js` to a *new* Supabase project made for KittyMart.
- Build: `npm install && CI=false npm run build` (homepage is ".", so the output works from any sub-path, e.g. GitHub Pages).
- `classic/` in the published site holds the earlier simple version of the game.

## Real cat photos (thecatapi.com + cataas.com)

- `src/photos.js` fetches real photos from two sources and always falls back to the cartoon portrait:
  1. **The Cat API** for real breeds: `https://api.thecatapi.com/v1/images/search?breed_ids=<id>&limit=10`
     (images from `https://cdn2.thecatapi.com/`). Works without a key at low volume; optional free key in `CATAPI_KEY`.
  2. **CATAAS** for colour/pattern "breeds" (Calico, Tortoiseshell, Tuxedo Cat, Ginger Tabby, Cream, Fawn, Black & White,
     Grey & White, Ginger & White, Tabby & White): `https://cataas.com/api/cats?tags=<tag>&limit=20`, or, if that listing
     isn't reachable from the browser, the documented random-by-tag image URL `https://cataas.com/cat/<tag>?width=500`.
     Tags used are confirmed in CATAAS's `/api/tags` list: calico, tortoiseshell, tuxedo, orange, ginger, cream, black,
     white, blackandwhite, gray, tabby. `PHOTO_TAGS` in `src/catData.js` maps breed -> tag. Fawn, Grey & White and Ginger & White
     use the nearest confirmed tag (cream / gray / orange). Lykoi has no tag and uses Russian Blue photos from the Cat API.
- Order tried per breed: CATAAS tag pool -> nearest Cat API breed pool (`catApiId`) -> cartoon.
- Each caught cat stores its own photo URL in `photo_url`. Photo lists are cached per source in localStorage
  (`km_catapi_pool_v1`, refreshed every 14 days). Older cats saved with the cartoon pick a stable photo from their breed's pool.
- A global `error` handler swaps any failed thecatapi.com / cataas.com `<img>` to the cartoon, so there are never broken images.
- Network note: a wrapper/CSP/ATS config must allow `api.thecatapi.com`, `cdn2.thecatapi.com` and `cataas.com`.
- Header: the "online" count is only shown when a KittyMart server is configured; the version label is `v1.<build-137>`
  (`APP_VERSION` in `App.js` and `public/version.json` must match; bump both to force old clients to refresh).
