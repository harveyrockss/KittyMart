# Cosy Cat Pack: in-app purchase hand-off (for Claude in Xcode / Harvey)

Built in v1.17: Mart > "Cosy Pack" tab, parental gate (maths question), 4 dress-up items, entitlement key `km_pack_cosy` ("1" = owned),
items granted via `grantCosyPack()` in `source/src/App.js`. Nothing is sold on the web build.

## To make it a real purchase (needs a Mac + App Store Connect)
1. App Store Connect: create a NON-CONSUMABLE in-app purchase, product id `cosy_cat_pack`, price tier ~ $2.99, display name "Cosy Cat Pack".
2. Add RevenueCat (`@revenuecat/purchases-capacitor`), create an entitlement + offering for that product.
3. Provide `window.KM_IAP = { purchase(productId) -> Promise<boolean>, restore() -> Promise<boolean> }` before the app loads
   (the pack UI already calls these; "Restore purchase" button is included, which Apple requires).
4. Keep the parental gate in front of every purchase (already wired).
5. Add the privacy/IAP disclosure in App Store Connect. Decide Kids Category yes/no (affects allowed analytics/ads).
6. Testing on web only: open the site with `?testpack=1` to unlock without paying. Remove this shortcut from the App Store build.

## Same idea for PuppyMart
Ask Claude in Xcode: "Add a one-time non-consumable 'Cosy Pup Pack' ($2.99) like KittyMart's Cosy Cat Pack: Mart tab with
parental gate, 4 dress-up items for dogs, `window.KM_IAP` RevenueCat bridge with purchase/restore, entitlement stored in
localStorage and in players.player_data. Do not submit to App Review."
