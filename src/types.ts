import { PlatformConfig } from "homebridge";

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password?: string;
  debugMode: boolean;
  baseURL?: string;
  encryptedToken?: string;
  skipDevices?: string | string[];
  matterDevices?: string | string[];
  // Devices whose Roborock scenes are bridged as Matter buttons. Absent
  // (legacy config) means enabled for every Matter device.
  matterSceneDevices?: string | string[];
  currentRoomMqtt?: {
    enabled?: boolean;
    brokerUrl?: string;
    topic?: string;
    cleaningPollSeconds?: number;
  };
}
