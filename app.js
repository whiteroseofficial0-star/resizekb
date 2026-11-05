/* ResizeKB — in-browser image resizing, batch export and PDF output. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var $$ = function (selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  };

  var Lib = window.ResizeKBLib;
  var MAX_BYTES = 25 * 1024 * 1024;
  var MAX_PIXELS = 100 * 1000 * 1000;
  var MAX_SIDE = 8000;
  var MAX_FILES = 30;
  var MIN_CROP = 24;

  var EMPTY_PREVIEW =
    '<div class="preview__empty">' +
    '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.8"/><path d="m21 15-4.5-4.5L6 21"/></svg>' +
    '<p>Your resized image appears here.</p>' +
    '<p class="note">Size, dimensions and pass/fail are measured on the real output file.</p>' +
    '</div>';

  var BUILTIN = [
    { name: 'Custom (enter your own)', custom: true },
    { name: 'Example: 200 × 230 px, 20–50 KB', w: 200, h: 230, min: 20, max: 50, fmt: 'image/jpeg', fit: 'cover', mode: 'C', kind: 'photo' },
    { name: 'Example: signature 140 × 60 px, 10–20 KB', w: 140, h: 60, min: 10, max: 20, fmt: 'image/jpeg', fit: 'contain', mode: 'C', kind: 'sig' },
    { name: 'Example: 3.5 × 4.5 cm at 300 DPI (413 × 531 px)', w: 413, h: 531, min: 20, max: 100, fmt: 'image/jpeg', fit: 'cover', mode: 'C', kind: 'photo', dpi: 300 }
  ];

  var state = {
    files: [],
    activeId: null,
    bmp: null,
    base: null,
    beforeUrl: '',
    rot: 0,
    flipH: false,
    flipV: false,
    crop: null,
    out: null,
    outUrl: '',
    outName: 'image',
    pdf: null
  };

  var busy = false;
  var pdfBusy = false;
  var drag = null;
  var compareDrag = false;
  var split = 50;
  var uid = 0;
  var dragDepth = 0;

  /* ---------- small helpers ---------- */

  function clamp(value, min, max) { return Math.min(Math.max(value, min), max); }
  function esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtKB(bytes) {
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
  }
  function extOf(fmt) {
    return fmt === 'image/png' ? 'png' : fmt === 'image/webp' ? 'webp' : 'jpg';
  }
  function fileBase(name) {
    return String(name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_').slice(0, 40) || 'image';
  }
  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a || 1;
  }
  function ratioLabel(w, h) {
    w = Math.round(w); h = Math.round(h);
    var d = gcd(w, h);
    var a = w / d, b = h / d;
    return (a <= 40 && b <= 40) ? a + ':' + b : (w / h).toFixed(2) + ':1';
  }
  function findFile(id) {
    for (var i = 0; i < state.files.length; i++) if (state.files[i].id === id) return state.files[i];
    return null;
  }
  function activeEntry() { return findFile(state.activeId); }

  function toast(message, kind) {
    var box = $('toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'bad' ? ' toast--bad' : '');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(function () {
      el.classList.add('is-out');
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 3600);
  }

  function downloadBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  /* ---------- stage video + menu ---------- */

  function initStageVideo() {
    var stage = $('stage');
    var video = $('stageVideo');
    if (!stage || !video) return;

    function reveal() { stage.classList.add('has-video'); }
    video.addEventListener('loadeddata', reveal);
    video.addEventListener('canplay', reveal);
    video.addEventListener('playing', reveal);
    video.addEventListener('error', function () { stage.classList.remove('has-video'); });
    if (video.readyState >= 2) reveal();

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    function applyMotion() {
      if (reduce && reduce.matches) {
        video.pause();
        return;
      }
      var played = video.play();
      if (played && played.catch) played.catch(function () { /* autoplay blocked: gradient fallback stays */ });
    }
    applyMotion();
    if (reduce && reduce.addEventListener) reduce.addEventListener('change', applyMotion);
  }

  function initMenu() {
    var btn = $('menuBtn');
    var menu = $('mobileMenu');
    if (!btn || !menu) return;

    function setOpen(open) {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }

    btn.addEventListener('click', function () {
      setOpen(menu.hidden);
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !menu.hidden) {
        setOpen(false);
        btn.focus();
      }
    });
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (e.target.closest('#mobileMenu') || e.target.closest('#menuBtn')) return;
      setOpen(false);
    });
    setOpen(false);
  }

  /* ---------- motion ---------- */

  function initMotion() {
    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!('IntersectionObserver' in window)) return;

    var targets = $$('.masthead__row, .hero__title, .hero__sub, .hero__cta, .hero__meta, .app__head, .card, .footer')
      .filter(function (el) { return !el.hidden; });
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
        entry.target.addEventListener('transitionend', function () {
          entry.target.style.transitionDelay = '';
        }, { once: true });
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -6% 0px' });

    targets.forEach(function (el, index) {
      el.classList.add('reveal');
      el.style.transitionDelay = Math.min(index * 45, 220) + 'ms';
      observer.observe(el);
    });
  }

  /* ---------- form helpers ---------- */

  function mode() {
    var el = document.querySelector('input[name="mode"]:checked');
    return el ? el.value : 'A';
  }

  function setMode(value) {
    var el = document.querySelector('input[name="mode"][value="' + value + '"]');
    if (el) el.checked = true;
  }

  function settings() {
    var m = mode();
    var sized = m !== 'A';
    return {
      mode: m,
      fmt: $('fmt').value,
      fit: $('fit').value,
      bg: $('bg').value,
      q: (+$('q').value) / 100,
      dpi: +$('dpi').value || 0,
      sig: $('kind').value === 'sig',
      brightness: +$('br').value,
      contrast: +$('ct').value,
      max: sized ? Math.round((parseFloat($('maxkb').value) || 0) * 1024) : 0,
      min: sized ? Math.round((parseFloat($('minkb').value) || 0) * 1024) : 0,
      w: Math.round(+$('w').value || 0),
      h: Math.round(+$('h').value || 0),
      stamp: stampConfig()
    };
  }

  function updateGoLabel() {
    if (busy) return;
    var n = state.files.length;
    $('go').querySelector('.btn__label').textContent = n > 1 ? 'Process all ' + n + ' images' : 'Process image';
  }

  function updateButtons() {
    var has = !!state.base;
    $('go').disabled = busy || !has;
    ['rotL', 'rotR', 'flipH', 'flipV', 'cropClear'].forEach(function (id) {
      $(id).disabled = !has || busy;
    });
    $('cropToggle').disabled = !has || busy;
    $('pdfgo').disabled = !has || busy;
    $('dl').disabled = !state.out || busy;
    $('copy').disabled = !state.out || busy;
    $('zipBtn').disabled = busy || !state.files.some(function (f) { return f.status === 'done'; });
    $('clearQueue').disabled = busy || !state.files.length;
  }

  function updateBatchNote() {
    var note = $('batchNote');
    var n = state.files.length;
    if (n > 1 && !busy) {
      note.hidden = false;
      note.textContent = 'These settings apply to all ' + n + ' queued images. Rotation is applied to every image; cropping is skipped in batch mode.';
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }

  function sync() {
    var m = mode();
    var fmt = $('fmt').value;
    $('dimrow').hidden = m === 'B';
    $('szrow').hidden = m === 'A';
    $('adj').hidden = $('kind').value !== 'sig';

    var autoQuality = m !== 'A';
    $('q').disabled = autoQuality;
    $('qfield').classList.toggle('is-disabled', autoQuality);
    $('qhint').textContent = m === 'A'
      ? 'Used for the exact-size export.'
      : (fmt === 'image/png'
        ? 'PNG is lossless, so quality does not apply; dimensions are reduced instead.'
        : 'Tuned automatically between 5% and 95% to fit inside your limit.');

    $('modeNote').textContent = {
      A: 'Draws the image at exactly these pixels, then compresses at your chosen quality.',
      B: 'Keeps the current dimensions and searches quality — then scales down if needed — to stay under the limit.',
      C: 'Keeps these exact pixels and stays inside the KB range. If the limit is unreachable, the result says so.'
    }[m];

    var stretch = $('fit').value === 'stretch';
    $('fitwarn').hidden = !stretch;
    $('fitwarn').textContent = stretch ? 'Stretching distorts the image when the shape differs from the crop.' : '';

    updateGoLabel();
    updateButtons();
  }

  function setBusy(value) {
    busy = value;
    var go = $('go');
    go.classList.toggle('is-busy', value);
    go.setAttribute('aria-busy', value ? 'true' : 'false');
    if (value) {
      go.disabled = true;
      go.querySelector('.btn__label').textContent = 'Processing…';
    } else {
      updateGoLabel();
    }
    updateBatchNote();
    updateButtons();
    renderQueue();
    renderBatch();
  }

  /* ---------- file intake ---------- */

  function sniff(file) {
    return file.slice(0, 12).arrayBuffer().then(function (buffer) {
      var b = new Uint8Array(buffer);
      if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'JPEG';
      if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'PNG';
      if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'WebP';
      return null;
    });
  }

  async function addFiles(list) {
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;
    var errors = [];
    var added = [];

    for (var i = 0; i < files.length; i++) {
      if (state.files.length >= MAX_FILES) {
        errors.push('You can queue up to ' + MAX_FILES + ' images.');
        break;
      }
      var file = files[i];
      try {
        if (file.size > MAX_BYTES) throw new Error((file.name || 'That file') + ' is larger than 25 MB.');
        var type = await sniff(file);
        if (!type) throw new Error((file.name || 'That file') + ' is not a real JPG, PNG or WebP image.');
        var entry = {
          id: ++uid,
          file: file,
          name: file.name || 'image',
          type: type,
          size: file.size,
          status: 'ready',
          out: null,
          msg: '',
          beforeUrl: ''
        };
        state.files.push(entry);
        added.push(entry);
      } catch (err) {
        errors.push(err.message);
      }
    }

    var msg = $('upmsg');
    if (errors.length) {
      msg.className = 'msg msg--bad';
      msg.textContent = errors.join(' ');
    } else {
      msg.className = 'msg';
      msg.textContent = '';
    }

    if (!state.activeId && added.length) {
      await selectFile(added[0].id);
    } else if (added.length > 1) {
      toast(added.length + ' images added to the queue');
    }

    renderQueue();
    renderBatch();
    updateBatchNote();
    updateGoLabel();
    updateButtons();
  }

  async function selectFile(id) {
    var entry = findFile(id);
    if (!entry) return;

    state.activeId = id;
    clearOut();
    closeCrop();
    renderQueue();

    if (state.bmp && state.bmp.close) state.bmp.close();
    state.bmp = null;
    state.base = null;
    state.crop = null;

    state.beforeUrl = '';
    $('upmsg').className = 'msg';
    $('upmsg').textContent = '';

    try {
      var bmp = await createImageBitmap(entry.file, { imageOrientation: 'from-image' });
      if (bmp.width * bmp.height > MAX_PIXELS) {
        bmp.close();
        throw new Error('That image has more than 100 megapixels.');
      }
      state.bmp = bmp;
      state.rot = 0;
      state.flipH = false;
      state.flipV = false;
      rebuildBase();
      showFacts(entry, bmp);
      if (mode() === 'B' && !$('maxkb').value) {
        $('maxkb').value = Math.max(10, Math.round(entry.size / 2048));
      }
    } catch (err) {
      entry.status = 'error';
      entry.msg = err.message || 'Could not read that file.';
      $('upmsg').className = 'msg msg--bad';
      $('upmsg').textContent = entry.name + ': ' + entry.msg;
      state.base = null;
      $('srcinfo').hidden = true;
      $('srcinfo').innerHTML = '';
    }

    renderQueue();
    renderBatch();
    updateGoLabel();
    updateButtons();
  }

  function showFacts(entry, bmp) {
    var facts = [
      ['File', entry.name],
      ['Type', entry.type],
      ['Size', fmtKB(entry.size)],
      ['Dimensions', bmp.width + ' × ' + bmp.height + ' px'],
      ['Aspect', ratioLabel(bmp.width, bmp.height)]
    ];
    $('srcinfo').innerHTML = facts.map(function (f) {
      return '<div class="fact"><span>' + esc(f[0]) + '</span><strong title="' + esc(f[1]) + '">' + esc(f[1]) + '</strong></div>';
    }).join('');
    $('srcinfo').hidden = false;
  }

  function renderQueue() {
    var queue = $('queue');
    var multi = state.files.length > 1;
    $('fileCount').textContent = state.files.length
      ? state.files.length + (state.files.length === 1 ? ' image' : ' images')
      : '';
    queue.hidden = !multi;
    if (!multi) {
      queue.innerHTML = '';
      return;
    }
    queue.innerHTML = state.files.map(function (f) {
      var meta = fmtKB(f.size);
      if (f.status === 'done' && f.out) meta = f.out.w + '×' + f.out.h + ' · ' + fmtKB(f.out.blob.size);
      else if (f.status === 'error') meta = 'failed';
      else if (f.status === 'working') meta = 'working…';
      return '<li class="queue__item' + (f.id === state.activeId ? ' is-active' : '') + '" data-id="' + f.id + '">' +
        '<button type="button" class="queue__main" data-pick="' + f.id + '"' + (busy ? ' disabled' : '') + '>' +
        '<span class="queue__dot queue__dot--' + (f.status === 'done' ? 'done' : f.status === 'error' ? 'error' : f.status === 'working' ? 'working' : 'ready') + '" aria-hidden="true"></span>' +
        '<span class="queue__name">' + esc(f.name) + '</span>' +
        '<span class="queue__meta">' + esc(meta) + '</span>' +
        '</button>' +
        '<button type="button" class="queue__x" data-remove="' + f.id + '" aria-label="Remove ' + esc(f.name) + '"' + (busy ? ' disabled' : '') + '>×</button>' +
        '</li>';
    }).join('');
  }

  function removeFile(id) {
    if (busy) return;
    var index = -1;
    for (var i = 0; i < state.files.length; i++) {
      if (state.files[i].id === id) { index = i; break; }
    }
    if (index < 0) return;
    state.files.splice(index, 1);

    if (state.activeId === id) {
      state.activeId = null;
      if (state.files.length) {
        selectFile(state.files[Math.min(index, state.files.length - 1)].id);
      } else {
        resetView();
      }
    }
    renderQueue();
    renderBatch();
    updateBatchNote();
    updateGoLabel();
    updateButtons();
  }

  function resetView() {
    if (state.bmp && state.bmp.close) state.bmp.close();
    state.bmp = null;
    state.base = null;
    state.beforeUrl = '';
    state.crop = null;
    state.rot = 0;
    state.flipH = false;
    state.flipV = false;
    clearOut();
    closeCrop();
    $('srcinfo').hidden = true;
    $('srcinfo').innerHTML = '';
    $('batchCard').hidden = true;
  }

  function clearQueue() {
    if (busy) return;
    var had = state.files.length;
    state.files = [];
    state.activeId = null;
    resetView();
    $('queue').hidden = true;
    $('queue').innerHTML = '';
    $('upmsg').className = 'msg';
    $('upmsg').textContent = '';
    $('fileCount').textContent = '';
    $('batchTable').innerHTML = '';
    updateBatchNote();
    updateGoLabel();
    updateButtons();
    if (had) toast('Queue cleared');
  }

  /* ---------- canvas pipeline ---------- */

  function makeBase(bmp, rot, flipH, flipV) {
    var swap = ((rot / 90) % 2) !== 0;
    var w = swap ? bmp.height : bmp.width;
    var h = swap ? bmp.width : bmp.height;
    var canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    var ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(w / 2, h / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1);
    ctx.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    return canvas;
  }

  function rebuildBase() {
    if (!state.bmp) { state.base = null; return; }
    state.base = makeBase(state.bmp, state.rot, state.flipH, state.flipV);
    state.crop = null;
    state.beforeUrl = snapshot(state.base);
    if (!$('cropWrap').hidden) paintCropStage();
    updateButtons();
  }

  function snapshot(canvas) {
    try {
      var scale = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
      var copy = document.createElement('canvas');
      copy.width = Math.max(1, Math.round(canvas.width * scale));
      copy.height = Math.max(1, Math.round(canvas.height * scale));
      var ctx = copy.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, copy.width, copy.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(canvas, 0, 0, copy.width, copy.height);
      return copy.toDataURL('image/jpeg', 0.88);
    } catch (e) {
      return '';
    }
  }

  /* ---------- stamp ---------- */

  var STAMP_SIZES = { small: 0.045, medium: 0.065, large: 0.09 };
  var STAMP_POSITIONS = ['br', 'bl', 'bc', 'tr', 'tl'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function todayStamp() {
    var d = new Date();
    return pad2(d.getDate()) + '-' + pad2(d.getMonth() + 1) + '-' + d.getFullYear();
  }

  function stampLines() {
    if (!$('stampOn').checked) return [];
    var lines = [];
    var text = $('stampText').value.trim().replace(/\s+/g, ' ').slice(0, 40);
    if (text) lines.push(text);
    if ($('stampDate').checked) lines.push(todayStamp());
    return lines;
  }

  function stampConfig() {
    var lines = stampLines();
    if (!lines.length) return null;
    return {
      lines: lines,
      pos: STAMP_POSITIONS.indexOf($('stampPos').value) > -1 ? $('stampPos').value : 'br',
      size: STAMP_SIZES[$('stampSize').value] ? $('stampSize').value : 'medium',
      color: /^#[0-9a-f]{6}$/i.test($('stampColor').value) ? $('stampColor').value : '#111111'
    };
  }

  function syncStamp() {
    var on = $('stampOn').checked;
    $('stampFields').hidden = !on;
    var note = $('stampNote');
    if (!on) {
      note.textContent = '';
      return;
    }
    var lines = stampLines();
    note.textContent = lines.length
      ? 'Will draw \u201c' + lines.join(' \u00b7 ') + '\u201d inside every output, including batch and PDF.'
      : 'Add some text or tick the date, otherwise nothing is drawn.';
  }

  function drawStamp(ctx, w, h, cfg) {
    var ratio = STAMP_SIZES[cfg.size] || 0.065;
    var pad = Math.max(5, Math.round(Math.min(w, h) * 0.035));
    var fs = Math.max(8, Math.round(Math.min(w, h) * ratio));
    var font = function (size) { return '600 ' + size + 'px Inter, "Segoe UI", system-ui, sans-serif'; };

    ctx.save();
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    /* Shrink until the longest line fits inside the image. */
    var widths = [];
    var widest = 0;
    for (;;) {
      ctx.font = font(fs);
      widths = cfg.lines.map(function (line) { return ctx.measureText(line).width; });
      widest = Math.max.apply(null, widths);
      if (widest <= w - 2 * pad || fs <= 7) break;
      fs -= 1;
    }

    var lineH = Math.round(fs * 1.28);
    var blockH = lineH * (cfg.lines.length - 1) + fs;
    var top = /^b/.test(cfg.pos) ? h - pad - blockH : pad;

    var rgb = cfg.color.slice(1);
    var r = parseInt(rgb.slice(0, 2), 16);
    var g = parseInt(rgb.slice(2, 4), 16);
    var b = parseInt(rgb.slice(4, 6), 16);
    var light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.55;

    ctx.fillStyle = cfg.color;
    ctx.shadowColor = light ? 'rgba(0, 0, 0, 0.72)' : 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = Math.max(2, Math.round(fs * 0.45));

    cfg.lines.forEach(function (line, i) {
      var x = pad;
      if (cfg.pos === 'br' || cfg.pos === 'tr') x = w - pad - widths[i];
      else if (cfg.pos === 'bc') x = (w - widths[i]) / 2;
      ctx.fillText(line, x, top + i * lineH);
    });
    ctx.restore();
  }

  function paint(base, crop, w, h, s) {
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w));
    canvas.height = Math.max(1, Math.round(h));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = s.bg || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (s.sig) {
      try {
        ctx.filter = 'brightness(' + s.brightness + '%) contrast(' + s.contrast + '%)';
      } catch (e) { /* canvas filters are optional */ }
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var sx = crop ? crop.x : 0;
    var sy = crop ? crop.y : 0;
    var sw = crop ? crop.w : base.width;
    var sh = crop ? crop.h : base.height;

    if (s.fit === 'stretch') {
      ctx.drawImage(base, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } else {
      var scale = s.fit === 'contain'
        ? Math.min(canvas.width / sw, canvas.height / sh)
        : Math.max(canvas.width / sw, canvas.height / sh);
      var dw = sw * scale;
      var dh = sh * scale;
      ctx.drawImage(base, sx, sy, sw, sh, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    }

    /* Canvas filters would also tint the stamp, so switch them off first. */
    try { ctx.filter = 'none'; } catch (e) { /* canvas filters are optional */ }
    if (s.stamp) drawStamp(ctx, canvas.width, canvas.height, s.stamp);
    return canvas;
  }

  function toBlob(canvas, type, quality) {
    return new Promise(function (resolve) {
      if (quality == null || type === 'image/png') canvas.toBlob(resolve, type);
      else canvas.toBlob(resolve, type, quality);
    });
  }

  async function encode(canvas, type, quality, dpi) {
    var blob = await toBlob(canvas, type, quality);
    if (!blob) throw new Error('The browser could not encode this image. Try smaller dimensions.');
    if (!dpi || type === 'image/webp') return blob;
    var bytes = new Uint8Array(await blob.arrayBuffer());
    var patched = bytes;
    if (type === 'image/jpeg') patched = Lib.setJpegDpi(bytes, dpi);
    else if (type === 'image/png') patched = Lib.setPngDpi(bytes, dpi);
    return new Blob([patched], { type: type });
  }

  async function renderToLimit(base, crop, s, w0, h0) {
    var free = s.mode === 'B';
    var max = s.max;

    if (s.fmt === 'image/png') {
      var testPng = async function (scale) {
        var w = Math.max(1, Math.round(w0 * scale));
        var h = Math.max(1, Math.round(h0 * scale));
        var blob = await encode(paint(base, crop, w, h, s), s.fmt, null, s.dpi);
        return { blob: blob, w: w, h: h, q: null, scale: scale, note: '' };
      };

      if (!free) {
        var fixed = await testPng(1);
        if (fixed.blob.size <= max) return fixed;
        fixed.note = 'PNG is lossless, so this file is still over the limit. Use JPG or WebP, or raise the limit.';
        return fixed;
      }

      var topPng = await testPng(1);
      if (topPng.blob.size <= max) return topPng;

      var tiny = await testPng(0.05);
      if (tiny.blob.size > max) {
        tiny.note = 'Even a heavily reduced PNG is over the limit. Choose JPG or WebP for strict KB limits.';
        return tiny;
      }

      var loScale = 0.05, hiScale = 1, bestPng = tiny;
      for (var p = 0; p < 6; p++) {
        var midScale = (loScale + hiScale) / 2;
        var candidate = await testPng(midScale);
        if (candidate.blob.size <= max) { bestPng = candidate; loScale = midScale; }
        else { hiScale = midScale; }
      }
      bestPng.note = bestPng.scale < 0.999 ? 'PNG cannot trade quality for size, so the image was scaled down to fit.' : '';
      return bestPng;
    }

    var scale = 1;
    var rounds = free ? 14 : 1;
    var smallest = null;

    for (var round = 0; round < rounds; round++) {
      var cw = Math.max(1, Math.round(w0 * scale));
      var ch = Math.max(1, Math.round(h0 * scale));
      var canvas = paint(base, crop, cw, ch, s);

      var lo = 0.05, hi = 0.95;
      var fit = null;
      var top = await encode(canvas, s.fmt, hi, s.dpi);

      if (top.size <= max) {
        fit = { blob: top, q: hi };
      } else {
        var low = await encode(canvas, s.fmt, lo, s.dpi);
        smallest = { blob: low, q: lo, w: cw, h: ch, scale: scale };
        if (low.size <= max) {
          fit = { blob: low, q: lo };
          for (var k = 0; k < 9; k++) {
            var mid = (lo + hi) / 2;
            var probe = await encode(canvas, s.fmt, mid, s.dpi);
            if (probe.size <= max) { fit = { blob: probe, q: mid }; lo = mid; }
            else { hi = mid; }
          }
        }
      }

      if (fit) {
        var result = { blob: fit.blob, q: fit.q, w: cw, h: ch, scale: scale, note: '' };
        if (scale < 0.999) result.note = 'Scaled to ' + cw + ' × ' + ch + ' px to reach the limit.';
        if (fit.q < 0.35) {
          result.note += (result.note ? ' ' : '') + 'Quality had to drop to ' + Math.round(fit.q * 100) + '%.';
        }
        return result;
      }

      if (!free) {
        return {
          blob: smallest.blob,
          q: lo,
          w: cw,
          h: ch,
          scale: scale,
          note: 'Even at the lowest quality this image stays above ' + fmtKB(max) + '. Use fewer pixels or a bigger limit.'
        };
      }
      scale *= 0.88;
    }

    return {
      blob: smallest.blob,
      q: smallest.q,
      w: smallest.w,
      h: smallest.h,
      scale: smallest.scale,
      note: 'Could not reach the limit even after shrinking. Try a larger limit or fewer pixels.'
    };
  }

  async function processOne(base, s, crop) {
    var cropW = crop ? crop.w : base.width;
    var cropH = crop ? crop.h : base.height;
    var w0 = s.mode === 'B' ? Math.round(cropW) : s.w;
    var h0 = s.mode === 'B' ? Math.round(cropH) : s.h;

    if (!(w0 >= 1 && h0 >= 1 && w0 <= MAX_SIDE && h0 <= MAX_SIDE)) {
      throw new Error('Width and height must be between 1 and 8000 px.');
    }
    if (s.mode !== 'A' && !s.max) throw new Error('Enter a maximum file size in KB.');
    if (s.mode !== 'A' && s.min > s.max) throw new Error('The minimum size is larger than the maximum size.');

    var res;
    if (s.mode === 'A') {
      var blob = await encode(paint(base, crop, w0, h0, s), s.fmt, s.q, s.dpi);
      res = { blob: blob, w: w0, h: h0, q: s.fmt === 'image/png' ? null : s.q, scale: 1, note: '' };
    } else {
      res = await renderToLimit(base, crop, s, w0, h0);
    }

    if (!res || !res.blob) throw new Error('Could not encode this image.');
    if (res.blob.type && res.blob.type !== s.fmt) {
      throw new Error('This browser cannot save ' + extOf(s.fmt).toUpperCase() + '. Choose JPG or PNG instead.');
    }

    /* Try to satisfy a minimum size without breaking the maximum. */
    if (s.mode !== 'A' && s.min && res.blob.size < s.min) {
      if (s.fmt !== 'image/png') {
        var higher = await encode(paint(base, crop, res.w, res.h, s), s.fmt, 0.99, s.dpi);
        if (higher.size <= s.max) { res.blob = higher; res.q = 0.99; res.note = ''; }
      }
      if (s.mode === 'B' && res.blob.size < s.min) {
        var up = res.scale || 1;
        for (var i = 0; i < 6 && res.blob.size < s.min; i++) {
          up *= 1.2;
          var w = Math.round(w0 * up);
          var h = Math.round(h0 * up);
          if (w > MAX_SIDE || h > MAX_SIDE) break;
          var bigger = await encode(paint(base, crop, w, h, s), s.fmt, res.q == null ? null : res.q, s.dpi);
          if (bigger.size > s.max) break;
          res.blob = bigger;
          res.w = w;
          res.h = h;
          res.scale = up;
          res.note = '';
        }
      }
    }

    var probe = null;
    try { probe = await createImageBitmap(res.blob); } catch (e) { probe = null; }
    if (probe) {
      res.w = probe.width;
      res.h = probe.height;
      probe.close();
    }

    res.mode = s.mode;
    res.fmt = s.fmt;
    res.min = s.min;
    res.max = s.max;
    res.wantW = s.mode === 'B' ? 0 : w0;
    res.wantH = s.mode === 'B' ? 0 : h0;
    res.dpi = s.fmt === 'image/webp' ? 0 : s.dpi;
    return res;
  }

  /* ---------- crop editor ---------- */

  function fullCrop() {
    return state.base ? { x: 0, y: 0, w: state.base.width, h: state.base.height } : null;
  }

  function ensureCrop() {
    if (!state.crop && state.base) state.crop = fullCrop();
    return state.crop;
  }

  function targetRatio() {
    if (mode() === 'B') {
      if (!state.crop) return null;
      return state.crop.w / state.crop.h;
    }
    var w = +$('w').value;
    var h = +$('h').value;
    return (w > 0 && h > 0) ? w / h : null;
  }

  function clampCrop(rect) {
    var bw = state.base.width;
    var bh = state.base.height;
    var w = clamp(rect.w, MIN_CROP, bw);
    var h = clamp(rect.h, MIN_CROP, bh);
    return { x: clamp(rect.x, 0, bw - w), y: clamp(rect.y, 0, bh - h), w: w, h: h };
  }

  function lockRect(rect, start, handle) {
    var ratio = targetRatio();
    if (!ratio) return rect;
    var w = rect.w;
    var h = rect.h;
    var x, y;
    if (handle === 'n' || handle === 's') {
      w = h * ratio;
      x = start.x + (start.w - w) / 2;
      y = handle === 'n' ? start.y + start.h - h : start.y;
    } else if (handle === 'e' || handle === 'w') {
      h = w / ratio;
      y = start.y + (start.h - h) / 2;
      x = handle === 'w' ? start.x + start.w - w : start.x;
    } else {
      if (w / h > ratio) h = w / ratio;
      else w = h * ratio;
      x = handle.indexOf('w') > -1 ? start.x + start.w - w : start.x;
      y = handle.indexOf('n') > -1 ? start.y + start.h - h : start.y;
    }
    return clampCrop({ x: x, y: y, w: w, h: h });
  }

  function paintCropStage() {
    if (!state.base) return;
    var canvas = $('cropCanvas');
    var bw = state.base.width;
    var bh = state.base.height;
    var scale = Math.min(1, 1400 / Math.max(bw, bh));
    canvas.width = Math.max(1, Math.round(bw * scale));
    canvas.height = Math.max(1, Math.round(bh * scale));
    var ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.base, 0, 0, canvas.width, canvas.height);
    paintCropBox();
  }

  function paintCropBox() {
    var box = $('cropBox');
    if (!state.base || !state.crop || $('cropWrap').hidden) {
      box.hidden = true;
      return;
    }
    var c = state.crop;
    var bw = state.base.width;
    var bh = state.base.height;
    box.hidden = false;
    box.style.left = (c.x / bw * 100) + '%';
    box.style.top = (c.y / bh * 100) + '%';
    box.style.width = (c.w / bw * 100) + '%';
    box.style.height = (c.h / bh * 100) + '%';
    $('cropInfo').textContent = Math.round(c.w) + ' × ' + Math.round(c.h) + ' px · ' + ratioLabel(c.w, c.h);
  }

  function openCrop() {
    if (!state.base) return;
    ensureCrop();
    $('cropWrap').hidden = false;
    $('cropToggle').setAttribute('aria-pressed', 'true');
    $('cropToggle').textContent = 'Close crop';
    paintCropStage();
  }

  function closeCrop() {
    $('cropWrap').hidden = true;
    $('cropToggle').setAttribute('aria-pressed', 'false');
    $('cropToggle').textContent = 'Crop';
    $('cropBox').hidden = true;
  }

  function cropDown(e) {
    if (!state.base || $('cropWrap').hidden) return;
    ensureCrop();
    var rect = $('cropStage').getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var handle = e.target && e.target.getAttribute ? e.target.getAttribute('data-h') : null;
    drag = {
      mode: handle ? 'resize' : 'move',
      handle: handle || '',
      sx: state.base.width / rect.width,
      sy: state.base.height / rect.height,
      x0: e.clientX,
      y0: e.clientY,
      start: { x: state.crop.x, y: state.crop.y, w: state.crop.w, h: state.crop.h }
    };
    try { $('cropBox').setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
    e.preventDefault();
  }

  function cropMove(e) {
    if (!drag || !state.base) return;
    e.preventDefault();
    var dx = (e.clientX - drag.x0) * drag.sx;
    var dy = (e.clientY - drag.y0) * drag.sy;
    var bw = state.base.width;
    var bh = state.base.height;
    var start = drag.start;

    if (drag.mode === 'move') {
      state.crop = {
        x: clamp(start.x + dx, 0, bw - start.w),
        y: clamp(start.y + dy, 0, bh - start.h),
        w: start.w,
        h: start.h
      };
    } else {
      var left = start.x;
      var top = start.y;
      var right = start.x + start.w;
      var bottom = start.y + start.h;
      var handle = drag.handle;

      if (handle.indexOf('w') > -1) left = clamp(start.x + dx, 0, right - MIN_CROP);
      if (handle.indexOf('e') > -1) right = clamp(start.x + start.w + dx, left + MIN_CROP, bw);
      if (handle.indexOf('n') > -1) top = clamp(start.y + dy, 0, bottom - MIN_CROP);
      if (handle.indexOf('s') > -1) bottom = clamp(start.y + start.h + dy, top + MIN_CROP, bh);

      var rect = { x: left, y: top, w: right - left, h: bottom - top };
      if ($('cropLock').checked) rect = lockRect(rect, start, handle);
      state.crop = clampCrop(rect);
    }
    paintCropBox();
  }

  function cropUp() { drag = null; }

  function rotate(delta) {
    if (!state.base) return;
    state.rot = ((state.rot + delta) % 360 + 360) % 360;
    rebuildBase();
    if (!$('cropWrap').hidden) { ensureCrop(); paintCropStage(); }
  }

  function flip(axis) {
    if (!state.base) return;
    if (axis === 'h') state.flipH = !state.flipH;
    else state.flipV = !state.flipV;
    rebuildBase();
    if (!$('cropWrap').hidden) { ensureCrop(); paintCropStage(); }
  }

  /* ---------- result ---------- */

  function clearPdf() {
    state.pdf = null;
    $('pdfdl').disabled = true;
    $('pdfmsg').className = 'msg';
    $('pdfmsg').textContent = '';
  }

  function clearOut() {
    clearPdf();
    state.out = null;
    if (state.outUrl) {
      URL.revokeObjectURL(state.outUrl);
      state.outUrl = '';
    }
    $('dl').disabled = true;
    $('copy').disabled = true;
    $('res').innerHTML = '';
    var verdict = $('verdict');
    verdict.className = 'verdict';
    verdict.innerHTML = '';
    var badge = $('resultBadge');
    badge.hidden = true;
    badge.className = 'badge';
    badge.textContent = '';
    $('gauge').hidden = true;
    $('compare').hidden = true;
    $('prev').hidden = false;
    $('prev').innerHTML = EMPTY_PREVIEW;
    $('cmpBefore').removeAttribute('src');
    $('cmpAfter').removeAttribute('src');
  }

  function showResult(out, beforeUrl, fileName) {
    state.out = out;
    if (state.outUrl) URL.revokeObjectURL(state.outUrl);
    state.outUrl = URL.createObjectURL(out.blob);

    var fails = [];
    if (out.mode !== 'B' && (out.w !== out.wantW || out.h !== out.wantH)) {
      fails.push('dimensions are ' + out.w + ' × ' + out.h + ' px instead of ' + out.wantW + ' × ' + out.wantH + ' px');
    }
    if (out.max && out.blob.size > out.max) fails.push('the file is ' + fmtKB(out.blob.size - out.max) + ' above the maximum');
    if (out.min && out.blob.size < out.min) fails.push('the file is ' + fmtKB(out.min - out.blob.size) + ' below the minimum');

    var badge = $('resultBadge');
    badge.hidden = false;
    badge.className = 'badge ' + (fails.length ? 'badge--bad' : 'badge--ok');
    badge.textContent = fails.length ? 'Outside limits' : 'Meets limits';

    var verdict = $('verdict');
    verdict.className = 'verdict ' + (fails.length ? 'verdict--bad' : 'verdict--ok');
    verdict.innerHTML =
      '<span class="verdict__icon" aria-hidden="true">' + (fails.length ? '!' : '✓') + '</span>' +
      '<span><strong>' + (fails.length ? 'Does not meet your requirements.' : 'Meets every limit you entered.') + '</strong>' +
      (fails.length ? ' The ' + esc(fails.join('; ')) + '.' : ' Measured on the real output file.') +
      (out.note ? '<span class="verdict__note">' + esc(out.note) + '</span>' : '') +
      '</span>';

    var rows = [
      ['Format', extOf(out.fmt).toUpperCase() + (out.dpi ? ' · ' + out.dpi + ' DPI tag' : '')],
      ['Dimensions', out.w + ' × ' + out.h + ' px'],
      ['File size', fmtKB(out.blob.size)],
      ['Target', out.mode === 'A' ? 'no size limit' : (out.min ? fmtKB(out.min) + ' – ' : 'up to ') + fmtKB(out.max)],
      ['Difference', out.max ? (out.blob.size > out.max ? '+' : '−') + fmtKB(Math.abs(out.blob.size - out.max)) + ' vs max' : '—'],
      ['Quality used', out.q == null ? 'lossless' : Math.round(out.q * 100) + '%']
    ];
    $('res').innerHTML = '<tbody>' + rows.map(function (row) {
      return '<tr><th scope="row">' + esc(row[0]) + '</th><td>' + esc(row[1]) + '</td></tr>';
    }).join('') + '</tbody>';

    var gauge = $('gauge');
    gauge.hidden = false;
    var domain = out.max
      ? Math.max(out.max * 1.35, out.blob.size * 1.08)
      : Math.max(out.blob.size * 1.25, 1024);
    var band = $('gaugeBand');
    if (out.max) {
      band.hidden = false;
      band.style.left = (out.min / domain * 100) + '%';
      band.style.width = Math.max(0.5, ((out.max - out.min) / domain) * 100) + '%';
      $('gaugeRange').textContent = (out.min ? fmtKB(out.min) + ' – ' : '≤ ') + fmtKB(out.max);
    } else {
      band.hidden = true;
      $('gaugeRange').textContent = 'no size target';
    }
    var marker = $('gaugeMarker');
    marker.style.left = Math.min(100, (out.blob.size / domain) * 100) + '%';
    marker.className = 'gauge__marker' + (out.max && out.blob.size > out.max ? ' is-over' : '');
    marker.title = fmtKB(out.blob.size);
    $('gaugeMax').textContent = fmtKB(domain);

    if (beforeUrl) {
      $('cmpBefore').src = beforeUrl;
      $('cmpAfter').src = state.outUrl;
      $('compare').hidden = false;
      $('prev').hidden = true;
      setSplit(50);
    } else {
      $('prev').hidden = false;
      $('prev').innerHTML = '<img alt="Resized result" src="' + state.outUrl + '">';
      $('compare').hidden = true;
    }

    state.outName = fileName || 'image';
    updateButtons();
  }

  function showError(message) {
    var verdict = $('verdict');
    verdict.className = 'verdict verdict--bad';
    verdict.innerHTML = '<span class="verdict__icon" aria-hidden="true">!</span><span><strong>Nothing was produced.</strong> ' + esc(message || 'Try another file or settings.') + '</span>';
    toast(message || 'Processing failed', 'bad');
  }

  function setSplit(value) {
    split = clamp(value, 0, 100);
    $('cmpBefore').style.clipPath = 'inset(0 ' + (100 - split) + '% 0 0)';
    $('cmpDivider').style.left = split + '%';
    $('compare').setAttribute('aria-valuenow', String(Math.round(split)));
  }

  function setSplitFromEvent(event) {
    var rect = $('compare').getBoundingClientRect();
    if (!rect.width) return;
    setSplit(((event.clientX - rect.left) / rect.width) * 100);
  }

  /* ---------- processing ---------- */

  async function runSingle() {
    if (!state.base) return;
    var s = settings();
    setBusy(true);
    try {
      var out = await processOne(state.base, s, state.crop);
      var entry = activeEntry();
      if (entry) {
        entry.out = out;
        entry.status = 'done';
        entry.msg = '';
      }
      showResult(out, state.beforeUrl, entry ? entry.name : 'image');
      saveSettings();
      toast('Ready — ' + fmtKB(out.blob.size));
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
      renderQueue();
      renderBatch();
    }
  }

  async function runAll() {
    if (!state.files.length) return;
    var s = settings();
    if (s.mode !== 'A') {
      if (!s.max) { showError('Enter a maximum file size in KB.'); return; }
      if (s.min > s.max) { showError('The minimum size is larger than the maximum size.'); return; }
    }

    setBusy(true);
    var total = state.files.length;
    var done = 0;

    for (var i = 0; i < total; i++) {
      var entry = state.files[i];
      entry.status = 'working';
      entry.out = null;
      renderQueue();
      renderBatch();
      $('batchNote').hidden = false;
      $('batchNote').textContent = 'Processing ' + (i + 1) + ' of ' + total + ' — ' + entry.name;

      try {
        var bmp = await createImageBitmap(entry.file, { imageOrientation: 'from-image' });
        if (bmp.width * bmp.height > MAX_PIXELS) {
          bmp.close();
          throw new Error('More than 100 megapixels.');
        }
        var base = makeBase(bmp, state.rot, state.flipH, state.flipV);
        bmp.close();
        var out = await processOne(base, s, null);
        entry.out = out;
        entry.status = 'done';
        done++;
        if (entry.id === state.activeId) entry.beforeUrl = snapshot(base);
      } catch (err) {
        entry.status = 'error';
        entry.msg = err.message || 'Failed.';
      }
      renderQueue();
      renderBatch();
    }

    setBusy(false);
    if (done) saveSettings();

    var shown = activeEntry();
    if (!shown || !shown.out) {
      shown = state.files.filter(function (f) { return f.status === 'done'; })[0] || null;
    }
    if (shown) showResult(shown.out, shown.beforeUrl || '', shown.name);
    toast(done + ' of ' + total + ' images ready');
    renderBatch();
    updateButtons();
  }

  function renderBatch() {
    var card = $('batchCard');
    var table = $('batchTable');
    if (state.files.length < 2) {
      card.hidden = true;
      table.innerHTML = '';
      return;
    }
    card.hidden = false;
    var done = state.files.filter(function (f) { return f.status === 'done'; }).length;
    $('batchSummary').textContent = done + ' of ' + state.files.length + ' ready';

    table.innerHTML = '<thead><tr><th>File</th><th>Dimensions</th><th>Size</th><th>Status</th><th></th></tr></thead><tbody>' +
      state.files.map(function (f) {
        var status = '<span class="badge">Queued</span>';
        if (f.status === 'done') status = '<span class="badge badge--ok">Done</span>';
        else if (f.status === 'error') status = '<span class="badge badge--bad">Failed</span>';
        else if (f.status === 'working') status = '<span class="badge badge--warn">Working</span>';
        var dims = f.out ? f.out.w + ' × ' + f.out.h : '—';
        var size = f.out ? fmtKB(f.out.blob.size) : '—';
        var action = f.out ? '<button type="button" class="btn btn--ghost btn--sm" data-dl="' + f.id + '">Download</button>' : '';
        return '<tr>' +
          '<td class="cell-name" title="' + esc(f.name) + '">' + esc(f.name) + (f.msg ? ' <span class="note">' + esc(f.msg) + '</span>' : '') + '</td>' +
          '<td>' + dims + '</td><td>' + size + '</td><td>' + status + '</td><td class="cell-act">' + action + '</td>' +
          '</tr>';
      }).join('') + '</tbody>';
  }

  async function downloadZip() {
    var done = state.files.filter(function (f) { return f.status === 'done' && f.out; });
    if (!done.length) return;
    $('zipBtn').disabled = true;
    try {
      var used = {};
      var entries = done.map(function (f) {
        var name = fileBase(f.name) + '_' + f.out.w + 'x' + f.out.h + '.' + extOf(f.out.fmt);
        var candidate = name;
        var n = 2;
        while (used[candidate]) {
          candidate = name.replace(/(\.[^.]+)$/, '_' + (n++) + '$1');
        }
        used[candidate] = true;
        return { name: candidate, blob: f.out.blob };
      });
      var zip = await Lib.makeZip(entries);
      downloadBlob(zip, 'resizekb-images.zip');
      toast('ZIP with ' + entries.length + ' images created');
    } catch (err) {
      toast('Could not build the ZIP: ' + err.message, 'bad');
    } finally {
      updateButtons();
    }
  }

  /* ---------- clipboard ---------- */

  async function copyOut() {
    if (!state.out) return;
    try {
      if (!navigator.clipboard || typeof window.ClipboardItem === 'undefined') throw new Error('unsupported');
      var blob = state.out.blob;
      if (blob.type !== 'image/png') {
        var bmp = await createImageBitmap(blob);
        var canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        bmp.close();
        blob = await toBlob(canvas, 'image/png');
      }
      await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
      toast('Image copied to the clipboard');
    } catch (err) {
      toast('Clipboard access was blocked. Download the image instead.', 'bad');
    }
  }

  /* ---------- PDF ---------- */

  function pageBox(imageW, imageH) {
    var letter = $('pdfsize').value === 'letter';
    var pw = letter ? 612 : 595;
    var ph = letter ? 792 : 842;
    var orientation = $('pdforient').value;
    var landscape = orientation === 'landscape' || (orientation === 'auto' && imageW > imageH);
    return landscape ? { w: ph, h: pw } : { w: pw, h: ph };
  }

  function pdfFrom(jpeg, w, h, pw, ph) {
    var margin = 24;
    var scale = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h);
    var dw = (w * scale).toFixed(2);
    var dh = (h * scale).toFixed(2);
    var x = ((pw - w * scale) / 2).toFixed(2);
    var y = ((ph - h * scale) / 2).toFixed(2);

    var encoder = new TextEncoder();
    var parts = [];
    var offsets = [];
    var length = 0;

    function add(data) {
      var bytes = typeof data === 'string' ? encoder.encode(data) : data;
      parts.push(bytes);
      length += bytes.length;
    }
    function obj(number, body, stream) {
      offsets[number] = length;
      add(number + ' 0 obj\n' + body);
      if (stream) {
        add('\nstream\n');
        add(stream);
        add('\nendstream');
      }
      add('\nendobj\n');
    }

    add('%PDF-1.4\n');
    var content = 'q ' + dw + ' 0 0 ' + dh + ' ' + x + ' ' + y + ' cm /Im0 Do Q';

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>');
    obj(4, '<< /Length ' + content.length + ' >>', content);
    obj(5, '<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + jpeg.length + ' >>', jpeg);

    var xref = length;
    var table = 'xref\n0 6\n0000000000 65535 f \n';
    for (var i = 1; i < 6; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    add(table + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF');

    return new Blob(parts, { type: 'application/pdf' });
  }

  async function makePdf() {
    if (!state.base || pdfBusy) return;
    var max = Math.round((parseFloat($('pdfmax').value) || 0) * 1024);
    var message = $('pdfmsg');
    state.pdf = null;
    $('pdfdl').disabled = true;

    if (!(max > 0)) {
      message.className = 'msg msg--bad';
      message.textContent = 'Enter a maximum PDF size in KB.';
      return;
    }
    pdfBusy = true;
    $('pdfgo').disabled = true;
    message.className = 'msg';
    message.textContent = 'Building the PDF…';

    var crop = state.crop;
    var sw = crop ? crop.w : state.base.width;
    var sh = crop ? crop.h : state.base.height;
    var page = pageBox(sw, sh);
    var scale = Math.min(1, 1600 / Math.max(sw, sh));
    var best = null;
    var dims = [0, 0];
    var quality = 0;

    try {
      for (var round = 0; round < 9 && !best; round++) {
        var cw = Math.max(1, Math.round(sw * scale));
        var ch = Math.max(1, Math.round(sh * scale));
        dims = [cw, ch];
        var canvas = paint(state.base, crop, cw, ch, {
          fmt: 'image/jpeg',
          fit: 'contain',
          bg: '#ffffff',
          sig: $('kind').value === 'sig',
          brightness: +$('br').value,
          contrast: +$('ct').value,
          stamp: stampConfig()
        });

        var attempt = async function (q) {
          var jpeg = await toBlob(canvas, 'image/jpeg', q);
          if (!jpeg) throw new Error('Could not encode the image for the PDF.');
          var bytes = new Uint8Array(await jpeg.arrayBuffer());
          return { blob: pdfFrom(bytes, cw, ch, page.w, page.h), q: q };
        };

        var lo = 0.1, hi = 0.92;
        var topPdf = await attempt(hi);
        if (topPdf.blob.size <= max) { best = topPdf; quality = hi; break; }

        var lowPdf = await attempt(lo);
        if (lowPdf.blob.size > max) { scale *= 0.8; continue; }

        best = lowPdf;
        quality = lo;
        for (var k = 0; k < 7; k++) {
          var mid = (lo + hi) / 2;
          var probe = await attempt(mid);
          if (probe.blob.size <= max) { best = probe; quality = mid; lo = mid; }
          else { hi = mid; }
        }
      }

      if (!best) throw new Error('Could not reach that size, even at a small scale. Try a larger limit.');

      state.pdf = best.blob;
      message.className = 'msg msg--ok';
      message.textContent = 'PDF is ' + fmtKB(best.blob.size) + ' (limit ' + fmtKB(max) + ') · ' +
        dims[0] + ' × ' + dims[1] + ' px image · quality ' + Math.round(quality * 100) + '%.';
      $('pdfdl').disabled = false;
    } catch (err) {
      message.className = 'msg msg--bad';
      message.textContent = err.message || 'Could not build the PDF.';
    } finally {
      pdfBusy = false;
      updateButtons();
    }
  }

  /* ---------- presets ---------- */

  function loadUserPresets() {
    try {
      var parsed = JSON.parse(localStorage.getItem('rk_presets') || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  var userPresets = loadUserPresets();

  function persistPresets() {
    try { localStorage.setItem('rk_presets', JSON.stringify(userPresets)); } catch (e) { /* ignore quota */ }
  }

  function allPresets() {
    var builtins = BUILTIN.map(function (p) {
      return Object.assign({}, p, { status: p.custom ? '' : 'Example, unverified' });
    });
    var mine = userPresets.map(function (p) {
      return Object.assign({}, p, { status: 'Saved by you, unverified' });
    });
    return builtins.concat(mine);
  }

  function fillPresets() {
    var select = $('preset');
    select.innerHTML = '';
    allPresets().forEach(function (preset, index) {
      var option = document.createElement('option');
      option.value = String(index);
      option.textContent = preset.name;
      select.appendChild(option);
    });
    if (+select.value >= allPresets().length) select.value = '0';
    togglePresetDelete();
  }

  function togglePresetDelete() {
    $('presetDel').disabled = +$('preset').value < BUILTIN.length;
  }

  function applyPreset() {
    var list = allPresets();
    var preset = list[+$('preset').value];
    togglePresetDelete();
    if (!preset || preset.custom) {
      $('presetnote').textContent = '';
      return;
    }
    if (preset.w) $('w').value = preset.w;
    if (preset.h) $('h').value = preset.h;
    $('minkb').value = preset.min == null ? '' : preset.min;
    $('maxkb').value = preset.max == null ? '' : preset.max;
    $('fmt').value = ['image/jpeg', 'image/png', 'image/webp'].indexOf(preset.fmt) > -1 ? preset.fmt : 'image/jpeg';
    $('fit').value = ['cover', 'contain', 'stretch'].indexOf(preset.fit) > -1 ? preset.fit : 'cover';
    $('dpi').value = preset.dpi ? String(preset.dpi) : '';
    $('kind').value = preset.kind === 'sig' ? 'sig' : 'photo';
    setMode(['A', 'B', 'C'].indexOf(preset.mode) > -1 ? preset.mode : 'C');
    $('presetnote').textContent = preset.status + (preset.src ? ' · Source: ' + preset.src : '') + '. Check your own form’s instructions.';
    sync();
  }

  function savePreset() {
    var name = $('pn').value.trim().slice(0, 60);
    if (!name) {
      $('pn').focus();
      toast('Give the preset a name first', 'bad');
      return;
    }
    userPresets.push({
      name: name,
      w: +$('w').value,
      h: +$('h').value,
      min: parseFloat($('minkb').value) || null,
      max: parseFloat($('maxkb').value) || null,
      fmt: $('fmt').value,
      fit: $('fit').value,
      dpi: +$('dpi').value || null,
      mode: mode(),
      kind: $('kind').value,
      src: $('psrc').value.trim().slice(0, 200)
    });
    persistPresets();
    fillPresets();
    $('preset').value = String(BUILTIN.length + userPresets.length - 1);
    $('pn').value = '';
    $('psrc').value = '';
    applyPreset();
    toast('Preset saved in this browser');
  }

  function deletePreset() {
    var index = +$('preset').value;
    if (index < BUILTIN.length) return;
    var removed = userPresets.splice(index - BUILTIN.length, 1)[0];
    persistPresets();
    fillPresets();
    $('preset').value = '0';
    applyPreset();
    if (removed) toast('Deleted “' + removed.name + '”');
  }

  /* ---------- share links ---------- */

  function shareQuery() {
    var p = new URLSearchParams();
    p.set('mode', mode());
    p.set('w', $('w').value);
    p.set('h', $('h').value);
    if ($('minkb').value) p.set('min', $('minkb').value);
    if ($('maxkb').value) p.set('max', $('maxkb').value);
    p.set('fmt', $('fmt').value);
    p.set('fit', $('fit').value);
    if ($('dpi').value) p.set('dpi', $('dpi').value);
    p.set('kind', $('kind').value);
    if (mode() === 'A') p.set('q', $('q').value);
    return p.toString();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '-1000px';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(area);
      if (ok) resolve();
      else reject(new Error('copy blocked'));
    });
  }

  function copyShareLink() {
    var query = shareQuery();
    var url = location.href.split('#')[0] + '#' + query;
    var applied = false;
    try {
      history.replaceState(null, '', '#' + query);
      applied = true;
    } catch (e) { applied = false; /* file:// may refuse */ }
    copyText(url).then(function () {
      toast('Link copied \u2014 it opens with these limits filled in');
    }).catch(function () {
      toast(applied ? 'Copy was blocked, but the link is in the address bar' : 'Copy was blocked by the browser', 'bad');
    });
  }

  function applyShareHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw || raw.indexOf('=') < 0) return false;

    var p;
    try { p = new URLSearchParams(raw); } catch (e) { return false; }
    var touched = false;

    if (['A', 'B', 'C'].indexOf(p.get('mode')) > -1) { setMode(p.get('mode')); touched = true; }

    var w = parseInt(p.get('w'), 10);
    if (w >= 1 && w <= MAX_SIDE) { $('w').value = w; touched = true; }
    var h = parseInt(p.get('h'), 10);
    if (h >= 1 && h <= MAX_SIDE) { $('h').value = h; touched = true; }

    var min = parseFloat(p.get('min'));
    if (isFinite(min) && min >= 0) { $('minkb').value = min; touched = true; }
    var max = parseFloat(p.get('max'));
    if (isFinite(max) && max > 0) { $('maxkb').value = max; touched = true; }

    var fmt = p.get('fmt');
    if (['image/jpeg', 'image/png', 'image/webp'].indexOf(fmt) > -1) { $('fmt').value = fmt; touched = true; }
    var fit = p.get('fit');
    if (['cover', 'contain', 'stretch'].indexOf(fit) > -1) { $('fit').value = fit; touched = true; }
    var dpi = p.get('dpi');
    if (dpi !== null && ['', '72', '96', '150', '300', '600'].indexOf(dpi) > -1) { $('dpi').value = dpi; touched = true; }
    var kind = p.get('kind');
    if (kind === 'sig' || kind === 'photo') { $('kind').value = kind; touched = true; }
    var q = parseInt(p.get('q'), 10);
    if (q >= 10 && q <= 100) { $('q').value = q; touched = true; }

    if (touched) {
      updateQ();
      sync();
      toast('Limits loaded from the shared link');
    }
    return touched;
  }

  /* ---------- settings persistence ---------- */

  function saveSettings() {
    try {
      localStorage.setItem('rk_settings', JSON.stringify({
        mode: mode(),
        w: $('w').value,
        h: $('h').value,
        min: $('minkb').value,
        max: $('maxkb').value,
        fmt: $('fmt').value,
        fit: $('fit').value,
        bg: $('bg').value,
        q: $('q').value,
        dpi: $('dpi').value,
        kind: $('kind').value,
        br: $('br').value,
        ct: $('ct').value,
        stampOn: $('stampOn').checked,
        stampText: $('stampText').value,
        stampPos: $('stampPos').value,
        stampSize: $('stampSize').value,
        stampColor: $('stampColor').value,
        stampDate: $('stampDate').checked
      }));
    } catch (e) { /* storage may be unavailable */ }
  }

  function restoreSettings() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem('rk_settings') || 'null'); } catch (e) { saved = null; }
    if (!saved) return;
    if (['A', 'B', 'C'].indexOf(saved.mode) > -1) setMode(saved.mode);
    if (+saved.w > 0) $('w').value = saved.w;
    if (+saved.h > 0) $('h').value = saved.h;
    if (saved.min != null) $('minkb').value = saved.min;
    if (saved.max != null) $('maxkb').value = saved.max;
    if (['image/jpeg', 'image/png', 'image/webp'].indexOf(saved.fmt) > -1) $('fmt').value = saved.fmt;
    if (['cover', 'contain', 'stretch'].indexOf(saved.fit) > -1) $('fit').value = saved.fit;
    if (/^#[0-9a-f]{6}$/i.test(saved.bg || '')) $('bg').value = saved.bg;
    if (+saved.q >= 10 && +saved.q <= 100) $('q').value = saved.q;
    if (['', '72', '96', '150', '300', '600'].indexOf(String(saved.dpi)) > -1) $('dpi').value = String(saved.dpi);
    if (saved.kind === 'sig' || saved.kind === 'photo') $('kind').value = saved.kind;
    if (+saved.br >= 50 && +saved.br <= 150) $('br').value = saved.br;
    if (+saved.ct >= 50 && +saved.ct <= 200) $('ct').value = saved.ct;
    $('stampOn').checked = saved.stampOn === true;
    if (typeof saved.stampText === 'string') $('stampText').value = saved.stampText.slice(0, 40);
    if (STAMP_POSITIONS.indexOf(saved.stampPos) > -1) $('stampPos').value = saved.stampPos;
    if (STAMP_SIZES[saved.stampSize]) $('stampSize').value = saved.stampSize;
    if (/^#[0-9a-f]{6}$/i.test(saved.stampColor || '')) $('stampColor').value = saved.stampColor;
    $('stampDate').checked = saved.stampDate === true;
  }

  function updateQ() { $('qv').textContent = $('q').value + '%'; }

  /* ---------- events ---------- */

  function bind() {
    $('drop').addEventListener('click', function (e) {
      if (e.target === $('file')) return;
      $('file').click();
    });
    $('drop').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        $('file').click();
      }
    });
    $('file').addEventListener('change', function (e) {
      addFiles(e.target.files);
      e.target.value = '';
    });

    $('drop').addEventListener('dragenter', function (e) {
      e.preventDefault();
      dragDepth++;
      $('drop').classList.add('is-drag');
    });
    $('drop').addEventListener('dragover', function (e) { e.preventDefault(); });
    $('drop').addEventListener('dragleave', function (e) {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) $('drop').classList.remove('is-drag');
    });
    $('drop').addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      $('drop').classList.remove('is-drag');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if ($('drop').contains(e.target)) return;
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });
    window.addEventListener('paste', function (e) {
      if (!e.clipboardData || !e.clipboardData.items) return;
      var files = [];
      for (var i = 0; i < e.clipboardData.items.length; i++) {
        var item = e.clipboardData.items[i];
        if (item.kind === 'file') {
          var pasted = item.getAsFile();
          if (pasted) files.push(pasted);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    });

    $('queue').addEventListener('click', function (e) {
      var remove = e.target.closest ? e.target.closest('[data-remove]') : null;
      if (remove) { removeFile(+remove.getAttribute('data-remove')); return; }
      var pick = e.target.closest ? e.target.closest('[data-pick]') : null;
      if (pick && !busy) selectFile(+pick.getAttribute('data-pick'));
    });

    $('preset').addEventListener('change', applyPreset);
    ['kind', 'fit', 'fmt'].forEach(function (id) {
      $(id).addEventListener('change', sync);
    });
    $$('input[name="mode"]').forEach(function (input) {
      input.addEventListener('change', sync);
    });
    $('q').addEventListener('input', updateQ);
    $('br').addEventListener('input', function () { $('brv').textContent = $('br').value + '%'; });
    $('ct').addEventListener('input', function () { $('ctv').textContent = $('ct').value + '%'; });

    $('stampOn').addEventListener('change', function () { syncStamp(); saveSettings(); });
    $('stampDate').addEventListener('change', function () { syncStamp(); saveSettings(); });
    $('stampText').addEventListener('input', function () { syncStamp(); saveSettings(); });
    ['stampPos', 'stampSize', 'stampColor'].forEach(function (id) {
      $(id).addEventListener('change', saveSettings);
    });

    $$('#chips [data-kb]').forEach(function (button) {
      button.addEventListener('click', function () {
        $('maxkb').value = button.getAttribute('data-kb');
        $('minkb').value = '';
        if (mode() === 'A') setMode('B');
        sync();
      });
    });

    $('go').addEventListener('click', function () {
      if (busy || !state.base) return;
      if (state.files.length > 1) runAll();
      else runSingle();
    });
    $('reset').addEventListener('click', function () {
      clearOut();
      $('q').value = 90;
      updateQ();
      $('bg').value = '#ffffff';
      $('br').value = 100;
      $('ct').value = 100;
      $('brv').textContent = '100%';
      $('ctv').textContent = '100%';
      $('cropLock').checked = true;
      $('stampOn').checked = false;
      $('stampText').value = '';
      $('stampPos').value = 'br';
      $('stampSize').value = 'medium';
      $('stampColor').value = '#111111';
      $('stampDate').checked = false;
      syncStamp();
      if (state.base) {
        state.rot = 0;
        state.flipH = false;
        state.flipV = false;
        rebuildBase();
      }
      toast('Settings reset');
    });

    $('rotL').addEventListener('click', function () { rotate(-90); });
    $('rotR').addEventListener('click', function () { rotate(90); });
    $('flipH').addEventListener('click', function () { flip('h'); });
    $('flipV').addEventListener('click', function () { flip('v'); });
    $('cropToggle').addEventListener('click', function () {
      if ($('cropWrap').hidden) openCrop();
      else closeCrop();
    });
    $('cropClear').addEventListener('click', function () {
      state.crop = fullCrop();
      paintCropBox();
      paintCropStage();
    });
    $('cropBox').addEventListener('pointerdown', cropDown);
    window.addEventListener('pointermove', cropMove);
    window.addEventListener('pointerup', cropUp);
    window.addEventListener('pointercancel', cropUp);

    $('compare').addEventListener('pointerdown', function (e) {
      compareDrag = true;
      setSplitFromEvent(e);
      try { $('compare').setPointerCapture(e.pointerId); } catch (err) { /* optional */ }
      e.preventDefault();
    });
    window.addEventListener('pointermove', function (e) {
      if (compareDrag) setSplitFromEvent(e);
    });
    window.addEventListener('pointerup', function () { compareDrag = false; });
    window.addEventListener('pointercancel', function () { compareDrag = false; });
    $('compare').addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        setSplit(split + (e.key === 'ArrowLeft' ? -5 : 5));
      }
    });

    $('dl').addEventListener('click', function () {
      if (!state.out) return;
      var name = fileBase(state.outName) + '_' + state.out.w + 'x' + state.out.h + '.' + extOf(state.out.fmt);
      downloadBlob(state.out.blob, name);
      toast('Saved ' + name);
    });
    $('copy').addEventListener('click', copyOut);

    $('pdfgo').addEventListener('click', makePdf);
    $('pdfdl').addEventListener('click', function () {
      if (!state.pdf) return;
      var entry = activeEntry();
      downloadBlob(state.pdf, fileBase(state.outName || (entry && entry.name) || 'document') + '.pdf');
    });

    $('batchTable').addEventListener('click', function (e) {
      var button = e.target.closest ? e.target.closest('[data-dl]') : null;
      if (!button) return;
      var entry = findFile(+button.getAttribute('data-dl'));
      if (!entry || !entry.out) return;
      downloadBlob(entry.out.blob, fileBase(entry.name) + '_' + entry.out.w + 'x' + entry.out.h + '.' + extOf(entry.out.fmt));
    });
    $('zipBtn').addEventListener('click', downloadZip);
    $('clearQueue').addEventListener('click', clearQueue);

    $('psave').addEventListener('click', savePreset);
    $('plink').addEventListener('click', copyShareLink);
    $('presetDel').addEventListener('click', deletePreset);
    $('pexp').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify(userPresets, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'resizekb-presets.json');
    });
    $('pimp').addEventListener('click', function () { $('pfile').click(); });
    $('pfile').addEventListener('change', async function (e) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        var parsed = JSON.parse(await file.text());
        if (!Array.isArray(parsed)) throw new Error('not a list');
        var added = 0;
        parsed.slice(0, 100).forEach(function (p) {
          if (!p || typeof p.name !== 'string' || !(+p.w > 0) || !(+p.h > 0)) return;
          userPresets.push({
            name: p.name.slice(0, 60),
            w: +p.w,
            h: +p.h,
            min: +p.min || null,
            max: +p.max || null,
            fmt: ['image/jpeg', 'image/png', 'image/webp'].indexOf(p.fmt) > -1 ? p.fmt : 'image/jpeg',
            fit: ['cover', 'contain', 'stretch'].indexOf(p.fit) > -1 ? p.fit : 'cover',
            dpi: +p.dpi || null,
            mode: ['A', 'B', 'C'].indexOf(p.mode) > -1 ? p.mode : 'C',
            kind: p.kind === 'sig' ? 'sig' : 'photo',
            src: String(p.src || '').slice(0, 200)
          });
          added++;
        });
        persistPresets();
        fillPresets();
        toast(added + ' presets imported');
      } catch (err) {
        toast('That file is not a valid ResizeKB preset list.', 'bad');
      }
    });

    window.addEventListener('hashchange', function () { applyShareHash(); });

    document.addEventListener('keydown', function (e) {
      var meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'o' || e.key === 'O')) { e.preventDefault(); $('file').click(); return; }
      if (meta && e.key === 'Enter') { e.preventDefault(); if (!busy && state.base) $('go').click(); return; }
      if (meta && (e.key === 's' || e.key === 'S')) { e.preventDefault(); if (state.out && !busy) $('dl').click(); return; }
      if (e.key === 'Escape' && !$('cropWrap').hidden) closeCrop();
    });
  }

  /* ---------- init ---------- */

  function init() {
    initStageVideo();
    initMenu();
    initMotion();
    fillPresets();
    restoreSettings();
    applyShareHash();
    updateQ();
    $('brv').textContent = $('br').value + '%';
    $('ctv').textContent = $('ct').value + '%';
    syncStamp();
    bind();
    sync();
    renderQueue();
    renderBatch();
    updateBatchNote();
    updateButtons();
  }

  init();
})();
