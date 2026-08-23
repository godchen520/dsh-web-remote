// dsh-web-remote — 远程访问面板注入脚本（浏览器端 UI）
export const INJECT_SCRIPT = `(function () {
  var NL = String.fromCharCode(10);
  var CHECK = 0;
  var currentTab = 'public';
  var lastInfo = null;
  var QR_SOURCES = ['https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=', 'https://api.pwmqr.com/qrcode/create/?url='];
  var currentBotChannel = null;
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
  function findSidebarRoot() {
    // 精确找侧边栏根：计算样式含 --dsh-sidebar-inline-padding 的元素
    var all = document.querySelectorAll('div');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      try {
        var v = window.getComputedStyle(el).getPropertyValue('--dsh-sidebar-inline-padding');
        if (v && v.trim() !== '') return el;
      } catch (e) { /* ignore */ }
    }
    return null;
  }
  function findSettingsArea() {
    // 优先：设置按钮（aria-label/title 含设置相关词）的父容器
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
      if (/setting|设置|preference|偏好/i.test(label)) {
        var parent = b.parentNode;
        if (parent) return parent;
      }
    }
    // 兜底：侧边栏根元素的最后一个直接子容器（footArea）
    var root = findSidebarRoot();
    if (root && root.children.length) {
      var foot = root.children[root.children.length - 1];
      if (foot && foot.children.length) return foot;
      return foot;
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
      // 容器改为横向 flex，靠左对齐：设置按钮贴左边框，手机按钮在它右侧
      try {
        area.style.display = 'flex';
        area.style.flexDirection = 'row';
        area.style.alignItems = 'center';
        area.style.justifyContent = 'flex-start';
        area.style.gap = '2px';
        // 设置按钮紧凑化：保留文字但缩短按钮体（内容宽、缩小内边距）
        var siblings = area.querySelectorAll('button');
        for (var si = 0; si < siblings.length; si++) {
          if (siblings[si] !== btn) {
            siblings[si].style.flex = '0 0 auto';
            siblings[si].style.width = 'auto';
            siblings[si].style.height = '34px';
            siblings[si].style.padding = '0 8px';
            siblings[si].style.fontSize = '13px';
            siblings[si].style.justifyContent = 'center';
            siblings[si].style.display = 'flex';
            siblings[si].style.alignItems = 'center';
            siblings[si].style.gap = '4px';
          }
        }
        syncGearColor();
      } catch (e) { /* ignore */ }
      // 手机按钮放设置按钮右侧（紧随其后）
      area.appendChild(btn);
      try { console.log('[webrm] inserted into:', area.tagName, area.className.slice(0, 80)); } catch (e) {}
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
      // 兜底：每 2 秒同步一次颜色（覆盖纯 CSS 变量变化，开销极小）
      var colorTimer = setInterval(syncGearColor, 2000);
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
        document.body.appendChild(btn); // 兜底：保留可用性
      }
    }, 250);
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function fetchInfo() {
    // 时间戳参数强制绕过所有缓存（浏览器 + 代理层）
    return fetch('/remote/info?_=' + Date.now(), { cache: 'no-store' }).then(function (res) { return res.json(); });
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
    if (id === 'telegram') return (info && info.telegram === 'connected') ? '\u5df2\u8fde\u63a5' : '\u672a\u8fde\u63a5';
    if (id === 'feishu') {
      if (info && info.feishu === 'connected') return '\u5df2\u8fde\u63a5';
      if (info && info.feishu === 'configured') return '\u5df2\u914d\u7f6e';
      return '\u672a\u914d\u7f6e';
    }
    return '\u672a\u63a5\u5165';
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
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8bf7\u5728\u4e0b\u65b9\u586b\u5199\u51ed\u8bc1')); }
            renderBotPage(panel, info, hint);
          } else {
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u7ed1\u5b9a\u4e2d\u2026\uff08\u529f\u80fd\u5f00\u53d1\u4e2d\uff09')); }
          }
        });
        var discBtn = el('button', 'webrm-btn', '\u89e3\u7ed1');
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
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '\u5df2\u89e3\u7ed1')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              info.feishu = null;
              renderBotPage(panel, info, hint);
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '\u89e3\u7ed1\u5931\u8d25')); }
            });
          } else {
            if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); }
          }
        });
        btns.appendChild(connectBtn);
        btns.appendChild(discBtn);
        detail.appendChild(btns);
        var qrZone = el('div', 'webrm-bot-qr', '');
        qrZone.id = 'webrm-bot-qr';
        if (ch.id === 'feishu') {
          var feishuSt = botChannelStatus('feishu', info);
          qrZone.textContent = '';
          var fForm = el('div', '', '');
          fForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          if (feishuSt === '\u5df2\u8fde\u63a5') {
            fForm.appendChild(el('div', 'webrm-label2', '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u8fde\u63a5\uff0c\u53ef\u5728\u98de\u4e66\u4e2d\u53d1\u6d88\u606f\u63a7\u5236 DSH'));
          } else if (feishuSt === '\u5df2\u914d\u7f6e') {
            var fReBtn = el('button', 'webrm-btn webrm-btn-primary', '\u91cd\u65b0\u8fde\u63a5');
            fReBtn.type = 'button';
            fReBtn.style.cssText = 'width:100%;margin-top:4px';
            fReBtn.addEventListener('click', function () {
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8fde\u63a5\u4e2d\u2026')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: '', appSecret: '' }) }).then(function (r) { return r.json(); }).then(function () {
                if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u5df2\u91cd\u8fde')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; }
              }).catch(function () { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u91cd\u8fde\u5931\u8d25')); } });
            });
            fForm.appendChild(el('div', 'webrm-label2', '\u98de\u4e66\u5df2\u914d\u7f6e\uff0c\u7b49\u5f85\u8fde\u63a5'));
            fForm.appendChild(fReBtn);
          } else {
            fForm.appendChild(el('div', 'webrm-label2', '\u8bf7\u586b\u5199\u98de\u4e66\u5f00\u653e\u5e73\u53f0\u7684 App ID \u548c App Secret'));
            var fId = el('input', '', '');
            fId.placeholder = 'App ID (cli_xxx)';
            fId.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
            fForm.appendChild(fId);
            var fSec = el('input', '', '');
            fSec.type = 'password';
            fSec.placeholder = 'App Secret';
            fSec.style.cssText = fId.style.cssText;
            fForm.appendChild(fSec);
            var fBtn = el('button', 'webrm-btn webrm-btn-primary', '\u786e\u8ba4\u5e76\u9a8c\u8bc1');
            fBtn.type = 'button';
            fBtn.style.cssText = 'margin-top:8px;width:100%';
            fBtn.addEventListener('click', function () {
              var vId = fId.value.trim(), vSec = fSec.value.trim();
              if (!vId || !vSec) { var se = document.getElementById('webrm-bot-strow'); if (se) { se.appendChild(el('span', '', ' \u8bf7\u586b\u5199\u5168\u90e8\u51ed\u8bc1')); se.querySelector('span:last-child').style.color = '#ef4444'; } return; }
              var st2 = document.getElementById('webrm-bot-strow');
              if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u9a8c\u8bc1\u4e2d\u2026')); }
              fetch('/remote/feishu/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId: vId, appSecret: vSec }) }).then(function (r) { return r.json(); }).then(function (d) {
                if (d.ok && d.connected) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u5df2\u8fde\u63a5')); var dt = st2.querySelector('.webrm-bot-dot'); if (dt) dt.style.background = '#22c55e'; } qrZone.textContent = ''; qrZone.appendChild(el('div', '', '\u98de\u4e66\u673a\u5668\u4eba\u5df2\u8fde\u63a5\uff0c\u53ef\u5728\u98de\u4e66\u4e2d\u53d1\u6d88\u606f\u63a7\u5236 DSH')); }
                else { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u9a8c\u8bc1\u5931\u8d25: ' + (d.error || '\u672a\u77e5\u9519\u8bef'))); st2.querySelector('span').style.color = '#ef4444'; } }
              }).catch(function (e) { if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '\u8bf7\u6c42\u5931\u8d25: ' + e.message)); st2.querySelector('span').style.color = '#ef4444'; } });
            });
            var fLink = el('a', '', '\u2192 \u6253\u5f00\u98de\u4e66\u5f00\u653e\u5e73\u53f0');
            fLink.href = 'https://open.feishu.cn';
            fLink.target = '_blank';
            fLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px';
            fForm.appendChild(fBtn);
            fForm.appendChild(fLink);
          }
          qrZone.appendChild(fForm);
        } else {
          qrZone.appendChild(el('div', '', '\u70b9\u51fb\u300c\u7ed1\u5b9a\u300d\u5f00\u59cb\u626b\u7801'));
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
      box.addEventListener('click', function () { copyText(item.url, labelEl, '\u5df2\u590d\u5236 \u2713'); });
    });
    (function () {
      var oldu = document.getElementById('webrm-custom-url');
      if (oldu && oldu.parentNode) oldu.parentNode.removeChild(oldu);
      var oldp = document.getElementById('webrm-port-box');
      if (oldp && oldp.parentNode) oldp.parentNode.removeChild(oldp);
      if (currentTab === 'public') {
        var con = el('div', '', '');
        con.id = 'webrm-custom-url';
        con.appendChild(el('div', 'webrm-label2', '\u81ea\u5b9a\u4e49\u516c\u7f51\u94fe\u63a5'));
        var wrap = el('div', '', '');
        var renderView = function () {
          wrap.textContent = '';
          if (info && info.customPublicUrl) {
            var uLink = el('div', 'webrm-url', info.customPublicUrl);
            uLink.style.marginBottom = '4px';
            uLink.addEventListener('click', function (e) { e.stopPropagation(); copyText(info.customPublicUrl, uLink, '\u5df2\u590d\u5236 \u2713'); });
            wrap.appendChild(uLink);
            var eBtn = el('button', 'webrm-btn-sm', '\u7f16\u8f91');
            eBtn.addEventListener('click', renderEdit);
            wrap.appendChild(eBtn);
            var dBtn = el('button', 'webrm-btn-sm', '\u6e05\u9664');
            dBtn.addEventListener('click', function () {
              fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":""}' });
              if (info) info.customPublicUrl = null;
              renderView();
            });
            wrap.appendChild(dBtn);
          } else {
            var ph = el('div', 'webrm-placeholder', '\u70b9\u51fb\u586b\u5199\u81ea\u5b9a\u4e49\u516c\u7f51\u94fe\u63a5');
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
          var sBtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '\u4fdd\u5b58');
          sBtn.addEventListener('click', function () {
            var v = inp.value.trim();
            fetch('/remote/custom-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"url":"' + v.replace(/"/g, '') + '"}' });
            if (info) info.customPublicUrl = v || null;
            renderView();
          });
          var cBtn = el('button', 'webrm-btn-sm', '\u53d6\u6d88');
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
        pbox.appendChild(el('div', 'webrm-label2', '\u81ea\u5b9a\u4e49\u7aef\u53e3'));
        var prow = el('div', 'webrm-port-row', '');
        var renderPortEdit = function () {
          prow.textContent = '';
          var fixed2 = el('span', 'webrm-port-fixed', (info.httpsPort ? 'https://' : 'http://') + lip + ':');
          var pin = el('input', '', '');
          pin.type = 'number'; pin.value = String(info.httpsPort || info.port);
          pin.min = '1024'; pin.max = '65535';
          var abtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '\u5e94\u7528');
          abtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var np = parseInt(pin.value, 10);
            if (isNaN(np) || np < 1024 || np > 65535) { pin.style.borderColor = '#ff3b30'; return; }
            fetch('/remote/set-port', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"port":' + np + '}' })
              .then(function (r) { return r.json(); })
              .then(function (d) { if (d.ok) { if (info) info.httpsPort = np; renderStatus(panel, info, hint); } else { alert(d.error || '\u7aef\u53e3\u8bbe\u7f6e\u5931\u8d25'); } })
              .catch(function () { alert('\u8bf7\u6c42\u5931\u8d25'); });
          });
          var cbtn = el('button', 'webrm-btn-sm', '\u53d6\u6d88');
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
})();`;
