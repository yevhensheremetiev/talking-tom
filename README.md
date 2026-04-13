# Talking Tom (Expo + Rive) — test task

## What this app does
- Shows a Rive character on a single screen.
- Automatically records when you start speaking and stops after ~1s of silence.
- Plays your recording back with a **higher pitch**.
- No backend, no external services.

## Key decisions (and why)
- **Expo managed**: fastest setup and iteration for a single-screen prototype.
- **`expo-av` for audio**: provides microphone permission handling + record/playback in one package.
- **Pitch**: implemented via playback rate (`rate > 1`) with `shouldCorrectPitch = false` which makes the voice sound higher (trade-off: playback is also slightly faster).
- **Voice/silence detection**: uses recording **metering (dB)** with simple thresholds and a silence timer.

## Setup
1. Replace the placeholder file `assets/character.riv` with the real `.riv` from the task link (your file from Downloads).
2. Install and run:

```bash
npm install
npm run ios
# or
npm run android
```

## Notes / limitations
- Metering values and thresholds can vary across devices; tweak `START_THRESHOLD_DB` / `SILENCE_THRESHOLD_DB` in `src/screens/RepeaterScreen.tsx`.
- If you need true pitch-shift without changing speed, the next step would be moving to `expo prebuild` and using a dedicated DSP solution.

