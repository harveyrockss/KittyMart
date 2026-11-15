# Getting KittyMart a 4+ age rating

Apple's rating is set by the questionnaire in App Store Connect (nothing in the code sets it). Answers below match what the app does today (offline mode). Nothing has been submitted.

## Questionnaire answers
- Cartoon/fantasy violence, realistic violence, sexual content, nudity, profanity, horror, mature themes: **None**
- Alcohol/tobacco/drugs, medical/treatment info: **None**
- Simulated gambling / contests: **None**. The daily gift is free, shows the prize up front and stakes nothing (no wheel, no jackpot, no paid random rewards).
- Unrestricted web access: **No** (no browser, no external links except a parent-gated support email).
- User-generated content / chat: **None** while offline (no player-to-player messages; names stay on the device). Keep it that way: do not enable friends/trades/leaderboard online without re-answering.
- In-app purchases: allowed at 4+. The Cosy Pack ($2.99) sits behind a parental gate (see IAP_SETUP.md).

## Code safeguards already in place
- Offline-only, no ads, no third-party analytics, no accounts on a server.
- Parental gate before purchase and before the support email.
- Child-safe text (wording sweeps in BACKLOG runs); cat facts are all reviewed.
- Location (Catch zone) only runs when the player taps the GPS button; no location is stored.

## Do this for the App Store build
1. Build with `REACT_APP_APPSTORE=1 CI=false npm run build` in source/. This switches off CATAAS photos (user-uploaded web images) so only the curated Cat API is used.
2. Cat API images are fetched from the internet: Apple may still ask. Safest 4+ option is bundling a set of own/licensed cat photos instead (not done).
3. Add a real support email (the support button currently has a placeholder address) and a privacy policy URL.
4. If targeting the Kids Category, also remove Google Fonts and the Nominatim zone lookup (both are third-party calls) and re-check the Cat API call.
