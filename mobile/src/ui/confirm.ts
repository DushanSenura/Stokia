import { Alert } from "react-native";

/** Ask a yes/no question with the platform's own dialog. Resolves true only if the person chooses the action. */
export function confirmDialog(title: string, message: string, actionLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: cancelLabel, style: "cancel", onPress: () => resolve(false) },
      { text: actionLabel, style: "destructive", onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}
