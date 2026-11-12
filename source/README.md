# KittyMart source

React 19 app (create-react-app). A cat-themed port of the PuppyMart game code.

- `src/App.js` – the game. `src/catData.js` – cat breeds, zones, names and the cartoon cat art generator.
- `src/backend.js` – data layer. With no server configured (`KM_SUPABASE_URL` empty) KittyMart runs fully offline:
  accounts, cats, points and races are stored in this browser's localStorage (`km_*`). Online features
  (other players, live race rooms, friends, trades, shared leaderboard) need a KittyMart server; set
  `KM_SUPABASE_URL` / `KM_SUPABASE_KEY` in `backend.js` to a *new* Supabase project made for KittyMart.
- Build: `npm install && CI=false npm run build` (homepage is ".", so the output works from any sub-path, e.g. GitHub Pages).
- `classic/` in the published site holds the earlier simple version of the game.

## Real cat photos (thecatapi.com)

- `src/photos.js` fetches real photos from **The Cat API**: `https://api.thecatapi.com/v1/images/search?breed_ids=<id>&limit=10`
  (images are served from `https://cdn2.thecatapi.com/`). It works without a key at low volume; an optional free
  key can be put in `CATAPI_KEY` at the top of `photos.js`.
- `CAT_API_IDS` in `src/catData.js` maps breed names to Cat API breed ids (about 55 of the 65 breeds, including the
  common look-alike coats such as Domestic Shorthair, Grey/Brown/Silver Tabby, Black Cat and White Cat).
  Breeds with no matching API breed keep their cartoon portrait: Calico, Tortoiseshell, Tuxedo Cat, Lykoi,
  Ginger Tabby, Cream Cat, Fawn Cat, Black & White, Grey & White, Ginger & White and Tabby & White.
- Each caught cat stores its own photo URL in `photo_url`. Photo lists are cached per breed in localStorage
  (`km_catapi_pool_v1`, refreshed every 14 days). Older cats that were saved with the cartoon pick a stable photo from their breed's cached list.
- If the API or an image is unreachable, rate-limited, or fails to load, the cartoon portrait is shown instead (a global
  `error` handler swaps any failed thecatapi.com `<img>` to the cartoon), so there are never broken images.
- Network note: a wrapper/CSP/ATS config must allow `api.thecatapi.com` and `cdn2.thecatapi.com` (for an iOS/Capacitor build
  add both domains under `NSAppTransportSecurity`). The photos are third-party content: check the Cat API terms before an App Store release.
