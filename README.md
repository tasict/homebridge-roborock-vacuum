# homebridge-roborock-vacuum

![Roborock Vacuum in Home App](https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/40/21/71/40217177-c879-f670-bd01-c93acfabc31e/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/460x0w.webp)

A Homebridge plugin to integrate your Roborock vacuum cleaner with Apple HomeKit, allowing you to control it via the Home app and Siri.

## Introduction

`homebridge-roborock-vacuum` brings your Roborock vacuum cleaner into Apple HomeKit. Using your Roborock app account credentials, this plugin automatically detects your vacuum, enabling you to control it directly from the Home app on your iPhone, iPad, or Mac, or with Siri voice commands.

This plugin is inspired by and adapted from the [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) project by copystring.

## Features

- **Automatic Device Detection**: No need to manually find or enter your vacuum's device ID.
- **Start/Stop Cleaning**: Begin or end cleaning sessions.
- **Device Exclusion**: Skip selected Roborock device IDs so shared or remote vacuums stay out of HomeKit.

## The supported robots are:

Roborock S4
Roborock S4 Max
Roborock S5 Max
Roborock S6
Roborock S6 Pure
Roborock S6 MaxV
Roborock S7
Roborock S7 MaxV (Ultra)
Roborock Q5+
Roborock Q7
Roborock Q7 Max
Roborock S7 Pro Ultra
Roborock S7 Max Ultra
Roborock S8
Roborock S8 Pro Ultra
Roborock Q Revo
Roborock Q8 Max
Roborock Q5 Pro
Roborock Q Revo Pro
Roborock Qrevo S
Roborock Qrevo Curve
Roborock Saros 10
Roborock (roborock.vacuum.a95)
Roborock (roborock.vacuum.a159)
Roborock (roborock.vacuum.ss07)

## Requirements

Before installing, ensure you have:

- A Roborock vacuum cleaner compatible with the Roborock app.
- A Roborock app account (email and password).
- [Homebridge](https://github.com/homebridge/homebridge) installed on a server (e.g., Raspberry Pi).
- Node.js and npm installed on your Homebridge server.

## Installation

Follow these steps to install the plugin:

1. **Install Homebridge** (if not already installed):

   - Refer to the official [Homebridge installation guide](https://github.com/homebridge/homebridge#installation).

2. **Install the Plugin**:
   - Open a terminal and run:
     ```bash
     npm install -g homebridge-roborock-vacuum
     ```

## Configuration

Use the Homebridge UI settings page to sign in and configure the plugin. Click **Load devices** to list the vacuums on your account, then choose a protocol for each one:

- **HomeKit (HAP)** — the default. The vacuum is bridged to Apple Home as a fan-style accessory, as in previous versions.
- **Matter (Beta)** — the vacuum is published over Matter as a robotic vacuum cleaner, so it gets the native vacuum icon and controls in Apple Home (and works with Google Home, Alexa and SmartThings). This is an experimental feature — read the [Matter support (Beta)](#matter-support-beta) section below before enabling it.
- **Skip** — the vacuum is excluded entirely. You can also enter device IDs manually in the list below; manual entries are always skipped.

When Homebridge restarts, each device is (re)published according to its selection. A device that was cached under a different protocol (or is now skipped) is removed from the old bridge first. **Changing a device's protocol re-creates the accessory**, so it loses its room and automation assignments in your home app and must be re-organized there.

### Matter support (Beta)

> ⚠️ **This is an experimental, lab-grade beta feature.** Matter support for robotic vacuums is still very new on the controller side. In particular, **Apple Home's compatibility is currently poor and not very stable**: the bridge is uncertified (Apple shows an "Uncertified Accessory" warning), the accessory appears as a generic **"Matter Accessory"** during pairing and must be named manually, room selection needs iOS 18.4 or later, and accessories can occasionally show "Not responding" or lose features after iOS updates. If you want the most reliable day-to-day experience, stay on **HomeKit (HAP)**. Choose Matter only if you want the native vacuum UI and room cleaning, and can live with rough edges.

#### What you get over Matter

- The **native robot-vacuum accessory** in Apple Home (proper icon, start/stop, Siri) instead of the fan-style HAP accessory.
- **Room cleaning**: the vacuum's named rooms are exposed through the Matter ServiceArea cluster. Pick rooms in the controller and start cleaning — selecting none (or all) runs a full clean. While a room clean runs, the controller shows the room currently being cleaned.
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

#### Known limitations

- **Apple Home compatibility is immature** — see the warning at the top of this section. Treat this as a beta and expect to occasionally re-pair or restart Homebridge after controller/iOS updates.
- The device always pairs as a generic, uncertified **"Matter Accessory"**: controllers look the bridge's test vendor ID up in the certification database and ignore the name the device advertises, so the name must be entered manually (the pairing panel shows what to type).
- Scene buttons require the **separate bridge pairing** (step 5) and appear as plain on/off switches in the controller.
- Multi-floor maps are not exposed (rooms come from the currently active map), and zone cleaning, consumables and dock controls other than the mop-wash switch are not available over Matter yet.

## Dock mop-wash switch

On vacuums whose dock can wash the mop (G10, S7 Pro/MaxV Ultra, S7 Max Ultra, S8 Pro Ultra, Q Revo family, …) the plugin adds a switch that starts and stops a dock mop wash:

- **HAP devices** get an extra switch service on the vacuum accessory.
- **Matter devices** get a bridged on/off switch on the plugin's own Matter bridge (the same pairing as the scene buttons — step 5 above).

The switch is **stateful**: it turns on whenever the dock is washing the mop — including washes started from the Roborock app or mid-clean wash cycles — and turning it off stops the wash. Devices without a washing dock don't get the switch.

The switch's default name comes from the plugin's translation catalog in the language selected by the **Language** option on the settings page (`"language"` in `config.json`; default `en`, 12 languages including `zh-cn` and `zh-tw`). Changing the language only renames accessories on the next restart — accessory identities never change, so **no re-pairing and no room re-selection is needed**. You can also rename the switch freely in your home app.

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
