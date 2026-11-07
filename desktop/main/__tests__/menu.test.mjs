import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMenuTemplate,
  installApplicationMenu,
  materializeMenu,
} from "../menu.ts";

function flatten(items) {
  const out = [];
  for (const item of items) {
    out.push(item);
    if (item.submenu) out.push(...flatten(item.submenu));
  }
  return out;
}

const actions = () => ({
  "retry-backend": () => undefined,
  "open-logs": () => undefined,
  reload: () => undefined,
});

test("the macOS menu is role-driven with fixed actions and an optional Reload", () => {
  const packaged = flatten(buildMenuTemplate({ appName: "Pi Web", isMac: true, devTools: false }));
  assert.equal(packaged.some((item) => item.role === "quit"), true);
  assert.equal(packaged.some((item) => item.role === "copy"), true);
  assert.equal(packaged.some((item) => item.action === "retry-backend"), true);
  assert.equal(packaged.some((item) => item.action === "open-logs"), true);
  assert.equal(packaged.some((item) => item.action === "reload"), false);

  const dev = flatten(buildMenuTemplate({ appName: "Pi Web", isMac: true, devTools: true }));
  const reload = dev.find((item) => item.action === "reload");
  assert.equal(reload.accelerator, "CmdOrCtrl+R");
});

test("non-mac menus keep File/Edit/View/Window and never add renderer commands", () => {
  const template = buildMenuTemplate({ appName: "Pi Web", isMac: false, devTools: true });
  assert.deepEqual(template.map((item) => item.label), ["File", "Edit", "View", "Window"]);
  const all = flatten(template);
  assert.equal(all.every((item) => item.click === undefined), true);
  assert.equal(all.filter((item) => item.action === "retry-backend").length, 1);
});

test("materializeMenu binds every action recursively and maps to its callback", () => {
  const calls = [];
  const template = [
    { label: "Root", submenu: [{ label: "Retry", action: "retry-backend" }, { role: "copy" }] },
    { label: "Logs", action: "open-logs" },
  ];
  const materialized = materializeMenu(template, {
    "retry-backend": () => calls.push("retry"),
    "open-logs": () => calls.push("logs"),
    reload: () => calls.push("reload"),
  });
  materialized[0].submenu[0].click();
  materialized[1].click();
  assert.deepEqual(calls, ["retry", "logs"]);
  assert.equal(materialized[0].submenu[1].click, undefined);
  assert.equal(template[0].submenu[0].click, undefined);
});

test("installApplicationMenu builds the template and installs exactly one menu", () => {
  const installed = [];
  const templates = [];
  installApplicationMenu({
    Menu: {
      buildFromTemplate: (template) => {
        templates.push(template);
        return { items: template.length };
      },
      setApplicationMenu: (menu) => installed.push(menu),
    },
    appName: "Pi Web",
    isMac: true,
    devTools: true,
    actions: actions(),
  });
  assert.equal(templates.length, 1);
  assert.deepEqual(installed, [{ items: templates[0].length }]);
});
