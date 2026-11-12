# KittyMart backlog

## Done
- Real photos: Cat API (breeds) + CATAAS (colour/pattern) with cartoon fallback (earlier runs).
- Honest header (no fake online count offline). Run 3: also hid "online" badges on leaderboard/friends when offline.
- Wording sweep: visible UI text had no dog/puppy/PuppyMart left except "N dogs" breed count (fixed -> cats). Leaderboard "Season 35" -> Season 1 (starts Nov 2026). Version label now v1.2 (APP_VERSION 139).

- Run 3b: photo fix. When a CATAAS tag photo (calico, blackandwhite, orange...) fails to load, the <img> now swaps to a real Cat API photo of the nearest breed before falling back to the cartoon; failed tag pools are dropped and all of a breed's photo sources are pre-warmed. v1.3.

- Run 4: dog bark synth replaced with a synthesized meow (`playMeow`, pitch varies per breed); "poo" wording -> litter trays (daily challenges, Litter Scooper power-up, stats row). v1.4 (APP_VERSION 141).

- Run 5: cat-only purr sound (`playPurr`, soft low rumble) when feeding a cat; Race tab subtitle is offline-honest ("Race the computer cats"). v1.5 (APP_VERSION 142). Tabs/signup/race screenshot checked, no console errors.

- Run 6 (bug report from phone screenshot: "saved-data space on this phone is full: 5 cats could not be updated"): cause was each cat row storing its whole cartoon SVG as photo_url (~10KB x 74 cats). Offline store now strips cartoon art on save, regenerates it from the breed on load, compacts old saves on first load (test: 2.25MB -> 25KB), and clears the re-downloadable photo-list cache then retries if a write still fails. v1.6 (APP_VERSION 143). Players should just reload to pick it up.

## Next (priority order)
1. Cat-only features for App Store differentiation (one per run): cat-bed/nap-spot house, yarn-chase mini-game, treat-lure catch twist, cat achievements/daily challenges ("Pick up 3 poos" is still PuppyMart flavoured -> litter-box wording), purr sound on cat pet (feed done).
2. Source comments/identifiers still say dog/poo (internal only; low priority).
3. Race sub-cards ("Host a Race Room", "Join a Race") still describe live rooms while offline; consider greying them out with an offline note.

## Known issues
- Automated catch-tap in playwright was flaky (cat moves); catch flow not re-verified by script in run 4 (only playMeow call changed, try/catch-wrapped). Tabs load with no console errors.
- Google Fonts (Nunito) blocked in sandbox only; harmless.
- Home "Weekly Community Goal" is local-only offline.
