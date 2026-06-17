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

Use the Homebridge UI settings page to sign in and configure the plugin. To exclude vacuums from HomeKit, add their Roborock device IDs to **Skipped Device IDs**.

When Homebridge restarts, matching devices will be skipped during discovery. If a skipped device already exists in HomeKit as a cached accessory, the plugin will remove it from Homebridge.

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
