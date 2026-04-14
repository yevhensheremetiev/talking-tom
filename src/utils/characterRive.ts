import type { RiveRef } from "rive-react-native";

import { RIVE_STATE_MACHINE } from "../constants/repeater";
import type { CharacterMode } from "../types/repeater";

export function applyCharacterMode(riveRef: RiveRef | null, mode: CharacterMode) {
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
