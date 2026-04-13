import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
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
const MAX_RECORDING_MS = 8000;
const NO_METERING_STOP_MS = 2200;
const PLAYBACK_RATE = 1.25;

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
  const [debug, setDebug] = useState<string>("");
  const [liveDb, setLiveDb] = useState<number | null>(null);

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
    } catch (e) {
      setUiState("error");
      setDebug(String(e));
      return null;
    }
  }, []);

  const playUri = useCallback(
    async (uri: string) => {
      setUiState("playing");
      await unloadSound();

      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true, rate: PLAYBACK_RATE, shouldCorrectPitch: false },
      );
      soundRef.current = sound;

      sound.setOnPlaybackStatusUpdate((status) => {
        if (!status.isLoaded) return;
        if (status.didJustFinish) {
          unloadSound().finally(() => setUiState("idle"));
        }
      });

      try {
        await sound.setRateAsync(PLAYBACK_RATE, false);
      } catch {}
    },
    [unloadSound],
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

  const prepareAudioMode = useCallback(async () => {
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
        setLiveDb(null);
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
        setLiveDb(null);
        if (startedAt != null && msNow() - startedAt >= NO_METERING_STOP_MS) {
          setUiState("processing");
          const uri = await stopRecordingIfAny();
          if (uri) await playUri(uri);
          else setUiState("idle");
        }
        return;
      }
      setLiveDb(db);

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
    } catch (e) {
      setUiState("error");
      setDebug(String(e));
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
        await prepareAudioMode();
        const ok = await ensurePermission();
        if (!mounted) return;
        if (!ok) return;

        clearPolling();
        pollingTimerRef.current = setInterval(pollOnce, POLL_MS);
      } catch (e) {
        setUiState("error");
        setDebug(String(e));
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
    prepareAudioMode,
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

  const subtitle = useMemo(() => {
    if (permission === "checking") return "Checking microphone permission…";
    if (permission === "denied")
      return "Microphone permission denied. Enable it in Settings.";
    switch (uiState) {
      case "idle":
        return "Say something…";
      case "recording":
        return "Listening…";
      case "processing":
        return "Thinking…";
      case "playing":
        return "Repeating…";
      case "error":
        return "Something went wrong.";
    }
  }, [permission, uiState]);

  return (
    <View style={styles.container}>
      <View style={styles.riveWrap}>
        <Rive
          ref={setRiveRef}
          source={RIVE_SOURCE}
          stateMachineName={RIVE_STATE_MACHINE}
          autoplay
          fit={Fit.Contain}
          alignment={Alignment.Center}
          style={styles.rive}
          onError={(e) => {
            setUiState("error");
            setDebug(JSON.stringify(e));
          }}
        />
      </View>

      <View style={styles.hud}>
        <Text style={styles.title}>Talking Tom (test)</Text>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {permission === "granted" && uiState === "recording" ? (
          <Text style={styles.meter}>
            dB: {liveDb == null ? "…" : liveDb.toFixed(1)}
          </Text>
        ) : null}
        {uiState === "error" && debug ? (
          <Text style={styles.debug} selectable>
            {Platform.OS}: {debug}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0b1020",
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
  hud: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.12)",
  },
  title: {
    color: "rgba(255,255,255,0.9)",
    fontSize: 16,
    fontWeight: "600",
  },
  subtitle: {
    marginTop: 6,
    color: "rgba(255,255,255,0.72)",
    fontSize: 14,
  },
  debug: {
    marginTop: 10,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
  },
  meter: {
    marginTop: 8,
    color: "rgba(255,255,255,0.55)",
    fontSize: 12,
  },
});
