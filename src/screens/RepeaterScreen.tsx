import { StyleSheet, Text, View } from "react-native";
import Rive, { Alignment, Fit } from "rive-react-native";

import {
  RIVE_SOURCE,
  RIVE_STATE_MACHINE,
  STATUS_BAR_TOP,
} from "../constants/repeater";
import { useRepeaterSession } from "../hooks/useRepeaterSession";

export function RepeaterScreen() {
  const { setRiveRef, statusLabel, onRiveError } = useRepeaterSession();

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
          onError={onRiveError}
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
