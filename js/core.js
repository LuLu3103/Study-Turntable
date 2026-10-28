/*
 * Study Turntable — 核心逻辑（纯函数，可同时运行在浏览器与 Node 中）
 * 不依赖 DOM / localStorage，方便单独做单元测试。
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.STCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ------------------------------------------------------------------ *
   * 转盘配置
   * 30 份内容：25 份学习时长（10min – 2h）+ 5 份休息（5/10/15/20/30min）
   * ------------------------------------------------------------------ */
  var WHEEL_SIZE = 30;

  // 休息片段固定分散在不同位置，保证转盘视觉上均匀
  var REST_POSITIONS = [
    { index: 4, minutes: 5 },
    { index: 10, minutes: 10 },
    { index: 16, minutes: 15 },
    { index: 22, minutes: 20 },
    { index: 28, minutes: 30 }
  ];

  // 23 个不同学习时长（10 – 120min，步长 5）+ 30、60 各重复一次 = 25 份
  var STUDY_MINUTES = [
    10, 15, 20, 25, 30,
    30, 35, 40, 45, 50,
    55, 60, 60, 65, 70,
    75, 80, 85, 90, 95,
    100, 105, 110, 115, 120
  ];

  // 深浅蓝交替，让 30 个扇区清晰可读；休息用一小块暖色点缀
  var STUDY_COLORS = ["#2563eb", "#93c5fd"];
  var STUDY_TEXT_COLORS = ["#ffffff", "#1e3a8a"];
  var REST_COLOR = "#f59e0b";
  var REST_TEXT_COLOR = "#7c2d12";

  function buildWheel() {
    var restByIndex = {};
    REST_POSITIONS.forEach(function (position) {
      restByIndex[position.index] = position.minutes;
    });

    var segments = [];
    var studyIndex = 0;

    for (var i = 0; i < WHEEL_SIZE; i++) {
      if (Object.prototype.hasOwnProperty.call(restByIndex, i)) {
        var restMinutes = restByIndex[i];
        segments.push({
          type: "rest",
          minutes: restMinutes,
          label: "休息" + restMinutes + "min",
          color: REST_COLOR,
          textColor: REST_TEXT_COLOR
        });
      } else {
        var minutes = STUDY_MINUTES[studyIndex];
        var colorIndex = studyIndex % 2;
        segments.push({
          type: "study",
          minutes: minutes,
          label: minutes + "min",
          color: STUDY_COLORS[colorIndex],
          textColor: STUDY_TEXT_COLORS[colorIndex]
        });
        studyIndex += 1;
      }
    }

    return segments;
  }

  var WHEEL = buildWheel();

  /* ------------------------------------------------------------------ *
   * 数值与时间格式
   * ------------------------------------------------------------------ */
  function formatDuration(minutes) {
    var value = Math.max(0, Math.round(Number(minutes) || 0));
    if (value < 60) {
      return value + "min";
    }
    var hours = Math.floor(value / 60);
    var rest = value % 60;
    return rest === 0 ? hours + "h" : hours + "h " + rest + "min";
  }

  function pad2(number) {
    return (number < 10 ? "0" : "") + number;
  }

  function formatClock(date) {
    var value = date || new Date();
    return pad2(value.getHours()) + ":" + pad2(value.getMinutes()) + ":" + pad2(value.getSeconds());
  }

  function formatTimeOfDay(timestamp) {
    var date = new Date(timestamp);
    if (isNaN(date.getTime())) {
      return "--:--";
    }
    return pad2(date.getHours()) + ":" + pad2(date.getMinutes());
  }

  /* ------------------------------------------------------------------ *
   * 日期工具（全部使用本地时区，避免 toISOString 的 UTC 偏移问题）
   * ------------------------------------------------------------------ */
  function toDateString(date) {
    var value = date || new Date();
    return value.getFullYear() + "-" + pad2(value.getMonth() + 1) + "-" + pad2(value.getDate());
  }

  function todayString(now) {
    return toDateString(now || new Date());
  }

  function parseDateString(dateString) {
    var match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateString || ""));
    if (!match) {
      return null;
    }
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var date = new Date(year, month - 1, day);
    if (
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      return null;
    }
    return date;
  }

  function shiftDate(dateString, days) {
    var date = parseDateString(dateString);
    if (!date) {
      return dateString;
    }
    date.setDate(date.getDate() + Number(days || 0));
    return toDateString(date);
  }

  function weekdayName(dateString) {
    var date = parseDateString(dateString);
    if (!date) {
      return "";
    }
    return "星期" + "日一二三四五六".charAt(date.getDay());
  }

  function formatDateLabel(dateString) {
    var date = parseDateString(dateString);
    if (!date) {
      return String(dateString || "");
    }
    return date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月 " + date.getDate() + " 日";
  }

  /* ------------------------------------------------------------------ *
   * 转盘角度计算
   * 扇区 i 在画布上占 [-90° + i*ap, -90° + (i+1)*ap)，指针固定在正上方。
   * ------------------------------------------------------------------ */
  function anglePerSegment(count) {
    return 360 / count;
  }

  // 让第 index 个扇区中心停在指针下的旋转角（0 – 360）
  function rotationForIndex(index, count, jitter) {
    var step = anglePerSegment(count);
    var rotation = (-(index + 0.5) * step) % 360;
    if (rotation < 0) {
      rotation += 360;
    }
    if (typeof jitter === "number" && jitter !== 0) {
      rotation = (rotation + (Math.random() * 2 - 1) * Math.abs(jitter) + 360) % 360;
    }
    return rotation;
  }

  // 旋转 rotation 度之后，指针正上方指向的扇区下标
  function indexAtPointer(rotation, count) {
    var step = anglePerSegment(count);
    var contentAngle = (((-rotation) % 360) + 360) % 360;
    var index = Math.floor(contentAngle / step + 1e-9);
    if (index < 0) {
      index = 0;
    }
    if (index >= count) {
      index = count - 1;
    }
    return index;
  }

  // 从当前旋转角出发，规划一次「停在第 index 个扇区」的总旋转角
  function planSpin(currentRotation, index, count, turns) {
    var base = rotationForIndex(index, count, 0);
    var currentMod = ((currentRotation % 360) + 360) % 360;
    var delta = ((base - currentMod) % 360 + 360) % 360;
    return currentRotation + Math.max(1, Math.ceil(turns || 5)) * 360 + delta;
  }

  /* ------------------------------------------------------------------ *
   * 统计
   * ------------------------------------------------------------------ */
  function summarize(records) {
    var summary = {
      study: 0,
      rest: 0,
      total: 0,
      done: 0,
      pending: 0,
      count: 0,
      studyCount: 0,
      restCount: 0
    };

    (records || []).forEach(function (record) {
      if (!record || typeof record.minutes !== "number") {
        return;
      }
      var minutes = Math.max(0, Math.round(record.minutes));
      if (record.type === "study") {
        summary.study += minutes;
        summary.studyCount += 1;
      } else if (record.type === "rest") {
        summary.rest += minutes;
        summary.restCount += 1;
      } else {
        return;
      }
      summary.count += 1;
      if (record.done) {
        summary.done += 1;
      } else {
        summary.pending += 1;
      }
    });

    summary.total = summary.study + summary.rest;
    return summary;
  }

  /* ------------------------------------------------------------------ *
   * 任务计时
   * - 学习任务：时长结束前不能再次抽取（findCooldown 返回倒计时）
   * - 休息任务：只显示休息倒计时，不锁定抽签，可以随时跳过（findRestTimer）
   * 全部使用记录里的 createdAt（毫秒时间戳）计算，因此刷新页面后依旧有效。
   * ------------------------------------------------------------------ */
  var MINUTE_MS = 60 * 1000;

  function cooldownTotal(record) {
    if (!record || typeof record.minutes !== "number" || !isFinite(record.minutes)) {
      return 0;
    }
    return Math.max(0, Math.round(record.minutes)) * MINUTE_MS;
  }

  // 所有日期中最近的一条抽取记录
  function latestRecord(days) {
    var latest = null;

    Object.keys(days || {}).forEach(function (dateString) {
      var day = days[dateString];
      var records = day && Array.isArray(day.records) ? day.records : [];
      records.forEach(function (record) {
        if (!record || typeof record.createdAt !== "number" || !isFinite(record.createdAt)) {
          return;
        }
        if (!latest || record.createdAt > latest.record.createdAt) {
          latest = { record: record, dateString: dateString };
        }
      });
    });

    return latest;
  }

  function timerFor(latest, now) {
    if (!latest) {
      return null;
    }

    var total = cooldownTotal(latest.record);
    if (total <= 0) {
      return null;
    }

    // 时钟被回拨或导入了“未来”的记录时，从 0 开始计时，避免无限锁定
    var current = typeof now === "number" ? now : Date.now();
    var elapsed = Math.max(0, current - latest.record.createdAt);
    var remaining = total - elapsed;
    if (remaining <= 0) {
      return null;
    }

    return {
      record: latest.record,
      dateString: latest.dateString,
      total: total,
      elapsed: Math.min(elapsed, total),
      remaining: remaining,
      endsAt: latest.record.createdAt + total
    };
  }

  // 学习任务冷却：只有最近一次抽到的是学习任务时才需要等待
  function findCooldown(days, now) {
    var latest = latestRecord(days);
    if (!latest || latest.record.type !== "study") {
      return null;
    }
    return timerFor(latest, now);
  }

  // 休息倒计时：只用于展示与“跳过休息”，不限制抽签
  function findRestTimer(days, now) {
    var latest = latestRecord(days);
    if (!latest || latest.record.type !== "rest") {
      return null;
    }
    return timerFor(latest, now);
  }

  // 毫秒 → 倒计时文本：45:00 / 1:02:30
  function formatCountdown(milliseconds) {
    var totalSeconds = Math.max(0, Math.ceil((Number(milliseconds) || 0) / 1000));
    var hours = Math.floor(totalSeconds / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;
    if (hours > 0) {
      return hours + ":" + pad2(minutes) + ":" + pad2(seconds);
    }
    return pad2(minutes) + ":" + pad2(seconds);
  }

  /* ------------------------------------------------------------------ *
   * 时间范围统计（今日 / 近 7 天 / 近 30 天）
   * ------------------------------------------------------------------ */
  var RANGE_DAYS = { today: 1, week: 7, month: 30 };

  function rangeDayCount(rangeKey) {
    return RANGE_DAYS[rangeKey] || 1;
  }

  function formatShortDate(dateString) {
    var date = parseDateString(dateString);
    if (!date) {
      return String(dateString || "");
    }
    return pad2(date.getMonth() + 1) + "-" + pad2(date.getDate());
  }

  // 以 endDateString 为最后一天，向前倒推 count 天（含首尾）
  function rangeDates(endDateString, dayCount) {
    var end = parseDateString(endDateString) ? endDateString : todayString();
    var count = Math.max(1, Math.round(Number(dayCount) || 1));
    var dates = [];
    for (var offset = count - 1; offset >= 0; offset -= 1) {
      dates.push(shiftDate(end, -offset));
    }
    return dates;
  }

  function aggregateRange(days, endDateString, dayCount) {
    var dates = rangeDates(endDateString, dayCount);
    var allRecords = [];

    var series = dates.map(function (dateString) {
      var day = days && days[dateString];
      var records = day && Array.isArray(day.records) ? day.records.slice() : [];
      records.sort(function (a, b) {
        return (a.createdAt || 0) - (b.createdAt || 0);
      });
      var summary = summarize(records);
      Array.prototype.push.apply(allRecords, records);
      return {
        date: dateString,
        short: formatShortDate(dateString),
        weekday: weekdayName(dateString),
        study: summary.study,
        rest: summary.rest,
        total: summary.total,
        count: summary.count,
        done: summary.done,
        pending: summary.pending,
        records: records
      };
    });

    var summary = summarize(allRecords);
    var activeDays = 0;
    series.forEach(function (day) {
      if (day.count > 0) {
        activeDays += 1;
      }
    });

    return {
      start: dates[0],
      end: dates[dates.length - 1],
      dates: dates,
      series: series,
      records: allRecords,
      summary: summary,
      activeDays: activeDays,
      averageStudy: activeDays > 0 ? Math.round(summary.study / activeDays) : 0
    };
  }

  return {
    WHEEL_SIZE: WHEEL_SIZE,
    REST_POSITIONS: REST_POSITIONS,
    STUDY_MINUTES: STUDY_MINUTES,
    WHEEL: WHEEL,
    MINUTE_MS: MINUTE_MS,
    RANGE_DAYS: RANGE_DAYS,
    buildWheel: buildWheel,
    summarize: summarize,
    cooldownTotal: cooldownTotal,
    findCooldown: findCooldown,
    findRestTimer: findRestTimer,
    formatCountdown: formatCountdown,
    rangeDayCount: rangeDayCount,
    rangeDates: rangeDates,
    formatShortDate: formatShortDate,
    aggregateRange: aggregateRange,
    rotationForIndex: rotationForIndex,
    indexAtPointer: indexAtPointer,
    planSpin: planSpin,
    anglePerSegment: anglePerSegment,
    formatDuration: formatDuration,
    formatClock: formatClock,
    formatTimeOfDay: formatTimeOfDay,
    pad2: pad2,
    toDateString: toDateString,
    todayString: todayString,
    parseDateString: parseDateString,
    shiftDate: shiftDate,
    weekdayName: weekdayName,
    formatDateLabel: formatDateLabel
  };
});