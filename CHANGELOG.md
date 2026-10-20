# Changelog

## 2.3.0

- **New (connectivity)**: Every feature now uses the local connection first and the Roborock cloud only as the fallback. The cloud is still needed to sign in and to read the device and scene lists. See "Cloud outages and local-only mode" in the README
- **New (scenes)**: Scenes run over the LAN when every step is a command for a vacuum the plugin is connected to locally. Steps run in order: the next one starts once the vacuum is back on the dock and the dock has finished emptying and washing the mop. Stopping or docking the vacuum from Apple Home, starting another scene on it, or restarting Homebridge drops the remaining steps, and a step that fails or a vacuum error stops the run with a log line naming the steps that were skipped. Scenes with other steps, shared vacuums or a vacuum without a local connection, and scenes whose first step the vacuum does not accept locally, are run by the cloud as before. A scene run locally may not appear in the Roborock app's history
- **New (scenes)**: The scene list is saved on disk (owner-readable only) on every fetch, so scene switches and Matter scene buttons are created and work in local-only mode. A list saved for another account is ignored
- **Improvement (status)**: Apple Home follows the vacuum sooner. Status is read from the vacuum every 15 seconds while it is cleaning, returning or docking, and while the cloud push channel is down, instead of only on the regular refresh (180 seconds by default)
- **Improvement (connectivity)**: A command whose local request times out or cannot be sent is retried once through the cloud, instead of failing. Cloud fallbacks are logged once per command and vacuum until the vacuum answers locally again
- **Improvement (HAP)**: Filter and brush life are computed from the vacuum's own work times, like the Roborock app, and keep updating while the cloud is down. The cloud's copy is used when the vacuum does not report a consumable
- **Fix (HAP)**: A vacuum with a working local connection is no longer shown as "Not Responding" when the cloud reports it offline
- **Fix (connectivity)**: A command sent through the cloud no longer reports a timeout after the vacuum carried it out. The vacuum's `ok` answer was ignored, so the request waited 10 seconds and logged `Cloud request ... timed out` although the vacuum had started, stopped or docked. Only map and photo requests, which send their data after the `ok`, still wait for it
- **Fix (charging)**: Vacuums that charge while reporting `charge_status` 0 are shown as charging again in Apple Home (HAP and Matter). Only vacuums with off-peak charging use 0 for "waiting for off-peak power"; the others report it while they charge on the dock too. The off-peak capability is read from the vacuum's feature set
- **Fix (Matter)**: Switching to a mop mode works on every vacuum with the 30-step water slider, such as the P30 Pro, not only the Qrevo Edge 2. They reject the classic water level 202, so the plugin now recognizes them from their feature set and sends a slider value from the app's "Medium" range
- **Change (packaging)**: Fewer dependencies: the plugin installs 49 packages instead of 101. Cloud requests use Node's built-in `fetch` instead of `axios`, protocol frames are read without `binary-parser`, and the settings page draws Matter pairing QR codes with the dependency-free `qrcode-generator` instead of `qrcode`. This removes the dependencies behind most of the supply-chain alerts on socket.dev (code generated at runtime with `eval`/`Function`, packages with a Socket replacement, trivial packages) and the stale `jszip` entry in the lockfile. The cloud requests no longer use a proxy set in the `HTTP_PROXY`/`HTTPS_PROXY` environment variables
- **Improvement (connectivity)**: When a vacuum cannot be reached at its known LAN address, the plugin looks for it with UDP discovery before asking the cloud for its new address. A UDP discovery port taken by another integration is warned about once

## 2.2.11

