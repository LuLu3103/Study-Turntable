/*
 * Study Turntable — 浏览器端自动化验收（Edge headless + CDP）
 * 覆盖：初次加载、使用说明弹窗、抽签与学习计时、打卡、图表生成/收起、
 *      近 7 天 / 近 30 天统计、保存 PNG、休息跳过计时、历史日期只读、
 *      刷新后本地数据保留、移动端布局。
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

function clearDownloads(pattern) {
  fs.readdirSync(SHOTS)
    .filter((name) => pattern.test(name))
    .forEach((name) => fs.rmSync(path.join(SHOTS, name)));
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
      await applyViewport(Object.assign({}, original, { height: Math.ceil(scrollHeight) }));
      await sleep(350);
      const screenshot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(SHOTS, filename), Buffer.from(screenshot.data, "base64"));
      await applyViewport(original);
      await sleep(150);
    }

    console.log("\n[1] 初次加载");
    results.initial = await evaluate(`(() => {
      const wheel = document.getElementById('wheelCanvas');
      const links = Array.from(document.querySelectorAll('.top-link')).map((link) => ({
        tag: link.tagName,
        text: link.textContent.trim(),
        href: link.getAttribute('href'),
        target: link.getAttribute('target'),
        rel: link.getAttribute('rel')
      }));
      const tabs = Array.from(document.querySelectorAll('.range-tab')).map((tab) => ({
        range: tab.getAttribute('data-range'),
        active: tab.classList.contains('is-active'),
        selected: tab.getAttribute('aria-selected')
      }));
      return {
        title: document.title,
        wheelSegments: window.STCore.WHEEL.length,
        wheelPixels: wheel.width,
        tasks: document.querySelectorAll('.task-item').length,
        spinDisabled: document.getElementById('spinBtn').disabled,
        chartDisabled: document.getElementById('chartBtn').disabled,
        chartExpanded: document.getElementById('chartBtn').getAttribute('aria-expanded'),
        links,
        tabs,
        helpModalHidden: document.getElementById('helpModal').hidden,
        helpBtnTag: document.getElementById('helpBtn').tagName,
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
    check("顶栏共四个快捷入口", results.initial.links.length === 4, results.initial.links);
    check(
      "每日计划链接地址正确",
      results.initial.links[0] &&
        results.initial.links[0].href ===
          "https://toashore.cn/public/apps/calendar/online/index.html?qq_aio_chat_type=2",
      results.initial.links[0]
    );
    check(
      "口诀题库链接地址正确",
      results.initial.links[1] &&
        results.initial.links[1].href === "https://rray1228.github.io/neike-306-tiku/?view=mnemonics",
      results.initial.links[1]
    );
    check(
      "GitHub 仓库链接地址正确",
      results.initial.links[2] && results.initial.links[2].href === "https://github.com/LuLu3103/Study-Turntable",
      results.initial.links[2]
    );
    check(
      "外链在新窗口打开",
      results.initial.links
        .filter((link) => link.tag === "A")
        .every((link) => link.target === "_blank" && /noopener/.test(link.rel || "")),
      results.initial.links
    );
    check("使用说明是按钮而不是链接", results.initial.helpBtnTag === "BUTTON", results.initial.helpBtnTag);
    check("使用说明弹窗默认隐藏", results.initial.helpModalHidden === true);
    check(
      "统计范围有三个选项且默认今日",
      results.initial.tabs.length === 3 &&
        results.initial.tabs[0].range === "today" &&
        results.initial.tabs[0].active === true,
      results.initial.tabs
    );
    check("图表默认收起", results.initial.chartExpanded === "false");
    await capture("01-initial.png");

    console.log("[2] 使用说明弹窗");
    await evaluate("document.getElementById('helpBtn').click(); true");
    await sleep(400);
    results.help = await evaluate(`(() => {
      const modal = document.getElementById('helpModal');
      return {
        hidden: modal.hidden,
        title: document.getElementById('helpTitle').textContent,
        items: Array.from(modal.querySelectorAll('.help-list li b')).map((node) => node.textContent),
        bodyText: modal.textContent,
        dialog: modal.querySelector('[role="dialog"]') !== null,
        ariaModal: modal.querySelector('[role="dialog"]').getAttribute('aria-modal'),
        lock: document.body.classList.contains('is-modal-open')
      };
    })()`);
    check("点击使用说明后弹窗打开", results.help.hidden === false);
    check("弹窗标题正确", results.help.title === "使用说明", results.help.title);
    check("弹窗包含五条使用说明", results.help.items.length === 5, results.help.items);
    check("说明里包含跳过休息规则", results.help.bodyText.indexOf("跳过休息") !== -1);
    check("弹窗具备无障碍属性", results.help.dialog === true && results.help.ariaModal === "true");
    check("弹窗打开时锁定页面滚动", results.help.lock === true);
    await capture("02-help.png");
    await evaluate("document.getElementById('helpClose').click(); true");
    await sleep(300);
    results.helpClosed = await evaluate(`(() => ({
      hidden: document.getElementById('helpModal').hidden,
      lock: document.body.classList.contains('is-modal-open')
    }))()`);
    check("点击关闭按钮可关闭弹窗", results.helpClosed.hidden === true);
    check("关闭后恢复页面滚动", results.helpClosed.lock === false);
    await evaluate("document.getElementById('helpBtn').click(); true");
    await sleep(300);
    await evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true"
    );
    await sleep(300);
    const escClosed = await evaluate("document.getElementById('helpModal').hidden");
    check("按 Esc 可关闭弹窗", escClosed === true);

    console.log("[3] 抽签与学习计时（固定抽到 10min 学习）");
    await evaluate(`
      window.__origRandom = Math.random;
      Math.random = function () { return 0.02; };
      document.getElementById('spinBtn').click();
      true
    `);
    await sleep(5600);
    await evaluate("Math.random = window.__origRandom; true");
    results.afterSpin = await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      const records = (data.days[date] || { records: [] }).records;
      return {
        spinning: document.getElementById('wheelStage').classList.contains('is-spinning'),
        resultTime: document.getElementById('resultTime').textContent,
        resultType: document.getElementById('resultType').textContent,
        resultNote: document.getElementById('resultNote').textContent,
        tasks: document.querySelectorAll('.task-item').length,
        savedRecords: records.length,
        record: records[records.length - 1] || null,
        transform: document.getElementById('wheelCanvas').style.transform,
        spinDisabled: document.getElementById('spinBtn').disabled,
        spinText: document.getElementById('spinBtn').textContent,
        progressHidden: document.getElementById('resultProgress').hidden,
        againHidden: document.getElementById('resultAgain').hidden,
        againText: document.getElementById('resultAgain').textContent,
        wheelPill: document.getElementById('wheelModePill').textContent,
        taskPill: document.getElementById('taskViewPill').textContent,
        delDisabled: document.querySelector('.task-item .task-del').disabled,
        abandonPresent: document.body.textContent.indexOf('放弃本轮') !== -1,
        skipElement: document.getElementById('resultSkip') !== null
      };
    })()`);
    check("抽签结束", results.afterSpin.spinning === false);
    check("固定抽到学习 10min", results.afterSpin.resultTime === "10min" && results.afterSpin.resultType === "学习任务", {
      time: results.afterSpin.resultTime,
      type: results.afterSpin.resultType
    });
    check("任务栏新增 1 条记录", results.afterSpin.tasks === 1, results.afterSpin.tasks);
    check("本地存储已写入 1 条记录", results.afterSpin.savedRecords === 1, results.afterSpin.savedRecords);
    check("转盘已旋转", results.afterSpin.transform.indexOf("rotate") === 0, results.afterSpin.transform);
    check("学习任务计时中禁止再次抽取", results.afterSpin.spinDisabled === true);
    check("按钮显示剩余时间", /剩余\s*\d/.test(results.afterSpin.spinText), results.afterSpin.spinText);
    check("结果卡显示专注计时", /专注计时中/.test(results.afterSpin.resultNote), results.afterSpin.resultNote);
    check("结果卡显示进度条", results.afterSpin.progressHidden === false);
    check("计时中隐藏“再抽一次”", results.afterSpin.againHidden === true);
    check("转盘状态显示计时中", results.afterSpin.wheelPill === "计时中", results.afterSpin.wheelPill);
    check("任务栏状态显示计时中", results.afterSpin.taskPill === "计时中", results.afterSpin.taskPill);
    check("学习计时中不能删除该条记录", results.afterSpin.delDisabled === true);
    check("界面上不再有“放弃本轮”", results.afterSpin.abandonPresent === false);
    check("界面上不再有放弃按钮元素", results.afterSpin.skipElement === false);
    check(
      "冷却剩余时间与任务时长一致",
      Boolean(
        results.afterSpin.record &&
          results.afterSpin.record.type === "study" &&
          results.afterSpin.record.minutes === 10 &&
          Date.now() - results.afterSpin.record.createdAt < 10 * 60000
      ),
      results.afterSpin.record
    );
    await evaluate("document.getElementById('spinBtn').click(); true");
    await sleep(400);
    results.blockedSpin = await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      return {
        records: (data.days[date] || { records: [] }).records.length,
        tasks: document.querySelectorAll('.task-item').length
      };
    })()`);
    check("学习计时期间点击抽签不会新增记录", results.blockedSpin.records === 1, results.blockedSpin);
    await capture("03-after-spin.png");

    console.log("[4] 打卡完成");
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

    console.log("[5] 生成统计图表并收起");
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
        legend: document.getElementById('donutLegendStudy').textContent,
        buttonText: document.getElementById('chartBtn').textContent,
        expanded: document.getElementById('chartBtn').getAttribute('aria-expanded'),
        barTitle: document.getElementById('barChartTitle').textContent,
        hint: document.getElementById('chartHint').textContent
      };
    })()`);
    check("图表区域已展开", results.chart.visible === true);
    check("环形图已绘制", results.chart.donutWidth > 100 && results.chart.donutHeight > 100, results.chart);
    check("柱状图已绘制", results.chart.barsWidth > 200 && results.chart.barsHeight > 100, results.chart);
    check("可以保存图表", results.chart.saveDisabled === false);
    check("图表图例已更新", /min|h/.test(results.chart.legend), results.chart.legend);
    check("生成后按钮变为收起", results.chart.buttonText === "收起图表", results.chart.buttonText);
    check("aria-expanded 同步", results.chart.expanded === "true");
    check("今日图表标题为每次任务", results.chart.barTitle === "每次任务时长", results.chart.barTitle);
    check("图表说明包含平均值", /平均/.test(results.chart.hint), results.chart.hint);
    await capture("04-after-chart.png");

    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(450);
    results.collapsed = await evaluate(`(() => ({
      hidden: document.getElementById('chartArea').hidden,
      saveDisabled: document.getElementById('saveChartBtn').disabled,
      buttonText: document.getElementById('chartBtn').textContent,
      expanded: document.getElementById('chartBtn').getAttribute('aria-expanded')
    }))()`);
    check("图表可以收起", results.collapsed.hidden === true);
    check("收起后不能保存图表", results.collapsed.saveDisabled === true);
    check("收起后按钮恢复为生成", results.collapsed.buttonText === "生成统计图表", results.collapsed.buttonText);
    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(700);

    console.log("[6] 保存今日图表 PNG");
    clearDownloads(/^study-turntable-chart-.*\.png$/);
    await evaluate("document.getElementById('saveChartBtn').click(); true");
    await sleep(2500);
    results.chartDownload = fs
      .readdirSync(SHOTS)
      .filter((name) => /^study-turntable-chart-\d{8}\.png$/.test(name));
    check("今日图表 PNG 已下载", results.chartDownload.length === 1, results.chartDownload);
    if (results.chartDownload.length) {
      const size = fs.statSync(path.join(SHOTS, results.chartDownload[0])).size;
      check("图表 PNG 内容有效", size > 20000, size);
    }

    console.log("[7] 近 7 天 / 近 30 天统计");
    await evaluate("document.getElementById('rangeWeek').click(); true");
    await sleep(700);
    results.rangeWeek = await evaluate(`(() => ({
      activeRange: document.querySelector('.range-tab.is-active').getAttribute('data-range'),
      statsSub: document.getElementById('statsSub').textContent,
      statsNote: document.getElementById('statsNote').textContent,
      barTitle: document.getElementById('barChartTitle').textContent,
      chartVisible: !document.getElementById('chartArea').hidden,
      saveDisabled: document.getElementById('saveChartBtn').disabled
    }))()`);
    check("近 7 天标签已选中", results.rangeWeek.activeRange === "week", results.rangeWeek.activeRange);
    check("统计栏显示日期区间", /至/.test(results.rangeWeek.statsSub), results.rangeWeek.statsSub);
    check("统计栏说明包含记录天数", /有记录/.test(results.rangeWeek.statsNote), results.rangeWeek.statsNote);
    check("图表切换为每日统计", results.rangeWeek.barTitle === "每日学习 / 休息时长", results.rangeWeek.barTitle);
    check("切换范围后图表保持展开", results.rangeWeek.chartVisible === true);
    check("切换范围后可以保存", results.rangeWeek.saveDisabled === false);
    await capture("05-range-week.png");

    clearDownloads(/^study-turntable-chart-.*\.png$/);
    await evaluate("document.getElementById('saveChartBtn').click(); true");
    await sleep(2500);
    results.rangeDownload = fs
      .readdirSync(SHOTS)
      .filter((name) => /^study-turntable-chart-\d{8}-7d\.png$/.test(name));
    check("近 7 天图表 PNG 已下载", results.rangeDownload.length === 1, results.rangeDownload);

    await evaluate("document.getElementById('rangeMonth').click(); true");
    await sleep(700);
    results.rangeMonth = await evaluate(`(() => ({
      activeRange: document.querySelector('.range-tab.is-active').getAttribute('data-range'),
      statsSub: document.getElementById('statsSub').textContent,
      chartVisible: !document.getElementById('chartArea').hidden,
      barTitle: document.getElementById('barChartTitle').textContent
    }))()`);
    check("近 30 天标签已选中", results.rangeMonth.activeRange === "month", results.rangeMonth.activeRange);
    check("近 30 天说明正确", /近 30 天/.test(results.rangeMonth.statsSub), results.rangeMonth.statsSub);
    check("近 30 天图表仍可展开", results.rangeMonth.chartVisible === true);
    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(500);
    results.rangeCollapsed = await evaluate(
      "document.getElementById('chartArea').hidden && document.getElementById('chartBtn').textContent === '生成统计图表'"
    );
    check("统计图表可再次收起", results.rangeCollapsed === true);

    console.log("[8] 学习计时结束");
    await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      const records = (data.days[date] || { records: [] }).records;
      records.forEach((record) => {
        record.createdAt = Date.now() - record.minutes * 60000 - 5000;
      });
      localStorage.setItem('study-turntable:v1', JSON.stringify(data));
      return records.length;
    })()`);
    await send("Page.reload");
    await sleep(2000);
    results.cooldownOver = await evaluate(`(() => ({
      spinDisabled: document.getElementById('spinBtn').disabled,
      spinText: document.getElementById('spinBtn').textContent,
      progressHidden: document.getElementById('resultProgress').hidden,
      resultNote: document.getElementById('resultNote').textContent,
      wheelPill: document.getElementById('wheelModePill').textContent,
      delDisabled: document.querySelector('.task-item .task-del').disabled
    }))()`);
    check("学习计时结束后可以抽签", results.cooldownOver.spinDisabled === false);
    check("按钮恢复为抽取任务", results.cooldownOver.spinText === "抽取学习任务", results.cooldownOver.spinText);
    check("计时进度条已隐藏", results.cooldownOver.progressHidden === true);
    check("计时结束后可以删除任务记录", results.cooldownOver.delDisabled === false);
    check(
      "结果卡恢复为最近一次抽取",
      /最近一次/.test(results.cooldownOver.resultNote),
      results.cooldownOver.resultNote
    );

    console.log("[9] 抽到休息时可跳过计时");
    await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      const day = data.days[date] || { records: [] };
      day.records.push({
        id: 'rest-test',
        type: 'rest',
        minutes: 15,
        done: false,
        createdAt: Date.now()
      });
      data.days[date] = day;
      localStorage.setItem('study-turntable:v1', JSON.stringify(data));
      return day.records.length;
    })()`);
    await send("Page.reload");
    await sleep(2000);
    results.rest = await evaluate(`(() => ({
      spinDisabled: document.getElementById('spinBtn').disabled,
      resultType: document.getElementById('resultType').textContent,
      resultTime: document.getElementById('resultTime').textContent,
      resultNote: document.getElementById('resultNote').textContent,
      againHidden: document.getElementById('resultAgain').hidden,
      againText: document.getElementById('resultAgain').textContent,
      progressHidden: document.getElementById('resultProgress').hidden,
      wheelPill: document.getElementById('wheelModePill').textContent,
      taskPill: document.getElementById('taskViewPill').textContent,
      statRest: document.getElementById('statRest').textContent,
      tasks: document.querySelectorAll('.task-item').length
    }))()`);
    check("休息不计时锁定：仍可抽签", results.rest.spinDisabled === false);
    check("结果卡显示休息任务", results.rest.resultType === "休息任务" && results.rest.resultTime === "15min", results.rest);
    check("结果卡显示休息倒计时", /休息计时中/.test(results.rest.resultNote), results.rest.resultNote);
    check("按钮变为“跳过休息”", results.rest.againText === "跳过休息", results.rest.againText);
    check("可以点击跳过休息", results.rest.againHidden === false);
    check("休息进度条显示", results.rest.progressHidden === false);
    check("转盘状态显示休息中", results.rest.wheelPill === "休息中", results.rest.wheelPill);
    check("任务栏状态显示休息中", results.rest.taskPill === "休息中", results.rest.taskPill);
    check("休息时长已计入统计", results.rest.statRest === "15min", results.rest.statRest);
    await capture("06-rest-skip.png");

    results.beforeSkip = await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      return (data.days[date] || { records: [] }).records.length;
    })()`);
    await evaluate("document.getElementById('resultAgain').click(); true");
    await sleep(600);
    const skipping = await evaluate(
      "document.getElementById('spinBtn').textContent === '转盘转动中'"
    );
    check("跳过休息后立即开始下一轮抽签", skipping === true);
    await sleep(5400);
    results.afterSkip = await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      const date = document.getElementById('datePicker').value;
      const records = (data.days[date] || { records: [] }).records;
      return {
        records: records.length,
        tasks: document.querySelectorAll('.task-item').length,
        restStillThere: records.some((record) => record.id === 'rest-test')
      };
    })()`);
    check("跳过休息后新增一条记录", results.afterSkip.records === results.beforeSkip + 1, results.afterSkip);
    check("休息记录仍保留在任务栏", results.afterSkip.restStillThere === true);

    // 让所有记录都“过期”，方便后续只读与刷新检查
    await evaluate(`(() => {
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      Object.keys(data.days).forEach((date) => {
        data.days[date].records.forEach((record) => {
          record.createdAt = Date.now() - record.minutes * 60000 - 5000;
        });
      });
      localStorage.setItem('study-turntable:v1', JSON.stringify(data));
      return true;
    })()`);
    await send("Page.reload");
    await sleep(2000);

    console.log("[10] 查看往日数据（只读）");
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
      studyText: document.getElementById('statStudy').textContent,
      rangeTodayText: document.getElementById('rangeToday').textContent
    }))()`);
    check("历史日期禁止抽签", results.history.spinDisabled === true);
    check("历史日期显示只读标签", results.history.wheelPill.indexOf("只读") !== -1, results.history.wheelPill);
    check("历史日期任务列表为空", results.history.taskRows === 0, results.history.taskRows);
    check("历史日期隐藏旧图表", results.history.chartHidden === true);
    check("历史日期统计清零", results.history.studyText === "0min", results.history.studyText);
    check("历史日期“今日”显示为“当日”", results.history.rangeTodayText === "当日", results.history.rangeTodayText);
    await capture("07-history.png");

    console.log("[11] 回到今天");
    await evaluate("document.getElementById('todayBtn').click(); true");
    await sleep(500);
    results.backToday = await evaluate(`(() => ({
      spinDisabled: document.getElementById('spinBtn').disabled,
      tasks: document.querySelectorAll('.task-item').length
    }))()`);
    check("回到今天后可再次抽签", results.backToday.spinDisabled === false);
    check("今天的记录仍在", results.backToday.tasks === 3, results.backToday.tasks);

    console.log("[12] 导出数据");
    clearDownloads(/^study-turntable-data-.*\.json$/);
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
            (dateKey) => results.exportedData.days[dateKey].records.length === 3
          )
      ),
      results.exportedData && Object.keys(results.exportedData.days || {})
    );

    console.log("[13] 刷新后本地数据保留");
    await send("Page.reload");
    await sleep(2000);
    results.reload = await evaluate(`(() => {
      const date = document.getElementById('datePicker').value;
      const raw = localStorage.getItem('study-turntable:v1');
      const data = raw ? JSON.parse(raw) : { days: {} };
      return {
        tasks: document.querySelectorAll('.task-item').length,
        statStudy: document.getElementById('statStudy').textContent,
        statRest: document.getElementById('statRest').textContent,
        records: (data.days[date] || { records: [] }).records.length,
        doneRows: document.querySelectorAll('.task-item.is-done').length,
        resultHidden: document.getElementById('resultBody').hidden,
        resultNote: document.getElementById('resultNote').textContent,
        spinDisabled: document.getElementById('spinBtn').disabled
      };
    })()`);
    check("刷新后任务记录恢复", results.reload.tasks === 3, results.reload.tasks);
    check("刷新后本地存储仍有 3 条", results.reload.records === 3, results.reload.records);
    check("刷新后打卡状态保留", results.reload.doneRows === 1, results.reload.doneRows);
    check(
      "刷新后学习/休息时长恢复",
      results.reload.statStudy !== "0min" || results.reload.statRest !== "0min",
      results.reload
    );
    check(
      "刷新后结果卡显示最近一次抽取",
      results.reload.resultHidden === false && results.reload.resultNote.indexOf("最近一次") !== -1,
      results.reload
    );

    console.log("[14] 移动端布局");
    await applyViewport({ width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await send("Page.reload");
    await sleep(1800);
    results.mobile = await evaluate(`(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      return {
        width: window.innerWidth,
        horizontalOverflow: overflow,
        wheelWidth: document.getElementById('wheelCanvas').clientWidth,
        chartDisabled: document.getElementById('chartBtn').disabled,
        linkCount: document.querySelectorAll('.top-link').length,
        tabCount: document.querySelectorAll('.range-tab').length
      };
    })()`);
    check("移动端无横向溢出", results.mobile.horizontalOverflow === false, results.mobile);
    check("移动端转盘自适应", results.mobile.wheelWidth > 200, results.mobile.wheelWidth);
    check("移动端仍显示四个快捷入口", results.mobile.linkCount === 4, results.mobile.linkCount);
    check("移动端仍显示统计范围", results.mobile.tabCount === 3, results.mobile.tabCount);
    await capture("08-mobile.png");

    await evaluate("document.getElementById('chartBtn').click(); true");
    await sleep(900);
    await capture("09-mobile-chart.png");
    const mobileOverflow = await evaluate(
      "document.documentElement.scrollWidth > window.innerWidth + 1"
    );
    check("移动端图表展开后无横向溢出", mobileOverflow === false);

    console.log("[15] 页面错误日志");
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