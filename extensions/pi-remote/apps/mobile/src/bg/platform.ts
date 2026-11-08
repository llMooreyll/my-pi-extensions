import notifee from "react-native-notify-kit";

export async function initialNotificationProcessId(): Promise<string | undefined> {
  const n = await notifee.getInitialNotification();
  const pid = n?.notification?.data?.processId;
  return typeof pid === "string" ? pid : undefined;
}

/** True when the app was started by tapping a file-transfer notification. */
export async function initialNotificationIsFiles(): Promise<boolean> {
  const n = await notifee.getInitialNotification();
  return n?.notification?.data?.files === "1";
}

export function openBatteryOptimization(): Promise<void> {
  return notifee.openBatteryOptimizationSettings();
}
