/*
 * Study Turntable — 统计图表
 * Canvas 手绘环形图 + 柱状图，并支持把当前统计导出为 PNG。
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
    muted: "#7c93b8",
    grid: "#e3edfb",
    track: "#eef4ff",
    card: "#f7fbff",
    border: "#e3edfb"
  };

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

  function setupCanvas(canvas, width, height) {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  /* ------------------------------------------------------------------ *
   * 环形图
   * ------------------------------------------------------------------ */
  function drawDonut(ctx, centerX, centerY, radius, thickness, summary, labelSize) {
    var total = summary.study + summary.rest;

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.lineWidth = thickness;
    ctx.strokeStyle = COLORS.track;
    ctx.stroke();

    if (total > 0) {
      var startAngle = -Math.PI / 2;
      var studyAngle = (summary.study / total) * Math.PI * 2;

      if (summary.study > 0) {
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, startAngle, startAngle + studyAngle);
        ctx.lineWidth = thickness;
        ctx.strokeStyle = COLORS.study;
        ctx.stroke();
      }
      if (summary.rest > 0) {
        var restStart = startAngle + studyAngle;
        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, restStart, startAngle + Math.PI * 2);
        ctx.lineWidth = thickness;
        ctx.strokeStyle = COLORS.rest;
        ctx.stroke();
      }
    }

    var totalLabel = total > 0 ? C.formatDuration(total) : "暂无数据";
    var size = fitFont(ctx, totalLabel, radius * 1.45, labelSize || 22, "700");
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = COLORS.ink;
    ctx.font = "700 " + size + "px " + FONT_STACK;
    ctx.fillText(totalLabel, centerX, centerY - 4);

    ctx.fillStyle = COLORS.muted;
    ctx.font = "500 11px " + FONT_STACK;
    ctx.fillText("总任务时长", centerX, centerY + 16);
  }

  function renderDonut(canvas, summary) {
    var size = Math.round(canvas.clientWidth || 200);
    var height = Math.round(canvas.clientHeight || size);
    var side = Math.min(size, height);
    var ctx = setupCanvas(canvas, size, side);
    var radius = side * 0.39;
    var thickness = side * 0.12;
    drawDonut(ctx, size / 2, side / 2, radius, thickness, summary, Math.round(side * 0.115));
  }

  /* ------------------------------------------------------------------ *
   * 柱状图（每次任务的时长，按时间顺序）
   * ------------------------------------------------------------------ */
  function scaleMaxFor(records) {
    var max = 0;
    records.forEach(function (record) {
      max = Math.max(max, record.minutes || 0);
    });
    if (max <= 30) {
      return 30;
    }
    if (max <= 60) {
      return 60;
    }
    if (max <= 90) {
      return 90;
    }
    return 120;
  }

  function drawBars(ctx, records, box, options) {
    options = options || {};
    var padLeft = options.padLeft || 34;
    var padRight = options.padRight || 8;
    var padTop = options.padTop || 22;
    var padBottom = options.padBottom || 26;
    var plotX = box.x + padLeft;
    var plotY = box.y + padTop;
    var plotW = box.w - padLeft - padRight;
    var plotH = box.h - padTop - padBottom;

    if (!records.length) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 13px " + FONT_STACK;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("当日还没有任务记录", box.x + box.w / 2, box.y + box.h / 2);
      return;
    }

    var scaleMax = options.scaleMax || scaleMaxFor(records);
    var gridSteps = Math.round(scaleMax / 30);

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.font = "500 10px " + FONT_STACK;
    for (var g = 0; g <= gridSteps; g++) {
      var value = g * 30;
      var y = plotY + plotH - (value / scaleMax) * plotH;
      ctx.beginPath();
      ctx.moveTo(plotX, Math.round(y) + 0.5);
      ctx.lineTo(plotX + plotW, Math.round(y) + 0.5);
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(value + "m", plotX - 6, y);
    }

    var count = records.length;
    var slot = plotW / count;
    var barWidth = Math.max(3, Math.min(26, slot * 0.6));
    var showValues = count <= (options.valueLabelLimit || 16);
    var xLabelEvery = count > 20 ? 3 : count > 14 ? 2 : 1;

    var average = records.reduce(function (total, record) {
      return total + (record.minutes || 0);
    }, 0) / count;

    // 平均线
    var averageY = plotY + plotH - (average / scaleMax) * plotH;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(plotX, averageY);
    ctx.lineTo(plotX + plotW, averageY);
    ctx.strokeStyle = "rgba(37, 99, 235, 0.45)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    records.forEach(function (record, index) {
      var slotCenter = plotX + slot * (index + 0.5);
      var barHeight = Math.max(2, ((record.minutes || 0) / scaleMax) * plotH);
      var x = slotCenter - barWidth / 2;
      var y = plotY + plotH - barHeight;
      var isRest = record.type === "rest";

      roundRect(ctx, x, y, barWidth, barHeight, Math.min(4, barWidth / 2));
      ctx.fillStyle = isRest ? COLORS.rest : COLORS.study;
      ctx.fill();

      if (showValues && barWidth >= 8) {
        ctx.fillStyle = isRest ? "#b45309" : COLORS.ink;
        ctx.font = "600 9px " + FONT_STACK;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(String(record.minutes), slotCenter, y - 4);
      }

      if (index % xLabelEvery === 0) {
        ctx.fillStyle = COLORS.muted;
        ctx.font = "500 9px " + FONT_STACK;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("#" + (index + 1), slotCenter, plotY + plotH + 8);
      }
    });

    // 平均线标签
    ctx.fillStyle = "rgba(37, 99, 235, 0.85)";
    ctx.font = "600 9px " + FONT_STACK;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("平均 " + Math.round(average) + "min", plotX + 4, averageY - 4);
  }

  function renderBars(canvas, records) {
    var width = Math.round(canvas.clientWidth || 320);
    var height = Math.round(canvas.clientHeight || 180);
    var ctx = setupCanvas(canvas, width, height);
    drawBars(ctx, records, { x: 0, y: 0, w: width, h: height }, {
      padLeft: Math.min(36, Math.max(28, width * 0.1)),
      valueLabelLimit: 15
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

  function exportPNG(payload) {
    return new Promise(function (resolve, reject) {
      var width = 1080;
      var height = 640;
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

      // 背景
      ctx.fillStyle = "#f4f8ff";
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "#ffffff";
      roundRect(ctx, 28, 28, width - 56, height - 56, 26);
      ctx.fill();
      ctx.strokeStyle = COLORS.border;
      ctx.lineWidth = 2;
      ctx.stroke();

      // 标题
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = COLORS.ink;
      ctx.font = "700 34px " + FONT_STACK;
      ctx.fillText("Study Turntable · 学习统计", 60, 96);

      ctx.fillStyle = COLORS.muted;
      ctx.font = "500 16px " + FONT_STACK;
      ctx.fillText(
        C.formatDateLabel(payload.date) + " " + C.weekdayName(payload.date) + " · 数据保存在本机浏览器",
        60,
        128
      );

      // 左侧环形图
      drawDonut(ctx, 300, 350, 136, 34, payload.summary, 30);

      // 图例
      var legendY = 530;
      ctx.textBaseline = "middle";
      ctx.fillStyle = COLORS.study;
      ctx.beginPath();
      ctx.arc(222, legendY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.ink;
      ctx.font = "600 15px " + FONT_STACK;
      ctx.fillText("学习 " + C.formatDuration(payload.summary.study), 238, legendY);

      ctx.fillStyle = COLORS.rest;
      ctx.beginPath();
      ctx.arc(390, legendY, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.ink;
      ctx.font = "600 15px " + FONT_STACK;
      ctx.fillText("休息 " + C.formatDuration(payload.summary.rest), 406, legendY);

      // 右侧柱状图
      ctx.fillStyle = COLORS.ink;
      ctx.font = "700 18px " + FONT_STACK;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText("每次任务时长（分钟）", 540, 186);

      drawBars(
        ctx,
        payload.records,
        { x: 540, y: 208, w: 460, h: 300 },
        { padLeft: 42, padRight: 12, padTop: 24, padBottom: 28, valueLabelLimit: 20 }
      );

      // 底部汇总
      ctx.fillStyle = COLORS.grid;
      ctx.beginPath();
      ctx.moveTo(60, 578);
      ctx.lineTo(width - 60, 578);
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = COLORS.ink;
      ctx.font = "600 15px " + FONT_STACK;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        "共 " + payload.summary.count + " 次抽取 · 已完成 " + payload.summary.done + " 项 · 平均每次 " +
        (payload.summary.count ? Math.round(payload.summary.total / payload.summary.count) : 0) + "min",
        60,
        602
      );

      ctx.fillStyle = COLORS.muted;
      ctx.font = "600 13px " + FONT_STACK;
      ctx.textAlign = "right";
      ctx.fillText("STUDY TURNTABLE", width - 60, 602);

      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error("图表导出失败"));
          return;
        }
        var filename = "study-turntable-chart-" + String(payload.date).replace(/-/g, "") + ".png";
        triggerDownload(blob, filename);
        resolve(filename);
      }, "image/png");
    });
  }

  root.STCharts = {
    renderDonut: renderDonut,
    renderBars: renderBars,
    exportPNG: exportPNG
  };
})(typeof self !== "undefined" ? self : this);