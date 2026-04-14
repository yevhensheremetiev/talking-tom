import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Audio } from "expo-av";
import { useRive } from "rive-react-native";

import {
  MAX_RECORDING_MS,
  NO_METERING_STOP_MS,
  PLAYBACK_RATE,
  POLL_MS,
  REPEATER_RECORDING_OPTIONS,
  SILENCE_MS,
  SILENCE_THRESHOLD_DB,
  START_THRESHOLD_DB,
  VOICE_STREAK_TICKS,
} from "../constants/repeater";
import type { CharacterMode, PermissionState, UiState } from "../types/repeater";
import { applyCharacterMode } from "../utils/characterRive";
import { setRepeaterAudioMode } from "../utils/repeaterAudioMode";
import { clampDb, msNow } from "../utils/repeaterAudio";

export function useRepeaterSession() {
  const [setRiveRef, riveRef] = useRive();

  const [permission, setPermission] = useState<PermissionState>("checking");
  const [uiState, setUiState] = useState<UiState>("idle");

  const pollGateRef = useRef({ permission, uiState });
  pollGateRef.current = { permission, uiState };

  const recordingRef = useRef<Audio.Recording | null>(null);
  const pollingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const silenceSinceRef = useRef<number | null>(null);
  const heardVoiceRef = useRef(false);
  const voiceStreakRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const [recordingVoiceConfirmed, setRecordingVoiceConfirmed] = useState(false);

  const soundRef = useRef<Audio.Sound | null>(null);
  const isBusyRef = useRef(false);

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
        await setRepeaterAudioMode("playback");
        const { sound } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true, rate: PLAYBACK_RATE, shouldCorrectPitch: false },
        );
        soundRef.current = sound;

        sound.setOnPlaybackStatusUpdate((status) => {
          if (!status.isLoaded || !status.didJustFinish) return;
          void unloadSound()
            .finally(() => setRepeaterAudioMode("record"))
            .finally(() => setUiState("idle"));
        });

        try {
          await sound.setRateAsync(PLAYBACK_RATE, false);
        } catch {}
      } catch {
        await setRepeaterAudioMode("record");
        setUiState("idle");
      }
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

  const pollOnce = useCallback(async () => {
    if (isBusyRef.current) return;
    isBusyRef.current = true;

    const stopAndPlay = async () => {
      setUiState("processing");
      const uri = await stopRecordingIfAny();
      if (uri) await playUri(uri);
      else setUiState("idle");
    };

    try {
      const rec = recordingRef.current;
      if (!rec) {
        const { permission: p, uiState: s } = pollGateRef.current;
        if (p !== "granted" || s !== "idle") return;

        setUiState("recording");
        const { recording } = await Audio.Recording.createAsync(
          REPEATER_RECORDING_OPTIONS,
        );
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
          await stopAndPlay();
          return;
        }
      }

      const db = clampDb((status as { metering?: unknown }).metering);
      if (db == null) {
        if (startedAt != null && msNow() - startedAt >= NO_METERING_STOP_MS) {
          await stopAndPlay();
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
        await stopAndPlay();
      }
    } catch {
      setUiState("error");
      await stopRecordingIfAny();
      await unloadSound();
    } finally {
      isBusyRef.current = false;
    }
  }, [playUri, stopRecordingIfAny, unloadSound]);

  useEffect(() => {
    let mounted = true;

    const clearTimer = () => {
      if (pollingTimerRef.current) {
        clearInterval(pollingTimerRef.current);
        pollingTimerRef.current = null;
      }
    };

    void (async () => {
      try {
        await setRepeaterAudioMode("record");
        const ok = await ensurePermission();
        if (!mounted || !ok) return;

        clearTimer();
        pollingTimerRef.current = setInterval(pollOnce, POLL_MS);
      } catch {
        setUiState("error");
      }
    })();

    return () => {
      mounted = false;
      clearTimer();
      void stopRecordingIfAny();
      void unloadSound();
    };
  }, [ensurePermission, pollOnce, stopRecordingIfAny, unloadSound]);

  const { characterMode, statusLabel } = useMemo(() => {
    let characterMode: CharacterMode;
    switch (uiState) {
      case "recording":
        characterMode = recordingVoiceConfirmed ? "hear" : "idle";
        break;
      case "playing":
        characterMode = "talk";
        break;
      case "processing":
        characterMode = "processing";
        break;
      case "error":
        characterMode = "error";
        break;
      default:
        characterMode = "idle";
    }

    if (permission !== "granted") {
      return { characterMode, statusLabel: null as string | null };
    }
    let statusLabel: string | null;
    switch (characterMode) {
      case "idle":
        statusLabel = "Waiting for you to talk";
        break;
      case "hear":
      case "processing":
        statusLabel = "Listening";
        break;
      case "talk":
        statusLabel = "Repeating";
        break;
      default:
        statusLabel = null;
    }
    return { characterMode, statusLabel };
  }, [permission, recordingVoiceConfirmed, uiState]);

  useEffect(() => {
    applyCharacterMode(riveRef, characterMode);
  }, [riveRef, characterMode]);

  const onRiveError = useCallback(() => {
    setUiState("error");
  }, []);

  return {
    setRiveRef,
    statusLabel,
    onRiveError,
  };
}