- **Fix (HAP)**: Scene switches are named exactly like the scene in the Roborock app. Spaces used to be replaced with underscores ("Vacuum the Bedroom" became "Vacuum_the_Bedroom"), so Siri did not match the name you say. Leading and trailing spaces are dropped. Existing switches take the new name on the next restart unless you renamed them in the Home app. A scene without a name is called "Scene <id>", as the Matter scene buttons already were
- **Fix (HAP)**: A scene switch or dock mop-wash switch you renamed in the Home app keeps that name when Homebridge restarts. The plugin wrote its own name back on every start. The rename is saved to the accessory cache right away, so it also survives Homebridge stopping without a clean shutdown. Switches you have not renamed still pick up a language change, or a scene renamed in the Roborock app, on the next restart

## 2.2.10

- **Fix (connectivity)**: Vacuums whose home data reports protocol `1.0` but that only speak L01 on the LAN, such as the S8 MaxV Ultra (`roborock.vacuum.a97`) on firmware 02.39.x, are controlled locally again (#61). The plugin talked `1.0` to them, the vacuum ignored every local request, and each one timed out after 10 s before falling back to the cloud. Before connecting to a vacuum that reports `1.0`, the plugin now sends it an L01 hello on a separate connection; if the vacuum answers, its local connection uses L01, while cloud requests keep `1.0`. Vacuums that speak `1.0` do not answer, so connecting to them takes up to 3 s longer, and nothing else changes for them. The log shows `reports protocol 1.0 but answers L01 locally` when a vacuum is switched
- **Fix (connectivity)**: Local L01 connections are no longer dropped after a minute of inactivity (#61). L01 vacuums close a connection that carries no traffic for 60 s, and the plugin reconnected only after another 60 s, so the vacuum spent about half the time without a local connection and commands went through the cloud. The plugin now sends a keepalive ping every 30 s on L01 connections. `1.0` connections stay open by themselves and get no ping
- **Docs**: The S8 MaxV Ultra is listed among the supported models, and the README explains the local protocol detection

## 2.2.9

- **Fix (Matter)**: Rooms are now published on a map (#60). They used to be published without one, and Apple Home showed no rooms. Room selection works as before
- **Fix (status)**: Vacuum status (state, battery, charging, error, fan and water settings) now comes from the vacuum itself. The plugin polls `get_status` on every refresh and keeps the real-time status broadcasts, instead of relying on the cloud's home-data snapshot, which can lag behind the device. This fixes Matter vacuums that kept an old state, such as "Return to dock" staying available while the vacuum was already docked (#60). HAP accessories read the same status
- **Fix (Matter)**: The charging state is reported correctly. "Not charging" was sent as Matter's "fully charged" value, and models that do not report `charge_status` now derive it from the charging and charged states
- **Fix (Matter)**: The start button no longer fails with `Cannot resume in current state` (#60). A Resume command sent while the vacuum is stopped or docked now starts a clean, and honors the room selection
- **Change (Matter)**: A vacuum that is returning to or docking at its station now reports "Seeking charger" instead of "Running"
- **New**: Clear device errors from the settings page. Some errors stay on the vacuum until they are marked as resolved in the Roborock app, even after the cause is fixed, such as the dock's "clean water tank empty" after a refill. When a vacuum reports an error, the settings page now shows it in the device list with a **Clear error** button that resolves it, like **Resolved** in the Roborock app. Homebridge must be running
- **Fix (login)**: Signing in no longer fails with code 3006 ("user agreement version is not up-to-date"). The login sent a fixed user agreement version, but the current version differs per Roborock server and country; it is now fetched before each login, with the old value as the fallback
- **Fix (connectivity)**: A cloud connection that stays connected but no longer delivers any messages is restarted. This only happens when the connection reports itself as connected, the Roborock cloud is reachable, and several requests in a row got no answer with no other message in between; restarts back off from 30 minutes up to 6 hours while they do not help. A network or Roborock outage does not trigger restarts

## 2.2.8

- **New**: Project website in English, Traditional Chinese and Japanese: [tasict.github.io/homebridge-roborock-vacuum](https://tasict.github.io/homebridge-roborock-vacuum/). It is now the plugin's homepage in the Homebridge UI
- **New**: You can now support the plugin by buying me a boba (paid by card, no PayPal account needed) or with PayPal: from the bottom of the plugin settings, the donate link in the Homebridge UI, the README or GitHub's Sponsor button
- **Change (packaging)**: The npm package no longer contains a development test script, a leftover client ID file or the protocol sniffing helper; it now holds only what the plugin needs to run
- **Docs**: README rewritten around the current feature set — supported models (with corrected names such as Qrevo Curv), requirements matching the supported Homebridge and Node.js versions, the sign-in flow, and a reference of every config option. The header image is now the plugin's own icon
- **Change (config UI)**: The settings page describes what it is for, and has a small support footer below the settings

## 2.2.7

- **Fix (connectivity)**: The plugin no longer fails to start when the Roborock cloud is unreachable. Startup used to abandon everything after the home-data request timed out (`AxiosError: timeout of 20000ms exceeded`, `ECONNRESET`), so no accessories were registered and every command was refused with "Adapter not inited" — even though the vacuum was reachable on the LAN the whole time. The home data (device list and local keys) is now cached on disk, and when the cloud fetch fails the plugin starts in **local-only mode** from that cache: it still runs LAN discovery, connects to each vacuum over the local protocol, publishes the accessories, and accepts start/stop/dock commands. Cloud-only features (scenes, push updates, fresh online flags) resume by themselves once the cloud answers again, without a Homebridge restart. One successful online start is needed to seed the cache; with no cache the plugin stays idle as before, now with a message that says why
- **Fix (connectivity)**: A vacuum the plugin is locally connected to is treated as online even when the cached cloud status says otherwise, so commands and polling are not blocked by a stale offline flag during a cloud outage
- **Fix (connectivity)**: Local-only mode no longer depends on UDP discovery finding the vacuums. Each device's last known LAN address is cached next to the device list, so vacuums on another VLAN (or when port 58866 is taken by another integration on the same host) are still dialed directly while the cloud is down
- **Fix (connectivity)**: Local-only mode also works without a cloud session. When the login itself fails while the cloud is down (or the cached session was cleared), the plugin still starts from the cache and logs in again on the periodic refresh once the cloud answers. Only network-level login failures are retried; a rejected login or a pending two-factor prompt is left to the Config UI
- **Fix (connectivity)**: A degraded cloud no longer costs you the session. The cached session is cleared only when the login API explicitly rejects it with an API error code. An empty or malformed answer, and a `401` from the device API that the login API does not confirm, are treated as transient and retried
- **Fix (connectivity)**: The cached device list is tagged with the account it was fetched for and ignored after switching accounts, so a local-only start never controls another account's vacuums
- **Fix (logging)**: During an outage the periodic home-data refresh logs its failure once at error level and then at debug level until the cloud answers again, instead of an error every interval. The signed device API now times out after 20 s instead of hanging on a black-holed connection

## 2.2.6

- **New Feature**: The Roborock region is now detected automatically from the account email when no endpoint is configured — the config UI's Region selector gains an "Auto detect (recommended)" option and new installs no longer need to know which server their account lives on. An explicitly chosen region keeps working exactly as before, and if detection fails the plugin falls back to the previous US default with a hint to pin the region manually. Two-factor login also benefits: it now sends the account's real registered country from the detection response instead of guessing it from the endpoint host (which mapped every EU account to Germany)

- **Fix (HAP/Matter)**: Recognize the state codes newer models report, ported from the python-roborock reference tables. State 25 (a second "washing the mop" code used by the Q7 Max family), 33/34 (attaching/detaching the mop mid-run) and the B01/Q10-generation mopping states (6301–6310) now count as an active cleaning session, so HomeKit no longer shows those vacuums as off while they are mopping. The dock mop-wash switch also follows states 25 and 6310, and the Matter operational state maps the new codes (mopping → Running, duster wash → Cleaning mop)

## 2.2.5

- **Fix (HAP/Matter)**: Real-time device messages are now routed to the accessory of the device they came from. Previously every push payload was fanned out to all accessories, so with two or more vacuums one robot could briefly show another robot's state, battery, or error in HomeKit
- **Fix (HAP)**: Unknown status values are no longer published to HomeKit. Before the first HomeData snapshot arrived, the battery could show 0% (with a normal low-battery flag) and the cleaning state could read as off; those characteristics now update only once the value is actually known, matching the guards the Matter accessories already had. The charging indicator also uses one consistent rule instead of two different comparisons in the create and update paths
- **Fix (HAP/Matter)**: "Washing the mop" (state 23) now counts as cleaning everywhere. The HAP accessory and the shared API each kept their own cleaning-state table that disagreed on this state, so during a mid-run mop wash the vacuum tile flapped between on and off as push and poll updates alternated
- **Fix (HAP)**: Removing outdated scene switches no longer skips every second one — the service list was being modified while it was iterated
- **Fix**: Sending a command to a device shared from another account now logs a warning instead of crashing the command handler (shared devices get an accessory but no control channel)
- **Change (efficiency)**: Removed a 1-per-second status poll per device whose results were never used (the timer now only exists for the opt-in current-room MQTT telemetry, which is its only consumer). Also removed periodic and startup requests whose responses fed nothing: `get_server_timer`, `get_timer`, `get_multi_maps_list`, the cleaning-history fetch (`get_clean_summary` plus up to 20 `get_clean_record` calls per device), an extra `get_status` round-trip in the room-mapping poll, a per-cycle firmware-update check, and a duplicate scene fetch at startup
- **Change (efficiency)**: Devices that go offline now stop being polled until they come back — the online flag from every HomeData refresh starts and stops the per-device intervals
- **Change (internal)**: Removed the inherited ioBroker object layer and other dead code from `roborockLib` (about 1,900 lines), including the unused map parser and packaging helper; the `jszip` dependency is gone. Plugin shutdown now also cancels in-flight request timers. The API surface consumed by the TypeScript plugin is now declared in `src/roborock_api.ts`, so lib-side renames fail the build instead of breaking HomeKit at runtime

## 2.2.4

- **New Feature (HAP)**: Consumable life (filter, main brush, side brush) is now exposed as HomeKit FilterMaintenance services — remaining life in percent plus a "change filter" alert when a consumable drops to 5% or less. Services are only created for consumables the device actually reports, and their names follow the plugin language
- **New Feature (HAP)**: The vacuum's error state and cloud online flag are now surfaced on the main service as StatusFault and StatusActive, so HomeKit apps can flag a device that reported an error code or went offline
- **Fix (Matter)**: Matter accessories no longer report their model as "Unknown" (or "Scene"/"Dock") — the model is resolved from the Roborock products table, the same source the HAP accessories always used
- **Fix (HAP)**: The firmware version shown in Apple Home no longer stays empty or "Unknown". It was written only once at accessory creation, so a HomeData snapshot without the firmware field (or a later device OTA update) left HomeKit without the real version forever. The version is now refreshed from the device data on every HomeData poll

## 2.2.3

- **Fix (Matter)**: Matter vacuums no longer sit at "Updating…" in Apple Home with no state, battery, or controls (#59). The initial status was pushed before the Matter endpoint was registered — so the Matter server discarded it — and nothing published it again afterwards. The status (state, battery, charging, error, clean mode) is now seeded right after registration and re-synced on every Roborock HomeData poll, matching the update path the HAP accessories always had
- **Fix (Matter)**: Real-time device broadcasts that arrive as raw protocol ids (dps 120–124) are now translated to named status fields once in the notification fan-out and shared by every accessory, so state, battery, and clean-mode changes reach Matter controllers immediately instead of waiting for the next poll. The HAP accessory consumes the same translated payload, replacing its own inline handling of dps 121/122
- **Fix (Matter)**: A dock mop-wash switch restored from the Matter cache with a stale On state is now corrected at startup

## 2.2.2

- **Fix (config UI)**: 2FA verification and login no longer fail with the generic "The Homebridge UI did not respond in time" message on slow connections (#58). Cloud-backed actions (login, 2FA, device list) now get a 60-second budget in the UI instead of 15 seconds — 2FA verify and password login each make two sequential Roborock cloud requests, which could legitimately exceed the old limit. Each underlying cloud request is also capped at 20 seconds, so a genuinely unreachable Roborock server now surfaces the real network error instead of the generic timeout

## 2.2.1

Maintenance release — no functional changes to device control. Reworks the four code patterns flagged by the Homebridge verification security scan so the automated checks come back clean:

- **Change**: The config UI server now loads the ESM-only `@homebridge/plugin-ui-utils` package via a native dynamic import in the uncompiled `homebridge-ui/server.js` bootstrap, replacing the `Function`-constructor workaround in the compiled UI bundle
- **Change**: Translation catalogs are loaded through a static per-language table instead of a computed `require()` path; unknown languages still fall back to English
- **Change**: The storage path is taken solely from the platform-provided config (with the existing local fallbacks); the redundant environment-variable lookup was removed
- **Change**: Renamed internal identifiers in the photo RSA-keypair helper; keys are still generated fresh in-process and never read from disk

## 2.2.0

Connectivity and device-support release, porting recent fixes from the python-roborock and ioBroker.roborock upstream projects.

- **New Feature**: Docks introduced since 2025 (Qrevo Curv, Saros 10, Qrevo S5V, Saros 20, and other new dock type codes 10–40) now get their dust-collection, mop-wash, and drying features — including the dock mop-wash switch. Unknown future dock types default to full-featured instead of featureless
- **New Feature**: Room names now resolve for vacuums shared from another Roborock account (fetched via the device-share rooms API), so Matter room cleaning and the current-room publisher work on shared devices
- **New Feature**: Qrevo Edge 2 (`a298`) support for clean-mode switching — it uses banded water levels (221–250), so the plugin no longer writes the classic level 202 that the device rejects
- **Fix (connectivity)**: A vacuum whose IP changed (DHCP) no longer stays unreachable or silently cloud-only until Homebridge restarts — the local reconnect loop now re-queries the device's current IP over the cloud and reconnects to the fresh address; devices demoted to cloud mode after a TCP failure are promoted back to local mode once reachable again
- **Fix (connectivity)**: The cloud MQTT connection is only reported healthy after the device-topic subscription actually succeeds (broker rejections arrive as qos 128); previously a failed subscription left the plugin claiming a working cloud channel that could never deliver a response
- **Fix (connectivity)**: Q10-generation (B01 protocol) devices no longer hang startup with a 10-second timeout and stay cloud-only — they are queried with their own `service.get_net_info` method so they can learn their local IP
- **Fix**: UDP discovery responses were silently discarded due to a missing `this.` in the decryption path; discovery now works again. A UDP port conflict (e.g. ioBroker.roborock on the same host) also no longer aborts all device creation
- **Fix**: An invalidated cloud session (password change, session revoked) no longer produces an endless 401 retry loop — the cached session is cleared once, polling stops, and the log tells you to re-authenticate. If the 401 is caused by host clock drift (common on NAS hosts), the log instead points at the system time/NTP
- Licensing note: python-roborock relicensed to Apache 2.0 (2026-07-20), making these ports license-compatible with this MIT plugin

## 2.1.3

Stability release — no new features.

- **Fix (crash)**: A failed Roborock cloud login (wrong credentials, expired session, or the cloud being unreachable) crashed Homebridge with an unhandled rejection during startup. The plugin now logs the error and stays idle instead of sending Homebridge into a crash-restart loop
- **Hardening**: Platform startup is wrapped so any unexpected initialization error is logged instead of taking down Homebridge

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
