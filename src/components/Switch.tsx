import { Pressable, StyleSheet, View } from "react-native";
import { colors, withAlpha } from "../theme";

interface SwitchProps {
  value: boolean;
  onChange: () => void;
  color: string;
}

export function Switch({ value, onChange, color }: SwitchProps) {
  return (
    <Pressable
      onPress={onChange}
      style={[
        styles.track,
        value
          ? { backgroundColor: color, borderColor: color }
          : { backgroundColor: withAlpha(color, 0.12), borderColor: withAlpha(color, 0.4) },
      ]}
    >
      <View
        style={[
          styles.thumb,
          value
            ? { backgroundColor: colors.background.base, marginLeft: 14 }
            : { backgroundColor: color },
        ]}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 36,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    padding: 2,
    justifyContent: "center",
  },
  thumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
  },
});
