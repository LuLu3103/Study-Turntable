/*
 * Study Turntable — 应用主逻辑
 * 负责：本地数据、日期切换、抽签、任务栏、统计栏、导入导出。
 */
(function () {
  "use strict";

  var C = window.STCore;
  var STCharts = window.STCharts;

  var STORAGE_KEY = "study-turntable:v1";
  var DATA_VERSION = 1;

  var state = {
    data: { version: DATA_VERSION, days: {} },
    viewDate: C.todayString(),
    wheel: null,
    spinning: false,
    resultRecord: null,
    chartGenerated: false,
    storageAvailable: true,
    clockTimer: null,
    toastTimer: null,
    resizeTimer: null
  };

  var el = {};

  /* ------------------------------------------------------------------ *
   * 本地存储
   * ------------------------------------------------------------------ */
  function emptyData() {
    return { version: DATA_VERSION, days: {} };
  }

  function checkStorage() {
    try {
      var probe = "__study_turntable_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      state.storageAvailable = true;
    } catch (error) {
      state.storageAvailable = false;
    }
  }

  function isValidRecord(record) {
    return Boolean(
      record &&
        typeof record.id === "string" &&
        (record.type === "study" || record.type === "rest") &&
        typeof record.minutes === "number" &&
        isFinite(record.minutes) &&
        record.minutes > 0 &&
        record.minutes <= 240
    );
  }

  function normalizeRecord(record) {
    return {
      id: String(record.id),
      type: record.type === "rest" ? "rest" : "study",
      minutes: Math.round(record.minutes),
      done: record.done === true,
      createdAt:
        typeof record.createdAt === "number" && isFinite(record.createdAt)
          ? record.createdAt
          : Date.now()
    };
  }

  function byCreatedAtAsc(a, b) {
    return a.createdAt - b.createdAt;
  }

  function loadData() {
    var data = emptyData();
    if (!state.storageAvailable) {
      return data;
    }
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return data;
      }
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.days || typeof parsed.days !== "object") {
        return data;
      }
      Object.keys(parsed.days).forEach(function (dateKey) {
        var date = C.parseDateString(dateKey);
        if (!date) {
          return;
        }
        var day = parsed.days[dateKey];
        if (!day || !Array.isArray(day.records)) {
          return;
        }
        var records = day.records
          .filter(isValidRecord)
          .map(normalizeRecord)
          .sort(byCreatedAtAsc);
        if (records.length) {
          data.days[C.toDateString(date)] = { records: records };
        }
      });
    } catch (error) {
      console.warn("[Study Turntable] 读取本地数据失败：", error);
    }
    return data;
  }

  function persist() {
    if (!state.storageAvailable) {
      updateStorageNote();
      return;
    }
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: DATA_VERSION, updatedAt: Date.now(), days: state.data.days })
      );
    } catch (error) {
      state.storageAvailable = false;
      console.warn("[Study Turntable] 保存本地数据失败：", error);
      toast("本地存储不可用，当前数据不会被保存", true);
    }
    updateStorageNote();
  }

  function updateStorageNote() {
    var dayCount = Object.keys(state.data.days).filter(function (key) {
      return state.data.days[key] && state.data.days[key].records.length > 0;
    }).length;

    if (state.storageAvailable) {
      el.storagePill.classList.remove("is-error");
      el.storagePill.textContent = "本地已保存";
      el.storagePill.title = "数据保存在本机浏览器 · 已记录 " + dayCount + " 天";
      el.footerNote.textContent = "数据仅保存在本机浏览器 · 已记录 " + dayCount + " 天";
    } else {
      el.storagePill.classList.add("is-error");
      el.storagePill.textContent = "未保存";
      el.storagePill.title = "浏览器禁用了本地存储，关闭页面后数据会丢失";
      el.footerNote.textContent = "浏览器禁用了本地存储，数据仅在当前页面内有效";
    }
  }

  /* ------------------------------------------------------------------ *
   * 数据访问
   * ------------------------------------------------------------------ */
  function isToday() {
    return state.viewDate === C.todayString();
  }

  function recordsFor(dateString) {
    var day = state.data.days[dateString];
    return day && Array.isArray(day.records) ? day.records : [];
  }

  function latestRecordForView() {
    if (!isToday()) {
      return null;
    }
    var records = recordsFor(state.viewDate);
    return records.length ? records[records.length - 1] : null;
  }

  function ensureDay(dateString) {
    if (!state.data.days[dateString] || !Array.isArray(state.data.days[dateString].records)) {
      state.data.days[dateString] = { records: [] };
    }
    return state.data.days[dateString];
  }

  function addRecord(type, minutes, dateString) {
    var targetDate = dateString || state.viewDate;
    var day = ensureDay(targetDate);
    var record = {
      id: "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      type: type === "rest" ? "rest" : "study",
      minutes: Math.round(minutes),
      done: false,
      createdAt: Date.now()
    };
    day.records.push(record);
    persist();
    return record;
  }

  function toggleDone(recordId) {
    var records = recordsFor(state.viewDate);
    for (var i = 0; i < records.length; i++) {
      if (records[i].id === recordId) {
        records[i].done = !records[i].done;
        if (state.resultRecord && state.resultRecord.id === recordId) {
          state.resultRecord = records[i];
        }
        persist();
        renderResult();
        renderTasks();
        renderStats();
        toast(records[i].done ? "已完成这份任务，继续保持" : "已取消完成标记");
        return;
      }
    }
  }

  function removeRecord(recordId) {
    var day = state.data.days[state.viewDate];
    if (!day) {
      return;
    }
    var before = day.records.length;
    day.records = day.records.filter(function (record) {
      return record.id !== recordId;
    });
    if (day.records.length === before) {
      return;
    }
    if (day.records.length === 0) {
      delete state.data.days[state.viewDate];
    }
    if (state.resultRecord && state.resultRecord.id === recordId) {
      state.resultRecord = null;
    }
    persist();
    renderResult();
    renderTasks();
    renderStats();
    toast("已删除这条任务");
  }

  function clearDay() {
    var records = recordsFor(state.viewDate);
    if (!records.length) {
      return;
    }
    var ok = window.confirm(
      "确定清空 " + C.formatDateLabel(state.viewDate) + " 的 " + records.length + " 条任务记录吗？此操作不可撤销。"
    );
    if (!ok) {
      return;
    }
    delete state.data.days[state.viewDate];
    state.resultRecord = null;
    persist();
    renderAll();
    toast("当日记录已清空");
  }

  function resetAll() {
    var ok = window.confirm("确定清空所有日期的数据吗？此操作不可撤销，建议先导出备份。");
    if (!ok) {
      return;
    }
    state.data = emptyData();
    state.resultRecord = null;
    state.chartGenerated = false;
    persist();
    renderAll();
    toast("全部数据已清空");
  }

  /* ------------------------------------------------------------------ *
   * 渲染：顶栏 / 转盘状态
   * ------------------------------------------------------------------ */
  function renderHeader() {
    var today = C.todayString();
    el.datePicker.value = state.viewDate;
    el.datePicker.max = today;
    el.prevDay.disabled = state.viewDate <= "2000-01-01";
    el.nextDay.disabled = state.viewDate >= today;
    el.todayBtn.disabled = isToday();

    el.viewMeta.textContent = isToday() ? "今天" : "历史数据 · 只读";
    el.viewMeta.classList.toggle("is-history", !isToday());
  }

  function renderWheelMode() {
    var locked = !isToday();
    el.spinBtn.disabled = locked || state.spinning;
    el.hubSpin.disabled = locked || state.spinning;
    el.spinBtn.classList.toggle("is-loading", state.spinning);
    if (state.spinning) {
      el.spinBtn.textContent = "转盘转动中";
    } else {
      el.spinBtn.textContent = locked ? "历史日期为只读" : "抽取学习任务";
    }
    el.wheelModePill.textContent = locked ? "历史 · 只读" : "今天";
    el.wheelModePill.classList.toggle("pill--history", locked);
  }

  function renderResult() {
    el.resultCard.classList.toggle("is-spinning", state.spinning);

    if (state.spinning) {
      el.resultEmpty.hidden = false;
      el.resultBody.hidden = true;
      el.resultEmptyText.textContent = "转盘转动中，愿你抽到刚刚好的时长…";
      return;
    }

    if (!isToday()) {
      el.resultEmpty.hidden = false;
      el.resultBody.hidden = true;
      el.resultEmptyText.textContent = "历史日期仅支持查看和统计，不能抽签";
      return;
    }

    var record = state.resultRecord || latestRecordForView();
    if (!record) {
      el.resultEmpty.hidden = false;
      el.resultBody.hidden = true;
      el.resultEmptyText.textContent = "点击下方按钮，抽出今天的任务吧";
      return;
    }

    var isRest = record.type === "rest";
    var isLatestOnly = !state.resultRecord;
    el.resultEmpty.hidden = true;
    el.resultBody.hidden = false;
    el.resultType.textContent = isRest ? "休息任务" : "学习任务";
    el.resultType.classList.toggle("is-rest", isRest);
    el.resultTime.textContent = C.formatDuration(record.minutes);
    if (isLatestOnly) {
      el.resultNote.textContent = record.done
        ? "当日最近一次抽取 · 已完成"
        : "当日最近一次抽取 · 待完成";
    } else {
      el.resultNote.textContent = record.done
        ? "已打卡：这份任务完成了"
        : "已加入今日任务，完成后记得打卡";
    }
    el.resultDone.textContent = record.done ? "取消完成" : "标记完成";
    el.resultDone.classList.toggle("is-done", record.done);
  }

  /* ------------------------------------------------------------------ *
   * 渲染：任务栏
   * ------------------------------------------------------------------ */
  function buildTaskRow(record, locked) {
    var item = document.createElement("li");
    item.className = "task-item" + (record.done ? " is-done" : "");
    item.dataset.id = record.id;

    var check = document.createElement("button");
    check.type = "button";
    check.className = "task-check";
    check.setAttribute("aria-label", record.done ? "取消完成" : "标记完成");
    check.setAttribute("aria-pressed", record.done ? "true" : "false");
    check.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" ' +
      'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
    if (locked) {
      check.disabled = true;
      check.title = "历史数据只读";
    } else {
      check.addEventListener("click", function () {
        toggleDone(record.id);
      });
    }

    var info = document.createElement("div");
    info.className = "task-info";

    var type = document.createElement("span");
    type.className = "task-type" + (record.type === "rest" ? " is-rest" : "");
    type.textContent = record.type === "rest" ? "休息" : "学习";

    var minutes = document.createElement("strong");
    minutes.className = "task-min";
    minutes.textContent = C.formatDuration(record.minutes);

    var time = document.createElement("span");
    time.className = "task-time";
    time.textContent = C.formatTimeOfDay(record.createdAt);

    info.appendChild(type);
    info.appendChild(minutes);
    info.appendChild(time);

    item.appendChild(check);
    item.appendChild(info);

    if (!locked) {
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "task-del";
      remove.title = "删除这条任务";
      remove.setAttribute("aria-label", "删除这条任务");
      remove.textContent = "×";
      remove.addEventListener("click", function () {
        removeRecord(record.id);
      });
      item.appendChild(remove);
    }

    return item;
  }

  function renderTasks() {
    var records = recordsFor(state.viewDate)
      .slice()
      .sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
    var summary = C.summarize(records);
    var locked = !isToday();

    el.taskList.innerHTML = "";
    records.forEach(function (record) {
      el.taskList.appendChild(buildTaskRow(record, locked));
    });

    el.taskEmpty.hidden = records.length > 0;
    el.taskEmptyText.textContent = locked
      ? "该日期没有保存任何任务记录"
      : "还没有任务，转动转盘开始今天的学习吧";

    el.taskSub.textContent =
      (locked ? "该日" : "今天") + " · 共 " + records.length + " 条记录";
    el.taskViewPill.textContent = locked ? "历史 · 只读" : "今天";
    el.taskViewPill.classList.toggle("pill--history", locked);
    el.taskViewPill.classList.toggle("pill--muted", !locked);

    el.taskFootHint.textContent = locked
      ? "历史数据 · 只读查看"
      : "已完成 " + summary.done + " 项 · 待完成 " + summary.pending + " 项";
    el.clearDayBtn.disabled = locked || records.length === 0;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：统计栏与图表
   * ------------------------------------------------------------------ */
  function renderStats() {
    var records = recordsFor(state.viewDate);
    var summary = C.summarize(records);
    var locked = !isToday();

    el.statsSub.textContent = C.formatDateLabel(state.viewDate) + (locked ? " · 历史数据" : " · 今日累计");
    el.statsPill.textContent = locked ? "历史 · 只读" : "今天";
    el.statsPill.classList.toggle("pill--history", locked);

    el.statStudy.textContent = C.formatDuration(summary.study);
    el.statStudySub.textContent = "共 " + summary.studyCount + " 次学习";

    el.statRest.textContent = C.formatDuration(summary.rest);
    el.statRestSub.textContent = "共 " + summary.restCount + " 次休息";

    el.statDone.innerHTML = summary.done + "<small>项</small>";
    el.statDoneSub.textContent = "共 " + summary.count + " 条任务";

    var total = summary.total;
    var studyPercent = total > 0 ? Math.round((summary.study / total) * 100) : 0;
    var restPercent = total > 0 ? 100 - studyPercent : 0;
    if (summary.rest === 0) {
      restPercent = 0;
    }
    if (summary.study === 0) {
      studyPercent = 0;
    }

    el.ratioStudy.textContent = studyPercent + "%";
    el.ratioRest.textContent = restPercent + "%";
    el.ratioStudyBar.style.width = studyPercent + "%";
    el.ratioRestBar.style.width = restPercent + "%";

    var canChart = records.length > 0;
    el.chartBtn.disabled = !canChart;
    if (!canChart) {
      state.chartGenerated = false;
    }

    if (state.chartGenerated && canChart) {
      el.chartArea.hidden = false;
      el.saveChartBtn.disabled = false;
      renderCharts(records, summary);
    } else {
      el.chartArea.hidden = true;
      el.saveChartBtn.disabled = true;
    }
  }

  function renderCharts(records, summary) {
    STCharts.renderDonut(el.donutChart, summary);
    STCharts.renderBars(el.barChart, records);
    el.donutLegendStudy.textContent = "学习 " + C.formatDuration(summary.study);
    el.donutLegendRest.textContent = "休息 " + C.formatDuration(summary.rest);
  }

  /* ------------------------------------------------------------------ *
   * 渲染总入口
   * ------------------------------------------------------------------ */
  function renderAll() {
    renderHeader();
    renderWheelMode();
    renderResult();
    renderTasks();
    renderStats();
    updateStorageNote();
  }

  /* ------------------------------------------------------------------ *
   * 抽签
   * ------------------------------------------------------------------ */
  function spin() {
    if (state.spinning || (state.wheel && state.wheel.spinning)) {
      return;
    }
    if (!isToday()) {
      toast("历史日期不能抽签，请先回到今天", true);
      return;
    }

    state.spinning = true;
    state.resultRecord = null;
    renderWheelMode();
    renderResult();
    el.wheelStage.classList.add("is-spinning");

    var spinDate = state.viewDate;
    var index = Math.floor(Math.random() * C.WHEEL.length);
    state.wheel
      .spinTo(index)
      .then(function () {
        var segment = C.WHEEL[index];
        state.resultRecord = addRecord(segment.type, segment.minutes, spinDate);
        state.spinning = false;
        el.wheelStage.classList.remove("is-spinning");
        renderAll();
        toast(
          segment.type === "rest"
            ? "抽到休息 " + C.formatDuration(segment.minutes) + "，放松一下再继续"
            : "抽到学习 " + C.formatDuration(segment.minutes) + "，专注开始吧"
        );
      })
      .catch(function (error) {
        console.warn("[Study Turntable] 转盘旋转失败：", error);
        state.spinning = false;
        el.wheelStage.classList.remove("is-spinning");
        renderAll();
        toast("转盘出了点小问题，请再试一次", true);
      });
  }

  /* ------------------------------------------------------------------ *
   * 日期切换
   * ------------------------------------------------------------------ */
  function setViewDate(dateString) {
    if (state.spinning) {
      toast("转盘转动中，请稍候再切换日期");
      return;
    }
    var parsed = C.parseDateString(dateString);
    if (!parsed) {
      renderHeader();
      return;
    }
    var today = C.todayString();
    var normalized = C.toDateString(parsed);
    if (normalized > today) {
      normalized = today;
    }
    if (normalized === state.viewDate) {
      renderHeader();
      return;
    }

    state.viewDate = normalized;
    state.resultRecord = null;
    state.chartGenerated = false;
    state.wheel.resetHighlight();
    renderAll();
  }

  /* ------------------------------------------------------------------ *
   * 导出 / 导入 / 保存图表
   * ------------------------------------------------------------------ */
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
  }

  function exportData() {
    var payload = {
      app: "study-turntable",
      version: DATA_VERSION,
      exportedAt: new Date().toISOString(),
      days: state.data.days
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    downloadBlob(blob, "study-turntable-data-" + C.todayString().replace(/-/g, "") + ".json");
    toast("数据已导出为 JSON 文件");
  }

  function importFile(event) {
    var file = event.target.files && event.target.files[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(String(reader.result));
        var days = payload && payload.days;
        if (!days || typeof days !== "object" || Array.isArray(days)) {
          throw new Error("文件中没有找到有效的 days 数据");
        }

        var importedDays = {};
        var recordCount = 0;

        Object.keys(days).forEach(function (dateKey) {
          var date = C.parseDateString(dateKey);
          if (!date) {
            return;
          }
          var day = days[dateKey];
          if (!day || !Array.isArray(day.records)) {
            return;
          }
          var records = day.records.filter(isValidRecord).map(normalizeRecord).sort(byCreatedAtAsc);
          if (!records.length) {
            return;
          }
          importedDays[C.toDateString(date)] = { records: records };
          recordCount += records.length;
        });

        if (!recordCount) {
          throw new Error("文件里没有可导入的任务记录");
        }

        var dayCount = Object.keys(importedDays).length;
        var ok = window.confirm(
          "将导入 " + recordCount + " 条记录（共 " + dayCount + " 天），同日期数据会被覆盖。是否继续？"
        );
        if (!ok) {
          return;
        }

        Object.keys(importedDays).forEach(function (dateKey) {
          state.data.days[dateKey] = importedDays[dateKey];
        });
        persist();
        renderAll();
        toast("已导入 " + recordCount + " 条记录");
      } catch (error) {
        console.warn("[Study Turntable] 导入失败：", error);
        toast("导入失败：" + (error && error.message ? error.message : "文件格式不正确"), true);
      }
    };
    reader.onerror = function () {
      toast("读取文件失败，请重试", true);
    };
    reader.readAsText(file);
  }

  function saveChart() {
    var records = recordsFor(state.viewDate);
    if (!records.length) {
      toast("没有可保存的图表数据", true);
      return;
    }
    var summary = C.summarize(records);
    el.saveChartBtn.disabled = true;
    STCharts.exportPNG({ date: state.viewDate, records: records, summary: summary })
      .then(function (filename) {
        toast("图表已保存：" + filename);
      })
      .catch(function (error) {
        console.warn("[Study Turntable] 保存图表失败：", error);
        toast("图表保存失败，请重试", true);
      })
      .then(function () {
        renderStats();
      });
  }

  /* ------------------------------------------------------------------ *
   * 提示
   * ------------------------------------------------------------------ */
  function toast(message, isError) {
    el.toast.textContent = message;
    el.toast.classList.toggle("is-error", Boolean(isError));
    el.toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(function () {
      el.toast.classList.remove("is-visible");
    }, 2600);
  }

  /* ------------------------------------------------------------------ *
   * 时钟（含跨天自动切换到新的一天）
   * ------------------------------------------------------------------ */
  function startClock() {
    var lastKnownToday = C.todayString();

    function tick() {
      var now = new Date();
      var nowString = C.toDateString(now);
      el.clock.textContent = C.formatClock(now);
      el.clockDate.textContent = C.formatDateLabel(nowString) + " " + C.weekdayName(nowString);

      if (nowString !== lastKnownToday) {
        var wasViewingToday = state.viewDate === lastKnownToday;
        lastKnownToday = nowString;
        el.datePicker.max = nowString;
        if (wasViewingToday) {
          state.viewDate = nowString;
          state.resultRecord = null;
          state.chartGenerated = false;
          state.wheel.resetHighlight();
          renderAll();
        } else {
          renderHeader();
        }
      }
    }

    tick();
    state.clockTimer = window.setInterval(tick, 1000);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定与初始化
   * ------------------------------------------------------------------ */
  function cacheElements() {
    [
      "clock", "clockDate", "viewMeta", "datePicker", "prevDay", "nextDay", "todayBtn",
      "storagePill", "footerNote", "wheelModePill", "wheelStage", "wheelCanvas", "hubSpin", "spinBtn",
      "resultCard", "resultEmpty", "resultEmptyText", "resultBody", "resultType", "resultTime",
      "resultNote", "resultDone", "resultAgain",
      "taskSub", "taskViewPill", "taskList", "taskEmpty", "taskEmptyText", "taskFootHint", "clearDayBtn",
      "statsSub", "statsPill", "statStudy", "statStudySub", "statRest", "statRestSub", "statDone", "statDoneSub",
      "ratioStudy", "ratioRest", "ratioStudyBar", "ratioRestBar",
      "chartBtn", "saveChartBtn", "chartArea", "donutChart", "barChart", "donutLegendStudy", "donutLegendRest",
      "exportBtn", "importBtn", "importFile", "resetAllBtn", "toast"
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
  }

  function bindEvents() {
    el.spinBtn.addEventListener("click", spin);
    el.hubSpin.addEventListener("click", spin);
    el.resultAgain.addEventListener("click", spin);
    el.resultDone.addEventListener("click", function () {
      var record = state.resultRecord || latestRecordForView();
      if (record) {
        toggleDone(record.id);
      }
    });

    el.prevDay.addEventListener("click", function () {
      setViewDate(C.shiftDate(state.viewDate, -1));
    });
    el.nextDay.addEventListener("click", function () {
      var next = C.shiftDate(state.viewDate, 1);
      if (next > C.todayString()) {
        return;
      }
      setViewDate(next);
    });
    el.todayBtn.addEventListener("click", function () {
      setViewDate(C.todayString());
    });
    el.datePicker.addEventListener("change", function () {
      setViewDate(el.datePicker.value);
    });

    el.clearDayBtn.addEventListener("click", clearDay);
    el.resetAllBtn.addEventListener("click", resetAll);

    el.chartBtn.addEventListener("click", function () {
      if (!recordsFor(state.viewDate).length) {
        toast("当天还没有任务，先抽取一份任务吧", true);
        return;
      }
      state.chartGenerated = true;
      renderStats();
      toast("统计图表已生成，可保存为 PNG");
    });
    el.saveChartBtn.addEventListener("click", saveChart);

    el.exportBtn.addEventListener("click", exportData);
    el.importBtn.addEventListener("click", function () {
      el.importFile.click();
    });
    el.importFile.addEventListener("change", importFile);

    window.addEventListener("resize", function () {
      if (!state.chartGenerated) {
        return;
      }
      window.clearTimeout(state.resizeTimer);
      state.resizeTimer = window.setTimeout(function () {
        if (!state.chartGenerated) {
          return;
        }
        var records = recordsFor(state.viewDate);
        if (records.length) {
          renderCharts(records, C.summarize(records));
        }
      }, 160);
    });
  }

  function init() {
    cacheElements();
    checkStorage();
    state.data = loadData();
    state.wheel = new window.STWheel(el.wheelCanvas, C.WHEEL);
    bindEvents();
    startClock();
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();