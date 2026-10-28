/*
 * Study Turntable — 统计图表（Canvas 手绘，简约风格）
 * - renderDonut: 学习 / 休息占比环形图
 * - renderTaskBars: 单日「每次任务」柱状图
 * - renderDailyBars: 多日「每日学习 / 休息」堆叠柱状图
 * - exportPNG: 把当前统计导出为 PNG
 */
(function (root) {
  "use strict";

  var C = root.STCore;
  var FONT_STACK = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  var COLORS = {
    study: "#2563eb",
    studySoft: "#bfdbfe",
    rest: "#f59e0b",
    restSoft: "#fde68a",
    ink: "#0f2a5c",
    inkSoft: "#35507f",
    muted: "#8ea6c8",
    grid: "#edf3fc",
    axis: "#dbe7f8",
    track: "#eef4fd",
    card: "#f4f8ff",
    border: "#e3edfb"
  };

  /* ------------------------------------------------------------------ *
   * 基础绘制工具
   * ------------------------------------------------------------------ */
  function roundRect(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height - r);
    ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    ctx.lineTo(x + r, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // 只圆上边两个角（柱子立在地平线上，底部保持平直）
  function roundRectTop(ctx, x, y, width, height, radius) {
    var r = Math.min(radius, width / 2, height);
    ctx.beginPath();
    ctx.moveTo(x, y + height);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + width - r, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + r);
    ctx.lineTo(x + width, y + height);
    ctx.closePath();
  }

  function setupCanvas(canvas, width, height) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  function fitFont(ctx, text, maxWidth, startSize, weight) {
    var size = startSize;
    while (size > 10) {
      ctx.font = (weight || "700") + " " + size + "px " + FONT_STACK;
      if (ctx.measureText(text).width <= maxWidth) {
        return size;
      }
      size -= 1;
    }
    return size;
  }

  /* ------------------------------------------------------------------ *
   * 环形图
   * ------------------------------------------------------------------ */
  function drawDonut(ctx, centerX, centerY, radius, thickness, summary, caption) {
    var total = (summary.study || 0) + (summary.rest || 0);
    var startAngle = -Math.PI / 2;

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.lineWidth = thickness;
    ctx.strokeStyle = COLORS.track;
    ctx.stroke();

    if (total > 0) {
      var studyAngle = (summary.study / total) * Math.PI * 2;
      var gap = summary.rest > 0 && summary.study > 0 ? 0.028 : 0;
      ctx.lineCap = "round";

      if (summary.study > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, startAngle + gap, startAngle + studyAngle - gap);
        ctx.lineWidth = thickness;
        ctx.strokeStyle = COLORS.study;
        ctx.stroke();
      }
      if (summary.rest > 0) {
        ctx.beginPath();
        ctx.arc(
          centerX,
          centerY,
          radius,
          startAngle + studyAngle + gap,
          startAngle + Math.PI * 2 - gap
        );
        ctx.lineWidth = thickness;
        ctx.strokeStyle = COLORS.rest;
        ctx.stroke();
      }
      ctx.lineCap = "butt";
    }

    var totalLabel = total > 0 ? C.formatDuration(total) : "暂无数据";
    var size = fitFont(ctx, totalLabel, radius * 1.5, Math.round(radius * 0.42), "700");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 " + size + "px " + FONT_STACK;
    ctx.fillText(totalLabel, centerX, centerY - Math.max(2, size * 0.12));

    var captionText = caption || "总任务时长";
    ctx.fillStyle = COLORS.muted;
    ctx.font = "500 " + Math.max(10, Math.round(radius * 0.16)) + "px " + FONT_STACK;
    ctx.fillText(captionText, centerX, centerY + Math.max(10, Math.round(radius * 0.3)));
  }

  function renderDonut(canvas, summary) {
    var width = Math.round(canvas.clientWidth || 190);
    var height = Math.round(canvas.clientHeight || width);
    var side = Math.max(80, Math.min(width, height));
    var ctx = setupCanvas(canvas, width, side);
    drawDonut(ctx, width / 2, side / 2, side * 0.37, side * 0.115, summary);
  }

  /* ------------------------------------------------------------------ *
   * 柱状图
   * ------------------------------------------------------------------ */
  function niceScale(maxValue) {
    if (!maxValue || maxValue <= 0) {
      return { max: 60, step: 30 };
    }
    var step = 15;
    if (maxValue > 60) {
      step = 30;
    }
    if (maxValue > 120) {
      step = 60;
    }
    if (maxValue > 240) {
      step = 120;
    }
    return { max: Math.max(step, Math.ceil(maxValue / step) * step), step: step };
  }

  function axisLabel(minutes) {
    if (minutes < 60) {
      return minutes + "m";
    }
    var hours = minutes / 60;
    return (Math.round(hours * 10) / 10).toString().replace(".0", "") + "h";
  }

  function modelMax(model) {
    var max = 0;
    model.forEach(function (item) {
      max = Math.max(max, item.total || 0);
    });
    return max;
  }

  function averageOf(model) {
    var active = model.filter(function (item) {
      return item.total > 0;
    });
    if (!active.length) {
      return 0;
    }
    var sum = active.reduce(function (total, item) {
      return total + item.total;
    }, 0);
    return sum / active.length;
  }

  function drawBars(ctx, model, box, options) {
    options = options || {};
    var padLeft = options.padLeft || 36;
    var padRight = options.padRight || 10;
    var padTop = options.padTop || 20;
    var padBottom = options.padBottom || 26;
    var plotX = box.x + padLeft;
    var plotY = box.y + padTop;
    var plotW = box.w - padLeft - padRight;
    var plotH = box.h - padTop - padBottom;

    if (!model.length) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 13px " + FONT_STACK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("这段时间还没有任务记录", box.x + box.w / 2, box.y + box.h / 2);
      return;
    }

    var scale = niceScale(modelMax(model));
    var scaleMax = scale.max;
    var gridCount = Math.round(scaleMax / scale.step);

    // 横向网格与纵轴刻度
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "500 10px " + FONT_STACK;
    for (var g = 0; g <= gridCount; g += 1) {
      var value = g * scale.step;
      var y = plotY + plotH - (value / scaleMax) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotX, Math.round(y) + 0.5);
      ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
      ctx.strokeStyle = g === 0 ? COLORS.axis : COLORS.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(axisLabel(value), plotX - 7, y);
    }

    var count = model.length;
    var slot = plotW / count;
    var barWidth = Math.max(3, Math.min(30, slot * 0.62));
    var radius = Math.min(4, barWidth / 2);
    var showValues = options.valueLabels !== false && barWidth >= 9;
    var labelEvery = options.labelEvery || (count > 20 ? 3 : count > 10 ? 2 : 1);

    // 平均线（具体数值显示在图表下方的说明文字里，避免与柱顶数字重叠）
    var average = averageOf(model);
    if (average > 0 && options.average !== false) {
      var averageY = plotY + plotH - (average / scaleMax) * plotH;
      ctx.save();
      ctx.setLineDash([4, 5]);
      ctx.beginPath();
      ctx.moveTo(plotX, averageY);
      ctx.lineTo(plotX + plotW, averageY);
      ctx.strokeStyle = "rgba(37, 99, 235, 0.38)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }

    model.forEach(function (item, index) {
      var slotCenter = plotX + slot * (index + 0.5);
      var x = slotCenter - barWidth / 2;
      var yBase = plotY + plotH;
      var total = Math.max(0, item.total || 0);
      var study = Math.max(0, Math.min(item.study || 0, total));
      var rest = Math.max(0, total - study);
      var totalHeight = total > 0 ? Math.max(2, (total / scaleMax) * plotH) : 0;
      var studyHeight = total > 0 ? (study / total) * totalHeight : 0;
      var restHeight = Math.max(0, totalHeight - studyHeight);

      if (total > 0) {
        if (study > 0 && rest > 0) {
          // 学习在下方（平顶），休息堆叠在上方（圆角）
          ctx.fillStyle = COLORS.study;
          ctx.fillRect(x, yBase - studyHeight, barWidth, studyHeight);
          roundRectTop(ctx, x, yBase - totalHeight, barWidth, restHeight, radius);
          ctx.fillStyle = COLORS.rest;
          ctx.fill();
        } else if (study > 0) {
          roundRectTop(ctx, x, yBase - studyHeight, barWidth, studyHeight, radius);
          ctx.fillStyle = COLORS.study;
          ctx.fill();
        } else {
          roundRectTop(ctx, x, yBase - restHeight, barWidth, restHeight, radius);
          ctx.fillStyle = COLORS.rest;
          ctx.fill();
        }
      }

      if (showValues && total > 0) {
        ctx.fillStyle = study > 0 ? COLORS.ink : "#b45309";
        ctx.font = "600 9px " + FONT_STACK;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(String(Math.round(total)), slotCenter, yBase - totalHeight - 5);
      }

      if (index % labelEvery === 0) {
        ctx.fillStyle = COLORS.muted;
        ctx.font = "500 9px " + FONT_STACK;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(item.label, slotCenter, plotY + plotH + 8);
      }
    });
  }

  function taskModel(records) {
    return (records || []).map(function (record, index) {
      var isRest = record.type === "rest";
      return {
        label: "#" + (index + 1),
        study: isRest ? 0 : record.minutes || 0,
        rest: isRest ? record.minutes || 0 : 0,
        total: record.minutes || 0
      };
    });
  }

  function dayModel(series) {
    return (series || []).map(function (day) {
      return {
        label: day.short,
        study: day.study || 0,
        rest: day.rest || 0,
        total: day.total || 0
      };
    });
  }

  function renderTaskBars(canvas, records) {
    var width = Math.round(canvas.clientWidth || 320);
    var height = Math.round(canvas.clientHeight || 180);
    var ctx = setupCanvas(canvas, width, height);
    drawBars(ctx, taskModel(records), { x: 0, y: 0, w: width, h: height }, {
      padLeft: 36,
      padRight: 10,
      padTop: 22,
      padBottom: 24,
      valueLabels: (records || []).length <= 14
    });
  }

  function renderDailyBars(canvas, series) {
    var width = Math.round(canvas.clientWidth || 320);
    var height = Math.round(canvas.clientHeight || 180);
    var ctx = setupCanvas(canvas, width, height);
    var list = series || [];
    drawBars(ctx, dayModel(list), { x: 0, y: 0, w: width, h: height }, {
      padLeft: 38,
      padRight: 10,
      padTop: 22,
      padBottom: 24,
      valueLabels: list.length <= 10
    });
  }

  /* ------------------------------------------------------------------ *
   * 导出 PNG
   * ------------------------------------------------------------------ */
  function triggerDownload(blob, filename) {
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

  function legendDot(ctx, x, y, color) {
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function exportPNG(payload) {
    return new Promise(function (resolve, reject) {
      var width = 1100;
      var height = 660;
      var dpr = 2;
      var canvas = document.createElement("canvas");
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      var ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("无法创建画布"));
        return;
      }
      ctx.scale(dpr, dpr);

      var isTasks = payload.mode !== "days";
      var title = isTasks ? "学习统计 · " + C.formatDateLabel(payload.date) : "学习统计 · " + payload.rangeLabel;
      var subtitle = isTasks
        ? C.formatDateLabel(payload.date) + " " + C.weekdayName(payload.date) + " · 数据保存在本机浏览器"
        : C.formatDateLabel(payload.start) + " 至 " + C.formatDateLabel(payload.end) + " · 数据保存在本机浏览器";

      // 背景与卡片
      ctx.fillStyle = COLORS.card;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      roundRect(ctx, 26, 26, width - 52, height - 52, 26);
      ctx.fill();
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 顶部标题
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = COLORS.ink;
      ctx.font = "700 32px " + FONT_STACK;
      ctx.fillText(title, 62, 94);

      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 15px " + FONT_STACK;
      ctx.fillText(subtitle, 62, 126);

      // 左侧环形图
      drawDonut(ctx, 312, 360, 138, 26, payload.summary, "总任务时长");

      // 环形图图例
      var legendY = 560;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";

      legendDot(ctx, 214, legendY, COLORS.study);
      ctx.fillStyle = COLORS.inkSoft;
      ctx.font = "600 14px " + FONT_STACK;
      ctx.fillText("学习 " + C.formatDuration(payload.summary.study), 230, legendY);

      legendDot(ctx, 392, legendY, COLORS.rest);
      ctx.fillStyle = COLORS.inkSoft;
      ctx.font = "600 14px " + FONT_STACK;
      ctx.fillText("休息 " + C.formatDuration(payload.summary.rest), 408, legendY);

      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 12px " + FONT_STACK;
      ctx.textAlign = "center";
      ctx.fillText(
        "共 " + payload.summary.count + " 次抽取 · 已完成 " + payload.summary.done + " 项",
        312,
        legendY + 34
      );

      // 右侧柱状图
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = COLORS.ink;
      ctx.font = "700 17px " + FONT_STACK;
      ctx.fillText(isTasks ? "每次任务时长（分钟）" : "每日学习 / 休息时长（分钟）", 590, 182);

      var chartModel = isTasks ? taskModel(payload.records) : dayModel(payload.series);
      var chartAverage = Math.round(averageOf(chartModel));
      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 12px " + FONT_STACK;
      ctx.fillText(
        isTasks
          ? "虚线为平均 " + chartAverage + "min"
          : "蓝色为学习 · 橙色为休息 · 虚线为日均 " + chartAverage + "min",
        590,
        204
      );

      drawBars(
        ctx,
        chartModel,
        { x: 590, y: isTasks ? 212 : 220, w: 450, h: isTasks ? 292 : 284 },
        { padLeft: 44, padRight: 14, padTop: 24, padBottom: 26, valueLabels: isTasks ? payload.records.length <= 20 : payload.series.length <= 10 }
      );

      // 底部汇总
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(62, 588);
      ctx.lineTo(width - 62, 588);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = COLORS.inkSoft;
      ctx.font = "600 14px " + FONT_STACK;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      var footer = isTasks
        ? "共 " + payload.summary.count + " 次抽取 · 已完成 " + payload.summary.done + " 项 · 平均每次 " +
          (payload.summary.count ? Math.round(payload.summary.total / payload.summary.count) : 0) + "min"
        : payload.rangeLabel + "累计 · 有记录 " + payload.activeDays + " 天 · 日均学习 " +
          C.formatDuration(payload.averageStudy);
      ctx.fillText(footer, 62, 614);

      ctx.fillStyle = COLORS.muted;
      ctx.font = "600 12px " + FONT_STACK;
      ctx.textAlign = "right";
      ctx.fillText("STUDY TURNTABLE", width - 62, 614);

      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("图表导出失败"));
          return;
        }
        var suffix = "";
        if (!isTasks) {
          suffix = payload.rangeKey === "month" ? "-30d" : "-7d";
        }
        var filename =
          "study-turntable-chart-" + String(payload.date).replace(/-/g, "") + suffix + ".png";
        triggerDownload(blob, filename);
        resolve(filename);
      }, "image/png");
    });
  }

  root.STCharts = {
    renderDonut: renderDonut,
    renderTaskBars: renderTaskBars,
    renderDailyBars: renderDailyBars,
    exportPNG: exportPNG
  };
})(typeof self !== "undefined" ? self : this);