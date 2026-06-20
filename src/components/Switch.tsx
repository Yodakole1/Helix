import { Pressable, StyleSheet, View } from "react-native";
import { colors } from "../theme";

interface SwitchProps {
  value: boolean;
  onChange: () => void;
  color: string;
}

export function Switch({ value, onChange, color }: SwitchProps) {
  return (
    <Pressable
      onPress={onChange}
      style={[styles.track, { borderColor: color, backgroundColor: value ? color : colors.background.surface }]}
    >
      <View style={[styles.thumb, value && styles.thumbOn]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 34,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    padding: 2,
  },
  thumb: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: colors.background.base,
  },
  thumbOn: {
    marginLeft: 12,
  },
});
