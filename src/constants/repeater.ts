import { Audio } from "expo-av";
import { Platform, StatusBar } from "react-native";

export const RIVE_SOURCE = require("../../assets/character.riv");
export const RIVE_STATE_MACHINE = "State Machine 1";

export const START_THRESHOLD_DB = -32;
export const SILENCE_THRESHOLD_DB = -45;
export const VOICE_STREAK_TICKS = 4;
export const SILENCE_MS = 1000;
export const POLL_MS = 80;
export const MAX_RECORDING_MS = 30000;
export const NO_METERING_STOP_MS = 2200;
export const PLAYBACK_RATE = 1.25;

const preset = Audio.RecordingOptionsPresets.HIGH_QUALITY;
export const REPEATER_RECORDING_OPTIONS = {
  ...preset,
  ios: { ...preset.ios, isMeteringEnabled: true },
  android: { ...preset.android, isMeteringEnabled: true },
  web: preset.web,
} as Audio.RecordingOptions;

export const STATUS_BAR_TOP =
  Platform.OS === "ios" ? 56 : (StatusBar.currentHeight ?? 0) + 12;
