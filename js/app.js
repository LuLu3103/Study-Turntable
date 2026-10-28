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
    range: "today",
    wheel: null,
    spinning: false,
    resultRecord: null,
    cooldown: null,
    restTimer: null,
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

  /* ------------------------------------------------------------------ *
   * 任务计时：学习任务必须等倒计时结束；休息任务只计时、不锁抽签
   * ------------------------------------------------------------------ */
  function refreshCooldown(now) {
    var timestamp = now || Date.now();
    state.cooldown = C.findCooldown(state.data.days, timestamp);
    state.restTimer = C.findRestTimer(state.data.days, timestamp);
    return state.cooldown;
  }

  function isCooling() {
    return Boolean(state.cooldown && state.cooldown.remaining > 0);
  }

  function isCoolingRecord(record) {
    return Boolean(record && state.cooldown && state.cooldown.record.id === record.id);
  }

  function isRestTiming() {
    return Boolean(state.restTimer && state.restTimer.remaining > 0);
  }

  function isRestTimerRecord(record) {
    return Boolean(record && state.restTimer && state.restTimer.record.id === record.id);
  }

  /* ------------------------------------------------------------------ *
   * 统计范围：今日 / 近 7 天 / 近 30 天
   * ------------------------------------------------------------------ */
  function currentRangeLabel() {
    if (state.range === "today") {
      return isToday() ? "今日" : "当日";
    }
    return state.range === "week" ? "近 7 天" : "近 30 天";
  }

  function rangeAggregate() {
    return C.aggregateRange(state.data.days, state.viewDate, C.rangeDayCount(state.range));
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

  function removeRecord(recordId, dateString) {
    var targetDate = dateString || state.viewDate;
    var day = state.data.days[targetDate];
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
      delete state.data.days[targetDate];
    }
    if (state.resultRecord && state.resultRecord.id === recordId) {
      state.resultRecord = null;
    }
    persist();
    renderAll();
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
    var cooling = isCooling();
    var resting = !cooling && isRestTiming();
    var disabled = locked || state.spinning || cooling;

    el.spinBtn.disabled = disabled;
    el.hubSpin.disabled = disabled;
    el.spinBtn.classList.toggle("is-loading", state.spinning);
    el.spinBtn.classList.toggle("is-cooling", cooling && !state.spinning);

    if (state.spinning) {
      el.spinBtn.textContent = "转盘转动中";
    } else if (locked) {
      el.spinBtn.textContent = "历史日期为只读";
    } else if (cooling) {
      el.spinBtn.textContent = "本轮任务进行中 · 剩余 " + C.formatCountdown(state.cooldown.remaining);
    } else {
      el.spinBtn.textContent = "抽取学习任务";
    }

    el.hubSpin.title = cooling ? "本轮任务结束后可以再抽" : "抽取任务";
    el.spinBtn.title = locked
      ? "历史日期为只读"
      : cooling
      ? "本轮任务结束后可以再抽"
      : "抽取学习任务";
    el.wheelModePill.textContent = locked ? "历史 · 只读" : cooling ? "计时中" : resting ? "休息中" : "今天";
    el.wheelModePill.classList.toggle("pill--history", locked);
    el.wheelModePill.classList.toggle("pill--cooling", !locked && cooling);
    el.wheelModePill.classList.toggle("pill--rest", !locked && resting);
  }

  function renderResult() {
    var locked = !isToday();
    var cooling = isCooling();
    var resting = isRestTiming();

    el.resultCard.classList.toggle("is-spinning", state.spinning);
    el.resultCard.classList.toggle("is-cooling", cooling && !state.spinning);

    if (state.spinning) {
      el.resultEmpty.hidden = false;
      el.resultBody.hidden = true;
      el.resultProgress.hidden = true;
      el.resultEmptyText.textContent = "转盘转动中，愿你抽到刚刚好的时长…";
      return;
    }

    var record = state.resultRecord || latestRecordForView();

    if (!record) {
      el.resultEmpty.hidden = false;
      el.resultBody.hidden = true;
      el.resultProgress.hidden = true;
      if (locked) {
        el.resultEmptyText.textContent = "历史日期仅支持查看和统计，不能抽签";
      } else if (cooling) {
        el.resultEmptyText.textContent = "上一轮学习仍在计时 · 剩余 " + C.formatCountdown(state.cooldown.remaining);
      } else if (resting) {
        el.resultEmptyText.textContent = "休息计时中 · 剩余 " + C.formatCountdown(state.restTimer.remaining) + "，可以直接抽下一轮";
      } else {
        el.resultEmptyText.textContent = "点击下方按钮，抽出今天的任务吧";
      }
      return;
    }

    var recordCooling = isCoolingRecord(record);
    var recordResting = isRestTimerRecord(record);
    var isLatestOnly = !state.resultRecord;
    var isRest = record.type === "rest";

    el.resultEmpty.hidden = true;
    el.resultBody.hidden = false;
    el.resultType.textContent = isRest ? "休息任务" : "学习任务";
    el.resultType.classList.toggle("is-rest", isRest);
    el.resultTime.textContent = C.formatDuration(record.minutes);

    if (recordCooling) {
      el.resultNote.textContent =
        "专注计时中 · 剩余 " + C.formatCountdown(state.cooldown.remaining) + "，结束后可再抽";
    } else if (recordResting) {
      el.resultNote.textContent =
        "休息计时中 · 剩余 " + C.formatCountdown(state.restTimer.remaining) + "，可跳过直接抽下一轮";
    } else if (isLatestOnly) {
      el.resultNote.textContent = record.done
        ? "当日最近一次抽取 · 已完成"
        : "当日最近一次抽取 · 待完成";
    } else {
      el.resultNote.textContent = record.done
        ? "已打卡：这份任务完成了"
        : "已加入今日任务，完成后记得打卡";
    }

    var activeTimer = recordCooling ? state.cooldown : recordResting ? state.restTimer : null;
    el.resultProgress.hidden = !activeTimer;
    if (activeTimer) {
      var ratio = activeTimer.total > 0 ? activeTimer.elapsed / activeTimer.total : 0;
      el.resultProgressBar.style.width = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(1) + "%";
    }

    el.resultDone.textContent = record.done ? "取消完成" : "标记完成";
    el.resultDone.classList.toggle("is-done", record.done);

    el.resultAgain.hidden = locked || recordCooling;
    el.resultAgain.disabled = state.spinning || recordCooling;
    el.resultAgain.textContent = recordResting ? "跳过休息" : "再抽一次";
  }

  // 每秒只刷新倒计时相关文案，避免整页重绘
  function setTimerProgress(timer) {
    el.resultProgress.hidden = !timer;
    if (timer) {
      var ratio = timer.total > 0 ? timer.elapsed / timer.total : 0;
      el.resultProgressBar.style.width = (Math.min(1, Math.max(0, ratio)) * 100).toFixed(1) + "%";
    }
  }

  function updateCooldownUI() {
    renderWheelMode();
    if (state.spinning) {
      return;
    }

    var record = state.resultRecord || latestRecordForView();

    if (record && isCoolingRecord(record)) {
      el.resultNote.textContent =
        "专注计时中 · 剩余 " + C.formatCountdown(state.cooldown.remaining) + "，结束后可再抽";
      setTimerProgress(state.cooldown);
      return;
    }
    if (record && isRestTimerRecord(record)) {
      el.resultNote.textContent =
        "休息计时中 · 剩余 " + C.formatCountdown(state.restTimer.remaining) + "，可跳过直接抽下一轮";
      setTimerProgress(state.restTimer);
      return;
    }
    if (!record && !isToday()) {
      return;
    }
    if (!record && isCooling()) {
      el.resultEmptyText.textContent =
        "上一轮学习仍在计时 · 剩余 " + C.formatCountdown(state.cooldown.remaining);
      return;
    }
    if (!record && isRestTiming()) {
      el.resultEmptyText.textContent =
        "休息计时中 · 剩余 " + C.formatCountdown(state.restTimer.remaining) + "，可以直接抽下一轮";
    }
  }

  /* ------------------------------------------------------------------ *
   * 渲染：任务栏
   * ------------------------------------------------------------------ */
  function buildTaskRow(record, locked, viewDate) {
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
      var timing = isCoolingRecord(record);
      remove.type = "button";
      remove.className = "task-del";
      remove.textContent = "×";
      if (timing) {
        // 本轮学习计时中不能删除，避免绕过等待
        remove.disabled = true;
        remove.title = "本轮计时中，结束后可删除";
        remove.setAttribute("aria-label", "本轮计时中，结束后可删除");
      } else {
        remove.title = "删除这条任务";
        remove.setAttribute("aria-label", "删除这条任务");
        remove.addEventListener("click", function () {
          removeRecord(record.id, viewDate);
        });
      }
      item.appendChild(remove);
    }

    return item;
  }

  function renderTasks() {
    var viewDate = state.viewDate;
    var records = recordsFor(viewDate)
      .slice()
      .sort(function (a, b) {
        return b.createdAt - a.createdAt;
      });
    var summary = C.summarize(records);
    var locked = !isToday();
    var cooling = isCooling();
    var resting = !cooling && isRestTiming();

    el.taskList.innerHTML = "";
    records.forEach(function (record) {
      el.taskList.appendChild(buildTaskRow(record, locked, viewDate));
    });

    el.taskEmpty.hidden = records.length > 0;
    el.taskEmptyText.textContent = locked
      ? "该日期没有保存任何任务记录"
      : "还没有任务，转动转盘开始今天的学习吧";

    el.taskSub.textContent =
      (locked ? "该日" : "今天") + " · 共 " + records.length + " 条记录";
    el.taskViewPill.textContent = locked ? "历史 · 只读" : cooling ? "计时中" : resting ? "休息中" : "今天";
    el.taskViewPill.classList.toggle("pill--history", locked);
    el.taskViewPill.classList.toggle("pill--cooling", !locked && cooling);
    el.taskViewPill.classList.toggle("pill--rest", !locked && resting);
    el.taskViewPill.classList.toggle("pill--muted", !locked && !cooling && !resting);

    el.taskFootHint.textContent = locked
      ? "历史数据 · 只读查看"
      : "已完成 " + summary.done + " 项 · 待完成 " + summary.pending + " 项";
    el.clearDayBtn.disabled = locked || records.length === 0;
  }

  /* ------------------------------------------------------------------ *
   * 渲染：统计栏与图表
   * ------------------------------------------------------------------ */
  function renderStats() {
    var aggregate = rangeAggregate();
    var summary = aggregate.summary;
    var locked = !isToday();
    var isTodayRange = state.range === "today";
    var rangeLabel = currentRangeLabel();

    el.rangeTabs.forEach(function (tab) {
      var active = tab.getAttribute("data-range") === state.range;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    el.rangeToday.textContent = locked ? "当日" : "今日";

    if (isTodayRange) {
      el.statsSub.textContent =
        C.formatDateLabel(state.viewDate) + (locked ? " · 历史数据" : " · 今日累计");
    } else {
      el.statsSub.textContent =
        C.formatShortDate(aggregate.start) + " 至 " + C.formatShortDate(aggregate.end) + " · " + rangeLabel;
    }

    el.statsPill.textContent = locked ? rangeLabel + " · 只读" : rangeLabel;
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

    if (isTodayRange) {
      el.statsNote.textContent = "学习 / 休息时长按当天抽到的任务累计；勾选完成仅用于打卡统计。";
    } else {
      el.statsNote.textContent =
        rangeLabel + "累计 · 有记录 " + aggregate.activeDays + " 天 · 日均学习 " +
        C.formatDuration(aggregate.averageStudy) + "（按有记录的天数计算）。";
    }

    var canChart = summary.count > 0;
    el.chartBtn.disabled = !canChart;
    if (!canChart) {
      state.chartGenerated = false;
    }

    var expanded = state.chartGenerated && canChart;
    el.chartBtn.textContent = expanded ? "收起图表" : "生成统计图表";
    el.chartBtn.setAttribute("aria-expanded", expanded ? "true" : "false");

    if (expanded) {
      el.chartArea.hidden = false;
      el.saveChartBtn.disabled = false;
      renderCharts(aggregate);
    } else {
      el.chartArea.hidden = true;
      el.saveChartBtn.disabled = true;
    }
  }

  function renderCharts(aggregate) {
    STCharts.renderDonut(el.donutChart, aggregate.summary);

    if (state.range === "today") {
      var taskTotal = 0;
      aggregate.records.forEach(function (record) {
        taskTotal += record.minutes || 0;
      });
      var taskAverage = aggregate.records.length
        ? Math.round(taskTotal / aggregate.records.length)
        : 0;
      el.donutChartTitle.textContent = "学习 / 休息占比";
      el.barChartTitle.textContent = "每次任务时长";
      el.chartHint.textContent = "按抽取顺序排列 · 虚线为平均 " + taskAverage + "min";
      el.barChart.setAttribute("aria-label", "每次任务时长柱状图");
      STCharts.renderTaskBars(el.barChart, aggregate.records);
    } else {
      var activeDays = aggregate.series.filter(function (day) {
        return day.total > 0;
      });
      var dayTotal = 0;
      activeDays.forEach(function (day) {
        dayTotal += day.total;
      });
      var dayAverage = activeDays.length ? Math.round(dayTotal / activeDays.length) : 0;
      el.donutChartTitle.textContent = currentRangeLabel() + "学习 / 休息占比";
      el.barChartTitle.textContent = "每日学习 / 休息时长";
      el.chartHint.textContent = "按日期排列 · 蓝色学习 / 橙色休息 · 虚线为日均 " + dayAverage + "min";
      el.barChart.setAttribute("aria-label", "每日学习与休息时长柱状图");
      STCharts.renderDailyBars(el.barChart, aggregate.series);
    }

    el.donutLegendStudy.textContent = "学习 " + C.formatDuration(aggregate.summary.study);
    el.donutLegendRest.textContent = "休息 " + C.formatDuration(aggregate.summary.rest);
  }

  /* ------------------------------------------------------------------ *
   * 渲染总入口
   * ------------------------------------------------------------------ */
  function renderAll() {
    refreshCooldown();
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

    refreshCooldown();
    if (isCooling()) {
      toast("本轮任务还在进行，剩余 " + C.formatCountdown(state.cooldown.remaining), true);
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
    var aggregate = rangeAggregate();
    if (!aggregate.summary.count) {
      toast("没有可保存的图表数据", true);
      return;
    }
    el.saveChartBtn.disabled = true;
    STCharts.exportPNG({
      mode: state.range === "today" ? "tasks" : "days",
      date: state.viewDate,
      rangeKey: state.range,
      rangeLabel: currentRangeLabel(),
      start: aggregate.start,
      end: aggregate.end,
      records: aggregate.records,
      series: aggregate.series,
      summary: aggregate.summary,
      activeDays: aggregate.activeDays,
      averageStudy: aggregate.averageStudy
    })
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
      var wasCooling = isCooling();

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

      // 计时刷新：学习倒计时结束解锁抽签；休息倒计时结束只做提示
      var wasResting = isRestTiming();
      refreshCooldown(now.getTime());
      if (wasCooling && !isCooling()) {
        renderAll();
        toast("本轮学习时间结束，可以抽取新任务啦");
      } else if (wasResting && !isRestTiming()) {
        renderAll();
        toast("休息时间结束，继续加油");
      } else if (isCooling() || isRestTiming()) {
        updateCooldownUI();
      }
    }

    tick();
    state.clockTimer = window.setInterval(tick, 1000);
  }

  /* ------------------------------------------------------------------ *
   * 事件绑定与初始化
   * ------------------------------------------------------------------ */
  function openHelp() {
    el.helpModal.hidden = false;
    document.body.classList.add("is-modal-open");
    el.helpClose.focus();
  }

  function dismissHelp() {
    if (el.helpModal.hidden) {
      return;
    }
    el.helpModal.hidden = true;
    document.body.classList.remove("is-modal-open");
    el.helpBtn.focus();
  }

  function cacheElements() {
    [
      "clock", "clockDate", "viewMeta", "datePicker", "prevDay", "nextDay", "todayBtn",
      "storagePill", "footerNote", "wheelModePill", "wheelStage", "wheelCanvas", "hubSpin", "spinBtn",
      "resultCard", "resultEmpty", "resultEmptyText", "resultBody", "resultType", "resultTime",
      "resultNote", "resultProgress", "resultProgressBar", "resultDone", "resultAgain",
      "taskSub", "taskViewPill", "taskList", "taskEmpty", "taskEmptyText", "taskFootHint", "clearDayBtn",
      "rangeToday", "rangeWeek", "rangeMonth", "statsNote",
      "statsSub", "statsPill", "statStudy", "statStudySub", "statRest", "statRestSub", "statDone", "statDoneSub",
      "ratioStudy", "ratioRest", "ratioStudyBar", "ratioRestBar",
      "chartBtn", "saveChartBtn", "chartArea", "donutChartTitle", "donutChart", "barChartTitle", "barChart",
      "chartHint", "donutLegendStudy", "donutLegendRest",
      "helpBtn", "helpModal", "helpBackdrop", "helpClose", "helpOk",
      "exportBtn", "importBtn", "importFile", "resetAllBtn", "toast"
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    el.rangeTabs = Array.prototype.slice.call(document.querySelectorAll(".range-tab"));
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

    el.rangeTabs.forEach(function (tab) {
      tab.addEventListener("click", function () {
        var range = tab.getAttribute("data-range");
        if (!range || range === state.range) {
          return;
        }
        state.range = range;
        renderStats();
      });
    });

    el.chartBtn.addEventListener("click", function () {
      var aggregate = rangeAggregate();
      if (!aggregate.summary.count) {
        toast(currentRangeLabel() + "还没有任务，先抽取一份任务吧", true);
        return;
      }
      state.chartGenerated = !state.chartGenerated;
      renderStats();
      toast(state.chartGenerated ? "统计图表已生成，可保存为 PNG" : "图表已收起");
    });
    el.saveChartBtn.addEventListener("click", saveChart);

    el.helpBtn.addEventListener("click", openHelp);
    el.helpClose.addEventListener("click", dismissHelp);
    el.helpOk.addEventListener("click", dismissHelp);
    el.helpBackdrop.addEventListener("click", dismissHelp);
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !el.helpModal.hidden) {
        dismissHelp();
      }
    });

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
        var aggregate = rangeAggregate();
        if (aggregate.summary.count) {
          renderCharts(aggregate);
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