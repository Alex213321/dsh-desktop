// DSH built-in skin switcher — client engine injected into the Web GUI.
// Two video slots give seamless, flash-free wallpaper switching: the old
// wallpaper keeps playing until the new one's first frame is ready. Every
// wallpaper has its own parameter profile (stored by the shell).
(function () {
  'use strict';
  if (window.__dshSkinInjected) return;
  window.__dshSkinInjected = true;

  const bridge = window.dshSkin;
  if (!bridge) return;

  const TOKENS = [
    '--dsw-alias-bg-base',
    '--dsw-alias-bg-layer-1',
    '--dsw-alias-bg-layer-2',
    '--dsw-alias-bg-overlay',
    '--dsw-specific-sidebar-fill',
  ];

  const PROFILE_DEFAULTS = {
    bgBaseAlpha: 35,
    surfaceAlpha: 45,
    overlayAlpha: 60,
    veil: 8,
    brightness: 104,
  };

  let config = {
    currentId: 'idle',
    profile: { ...PROFILE_DEFAULTS },
    wallpapers: [],
  };

  let veilEl = null;
  let imageEl = null;
  let videoA = null;
  let videoB = null;
  let styleEl = null;
  let fabEl = null;
  let panelEl = null;
  let gridEl = null;
  const sliderRefs = {};

  // --- dual video slots -------------------------------------------------------
  const slotEl = { a: null, b: null };
  const slotId = { a: null, b: null };
  let activeSlot = 'a';

  function make(tag, cls) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    return el;
  }
  function noop() {}

  // Start media on an idle tick (the first time) so the freshly opened UI
  // paints before the wallpaper + mascot videos begin decoding; afterwards
  // every start is immediate (user actions stay snappy).
  let mediaStarted = false;
  function deferPlay(v) {
    const start = () => {
      mediaStarted = true;
      try {
        v.play().catch(noop);
      } catch (e) {}
    };
    if (mediaStarted) {
      start();
      return;
    }
    if (window.requestIdleCallback) window.requestIdleCallback(start, { timeout: 1200 });
    else setTimeout(start, 700);
  }

  // Throttle: leading call passes through, trailing call is coalesced.
  function throttle(fn, ms) {
    let timer = null;
    let last = 0;
    return function () {
      const now = Date.now();
      if (now - last >= ms) {
        last = now;
        fn();
        return;
      }
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, ms - (now - last));
    };
  }

  // Burst: re-measure now and again through a typical layout animation
  // (sidebar collapse ~200-400ms), so the button ends exactly in place.
  function burstReposition(fn) {
    fn();
    [60, 180, 400, 760].forEach((ms) => setTimeout(fn, ms));
  }

  function ensureLayers() {
    if (veilEl) return;
    veilEl = make('div');
    veilEl.id = 'dsh-skin-veil';
    imageEl = make('div');
    imageEl.className = 'dsh-skin-image';
    imageEl.style.display = 'none';
    videoA = make('video');
    videoB = make('video');
    videoA.className = 'dsh-skin-video';
    videoB.className = 'dsh-skin-video';
    for (const v of [videoA, videoB]) {
      v.muted = true; // 动态壁纸静音
      v.loop = true; // 循环播放
      v.playsInline = true;
      v.style.display = 'none';
    }
    styleEl = make('style');
    styleEl.id = 'dsh-skin-style';
    document.body.appendChild(veilEl);
    document.body.appendChild(imageEl);
    document.body.appendChild(videoA);
    document.body.appendChild(videoB);
    document.head.appendChild(styleEl);
    slotEl.a = videoA;
    slotEl.b = videoB;
  }

  function currentVideo() {
    return slotEl[activeSlot];
  }

  function findSlotForId(id) {
    if (slotId.a === id) return 'a';
    if (slotId.b === id) return 'b';
    return null;
  }

  function swapTo(slot) {
    if (slot === activeSlot) return;
    const from = activeSlot;
    slotEl[from].style.display = 'none';
    try { slotEl[from].pause(); } catch (e) {}
    activeSlot = slot;
    slotEl[slot].style.display = 'block';
    deferPlay(slotEl[slot]);
  }

  function applyWallpaper() {
    if (!videoA || !config) return;
    const filter = 'brightness(' + config.profile.brightness / 100 + ')';
    videoA.style.filter = filter;
    videoB.style.filter = filter;
    imageEl.style.filter = filter;
    const meta = config.wallpapers.find((w) => w.id === config.currentId);
    if (!meta) {
      imageEl.style.display = 'none';
      videoA.style.display = 'none';
      videoB.style.display = 'none';
      try { videoA.pause(); videoB.pause(); } catch (e) {}
      return;
    }
    // Static image wallpaper: show it in the dedicated image layer.
    if (meta.kind === 'image') {
      videoA.style.display = 'none';
      videoB.style.display = 'none';
      try { videoA.pause(); videoB.pause(); } catch (e) {}
      const url = 'wallpaper://skin/video/' + encodeURIComponent(meta.id);
      imageEl.style.backgroundImage = 'url("' + url + '")';
      imageEl.style.display = 'block';
      return;
    }
    imageEl.style.display = 'none';
    // Already showing this wallpaper — nothing to do.
    if (slotId[activeSlot] === meta.id) {
      currentVideo().style.display = 'block';
      deferPlay(currentVideo());
      return;
    }
    // Loaded in the other slot — instant swap, no flash.
    const existing = findSlotForId(meta.id);
    if (existing) {
      swapTo(existing);
      return;
    }
    // New wallpaper: keep the current one playing until the new one has
    // buffered enough to start cleanly (canplay), then swap.
    const target = activeSlot === 'a' ? 'b' : 'a';
    const el = slotEl[target];
    const url = 'wallpaper://skin/video/' + encodeURIComponent(meta.id);
    const onReady = () => {
      slotId[target] = meta.id;
      swapTo(target);
    };
    if (el.getAttribute('src') !== url) {
      slotId[target] = null;
      el.src = url;
      el.load();
    }
    if (el.readyState >= 3) onReady();
    else el.addEventListener('canplay', onReady, { once: true });
  }

  // --- theme token translucency ------------------------------------------------
  function captureAndBuild() {
    if (!styleEl) return;
    const wasOn = document.body.classList.contains('dsh-skin');
    document.body.classList.remove('dsh-skin');
    const cs = getComputedStyle(document.body);
    const lines = ['body.dsh-skin{'];
    for (const t of TOKENS) {
      const v = (cs.getPropertyValue(t) || '').trim();
      if (!v) continue;
      let alpha = config.profile.surfaceAlpha;
      if (t === '--dsw-alias-bg-base') alpha = config.profile.bgBaseAlpha;
      else if (t === '--dsw-alias-bg-overlay') alpha = config.profile.overlayAlpha;
      lines.push(t + ':color-mix(in srgb,' + v + ' ' + alpha + '%,transparent)!important;');
    }
    lines.push('}');
    styleEl.textContent = lines.join('');
    if (wasOn) document.body.classList.add('dsh-skin');
  }

  function applyVeil() {
    if (veilEl) veilEl.style.backgroundColor = 'rgba(8,10,20,' + config.profile.veil / 100 + ')';
  }

  function applyAll() {
    if (!veilEl) return;
    captureAndBuild();
    applyVeil();
    applyWallpaper();
    document.body.classList.add('dsh-skin');
    syncActiveCover();
    syncSliders();
  }

  // --- switcher UI ------------------------------------------------------------
  // The 0.1.2-rc.1 chat composer is a Lexical editor, not a textarea; the UI
  // exposes stable data-* contracts for it, so prefer them with fallbacks.
  function findComposerInput() {
    return (
      document.querySelector('[data-composer-input]') ||
      document.querySelector('textarea') ||
      document.querySelector('[contenteditable="true"]')
    );
  }

  // Position the maid button at the horizontal midpoint between the message
  // input box's right edge and the window's right edge. The layout is fluid,
  // so re-measure on resize and periodically.
  function positionFab() {
    if (!fabEl) return;
    const BUTTON_WIDTH = 168;
    let right = 20;
    try {
      const ta = findComposerInput();
      if (ta) {
        const rect = ta.getBoundingClientRect();
        const gap = window.innerWidth - rect.right;
        if (gap > BUTTON_WIDTH) {
          right = gap / 2 - BUTTON_WIDTH / 2;
        } else {
          right = 8;
        }
      }
    } catch (e) {}
    fabEl.style.right = Math.max(8, Math.round(right)) + 'px';
    if (panelEl) panelEl.style.right = fabEl.style.right;
  }

  function buildFab() {
    if (fabEl) return;
    fabEl = make('button');
    fabEl.id = 'dsh-skin-fab';
    fabEl.title = '壁纸皮肤';
    // 优雅女仆舞：muted looping video fills the round button.
    const icon = make('video');
    icon.muted = true;
    icon.loop = true;
    icon.playsInline = true;
    icon.src = 'wallpaper://skin/fab';
    deferPlay(icon);
    fabEl.appendChild(icon);
    fabEl.addEventListener('click', () => {
      if (!panelEl) buildPanel();
      positionFab();
      panelEl.style.display = panelEl.style.display === 'none' ? '' : 'none';
    });
    document.body.appendChild(fabEl);
    positionFab();
  }

  function sliderRow(key, label, min, max, suffix) {
    const row = make('div', 'dsh-skin-row');
    const lab = make('div', 'dsh-skin-label');
    const span = make('span');
    span.textContent = label;
    const val = make('b');
    lab.appendChild(span);
    lab.appendChild(val);
    const input = make('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    input.value = String(config.profile[key]);
    input.addEventListener('input', () => {
      config.profile[key] = Number(input.value);
      val.textContent = input.value + suffix;
      if (key === 'veil') applyVeil();
      else if (key === 'brightness') applyWallpaper();
      else captureAndBuild();
    });
    input.addEventListener('change', () => {
      bridge.setConfig({ params: { [key]: Number(input.value) } });
    });
    val.textContent = config.profile[key] + suffix;
    row.appendChild(lab);
    row.appendChild(input);
    sliderRefs[key] = { input, val, suffix };
    return row;
  }

  function renderCovers() {
    if (!gridEl) return;
    gridEl.innerHTML = '';
    for (const w of config.wallpapers) {
      const cover = make('div', 'dsh-skin-cover');
      cover.dataset.id = w.id;
      const url = 'wallpaper://skin/video/' + encodeURIComponent(w.id);
      if (w.kind === 'image') {
        const thumb = make('div', 'dsh-skin-cover-img');
        thumb.style.backgroundImage = 'url("' + url + '")';
        cover.appendChild(thumb);
      } else {
        const thumb = make('video');
        thumb.muted = true;
        thumb.preload = 'metadata';
        thumb.src = url;
        cover.appendChild(thumb);
      }
      const label = make('div', 'dsh-skin-cover-label');
      label.textContent = w.name;
      cover.appendChild(label);
      cover.addEventListener('click', () => {
        config.currentId = w.id;
        bridge.setConfig({ currentId: w.id });
        applyWallpaper();
        syncActiveCover();
      });
      gridEl.appendChild(cover);
    }
    syncActiveCover();
  }

  function syncActiveCover() {
    if (!gridEl) return;
    for (const el of gridEl.children) {
      el.classList.toggle('dsh-skin-active', el.dataset.id === config.currentId);
    }
  }

  function syncSliders() {
    for (const key of Object.keys(sliderRefs)) {
      const ref = sliderRefs[key];
      if (!ref) continue;
      ref.input.value = String(config.profile[key]);
      ref.val.textContent = config.profile[key] + ref.suffix;
    }
  }

  function buildPanel() {
    panelEl = make('div');
    panelEl.className = 'dsh-skin-panel';
    panelEl.id = 'dsh-skin-panel';
    panelEl.style.display = 'none';

    const head = make('div', 'dsh-skin-head');
    const title = make('div', 'dsh-skin-title');
    title.textContent = '\u{1F3A8} \u58c1\u7eb8\u76ae\u80a4';
    const close = make('button', 'dsh-skin-close');
    close.textContent = '\u2715';
    close.addEventListener('click', () => {
      panelEl.style.display = 'none';
    });
    head.appendChild(title);
    head.appendChild(close);
    panelEl.appendChild(head);

    const coversWrap = make('div', 'dsh-skin-covers');
    gridEl = make('div', 'dsh-skin-grid');
    coversWrap.appendChild(gridEl);
    panelEl.appendChild(coversWrap);
    renderCovers();

    const defs = [
      ['bgBaseAlpha', '主背景不透明度', 20, 100, '%'],
      ['surfaceAlpha', '面板/侧栏不透明度', 25, 100, '%'],
      ['overlayAlpha', '弹层不透明度', 30, 100, '%'],
      ['veil', '深色遮罩', 0, 30, '%'],
      ['brightness', '视频亮度', 80, 120, '%'],
    ];
    for (const [key, label, min, max, suffix] of defs) {
      panelEl.appendChild(sliderRow(key, label, min, max, suffix));
    }

    document.body.appendChild(panelEl);
  }

  // Re-capture theme colors when the user flips dark/light/system.
  new MutationObserver(() => {
    if (config.wallpapers.length) captureAndBuild();
  }).observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });

  // --- boot ------------------------------------------------------------------
  ensureLayers();
  buildFab();
  window.addEventListener('resize', positionFab);
  // Event-driven repositioning: any DOM/layout change (sidebar collapse,
  // SPA re-render) re-anchors the maid button within ~150ms. The interval
  // is only a slow safety net.
  new MutationObserver(throttle(() => burstReposition(positionFab), 100)).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
  });
  setInterval(positionFab, 5000); // keep the button anchored as the layout settles
  bridge.getConfig()
    .then((cfg) => {
      config = {
        currentId: (cfg && cfg.currentId) || 'idle',
        profile: { ...PROFILE_DEFAULTS, ...((cfg && cfg.profile) || {}) },
        wallpapers: (cfg && cfg.wallpapers) || [],
      };
      if (!Array.isArray(config.wallpapers)) config.wallpapers = [];
      buildPanel();
      applyAll();
      positionFab();
    })
    .catch(() => {});
  bridge.onConfig((cfg) => {
    if (!cfg) return;
    const oldIds = (config.wallpapers || []).map((w) => w.id).join(',');
    const incoming = cfg.wallpapers && Array.isArray(cfg.wallpapers) ? cfg.wallpapers : config.wallpapers;
    const newIds = incoming.map((w) => w.id).join(',');
    config = {
      currentId: cfg.currentId || config.currentId,
      profile: { ...PROFILE_DEFAULTS, ...(cfg.profile || {}) },
      wallpapers: incoming,
    };
    if (!Array.isArray(config.wallpapers)) config.wallpapers = [];
    if (!panelEl) buildPanel();
    // Rebuild the cover grid only when the wallpaper list actually changed;
    // slider pushes must not reload thumbnails (IO contention → stutter).
    if (oldIds !== newIds) renderCovers();
    applyAll();
  });

  // --- frameless window: controls in a persistent top-right strip ----------
  // The strip is mounted immediately with the skin; the host header content
  // ("Session 日志" and friends) is shifted left so nothing sits underneath.
  const bridgeWindow = window.dshWindow;
  if (bridgeWindow) {
    function winButton(cls, title, svg) {
      const btn = document.createElement('button');
      btn.className = 'dsh-skin-win-btn ' + cls;
      btn.title = title;
      btn.innerHTML = svg;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (cls === 'dsh-skin-win-min') bridgeWindow.minimize();
        else if (cls === 'dsh-skin-win-max') bridgeWindow.maximize();
        else bridgeWindow.close();
      });
      return btn;
    }

    const btnMin = winButton(
      'dsh-skin-win-min dsh-skin-win-first',
      '最小化',
      '<svg width="15" height="15" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M2.5 6h7"/></svg>'
    );
    const btnMax = winButton(
      'dsh-skin-win-max',
      '最大化/还原',
      '<svg width="15" height="15" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2.5" y="2.5" width="7" height="7" rx="1"/></svg>'
    );
    const btnClose = winButton(
      'dsh-skin-win-close',
      '关闭',
      '<svg width="15" height="15" viewBox="0 0 12 12" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><path d="M3.2 3.2l5.6 5.6M8.8 3.2l-5.6 5.6"/></svg>'
    );

    // Persistent corner strip: the window controls always live at the very
    // top-right of the window, mounted immediately with the skin. The host
    // header content (e.g. "Session 日志") is shifted left so nothing sits
    // underneath; the strip itself carries the drag region (buttons no-drag).
    const TITLEBAR_W = 132;
    let titlebarEl = null;
    let paddingRow = null;

    function buildTitlebar() {
      const bar = document.createElement('div');
      bar.className = 'dsh-skin-titlebar';
      bar.appendChild(btnMin);
      bar.appendChild(btnMax);
      bar.appendChild(btnClose);
      document.body.appendChild(bar);
      return bar;
    }

    function findSessionLogButton() {
      const buttons = document.querySelectorAll('button');
      for (const b of buttons) {
        const t = (b.textContent || '').trim();
        if (t && t.includes('Session') && (t.includes('日志') || t.includes('log'))) return b;
      }
      return null;
    }

    function shiftHeaderForControls() {
      const log = findSessionLogButton();
      if (!log) return;
      let row = null;
      let node = log;
      for (let i = 0; i < 5 && node; i++) {
        const r = node.getBoundingClientRect();
        if (r.width > 300 && r.top < 100 && r.height > 0 && r.height <= 90) {
          row = node;
          break;
        }
        node = node.parentElement;
      }
      if (!row) return;
      if (paddingRow && paddingRow !== row) paddingRow.style.paddingRight = '';
      paddingRow = row;
      if (parseInt(paddingRow.style.paddingRight, 10) !== TITLEBAR_W) {
        paddingRow.style.paddingRight = TITLEBAR_W + 'px';
      }
    }

    function syncWindowUI() {
      if (!titlebarEl || !titlebarEl.isConnected) titlebarEl = buildTitlebar();
      shiftHeaderForControls();
    }

    syncWindowUI();
    // The header mounts asynchronously with the session; re-apply the
    // left-shift whenever it (or its content) changes. The interval is only
    // a safety net for odd re-renders.
    const shiftThrottled = throttle(shiftHeaderForControls, 400);
    const winObserver = new MutationObserver(() => {
      if (!titlebarEl || !titlebarEl.isConnected) titlebarEl = buildTitlebar();
      shiftThrottled();
    });
    winObserver.observe(document.body, { childList: true, subtree: true });
    setInterval(syncWindowUI, 5000);
  }

  // --- info button (凭空生花) + 信息 panel ----------------------------------
  const bridgeInfo = window.dshInfo;
  if (bridgeInfo) {
    const infoFab = make('div');
    infoFab.className = 'dsh-skin-info-fab';
    infoFab.title = '信息';
    const infoVideo = make('video');
    infoVideo.muted = true;
    infoVideo.loop = true;
    infoVideo.playsInline = true;
    infoVideo.src = 'wallpaper://skin/info-fab';
    // Match the maid's visual size: portrait/square footage keeps the full
    // figure (contain fills the 168px height), landscape fills the box.
    infoVideo.addEventListener(
      'loadedmetadata',
      () => {
        if (infoVideo.videoWidth && infoVideo.videoHeight) {
          infoVideo.style.objectFit = infoVideo.videoHeight >= infoVideo.videoWidth ? 'contain' : 'cover';
        }
      },
      { once: true }
    );
    deferPlay(infoVideo);
    infoFab.appendChild(infoVideo);
    document.body.appendChild(infoFab);

    let infoPanel = null;

    function buildInfoPanel() {
      if (infoPanel) return;
      infoPanel = make('div');
      infoPanel.className = 'dsh-skin-panel';
      infoPanel.id = 'dsh-info-panel';
      infoPanel.style.display = 'none';
      infoPanel.style.bottom = '200px';
      infoPanel.style.right = 'auto';
      infoPanel.style.width = '300px';

      const head = make('div', 'dsh-skin-head');
      const title = make('div', 'dsh-skin-title');
      title.textContent = '\u4fe1\u606f';
      const close = make('button', 'dsh-skin-close');
      close.textContent = '\u2715';
      close.addEventListener('click', () => {
        infoPanel.style.display = 'none';
      });
      head.appendChild(title);
      head.appendChild(close);
      infoPanel.appendChild(head);

      const vRow = make('div', 'dsh-skin-info-row');
      const vLabel = make('span');
      vLabel.textContent = 'DSH \u7248\u672c';
      const vVal = make('b', 'dsh-skin-info-val');
      vVal.id = 'dsh-info-version';
      vVal.textContent = '\u8bfb\u53d6\u4e2d\u2026';
      vRow.appendChild(vLabel);
      vRow.appendChild(vVal);
      infoPanel.appendChild(vRow);

      const bRow = make('div', 'dsh-skin-info-row');
      const bLabel = make('span');
      bLabel.textContent = 'DeepSeek API \u4f59\u989d';
      const bVal = make('b', 'dsh-skin-info-val');
      bVal.id = 'dsh-info-balance';
      bVal.textContent = '\u2014';
      bRow.appendChild(bLabel);
      bRow.appendChild(bVal);
      infoPanel.appendChild(bRow);

      const btnRow = make('div', 'dsh-skin-row');
      const updBtn = make('button', 'dsh-skin-btn');
      updBtn.style.width = '100%';
      updBtn.textContent = '\u66f4\u65b0\u4f59\u989d';
      updBtn.addEventListener('click', () => {
        updBtn.disabled = true;
        updBtn.textContent = '\u67e5\u8be2\u4e2d\u2026';
        bridgeInfo
          .getBalance()
          .then((res) => {
            updBtn.disabled = false;
            updBtn.textContent = '\u66f4\u65b0\u4f59\u989d';
            const bv = document.getElementById('dsh-info-balance');
            if (bv) {
              if (res && res.ok) {
                bv.textContent = res.balance + ' ' + (res.currency || 'CNY');
                bv.title = '';
              } else {
                bv.textContent = '\u67e5\u8be2\u5931\u8d25';
                bv.title = (res && res.reason) || '\u672a\u77e5\u9519\u8bef';
              }
            }
          })
          .catch(() => {
            updBtn.disabled = false;
            updBtn.textContent = '\u66f4\u65b0\u4f59\u989d';
            const bv = document.getElementById('dsh-info-balance');
            if (bv) bv.textContent = '\u67e5\u8be2\u5931\u8d25';
          });
      });
      btnRow.appendChild(updBtn);
      infoPanel.appendChild(btnRow);

      document.body.appendChild(infoPanel);
    }

    function measureSidebarRight() {
      // New harness UI (0.1.2-rc.1+): the composer seat spans the chat column
      // only, so its left edge is the sidebar's right edge.
      const seat = document.querySelector('[data-composer-seat]');
      if (seat) {
        const r = seat.getBoundingClientRect();
        if (r.width > 0) return r.left + 8;
      }
      // Legacy expanded sidebar: rows carry role="treeitem" (left half only —
      // the new JSON viewer also uses treeitem and must not be measured).
      let maxRight = 0;
      const items = document.querySelectorAll('[role="treeitem"]');
      for (const it of items) {
        const r = it.getBoundingClientRect();
        if (r.left < window.innerWidth / 2 && r.right > maxRight) maxRight = r.right;
      }
      if (maxRight > 0) return maxRight + 12;
      // Collapsed sidebar: a tall, narrow rail hugging the left edge.
      const candidates = document.querySelectorAll('div, nav, aside, section');
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.left <= 4 && r.height >= 200 && r.width >= 40 && r.width <= 140) {
          maxRight = Math.max(maxRight, r.right);
        }
      }
      return maxRight > 0 ? maxRight + 8 : 268;
    }

    function positionInfoFab() {
      // Horizontally centered between the sidebar's right edge and the
      // message input's left edge; bottom aligns with the maid button.
      // Works for both expanded and collapsed sidebar states.
      let left = window.innerWidth / 2 - 84;
      try {
        const sidebarRight = measureSidebarRight();
        const ta = findComposerInput();
        const inputLeft = ta ? ta.getBoundingClientRect().left : window.innerWidth * 0.55;
        left = (sidebarRight + inputLeft) / 2 - 84;
      } catch (e) {}
      left = Math.max(110, Math.min(Math.round(left), window.innerWidth - 200));
      infoFab.style.left = left + 'px';
      if (infoPanel) {
        infoPanel.style.left = Math.max(8, Math.min(Math.round(left + 84 - 150), window.innerWidth - 316)) + 'px';
      }
    }

    infoFab.addEventListener('click', () => {
      buildInfoPanel();
      positionInfoFab();
      if (infoPanel.style.display === 'none') {
        // Refresh the version every time the panel opens.
        bridgeInfo
          .getInfo()
          .then((info) => {
            const el = document.getElementById('dsh-info-version');
            if (el) el.textContent = info && info.version ? 'v' + info.version : '\u672a\u77e5';
          })
          .catch(() => {});
        infoPanel.style.display = '';
      } else {
        infoPanel.style.display = 'none';
      }
    });

    positionInfoFab();
    window.addEventListener('resize', positionInfoFab);
    // Same event-driven approach as the maid button: reposition within
    // ~150ms of any DOM/layout change; the interval is only a safety net.
    new MutationObserver(throttle(() => burstReposition(positionInfoFab), 100)).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    });
    setInterval(positionInfoFab, 5000);
  }
})();
