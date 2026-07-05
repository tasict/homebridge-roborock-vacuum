# Changelog

## 2.0.0

- **New Feature**: Matter protocol support (Beta)
  - Per-device protocol selector in the settings UI: publish each vacuum over **HomeKit (HAP)** (default), **Matter (Beta)**, or skip it
  - Vacuums publish as native Matter robotic vacuum cleaners: proper vacuum icon and controls in Apple Home (also works with Google Home, Alexa, SmartThings)
  - **Room cleaning** through the Matter ServiceArea cluster (Apple Home needs iOS 18.4+): pick named rooms in the controller and clean only those; the room currently being cleaned is reported live
  - **Vacuum / Mop / Vacuum & Mop** clean modes mapped to the Roborock suction and water-box settings; models without a water box only offer Vacuum
  - Battery, charging state and operational errors (stuck, dust bin missing, dock problems, …) reported over Matter
  - Roborock **scenes** as Matter on/off buttons on the plugin's own bridge, with a per-device "Bridge scene buttons over Matter" toggle
  - Pairing QR codes, commissioning status and naming hints shown on the settings page (per device, plus the scene-button bridge)
  - Requires **Homebridge 2.x with Matter enabled**; on Homebridge 1.x (or with Matter disabled) Matter selections safely fall back to HAP
  - **Known limitations (Beta)**: Apple Home's Matter support for vacuums is still immature — expect the "Uncertified Accessory" warning, a generic "Matter Accessory" name during pairing (type the name shown in the settings page), and occasional instability. See the README's "Matter support (Beta)" section
- **Improvement**: Settings page loads the device list instantly from a local cache (prefetched at login, refreshed in the background); "Load devices" forces a cloud refresh
- **Fix**: Matter accessories now receive live state updates (state, battery, clean mode) instead of only the startup snapshot
- **Fix**: Duplicate scene names across multiple Matter vacuums are suffixed with the vacuum name regardless of discovery order

## 1.2.2

- **New Feature**: Dynamic Scene Switch Management
  - Automatically create HomeKit switch buttons for each device's available scenes
  - Scene switches named after scene names with momentary switch behavior
  - Automatically add/remove corresponding switch buttons when scenes change
  - Execute corresponding scenes when switches are pressed, with error handling and status feedback
  - Synchronize scene switches when HomeData is updated
- **Improvement**: Refactored scene API methods, separated scene fetching and device filtering functionality
- **Fix**: Resolved recursive call issue in scene methods

## 1.0.15

- Fix Roborock Saros 10R Status issue

## 1.0.6

- Support new model

## 1.0.0

- First version.
