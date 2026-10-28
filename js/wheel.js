/*
 * Study Turntable — 转盘渲染与旋转动画
 * 使用 Canvas 绘制 30 个扇区，通过 CSS transform 旋转整个画布，
 * 由 requestAnimationFrame 驱动缓动，最终角度由核心逻辑计算。
 */
(function (root) {
  "use strict";

  var C = root.STCore;
  var FONT_STACK = '"Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

  function Wheel(canvas, segments) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.segments = segments || C.WHEEL;
    this.count = this.segments.length;
    this.rotation = 0;
    this.highlightIndex = -1;
    this.spinning = false;
    this.size = 420;
    this.dpr = 1;
    this._raf = null;

    this._onResize = this.resize.bind(this);
    window.addEventListener("resize", this._onResize);

    if (typeof ResizeObserver !== "undefined" && canvas.parentElement) {
      var self = this;
      this._observer = new ResizeObserver(function () {
        self.resize();
      });
      this._observer.observe(canvas.parentElement);
    }

    this.resize();
  }

  Wheel.prototype.resize = function () {
    var wrap = this.canvas.parentElement;
    var size = Math.round((wrap && wrap.clientWidth) || this.canvas.clientWidth || 420);
    if (size < 160) {
      size = 160;
    }
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    var pixel = Math.round(size * dpr);

    this.size = size;
    this.dpr = dpr;

    if (this.canvas.width !== pixel || this.canvas.height !== pixel) {
      this.canvas.width = pixel;
      this.canvas.height = pixel;
    }

    this.draw();
  };

  Wheel.prototype.draw = function () {
    var ctx = this.ctx;
    if (!ctx) {
      return;
    }

    var size = this.size;
    var dpr = this.dpr;
    var center = size / 2;
    var radius = size / 2 - 3;
    var step = (Math.PI * 2) / this.count;
    var fontSize = Math.max(9, Math.min(13, Math.round(size * 0.026)));
    var labelRadius = radius * 0.94;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // 底圆，避免抗锯齿出现白边
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fillStyle = "#eaf2ff";
    ctx.fill();

    for (var i = 0; i < this.count; i++) {
      var segment = this.segments[i];
      var startAngle = -Math.PI / 2 + i * step;
      var endAngle = startAngle + step;

      ctx.beginPath();
      ctx.moveTo(center, center);
      ctx.arc(center, center, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = segment.color;
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
      ctx.stroke();

      if (i === this.highlightIndex) {
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#ffffff";
        ctx.shadowColor = "rgba(15, 42, 92, 0.55)";
        ctx.shadowBlur = 8;
        ctx.stroke();
        ctx.restore();
      }

      var midAngle = startAngle + step / 2;
      ctx.save();
      ctx.translate(center, center);
      ctx.fillStyle = segment.textColor;
      ctx.font = "600 " + fontSize + "px " + FONT_STACK;
      ctx.textBaseline = "middle";
      if (Math.cos(midAngle) >= 0) {
        ctx.rotate(midAngle);
        ctx.textAlign = "right";
        ctx.fillText(segment.label, labelRadius, 0);
      } else {
        ctx.rotate(midAngle + Math.PI);
        ctx.textAlign = "left";
        ctx.fillText(segment.label, -labelRadius, 0);
      }
      ctx.restore();
    }

    // 外圈描边
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(147, 197, 253, 0.8)";
    ctx.stroke();
  };

  Wheel.prototype.setRotation = function (rotation) {
    this.rotation = ((rotation % 360) + 360) % 360;
    this.canvas.style.transform = "rotate(" + this.rotation + "deg)";
  };

  Wheel.prototype.resetHighlight = function () {
    this.highlightIndex = -1;
    this.draw();
  };

  Wheel.prototype.spinTo = function (index, options) {
    var self = this;
    options = options || {};

    if (this.spinning) {
      return Promise.reject(new Error("Wheel is already spinning"));
    }

    this.spinning = true;
    this.highlightIndex = -1;

    var reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var duration = options.duration || (reduceMotion ? 900 : 4200);
    var turns = reduceMotion ? 2 : 5 + Math.floor(Math.random() * 2);
    var from = this.rotation;
    var to = C.planSpin(from, index, this.count, turns);
    var startTime = null;

    return new Promise(function (resolve) {
      function frame(now) {
        if (startTime === null) {
          startTime = now;
        }
        var progress = Math.min(1, (now - startTime) / duration);
        var eased = 1 - Math.pow(1 - progress, 4);
        var current = from + (to - from) * eased;
        self.canvas.style.transform = "rotate(" + current + "deg)";

        if (progress < 1) {
          self._raf = requestAnimationFrame(frame);
          return;
        }

        self._raf = null;
        self.rotation = ((to % 360) + 360) % 360;
        self.canvas.style.transform = "rotate(" + self.rotation + "deg)";
        self.highlightIndex = index;
        self.draw();
        self.spinning = false;
        resolve({ index: index, rotation: self.rotation });
      }

      self._raf = requestAnimationFrame(frame);
    });
  };

  root.STWheel = Wheel;
})(typeof self !== "undefined" ? self : this);