#!/usr/bin/env node
// Waydroid UI helper: press <label> | labels | haslabel <label|prefix*> | waitlabel <label> [sec] | dump | tap <label> [index] | has <label> | wait <label> [sec] | type <label> <text> | state | text <substring> | key <code> | back
import { execFileSync } from "node:child_process";
const D = process.env.WD ?? "192.168.240.112:5555";
const adb = (...a) => execFileSync("adb", ["-s", D, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function nodes() {
  let x = "";
  for (let i = 0; i < 3 && !x.includes("<hierarchy"); i++) { try { x = adb("exec-out", "uiautomator", "dump", "/dev/tty"); } catch { x = ""; } }
  const out = [];
  for (const m of x.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    const dec = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#10;/g, "\n").replace(/&apos;/g, "'");
    out.push({ text: dec(m[1]), desc: dec(m[2]), x: (+m[3] + +m[5]) >> 1, y: (+m[4] + +m[6]) >> 1, w: +m[5] - +m[3], h: +m[6] - +m[4] });
  }
  return out;
}
const [cmd, a, b] = process.argv.slice(2);
const find = (label) => nodes().filter((n) => n.desc === label && n.w > 0 && n.h > 0);
switch (cmd) {
  case "dump": for (const n of nodes()) if (n.text || n.desc) console.log(`${n.desc ? `[${n.desc}] ` : ""}${n.text.replace(/\n/g, "⏎").slice(0, 120)} @${n.x},${n.y}`); break;
  case "tap": { const f = find(a); const n = f[Number(b ?? 0)]; if (!n) { console.error(`not found: ${a}`); process.exit(2); } adb("shell", "input", "tap", String(n.x), String(n.y)); console.log(`tapped ${a}`); break; }
  case "taptext": { const n = nodes().find((n) => n.text.includes(a)); if (!n) { console.error(`text not found: ${a}`); process.exit(2); } adb("shell", "input", "tap", String(n.x), String(n.y)); console.log(`tapped text ${a}`); break; }
  case "has": { const ok = find(a).length > 0; console.log(ok ? "yes" : "no"); process.exit(ok ? 0 : 1); }
  case "text": { const ok = nodes().some((n) => n.text.includes(a) || n.desc.includes(a)); console.log(ok ? "yes" : "no"); process.exit(ok ? 0 : 1); }
  case "wait": { const until = Date.now() + Number(b ?? 20) * 1000; while (Date.now() < until) { const ns = nodes(); if (ns.some((n) => n.desc === a || n.text.includes(a))) { console.log(`found ${a}`); process.exit(0); } await sleep(700); } console.error(`timeout waiting for ${a}`); process.exit(2); }
  case "type": { adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'piremote://test/type?label=${encodeURIComponent(a)}&text=${encodeURIComponent(b ?? "")}'`); await sleep(500); console.log(`typed into ${a}`); break; }
  case "state": {
    adb("logcat", "-c");
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "'piremote://test/dump'");
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const log = adb("logcat", "-d", "-s", "ReactNativeJS:I");
      const line = log.split("\n").filter((l) => l.includes('PIREMOTE_TEST {"kind":"dump"')).pop();
      if (line) { console.log(line.slice(line.indexOf("{"))); process.exit(0); }
    }
    console.error("no dump"); process.exit(2);
  }
  case "press": {
    adb("logcat", "-c");
    adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", `'piremote://test/press?label=${encodeURIComponent(a)}'`);
    for (let i = 0; i < 15; i++) {
      await sleep(300);
      const line = adb("logcat", "-d", "-s", "ReactNativeJS:I").split("\n").filter((l) => l.includes('"kind":"press"')).pop();
      if (line) { const ok = line.includes('"ok":true'); console.log(ok ? `pressed ${a}` : `not registered: ${a}`); process.exit(ok ? 0 : 2); }
    }
    console.error("no press log"); process.exit(2);
  }
  case "labels": case "haslabel": case "waitlabel": {
    const until = Date.now() + Number(cmd === "waitlabel" ? (b ?? 20) : 0) * 1000;
    do {
      adb("logcat", "-c");
      adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", "'piremote://test/labels'");
      let labels;
      for (let i = 0; i < 15 && !labels; i++) {
        await sleep(300);
        const line = adb("logcat", "-d", "-s", "ReactNativeJS:I").split("\n").filter((l) => l.includes('"kind":"labels"')).pop();
        if (line) labels = JSON.parse(line.slice(line.indexOf("{"))).labels;
      }
      if (cmd === "labels") { console.log((labels ?? []).join("\n")); process.exit(0); }
      const hit = (labels ?? []).filter((l) => l === a || (a.endsWith("*") && l.startsWith(a.slice(0, -1))));
      if (hit.length) { console.log(hit.join("\n")); process.exit(0); }
      if (Date.now() < until) await sleep(700);
    } while (Date.now() < until);
    console.log("no"); process.exit(1);
  }
  case "key": adb("shell", "input", "keyevent", a); break;
  case "back": adb("shell", "input", "keyevent", "KEYCODE_BACK"); break;
  case "swipeup": adb("shell", "input", "swipe", "1150", "1200", "1150", "400", "300"); break;
  case "swipedown": adb("shell", "input", "swipe", "1150", "400", "1150", "1200", "300"); break;
  default: console.error("usage: wd dump|tap|taptext|has|text|wait|type|state|key|back|swipeup|swipedown"); process.exit(1);
}
