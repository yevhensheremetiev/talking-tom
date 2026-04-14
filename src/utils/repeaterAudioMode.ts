import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";

const shared = {
  playsInSilentModeIOS: true,
  interruptionModeIOS: InterruptionModeIOS.DoNotMix,
  interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
  shouldDuckAndroid: true,
  playThroughEarpieceAndroid: false,
  staysActiveInBackground: false,
} as const;

export async function setRepeaterAudioMode(mode: "record" | "playback") {
  await Audio.setAudioModeAsync({
    ...shared,
    allowsRecordingIOS: mode === "record",
  });
}
