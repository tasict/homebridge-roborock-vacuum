# homebridge-roborock-vacuum

![Roborock Vacuum in Home App](https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/40/21/71/40217177-c879-f670-bd01-c93acfabc31e/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/460x0w.webp)

A Homebridge plugin to integrate your Roborock vacuum cleaner with Apple HomeKit, allowing you to control it via the Home app and Siri.

## Introduction

`homebridge-roborock-vacuum` brings your Roborock vacuum cleaner into Apple HomeKit. Using your Roborock app account credentials, this plugin automatically detects your vacuum, enabling you to control it directly from the Home app on your iPhone, iPad, or Mac, or with Siri voice commands.

This plugin is inspired by and adapted from the [ioBroker.roborock](https://github.com/copystring/ioBroker.roborock) project by copystring.

## Features

- **Automatic Device Detection**: No need to manually find or enter your vacuum's device ID.
- **Start/Stop Cleaning**: Begin or end cleaning sessions.

## The supported robots are:

Roborock S4
Roborock S4 Max
Roborock S5 Max
Roborock S6
Roborock S6 Pure
Roborock S6 MaxV
Roborock S7
Roborock S7 MaxV (Ultra)
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
