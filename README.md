<p align="center">
  <img src="https://raw.githubusercontent.com/tasict/homebridge-roborock-vacuum/master/branding/icon.png" width="96" height="96" alt="">
</p>

# Homebridge Roborock Vacuum

**Website: [tasict.github.io/homebridge-roborock-vacuum](https://tasict.github.io/homebridge-roborock-vacuum/)** (English, 繁體中文, 日本語)

[![npm version](https://img.shields.io/npm/v/homebridge-roborock-vacuum?color=%23cb3837&label=npm)](https://www.npmjs.com/package/homebridge-roborock-vacuum)
[![npm downloads](https://img.shields.io/npm/dm/homebridge-roborock-vacuum)](https://www.npmjs.com/package/homebridge-roborock-vacuum)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

`homebridge-roborock-vacuum` is a [Homebridge](https://homebridge.io) plugin that brings Roborock robot vacuums into Apple Home, over HomeKit or Matter. Sign in with your Roborock app account and the plugin finds your vacuums by itself; you can then start and stop them from the Home app, with Siri or from automations. Commands go to the vacuum over your home network, so it stays controllable when the Roborock cloud is down.

Free and open source. If it saves you a few chores, you can [buy me a boba](https://tasict.bobaboba.me) (by card, no PayPal account needed) or [tip with PayPal](https://paypal.me/tasict).

This plugin is inspired by and adapted from the [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) project by copystring.

## Features

- **Automatic device discovery** — no device IDs or IP addresses to look up. The Roborock region is detected from your account.
- **Start, stop and send home** — over HomeKit the vacuum is a fan-style accessory: turn it on to start cleaning, off to stop and return to the dock.
- **Battery, charging and status** — battery level, charging state, low-battery warning, and a fault/offline flag when the vacuum reports an error or loses its connection.
- **Roborock scenes as switches** — every enabled scene from the Roborock app that uses the vacuum can be run from Apple Home. Each switch has the scene's name, and a name you give it in the Home app is kept.
- **Dock mop-wash switch** on docks that wash the mop. See [Dock mop-wash switch](#dock-mop-wash-switch).
- **Consumables** (HomeKit) — remaining life of the filter, main brush and side brush, with a change reminder at 5% or less.
- **Clear errors from the settings page** — an error the vacuum or dock keeps reporting after you fixed the cause can be cleared without the Roborock app. See [Clearing device errors](#clearing-device-errors).
- **Matter (Beta)** — publish a vacuum as a native Matter robot vacuum, with room cleaning and clean modes. See [Matter support (Beta)](#matter-support-beta).
- **Local first, works through cloud outages** — commands, status, consumables and scenes go over the LAN, with the cloud as the fallback, and the plugin starts in local-only mode when the Roborock cloud is unreachable. See [Cloud outages and local-only mode](#cloud-outages-and-local-only-mode).
- **Current room → MQTT** (optional) — publish the room being cleaned to your MQTT broker. See [Current Room → MQTT](#current-room--mqtt-optional-telemetry).
- **Per-device choice** — publish each vacuum over HomeKit or Matter, or skip it (for example a vacuum shared from another home).

## Supported vacuums

The plugin works with vacuums that are on your **Roborock app** account. These models are known to work:

S4, S4 Max, S5 Max, S6, S6 Pure, S6 MaxV, S7, S7 MaxV (Ultra), S7 Pro Ultra, S7 Max Ultra, S8, S8 Pro Ultra, S8 MaxV Ultra, Q5+, Q5 Pro, Q7, Q7 Max, Q8 Max, Qrevo, Qrevo Pro, Qrevo S, Qrevo Curv, Saros 10, and the models `roborock.vacuum.a95`, `roborock.vacuum.a159` and `roborock.vacuum.ss07`.

Most other vacuums in the Roborock app work as well; which extras (dock mop wash, consumables, clean modes) appear depends on what the model reports. A vacuum that is set up only in the Xiaomi Home app is not on your Roborock account, so the plugin cannot see it.

## Requirements

- A Roborock vacuum added to the Roborock app, and the email address of that Roborock account.
- [Homebridge](https://homebridge.io) 1.6 or later, on Node.js 18.20, 20.15, 22 or 24.
- For Matter: Homebridge 2.x with Matter enabled on the bridge the plugin runs on.

## Installation

In the Homebridge UI, open **Plugins**, search for **Roborock Vacuum** and install `homebridge-roborock-vacuum`.

Without the UI, install it next to Homebridge:

```bash
npm install -g homebridge-roborock-vacuum
```

## Configuration

Configure the plugin from its settings page in the Homebridge UI:

1. **Sign in.** Enter your Roborock app email. Either enter your password and press **Password Login**, or press **Send 2FA Email** and enter the code from the email with **Verify Code** (also the way to finish a login that asks for two-factor authentication). Leave **Region** on _Auto detect_ unless detection picks the wrong server. The settings page stores an encrypted session token; you do not need to sign in again after a restart.
2. **Choose a protocol per vacuum.** Press **Load devices** to list the vacuums on your account and pick one for each:
   - **HomeKit (HAP)** — the default. The vacuum is bridged to Apple Home as a fan-style accessory, as in previous versions.
   - **Matter (Beta)** — the vacuum is published over Matter as a robotic vacuum cleaner, so it gets the native vacuum icon and controls in Apple Home (and works with Google Home, Alexa and SmartThings). This is an experimental feature — read the [Matter support (Beta)](#matter-support-beta) section below before enabling it.
   - **Skip** — the vacuum is excluded entirely. You can also enter device IDs manually in the list below; manual entries are always skipped.
3. **Restart Homebridge.**

When Homebridge restarts, each device is (re)published according to its selection. A device that was cached under a different protocol (or is now skipped) is removed from the old bridge first. **Changing a device's protocol re-creates the accessory**, so it loses its room and automation assignments in your home app and must be re-organized there.

### Options

The settings page writes these keys to the `RoborockVacuumPlatform` block in `config.json`:

| Key                  | Description                                                                                                                                                                                                |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`              | Roborock app account email. Required.                                                                                                                                                                      |
| `password`           | Roborock account password, saved by **Password Login**. Not needed when you sign in with an email code.                                                                                                    |
| `encryptedToken`     | Encrypted session data, managed by the settings page.                                                                                                                                                      |
| `baseURL`            | Roborock API endpoint. Leave empty to auto-detect; otherwise `https://usiot.roborock.com` (US), `https://euiot.roborock.com` (EU), `https://cniot.roborock.com` (CN) or `https://api.roborock.com` (Asia). |
| `language`           | Language of the names the plugin gives to switches and sensors it adds (`en`, `de`, `es`, `fr`, `it`, `nl`, `pl`, `pt`, `ru`, `uk`, `zh-cn`, `zh-tw`). Default `en`.                                       |
| `skipDevices`        | Device IDs to leave out, as a list or a comma- or newline-separated string.                                                                                                                                |
| `matterDevices`      | Device IDs to publish over Matter instead of HomeKit. Ignored without Homebridge 2 and Matter.                                                                                                             |
| `matterSceneDevices` | Matter device IDs whose Roborock scenes become Matter buttons. When omitted, every Matter device gets them.                                                                                                |
| `currentRoomMqtt`    | Optional current-room telemetry, see [Current Room → MQTT](#current-room--mqtt-optional-telemetry).                                                                                                        |
| `debugMode`          | Write debug messages to the Homebridge log. Default `false`.                                                                                                                                               |

### Matter support (Beta)

> ⚠️ **This is an experimental, lab-grade beta feature.** Matter support for robotic vacuums is still very new on the controller side. In particular, **Apple Home's compatibility is currently poor and not very stable**: the bridge is uncertified (Apple shows an "Uncertified Accessory" warning), the accessory appears as a generic **"Matter Accessory"** during pairing and must be named manually, room selection needs iOS 18.4 or later, and accessories can occasionally show "Not responding" or lose features after iOS updates. If you want the most reliable day-to-day experience, stay on **HomeKit (HAP)**. Choose Matter only if you want the native vacuum UI and room cleaning, and can live with rough edges.

#### What you get over Matter

- The **native robot-vacuum accessory** in Apple Home (proper icon, start/stop, Siri) instead of the fan-style HAP accessory.
- **Room cleaning**: the vacuum's named rooms are exposed through the Matter ServiceArea cluster. Pick rooms in the controller and start cleaning — selecting none (or all) runs a full clean. While a room clean runs, the controller shows the room currently being cleaned. Vacuums with several saved floor maps publish each floor as its own map (Apple Home shows a **Cleaning Map** picker): see [Multi-floor maps](#multi-floor-maps).
- **Vacuum / Mop / Vacuum & Mop** clean modes, mapped to the Roborock suction and water-box settings (models without a water box only offer Vacuum).
- **Battery, charging state and error reporting** (stuck, dust bin missing, dock unreachable, … are surfaced as Matter operational errors).
- Every Roborock **scene** that targets the device becomes an on/off button (see step 5 below). When the same scene name exists on more than one Matter vacuum, the vacuum's name is appended to keep the buttons distinguishable.
- On docks that can wash the mop, a **dock mop-wash switch** (bridged like the scene buttons, so it also needs the step-5 pairing). See [Dock mop-wash switch](#dock-mop-wash-switch).
- **Identify** ("play sound to locate" in Apple Home) plays the vacuum's find-me sound.

Run-mode semantics follow the Matter spec: setting the run mode to **Idle stops** the vacuum where it is; use the **dock/Go Home** control to send it back to the charger.

#### Requirements

- **Homebridge 2.x** with Matter enabled on the bridge this plugin runs on (Homebridge 1.x, or Matter disabled, silently falls back to HAP with a log warning — nothing breaks).
- For room cleaning in Apple Home: **iOS 18.4 or later**, and rooms must be **named in the Roborock app** (unnamed rooms are not published; the room list loads shortly after Homebridge starts).

#### Setup steps

1. **Enable Matter on the bridge.** If the plugin runs as a child bridge (the default when configured through the Homebridge UI), tick **"Enable Matter on this plugin's child bridge"** on the plugin settings page (writes `_bridge.matter` for you). If it runs on the main bridge, set `"matter": true` on the `bridge` block in `config.json`. Restart Homebridge to apply.
2. **Select the protocol.** On the plugin settings page press **Load devices** and set the vacuum's dropdown to **Matter (Beta)**, then restart Homebridge. The per-device Matter option only appears when the relevant bridge has Matter enabled.
3. **Pair the vacuum.** Reopen the settings page — a pairing panel with a QR code, the manual pairing code and the commissioning status appears under every Matter-selected device (each device is its own Matter node with its **own** pairing code). In Apple Home choose **Add Accessory** and scan the QR code. Expect the **"Uncertified Accessory"** warning (press _Add Anyway_) and a generic **"Matter Accessory"** name — when asked for a name, type the device name shown in the pairing panel.
4. **Try it.** Start/stop from the accessory tile, pick rooms (iOS 18.4+) before starting for a room clean, and use the dock control to send it home.
5. **Optional — scene buttons.** The scene buttons live on the plugin's **own Matter bridge**, which is a separate pairing from the vacuum. Scroll to the bottom of the device list on the settings page and scan the additional bridge QR code to add them. Scene list changes are picked up on the next Homebridge restart.

Pairing is one-time per node — switching a device between HAP and Matter later does **not** require re-pairing, but note that **changing a device's protocol re-creates the accessory**, so room and automation assignments in your home app are lost and must be re-organized.

#### Multi-floor maps

When the vacuum has more than one saved map, every floor is published with its own rooms, and Apple Home lists them under **Cleaning Map**.

- **Learning each floor's rooms**: the vacuum only reports the rooms of the map it has loaded. Once, while the vacuum sits idle on its dock, the plugin loads each other map for a few seconds, reads its rooms and loads the original map again, like Home Assistant does. The vacuum does not move. The result is saved on disk (`roborock.multimap.<duid>.json` in the Homebridge storage folder), and the loaded map's rooms keep updating on every refresh. A map without named rooms is checked again at most once a day.
- **Floors without rooms**: a map whose rooms are not divided or named in the Roborock app is published as one area named after the floor. Selecting it cleans the whole floor.
- **Cleaning another floor**: starting a clean of rooms on a map that is not loaded first loads that map, like a Roborock scene that switches floors, and only cleans once the vacuum lists the same rooms on it. **The vacuum must already be on that floor.** Rooms from several floors cannot be cleaned in one go, and maps are only switched while the vacuum is idle on its dock.
- A vacuum with a single map keeps its existing map and area ids, so room selections and automations are unchanged.

#### Known limitations

- **Apple Home compatibility is immature** — see the warning at the top of this section. Treat this as a beta and expect to occasionally re-pair or restart Homebridge after controller/iOS updates.
- The device always pairs as a generic, uncertified **"Matter Accessory"**: controllers look the bridge's test vendor ID up in the certification database and ignore the name the device advertises, so the name must be entered manually (the pairing panel shows what to type).
- Scene buttons require the **separate bridge pairing** (step 5) and appear as plain on/off switches in the controller.
- Zone cleaning, consumables and dock controls other than the mop-wash switch are not available over Matter yet.

## Cloud outages and local-only mode

Roborock's cloud is required to log in and to read your device and scene
lists, but not to _control_ a vacuum: once the plugin knows a device's local
key, it talks to the robot directly over your LAN. Everything the robot can
answer locally goes over the LAN first, and the cloud is only the fallback:

- **Commands** (start, stop, dock, dock wash, rooms) go over the LAN. A
  command that gets no local answer is sent once more through the cloud.
- **Status** (state, battery, charging, errors) is read from the robot every
  15 seconds while it is cleaning, returning or docking, and while the cloud
  push channel is down; otherwise on the regular refresh.
- **Consumables** (filter, main and side brush) are computed from the
  robot's own work times, like the Roborock app does; the cloud's copy is
  used only when the robot does not report them.
- **Reachability**: a vacuum with a working local connection is never shown
  as "Not Responding", whatever the cloud reports.
- **Scenes** whose steps are all commands for vacuums connected over the LAN
  run locally, one step after the other: the next step starts once the
  vacuum is back on the dock and the dock has finished emptying and washing.
  Stopping or docking the vacuum from Apple Home, starting another scene on
  it, or restarting Homebridge drops the remaining steps. Other scenes, and
  scenes whose first step the vacuum does not accept locally, are run by the
  Roborock cloud as before. A scene run locally may not show up in the
  Roborock app's history.
- **LAN address changes** are found with UDP discovery before the cloud is
  asked.

The plugin caches the device list, the local keys, each vacuum's last known
LAN address and the scene list on disk (owner-readable only) after every
successful cloud refresh. If the Roborock cloud is unreachable when Homebridge
starts, the plugin falls back to that cache and starts in **local-only mode**:

- your vacuums and scene switches still appear in HomeKit, and commands and
  scenes work over the LAN;
- vacuums are found by UDP discovery, or dialed at their cached address when
  discovery finds nothing (another VLAN, or port 58866 in use);
- changes to the device or scene list, shared vacuums and the cloud's push
  updates wait until the cloud returns;
- the plugin keeps retrying in the background, so cloud features come back on
  their own without a Homebridge restart. If the login itself failed during
  the outage, the plugin logs in again by itself once the cloud answers (a
  pending two-factor prompt still needs the Config UI).

The log says which mode you are in (`Starting adapter finished in local-only
mode (cloud unreachable).`). Two caveats: the plugin needs **one successful
online start** to create the cache, so a brand-new install cannot start offline,
and a vacuum that is shared from another Roborock account can only be controlled
through the cloud.

Some firmwares (such as the S8 MaxV Ultra on 02.39.x) speak a different local
protocol than the one the cloud reports for them. The plugin detects this when
it connects and logs `reports protocol 1.0 but answers L01 locally`; nothing
needs to be configured.

## Dock mop-wash switch

On vacuums whose dock can wash the mop (G10, S7 Pro/MaxV Ultra, S7 Max Ultra, S8 Pro Ultra, Q Revo family, …) the plugin adds a switch that starts and stops a dock mop wash:

- **HAP devices** get an extra switch service on the vacuum accessory.
- **Matter devices** get a bridged on/off switch on the plugin's own Matter bridge (the same pairing as the scene buttons — step 5 above).

The switch is **stateful**: it turns on whenever the dock is washing the mop — including washes started from the Roborock app or mid-clean wash cycles — and turning it off stops the wash. Devices without a washing dock don't get the switch.

The switch's default name comes from the plugin's translation catalog in the language selected by the **Language** option on the settings page (`"language"` in `config.json`; default `en`, 12 languages including `zh-cn` and `zh-tw`). Changing the language only renames accessories on the next restart — accessory identities never change, so **no re-pairing and no room re-selection is needed**. You can also rename the switch freely in your home app; a renamed switch keeps your name across restarts and language changes.

## Clearing device errors

Some errors stay on the vacuum until they are marked as resolved in the Roborock app, even after the cause is fixed. A typical one is the dock's "clean water tank empty" after you have refilled the tank. While such an error is latched, Apple Home keeps showing the fault.

When a vacuum reports an error, the plugin's settings page shows it next to the vacuum in the device list, with the error code and a short description. Press **Clear error** to resolve it, like tapping **Resolved** in the Roborock app. A dock error is cleared first; press the button again if the vacuum then still reports an error of its own.

The settings page asks the running plugin to send the command, so Homebridge must be running. Fix the cause before clearing the error; an error whose cause is still there comes back.

## Current Room → MQTT (optional telemetry)

The plugin can publish the room a vacuum is currently cleaning to a local MQTT broker, for use in external automations (e.g. lighting that follows the vacuum room to room). This is **telemetry only** — it is not exposed to HomeKit — and is **off by default**. It reuses the `mqtt` dependency the plugin already ships, so it adds nothing when disabled.

Enable it under **Current Room → MQTT** in the settings UI, or in `config.json`:

```json
"currentRoomMqtt": {
  "enabled": true,
  "brokerUrl": "mqtt://127.0.0.1:1883",
  "topic": "homebridge/roborock/{duid}/current_room",
  "cleaningPollSeconds": 10
}
```

- **topic** is a template. `{duid}` and `{name}` (the device name, slugified) are substituted. If the template contains neither token, `/{duid}` is appended automatically so multiple vacuums never publish to the same topic.
- **cleaningPollSeconds** is how often status is polled while the vacuum is actively cleaning (it polls slowly otherwise). The poll only runs while the feature is enabled.

A retained JSON message is published whenever the room changes:

```json
{
  "segment_id": 16,
  "room": "Kitchen",
  "state": 5,
  "target_segment_id": 17,
  "target_room": "Hallway",
  "in_cleaning": 1,
  "ts": 1718524800000
}
```

- **segment_id / room** — the room currently being cleaned. `segment_id` is `-1` (and `room` `null`) when docked/idle, or transiently while the robot relocalizes; use `state` to distinguish.
- **target_segment_id / target_room** — the next room the robot is heading to (populated during transitions), so a consumer can pre-light it. `-1`/`null` when steady or unknown.
- **in_cleaning** — the device's own flag; `0` once a clean has concluded even while the robot returns to the dock or empties, which `state` alone does not always distinguish.
- Room names are resolved from the robot's saved map; name your rooms in the Roborock app for them to appear.

> Validated on a Roborock Qrevo (`roborock.vacuum.a185`). On models that don't populate `cleaning_info`, the payload degrades gracefully to `segment_id: -1` / `room: null`.

## Support

If this plugin is useful to you, I'd love it if you bought me a boba:

- **[Buy me a boba](https://tasict.bobaboba.me)**: pay by card, no PayPal account needed
- **[Tip with PayPal](https://paypal.me/tasict)**

## Trademarks

Roborock is a trademark of Beijing Roborock Technology Co., Ltd. Apple Home and HomeKit are trademarks of Apple Inc. Matter is a trademark of the Connectivity Standards Alliance. This plugin is unofficial and is not affiliated with, endorsed by, or sponsored by any of them.
