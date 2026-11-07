import notifee from "react-native-notify-kit";

export async function initialNotificationProcessId(): Promise<string | undefined> {
  const n = await notifee.getInitialNotification();
  const pid = n?.notification?.data?.processId;
  return typeof pid === "string" ? pid : undefined;
}

export function openBatteryOptimization(): Promise<void> {
  return notifee.openBatteryOptimizationSettings();
}
