# Talking Tom

Small Expo + React Native app: a Rive character listens, records your voice when you speak, stops after a short silence, and plays it back higher-pitched. No backend.

**Choices:** Expo for a fast single-screen prototype and straightforward native permissions. `expo-av` handles mic access, recording, and playback in one place. Rive drives the character. Voice start/stop uses the recorder’s **dB metering** with simple thresholds instead of a separate VAD library. A **higher pitch** comes from a slightly faster playback rate with pitch correction disabled—quick to ship, at the cost of the clip sounding a bit sped up.

### Recording and playback limits

These values are constants in code; adjust them there if you need different behavior.

- **Maximum one take:** **30 seconds** (`MAX_RECORDING_MS`). After that, recording stops and whatever was captured is played back (or the flow returns to idle if there is no usable file).
- **End of phrase:** once the app has detected speech, **~1 second** of silence (`SILENCE_MS`) below the silence threshold ends the clip early, so normal sentences usually finish well under 30 seconds.
- **No speech:** if no confirmed voice within **~1 second** from the start of a take, recording is discarded and the app goes back to waiting.
- **Missing metering:** if level metering is unavailable for **~2.2 seconds** (`NO_METERING_STOP_MS`), recording stops and playback is attempted or the app idles out.
- **Playback:** the full clip is played at **1.25×** speed (`PLAYBACK_RATE`, pitch correction off), so playback duration is shorter than wall-clock recording time.

```bash
npm install
npm run ios
npm start
```
