// dsh-web-remote — 远程访问面板注入脚本（浏览器端 UI）
// 注意：本脚本可能通过两条通道进入页面（结构化注入行 webserver/index-inject，
// 以及旧的 tapIndex 字符串变换），桌面版静态部署只认前者。开头做一次性守卫，
// 避免两条通道同时生效时重复初始化（会多出定时器与 MutationObserver）。
export const INJECT_SCRIPT = `(function () {
  if (window.__webrmLoaded) return;
  window.__webrmLoaded = true;
  var NL = String.fromCharCode(10);
  var CHECK = 0;
  var currentTab = 'public';
  var lastInfo = null;
  var QR_SOURCES = ['https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=', 'https://api.pwmqr.com/qrcode/create/?url='];
  var currentBotChannel = null;
  // 断开态下用户点「重新配置」时强制显示配置表单（否则 token 失效就无路可走）
  var forceConfigChannel = null;
  // QQ 官方「扫码绑定」：是否处于扫码流程中 + 轮询句柄
  var qqQrActive = false;
  var qqQrPoll = null;
  var qqQrShownUrl = '';   // 已渲染到 <img> 的二维码 URL（避免每次重渲染都换源）
  function qqStopQrPoll() {
    if (qqQrPoll) { clearInterval(qqQrPoll); qqQrPoll = null; }
  }
  function saveTab() {
    try { localStorage.setItem('webrm-tab', currentTab); } catch (e) {}
  }
  function loadTab() {
    var t = 'public';
    try {
      var v = localStorage.getItem('webrm-tab');
      if (v === 'lan') t = 'lan';
      else if (v === 'bot') t = 'bot';
    } catch (e) {}
    return t;
  }
  function style() {
    var css = '#webrm-native{z-index:1;height:34px;margin:0;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#6e6e73);cursor:pointer;background:transparent;border:none;border-radius:8px;display:flex;align-items:center;justify-content:center;gap:4px;padding:0 8px;font-size:13px;font-weight:500;font-family:inherit;transition:background .15s ease,color .15s ease}#webrm-native:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-native:active{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(120,120,128,.2))}#webrm-mask{position:fixed;inset:0;z-index:100000;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);}#webrm-panel{position:fixed;z-index:100001;left:50%;top:50%;transform:translate(-50%,-50%);width:min(440px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#fff) 80%,transparent);-webkit-backdrop-filter:blur(30px) saturate(180%);backdrop-filter:blur(30px) saturate(180%);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:24px;box-shadow:0 24px 70px var(--dsw-alias-bg-mask-3,rgba(0,0,0,.3)),0 4px 16px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1));padding:22px 20px 18px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1d1d1f);font-size:14px;line-height:22px;font-family:-apple-system,BlinkMacSystemFont,\\'SF Pro Text\\',\\'Segoe UI\\',Roboto,\\'PingFang SC\\',\\'Microsoft YaHei\\',sans-serif;-webkit-font-smoothing:antialiased}#webrm-panel h2{margin:0 0 14px;font-size:19px;font-weight:600;letter-spacing:-.2px;display:flex;align-items:center;justify-content:space-between;color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-close{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.14));border:none;cursor:pointer;width:26px;height:26px;border-radius:50%;font-size:15px;line-height:1;color:var(--dsw-alias-label-secondary,#48484a);display:flex;align-items:center;justify-content:center;padding:0;transition:background .15s}#webrm-close:hover{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(120,120,128,.26))}#webrm-tabs{display:flex;justify-content:center;gap:2px;margin:2px 0 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));border-radius:10px;padding:2px;width:fit-content;margin-left:auto;margin-right:auto}#webrm-tabs button{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:5px 22px;font-size:13px;font-weight:500;font-family:inherit;transition:all .18s ease}#webrm-tabs button.webrm-tab-active{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1))}body[data-ds-dark-theme] #webrm-tabs button.webrm-tab-active{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}#webrm-status{display:flex;align-items:center;gap:8px;margin:6px 0 4px;font-size:13px;color:var(--dsw-alias-label-secondary,#6e6e73)}#webrm-dot{width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-state-success-primary,#34c759);box-shadow:0 0 6px var(--dsw-alias-state-success-primary,#34c759)}.webrm-urlbox{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 70%,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.04));border-radius:14px;padding:12px 14px;margin:10px 0;cursor:pointer;word-break:break-all;box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.04));transition:background .15s}.webrm-urlbox:hover{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 90%,transparent)}.webrm-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#86868b);margin-bottom:4px}.webrm-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1d1d1f)}#webrm-row{display:flex;gap:2px;margin:16px 0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));border-radius:10px;padding:2px}.webrm-btn{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:6px 0;font-size:13px;font-weight:500;font-family:inherit;flex:1;text-align:center;transition:all .18s ease;-webkit-tap-highlight-color:transparent}.webrm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.1));color:var(--dsw-alias-label-primary,#1d1d1f)}.webrm-btn:active{transform:none}.webrm-btn-primary{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.1))}body[data-ds-dark-theme] .webrm-btn-primary{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}.webrm-btn-primary:hover{background:#fff;color:var(--dsw-alias-label-primary,#1d1d1f)}body[data-ds-dark-theme] .webrm-btn-primary:hover{background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff)}.webrm-btn:disabled{opacity:.45;cursor:default}#webrm-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#86868b);margin-top:12px;white-space:pre-wrap;line-height:19px}#webrm-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#ff3b30);margin-top:8px;white-space:pre-wrap}#webrm-qr{width:190px;height:190px;border-radius:14px;margin:12px auto;display:block;background:color-mix(in srgb,var(--dsw-alias-bg-overlay,#fff) 85%,#fff);padding:8px;box-sizing:border-box;box-shadow:0 2px 10px var(--dsw-alias-bg-mask-2,rgba(0,0,0,.06))}#webrm-bot-grid{display:flex;justify-content:center;gap:2px;margin:2px 0 12px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12));border-radius:10px;padding:2px;width:fit-content;margin-left:auto;margin-right:auto}.webrm-bot-chip{cursor:pointer;border:0!important;outline:none!important;appearance:none;-webkit-appearance:none;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73);border-radius:8px;padding:5px 14px;font-size:13px;font-weight:500;font-family:inherit;transition:all .18s ease;-webkit-tap-highlight-color:transparent}.webrm-bot-chip:hover{color:var(--dsw-alias-label-primary,#1d1d1f)}.webrm-bot-chip-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.1))}.webrm-bot-ic{display:inline-flex;align-items:center;justify-content:center;margin-right:4px;vertical-align:middle}.webrm-bot-ic svg{width:14px;height:14px}.webrm-bot-name{display:inline-block}#webrm-bot-detail{margin-top:4px}#webrm-bot-strow{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--dsw-alias-label-secondary,#6e6e73);margin:6px 0}#webrm-bot-dot{width:8px;height:8px;border-radius:50%;display:inline-block}#webrm-bot-desc{font-size:12px;color:var(--dsw-alias-label-secondary,#86868b);margin:4px 0 8px}.webrm-bot-actions{display:flex;gap:2px;margin:14px 0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.12));border-radius:10px;padding:2px}.webrm-bot-actions .webrm-btn{flex:1;padding:6px 0;font-size:13px;font-weight:500;border-radius:8px;white-space:nowrap;background:transparent;color:var(--dsw-alias-label-secondary,#6e6e73)}.webrm-bot-actions .webrm-btn-primary{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1d1d1f);box-shadow:0 1px 4px var(--dsw-alias-bg-mask-1,rgba(0,0,0,.1))}#webrm-bot-qr{margin:10px 0;padding:14px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:12px;text-align:center;color:var(--dsw-alias-label-secondary,#86868b);font-size:12px}#webrm-bot-empty{font-size:13px;color:var(--dsw-alias-label-secondary,#86868b);text-align:center;padding:14px 0}';
    var tag = document.createElement('style');
    tag.textContent = css;
    document.head.appendChild(tag);
    var extraCss = '#webrm-custom-url{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.1)}#webrm-custom-url .webrm-label2{font-size:12px;color:#8e8e93;margin-bottom:6px}#webrm-custom-url .webrm-edit-row{display:flex;gap:6px;align-items:center}#webrm-custom-url input{flex:1;padding:6px 8px;background:#f2f2f7;border:1px solid #d1d1d6;border-radius:6px;color:#1d1d1f;font-size:13px;outline:none;font-family:inherit}#webrm-custom-url input:focus{border-color:#0a84ff}#webrm-custom-url .webrm-btn-sm{padding:5px 10px;border-radius:6px;border:none;font-size:12px;font-weight:500;cursor:pointer;background:transparent;color:#8e8e93;font-family:inherit}#webrm-custom-url .webrm-btn-sm-primary{background:#0a84ff;color:#fff}#webrm-custom-url .webrm-placeholder{cursor:pointer;padding:6px 0;border-bottom:1px dashed rgba(120,120,128,.4);color:#636366;font-size:13px;display:flex;align-items:center;transition:border-color .2s}#webrm-custom-url .webrm-placeholder:hover{border-bottom-color:#0a84ff}#webrm-port-box{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.1)}#webrm-port-box .webrm-label2{font-size:12px;color:#8e8e93;margin-bottom:6px}#webrm-port-box .webrm-port-row{display:flex;align-items:center;gap:6px}#webrm-port-box .webrm-port-fixed{color:#8e8e93;font-size:13px;white-space:nowrap}#webrm-port-box .webrm-port-editable{cursor:pointer;padding:2px 0;border-bottom:1px dashed rgba(120,120,128,.4);color:#0a84ff;font-weight:500;font-size:13px}#webrm-port-box .webrm-port-editable:hover{border-bottom-color:#0a84ff}#webrm-port-box input{width:70px;padding:5px 8px;background:#f2f2f7;border:1px solid #d1d1d6;border-radius:6px;color:#1d1d1f;font-size:13px;outline:none;font-family:inherit}body[data-ds-dark-theme] #webrm-custom-url input,body[data-ds-dark-theme] #webrm-port-box input{background:rgba(120,120,128,.2);border-color:rgba(255,255,255,.2);color:#fff}body[data-ds-dark-theme] #webrm-custom-url .webrm-btn-sm{background:rgba(120,120,128,.2);color:#8e8e93}body[data-ds-dark-theme] #webrm-port-box .webrm-port-editable{color:#0a84ff}';
    var extraTag = document.createElement('style');
    extraTag.textContent = extraCss;
    document.head.appendChild(extraTag);
    // 移动端视觉缩小（不覆盖 viewport）
    var mobileTag = document.createElement('style');
    mobileTag.textContent = '@media(max-width:768px){html{zoom:80%}}';
    document.head.appendChild(mobileTag);
  }
  function isVisibleEl(el) {
    if (!el) return false;
    try {
      var c = window.getComputedStyle(el);
      if (c.display === 'none' || c.visibility === 'hidden' || c.opacity === '0') return false;
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) { return false; }
  }
  function rectContains(outer, inner) {
    return inner.left >= outer.left - 4 && inner.right <= outer.right + 4
      && inner.top >= outer.top - 4 && inner.bottom <= outer.bottom + 4;
  }
  /**
   * 找「原生参照按钮」：同容器里面积最大的可见原生 button（桌面版就是底部那个「账号菜单」按钮）。
   * 用户要求远程按钮「和上面用户头像按钮一样」，所以尺寸以它为准。
   */
  function findNativeRef(btn) {
    var area = btn.parentElement;
    if (!area) return null;
    var best = null;
    var cands = area.querySelectorAll('button');
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      if (c === btn || !isVisibleEl(c)) continue;
      var r = c.getBoundingClientRect();
      if (r.height <= 0 || r.height > 120) continue;   // 排除异常高度
      if (r.width < 60) continue;                      // 太窄的多半是纯图标按钮
      if (!best || r.width * r.height > best.r.width * best.r.height) best = { el: c, r: r };
    }
    return best;
  }
  /**
   * 把「远程」按钮的尺寸对齐到原生参照按钮。
   *
   * 为什么要反复调用：**参照按钮在插入之后还会自己变**。实测同一容器里
   * 「账号菜单」按钮在插入那一刻是 260x32，随后变成 244x44（头像加载/行高重排），
   * 只采样一次的话远程按钮就永远停在 240x32 上，高度和原生差 12px。
   * 所以这里做成幂等函数，由 ResizeObserver + 定时器反复调用。
   */
  function syncNativeSize(btn) {
    try {
      if (!btn || !btn.parentElement) return;
      var ref = findNativeRef(btn);
      if (!ref) return;
      var h = Math.round(ref.r.height);
      // ⚠ 只在**高度**变化时才写样式。
      // 早先的版本把宽度也纳入判据、并且每次都用「参照当前矩形」重算左右内缩与宽度 ——
      // 那会形成反馈循环：我改宽度 → 容器跟着变 → 参照矩形变 → 我再改宽度，
      // 实测控制台刷出 244x44 / 350x44 / 244x44 / 346x44 … 来回抖动。
      // 高度是稳定的（它就是那一行的高度），拿它当唯一判据即可。
      if (btn.dataset.webrmH === String(h)) return;
      var rc = window.getComputedStyle(ref.el);
      // 左右内缩只在**首次**确定一次，之后固定复用 —— 每次重算就会跟宽度抖动形成循环。
      if (!btn.dataset.webrmInset) {
        var ar = btn.parentElement.getBoundingClientRect();
        btn.dataset.webrmInset = String(Math.max(0, Math.round(ref.r.left - ar.left)));
      }
      var inset = Number(btn.dataset.webrmInset) || 6;
      // 左内边距抄参照自己的 paddingLeft。
      // 早先写成 paddingLeft = inset（桌面版 inset=0）→ 图标文字**贴死左边缘**（用户反馈）。
      var pl = parseFloat(rc.paddingLeft);
      btn.style.alignSelf = 'stretch';   // 撑满容器宽度 → 和原生那一行等宽，且能自适应侧边栏缩放
      btn.style.width = 'auto';
      btn.style.maxWidth = 'none';
      btn.style.flex = '0 0 auto';
      btn.style.boxSizing = 'border-box';
      btn.style.height = h + 'px';
      btn.style.minHeight = h + 'px';
      btn.style.borderRadius = rc.borderRadius;
      btn.style.fontSize = rc.fontSize;
      btn.style.paddingLeft = ((isFinite(pl) && pl >= 4) ? pl : 10) + 'px';
      btn.style.paddingRight = '10px';
      btn.style.justifyContent = 'flex-start';
      btn.style.gap = '8px';
      btn.style.margin = '2px ' + inset + 'px 6px ' + inset + 'px';
      btn.dataset.webrmH = String(h);
      // 日志同时打印「按钮实际宽度」与「参照宽度」——
      // 宽度不参与判据（靠 CSS align-self:stretch 自适应，拖侧边栏时零 JS 参与），
      // 但打出来便于核对跟随效果。
      try {
        var brSelf = btn.getBoundingClientRect();
        console.log('[webrm] 尺寸跟随原生按钮: 按钮', Math.round(brSelf.width) + 'x' + Math.round(brSelf.height),
          '/ 参照', Math.round(ref.r.width) + 'x' + h,
          '圆角', rc.borderRadius, '内缩', inset, '左内边距', btn.style.paddingLeft);
      } catch (e2) { /* ignore */ }
    } catch (e) { /* ignore */ }
  }
  function findSidebarRoot() {
    // 精确找侧边栏根：既要带 --dsh-sidebar-inline-padding，**又要几何上像侧边栏**（贴左、窄、高）。
    // 教训：桌面版里带这个 CSS 变量的元素不止一个（工作区面板也用），
    // 只按"第一个匹配"会拿到错误元素 —— 按钮被挂到 x=658 那种窗口中间的位置，用户完全看不到。
    var all = document.querySelectorAll('div');
    var best = null;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      try {
        var v = window.getComputedStyle(el).getPropertyValue('--dsh-sidebar-inline-padding');
        if (!v || v.trim() === '') continue;
        if (!isVisibleEl(el)) continue;
        var r = el.getBoundingClientRect();
        if (r.left > 90) continue;                            // 必须贴左边
        if (r.width < 90 || r.width > 460) continue;          // 宽度像侧边栏
        if (r.height < window.innerHeight * 0.35) continue;   // 高度占主体
        if (!best || r.height > best.r.height) best = { el: el, r: r };
      } catch (e) { /* ignore */ }
    }
    return best ? best.el : null;
  }
  function findSettingsArea() {
    var root = findSidebarRoot();
    var rootRect = root ? root.getBoundingClientRect() : null;
    // ① 设置按钮的父容器 —— 但必须**可见**且**落在侧边栏内**。
    //    桌面版把「设置」挪进了头像弹出菜单：菜单项在 DOM 里但不在侧边栏内，
    //    直接采用会把按钮塞进"只有菜单打开时才看得见"的容器。
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
      if (!/setting|设置|preference|偏好/i.test(label)) continue;
      if (!isVisibleEl(b)) continue;
      if (rootRect && !rectContains(rootRect, b.getBoundingClientRect())) continue;
      var parent = b.parentNode;
      if (parent) return parent;
    }
    // ② 兜底：侧边栏根元素的最后一个直接子容器（通常就是底部工具行）
    if (root && root.children.length) {
      var foot = root.children[root.children.length - 1];
      if (foot) return foot;
    }
    return null;
  }
  function updateVisibility() {
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    var root = findSidebarRoot();
    var collapsed = root && (root.className || '').indexOf('collapsed') !== -1;
    btn.style.display = collapsed ? 'none' : '';
  }
  function syncGearColor() {
    // 重新读取设置按钮当前颜色并应用到远程按钮（主题/皮肤切换后颜色会变）
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    var area = findSettingsArea();
    if (!area) return;
    var buttons = area.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] !== btn) {
        try { btn.style.color = window.getComputedStyle(buttons[i]).color; } catch (e) { /* ignore */ }
        return;
      }
    }
  }
  function attachButton(btn) {
    // 插入设置按钮旁（同一容器）
    var area = findSettingsArea();
    if (area) {
      // ⚠ 只追加按钮 —— **绝不**改父容器的布局、也**不碰**兄弟按钮的样式。
      //
      // 教训：这里原本会把容器改成 display:flex/justify-content:flex-start，
      // 并把所有兄弟 button 强制压成 34px 高、width:auto。
      // 浏览器版的「设置行」有余量，这么改没感觉；但**桌面版这个容器是头像行** ——
      // 强改布局 + 压缩兄弟按钮会把**用户头像挤成细条**（用户反馈"头像没回原位"）。
      //
      // 让按钮用自己的 CSS（#webrm-native）融入即可；容器本来多是 flex 行，
      // 直接追加就能正常排布。
      try { syncGearColor(); } catch (e) { /* ignore */ }
      area.appendChild(btn);
      // ── 尺寸对齐同容器里的原生按钮（桌面版就是「账号菜单」那一行）──
      // 用户要求「和上面用户头像按钮一样」。这里只做**首次**对齐；
      // 参照按钮插入后还会自己变（实测 260x32 → 244x44），
      // 所以下面挂了 ResizeObserver + 定时器反复调用 syncNativeSize 持续跟随。
      // 注意：只写 btn.style，原生元素一个都不碰（碰过一次，把头像挤扁了）。
      syncNativeSize(btn);
      if (!btn.style.height) {
        // 找不到参照时的保守兜底
        btn.style.alignSelf = 'stretch';
        btn.style.width = 'auto';
        btn.style.height = '34px';
        btn.style.justifyContent = 'flex-start';
        btn.style.margin = '2px 6px 6px';
      }
      try { console.log('[webrm] inserted into:', area.tagName, area.className.slice(0, 80)); } catch (e) {}
      // ── 插入后校验：按钮必须真的落在侧边栏内 ──
      // 桌面版里"设置"藏在头像弹出菜单，菜单项虽在 DOM 但不在侧边栏区域；
      // 若不校验，按钮会被插到窗口中间(x≈658)那种谁也看不见的地方，且 attachButton 还报"成功"。
      try {
        var sroot = findSidebarRoot();
        if (sroot) {
          var sr = sroot.getBoundingClientRect();
          var br = btn.getBoundingClientRect();
          if (!rectContains(sr, br)) {
            if (!window.__webrmWarned) {
              window.__webrmWarned = true;
              console.warn('[webrm] 插入位置不在侧边栏内（btn', Math.round(br.left), Math.round(br.top),
                '/ sidebar', Math.round(sr.left), Math.round(sr.width), '）→ 撤销，改走兜底');
            }
            if (btn.parentNode) btn.parentNode.removeChild(btn);
            return false;
          }
        }
      } catch (e) { /* 校验失败就不阻断，视为通过 */ }
      // 监听侧边栏根元素 class 变化（展开/收起）
      var root = findSidebarRoot();
      if (root && window.MutationObserver) {
        var obs = new MutationObserver(updateVisibility);
        obs.observe(root, { attributes: true, attributeFilter: ['class'] });
      }
      // 监听主题/皮肤变化：body/html 的 class/data/style 属性变化时重新同步颜色
      if (window.MutationObserver) {
        var themeObs = new MutationObserver(syncGearColor);
        themeObs.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'data-theme', 'style'] });
        if (document.documentElement) {
          themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-ds-dark-theme', 'data-theme', 'style'] });
        }
      }
      // ── 尺寸持续跟随原生参照按钮 ──
      // 只在插入时采样一次不够：参照按钮随后会自己变（实测 260x32 → 244x44，
      // 头像加载/行高重排导致），远程按钮就会停在旧尺寸上，高度和原生差一截。
      // 双保险：ResizeObserver 立即响应 + 定时器兜底（参照被重建时也能接上）。
      try {
        if (window.ResizeObserver) {
          var refForObs = findNativeRef(btn);
          if (refForObs) {
            var sizeObs = new ResizeObserver(function () { syncNativeSize(btn); });
            sizeObs.observe(refForObs.el);
            sizeObs.observe(area);   // 侧边栏展开/收起也要跟着走
          }
        }
        if (window.addEventListener) {
          window.addEventListener('resize', function () { syncNativeSize(btn); });
        }
      } catch (e) { /* ignore */ }
      // 兜底：每 2 秒同步一次颜色 + 尺寸（覆盖纯 CSS 变量变化/参照被重建，开销极小）
      var colorTimer = setInterval(function () {
        try { syncGearColor(); } catch (e) { /* ignore */ }
        syncNativeSize(btn);
      }, 2000);
      updateVisibility();
      return true;
    }
    return false;
  }
  function create() {
    if (document.getElementById('webrm-native')) return;
    style();
    var btn = document.createElement('button');
    btn.id = 'webrm-native';
    btn.type = 'button';
    btn.title = '远程访问';
    btn.setAttribute('aria-label', '远程访问');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="2" width="10" height="20" rx="2"/><line x1="11" y1="18" x2="13" y2="18"/></svg><span>远程</span>';
    btn.style.position = 'relative';
    // 通道断开红点：任一通道 down 时显示，点击直达该通道页
    var hdot = document.createElement('i');
    hdot.id = 'webrm-native-dot';
    hdot.style.cssText = 'position:absolute;top:-1px;right:-1px;width:9px;height:9px;border-radius:50%;background:#ef4444;display:none;box-shadow:0 0 0 2px var(--dsw-alias-bg-layer-1,#fff);cursor:pointer';
    hdot.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      var list = (lastHealthInfo && lastHealthInfo.downList) || [];
      if (!list.length) return;
      currentBotChannel = list[0];  // 直达第一个出问题的通道页
      currentTab = 'bot';           // 面板打开即停在机器人标签
      saveTab();
      if (document.getElementById('webrm-mask')) {
        // 面板已打开：直接就地重渲染到机器人页
        var p = document.getElementById('webrm-panel');
        var h = document.getElementById('webrm-hint');
        if (p) { try { renderStatus(p, lastInfo || lastInfoCache, h); } catch (e) { /* ignore */ } }
      } else {
        openPanel();
      }
    });
    btn.appendChild(hdot);
    btn.addEventListener('click', openPanel);
    // 侧边栏由 React 异步渲染：轮询等待（最多 10 秒），找到设置区域再插入
    if (attachButton(btn)) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (attachButton(btn)) {
        clearInterval(timer);
        return;
      }
      if (tries >= 40) {
        clearInterval(timer);
        // 兜底：挂载失败（DOM 结构不认识）时**固定定位钉在侧边栏左下角**，
        // 而不是丢到 body 末尾 —— 后者位置随机，用户根本找不到按钮。
        try {
          var root = findSidebarRoot();
          var r = root ? root.getBoundingClientRect() : null;
          btn.style.position = 'fixed';
          btn.style.left = ((r ? r.left : 0) + 12) + 'px';
          btn.style.bottom = '56px';   // 让开底部头像行
          btn.style.zIndex = '9999';
          btn.title = '远程访问（兜底定位：未找到侧边栏插槽）';
          console.log('[webrm] 兜底定位到侧边栏底部', btn.style.left, btn.style.bottom);
        } catch (e) { /* ignore */ }
        document.body.appendChild(btn);
      }
    }, 250);
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  var lastHealthInfo = null;   // 最近一次 /remote/info 的 health 字段（红点用）
  var lastInfoCache = null;    // 最近一次完整 info（面板重渲染用）
  /** 根据 /remote/info 的 health 更新「远程」按钮红点 */
  function updateHealthDot(info) {
    lastInfoCache = info;
    lastHealthInfo = (info && info.health) || null;
    var dot = document.getElementById('webrm-native-dot');
    if (!dot) return;
    var down = lastHealthInfo && lastHealthInfo.downList ? lastHealthInfo.downList : [];
    if (down.length) {
      var names = { weixin: '微信', feishu: '飞书', telegram: '纸飞机', dingtalk: '钉钉', qq: 'QQ', qqbot: 'QQ官方' };
      dot.style.display = 'block';
      dot.title = '通道断开：' + down.map(function (k) { return names[k] || k; }).join('、') + '\\n点此直达修复';
    } else {
      dot.style.display = 'none';
      dot.title = '';
    }
  }
  function fetchInfo() {
    // 时间戳参数强制绕过所有缓存（浏览器 + 代理层）
    return fetch('/remote/info?_=' + Date.now(), { cache: 'no-store' }).then(function (res) { return res.json(); }).then(function (info) {
      try { updateHealthDot(info); } catch (e) { /* 红点失败不影响主流程 */ }
      return info;
    });
  }
  function act(action) {
    return fetch('/remote/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: action }) }).then(function (res) { return res.json(); });
  }
  function copyText(text, labelEl, doneLabel) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (labelEl) {
          var prev = labelEl.textContent;
          labelEl.textContent = doneLabel || '已复制 ✓';
          setTimeout(function () { labelEl.textContent = prev; }, 1500);
        }
      }).catch(function () {});
    }
  }
  // 白色滑块跟随真实运行状态：运行中→「启动」高亮，已停止→「停止」高亮
  function syncActionButtons(info) {
    var s = document.getElementById('webrm-start');
    var p = document.getElementById('webrm-stop');
    if (!s || !p) return;
    var running = !!(info && info.running);
    s.className = running ? 'webrm-btn webrm-btn-primary' : 'webrm-btn';
    p.className = running ? 'webrm-btn' : 'webrm-btn webrm-btn-primary';
  }
  // 机器人通道定义
  var BOT_CHANNELS = [
    { id: 'weixin', name: '微信', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z"/></svg>', hint: 'ClawBot / iLink 扫码接入' },
    { id: 'qq', name: 'QQ', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>', hint: 'NapCat（OneBot 11）连接后可用' },
    { id: 'qqbot', name: 'QQ官方', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.5C8.6 1.5 5.8 3.6 5.8 6.4c0 .3 0 .6.1.9C4.3 8.8 3.3 10.7 3.3 12.8c0 1.2.3 2.3.8 3.3-.5.6-.8 1.3-.8 2 0 .5.6.8 1.6.8.6 0 1.3-.1 2-.4.9.5 2 1 3.4 1.4l-.4 1.6c-.1.5.2.9.7.9.3 0 .6-.2.8-.5l1-2c.5.1 1 .1 1.5.1s1 0 1.5-.1l1 2c.2.3.5.5.8.5.5 0 .8-.4.7-.9l-.4-1.6c1.4-.4 2.5-.9 3.4-1.4.7.3 1.4.4 2 .4 1 0 1.6-.3 1.6-.8 0-.7-.3-1.4-.8-2 .5-1 .8-2.1.8-3.3 0-2.1-1-4-2.6-5.5.1-.3.1-.6.1-.9 0-2.8-2.8-4.9-6.2-4.9z"/></svg>', hint: 'QQ 开放平台 Agent 接入（官方，无需额外 QQ 号）' },
    { id: 'telegram', name: '纸飞机', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>', hint: 'Telegram Bot API 接入' },
    { id: 'dingtalk', name: '钉钉', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M10.5 7h3l-1.5 4h4l-6 8 1.5-4H8z" fill="#fff"/></svg>', hint: '钉钉机器人 Webhook 接入' },
    { id: 'feishu', name: '飞书', icon: '<svg viewBox="7 7 26 26" fill="currentColor"><path d="M16.791 30c5.57 0 10.423-3.074 12.955-7.618q.133-.239.258-.484a6 6 0 0 1-.425.699 6 6 0 0 1-.17.23 6 6 0 0 1-.225.274q-.092.105-.188.206a6 6 0 0 1-.407.384 6 6 0 0 1-.24.195 7 7 0 0 1-.292.21q-.094.065-.191.122c-.097.057-.134.081-.204.119q-.21.116-.428.215a6 6 0 0 1-.385.157 6 6 0 0 1-.43.138 6 6 0 0 1-.661.143 6 6 0 0 1-.491.055 6.125 6.125 0 0 1-1.543-.085 7 7 0 0 1-.38-.079l-.2-.051-.555-.155-.275-.081-.41-.125-.334-.107-.317-.104-.215-.073-.26-.091-.186-.066-.367-.134-.212-.081-.284-.11-.299-.119-.193-.079-.24-.1-.185-.078-.192-.084-.166-.073-.152-.067-.153-.07-.159-.073-.2-.093-.208-.099-.222-.108-.189-.093a31.2 31.2 0 0 1-8.822-6.583.202.202 0 0 0-.349.138l.005 9.52v.773c0 .448.222.87.595 1.118A14.75 14.75 0 0 0 16.791 30z"/><path d="M33.151 16.582a8.45 8.45 0 0 0-3.744-.869 8.5 8.5 0 0 0-2.303.317l-.252.075-.177.058-.348.127-.606.265-.617.33-.598.386-.404.306-.419.359-.218.206-.374.37-.269.266-.293.289-.281.278-.299.296-.348.344-.256.254-.085.084-.125.122-.063.06-.095.09-.105.099a15 15 0 0 1-3.072 2.175l.2.093.159.073.153.07.152.067.166.073.192.084.185.078.24.1.193.079.299.119.284.11.212.081.367.134.186.066.26.09.215.073.317.104.334.107.41.125.275.081.555.155.2.051.379.079.433.062.585.037.525-.014.491-.055a6 6 0 0 0 .66-.143l.43-.138.385-.158.427-.215.204-.119.191-.122.292-.21.24-.195.407-.384.188-.206.225-.274.17-.23a6 6 0 0 0 .421-.693l.144-.288 1.305-2.599-.003.006a8.1 8.1 0 0 1 1.697-2.439z"/><path d="M21.069 20.504l.063-.06.125-.122.085-.084.256-.254.348-.344.299-.296.281-.278.293-.289.269-.266.374-.37.218-.206.419-.359.404-.306.598-.386.617-.33.606-.265.348-.127.177-.058a14.78 14.78 0 0 0-2.793-5.603c-.252-.318-.639-.502-1.047-.502H12.221c-.196 0-.277.249-.119.364a31.49 31.49 0 0 1 8.943 10.162c.008-.007.016-.015.025-.023z"/></svg>', hint: '飞书机器人接入' },
  ];
  function botChannelStatus(id, info) {
    if (id === 'qq') return (info && info.qq === 'listening') ? '已就绪' : '等待 NapCat';
    if (id === 'weixin') {
      if (info && info.weixin === 'connected') return '已连接';
      if (info && info.weixin === 'waiting') return '等待扫码';
      return '未连接';
    }
    if (id === 'telegram') return (info && info.telegram === 'connected') ? '已连接' : '未连接';
    if (id === 'qqbot') {
      if (info && info.qqbot === 'connected') return '已连接';
      if (info && info.qqbot === 'configured') return '已配置';
      return '未配置';
    }
    if (id === 'feishu') {
      if (info && info.feishu === 'connected') return '已连接';
      if (info && info.feishu === 'configured') return '已配置';
      return '未配置';
    }
    return '未接入';
  }
  function renderBotPage(panel, info, hint) {
    var box = document.getElementById('webrm-urlbox');
    if (!box) return;
    box.textContent = '';
    var grid = el('div', '', '');
    grid.id = 'webrm-bot-grid';
    BOT_CHANNELS.forEach(function (ch) {
      var b = el('button', 'webrm-bot-chip' + (currentBotChannel === ch.id ? ' webrm-bot-chip-active' : ''), '');
      b.type = 'button';
      b.setAttribute('data-channel', ch.id);
      var ic = el('span', 'webrm-bot-ic', '');
      ic.innerHTML = ch.icon;
      var nm = el('span', 'webrm-bot-name', ch.name);
      b.appendChild(ic);
      b.appendChild(nm);
      b.addEventListener('click', function () {
        currentBotChannel = (currentBotChannel === ch.id) ? null : ch.id;
        forceConfigChannel = null;  // 切换通道时重置「强制配置表单」状态
        qqStopQrPoll();             // 离开时停掉扫码轮询，避免后台空转
        qqQrActive = false;
        renderBotPage(panel, info, hint);
      });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var detail = el('div', '', '');
    detail.id = 'webrm-bot-detail';
    if (currentBotChannel) {
      var ch = null;
      for (var i = 0; i < BOT_CHANNELS.length; i++) if (BOT_CHANNELS[i].id === currentBotChannel) { ch = BOT_CHANNELS[i]; break; }
      if (ch) {
        var status = botChannelStatus(ch.id, info);
        var stRow = el('div', 'webrm-bot-strow', '');
        stRow.id = 'webrm-bot-strow';
        var d = el('span', 'webrm-bot-dot', '');
        d.style.background = (status === '已就绪' || status === '已连接') ? '#22c55e' : '#ef4444';
        stRow.appendChild(d);
        stRow.appendChild(el('span', '', status));
        detail.appendChild(stRow);
        var desc = el('div', 'webrm-bot-desc', ch.name + '通道：' + ch.hint);
        detail.appendChild(desc);
        var btns = el('div', 'webrm-bot-actions', '');
        var connectBtn = el('button', 'webrm-btn webrm-btn-primary', '绑定');
        connectBtn.type = 'button';
        connectBtn.addEventListener('click', function () {
          var st2 = document.getElementById('webrm-bot-strow');
          var qr2 = document.getElementById('webrm-bot-qr');
          if (ch.id === 'weixin') {
            // 微信 iLink 扫码绑定
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '正在获取二维码…')); }
            if (qr2) qr2.textContent = '';
            fetch('/weixin/qrcode', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (data) {
              if (!data.ok) {
                if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '获取失败: ' + (data.error || '未知错误'))); }
                return;
              }
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '用微信扫描下方二维码')); }
              if (qr2) {
                qr2.textContent = '';
                var img = el('img', '', '');
                img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(data.qrcodeUrl);
                img.style.cssText = 'width:200px;height:200px;border-radius:8px;background:#fff';
                qr2.appendChild(img);
                var tip = el('div', '', '打开微信扫描上方二维码');
                tip.style.cssText = 'font-size:11px;color:var(--dsw-alias-label-secondary,#888);margin-top:6px;text-align:center';
                qr2.appendChild(tip);
              }
              // 开始轮询扫码状态
              var pollTimer = setInterval(function () {
                fetch('/weixin/poll').then(function (r) { return r.json(); }).then(function (res) {
                  if (res.status === 'connected') {
                    clearInterval(pollTimer);
                    if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '已连接')); st2.querySelector('span').previousElementSibling.style.background = '#22c55e'; }
                    if (qr2) qr2.textContent = '';
                    renderBotPage(panel, info, hint);
                  } else if (res.status === 'expired') {
                    clearInterval(pollTimer);
                    if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '二维码已过期，请重新绑定')); }
                  }
                }).catch(function () {});
              }, 3000);
            }).catch(function (e) {
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '网络错误: ' + e.message)); }
            });
          } else if (ch.id === 'feishu') {
            // 飞书：直接重新渲染飞书面板
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '请在下方填写凭证')); }
            renderBotPage(panel, info, hint);
          } else {
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '绑定中…（功能开发中）')); }
          }
        });
        var discBtn = el('button', 'webrm-btn', '解绑');
        discBtn.type = 'button';
        discBtn.addEventListener('click', function () {
          var st3 = document.getElementById('webrm-bot-strow');
          var qr3 = document.getElementById('webrm-bot-qr');
          if (ch.id === 'weixin') {
            fetch('/weixin/unbind', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              if (qr3) qr3.textContent = '';
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '解绑失败')); }
            });
          } else if (ch.id === 'feishu') {
            fetch('/remote/feishu/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              info.feishu = null;
              renderBotPage(panel, info, hint);
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '解绑失败')); }
            });
          } else {
            if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); }
          }
        });
        // QQ官方/Telegram/飞书 等通道在下方表单里有自己的「连接/断开」按钮，
        // 通用的「绑定/解绑」对它们无意义（点了只会显示"功能开发中"），直接不渲染。
        var selfManaged = (ch.id === 'qqbot' || ch.id === 'telegram' || ch.id === 'feishu' || ch.id === 'dingtalk');
        if (!selfManaged) {
          btns.appendChild(connectBtn);
          btns.appendChild(discBtn);
          detail.appendChild(btns);
        }
        var qrZone = el('div', 'webrm-bot-qr', '');
        qrZone.id = 'webrm-bot-qr';
        if (ch.id === 'feishu') {
          var feishuSt = botChannelStatus('feishu', info);
          qrZone.textContent = '';
          var fForm = el('div', '', '');
          fForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var fsH = (info && info.health && info.health.feishu) || null;
          if (fsH && fsH.state === 'down' && forceConfigChannel !== 'feishu') {
            var fsTitle = el('div', '', '⚠ 连接断开，请检查网络或凭证');
            fsTitle.style.cssText = 'font-size:13px;font-weight:600;color:#ef4444;margin-bottom:6px';
            fForm.appendChild(fsTitle);
            var fsReason = el('div', 'webrm-label2', fsH.error || '连续发送失败');
            fsReason.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all';
            fForm.appendChild(fsReason);
            var fsRe = el('button', 'webrm-btn', '重新连接');
            fsRe.type = 'button';
            fsRe.style.cssText = 'margin-top:8px;width:100%';
            fsRe.addEventListener('click', function () {
              var st7 = document.getElementById('webrm-bot-strow');
              if (st7) { st7.textContent = ''; st7.appendChild(el('span', '', '重连中…')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '', appSecret: '' }) }).then(function (r) { return r.json(); }).then(function () {
                fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
              }).catch(function () { if (st7) { st7.textContent = ''; st7.appendChild(el('span', '', '重连失败')); } });
            });
            fForm.appendChild(fsRe);
            var fsCfg = el('a', '', '→ 重新配置凭证');
            fsCfg.href = 'javascript:void 0';
            fsCfg.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px;text-decoration:underline';
            fsCfg.addEventListener('click', function (ev) {
              ev.preventDefault();
              forceConfigChannel = 'feishu';
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            });
            fForm.appendChild(fsCfg);
          } else if (fsH && fsH.state === 'degraded') {
            fForm.appendChild(el('div', 'webrm-label2', '连接不稳定（第 ' + (fsH.fails || 1) + ' 次失败）：' + (fsH.error || '')));
          } else if (feishuSt === '已连接') {
            fForm.appendChild(el('div', 'webrm-label2', '飞书机器人已连接，可在飞书中发消息控制 DSH'));
          } else if (feishuSt === '已配置') {
            var fReBtn = el('button', 'webrm-btn webrm-btn-primary', '重新连接');
            fReBtn.type = 'button';
            fReBtn.style.cssText = 'width:100%;margin-top:4px';
            fReBtn.addEventListener('click', function () {
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '连接中…')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '', appSecret: '' }) }).then(function (r) { return r.json(); }).then(function () {
                if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '已重连')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; }
              }).catch(function () { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '重连失败')); } });
            });
            fForm.appendChild(el('div', 'webrm-label2', '飞书已配置，等待连接'));
            fForm.appendChild(fReBtn);
          } else {
            fForm.appendChild(el('div', 'webrm-label2', '请填写飞书开放平台的 App ID 和 App Secret'));
            var fId = el('input', '', '');
            fId.placeholder = 'App ID (cli_xxx)';
            fId.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
            fForm.appendChild(fId);
            var fSec = el('input', '', '');
            fSec.type = 'password';
            fSec.placeholder = 'App Secret';
            fSec.style.cssText = fId.style.cssText;
            fForm.appendChild(fSec);
            var fBtn = el('button', 'webrm-btn webrm-btn-primary', '确认并验证');
            fBtn.type = 'button';
            fBtn.style.cssText = 'margin-top:8px;width:100%';
            fBtn.addEventListener('click', function () {
              var vId = fId.value.trim(), vSec = fSec.value.trim();
              if (!vId || !vSec) { var se = document.getElementById('webrm-bot-strow'); if (se) { se.appendChild(el('span', '', ' 请填写全部凭证')); se.querySelector('span:last-child').style.color = '#ef4444'; } return; }
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '验证中…')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: vId, appSecret: vSec }) }).then(function (r) { return r.json(); }).then(function (d) {
                if (d.ok && d.connected) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '已连接')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; } qrZone.textContent = ''; qrZone.appendChild(el('div', '', '飞书机器人已连接，可在飞书中发消息控制 DSH')); }
                else { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '验证失败: ' + (d.error || '未知错误'))); st2.querySelector('span').style.color = '#ef4444'; } }
              }).catch(function (e) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '请求失败: ' + e.message)); st2.querySelector('span').style.color = '#ef4444'; } });
            });
            var fLink = el('a', '', '→ 打开飞书开放平台');
            fLink.href = 'https://open.feishu.cn';
            fLink.target = '_blank';
            fLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px';
            fForm.appendChild(fBtn);
            fForm.appendChild(fLink);
          }
          qrZone.appendChild(fForm);
        } else if (ch.id === 'telegram') {
          var tgSt = botChannelStatus('telegram', info);
          qrZone.textContent = '';
          var tForm = el('div', '', '');
          tForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var tInputCss = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var tgH = (info && info.health && info.health.telegram) || null;
          var tgKindMsg = {
            'proxy-refused': '代理未运行，请启动 Clash（默认端口 7897）',
            'proxy-timeout': '代理连接超时，请检查代理地址是否正确',
            'network': '网络异常（连接被重置），请检查代理状态',
            'dns': '域名解析失败，请检查代理与网络',
            'token': 'Bot Token 无效，请重新配置',
            'conflict': '已有其它实例在轮询同一机器人',
          }[tgH && tgH.kind] || '';
          if (tgH && tgH.state === 'down' && forceConfigChannel !== 'telegram') {
            // ── 断开态：显示原因 + 重连按钮（不显示配置表单，避免误以为要重新填）
            var dTitle = el('div', '', '⚠ 连接断开，请检查网络代理');
            dTitle.style.cssText = 'font-size:13px;font-weight:600;color:#ef4444;margin-bottom:6px';
            tForm.appendChild(dTitle);
            var dReason = el('div', 'webrm-label2', tgKindMsg || (tgH.error ? ('原因：' + tgH.error) : '原因未知'));
            dReason.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all;margin-bottom:4px';
            tForm.appendChild(dReason);
            if (tgKindMsg && tgH.error) tForm.appendChild(el('div', 'webrm-label2', '底层错误：' + tgH.error));
            var tRe = el('button', 'webrm-btn webrm-btn-primary', '重连');
            tRe.type = 'button';
            tRe.style.cssText = 'margin-top:8px;width:100%';
            tRe.addEventListener('click', function () {
              var st5 = document.getElementById('webrm-bot-strow');
              tRe.disabled = true;
              if (st5) { st5.textContent = ''; st5.appendChild(el('span', '', '重连中…（正在重建代理隧道）')); }
              fetch('/remote/telegram/reconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
                tRe.disabled = false;
                if (d.connected) {
                  if (st5) { st5.textContent = ''; st5.appendChild(el('span', '', '已重连' + (d.me && d.me.username ? ' @' + d.me.username : ''))); var dt3 = st5.querySelector('.webrm-bot-dot'); if (dt3) dt3.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  if (st5) { st5.textContent = ''; st5.appendChild(el('span', '', '重连失败：' + (d.error || '未知'))); st5.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) { tRe.disabled = false; if (st5) { st5.textContent = ''; st5.appendChild(el('span', '', '请求失败：' + e.message)); } });
            });
            tForm.appendChild(tRe);
            // 逃生口：token 失效等无法靠重连解决的情况，允许回到配置表单
            var tCfg = el('a', '', '→ 重新配置 Token / 代理');
            tCfg.href = 'javascript:void 0';
            tCfg.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px;text-decoration:underline';
            tCfg.addEventListener('click', function (ev) {
              ev.preventDefault();
              forceConfigChannel = 'telegram';
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            });
            tForm.appendChild(tCfg);
          } else if (tgH && tgH.state === 'degraded') {
            tForm.appendChild(el('div', 'webrm-label2', '连接不稳定，重试中…（第 ' + (tgH.fails || 1) + ' 次失败）'));
            tForm.appendChild(el('div', 'webrm-label2', tgH.error || ''));
          } else if (tgSt === '已连接') {
            tForm.appendChild(el('div', 'webrm-label2', 'Telegram 机器人已连接，可在 Telegram 里发消息控制 DSH'));
            tForm.appendChild(el('div', 'webrm-label2', '监听：' + ((info && info.telegramMonitor) ? '开（会话思考完毕会推送）' : '关（发 /监听 开启）')));
            var tDisc = el('button', 'webrm-btn', '断开连接');
            tDisc.type = 'button';
            tDisc.style.cssText = 'margin-top:8px;width:100%';
            tDisc.addEventListener('click', function () {
              var st3 = document.getElementById('webrm-bot-strow');
              fetch('/remote/telegram/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
                if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已断开')); }
                if (info) info.telegram = null;
                if (typeof currentBotChannel !== 'undefined' && currentBotChannel === 'telegram') { try { renderBotPage(panel, info, hint); } catch (e) { /* ignore */ } }
              });
            });
            tForm.appendChild(tDisc);
          } else {
            tForm.appendChild(el('div', 'webrm-label2', '向 Telegram 的 @BotFather 申请 Bot Token，填入下方连接'));
            var tTok = el('input', '', '');
            tTok.placeholder = 'Bot Token（形如 123456789:AAE...）';
            tTok.style.cssText = tInputCss;
            tForm.appendChild(tTok);
            var tProxy = el('input', '', '');
            tProxy.placeholder = 'HTTP 代理（国内必填）';
            tProxy.value = 'http://127.0.0.1:7897';
            tProxy.style.cssText = tInputCss;
            tForm.appendChild(tProxy);
            var tBase = el('input', '', '');
            tBase.placeholder = 'API 地址（默认 https://api.telegram.org，留空即可）';
            tBase.style.cssText = tInputCss;
            tForm.appendChild(tBase);
            tForm.appendChild(el('div', 'webrm-label2', '说明：api.telegram.org 在国内无法直连，必须填代理（Clash 默认 7897 端口）'));
            var tBtn = el('button', 'webrm-btn webrm-btn-primary', '确认并连接');
            tBtn.type = 'button';
            tBtn.style.cssText = 'margin-top:8px;width:100%';
            tBtn.addEventListener('click', function () {
              var vTok = tTok.value.trim();
              if (!vTok) { var se2 = document.getElementById('webrm-bot-strow'); if (se2) { se2.textContent = ''; se2.appendChild(el('span', '', '请填写 Bot Token')); se2.querySelector('span').style.color = '#ef4444'; } return; }
              var st4 = document.getElementById('webrm-bot-strow');
              if (st4) { st4.textContent = ''; st4.appendChild(el('span', '', '连接中（首次要握手 Telegram，约 1-3 秒）…')); }
              tBtn.disabled = true;
              fetch('/remote/telegram/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botToken: vTok, proxyUrl: tProxy.value.trim(), apiBase: tBase.value.trim() }),
              }).then(function (r) { return r.json(); }).then(function (d) {
                tBtn.disabled = false;
                if (d.connected) {
                  forceConfigChannel = null;  // 连上了，恢复正常显示
                  if (st4) { st4.textContent = ''; st4.appendChild(el('span', '', '已连接' + (d.me && d.me.username ? ' @' + d.me.username : ''))); var dt2 = st4.querySelector('.webrm-bot-dot'); if (dt2) dt2.style.background = '#22c55e'; }
                  qrZone.textContent = '';
                  qrZone.appendChild(el('div', '', 'Telegram 机器人已连接，在 Telegram 里给机器人发 /帮助 开始使用'));
                } else {
                  if (st4) { st4.textContent = ''; st4.appendChild(el('span', '', '连接失败: ' + (d.error || '未知错误'))); st4.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) { tBtn.disabled = false; if (st4) { st4.textContent = ''; st4.appendChild(el('span', '', '请求失败: ' + e.message)); st4.querySelector('span').style.color = '#ef4444'; } });
            });
            tForm.appendChild(tBtn);
            var tLink = el('a', '', '→ 打开 @BotFather 申请 Token');
            tLink.href = 'https://t.me/BotFather';
            tLink.target = '_blank';
            tLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px';
            tForm.appendChild(tLink);
          }
          qrZone.appendChild(tForm);
        } else if (ch.id === 'qqbot') {
          var qbSt = botChannelStatus('qqbot', info);
          var qbH = (info && info.health && info.health.qqbot) || null;
          qrZone.textContent = '';
          var qForm = el('div', '', '');
          qForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var qCss = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var qKindMsg = {
            auth: 'AppID 或 AppSecret 不正确，请核对后重新配置',
            'sdk-missing': 'QQ 官方 SDK 未安装（需要 @tencent-connect/qqbot-nodejs）',
            network: '网络异常，请检查网络连接',
            'rate-limit': '调用过于频繁，请稍后重试',
            rejected: '用户/群主关闭了机器人的主动消息，无法主动推送（发消息给机器人可恢复会话）',
          }[qbH && qbH.kind] || '';

          if (qbH && qbH.state === 'down' && forceConfigChannel !== 'qqbot') {
            // ── 断开态：原因 + 重连 + 逃生口
            var qTitle = el('div', '', '⚠ 连接断开');
            qTitle.style.cssText = 'font-size:13px;font-weight:600;color:#ef4444;margin-bottom:6px';
            qForm.appendChild(qTitle);
            var qReason = el('div', 'webrm-label2', qKindMsg || (qbH.error ? ('原因：' + qbH.error) : '原因未知'));
            qReason.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all;margin-bottom:4px';
            qForm.appendChild(qReason);
            if (qKindMsg && qbH.error) qForm.appendChild(el('div', 'webrm-label2', '底层错误：' + qbH.error));
            var qRe = el('button', 'webrm-btn webrm-btn-primary', '重连');
            qRe.type = 'button';
            qRe.style.cssText = 'margin-top:8px;width:100%';
            qRe.addEventListener('click', function () {
              var stq = document.getElementById('webrm-bot-strow');
              qRe.disabled = true;
              if (stq) { stq.textContent = ''; stq.appendChild(el('span', '', '重连中…')); }
              fetch('/remote/qqbot/reconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
                qRe.disabled = false;
                if (d.connected) {
                  if (stq) { stq.textContent = ''; stq.appendChild(el('span', '', '已重连')); var dq = stq.querySelector('.webrm-bot-dot'); if (dq) dq.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  var m2 = ({ auth: 'AppID/AppSecret 不正确，请重新配置' })[d.kind] || (d.error || '未知');
                  if (stq) { stq.textContent = ''; stq.appendChild(el('span', '', '重连失败：' + m2)); stq.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) { qRe.disabled = false; if (stq) { stq.textContent = ''; stq.appendChild(el('span', '', '请求失败：' + e.message)); } });
            });
            qForm.appendChild(qRe);
            var qCfgLink = el('a', '', '→ 重新配置 AppID / AppSecret');
            qCfgLink.href = 'javascript:void 0';
            qCfgLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px;text-decoration:underline';
            qCfgLink.addEventListener('click', function (ev) {
              ev.preventDefault();
              forceConfigChannel = 'qqbot';
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            });
            qForm.appendChild(qCfgLink);
          } else if (qbSt === '已连接') {
            // ── 已连接
            qForm.appendChild(el('div', 'webrm-label2', 'QQ 官方机器人已连接，可在 QQ 里给机器人发消息控制 DSH'));
            qForm.appendChild(el('div', 'webrm-label2', 'AppID：' + ((info && info.qqbotAppId) || '(已隐藏)')));
            qForm.appendChild(el('div', 'webrm-label2', '监听：' + ((info && info.qqbotMonitor) ? '开（会话思考完毕会推送）' : '关（发 /监听 开启）')));
            qForm.appendChild(el('div', 'webrm-label2', '提示：群聊需群主把机器人拉进群；主动推送需要你曾给机器人发过消息'));
            var qDisc = el('button', 'webrm-btn', '断开连接');
            qDisc.type = 'button';
            qDisc.style.cssText = 'margin-top:8px;width:100%';
            qDisc.addEventListener('click', function () {
              var stq2 = document.getElementById('webrm-bot-strow');
              fetch('/remote/qqbot/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
                if (stq2) { stq2.textContent = ''; stq2.appendChild(el('span', '', '已断开')); }
                if (info) info.qqbot = null;
                fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
              });
            });
            qForm.appendChild(qDisc);
          } else {
            // ── 未配置：扫码绑定（推荐）+ 创建引导 + 手动填凭据
            qForm.appendChild(el('div', 'webrm-label2', 'QQ 官方机器人（QQ 开放平台 Agent 接入）'));
            qForm.appendChild(el('div', 'webrm-label2', '· 不需要额外 QQ 号，平台分配独立机器人身份'));
            qForm.appendChild(el('div', 'webrm-label2', '· WebSocket 长连接，不需要公网入口、不需要备案'));
            qForm.appendChild(el('div', 'webrm-label2', '· 个人主体可创建 5 个机器人，无需营业执照'));

            if (qqQrActive) {
              // ══ 扫码等待中 ══
              var qrBox = el('div', '', '');
              qrBox.style.cssText = 'text-align:center;padding:10px 0';
              var qrImg = el('img', '', '');
              qrImg.id = 'webrm-qq-qr-img';
              qrImg.alt = '扫码绑定 QQ 机器人';
              qrImg.style.cssText = 'width:180px;height:180px;border-radius:10px;background:rgba(120,120,128,.08);display:block;margin:0 auto';
              qrBox.appendChild(qrImg);
              var qrTip = el('div', '', '正在获取二维码…');
              qrTip.id = 'webrm-qq-qr-tip';
              qrTip.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-top:10px;line-height:1.6';
              qrBox.appendChild(qrTip);
              qForm.appendChild(qrBox);
              var qCancelBtn = el('button', 'webrm-btn', '取消扫码');
              qCancelBtn.type = 'button';
              qCancelBtn.style.cssText = 'margin-top:6px;width:100%';
              qCancelBtn.addEventListener('click', function () {
                qqStopQrPoll();
                qqQrActive = false;
                qqQrShownUrl = '';
                fetch('/remote/qqbot/qr/cancel', { method: 'POST' }).catch(function () { /* 忽略：本地状态已重置 */ });
                fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
              });
              qForm.appendChild(qCancelBtn);

              // 轮询扫码结果（每 2 秒）
              qqStopQrPoll();
              var qqQrTick = function () {
                fetch('/remote/qqbot/qr/status?_=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
                  var img = document.getElementById('webrm-qq-qr-img');
                  var tip = document.getElementById('webrm-qq-qr-tip');
                  if (d.qrUrl && d.qrUrl !== qqQrShownUrl && img) {
                    qqQrShownUrl = d.qrUrl;
                    img.onerror = function () {
                      // 第一个二维码服务挂了就换备用源
                      if (img.src.indexOf(QR_SOURCES[0]) === 0) img.src = QR_SOURCES[1] + encodeURIComponent(d.qrUrl);
                    };
                    img.src = QR_SOURCES[0] + encodeURIComponent(d.qrUrl);
                  }
                  if (tip) {
                    if (d.state === 'expired') {
                      tip.textContent = '二维码已过期，正在自动刷新…';
                    } else if (d.state === 'waiting') {
                      tip.textContent = '手机 QQ 扫码 → 选择你要绑定的机器人 → 确认授权'
                        + (d.elapsedSec ? '（已等待 ' + d.elapsedSec + ' 秒）' : '');
                    }
                  }
                  if (d.state === 'success' && d.connected) {
                    qqStopQrPoll();
                    qqQrActive = false;
                    qqQrShownUrl = '';
                    fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                  } else if (d.state === 'failed') {
                    qqStopQrPoll();
                    qqQrActive = false;
                    qqQrShownUrl = '';
                    var stq4 = document.getElementById('webrm-bot-strow');
                    if (stq4) { stq4.textContent = ''; var sp = el('span', '', '扫码失败：' + (d.error || '未知')); sp.style.color = '#ef4444'; stq4.appendChild(sp); }
                    fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                  }
                }).catch(function () { /* 网络抖动：下个周期再试 */ });
              };
              qqQrTick();
              qqQrPoll = setInterval(qqQrTick, 2000);
            } else {
              // ══ 扫码按钮（推荐入口）══
              var qQrBtn = el('button', 'webrm-btn webrm-btn-primary', '📱 扫码绑定（推荐）');
              qQrBtn.type = 'button';
              qQrBtn.style.cssText = 'margin-top:8px;width:100%';
              qQrBtn.addEventListener('click', function () {
                var stq5 = document.getElementById('webrm-bot-strow');
                qQrBtn.disabled = true;
                if (stq5) { stq5.textContent = ''; stq5.appendChild(el('span', '', '正在获取二维码…')); }
                fetch('/remote/qqbot/qr/start', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
                  qQrBtn.disabled = false;
                  if (d.ok) {
                    qqQrActive = true;
                    qqQrShownUrl = '';
                    if (stq5) { stq5.textContent = ''; stq5.appendChild(el('span', '', '等待扫码…')); }
                    fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                  } else {
                    if (stq5) { stq5.textContent = ''; var sp2 = el('span', '', '无法启动扫码：' + (d.error || '未知')); sp2.style.color = '#ef4444'; stq5.appendChild(sp2); }
                  }
                }).catch(function (e) {
                  qQrBtn.disabled = false;
                  if (stq5) { stq5.textContent = ''; stq5.appendChild(el('span', '', '请求失败：' + e.message)); }
                });
              });
              qForm.appendChild(qQrBtn);
              var qQrNote = el('div', 'webrm-label2', '扫码只能绑定「已有」的机器人，不会新建。若还没有机器人，请先点下面的创建页面。');
              qQrNote.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-top:6px;line-height:1.6';
              qForm.appendChild(qQrNote);

              // ══ 手动填写（备用）══
              var qDivider = el('div', 'webrm-label2', '———— 或手动填写 ————');
              qDivider.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin:12px 0 4px;text-align:center';
              qForm.appendChild(qDivider);
              var qCreate = el('button', 'webrm-btn', '① 打开创建页面（拿 AppID / AppSecret）');
              qCreate.type = 'button';
              qCreate.style.cssText = 'margin-top:4px;width:100%';
              qCreate.addEventListener('click', function () {
                window.open('https://q.qq.com/qqbot/openclaw/login.html', '_blank');
              });
              qForm.appendChild(qCreate);
              var qStep = el('div', 'webrm-label2', '② 创建后，在开放平台「开发设置」里复制 AppID 与 AppSecret 填入下方');
              qStep.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);margin-top:6px';
              qForm.appendChild(qStep);
              var qId = el('input', '', '');
              qId.placeholder = 'AppID（形如 102xxxxxx）';
              qId.style.cssText = qCss;
              qForm.appendChild(qId);
              var qSec = el('input', '', '');
            qSec.type = 'password';
            qSec.placeholder = 'AppSecret';
            qSec.style.cssText = qCss;
            qForm.appendChild(qSec);
            var qBtn = el('button', 'webrm-btn webrm-btn-primary', '确认并连接');
            qBtn.type = 'button';
            qBtn.style.cssText = 'margin-top:8px;width:100%';
            qBtn.addEventListener('click', function () {
              var vId = qId.value.trim(), vSec = qSec.value.trim();
              if (!vId || !vSec) {
                var se3 = document.getElementById('webrm-bot-strow');
                if (se3) { se3.textContent = ''; se3.appendChild(el('span', '', '请填写 AppID 和 AppSecret')); se3.querySelector('span').style.color = '#ef4444'; }
                return;
              }
              var stq3 = document.getElementById('webrm-bot-strow');
              if (stq3) { stq3.textContent = ''; stq3.appendChild(el('span', '', '连接中（首次要换取 access_token 并建 WebSocket）…')); }
              qBtn.disabled = true;
              fetch('/remote/qqbot/config', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ appId: vId, appSecret: vSec }),
              }).then(function (r) { return r.json(); }).then(function (d) {
                qBtn.disabled = false;
                if (d.connected) {
                  forceConfigChannel = null;
                  if (stq3) { stq3.textContent = ''; stq3.appendChild(el('span', '', '已连接')); var dq2 = stq3.querySelector('.webrm-bot-dot'); if (dq2) dq2.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  var m3 = ({ auth: 'AppID 或 AppSecret 不正确' })[d.kind] || '';
                  if (stq3) { stq3.textContent = ''; stq3.appendChild(el('span', '', '连接失败：' + m3 + (m3 ? ' — ' : '') + (d.error || '未知'))); stq3.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) { qBtn.disabled = false; if (stq3) { stq3.textContent = ''; stq3.appendChild(el('span', '', '请求失败：' + e.message)); } });
            });
            qForm.appendChild(qBtn);
            }
          }
          qrZone.appendChild(qForm);
        } else if (ch.id === 'weixin') {
          var wxH = (info && info.health && info.health.weixin) || null;
          qrZone.textContent = '';
          if (wxH && wxH.state === 'down' && forceConfigChannel !== 'weixin') {
            // ── 微信断开态：轮询已停止，给一键重连
            var wTitle = el('div', '', '⚠ 连接断开，请检查网络');
            wTitle.style.cssText = 'font-size:13px;font-weight:600;color:#ef4444;margin-bottom:6px';
            qrZone.appendChild(wTitle);
            var wReason = el('div', 'webrm-label2', wxH.error || '连续失败已停止轮询');
            wReason.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all';
            qrZone.appendChild(wReason);
            var wRe = el('button', 'webrm-btn webrm-btn-primary', '重连');
            wRe.type = 'button';
            wRe.style.cssText = 'margin-top:8px;width:100%';
            wRe.addEventListener('click', function () {
              var st6 = document.getElementById('webrm-bot-strow');
              wRe.disabled = true;
              if (st6) { st6.textContent = ''; st6.appendChild(el('span', '', '重连中…')); }
              fetch('/remote/weixin/reconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
                wRe.disabled = false;
                if (d.ok && d.connected) {
                  if (st6) { st6.textContent = ''; st6.appendChild(el('span', '', '已重连')); var dt4 = st6.querySelector('.webrm-bot-dot'); if (dt4) dt4.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  if (st6) { st6.textContent = ''; st6.appendChild(el('span', '', '重连失败：' + (d.error || '未知'))); st6.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) { wRe.disabled = false; if (st6) { st6.textContent = ''; st6.appendChild(el('span', '', '请求失败：' + e.message)); } });
            });
            qrZone.appendChild(wRe);
            var wCfg = el('a', '', '→ 重新绑定');
            wCfg.href = 'javascript:void 0';
            wCfg.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px;text-decoration:underline';
            wCfg.addEventListener('click', function (ev) {
              ev.preventDefault();
              forceConfigChannel = 'weixin';
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            });
            qrZone.appendChild(wCfg);
          } else if (wxH && wxH.state === 'degraded') {
            qrZone.appendChild(el('div', 'webrm-label2', '连接不稳定，重试中…（第 ' + (wxH.fails || 1) + ' 次失败）'));
            qrZone.appendChild(el('div', 'webrm-label2', wxH.error || ''));
          } else {
            qrZone.appendChild(el('div', '', '点击「绑定」开始扫码'));
          }
        } else {
          qrZone.appendChild(el('div', '', '点击「绑定」开始扫码'));
        }
        detail.appendChild(qrZone);
      }
    } else {
      detail.appendChild(el('div', 'webrm-bot-empty', '选择一个通道查看详情'));
    }
    box.appendChild(detail);
  }
  function renderStatus(panel, info, hint) {
    syncActionButtons(info);
    var st = document.getElementById('webrm-status');
    if (st) {
      st.textContent = '';
      var dot = el('span', '', '');
      dot.id = 'webrm-dot';
      dot.style.background = info && info.running ? '#22c55e' : '#ef4444';
      st.appendChild(dot);
      st.appendChild(el('span', '', info && info.running ? '运行中' : '已停止'));
    }
        // 机器人标签：渲染四通道页面，隐藏远程控制行与二维码
    var rowEl = document.getElementById('webrm-row');
    var qrEl = document.getElementById('webrm-qr');
    if (currentTab === 'bot') {
      if (rowEl) rowEl.style.display = 'none';
      if (qrEl && qrEl.parentNode) qrEl.parentNode.removeChild(qrEl);
      renderBotPage(panel, info, hint);
      var hb = document.getElementById('webrm-hint');
      if (hb) {
        hb.textContent = '通过聊天机器人遥控 DSH：QQ（NapCat）/ 微信（ClawBot）/ 钉钉 / 飞书。' + NL + '支持指令：状态 / 获取链接 / 启动 / 停止 / 换新链接 / 帮助';
      }
      var eb = document.getElementById('webrm-error');
      if (eb) eb.textContent = '';
      return;
    }
    if (rowEl) rowEl.style.display = '';
    var box = document.getElementById('webrm-urlbox');
    if (!box) return;
    box.textContent = '';
    var urls = [];
    if (currentTab === 'lan' && info && info.ips && info.ips.length) {
      urls = info.ips.map(function (ip) { return { label: '局域网直连 ' + ip + '（点击复制）', url: (info.httpsPort ? 'https://' : 'http://') + ip + ':' + (info.httpsPort || info.port) + (info.lanOpen ? '' : '/?token=' + info.token) }; });
    } else if (info && info.url && info.token) {
      urls = [{ label: '公网访问链接（点击复制）', url: info.url + '/?token=' + info.token }];
    }
    if (urls.length === 0) {
      if (info && info.running && currentTab === 'public') {
        box.appendChild(el('div', '', '隧道已断开：请点「停止」后重新「启动」'));
      } else {
        box.appendChild(el('div', '', '尚未启动'));
      }
    }
    urls.forEach(function (item) {
      var labelEl = el('div', '', item.label);
      labelEl.className = 'webrm-label';
      var linkEl = el('div', '', item.url);
      linkEl.className = 'webrm-url';
      linkEl.style.marginBottom = '6px';
      box.appendChild(labelEl);
      box.appendChild(linkEl);
      box.addEventListener('click', function () { copyText(item.url, labelEl, '已复制 ✓'); });
    });
    (function () {
      var oldu = document.getElementById('webrm-custom-url');
      if (oldu && oldu.parentNode) oldu.parentNode.removeChild(oldu);
      var oldp = document.getElementById('webrm-port-box');
      if (oldp && oldp.parentNode) oldp.parentNode.removeChild(oldp);
      if (currentTab === 'public') {
        var con = el('div', '', '');
        con.id = 'webrm-custom-url';
        con.appendChild(el('div', 'webrm-label2', '自定义公网链接'));
        var wrap = el('div', '', '');
        var renderView = function () {
          wrap.textContent = '';
          if (info && info.customPublicUrl) {
            var uLink = el('div', 'webrm-url', info.customPublicUrl);
            uLink.style.marginBottom = '4px';
            uLink.addEventListener('click', function (e) { e.stopPropagation(); copyText(info.customPublicUrl, uLink, '已复制 ✓'); });
            wrap.appendChild(uLink);
            var eBtn = el('button', 'webrm-btn-sm', '编辑');
            eBtn.addEventListener('click', renderEdit);
            wrap.appendChild(eBtn);
            var dBtn = el('button', 'webrm-btn-sm', '清除');
            dBtn.addEventListener('click', function () {
              fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":""}' });
              if (info) info.customPublicUrl = null;
              renderView();
            });
            wrap.appendChild(dBtn);
          } else {
            var ph = el('div', 'webrm-placeholder', '点击填写自定义公网链接');
            ph.addEventListener('click', renderEdit);
            wrap.appendChild(ph);
          }
        };
        var renderEdit = function () {
          wrap.textContent = '';
          var row = el('div', 'webrm-edit-row', '');
          var inp = el('input', '', '');
          inp.type = 'text';
          inp.placeholder = 'https://xxx.ngrok.io';
          if (info && info.customPublicUrl) inp.value = info.customPublicUrl;
          var sBtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '保存');
          sBtn.addEventListener('click', function () {
            var v = inp.value.trim();
            fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"' + v.replace(/"/g, '') + '"}' });
            if (info) info.customPublicUrl = v || null;
            renderView();
          });
          var cBtn = el('button', 'webrm-btn-sm', '取消');
          cBtn.addEventListener('click', renderView);
          row.appendChild(inp); row.appendChild(sBtn); row.appendChild(cBtn);
          wrap.appendChild(row);
          inp.focus();
        };
        con.appendChild(wrap);
        box.appendChild(con);
        renderView();
      } else if (currentTab === 'lan' && info && info.ips && info.ips.length) {
        var lip = info.ips[0];
        var pbox = el('div', '', '');
        pbox.id = 'webrm-port-box';
        pbox.appendChild(el('div', 'webrm-label2', '自定义端口'));
        var prow = el('div', 'webrm-port-row', '');
        var renderPortEdit = function () {
          prow.textContent = '';
          var fixed2 = el('span', 'webrm-port-fixed', (info.httpsPort ? 'https://' : 'http://') + lip + ':');
          var pin = el('input', '', '');
          pin.type = 'number'; pin.value = String(info.httpsPort || info.port);
          pin.min = '1024'; pin.max = '65535';
          var abtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '应用');
          abtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var np = parseInt(pin.value, 10);
            if (isNaN(np) || np < 1024 || np > 65535) { pin.style.borderColor = '#ff3b30'; return; }
            fetch('/remote/set-port', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"port":' + np + '}' })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { if (info) info.httpsPort = np; renderStatus(panel, info, hint); } else { alert(d.error || '端口设置失败'); } })
              .catch(function () { alert('请求失败'); });
          });
          var cbtn = el('button', 'webrm-btn-sm', '取消');
          cbtn.addEventListener('click', renderPortView);
          prow.appendChild(fixed2); prow.appendChild(pin); prow.appendChild(abtn); prow.appendChild(cbtn);
          pin.focus(); pin.select();
        };
        var renderPortView = function () {
          prow.textContent = '';
          var fixed2 = el('span', 'webrm-port-fixed', (info.httpsPort ? 'https://' : 'http://') + lip + ':');
          var ed2 = el('span', 'webrm-port-editable', String(info.httpsPort || info.port));
          ed2.addEventListener('click', renderPortEdit);
          prow.appendChild(fixed2); prow.appendChild(ed2);
        };
        renderPortView();
        pbox.appendChild(prow);
        box.appendChild(pbox);
      }
    })();
    var qr = document.getElementById('webrm-qr');
    if (qr && qr.parentNode) qr.parentNode.removeChild(qr);
    var qrTarget = currentTab === 'lan' && info && info.ips && info.ips.length ? (info.httpsPort ? 'https://' : 'http://') + info.ips[0] + ':' + (info.httpsPort || info.port) + (info.lanOpen ? '' : '/?token=' + info.token) : (info && info.url && info.token ? info.url + '/?token=' + info.token : null);
    if (qrTarget) {
      var qi = 0;
      var q = el('img', '', '');
      q.id = 'webrm-qr';
      q.alt = '扫码访问';
      var loadQr = function () {
        if (qi >= QR_SOURCES.length) {
          if (q.parentNode) q.parentNode.removeChild(q);
          return;
        }
        // 附加时间戳，强制浏览器重新加载二维码（避免缓存显示旧图）
        q.src = QR_SOURCES[qi] + encodeURIComponent(qrTarget) + '&_=' + Date.now();
        qi += 1;
      };
      q.addEventListener('error', loadQr);
      panel.insertBefore(q, hint);
      loadQr();
    } else if (info && info.running && currentTab === 'public') {
      var waitEl = el('div', '', '正在获取公网链接，请稍候…');
      waitEl.id = 'webrm-qr';
      waitEl.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);text-align:center;margin:10px 0';
      panel.insertBefore(waitEl, hint);
    }
    var h2 = document.getElementById('webrm-hint');
    if (h2) {
      var parts = [];
      parts.push('注意：公网链接含访问令牌，请勿泄露。');
      parts.push('提示：换新链接后首次打开较慢（约 10~30 秒），之后秒开；同 Wi-Fi 建议用「局域网」链接，速度更快。');
      h2.textContent = parts.join(NL + NL);
    }
    var err = document.getElementById('webrm-error');
    if (err) {
      if (info && info.error) err.textContent = String(info.error);
      else err.textContent = '';
    }
  }
  function setTab(tab, publicBtn, lanBtn, botBtn, panel, hint) {
    currentTab = tab;
    saveTab();
    publicBtn.className = tab === 'public' ? 'webrm-tab-active' : '';
    lanBtn.className = tab === 'lan' ? 'webrm-tab-active' : '';
    if (botBtn) botBtn.className = tab === 'bot' ? 'webrm-tab-active' : '';
    if (lastInfo) renderStatus(panel, lastInfo, hint);
  }
  function openPanel() {
    if (document.getElementById('webrm-mask')) return;
    currentTab = loadTab();
    var mask = el('div', '', '');
    mask.id = 'webrm-mask';
    var panel = el('div', '', '');
    panel.id = 'webrm-panel';
    var head = el('h2', '', '远程访问');
    var x = el('button', '', '×');
    x.id = 'webrm-close';
    x.setAttribute('aria-label', '关闭');
    head.appendChild(x);
    panel.appendChild(head);
    var tabs = el('div', '', '');
    tabs.id = 'webrm-tabs';
    var publicBtn = el('button', currentTab === 'public' ? 'webrm-tab-active' : '', '公网');
    publicBtn.type = 'button';
    var lanBtn = el('button', currentTab === 'lan' ? 'webrm-tab-active' : '', '局域网');
    var botBtn = el('button', currentTab === 'bot' ? 'webrm-tab-active' : '', '机器人');
    botBtn.type = 'button';
    lanBtn.type = 'button';
    tabs.appendChild(publicBtn);
    tabs.appendChild(lanBtn);
    tabs.appendChild(botBtn);
    panel.appendChild(tabs);
    var statusRow = el('div', '', '加载中…');
    statusRow.id = 'webrm-status';
    panel.appendChild(statusRow);
    var urlBox = el('div', '', '');
    urlBox.id = 'webrm-urlbox';
    panel.appendChild(urlBox);
    var row = el('div', '', '');
    row.id = 'webrm-row';
    row.className = 'webrm-row';
    var startBtn = el('button', 'webrm-btn webrm-btn-primary', '启动');
    startBtn.type = 'button';
    startBtn.id = 'webrm-start';
    var stopBtn = el('button', 'webrm-btn', '停止');
    stopBtn.type = 'button';
    stopBtn.id = 'webrm-stop';
    var refreshBtn = el('button', 'webrm-btn', '换新链接');
    refreshBtn.type = 'button';
    refreshBtn.id = 'webrm-refresh';
    row.appendChild(startBtn);
    row.appendChild(stopBtn);
    row.appendChild(refreshBtn);
    panel.appendChild(row);
    var err = el('div', '', '');
    err.id = 'webrm-error';
    err.className = 'webrm-error';
    panel.appendChild(err);
    var hint = el('div', '', '');
    hint.id = 'webrm-hint';
    hint.className = 'webrm-hint';
    panel.appendChild(hint);
    var retryCount = 0;
    function close() {
      if (mask.parentNode) mask.parentNode.removeChild(mask);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      lastInfo = null;
    }
    function refresh() {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      refreshBtn.disabled = true;
      fetchInfo().then(function (info) {
        lastInfo = info;
        renderStatus(panel, info, hint);
        if (info && info.running && currentTab === 'public' && !info.url && retryCount < 3) {
          retryCount += 1;
          setTimeout(function () { refresh(); }, 5000);
        }
      }).catch(function () {
        var st2 = document.getElementById('webrm-status');
        if (st2) st2.textContent = '获取状态失败';
      }).finally(function () {
        startBtn.disabled = false;
        stopBtn.disabled = false;
        refreshBtn.disabled = false;
      });
    }
    function control(action) {
      startBtn.disabled = true;
      stopBtn.disabled = true;
      refreshBtn.disabled = true;
      act(action).then(function (info) {
        lastInfo = info;
        renderStatus(panel, info, hint);
      }).catch(function () {
        var st3 = document.getElementById('webrm-status');
        if (st3) st3.textContent = '操作失败';
      }).finally(function () {
        startBtn.disabled = false;
        stopBtn.disabled = false;
        refreshBtn.disabled = false;
      });
    }
    mask.addEventListener('click', close);
    x.addEventListener('click', close);
    publicBtn.addEventListener('click', function () { setTab('public', publicBtn, lanBtn, botBtn, panel, hint); });
    lanBtn.addEventListener('click', function () { setTab('lan', publicBtn, lanBtn, botBtn, panel, hint); });
    botBtn.addEventListener('click', function () { setTab('bot', publicBtn, lanBtn, botBtn, panel, hint); });
    startBtn.addEventListener('click', function () { control('start'); });
    stopBtn.addEventListener('click', function () { control('stop'); });
    refreshBtn.addEventListener('click', function () {
      var st4 = document.getElementById('webrm-status');
      if (st4) st4.textContent = '正在换新链接…';
      control('renew');
    });
    document.body.appendChild(mask);
    document.body.appendChild(panel);
    refresh();
  }
  function tryCreate() {
    if (document.querySelector('.webrm-fab')) return;
    if (document.body) {
      create();
    } else if (CHECK < 40) {
      CHECK += 1;
      setTimeout(tryCreate, 250);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryCreate);
  } else {
    tryCreate();
  }
  // 后台健康轮询：面板关着也能让「远程」按钮的红点亮起来（10 秒一次本地请求，开销可忽略）
  setInterval(function () { fetchInfo().catch(function () { /* 忽略：服务器未就绪时静默 */ }); }, 10000);
})();`;
