// Page behaviour: light/dark theme swap (as on the 3DPS page), sequence chips that retarget a themed video,
// and the fitting slider. Every element with class "themed" declares data-light / data-dark sources.
(function () {
  var root = document.documentElement;
  var KEY = 'fdps-theme';
  var btn = document.getElementById('theme-toggle');
  var icon = document.getElementById('theme-icon');
  function osDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function theme() { return root.getAttribute('data-theme') || 'light'; }

  function swapVideo(el, src, keepTime) {
    // rapid toggling must not stack stale seek handlers (3DPS page, same fix)
    var pos = keepTime ? el.currentTime : 0;
    if (el._seek) { el.removeEventListener('loadedmetadata', el._seek); el._seek = null; }
    el.setAttribute('src', src);
    el.load();
    // iOS Safari fetches nothing (not even metadata) until play() is called,
    // so the metadata callback below never runs there; a muted inline play()
    // needs no gesture, so ask for it right away (the 3DPS/mmIR fix)
    if (el.hasAttribute('autoplay')) el.play().catch(function () {});
    var seek = function () {
      el.removeEventListener('loadedmetadata', seek);
      if (el._seek === seek) el._seek = null;
      if (el.getAttribute('src') !== src) return;
      if (pos && isFinite(el.duration) && el.duration > 0) el.currentTime = pos % el.duration;
      el.play().catch(function () {});
    };
    el._seek = seek;
    el.addEventListener('loadedmetadata', seek);
  }

  function apply(t) {
    root.setAttribute('data-theme', t);
    if (icon) icon.className = (t === 'dark') ? 'fas fa-sun' : 'fas fa-moon';
    document.querySelectorAll('.themed').forEach(function (el) {
      var src = el.getAttribute('data-' + t);
      if (!src || el.getAttribute('src') === src) return;
      if (el.tagName === 'VIDEO') swapVideo(el, src, true); else el.setAttribute('src', src);
    });
    window.dispatchEvent(new CustomEvent('fdps-theme', { detail: t }));
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      document.querySelectorAll('img.themed').forEach(function (el) {
        ['light', 'dark'].forEach(function (t) {
          var s = el.getAttribute('data-' + t);
          if (s && el.getAttribute('src') !== s) { var im = new Image(); im.src = s; }
        });
      });
    }, 800);
  });
  window.fdpsTheme = theme;
  apply(stored() || (osDark() ? 'dark' : 'light'));
  if (btn) btn.addEventListener('click', function () {
    var next = (theme() === 'dark') ? 'light' : 'dark';
    try { localStorage.setItem(KEY, next); } catch (e) {}
    apply(next);
  });
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (!stored()) apply(osDark() ? 'dark' : 'light');
  });

  // sequence chips: <div class="chips" id="X-chips"> drives <video id="X-video" data-base=...>
  function wireChips(prefix) {
    var box = document.getElementById(prefix + '-chips');
    var vid = document.getElementById(prefix + '-video');
    if (!box || !vid) return;
    var base = vid.getAttribute('data-base');
    var chips = box.querySelectorAll('.chip[data-seq]');
    function pick(chip) {
      chips.forEach(function (c) { c.classList.toggle('on', c === chip); });
      var s = chip.getAttribute('data-seq');
      var v = vid.getAttribute('data-v') || '1';
      vid.setAttribute('data-light', base + s + '_light.mp4?v=' + v);
      vid.setAttribute('data-dark', base + s + '_dark.mp4?v=' + v);
      swapVideo(vid, vid.getAttribute('data-' + theme()), false);
    }
    chips.forEach(function (c) { c.addEventListener('click', function () { pick(c); }); });
    if (chips.length) chips[0].classList.add('on');
  }
  wireChips('fid');
  wireChips('pose');

  // Mobile fallbacks: iOS pauses or never starts autoplay clips that are off
  // screen, and Low Power Mode blocks autoplay until a gesture. Nudge every
  // autoplay clip as it enters the viewport, and once on the first touch.
  (function () {
    var clips = Array.prototype.slice.call(document.querySelectorAll('video[autoplay]'));
    function nudge(v) { if (v.paused) v.play().catch(function () {}); }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) {
        es.forEach(function (e) { if (e.isIntersecting) nudge(e.target); });
      }, { threshold: 0.1 });
      clips.forEach(function (v) { io.observe(v); });
    }
    var unlock = function () {
      clips.forEach(nudge);
      if (window.fdpsFitUpdate) window.fdpsFitUpdate();
    };
    document.addEventListener('touchend', unlock, { once: true, passive: true });
    document.addEventListener('pointerdown', unlock, { once: true, passive: true });
  })();

  // fitting video: videos/fitting_{light,dark}.mp4, one frame per training epoch, with holds on the first and last
  // states; videos/fitting.json = {fps, hold_frames, epochs}. The slider shows and seeks the epoch; the button
  // pauses; the video plays only while on screen (and not after the viewer paused it).
  var fv = document.getElementById('fit-video');
  var slider = document.getElementById('fit-slider');
  var readout = document.getElementById('fit-readout');
  var playBtn = document.getElementById('fit-play');
  if (fv && slider) {
    fetch('./static/videos/fitting.json').then(function (r) { return r.json(); }).then(function (meta) {
      var last = meta.epochs - 1, userPaused = false, visible = false, dragging = false;
      slider.max = last;
      function epochAt(t) { return Math.max(0, Math.min(last, Math.floor(t * meta.fps + 1e-3) - meta.hold_frames)); }
      function label(e) { return e === 0 ? 'camera-initialized (epoch 0)' : 'epoch ' + e + ' / ' + last; }
      function sync() { if (!dragging) { var e = epochAt(fv.currentTime); slider.value = e; readout.textContent = label(e); } }
      (function tick() { sync(); requestAnimationFrame(tick); })();
      function update() {
        if (!userPaused && visible) { fv.play().catch(function () {}); } else { fv.pause(); }
        if (playBtn) playBtn.textContent = userPaused ? 'play' : 'pause';
      }
      window.fdpsFitUpdate = update;          // the first-touch fallback above re-asks for playback
      if (playBtn) playBtn.addEventListener('click', function () { userPaused = !userPaused; update(); });
      slider.addEventListener('input', function () {
        dragging = true; userPaused = true; update();
        var e = +slider.value;
        fv.currentTime = (meta.hold_frames + e + 0.5) / meta.fps;
        readout.textContent = label(e);
      });
      slider.addEventListener('change', function () { dragging = false; });
      new IntersectionObserver(function (es) {
        visible = es.some(function (x) { return x.isIntersecting; }); update();
      }, { threshold: 0.25 }).observe(fv);
    }).catch(function () {});
  }
})();
