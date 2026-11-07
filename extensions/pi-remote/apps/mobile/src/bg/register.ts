import notifee from "react-native-notify-kit";
import { foregroundRunner } from "./foreground";

// Must run before the app component registers.
notifee.registerForegroundService(foregroundRunner);
