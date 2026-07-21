# Upstream Review — July 2026

> **Status (2026-07-21): items 1–9 are implemented** (see
> `openspec/changes/port-upstream-fixes-2026-07/` and the 2.2.0 CHANGELOG section;
> tests in `src/upstream_ports.test.ts`). The two "Deferred / monitor" items below
> remain open.

Review of recent changes (roughly 2026-04 → 2026-07-21) in two upstream projects, compared
against our `roborockLib/` implementation, to identify fixes/features worth porting:

- **python-roborock** — https://github.com/Python-roborock/python-roborock (v5.7.x → v5.36.0)
- **ioBroker.roborock** — https://github.com/copystring/ioBroker.roborock (v0.7.0 → v0.7.x)

> Note: ioBroker.roborock completed a full TypeScript rewrite in v0.7.0 (protocol code now in
> `src/lib/localApi.ts`, `httpApi.ts`, …), while our fork descends from the older 0.6.x JS lib.
> Nothing below can be cherry-picked as a patch — every item is a **concept port**.
>
> License note: python-roborock switched from GPL to **Apache 2.0** on 2026-07-20
> (`a30447130`, v5.34.0). Porting logic from current upstream into this MIT plugin is now
> license-compatible (with attribution).

Per project workflow, non-trivial items below should get an OpenSpec change proposal under
`openspec/changes/<change-id>/` before implementation.

---

## P1 — High value, do first

### 1. [BUG in our code] UDP discovery decryption always fails (found during this review)
- **Where:** `roborockLib/lib/localConnector.js:536`
- **Problem:** `decryptECB()` calls `safeRemovePkcs7(decryptedBuf)` without `this.`.
  `safeRemovePkcs7` is a class method (defined at `localConnector.js:498`), so this throws a
  `ReferenceError` inside the `try` block, which is swallowed by the `catch` → `decryptECB`
  always returns `null` → **every UDP discovery response is silently discarded**.
  Local connections still work today only because `get_network_info` (cloud) provides IPs.
- **Fix:** one line — `const unpadded = this.safeRemovePkcs7(decryptedBuf);`
- **Effort:** trivial. No upstream reference needed.

