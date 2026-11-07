import "react-native-get-random-values"; // must be first: crypto.getRandomValues for the e2ee library
import "./src/lib/text-polyfill";
import notifee from "react-native-notify-kit";
import { foregroundRunner } from "./src/bg/foreground";
notifee.registerForegroundService(foregroundRunner); // must run before the app registers
import "expo-router/entry";
