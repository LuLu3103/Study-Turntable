/*
 * Study Turntable — 浏览器端自动化验收（Edge headless + CDP）
 * 覆盖：初次加载、抽签、打卡、生成图表、历史日期只读、刷新后本地数据保留、移动端布局。
 * 运行：node tests/screenshot.js（需要 Edge）
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ROOT = path.resolve(__dirname, "..");
const SHOTS = path.join(__dirname, "shots");
const PROFILE = path.join(os.tmpdir(), "study-turntable-edge-profile");
const PORT = 9333;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = {};
const failures = [];
const pageErrors = [];

function check(name, condition, detail) {
  if (condition) {
    console.log("  ✓ " + name);
  } else {
    failures.push(name + (detail ? " — " + JSON.stringify(detail) : ""));
    console.error("  ✗ " + name + (detail ? " — " + JSON.stringify(detail) : ""));
  }
}

function httpJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: "127.0.0.1", port: PORT, path: pathname, timeout: 2000 },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy(new Error("请求 DevTools 超时"));
    });
  });
}

async function waitForDevTools() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const version = await httpJson("/json/version");
      if (version && version.webSocketDebuggerUrl) {
        return version;
      }
    } catch (error) {
      // 浏览器尚未就绪，继续等待
    }
    await sleep(250);
  }
  throw new Error("DevTools 端点没有在预期时间内就绪");
}

function connect(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    const listeners = [];
    let nextId = 1;

    socket.onopen = () => {
      resolve({
        send(method, params) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand, method });
            socket.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        on(handler) {
          listeners.push(handler);
        },
        close() {
          socket.close();
        }
      });
    };
    socket.onerror = () => reject(new Error("无法连接 DevTools WebSocket"));
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(message.error.message + " (" + entry.method + ")"));
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      listeners.forEach((handler) => handler(message));
    };
  });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.rmSync(PROFILE, { recursive: true, force: true });

  const browser = spawn(
    EDGE,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--disable-extensions",
      "--disable-crash-reporter",
      "--disable-background-networking",
      "--no-sandbox",
      "--remote-debugging-port=" + PORT,
      "--user-data-dir=" + PROFILE,
      "--window-size=1440,1300",
      "--hide-scrollbars",
      "about:blank"
    ],
    { stdio: "ignore" }
  );

  let client = null;
  let viewport = { width: 1440, height: 1300, deviceScaleFactor: 1, mobile: false };

  try {
    await waitForDevTools();
    const targets = await httpJson("/json/list");
    const page = targets.find((target) => target.type === "page");
    if (!page) {
      throw new Error("没有找到可用的页面目标");
    }

    client = await connect(page.webSocketDebuggerUrl);
    const send = client.send;

    client.on((message) => {
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params.exceptionDetails;
        pageErrors.push("exception: " + (details.exception ? details.exception.description : details.text));
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
        pageErrors.push("console: " + message.params.args.map((arg) => arg.value || arg.description).join(" "));
      }
      if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
        pageErrors.push("log: " + message.params.entry.text);
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: SHOTS });
    await send("Emulation.setDeviceMetricsOverride", viewport);

    const pageUrl = "file:///" + encodeURI(path.join(ROOT, "index.html").replace(/\\/g, "/"));
    await send("Page.navigate", { url: pageUrl });
    await sleep(1800);

    async function evaluate(expression) {
      const response = await send("Runtime.evaluate", {
        expression: expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (response.exceptionDetails) {
        throw new Error(
          "页面脚本执行失败：" +
            (response.exceptionDetails.exception
              ? response.exceptionDetails.exception.description
              : response.exceptionDetails.text)
        );
      }
      return response.result.value;
    }

    async function applyViewport(next) {
      viewport = next;
      await send("Emulation.setDeviceMetricsOverride", viewport);
    }

    async function capture(filename) {
      const original = Object.assign({}, viewport);
      const scrollHeight = await evaluate("Math.max(document.documentElement.scrollHeight, 600)");
      await applyViewport(
        Object.assign({}, original, { height: Math.ceil(scrollHeight) })
      );
      await sleep(350);
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, filename), Buffer.from(screenshot.data, "base64"));
      await applyViewport(original);
      await sleep(150);
    }

    console.log("\n[1] 初次加载");
    results.initial = await evaluate(`(() => {
      const wheel = document.getElementById('wheelCanvas');
      return {
        title: document.title,
        wheelSegments: window.STCore.WHEEL.length,
        wheelPixels: wheel.width,
        tasks: document.querySelectorAll('.task-item').length,
        spinDisabled: document.getElementById('spinBtn').disabled,
        chartDisabled: document.getElementById('chartBtn').disabled,
        dateValue: document.getElementById('datePicker').value,
        localStorage: (() => {
          try {
            localStorage.setItem('__probe__', '1');
            localStorage.removeItem('__probe__');
            return 'available';
          } catch (error) {
            return 'blocked: ' + error.message;
          }
        })()
      };
    })()`);
    check("页面标题正确", results.initial.title === "Study Turntable · 学习转盘", results.initial.title);
    check("转盘渲染 30 份内容", results.initial.wheelSegments === 30, results.initial.wheelSegments);
    check("转盘画布已绘制", results.initial.wheelPixels > 300, results.initial.wheelPixels);
    check("初次加载可抽签", results.initial.spinDisabled === false);
    check("初次加载无数据时不能生成图表", results.initial.chartDisabled === true);
    check("本地存储可用", results.initial.localStorage === "available", results.initial.localStorage);
    await capture("01-initial.png");

    console.log("[2] 抽签");
    await evaluate("document.getElementById('spinBtn').click(); true");
    await sleep(5400);
    results.afterSpin = await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      return {
        spinning: document.getElementById('wheelStage').classList.contains('is-spinning'),
        resultTime: document.getElementById('resultTime').textContent,
        resultType: document.getElementById('resultType').textContent,
        tasks: document.querySelectorAll('.task-item').length,
        statStudy: document.getElementById('statStudy').textContent,
        statRest: document.getElementById('statRest').textContent,
        savedRecords: (data.days[date] || { records: [] }).records.length,
        transform: document.getElementById('wheelCanvas').style.transform
      };
    })()`);
    check("抽签结束", results.afterSpin.spinning === false);
    check("抽签结果已显示", /min/.test(results.afterSpin.resultTime), results.afterSpin.resultTime);
    check("任务栏新增 1 条记录", results.afterSpin.tasks === 1, results.afterSpin.tasks);
    check("本地存储已写入 1 条记录", results.afterSpin.savedRecords === 1, results.afterSpin.savedRecords);
    check("转盘已旋转", results.afterSpin.transform.indexOf("rotate") === 0, results.afterSpin.transform);
    await capture("02-after-spin.png");

    console.log("[3] 打卡完成");
    await evaluate("document.querySelector('.task-check').click(); true");
    await sleep(450);
    results.afterDone = await evaluate(`(() => ({
      doneRows: document.querySelectorAll('.task-item.is-done').length,
      statDone: document.getElementById('statDone').textContent,
      pressed: document.querySelector('.task-check').getAttribute('aria-pressed'),
      footHint: document.getElementById('taskFootHint').textContent
    }))()`);
    check("任务已标记完成", results.afterDone.doneRows === 1, results.afterDone.doneRows);
    check("完成数统计为 1", results.afterDone.statDone.indexOf("1") === 0, results.afterDone.statDone);
    check("无障碍状态同步", results.afterDone.pressed === "true", results.afterDone.pressed);

    console.log("[4] 生成统计图表");
    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(900);
    results.chart = await evaluate(`(() => {
      const donut = document.getElementById('donutChart');
      const bars = document.getElementById('barChart');
      return {
        visible: !document.getElementById('chartArea').hidden,
        donutWidth: donut.width,
        donutHeight: donut.height,
        barsWidth: bars.width,
        barsHeight: bars.height,
        saveDisabled: document.getElementById('saveChartBtn').disabled,
        legend: document.getElementById('donutLegendStudy').textContent
      };
    })()`);
    check("图表区域已展开", results.chart.visible === true);
    check("环形图已绘制", results.chart.donutWidth > 100 && results.chart.donutHeight > 100, results.chart);
    check("柱状图已绘制", results.chart.barsWidth > 200 && results.chart.barsHeight > 100, results.chart);
    check("可以保存图表", results.chart.saveDisabled === false);
    check("图表图例已更新", /min/.test(results.chart.legend), results.chart.legend);
    await capture("03-after-chart.png");

    console.log("[5] 保存图表 PNG");
    fs.readdirSync(SHOTS)
      .filter((name) => /^study-turntable-chart-.*\.png$/.test(name))
      .forEach((name) => fs.rmSync(path.join(SHOTS, name)));
    await evaluate("document.getElementById('saveChartBtn').click(); true");
    await sleep(2500);
    results.chartDownload = fs
      .readdirSync(SHOTS)
      .filter((name) => /^study-turntable-chart-.*\.png$/.test(name));
    check(
      "图表 PNG 已下载",
      results.chartDownload.length === 1,
      results.chartDownload
    );

    console.log("[6] 查看往日数据（只读）");
    results.historyDate = await evaluate(`(() => {
      const picker = document.getElementById('datePicker');
      const parts = picker.max.split('-').map(Number);
      const yesterday = new Date(parts[0], parts[1] - 1, parts[2] - 1);
      const pad = (value) => String(value).padStart(2, '0');
      const value = yesterday.getFullYear() + '-' + pad(yesterday.getMonth() + 1) + '-' + pad(yesterday.getDate());
      picker.value = value;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
      return value;
    })()`);
    await sleep(600);
    results.history = await evaluate(`(() => ({
      spinDisabled: document.getElementById('spinBtn').disabled,
      wheelPill: document.getElementById('wheelModePill').textContent,
      taskPill: document.getElementById('taskViewPill').textContent,
      viewMeta: document.getElementById('viewMeta').textContent,
      taskRows: document.querySelectorAll('.task-item').length,
      chartHidden: document.getElementById('chartArea').hidden,
      saveDisabled: document.getElementById('saveChartBtn').disabled,
      studyText: document.getElementById('statStudy').textContent
    }))()`);
    check("历史日期禁止抽签", results.history.spinDisabled === true);
    check("历史日期显示只读标签", results.history.wheelPill.indexOf("只读") !== -1, results.history.wheelPill);
    check("历史日期任务列表为空", results.history.taskRows === 0, results.history.taskRows);
    check("历史日期隐藏旧图表", results.history.chartHidden === true);
    check("历史日期统计清零", results.history.studyText === "0min", results.history.studyText);
    await capture("04-history.png");

    console.log("[7] 回到今天");
    await evaluate("document.getElementById('todayBtn').click(); true");
    await sleep(500);
    results.backToday = await evaluate(`(() => ({
      spinDisabled: document.getElementById('spinBtn').disabled,
      tasks: document.querySelectorAll('.task-item').length,
      resultTime: document.getElementById('resultTime').textContent
    }))()`);
    check("回到今天后可再次抽签", results.backToday.spinDisabled === false);
    check("今天的记录仍在", results.backToday.tasks === 1, results.backToday.tasks);

    console.log("[8] 导出数据");
    fs.readdirSync(SHOTS)
      .filter((name) => /^study-turntable-data-.*\.json$/.test(name))
      .forEach((name) => fs.rmSync(path.join(SHOTS, name)));
    await evaluate("document.getElementById('exportBtn').click(); true");
    await sleep(1500);
    results.dataDownload = fs
      .readdirSync(SHOTS)
      .filter((name) => /^study-turntable-data-.*\.json$/.test(name));
    check("数据 JSON 已导出", results.dataDownload.length === 1, results.dataDownload);
    results.exportedData = results.dataDownload.length
      ? JSON.parse(fs.readFileSync(path.join(SHOTS, results.dataDownload[0]), "utf8"))
      : null;
    check(
      "导出文件包含当日记录",
      Boolean(
        results.exportedData &&
          results.exportedData.days &&
          Object.keys(results.exportedData.days).some(
            (dateKey) => results.exportedData.days[dateKey].records.length === 1
          )
      ),
      results.exportedData && Object.keys(results.exportedData.days || {})
    );

    console.log("[9] 刷新后本地数据保留");
    await send("Page.reload");
    await sleep(2000);
    results.reload = await evaluate(`(() => {
      const date = document.getElementById('datePicker').value;
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      return {
        tasks: document.querySelectorAll('.task-item').length,
        statStudy: document.getElementById('statStudy').textContent,
        records: (data.days[date] || { records: [] }).records.length,
        doneRows: document.querySelectorAll('.task-item.is-done').length,
        resultHidden: document.getElementById('resultBody').hidden,
        resultNote: document.getElementById('resultNote').textContent
      };
    })()`);
    check("刷新后任务记录恢复", results.reload.tasks === 1, results.reload.tasks);
    check("刷新后本地存储仍有 1 条", results.reload.records === 1, results.reload.records);
    check("刷新后打卡状态保留", results.reload.doneRows === 1, results.reload.doneRows);
    check("刷新后学习时长恢复", results.reload.statStudy !== "0min", results.reload.statStudy);
    check(
      "刷新后结果卡显示最近一次抽取",
      results.reload.resultHidden === false && results.reload.resultNote.indexOf("最近一次") !== -1,
      results.reload
    );

    console.log("[10] 移动端布局");
    await applyViewport({
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await send("Page.reload");
    await sleep(1800);
    results.mobile = await evaluate(`(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return {
        width: window.innerWidth,
        horizontalOverflow: overflow,
        wheelWidth: document.getElementById('wheelCanvas').clientWidth,
        chartDisabled: document.getElementById('chartBtn').disabled
      };
    })()`);
    check("移动端无横向溢出", results.mobile.horizontalOverflow === false, results.mobile);
    check("移动端转盘自适应", results.mobile.wheelWidth > 200, results.mobile.wheelWidth);
    await capture("05-mobile.png");

    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(900);
    await capture("06-mobile-chart.png");

    console.log("[11] 页面错误日志");
    check("页面无 JS 报错", pageErrors.length === 0, pageErrors.slice(0, 5));

    results.pageErrors = pageErrors;
    fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2));
  } finally {
    if (client) {
      try {
        client.close();
      } catch (error) {
        /* 忽略关闭异常 */
      }
    }
    browser.kill();
    await sleep(800);
    try {
      fs.rmSync(PROFILE, { recursive: true, force: true });
    } catch (error) {
      /* 临时目录可能被占用，忽略 */
    }
  }

  console.log("\n截图目录：" + SHOTS);
  if (failures.length) {
    console.error("\n" + failures.length + " 项检查未通过：\n- " + failures.join("\n- "));
    process.exitCode = 1;
  } else {
    console.log("全部浏览器验收检查通过 ✓");
  }
}

main().catch((error) => {
  console.error("自动化验收失败：", error);
  process.exitCode = 1;
});