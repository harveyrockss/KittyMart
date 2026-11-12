# KittyMart source

React 19 app (create-react-app). A cat-themed port of the PuppyMart game code.

- `src/App.js` – the game. `src/catData.js` – cat breeds, zones, names and the cartoon cat art generator.
- `src/backend.js` – data layer. With no server configured (`KM_SUPABASE_URL` empty) KittyMart runs fully offline:
  accounts, cats, points and races are stored in this browser's localStorage (`km_*`). Online features
  (other players, live race rooms, friends, trades, shared leaderboard) need a KittyMart server; set
  `KM_SUPABASE_URL` / `KM_SUPABASE_KEY` in `backend.js` to a *new* Supabase project made for KittyMart.
- Build: `npm install && CI=false npm run build` (homepage is ".", so the output works from any sub-path, e.g. GitHub Pages).
- `classic/` in the published site holds the earlier simple version of the game.
