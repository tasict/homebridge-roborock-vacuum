# Changelog

## 2.1.2

Maintenance release — no functional changes.

- **Fix**: Added the standard `name` property to `config.schema.json`. The settings UI already wrote a platform name to the config; it was only missing from the schema (flagged by the Homebridge verification checks)

## 2.1.1

Maintenance release — no functional changes to device control.

- **Improvement**: The plugin settings page now inherits the Homebridge UI theme (theme color and light/dark mode) instead of using its own hard-coded dark palette, so it matches the rest of the Homebridge UI
- **Fix**: Corrected a malformed `repository` URL in `package.json` (`git+hhttps://…`) that broke the "Repository" link on the NPM package page

## 2.1.0

- **New Feature**: Dock mop-wash switch
  - Vacuums with a washing dock get an extra stateful switch that starts/stops a dock mop wash and mirrors the device's washing state — including washes started from the Roborock app
  - Available over both HomeKit (extra Switch service on the vacuum accessory) and Matter (bridged on/off accessory per washing-capable vacuum)
- **New Feature**: `language` config option (settings-page dropdown, default `en`, adds `zh-tw`) for localized device-provided switch names. Changing the language never affects accessory UUIDs or service subtypes, so no re-pairing or room re-selection is needed
- **Fix**: Dock type detection used the attribute name instead of the actual `dock_type` value

## 2.0.1

Stability and security hardening release based on a full plugin vulnerability scan. No new features, no configuration changes — updating is strongly recommended, especially on low-power hosts (NAS, Raspberry Pi).

- **Fix (crash)**: An MQTT connection that failed to establish within 30 seconds crashed the whole Homebridge process (a timer called a method that does not exist); it now logs a warning and keeps retrying in the background
- **Fix (crash)**: Status updates no longer abort mid-processing while the vacuum is cleaning (calls to undefined map-updater functions were throwing on every `get_status` poll), so state and battery keep updating during a clean
- **Performance**: Startup no longer blocks the event loop with synchronous RSA-2048 key generation for every vacuum — the keypair (only used for photo requests) is now generated once, on demand, using fast native crypto. On NAS-class hardware this removes multi-second (up to minute-long) Homebridge freezes at startup
- **Performance**: Device data (HomeData) is parsed once and cached instead of being re-parsed on every request and every HomeKit read — significantly lower CPU and fewer "Not Responding" moments in the Home app with multiple devices
- **Performance**: Map payloads are decompressed asynchronously instead of blocking the message loop
- **Fix (memory)**: Polling timers now keep their real handles — they are properly stopped when a device goes offline or the service stops, and can no longer stack up duplicates (previously they could never be cleared and multiplied on every reconnect)
- **Fix (memory)**: The local TCP receive buffer is bounded (8 MB per frame / 16 MB total) and the connection resets on corrupt framing, instead of buffering bad data forever
- **Fix (leak)**: Local TCP reconnect timers are cancellable and stop on shutdown; photo transfer buffers no longer leak when a transfer is interrupted; the UDP discovery socket is created per discovery run; the cloud MQTT connection is closed on service stop
- **Fix**: TCP connection failures no longer mislabel every device as a remote (cloud-only) device
- **Fix**: Stale HomeKit scene switches are now actually removed when scenes are deleted
- **Fix**: The periodic MQTT reconnect now runs every 3 hours as documented (was every hour)
- **Security**: The persisted Roborock session file (`roborock.UserData`, contains the cloud token) is now written with owner-only permissions (0600)
- **Security/maintenance**: Removed 10 unused dependencies (`express`, `node-forge`, `abstract-things`, `tinkerhub-discovery`, `yargs`, `deep-equal`, `chalk`, `debug`, `semver`, `rxjs`) — smaller install and attack surface

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
