#!/usr/bin/env node
// startup-timing.mjs — MEASURE-1 runner: cold and hot packaged launches with
// PI_WEB_PERF=1, reading the `startup marks=` line the shell logs
// (desktop/main/startup-marks.ts) from the desktop main.log. Cold runs are
// spaced apart so the previous process is fully gone; hot runs relaunch
// immediately, with the OS page cache warm. OS caches cannot be dropped from
// user space, so "cold" is best-effort (fresh process, spaced) — note this
// when comparing numbers.
//
// Usage: node desktop/packaging/startup-timing.mjs --app "<.app path>" \
//          --label baseline [--cold 5] [--hot 5] --out startup-timing.json

import { spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function usage(message) {
  console.error(`${message}\nusage: startup-timing.mjs --app <path.app> --label <name> [--cold N] [--hot N] [--out file.json]`);
  process.exit(2);
}

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const appPath = arg("app");
const label = arg("label") ?? "unlabeled";
const coldRuns = Number(arg("cold") ?? 5);
const hotRuns = Number(arg("hot") ?? 5);
const outFile = arg("out") ?? "startup-timing.json";
if (!appPath) usage("--app is required");

const binary = join(appPath, "Contents", "MacOS", readdirSync(join(appPath, "Contents", "MacOS"))[0]);
const logPath = join(homedir(), "Library", "Logs", appPath.split("/").pop().replace(/\.app$/, ""), "main.log");

function readMarksLine() {
  try {
    const lines = readFileSync(logPath, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const at = lines[i].indexOf('marks="');
      if (at >= 0 && lines[i].includes(" startup ")) {
        const value = lines[i].slice(at + 'marks="'.length, lines[i].lastIndexOf('"'));
        return JSON.parse(JSON.parse(`"${value}"`));
      }
    }
  } catch {
    // no log yet
  }
  return null;
}

function countMarksLines() {
  try {
    return readFileSync(logPath, "utf8").split("\n").filter((l) => l.includes(" startup ") && l.includes("marks=")).length;
  } catch {
    return 0;
  }
}

async function runOnce() {
  const before = countMarksLines();
  const child = spawn(binary, [], { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, PI_WEB_PERF: "1" } });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let marks = null;
  for (let t = 0; t < 150; t++) {
    await new Promise((r) => setTimeout(r, 200));
    if (countMarksLines() > before) {
      marks = readMarksLine();
      break;
    }
  }
  child.kill("SIGTERM");
  const gone = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
  if (!gone) child.kill("SIGKILL");
  return marks;
}

function aggregate(runs) {
  const agg = {};
  for (const name of Object.keys(runs[0] ?? {})) {
    const values = runs.map((r) => r[name]).filter((v) => typeof v === "number").sort((a, b) => a - b);
    if (values.length === 0) continue;
    const at = (q) => values[Math.min(values.length - 1, Math.max(0, Math.round(q * (values.length - 1))))];
    agg[name] = { n: values.length, min: values[0], median: at(0.5), p95: at(0.95), max: values[values.length - 1] };
  }
  return agg;
}

const protocol = `cold=${coldRuns} (fresh process, 5 s apart), hot=${hotRuns} (immediate relaunch)`;
const result = { label, appPath, generatedAt: new Date().toISOString(), protocol, cold: { runs: [], agg: {} }, hot: { runs: [], agg: {} } };

for (let i = 0; i < coldRuns; i++) {
  const marks = await runOnce();
  if (marks) result.cold.runs.push(marks);
  else console.error(`cold run ${i + 1}: no marks line (is PI_WEB_PERF honored?)`);
  await new Promise((r) => setTimeout(r, 5000));
}
for (let i = 0; i < hotRuns; i++) {
  const marks = await runOnce();
  if (marks) result.hot.runs.push(marks);
  else console.error(`hot run ${i + 1}: no marks line`);
}
result.cold.agg = aggregate(result.cold.runs);
result.hot.agg = aggregate(result.hot.runs);

writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
const rows = Object.keys(result.cold.agg);
const line = (phase, name) => `  ${phase.padEnd(5)} ${name.padEnd(20)} p50 ${String(result[phase].agg[name]?.median ?? "-").padStart(7)}  p95 ${String(result[phase].agg[name]?.p95 ?? "-").padStart(7)}  max ${String(result[phase].agg[name]?.max ?? "-").padStart(7)}`;
console.log(`  label                   ${label}`);
console.log(`  app                     ${appPath}`);
console.log(`  protocol                ${protocol}`);
for (const name of rows) console.log(line("cold", name));
for (const name of rows) console.log(line("hot", name));
console.log(`  report: ${outFile}`);
