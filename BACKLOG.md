# KittyMart backlog

## Done
- Real photos: Cat API (breeds) + CATAAS (colour/pattern) with cartoon fallback (earlier runs).
- Honest header (no fake online count offline). Run 3: also hid "online" badges on leaderboard/friends when offline.
- Wording sweep: visible UI text had no dog/puppy/PuppyMart left except "N dogs" breed count (fixed -> cats). Leaderboard "Season 35" -> Season 1 (starts Nov 2026). Version label now v1.2 (APP_VERSION 139).

## Next (priority order)
1. Cat-only features for App Store differentiation (one per run): cat-bed/nap-spot house, yarn-chase mini-game, treat-lure catch twist, cat achievements/daily challenges ("Pick up 3 poos" is still PuppyMart flavoured -> litter-box wording), purr/meow sounds (playBark in App.js is dog-bark synth -> replace with meow).
2. Source comments/identifiers still say dog (internal only; low priority). Sound function playBark should be a meow.
3. Race tab says "Live multiplayer" while offline; consider offline subtitle.

## Known issues
- Google Fonts (Nunito) blocked in sandbox only; harmless.
- Home "Weekly Community Goal" is local-only offline.