### 2. MQTT: only report "connected" after the device-topic subscription succeeds
- **Upstream:** python-roborock `e3c97c68ce` (PR #858, 2026-07-03, v5.23.1).
- **Problem in our code:** `roborockLib/lib/roborock_mqtt_connector.js:70-87` — in
  `client.on("connect")` we call `client.subscribe(...)` and set `this.connected = true`
  unconditionally; subscribe errors are only logged. Same pattern in the `reconnect` handler
  (lines 104-122). `isConnected()` (line 421) is consulted by the rest of the stack, so a
  failed subscription leaves us claiming a healthy cloud channel while no message can arrive.
- **Port:** move `this.connected = true` (and `clearTimeout`) into the subscribe callback;
  require `err == null` **and** a valid grant (`granted[0].qos !== 128` — mqtt.js signals
  broker-side rejection via qos 128, not `err`). On failure set `this.connected = false` so
  fallback/health logic reacts. Apply to both `connect` and `reconnect` handlers.
- **Effort:** small.

### 3. Local endpoint recovery after device IP changes (DHCP)
- **Upstream:** ioBroker.roborock PR #1270 (`ad1a660`, 2026-05-19, v0.7.1) + PR #1279
  (`bb7441f`, 2026-05-20, v0.7.2).
- **What upstream does:** on TCP errors (`EHOSTUNREACH`/`ENETUNREACH`/`ETIMEDOUT`/
  `ECONNREFUSED`) mark the endpoint stale, clear nonces, re-query the device IP via cloud MQTT
  (`get_network_info`), rate-limited to once per 60 s; periodically refresh stale endpoints;
  re-arm the retry after a temporary MQTT outage.
- **Problem in our code:**
  - `roborockLib/lib/localConnector.js:244, 259-276` — `scheduleReconnect(duid, ip)` pins the
    IP captured at startup forever; after a DHCP change we redial a dead IP every 60 s until
    Homebridge restarts.
  - `roborockAPI.js:612-632, 824-833` — `getNetworkInfo()` and UDP discovery run exactly once
    at startup; `this.localDevices` is never refreshed (only writer: `lib/vacuum.js:195-198`).
  - `localConnector.js:101-111` + `roborockAPI.js:120, 1235` — one failed TCP connect at boot
    puts the device in `remoteDevices` permanently; there is no path back to local mode.
- **Port:** in `scheduleReconnect`, after N failed reconnects (or on the error classes above),
  re-run `get_network_info` via cloud before dialing, update `localDevices[duid]`, connect to
  the fresh IP. Periodically re-probe devices stuck in `remoteDevices` to promote them back to
  local mode.
- **Effort:** medium. Fixes the biggest real-world failure mode (devices silently degrading to
  cloud-only / dropping off after a DHCP change).

### 4. Dock feature mapping for new dock type codes (10–40)
- **Upstream:** python-roborock `73ba2bf152` (PR #867, 2026-07-08, v5.28.0), refined by
  `9e95992fcf` (PR #872, 2026-07-12, v5.28.1); dock codes added in `8d8a4437a3` (code 22
  Qrevo S5V), `6c6c396583` (code 27 Saros 20), `shell_2e_heat_dock = 40` (PR #872).
- **What upstream does:** dock type codes now span 0–40. Crucially the default was
  **inverted**: any dock *not* in a small exception set is treated as full-featured
  (collect + wash + dry); exceptions: `{unknown, 0}` = no dock, `{1, 5}` = dust-collect only,
  `{2}` = wash only, `{3}` = collect+wash.
- **Problem in our code:** `roborockLib/lib/deviceFeatures.js:62-71` — `dockTypes` label map
  stops at code 9. `deviceFeatures.js:1164-1207` — `processDockType()` handles only 0–9 and
  the `default:` branch does nothing. Owners of any 2025+ dock (Qrevo Curv = 17,
  Saros 10 = 18, Qrevo S5V = 22, Saros 20 = 27, …) get no dust-collection / mop-wash / dryer
  features. Also: code 6 (S7 Max Ultra) is handled in `processDockType` but missing from the
  `dockTypes` label map.
- **Port:** make the `default:` branch of `processDockType()` enable
  `isDustCollectionSettingSupported() + isWashThenChargeCmdSupported() + isSupportedDrying()`
  (unknown dock ⇒ full-featured), keeping explicit cases only for 0 / 1 / 5 / 2 / 3. Add
  labels for codes 6 and 10–40 to `dockTypes`.
- **Effort:** small–medium, high user-visible value.

---

## P2 — Medium value

### 5. B01 devices (Q10 generation): obtain local IP via `service.get_net_info`
- **Upstream:** ioBroker.roborock PR #1357 (`64daa2c0` + `6ff5161c`, merged 2026-07-13), plus
  the B01 branch introduced in `ad1a660`.
- **What upstream does:** B01 devices don't answer `get_network_info`; upstream sends
  `service.get_net_info` over MQTT (response wrapped in dps `"10001"`, IP field may be `ip`,
  `ipAddress`, or `ipAdress`), then probes local TCP; pre-init probe timeout relaxed 2 s → 4 s.
- **Problem in our code:** `roborockAPI.js:831` sends `get_network_info` to every model;
  `lib/message.js:76-89` only rewrites `get_prop` → `prop.get` for B01. Each B01 device costs
  a 10 s request timeout at startup and never learns its local IP → permanently cloud-only.
  Response plumbing already exists (`lib/roborock_mqtt_connector.js:213-217` parses dps
  `"10001"`).
- **Port:** in `getNetworkInfo` / `vacuum.getParameter` (`lib/vacuum.js:187`), branch on
  `getRobotVersion(duid) == "B01"` to send `service.get_net_info` and accept the alternate IP
  field names.
- **Effort:** small–medium. High value **if** B01 (Q10-generation) users exist.

### 6. Handle Web-API 401 properly: stop retry loop + diagnose clock skew
Two complementary upstream fixes, best implemented together:
- **(a) Stop retrying forever on invalid session** — python-roborock `ad8d8f095a` (PR #825,
  2026-05-12, v5.10.1): unauthorized errors from `get_home_data` / scenes fire a re-auth hook
  instead of being retried blindly.
  - Our code: no 401 handling anywhere in `roborockLib/`. `updateHomeData`
    (`roborockAPI.js:1396-1422`) catches everything and just logs, and runs on
    `this.updateInterval` forever — an invalidated rriot token (password change, session
    revoked) produces an endless error loop. Startup deletes cached `UserData` on some
    failures (`roborockAPI.js:637-651`) but the steady-state loop never does.
  - Port: in the catch blocks of `updateHomeData`, `getScenes` (~line 1085), and
    `executeScene` (~line 1043), on `error.response?.status === 401` clear cached `UserData`,
    surface a "re-authenticate in Config UI" warning, and stop the polling interval.
- **(b) Diagnose host clock skew on 401** — ioBroker.roborock PR #1327 (`402dfbf1`,
  2026-06-15): on 401 from the Hawk-signed API, compare server time (response body / `Date`
  header) with local time; if skew > 60 s, log an explicit "fix your NTP" error.
  - Our code: the Hawk signature embeds a local timestamp (`roborockAPI.js:484-509`). On NAS
    hosts (this plugin's typical platform) clock drift is a realistic, hard-to-diagnose 401
    cause.
  - Port: in the same 401 path as (a), compute skew from the response `Date` header and log a
    clear clock-sync warning when |skew| > 60 s.
- **Effort:** small.

### 7. Rooms for shared devices (`receivedDevices`)
- **Upstream:** python-roborock `5948eed60b` (2026-06-16, v5.15.0) — new signed endpoint
  `GET /user/deviceshare/query/{device_id}/rooms`, because rooms of a device shared *to* you
  are absent from your own home's room list; response entries may use `roomId` or `id`.
- **Problem in our code:** we support shared devices (`roborockAPI.js:545-548`) but resolve
  room names only from our own home data (`this.roomIDs`, populated at
  `roborockAPI.js:587-593`); `vacuum.js:396` drops unknown segment ids. Shared vacuums get
  empty `segmentRoomNames`, breaking room naming for the Matter ServiceArea surface
  (`getSegmentRooms`, `roborockAPI.js:2301`) and the current-room publisher
  (`roborockAPI.js:1930`).
- **Port:** after home data load, for each device in `receivedDevices` call
  `this.api.get("user/deviceshare/query/<duid>/rooms")` and merge into `this.roomIDs`
  (accept both `roomId` and `id`). Existing Hawk-signed axios instance works unchanged.
- **Effort:** small.

### 8. Qrevo Edge 2 (`roborock.vacuum.a298`): different water_box_custom_mode values
- **Upstream:** ioBroker.roborock #1356 (`58f33844` 2026-07-12, `c4ed3653` 2026-07-13).
- **What upstream does:** a298 does not use classic water levels 200–203; it uses 200 = Off
  plus banded values 221–250 ("Very Light" … "Extreme"). Scoped to a298 only (a187 Qrevo Edge
  keeps the base mapping).
- **Problem in our code:** no `a298` anywhere in the repo; `deviceFeatures.js:381-386`
  hard-codes 200–203 and `getCleanModeCapabilities` (`roborockAPI.js:2369-2388`) returns
  hard-coded `waterOff: 200, waterDefault: 202`, which `src/vacuum_matter_accessory.ts:436-475`
  writes when switching clean modes. On an Edge 2, writing 202 is invalid → Mop /
  Vacuum-and-Mop switching misbehaves.
- **Port:** make `getCleanModeCapabilities` model-aware: for `roborock.vacuum.a298` return
  `waterOff: 200, waterDefault: 233` (Medium), and prefer keeping the device's current
  in-range value.
- **Effort:** small.

---

## P3 — Low priority / hardening

### 9. UDP discovery: don't abort startup when port 58866 is already bound
- **Upstream inspiration:** ioBroker.roborock #1352 (`3a383926`, 2026-07-05) adds leader
  election across instances sharing UDP port 58866 (mechanism uses ioBroker state objects —
  not portable).
- **Problem in our code:** if the port is already bound (e.g. ioBroker.roborock on the same
  host), `getLocalDevices` rejects on the socket `error` event
  (`lib/localConnector.js:476-483`); the rejection lands in the big `startService` try/catch
  (`roborockAPI.js:612` → catch at `:652`) and aborts device creation entirely — no
  accessories at all.
- **Port (minimal):** on bind error, log a warning and resolve with an empty device set
  (local IPs still come from `get_network_info`).
- **Effort:** trivial.

---

## Deferred / monitor (not scheduled)

- **Multi-step scene execution for Saros 10/20** — ioBroker.roborock #1318 fix chain (merged
  via #1337, 2026-06-27): upstream replicates scene steps locally (batch
  `do_scenes_segments`, resolve `app_start_program` via `app_get_program`, wait for dock-wash
  completion between steps). Our scene switches call the cloud endpoint
  `user/scene/{id}/execute` (`roborockAPI.js:1040-1043`) — same as the Roborock app. Only
  revisit if users report multi-step scenes stopping partway on Saros-generation devices;
  this is a large subsystem, not a fix.
- **Full Q10 / B01 (ss07) support** — roughly half of python-roborock's recent work: B01
  status DPS mappings, fault enums, room/segment cleaning, clean records, remote control by
  DP code, and a complete Q10 map decoder. Our B01 support is minimal (AES framing +
  dps-10000 request building in `lib/message.js:76-89, 179-183`; dps-10001 parsing in
  `roborock_mqtt_connector.js:213-218`); we still send V1 method names to B01 devices and
  RRMapParser cannot decode Q10 maps. Multi-week project — only worth it if Q10/Q7 owners are
  a target audience. Upstream (now Apache 2.0) is a mature reference implementation.

---

## Verified as NOT needed (our code is already correct)

- **Consumable reset param names** (python-roborock `b11fc49844`, PR #879): we already use
  the correct plural names (`deviceFeatures.js:342-346`) — upstream's fix validates our values.
- **Non-vacuum V1 devices** (python-roborock `2e9a84807f`, PR #828): we already skip anything
  not matching `roborock.vacuum.` (`roborockAPI.js:848, 1269-1271`), covering mowers, Zeo,
  Dyad.
- **Hawk body signing for B01 `/jobs` POSTs** (python-roborock `4dbe17e6af`, v5.15.2): our
  only signed POST (`user/scene/{id}/execute`) has no body; our empty-body signing
  (`roborockAPI.js:494-502`, `roborockHome.js:25-33`) matches upstream. ⚠️ Remember: if we
  ever POST a JSON body to the signed API, the MD5 of the compact JSON body must go into the
  Hawk prestr or the server rejects the MAC.
- **"No maps" non-fatal** (python-roborock `011c9d169d`, PR #809): our flow already degrades
  gracefully (`vacuum.js:389-392`).
- **HomeData consumable percentages regression** (ioBroker v0.7.4 #1305): regression from
  their rewrite; our fork already has `updateConsumablesPercent` (`roborockAPI.js:1410-1443`).
- **V1 / Qrevo MaxV auto-empty restores** (ioBroker v0.7.3, #1280): restores behavior our
  lineage never lost (`deviceFeatures.js:350-352`); our plugin surface exposes no auto-empty
  control anyway.
- **A01 MQTT QoS/timestamp** (python-roborock `3deed815a8`, v5.36.0): A01 is Dyad/Zeo; we
  only bridge vacuums, and our publishes already use QoS 1 (`roborock_mqtt_connector.js:417`).
- Ignored as out of scope: HA-facing abstractions, mower/Zeo dataclasses, trait refactors,
  simulators/test infra, dependency pins, ioBroker admin/translation commits, internal
  message-ID refactor (we already generate IDs internally via `getRequestId()`).

---

## Suggested implementation order

| Order | Item | Effort | Risk | Status |
|-------|------|--------|------|--------|
| 1 | #1 `this.safeRemovePkcs7` bug fix | trivial | none | ✅ done |
| 2 | #2 MQTT connected-after-subscribe | small | low | ✅ done |
| 3 | #9 UDP bind-error resilience | trivial | low | ✅ done |
| 4 | #6 401 handling (+ clock-skew log) | small | low | ✅ done |
| 5 | #4 dock type codes 10–40 | small–medium | low | ✅ done |
| 6 | #3 local endpoint IP refresh | medium | medium (touches reconnect path) | ✅ done |
| 7 | #5 B01 `service.get_net_info` | small–medium | medium (needs B01 hardware to verify) | ✅ done |
| 8 | #7 shared-device rooms | small | low | ✅ done |
| 9 | #8 a298 water modes | small | low (needs a298 hardware to verify) | ✅ done |

Items 3–9 in this table are protocol-affecting (`roborockLib/`) — treat as risky per
CLAUDE.md; each functional change must also update the next unreleased CHANGELOG section.
