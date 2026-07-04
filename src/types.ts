import { PlatformConfig } from "homebridge";

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password?: string;
  debugMode: boolean;
  baseURL?: string;
  encryptedToken?: string;
  skipDevices?: string | string[];
  matterDevices?: string | string[];
  currentRoomMqtt?: {
    enabled?: boolean;
    brokerUrl?: string;
    topic?: string;
    cleaningPollSeconds?: number;
  };
}
