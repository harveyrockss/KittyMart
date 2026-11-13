# KittyMart backlog

## Done
- Real photos: Cat API (breeds) + CATAAS (colour/pattern) with cartoon fallback (earlier runs).
- Honest header (no fake online count offline). Run 3: also hid "online" badges on leaderboard/friends when offline.
- Wording sweep: visible UI text had no dog/puppy/PuppyMart left except "N dogs" breed count (fixed -> cats). Leaderboard "Season 35" -> Season 1 (starts Nov 2026). Version label now v1.2 (APP_VERSION 139).

- Run 3b: photo fix. When a CATAAS tag photo (calico, blackandwhite, orange...) fails to load, the <img> now swaps to a real Cat API photo of the nearest breed before falling back to the cartoon; failed tag pools are dropped and all of a breed's photo sources are pre-warmed. v1.3.

- Run 4: dog bark synth replaced with a synthesized meow (`playMeow`, pitch varies per breed); "poo" wording -> litter trays (daily challenges, Litter Scooper power-up, stats row). v1.4 (APP_VERSION 141).

- Run 5: cat-only purr sound (`playPurr`, soft low rumble) when feeding a cat; Race tab subtitle is offline-honest ("Race the computer cats"). v1.5 (APP_VERSION 142). Tabs/signup/race screenshot checked, no console errors.

- Run 6 (bug report from phone screenshot: "saved-data space on this phone is full: 5 cats could not be updated"): cause was each cat row storing its whole cartoon SVG as photo_url (~10KB x 74 cats). Offline store now strips cartoon art on save, regenerates it from the breed on load, compacts old saves on first load (test: 2.25MB -> 25KB), and clears the re-downloadable photo-list cache then retries if a write still fails. v1.6 (APP_VERSION 143). Players should just reload to pick it up.

- Run 7: Race "Host a Race Room"/"Join a Race" cards greyed with "Needs online play" note + toast when offline. Login: when no account exists on this device, the error now explains accounts are saved per browser/phone (likely why Indiana could not log in from another device; her account exists only where she signed up). v1.8 (APP_VERSION 145). Tabs/signup/login checked, no console errors.

- Run 8: 4 cat-only achievements (Purr Maker=feed 10x, Tidy Tray=scoop 5 litter trays, Nine Lives=9 of one breed, Cat Café=20 cats); 'A Small Pack' -> 'Little Clowder'. v1.9 (APP_VERSION 146). Signup/tabs/race/mart checked, no console errors. Note: feed/litter achievements are evaluated when the collection changes.

- Run 9: 4 cat-flavoured daily challenges added (snack-purr, food bowls, scoop trays, napping cats). v1.10 (APP_VERSION 147). Signup/tutorial/tabs (Catch, Mart, Race, Home) checked, no console errors.

- Run 10: cat-only Nap feature: 😴 button on each cat card (6h cooldown per cat, +8 XP, purr sound, toast) and new achievement 'Cosy Napper' (5 naps). v1.11 (APP_VERSION 148). Tabs/nap/collection checked with playwright, no console errors.

- Run 11: wording sweep: litter-tray pickup overlay ("Poo!" -> "Litter Tray!", 💩 -> 🧹), vet banner "per dog" -> "per cat". v1.12 (APP_VERSION 149). Signup + Home/Catch/Mart/Race tabs checked, no console errors.

- Run 12: cat-only Pet button (💜 on each cat card: purr + 3 XP, 1h cooldown per cat); Feed icon 🍖 -> 🐟; cosmetic text 'Dapper doggo' -> 'Dapper kitty'; card button row wraps. v1.13 (APP_VERSION 150). Signup/tabs/collection/pet checked with playwright, no console errors.

- Run 13: cat-only Yarn Chase mini-game on Home (15s tap-the-yarn, 3 plays/day, up to +15 pts, meow on hit). v1.14 (APP_VERSION 151). Signup/Home/Catch/Mart/Race checked with playwright, no console errors.

- Run 14: cat-only treat-lure catch twist: 🐟 'Throw a Treat' button on Catch (1 per cat); the cat stops moving and sniffs for 4s (purr), then runs again; resets on each new cat. v1.15 (APP_VERSION 152). Signup/tabs/catch/treat/mart checked with playwright, no console errors.

- Run 15 (bug report from Indiana's phone, v1.14: "saved-data space on this phone is full: 7 cats could not be updated" with 118 cats): ROOT CAUSE found: offline, the cloud-backup (player_data, which packs every km_ key) was saved into km_db_players, which is itself a km_ key and its write re-triggered a save every 5s, so each save nested the previous backup and the row grew until storage filled. Fixed 3 ways: (1) setItem hook ignores km_db_* keys, (2) backup packing skips km_db_* and photo-pool caches, (3) offline store never keeps player_data and strips an existing bloated row on load (tested: 3MB -> 249 bytes, stays stable across saves). v1.16 (APP_VERSION 153). Indiana should reload the app twice (first load cleans, needs the new version.json).

- Run 16: Cosy Cat Pack set up (Harvey asked, to cover running costs): Mart > 🧶 Cosy Pack tab, $2.99 one-time (not sellable on web), parental gate before purchase, Restore button, 4 dress-up items + per-cat dress-up picker, entitlement `km_pack_cosy`. Real purchase needs RevenueCat/App Store Connect on a Mac: see IAP_SETUP.md (also has a prompt for PuppyMart). Web test unlock: `?testpack=1`. v1.17 (APP_VERSION 154). Gate/unlock tested; dress-up with an owned cat not yet exercised by script.

- Run 17: 'Transfer my cats': Settings > 📦 Save My Cats to a File / 📥 Load Cats from a File (JSON backup of all km_ data, photo caches excluded) so Indiana's account can move between phones offline. Tested save + load + reload with playwright, no console errors beyond blocked network. v1.18 (APP_VERSION 155). Loading a backup replaces local data (confirm dialog).

- Run 17 (bug report from Indiana: Training School showed the cartoon instead of the real photo): Training School (both available and in-training cards), champion card and 2 other thumbnails used `photo_url` directly (cartoon offline); now use `dogImageSrc()` (real photo, cartoon fallback) and the school warms each cat's photo list first. v1.19 (APP_VERSION 156). School tab loads with no console errors; real-photo swap NOT verified by script (sandbox blocks the photo APIs and test account has no Lv5 cat), please confirm on a phone.

## Next (priority order)
0. Super Fan unlock (extra daily plays/slots, nothing locked) after Cosy Pack is live; dress-up UI should also show on the Cats card.
1. Cat-only features for App Store differentiation (one per run): cat-bed house layout (nap button done run 10), (yarn-chase done run 13), (treat-lure done run 14), cat daily challenges (achievements done run 8) ("Pick up 3 poos" is still PuppyMart flavoured -> litter-box wording), purr sound on cat pet (feed done).
2. Source comments/identifiers still say dog/poo (internal only; low priority).
3. Accounts are per-device offline: a real fix needs a new KittyMart Supabase project from Harvey. (File transfer done run 17.)

## Known issues
- Automated catch-tap in playwright was flaky (cat moves); catch flow not re-verified by script in run 4 (only playMeow call changed, try/catch-wrapped). Tabs load with no console errors.
- Google Fonts (Nunito) blocked in sandbox only; harmless.
- Home "Weekly Community Goal" is local-only offline.
