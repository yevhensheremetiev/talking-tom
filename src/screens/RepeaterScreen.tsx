import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StatusBar, StyleSheet, Text, View } from "react-native";
import Rive, { Alignment, Fit, useRive, type RiveRef } from "rive-react-native";
import { Audio, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";

type PermissionState = "checking" | "denied" | "granted";
type UiState = "idle" | "recording" | "processing" | "playing" | "error";

const RIVE_SOURCE = require("../../assets/character.riv");

const RIVE_STATE_MACHINE = "State Machine 1";

type CharacterMode = "idle" | "hear" | "talk" | "processing" | "error";

function applyCharacterMode(riveRef: RiveRef | null, mode: CharacterMode) {
  if (!riveRef) return;
  const sm = RIVE_STATE_MACHINE;
  try {
    switch (mode) {
      case "hear":
        riveRef.setInputState(sm, "Hear", true);
        riveRef.setInputState(sm, "Talk", false);
        riveRef.setInputState(sm, "Check", false);
        break;
      case "talk":
        riveRef.setInputState(sm, "Hear", false);
        riveRef.setInputState(sm, "Talk", true);
        riveRef.setInputState(sm, "Check", false);
        break;
      case "processing":
        riveRef.setInputState(sm, "Hear", false);
        riveRef.setInputState(sm, "Talk", false);
        riveRef.setInputState(sm, "Check", true);
        break;
      case "error":
      case "idle":
        riveRef.setInputState(sm, "Hear", false);
        riveRef.setInputState(sm, "Talk", false);
        riveRef.setInputState(sm, "Check", false);
        break;
    }
  } catch {}
}

const START_THRESHOLD_DB = -32;
const SILENCE_THRESHOLD_DB = -45;
const VOICE_STREAK_TICKS = 4;
const SILENCE_MS = 1000;
const POLL_MS = 80;
const MAX_RECORDING_MS = 30000;
const NO_METERING_STOP_MS = 2200;
const PLAYBACK_RATE = 1.25;

const STATUS_BAR_TOP =
  Platform.OS === "ios" ? 56 : (StatusBar.currentHeight ?? 0) + 12;

function clampDb(metering: unknown): number | null {
  if (typeof metering !== "number" || Number.isNaN(metering)) return null;
  return Math.max(-160, Math.min(0, metering));
}

function msNow() {
  return Date.now();
}

export function RepeaterScreen() {
  const [setRiveRef, riveRef] = useRive();

  const [permission, setPermission] = useState<PermissionState>("checking");
  const [uiState, setUiState] = useState<UiState>("idle");

  const permissionRef = useRef<PermissionState>("checking");
  const uiStateRef = useRef<UiState>("idle");

  const recordingRef = useRef<Audio.Recording | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const heardVoiceRef = useRef(false);
  const voiceStreakRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const [recordingVoiceConfirmed, setRecordingVoiceConfirmed] = useState(false);

  const soundRef = useRef<Audio.Sound | null>(null);
  const isBusyRef = useRef(false);

  const recordingOptions = useMemo(() => {
    const preset = Audio.RecordingOptionsPresets.HIGH_QUALITY;
    return {
      ...preset,
      ios: { ...preset.ios, isMeteringEnabled: true },
      android: { ...preset.android, isMeteringEnabled: true },
      web: preset.web,
    } as Audio.RecordingOptions;
  }, []);

  const clearPolling = useCallback(() => {
    if (pollingTimerRef.current) {
      clearInterval(pollingTimerRef.current);
      pollingTimerRef.current = null;
    }
  }, []);

  const unloadSound = useCallback(async () => {
    const s = soundRef.current;
    soundRef.current = null;
    if (s) {
      try {
        await s.unloadAsync();
      } catch {}
    }
  }, []);

  /** iOS: `allowsRecordingIOS: true` routes playback to the earpiece; turn it off while playing. */
  const setRecordingAudioMode = useCallback(async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    });
  }, []);

  const setPlaybackAudioMode = useCallback(async () => {
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    });
  }, []);

  const stopRecordingIfAny = useCallback(async (): Promise<string | null> => {
    const rec = recordingRef.current;
    recordingRef.current = null;
    silenceSinceRef.current = null;
    heardVoiceRef.current = false;
    voiceStreakRef.current = 0;
    startedAtRef.current = null;

    if (!rec) return null;
    try {
      await rec.stopAndUnloadAsync();
      return rec.getURI() ?? null;
    } catch {
      setUiState("error");
      return null;
    }
  }, []);

  const playUri = useCallback(
    async (uri: string) => {
      setUiState("playing");
      await unloadSound();

      try {
        await setPlaybackAudioMode();
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, rate: PLAYBACK_RATE, shouldCorrectPitch: false },
        );
        soundRef.current = sound;

        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            unloadSound()
              .finally(() => setRecordingAudioMode())
              .finally(() => setUiState("idle"));
          }
        });

        try {
          await sound.setRateAsync(PLAYBACK_RATE, false);
        } catch {}
      } catch {
        await setRecordingAudioMode();
        setUiState("idle");
      }
    },
    [setPlaybackAudioMode, setRecordingAudioMode, unloadSound],
  );

  const ensurePermission = useCallback(async () => {
    setPermission("checking");
    const current = await Audio.getPermissionsAsync();
    if (current.status === "granted") {
      setPermission("granted");
      return true;
    }

    const requested = await Audio.requestPermissionsAsync();
    if (requested.status === "granted") {
      setPermission("granted");
      return true;
    }

    setPermission("denied");
    return false;
  }, []);

  useEffect(() => {
    permissionRef.current = permission;
    uiStateRef.current = uiState;
  }, [permission, uiState]);

  const pollOnce = useCallback(async () => {
    if (isBusyRef.current) return;
    isBusyRef.current = true;
    try {
      const rec = recordingRef.current;
      if (!rec) {
        const p = permissionRef.current;
        const s = uiStateRef.current;
        if (p !== "granted" || s !== "idle") return;

        setUiState("recording");
        const { recording } =
          await Audio.Recording.createAsync(recordingOptions);
        try {
          recording.setProgressUpdateInterval(POLL_MS);
        } catch {}
        recordingRef.current = recording;
        silenceSinceRef.current = null;
        heardVoiceRef.current = false;
        voiceStreakRef.current = 0;
        setRecordingVoiceConfirmed(false);
        startedAtRef.current = msNow();
        return;
      }

      const status = await rec.getStatusAsync();
      if (!status.isRecording) return;

      const startedAt = startedAtRef.current;
      if (startedAt != null) {
        const elapsed = msNow() - startedAt;
        if (elapsed >= MAX_RECORDING_MS) {
          setUiState("processing");
          const uri = await stopRecordingIfAny();
          if (uri) await playUri(uri);
          else setUiState("idle");
          return;
        }
      }

      const db = clampDb((status as any).metering);
      if (db == null) {
        if (startedAt != null && msNow() - startedAt >= NO_METERING_STOP_MS) {
          setUiState("processing");
          const uri = await stopRecordingIfAny();
          if (uri) await playUri(uri);
          else setUiState("idle");
        }
        return;
      }

      const isVoice = db > START_THRESHOLD_DB;
      const isSilence = db < SILENCE_THRESHOLD_DB;

      if (isVoice) {
        voiceStreakRef.current += 1;
        if (voiceStreakRef.current >= VOICE_STREAK_TICKS) {
          heardVoiceRef.current = true;
          setRecordingVoiceConfirmed(true);
          silenceSinceRef.current = null;
        }
      } else {
        if (db < START_THRESHOLD_DB) {
          voiceStreakRef.current = 0;
        }
        if (isSilence && heardVoiceRef.current) {
          silenceSinceRef.current ??= msNow();
        }
      }

      if (
        !heardVoiceRef.current &&
        startedAt != null &&
        msNow() - startedAt >= SILENCE_MS
      ) {
        await stopRecordingIfAny();
        setUiState("idle");
        return;
      }

      const silenceSince = silenceSinceRef.current;
      if (silenceSince != null && msNow() - silenceSince >= SILENCE_MS) {
        setUiState("processing");
        const uri = await stopRecordingIfAny();
        if (uri) await playUri(uri);
        else setUiState("idle");
      }
    } catch {
      setUiState("error");
      await stopRecordingIfAny();
      await unloadSound();
    } finally {
      isBusyRef.current = false;
    }
  }, [playUri, recordingOptions, stopRecordingIfAny, unloadSound]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await setRecordingAudioMode();
        const ok = await ensurePermission();
        if (!mounted) return;
        if (!ok) return;

        clearPolling();
        pollingTimerRef.current = setInterval(pollOnce, POLL_MS);
      } catch {
        setUiState("error");
      }
    })();
    return () => {
      mounted = false;
      clearPolling();
      stopRecordingIfAny();
      unloadSound();
    };
  }, [
    clearPolling,
    ensurePermission,
    pollOnce,
    setRecordingAudioMode,
    stopRecordingIfAny,
    unloadSound,
  ]);

  const characterMode = useMemo((): CharacterMode => {
    switch (uiState) {
      case "recording":
        return recordingVoiceConfirmed ? "hear" : "idle";
      case "playing":
        return "talk";
      case "processing":
        return "processing";
      case "error":
        return "error";
      default:
        return "idle";
    }
  }, [recordingVoiceConfirmed, uiState]);

  useEffect(() => {
    applyCharacterMode(riveRef, characterMode);
  }, [riveRef, characterMode]);

  const statusLabel = useMemo(() => {
    if (permission !== "granted") return null;
    switch (characterMode) {
      case "idle":
        return "Waiting for you to talk";
      case "hear":
      case "processing":
        return "Listening";
      case "talk":
        return "Repeating";
      case "error":
        return null;
      default:
        return null;
    }
  }, [characterMode, permission]);

  return (
    <View style={styles.container}>
      <View style={[styles.statusBar, { paddingTop: STATUS_BAR_TOP }]}>
        {statusLabel ? (
          <Text style={styles.statusText}>{statusLabel}</Text>
        ) : null}
      </View>
      <View style={styles.riveWrap}>
        <Rive
          ref={setRiveRef}
          source={RIVE_SOURCE}
          stateMachineName={RIVE_STATE_MACHINE}
          autoplay
          fit={Fit.Contain}
          alignment={Alignment.Center}
          style={styles.rive}
          onError={() => {
            setUiState("error");
          }}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1020",
  },
  statusBar: {
    minHeight: 24,
    paddingHorizontal: 20,
    paddingBottom: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  statusText: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 15,
    fontWeight: "500",
    letterSpacing: 0.2,
    textAlign: "center",
  },
  riveWrap: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  rive: {
    width: "100%",
    height: "100%",
  },
});
