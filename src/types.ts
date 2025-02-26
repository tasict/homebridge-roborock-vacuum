import { PlatformConfig } from 'homebridge';

export interface RoborockPlatformConfig extends PlatformConfig {
  email: string;
  password: string;
  debugMode: boolean;
}
