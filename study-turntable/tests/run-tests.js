/*
 * Study Turntable — 核心逻辑单元测试
 * 运行方式：node tests/run-tests.js
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const C = require("../js/core.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("  ✓ " + name);
  } catch (error) {
    console.error("  ✗ " + name);
    throw error;
  }
}

console.log("Study Turntable core tests\n");

test("转盘共 30 份：25 份学习 + 5 份休息", () => {
  assert.strictEqual(C.WHEEL.length, 30);
  const study = C.WHEEL.filter((segment) => segment.type === "study");
  const rest = C.WHEEL.filter((segment) => segment.type === "rest");
  assert.strictEqual(study.length, 25);
  assert.strictEqual(rest.length, 5);
  const studyMinutes = study.map((segment) => segment.minutes);
  assert.strictEqual(Math.min(...studyMinutes), 10);
  assert.strictEqual(Math.max(...studyMinutes), 120);
  assert.deepStrictEqual(
    rest.map((segment) => segment.minutes).sort((a, b) => a - b),
    [5, 10, 15, 20, 30]
  );
});

test("学习时长全部在 10min – 2h 之间且为 5 的倍数", () => {
  C.WHEEL.filter((segment) => segment.type === "study").forEach((segment) => {
    assert.ok(segment.minutes >= 10 && segment.minutes <= 120);
    assert.strictEqual(segment.minutes % 5, 0);
  });
});

test("休息时长只包含 5/10/15/20/30min", () => {
  const allowed = new Set([5, 10, 15, 20, 30]);
  C.WHEEL.filter((segment) => segment.type === "rest").forEach((segment) => {
    assert.ok(allowed.has(segment.minutes));
  });
});

test("每个扇区都有颜色与文本", () => {
  C.WHEEL.forEach((segment) => {
    assert.ok(segment.label && segment.label.length > 0);
    assert.match(segment.color, /^#[0-9a-f]{6}$/i);
    assert.match(segment.textColor, /^#[0-9a-f]{6}$/i);
  });
});

test("每个扇区中心都恰好停在指针下（30 个扇区）", () => {
  for (let index = 0; index < 30; index += 1) {
    const finalRotation = C.planSpin(0, index, 30, 5) % 360;
    assert.strictEqual(C.indexAtPointer(finalRotation, 30), index);
  }
});

test("带抖动的落点仍落在目标扇区内", () => {
  for (let index = 0; index < 30; index += 1) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const rotation = C.rotationForIndex(index, 30, 3);
      assert.strictEqual(C.indexAtPointer(rotation, 30), index);
    }
  }
});

test("连续旋转 300 次后指针结果始终正确", () => {
  let rotation = 0;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const index = Math.floor(Math.random() * 30);
    rotation = C.planSpin(rotation, index, 30, 5);
    assert.strictEqual(C.indexAtPointer(rotation, 30), index);
    rotation = ((rotation % 360) + 360) % 360;
  }
});

test("旋转总角度至少转满 5 圈", () => {
  const total = C.planSpin(0, 7, 30, 5);
  assert.ok(total >= 5 * 360);
});

test("日期工具使用本地时区并正确处理跨月/闰年", () => {
  assert.strictEqual(C.toDateString(new Date(2026, 9, 28)), "2026-10-28");
  assert.strictEqual(C.toDateString(new Date(2026, 0, 5)), "2026-01-05");
  assert.strictEqual(C.shiftDate("2026-03-01", -1), "2026-02-28");
  assert.strictEqual(C.shiftDate("2024-02-28", 1), "2024-02-29");
  assert.strictEqual(C.shiftDate("2024-12-31", 1), "2025-01-01");
  assert.strictEqual(C.parseDateString("2026-02-30"), null);
  assert.strictEqual(C.parseDateString("2026/10/28"), null);
  assert.strictEqual(C.weekdayName("2026-10-28"), "星期三");
  assert.strictEqual(C.formatDateLabel("2026-10-28"), "2026 年 10 月 28 日");
  assert.strictEqual(C.formatClock(new Date(2026, 9, 28, 9, 5, 3)), "09:05:03");
});

test("时长格式化", () => {
  assert.strictEqual(C.formatDuration(0), "0min");
  assert.strictEqual(C.formatDuration(45), "45min");
  assert.strictEqual(C.formatDuration(60), "1h");
  assert.strictEqual(C.formatDuration(90), "1h 30min");
  assert.strictEqual(C.formatDuration(120), "2h");
});

test("统计汇总学习/休息/完成数量", () => {
  const summary = C.summarize([
    { type: "study", minutes: 45, done: true },
    { type: "study", minutes: 30, done: false },
    { type: "rest", minutes: 10, done: true },
    { type: "study", minutes: 120, done: true },
    { type: "rest", minutes: 5, done: false }
  ]);
  assert.strictEqual(summary.study, 195);
  assert.strictEqual(summary.rest, 15);
  assert.strictEqual(summary.total, 210);
  assert.strictEqual(summary.studyCount, 3);
  assert.strictEqual(summary.restCount, 2);
  assert.strictEqual(summary.count, 5);
  assert.strictEqual(summary.done, 3);
  assert.strictEqual(summary.pending, 2);
});

test("统计空数据与非法数据", () => {
  const empty = C.summarize([]);
  assert.deepStrictEqual(
    {
      study: empty.study,
      rest: empty.rest,
      total: empty.total,
      done: empty.done,
      pending: empty.pending,
      count: empty.count
    },
    { study: 0, rest: 0, total: 0, done: 0, pending: 0, count: 0 }
  );
  const withBad = C.summarize([
    null,
    { type: "unknown", minutes: 30, done: true },
    { type: "study", minutes: 20, done: true }
  ]);
  assert.strictEqual(withBad.study, 20);
  assert.strictEqual(withBad.count, 1);
});

test("页面 id 不重复，app.js 引用的元素都存在", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.deepStrictEqual(duplicates, []);

  const appSource = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const cacheBlock = appSource.match(/\[\s*"clock"[\s\S]*?\]\.forEach/);
  assert.ok(cacheBlock, "没有找到 app.js 的元素缓存列表");
  const referenced = [...cacheBlock[0].matchAll(/"([A-Za-z][\w-]*)"/g)].map((match) => match[1]);
  const missing = referenced.filter((id) => !ids.includes(id));
  assert.deepStrictEqual(missing, []);
});

test("脚本加载顺序：core → wheel → charts → app", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const order = [
    /<script src="js\/core\.js"><\/script>/,
    /<script src="js\/wheel\.js"><\/script>/,
    /<script src="js\/charts\.js"><\/script>/,
    /<script src="js\/app\.js"><\/script>/
  ].map((pattern) => html.search(pattern));
  assert.ok(order.every((index) => index >= 0), "存在未引入的脚本");
  assert.deepStrictEqual(order, order.slice().sort((a, b) => a - b));
});

console.log("\n" + passed + " tests passed ✓");