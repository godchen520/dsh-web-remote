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
  // ===== 本地二维码生成（零依赖、零联网）=====
  // 之前是把链接拼到别人家的图床 URL 后面让远端画图：国内源 0.21s、境外 1.40s，
  // 断网就没码，而且 ?token=xxx 会明文发给第三方。这里自己按 ISO/IEC 18004 画。
  // 只实现字节模式(UTF-8) + 纠错等级 M + 版本 1~20（M 级最多 669 字节）。
  var QR_MAX_VERSION = 20;
  // [组1数据长, 每块纠错长, 组1块数, 组2数据长, 组2块数]；组2为 0 表示只有一种块。
  // 版本 8 起两种块的**数据长度不同**（组1比组2少1字节）—— 别假设所有块一样长。
  var QR_ECC_M = {1:[16,10,1,0,0],2:[28,16,1,0,0],3:[44,26,1,0,0],4:[32,18,2,0,0],5:[43,24,2,0,0],6:[27,16,4,0,0],7:[31,18,4,0,0],8:[38,22,2,39,2],9:[36,22,3,37,2],10:[43,26,4,44,1],11:[50,30,1,51,4],12:[36,22,6,37,2],13:[37,22,8,38,1],14:[40,24,4,41,5],15:[41,24,5,42,5],16:[45,28,7,46,3],17:[46,28,10,47,1],18:[43,26,9,44,4],19:[44,26,3,45,11],20:[41,26,3,42,13]};
  var QR_DATA_CW = {1:16,2:28,3:44,4:64,5:86,6:108,7:124,8:154,9:182,10:216,11:254,12:290,13:334,14:365,15:415,16:453,17:507,18:563,19:627,20:669};
  var QR_ALIGN = {1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],9:[6,26,46],10:[6,28,50],11:[6,30,54],12:[6,32,58],13:[6,34,62],14:[6,26,46,66],15:[6,26,48,70],16:[6,26,50,74],17:[6,30,54,78],18:[6,30,56,82],19:[6,30,58,86],20:[6,34,62,90]};
  var QR_VER_INFO = {7:31892,8:34236,9:39577,10:42195,11:48118,12:51042,13:55367,14:58893,15:63784,16:68472,17:70749,18:76311,19:79154,20:84390};

  // GF(256) 上的乘 2 / 乘 3（生成多项式只用小系数）
  function qrMul(a, b) {
    var r = 0;
    for (var i = 0; i < 8; i++) {
      if (b & 1) r ^= a;
      var hi = a & 0x80;
      a = (a << 1) & 0xFF;
      if (hi) a ^= 0x1D;
      b >>= 1;
    }
    return r;
  }

  // alpha 的幂表：ALPHA_POW[i] = 2^i 在 GF(256) 里的值。
  // 必须查表 —— 直接写 Math.pow(2, d) 在 d>=8 时超出 GF(256) 范围（如 256、512），
  // 会让 qrMul 算出错误结果，整张码就扫不出来了（踩过这个坑）。
  var QR_ALPHA_POW = (function () {
    var t = [1];
    for (var i = 1; i < 255; i++) t.push(qrMul(t[i - 1], 2));
    return t;
  })();

  // 生成 degree 次的 RS 生成多项式系数（首项恒为 1，共 degree+1 项）
  function qrGenPoly(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1);
      for (var i = 0; i < next.length; i++) next[i] = 0;
      var alpha = QR_ALPHA_POW[d];
      for (var j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= qrMul(poly[j], alpha);
      }
      poly = next;
    }
    return poly;
  }

  // 对一块数据算纠错码字
  function qrRsEncode(data, ecLen) {
    var gen = qrGenPoly(ecLen);
    var res = new Array(ecLen);
    for (var i = 0; i < ecLen; i++) res[i] = 0;
    for (var k = 0; k < data.length; k++) {
      var factor = data[k] ^ res[0];
      for (var j = 0; j < ecLen - 1; j++) res[j] = res[j + 1];
      res[ecLen - 1] = 0;
      for (var m = 0; m < ecLen; m++) res[m] ^= qrMul(gen[m + 1], factor);
    }
    return res;
  }

  // UTF-8 编码成字节数组
  function qrUtf8(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) { out.push(0xC0 | (c >> 6), 0x80 | (c & 63)); }
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < str.length) {
        var c2 = str.charCodeAt(i + 1);
        var cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
        i++;
      } else { out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)); }
    }
    return out;
  }

  // 选最小可用版本
  function qrPickVersion(len) {
    for (var v = 1; v <= QR_MAX_VERSION; v++) {
      // 计数指示符：版本 1~9 用 8 位，10 起用 16 位
      var need = 4 + (v <= 9 ? 8 : 16) + len * 8;
      if (need <= QR_DATA_CW[v] * 8) return v;
    }
    return 0;
  }

  // 组装数据码字（模式指示符 + 字符计数 + 数据 + 终止符 + 填充）
  function qrDataCodewords(bytes, version) {
    var bits = [];
    var push = function (val, n) {
      for (var i = n - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    push(4, 4);
    push(bytes.length, version <= 9 ? 8 : 16);
    for (var i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var cap = QR_DATA_CW[version] * 8;
    var term = Math.min(4, cap - bits.length);
    push(0, term);
    while (bits.length % 8 !== 0) bits.push(0);
    var cw = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      cw.push(v);
    }
    var pad = [0xEC, 0x11];
    var pi = 0;
    while (cw.length < QR_DATA_CW[version]) { cw.push(pad[pi % 2]); pi++; }
    return cw;
  }

  // 分块 + 纠错 + 交织
  function qrInterleave(cw, version) {
    var spec = QR_ECC_M[version];
    var d1 = spec[0], ecLen = spec[1], g1 = spec[2], d2 = spec[3], g2 = spec[4];
    var blocks = [], eccs = [], pos = 0;
    // 版本 8 起有两组块，且**两组的数据长度差 1 字节**（组1 短、组2 长）。
    // 以前假设所有块等长，版本 8~10 会算出错误交织（图看着正常但扫不出）。
    for (var i = 0; i < g1; i++) {
      var b1 = cw.slice(pos, pos + d1);
      pos += d1;
      blocks.push(b1);
      eccs.push(qrRsEncode(b1, ecLen));
    }
    for (var j = 0; j < g2; j++) {
      var b2 = cw.slice(pos, pos + d2);
      pos += d2;
      blocks.push(b2);
      eccs.push(qrRsEncode(b2, ecLen));
    }
    var maxLen = Math.max(d1, d2 || 0);
    var out = [];
    // 短块在最后一轮自动跳过（c < blocks[b].length）
    for (var c = 0; c < maxLen; c++) {
      for (var b = 0; b < blocks.length; b++) {
        if (c < blocks[b].length) out.push(blocks[b][c]);
      }
    }
    for (var e = 0; e < ecLen; e++) {
      for (var b3 = 0; b3 < eccs.length; b3++) out.push(eccs[b3][e]);
    }
    return out;
  }

  // 建矩阵：功能图案 + 数据填充 + 掩码择优
  function qrMatrix(version, finalCw) {
    var size = version * 4 + 17;
    var m = [], fn = [];
    for (var i = 0; i < size; i++) {
      m.push(new Array(size));
      fn.push(new Array(size));
      for (var j = 0; j < size; j++) { m[i][j] = 0; fn[i][j] = 0; }
    }
    var setF = function (r, c, v) {
      if (r < 0 || c < 0 || r >= size || c >= size) return;
      m[r][c] = v; fn[r][c] = 1;
    };
    // 定位图案 + 分隔符
    var finder = function (r0, c0) {
      for (var r = -1; r <= 7; r++) {
        for (var c = -1; c <= 7; c++) {
          var rr = r0 + r, cc = c0 + c;
          if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
          var inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
          var inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setF(rr, cc, inRing || inCore ? 1 : 0);
        }
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
    // 定时图案
    for (var t = 8; t < size - 8; t++) {
      setF(6, t, t % 2 === 0 ? 1 : 0);
      setF(t, 6, t % 2 === 0 ? 1 : 0);
    }
    // 对齐图案
    var ac = QR_ALIGN[version];
    for (var a = 0; a < ac.length; a++) {
      for (var b = 0; b < ac.length; b++) {
        var ar = ac[a], acc = ac[b];
        if ((ar === 6 && acc === 6) || (ar === 6 && acc === size - 7) || (ar === size - 7 && acc === 6)) continue;
        for (var dr = -2; dr <= 2; dr++) {
          for (var dc = -2; dc <= 2; dc++) {
            var edge = Math.max(Math.abs(dr), Math.abs(dc));
            setF(ar + dr, acc + dc, edge === 2 || edge === 0 ? 1 : 0);
          }
        }
      }
    }
    // 预留格式信息区（先占位，稍后真正写入）
    for (var f = 0; f <= 8; f++) {
      if (!fn[8][f]) setF(8, f, 0);
      if (!fn[f][8]) setF(f, 8, 0);
    }
    for (var f2 = 0; f2 < 8; f2++) {
      if (!fn[8][size - 1 - f2]) setF(8, size - 1 - f2, 0);
      if (!fn[size - 1 - f2][8]) setF(size - 1 - f2, 8, 0);
    }
    setF(size - 8, 8, 1); // 固定的深色模块
    // 版本信息（>= 7）
    if (version >= 7) {
      var vi = QR_VER_INFO[version];
      for (var k = 0; k < 18; k++) {
        var bit = (vi >> k) & 1;
        var rr2 = Math.floor(k / 3), cc2 = k % 3;
        setF(size - 11 + cc2, rr2, bit);
        setF(rr2, size - 11 + cc2, bit);
      }
    }
    // 数据填充（之字形）
    var bitIdx = 0, total = finalCw.length * 8;
    var getBit = function (i) { return (finalCw[i >> 3] >> (7 - (i & 7))) & 1; };
    var upward = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5;
      for (var n = 0; n < size; n++) {
        var row = upward ? size - 1 - n : n;
        for (var c2 = 0; c2 < 2; c2++) {
          var cc3 = col - c2;
          if (fn[row][cc3]) continue;
          m[row][cc3] = bitIdx < total ? getBit(bitIdx) : 0;
          bitIdx++;
        }
      }
      upward = !upward;
    }
    // 掩码评估
    var maskFn = [
      function (r, c) { return (r + c) % 2 === 0; },
      function (r, c) { return r % 2 === 0; },
      function (r, c) { return c % 3 === 0; },
      function (r, c) { return (r + c) % 3 === 0; },
      function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
      function (r, c) { return ((r * c) % 2) + ((r * c) % 3) === 0; },
      function (r, c) { return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0; },
      function (r, c) { return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0; }
    ];
    var applyMask = function (mask, apply) {
      for (var r = 0; r < size; r++) {
        for (var c = 0; c < size; c++) {
          if (fn[r][c]) continue;
          if (maskFn[mask](r, c) === apply) m[r][c] ^= 1;
        }
      }
    };
    var writeFormat = function (mask) {
      // 格式信息 = 5 位(纠错等级+掩码) + BCH(15,5) 校验，再异或 0x5412。
      // 位序：**最高位(bit14)在前** —— 之前写成低位在前，矩阵看着正常但任何
      // 扫码器都读不出（自己写的解码器用同一套反序，还会"验证通过"，别信）。
      var data = (0 << 3) | mask; // 纠错等级 M = 00
      var d = data << 10;
      for (var i = 14; i >= 10; i--) {
        if ((d >> i) & 1) d ^= 0x537 << (i - 10);
      }
      var fmt = ((data << 10) | d) ^ 0x5412;
      var bitAt = function (i) { return (fmt >> i) & 1; };
      // 副本1：bit14..bit9 -> (8,0..5)；bit8 -> (8,7)；bit7 -> (8,8)；
      //        bit6 -> (7,8)；bit5..bit0 -> (5,8),(4,8),(3,8),(2,8),(1,8),(0,8)
      for (var i2 = 0; i2 <= 5; i2++) setF(8, i2, bitAt(14 - i2));
      setF(8, 7, bitAt(8));
      setF(8, 8, bitAt(7));
      setF(7, 8, bitAt(6));
      for (var i3 = 0; i3 <= 5; i3++) setF(5 - i3, 8, bitAt(i3));
      // 副本2：bit14..bit8 -> (size-1,8)..(size-7,8)；bit7..bit0 -> (8,size-8)..(8,size-1)
      for (var i4 = 0; i4 <= 6; i4++) setF(size - 1 - i4, 8, bitAt(14 - i4));
      for (var i5 = 0; i5 <= 7; i5++) setF(8, size - 8 + i5, bitAt(7 - i5));
      setF(size - 8, 8, 1); // 固定深色模块
    };
    var score = function () {
      var s = 0, r, c;
      // 规则1：连续同色
      for (r = 0; r < size; r++) {
        var run = 1;
        for (c = 1; c < size; c++) {
          if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) s += 3; else if (run > 5) s += 1; }
          else run = 1;
        }
      }
      for (c = 0; c < size; c++) {
        var run2 = 1;
        for (r = 1; r < size; r++) {
          if (m[r][c] === m[r - 1][c]) { run2++; if (run2 === 5) s += 3; else if (run2 > 5) s += 1; }
          else run2 = 1;
        }
      }
      // 规则2：2x2 同色块
      for (r = 0; r < size - 1; r++) {
        for (c = 0; c < size - 1; c++) {
          var v = m[r][c];
          if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) s += 3;
        }
      }
      // 规则3：1:1:3:1:1 图案
      var pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
      var pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
      var match = function (arr, off, pat) {
        for (var i = 0; i < 11; i++) if (arr[off + i] !== pat[i]) return false;
        return true;
      };
      for (r = 0; r < size; r++) {
        var rowArr = m[r];
        for (c = 0; c + 11 <= size; c++) {
          if (match(rowArr, c, pat1) || match(rowArr, c, pat2)) s += 40;
        }
      }
      for (c = 0; c < size; c++) {
        var colArr = [];
        for (r = 0; r < size; r++) colArr.push(m[r][c]);
        for (r = 0; r + 11 <= size; r++) {
          if (match(colArr, r, pat1) || match(colArr, r, pat2)) s += 40;
        }
      }
      // 规则4：深色比例偏离 50%
      var dark = 0;
      for (r = 0; r < size; r++) for (c = 0; c < size; c++) if (m[r][c]) dark++;
      var pct = dark * 100 / (size * size);
      s += Math.floor(Math.abs(pct - 50) / 5) * 10;
      return s;
    };
    var best = -1, bestScore = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      applyMask(mk, true);
      writeFormat(mk);
      var sc = score();
      if (sc < bestScore) { bestScore = sc; best = mk; }
      applyMask(mk, false);
    }
    applyMask(best, true);
    writeFormat(best);
    return m;
  }

  // 对外：把文本画成二维码，返回 0/1 二维数组
  function qrEncode(text) {
    var bytes = qrUtf8(String(text));
    var version = qrPickVersion(bytes.length);
    if (!version) return null;
    var cw = qrDataCodewords(bytes, version);
    var finalCw = qrInterleave(cw, version);
    return qrMatrix(version, finalCw);
  }

  // 把 <img> 换成"本地画出来的二维码"。
  // 以前是把链接拼到别人家的图床 URL 上让远端画图（国内 0.21s / 境外 1.40s，
  // 断网就没码，?token= 还会发给第三方）；现在纯本地生成，瞬时出图、离线可用。
  // target 为空或超出容量时把 <img> 藏起来，避免留一张破图。
  function setQrImage(img, target) {
    if (!target) { img.removeAttribute('src'); img.style.display = 'none'; return; }
    var mat = null;
    try { mat = qrEncode(target); } catch (e) { mat = null; }
    if (!mat) { img.removeAttribute('src'); img.style.display = 'none'; return; }
    var n = mat.length;
    var quiet = 4;
    var total = n + quiet * 2;
    // 位图分辨率必须 >=「显示尺寸 × devicePixelRatio」，否则会被浏览器放大插值 → 糊。
    // 实测（无头 Edge 量真实布局）：
    //   面板二维码内容区 174x174 CSS px（#webrm-qr 是 190x190 且 padding 8 + border-box）
    //   微信二维码内容区 200x200 CSS px
    //   手机 DPR 普遍 3 → 最大需要 200 x 3 = 600 设备像素
    // 第一版写成 1 模块 1 像素（版本4 只有 41px）→ 放大 14 倍，糊到扫不出；
    // 第二版取 400px，在 DPR 3 下仍被放大 1.5 倍，还是糊（用户两轮反馈）。
    // 现在按"内容区 × DPR"实时算：优先读 img 的真实布局尺寸，读不到再用兜底值。
    var FALLBACK_CSS = 200;   // 面板 174、微信/QQ 200，取最大
    var cssPx = 0;
    try {
      var dpr = window.devicePixelRatio || 1;
      var rect = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
      if (rect && rect.width > 0) {
        // border-box 减掉内边距才是图片真正占据的区域
        var cs = window.getComputedStyle ? window.getComputedStyle(img) : null;
        var padX = cs ? (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) : 0;
        var padY = cs ? (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) : 0;
        cssPx = Math.max(rect.width - padX, rect.height - padY);
      }
      if (!(cssPx > 0)) cssPx = FALLBACK_CSS;
      cssPx = cssPx * dpr;
    } catch (e) {
      cssPx = FALLBACK_CSS * 2;
    }
    // 再留 10% 余量；上限 1600 防呆（正常不会到）
    var need = Math.ceil(cssPx * 1.1);
    if (need < 400) need = 400;      // 屏幕小/DPR 1 时也别低于 400，免得锐度不如从前
    if (need > 1600) need = 1600;
    var scale = Math.ceil(need / total);
    if (scale < 4) scale = 4;        // 版本 20（105 模块）也保证每模块 4px
    var px = total * scale;
    var cv = document.createElement('canvas');
    cv.width = px;
    cv.height = px;
    var g = cv.getContext('2d');
    // 关掉平滑：否则每个 fillRect 的边界会被抗锯齿抹成灰边，缩小时仍显糊。
    // 二维码要的是硬边。
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, px, px);
    g.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (mat[r][c]) g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
      }
    }
    // 用 toDataURL 而不是直接塞 canvas：<img> 受现有样式约束（尺寸/圆角/背景），
    // 换成 canvas 会破坏各处的 cssText 与布局。canvas 不插入文档，画完即丢。
    img.style.display = '';
    // 不要设 image-rendering:pixelated —— 位图与显示尺寸不是整数比时，最近邻缩小
    // 反而会让模块边缘发毛。位图 >= 显示尺寸时浏览器默认的高质量缩小最干净。
    img.src = cv.toDataURL('image/png');
  }

  var currentBotChannel = null;
  // 断开态下用户点「重新配置」时强制显示配置表单（否则 token 失效就无路可走）
  var forceConfigChannel = null;
  // 尺寸参照：优先用「设置」那个原生按钮（我们的按钮就是照着它长的）。
  // 不能只按"所在容器里最宽的原生按钮"去找 —— 按钮被放进纵向大容器后，
  // 容器里还有「新会话」「插件」等更宽的原生按钮，参照会挑错，
  // 结果尺寸/内边距和「设置」对不上（用户反馈"不是和原生按钮一样"）。
  var webrmRefBtn = null;
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
    var extraCss = '.webrm-label-note{margin-left:8px;color:#1d1d1f;font-weight:500}body[data-ds-dark-theme] .webrm-label-note{color:#f5f5f7}#webrm-port-box{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.1)}#webrm-port-box .webrm-label2{font-size:12px;color:#8e8e93;margin-bottom:6px}#webrm-port-box .webrm-port-row{display:flex;align-items:center;gap:6px}#webrm-port-box .webrm-port-fixed{color:#8e8e93;font-size:13px;white-space:nowrap}#webrm-port-box .webrm-port-editable{cursor:pointer;padding:2px 0;border-bottom:1px dashed rgba(120,120,128,.4);color:#0a84ff;font-weight:500;font-size:13px}#webrm-port-box .webrm-port-editable:hover{border-bottom-color:#0a84ff}#webrm-port-box input{width:70px;padding:5px 8px;background:#f2f2f7;border:1px solid #d1d1d6;border-radius:6px;color:#1d1d1f;font-size:13px;outline:none;font-family:inherit}body[data-ds-dark-theme] body[data-ds-dark-theme] body[data-ds-dark-theme] #webrm-port-box .webrm-port-editable{color:#0a84ff}';
    var extraTag = document.createElement('style');
    extraTag.textContent = extraCss;
    document.head.appendChild(extraTag);
    // 标题版本徽标：圆角实底 + 镂空字。
    // 底色用 label-primary、字色用面板底色 token —— 浅色主题是"黑底白字"（镂空观感），
    // 深色主题 token 自动互换，于是变成"白底黑字"，标题文字本身也跟着主题反色。
    // 尺寸：内边距只留 1px（约等于一个笔画的宽度，3px/6px 太厚、像贴住字），
    //       与标题文字的间距 4px（和标题自身的字距观感一致），
    //       圆角 2px 2px 2px 0 —— 上面两角与右下圆、左下直角（左下要与下划线接上）。
    // 下划线：画在容器的 ::after 上（不能用 border-bottom —— 它只能贴盒子边缘）。
    // ⚠️ 位置必须落在**容器的 padding 区**里（容器 padding-bottom:2px + 线的 bottom:0）：
    //    19px 的中文字形墨迹几乎占满 22px 行框（离行框底只剩 1px），
    //    线若画在容器内部（例如 bottom:2px）必然压进字形 —— 实测线盖住字底 3 行，
    //    字的底边还会从线下面露出来。挪到 padding 区后：线紧贴字形底、0px 重叠。
    //    粗细 2px（≈标题笔画粗细）；右端也收 2px 圆角，与徽标右下圆角对齐。
    //    徽标不再需要 margin-bottom（其底边 = 内容框底 = 线的顶边，正好"坐"在线上）。
    var verTag = document.createElement('style');
    verTag.textContent = '#webrm-head-left{display:flex;align-items:flex-end;gap:4px;min-width:0;position:relative;padding-bottom:2px}'
      + '#webrm-head-left::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2px;background:var(--dsw-alias-label-primary,#1d1d1f);border-bottom-right-radius:2px}'
      + '#webrm-ver{display:inline-flex;align-items:center;font-size:.5em;line-height:1;font-weight:600;letter-spacing:.02em;padding:1px;border-radius:2px 2px 2px 0;background:var(--dsw-alias-label-primary,#1d1d1f);color:var(--dsw-alias-bg-layer-2,#fff)}'
      + 'body[data-ds-dark-theme] #webrm-ver{background:var(--dsw-alias-label-primary,#f5f5f7);color:var(--dsw-alias-bg-layer-2,#1c1c1e)}';
    document.head.appendChild(verTag);
    // 移动端视觉缩小（不覆盖 viewport）
    var mobileTag = document.createElement('style');
    mobileTag.textContent = '@media(max-width:768px){html{zoom:80%}}';
    document.head.appendChild(mobileTag);
    // 展开把手：钉在左上角（带 safe-area，避开刘海/圆角）。
    // 位置固定、不跟着原生按钮浮动；收起时由标题行让出 52px（见 ADAPT_CSS）。
    var railTag = document.createElement('style');
    railTag.textContent = '#webrm-railopen{position:fixed;top:calc(4px + env(safe-area-inset-top));left:calc(8px + env(safe-area-inset-left));'
      + 'z-index:9000;width:34px;height:34px;display:none;align-items:center;justify-content:center;padding:0;margin:0;'
      + 'border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:10px;cursor:pointer;'
      + 'color:var(--dsw-alias-label-primary,#1d1d1f);background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.92));'
      + 'box-shadow:0 1px 6px rgba(0,0,0,.25);'
      + '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}'
      + '#webrm-railopen[data-show="1"]{display:flex}'
      + '#webrm-railopen:active{opacity:.72}'
      + '#webrm-railopen svg{width:18px;height:18px;display:block}';
    document.head.appendChild(railTag);
    // 移动端适配层：全部规则都挂在 body.webrm-mobile 下（见 ADAPT_CSS）。
    // 常驻 head 也没关系 —— 退出窄屏时 body class 一摘，整层失效。
    var adaptTag = document.createElement('style');
    adaptTag.setAttribute('data-webrm-adapt', '1');
    adaptTag.textContent = ADAPT_CSS;
    document.head.appendChild(adaptTag);
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
      // 参照优先级：
      //  ① 「设置」那个原生按钮（我们就是照着它长的）—— 插入时记下来，最准；
      //  ② 兜底：所在容器里最宽/最大的可见原生按钮（桌面版没有可见的「设置」，走这条）。
      var ref = null;
      if (webrmRefBtn && webrmRefBtn !== btn && webrmRefBtn.isConnected && isVisibleEl(webrmRefBtn)) {
        var rref = webrmRefBtn.getBoundingClientRect();
        if (rref.height > 0 && rref.width > 0) ref = { el: webrmRefBtn, r: rref };
      }
      if (!ref) ref = findNativeRef(btn);
      if (!ref) return;
      var h = Math.round(ref.r.height);
      // 形态：**一律满行**（用户明确要求「和设置按钮一样的满行」）。
      //
      // 走过的弯路：我曾按「参照宽度 < 容器 80%」判定为"小按钮形态"并收缩成 70px —— 方向反了。
      // 那个 70px 是**被我自己的按钮挤出来的**：我们的按钮当时和「设置」在同一行，
      // 260 宽的按钮把原生「设置」压到了 70。拿这个被污染的值当依据，
      // 就把"满行"做成了"小按钮"。
      // 原生的「设置」其实是横跨侧边栏的**整行**（其容器实测 272x98，圆角背景）——
      // 现在按钮已经插在设置行**下面**，不再挤压它，直接撑满即可。
      var refKey = (ref.el.getAttribute('aria-label') || ref.el.title || ref.el.textContent || '').trim().slice(0, 10)
        + '|' + h + '|full';
      if (btn.dataset.webrmH === refKey) return;
      var rc = window.getComputedStyle(ref.el);
      // 左内边距抄参照自己的 paddingLeft。
      // 早先写成 paddingLeft = inset → 图标文字**贴死左边缘**（用户反馈）。
      var pl = parseFloat(rc.paddingLeft);
      // 左右外边距：抄参照按钮自己的 computed margin/font 等**样式值**。
      //
      // ⚠ 千万不要再用「参照矩形左边缘 − 容器矩形左边缘」那个几何偏移当 margin：
      //   getBoundingClientRect() 是 **border-box** 坐标，那个偏移里已经含了
      //   **容器自身 padding**；再把它当成子元素 margin 用一次 = 重复计算一次内缩，
      //   结果按钮左右各多缩一段 → **比原生行窄一截**（用户反馈"按钮宽度变小了"）。
      //   而且它是首次采样的瞬时值，采错一次就永久冻结。
      //   样式值（computed margin）不含容器 padding，用它才对得上。
      var ml = parseFloat(rc.marginLeft);
      var mr = parseFloat(rc.marginRight);
      if (!isFinite(ml) || ml < 0) ml = 0;
      if (!isFinite(mr) || mr < 0) mr = 0;
      // 满行形态：和原生「设置」那一行等宽。
      // 用 width:100% 而不是 width:auto —— auto 只在"块级父容器"里才铺满；
      // 父级一旦是 flex 行（或经 display:contents 链到 flex 行上）就会收缩成内容宽度，
      // 看起来就不是"满行"了。100% 对两种父容器都成立。
      btn.style.display = 'flex';
      btn.style.alignSelf = 'stretch';
      btn.style.width = '100%';
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
      // 横向不留外边距 —— 「满行」就该顶到容器两侧，和原生那一行对齐。
      // （早先抄参照的 margin，左右各缩一截，看着就不"满"了。）
      btn.style.margin = '2px 0 6px';
      btn.dataset.webrmH = refKey;
      // 日志打印「参照是谁/多大 → 按钮变成多大」，便于核对。
      try {
        var brSelf = btn.getBoundingClientRect();
        var refName = (ref.el.getAttribute('aria-label') || ref.el.title || ref.el.textContent || '').trim().slice(0, 12);
        console.log('[webrm] 尺寸跟随参照「' + refName + '」:', Math.round(ref.r.width) + 'x' + h,
          '（满行形态）',
          '→ 按钮', Math.round(brSelf.width) + 'x' + Math.round(brSelf.height),
          '圆角', rc.borderRadius, '左内边距', btn.style.paddingLeft, '外边距', btn.style.margin);
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
  /**
   * 找挂载点。返回 { container, after } 对象：
   *   container —— 把按钮插进哪个容器
   *   after     —— 若非 null，则插到该元素**之后**（用来实现「放在设置行下面一行」）
   * 找不到返回 null。
   *
   * 为什么不是直接返回「设置按钮的父容器」：
   * 用户要求 web 端把「远程」放在**设置那一行的下面**（独立一行），而不是挤在同一行。
   * 那一行通常用 space-between 分布，两个子元素会被推到行的两端 —— 观感很散。
   * 所以这里返回**承载设置行的容器** + 标记「插在设置行之后」，
   * 插进去后自然成为设置下方的独立一行。
   *
   * ⚠ 本文件整体是一个模板字符串（反引号包裹），注释里**不能出现反引号**，
   *   否则会截断模板字符串，导致注入脚本语法错误（真踩过）。
   */
  function findSettingsArea() {
    var root = findSidebarRoot();
    var rootRect = root ? root.getBoundingClientRect() : null;
    // ① 设置按钮 —— 但必须**可见**且**落在侧边栏内**。
    //    桌面版把「设置」挪进了头像弹出菜单：菜单项在 DOM 里但不在侧边栏内，
    //    直接采用会把按钮塞进"只有菜单打开时才看得见"的容器。
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var label = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '') + ' ' + (b.textContent || '');
      if (!/setting|设置|preference|偏好/i.test(label)) continue;
      if (!isVisibleEl(b)) continue;
      if (rootRect && !rectContains(rootRect, b.getBoundingClientRect())) continue;
      var row = b.parentNode;
      if (!row) continue;
      // ── 往上找「纵向排列」的容器 ──
      // 用户要求把按钮放到「设置」那一行的**下面**（独立一行）。
      // 关键：必须插进**纵向**容器里才会真的换行。
      // 如果只插到 row.parentNode（footer 常见是**横向** flex），
      // 按钮只会贴在设置行的右边、仍在同一行 —— 视觉上"没变"（真踩过）。
      // 所以这里从 row 往上走，直到遇到纵向 flex 或块级流容器。
      var holder = row.parentNode;
      var steps = 0;
      while (holder && holder !== document.body && steps < 8) {
        var broke = false;
        try {
          var cs = window.getComputedStyle(holder);
          var dir = cs.flexDirection || '';
          if (cs.display === 'flex' || cs.display === 'inline-flex') {
            if (dir === 'column' || dir === 'column-reverse') broke = true;
          } else if (cs.display === 'block' || cs.display === 'flow-root' || cs.display === 'list-item') {
            broke = true;   // 块级流：子元素天然各占一行
          }
        } catch (e) { /* ignore */ }
        if (broke) break;
        holder = holder.parentNode;
        steps += 1;
      }
      if (holder && holder !== document.body) {
        // 插到「holder 的直接子元素里、包住设置行的那一个」之后 ——
        // 保证 insertBefore 的参照节点确实是 holder 的孩子，否则会抛错。
        var anchor = row;
        var guard = 0;
        while (anchor.parentNode && anchor.parentNode !== holder && guard < 8) {
          anchor = anchor.parentNode;
          guard += 1;
        }
        if (anchor.parentNode === holder) return { container: holder, after: anchor, refBtn: b };
      }
      // 找不到合适的纵向容器：退回到设置行所在容器（至少保证可见）
      return { container: row.parentNode || row, after: null, refBtn: b };
    }
    // ② 兜底：侧边栏根元素的最后一个直接子容器
    //    （桌面版走这里 —— 设置藏在弹出菜单里，找不到可见的设置按钮；
    //      这个容器是底部头像行，纵向排列，追加进去就落在头像行下面 ✓ 与 web 端观感一致）
    if (root && root.children.length) {
      var foot = root.children[root.children.length - 1];
      if (foot) return { container: foot, after: null };
    }
    return null;
  }
  // 侧边栏是否收起。
  //
  // ⚠ 不能复用 findSidebarRoot()：它按「宽度 90~460」筛侧边栏，而收起后的图标栏
  //   只有 48~64px，会被直接滤掉 → 返回 null → collapsed 恒为 false → 按钮**不隐藏**，
  //   却待在一个窄栏里被裁切（用户截图反馈的「左侧栏收起时 UI 出错」）。
  //
  // 三重判断，任一命中即视为收起：
  //   ① 祖先类名带 collapsed
  //   ② 按钮所在容器比按钮本身还窄（装不下 → 收起）
  //   ③ 带 --dsh-sidebar-inline-padding 的侧边栏根宽度 < 90（放宽下限，把图标栏算进来）
  function isSidebarCollapsed() {
    var btn = document.getElementById('webrm-native');
    try {
      var p = btn ? btn.parentElement : null;
      for (var d = 0; p && d < 12; d++, p = p.parentElement) {
        if (/collapsed/i.test(String(p.className || ''))) return true;
      }
      if (btn && btn.parentElement) {
        var pr = btn.parentElement.getBoundingClientRect();
        var br = btn.getBoundingClientRect();
        if (pr.width > 0 && br.width > 0 && br.width > pr.width) return true;
      }
      var all = document.querySelectorAll('div');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        var v = window.getComputedStyle(el).getPropertyValue('--dsh-sidebar-inline-padding');
        if (!v || v.trim() === '') continue;
        var r = el.getBoundingClientRect();
        if (r.left > 90) continue;
        if (r.height < window.innerHeight * 0.35) continue;
        if (r.width > 0 && r.width < 90) return true;
      }
    } catch (e) { /* 量不到就当没收起，保持原行为 */ }
    return false;
  }
  function updateVisibility() {
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    // 收起时直接隐藏按钮（窄栏里放不下「远程」两字，显示出来必然被裁切）
    btn.style.display = isSidebarCollapsed() ? 'none' : '';
  }
  // ===== 窄屏收起态：去掉图标栏那条竖栏，只留一个展开把手 =====
  //
  // ⚠ 别改错地方（实测确认）：那条竖栏**不是**侧边栏元素撑出来的，而是 AppFrame 的
  //   一条网格轨道，并且以内联样式写在 frame 元素上：
  //       style="grid-template-columns: 56px minmax(...) minmax(...)"
  //   那个 56 = dsh-client-ui-layout 的 collapsedWidth（darwin / 窗口标题栏之外恒为 56，
  //   见 lib/client.js:241）。所以「把侧边栏元素压成 0 宽」**完全没用** ——
  //   轨道照样占 56px，只会从一条有内容的竖栏变成一条空白。
  //   正确做法：只把内联模板的**第一条**轨道改成 0，后两条原样保留
  //   （右侧栏宽度是 JS 按视口动态算的，写死会连带弄坏右侧栏）。
  //
  // 另外：author 的 !important 才能压过内联样式，而纯 CSS 又无法只替换一条轨道，
  // 所以这里用 JS 改写内联值，并挂在 frame 的 style 观察器上重放（React 每次渲染会重写它）。
  var RAIL_BP = 1024;          // 与 DSH 自己的 SIDEBAR_AUTO_COLLAPSE 对齐
  var railPref = true;         // 手机端默认开；由 /remote/info 的 mobileRailHidden 覆盖
  /** 适配层总开关（挂在 body 上）：所有移动端规则都以此为作用域。 */
  var MOBILE_CLASS = 'webrm-mobile';
  /** 收起态竖栏已隐藏（挂在 body 上）：用来给标题行让位。 */
  var RAIL_HIDDEN_CLASS = 'webrm-rail-hidden';
  /**
   * 移动端适配样式表。
   *
   * 选择器策略：CSS Module 的类名是「**哈希前缀 + 语义后缀**」，
   * 所以用**属性后缀选择器** [class$="_centerCol"] —— 官方重建只换哈希时依然有效。
   * 前提：这些后缀在本版 DSH 里**逐个核实过存在**（见守卫 #39 的断言）。
   *
   * 全部规则都挂在 body.webrm-mobile 下：退出窄屏时整层失效，
   * 不需要逐条还原（这一点是必须的 —— 这个 style 标签常驻 head，
   * 不加作用域的话桌面端也会被一起改掉）。
   *
   * ⚠ 钉轨道那三条里，第三条必须是 _rightbarCol。参考实现（dsh-remote-web-ui）
   *   写的是 _detailsCol，但那个后缀**在本版 DSH 里不存在**（逐包核实过），
   *   照抄会让右侧栏那条轨道失去约束。守卫 #39 会拦下 _detailsCol。
   */
  var ADAPT_CSS = [
    // 收起态：把第一条轨道钉成 0。!important 能压过 React 写在内联 style 上的
    // grid-template-columns，所以**不需要**再让 JS 去改写内联值（老做法已删）。
    // _frame 在 6 个包里都有，必须用 :has(_centerCol) 限定成 AppFrame。
    'body.' + MOBILE_CLASS + ' [class$="_frame"]:has([class*="_centerCol"])[data-sidebar-collapsed]{grid-template-columns:0 minmax(0,1fr) 0 !important}',
    // ⚠ 必须逐列显式钉住轨道。官方收起态的侧边栏是**绝对定位浮层**（脱离网格流），
    //   于是中间的 centerCol 会**自动落到那条已经变 0 宽的第一轨道**上，
    //   把对话挤成 0 宽 —— 而且是间歇性的（rail 在 relative/absolute 之间切）。
    'body.' + MOBILE_CLASS + ' [class$="_frame"][data-sidebar-collapsed] [class*="_sidebarCol"]{grid-column:1/2}',
    'body.' + MOBILE_CLASS + ' [class$="_frame"][data-sidebar-collapsed] [class$="_centerCol"]{grid-column:2/3}',
    'body.' + MOBILE_CLASS + ' [class$="_frame"][data-sidebar-collapsed] [class$="_rightbarCol"]{grid-column:3/4}',
    // 浮动按钮钉在左上角，标题行让出 52px，免得被压住。
    'body.' + MOBILE_CLASS + '.' + RAIL_HIDDEN_CLASS + ' [class$="_titleRow"]{padding-left:52px}',
    // 设置弹窗：官方是固定宽的两栏（左导航 + 右内容），窄屏下内容列被挤到卡片竖排。
    // 改成纵向堆叠、导航变横向可滚动一条。
    // ⚠ 必须限定在 body class 下：overlay 这个 portal 层是所有弹窗共用的。
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"]{flex-direction:column;max-height:calc(100dvh - 32px)}',
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class$="_nav"]{flex-direction:row;gap:4px;width:100%;padding:12px 12px 0;overflow-x:auto;overflow-y:hidden}',
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class$="_navTitle"]{display:none}',
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class$="_navList"]{flex-direction:row;gap:4px}',
    // navCell 是 clsx() 拼出来的（可能带第二个类），后缀匹配会失配 → 用包含匹配。
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class*="_navCell"]{height:34px;padding:0 12px;gap:6px;flex:none;border-radius:10px}',
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class$="_navLabel"]{font-size:13px}',
    'body.' + MOBILE_CLASS + ' [class$="_overlay"] [class$="_panel"] [class$="_content"]{flex:1;min-height:0}',
    // 右侧栏（右侧面板）在窄屏必须真的占满屏。
    //
    // 官方逻辑（dsh-client-ui-sidebar-right）：
    //   const autoFullscreen = viewportWidth < 768;          // viewportWidth = window.innerWidth
    //   const fullscreen = autoFullscreen || surface.layout.mode === "fullscreen";
    //   style: { width: fullscreen ? "100vw" : width }
    // 也就是说**只有 innerWidth < 768 时它才给自己 100vw**；否则按 width 部分宽度、
    // 以 position:absolute 挂在右侧栏列的右边缘上（那条列在手机上恒为 0 宽），
    // 于是变成"盖在对话上一半"的样子 —— 用户反馈的"右侧栏没有真的全屏"。
    //
    // 这里直接按窄屏强制占满。用 DSH 自己的属性 data-sidebar-right-panel
    // （取值 fullscreen / push），不碰哈希类名。
    // 面板是 absolute + right:0、锚在 0 宽的列右边缘（= 视口右边缘），
    // 所以给 width:100vw 就是"从右边缘往左铺满"，不要去设 left（那会跑到屏幕外）。
    'body.' + MOBILE_CLASS + ' [data-sidebar-right-panel]{width:100vw !important;max-width:100vw !important}',
  ].join('');
  /**
   * 收起态下侧边栏是否收起 —— 只看 DSH 自己的 data-sidebar-collapsed 属性是否在场
   * （React 只在收起时渲染它）。宽度改写已全部交给 CSS，这里只用来读状态。
   */
  function isRailCollapsed() {
    try { return document.querySelector('[data-sidebar-collapsed]') !== null; } catch (e) { return false; }
  }
  /**
   * 找 DSH 原生的侧边栏开关按钮。
   * 收起态它的 aria-label 是「打开侧边栏」，展开态是「收起侧边栏」——
   * 两个都要认：前者用来点击展开，后者用来量"切换按钮在哪个高度"。
   */
  function findNativeToggle() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === 'webrm-native' || b.id === 'webrm-railopen') continue;
      var lb = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (/打开侧边栏|展开侧边栏|收起侧边栏|折叠侧边栏|open sidebar|collapse sidebar/i.test(lb)) return b;
    }
    return null;
  }
  function findNativeOpenBtn() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.id === 'webrm-native' || b.id === 'webrm-railopen') continue;
      var lb = (b.getAttribute('aria-label') || '') + ' ' + (b.title || '');
      if (/打开侧边栏|展开侧边栏|open sidebar/i.test(lb)) return b;
    }
    return null;
  }
  // 说明：原来这里有一套「量原生开关的高度、把把手钉在同一高度」的逻辑。
  // 现在把手直接钉死在左上角（CSS 里带 safe-area），并让标题行让位 52px ——
  // 位置固定、不随原生按钮浮动，因此那套测量逻辑连同 railAnchorPct 一起删掉了。

  /** 从原生按钮抄来的图标 markup（用户要求"和收起的按钮一样的图标"）。 */
  var railIconMarkup = null;
  function applyRailIcon() {
    var mine = document.getElementById('webrm-railopen');
    if (mine && railIconMarkup) {
      mine.innerHTML = railIconMarkup;
      mine.setAttribute('data-icon', 'native');
    }
  }
  /**
   * 抄原生收起按钮的图标（DSH 用的是 IconPanelLeftOutlineRegular，"面板左"）。
   *
   * ⚠ 只在**展开态**抄：收起态那个按钮里还混着一个品牌标记（railMark / 鲸鱼 logo），
   *   而且那时图标是"打开"语义的。用户要的是**收起按钮**那个图标。
   *   抄到之后不再更换（railIconMarkup 只写一次）。
   */
  function learnRailIcon(collapsed) {
    try {
      if (railIconMarkup || collapsed) return;
      var b = findNativeToggle();
      if (!b) return;
      // 类名是 CSS Module 哈希（前缀随版本变），所以按后缀嗅探 panelIcon，不写死全名；
      // 实在嗅不到就退回取按钮里的 svg。
      var icon = b.querySelector('svg[class*="panelIcon"]') || b.querySelector('svg');
      if (!icon) return;
      railIconMarkup = icon.outerHTML;
      applyRailIcon();
    } catch (e) { /* ignore */ }
  }
  /** 展开侧边栏：复用 DSH 原生按钮（不自己改状态，行为与官方一致）。 */
  function openSidebar() {
    var b = findNativeOpenBtn();
    if (!b) {
      console.warn('[webrm] 未找到原生「打开侧边栏」按钮 —— 保持原样，不强行展开');
      return;
    }
    try { b.click(); } catch (e) { console.warn('[webrm] 展开失败:', e && e.message); }
  }
  /**
   * 判定「窄屏」。不能只看 innerWidth —— 实测手机上它未必 < 1024，
   * 所以加一条触摸设备兜底：指针是 coarse 且屏幕窄，同样按窄屏处理。
   */
  function railNarrow() {
    try {
      if (window.innerWidth < RAIL_BP) return true;
      var sw = (window.screen && window.screen.width) || 0;
      var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      if (coarse && sw > 0 && sw <= RAIL_BP) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  var railReports = 0;
  /**
   * 采 DOM 侧证据（只在没找到 frame 时需要）。
   * 为什么要：光知道"没找到"没用，得知道页面上**实际**有什么 —— 那条竖栏是哪个元素、
   * 宽度是谁给的、带不带 data-* 标记。
   */
  function railProbe() {
    var out = { attrCount: document.querySelectorAll('[data-sidebar-collapsed]').length, inlineGrid: [], rails: [] };
    try {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        if (out.inlineGrid.length >= 3 && out.rails.length >= 3) break;
        var e = all[i];
        try {
          if (out.inlineGrid.length < 3 && e.style && e.style.gridTemplateColumns) {
            out.inlineGrid.push(e.tagName + '|' + String(e.className).slice(0, 40) + '|'
              + e.style.gridTemplateColumns + '|w' + Math.round(e.getBoundingClientRect().width));
          }
          if (out.rails.length < 3) {
            var r = e.getBoundingClientRect();
            // "竖栏"特征：贴左、窄、高
            if (r.width > 20 && r.width < 90 && r.height > window.innerHeight * 0.4 && r.left < 20) {
              var chain = [];
              for (var p = e, k = 0; p && k < 4; k++, p = p.parentElement) {
                chain.push(p.tagName + '.' + String(p.className).slice(0, 28)
                  + (p.style && p.style.gridTemplateColumns ? '[g:' + p.style.gridTemplateColumns + ']' : '')
                  + '(w' + Math.round(p.getBoundingClientRect().width) + ')');
              }
              out.rails.push(chain.join(' < '));
            }
          }
        } catch (e2) { /* ignore */ }
      }
    } catch (e3) { /* ignore */ }
    return out;
  }
  /**
   * 右侧栏现场取证。
   *
   * 为什么要专门探它：官方是否给右侧栏全屏，取决于 window.innerWidth < 768
   * （见 dsh-client-ui-sidebar-right 的 autoFullscreen）。用户报"右侧栏没有真的
   * 全屏"时，只有拿到当时的 innerWidth + 面板属性 + 实际宽度，才能判断是
   * "innerWidth 越过了 768" 还是"面板自己没铺满"，而不是靠猜。
   */
  function rightbarProbe() {
    var out = {};
    try {
      out.w = window.innerWidth || 0;
      out.dw = (document.documentElement && document.documentElement.clientWidth) || 0;
      out.fullscreenAttr = document.querySelector('[data-rightbar-fullscreen]') !== null;
      out.rightbarCollapsedAttr = document.querySelector('[data-rightbar-collapsed]') !== null;
      var col = document.querySelector('[data-rightbar-col]');
      var panel = document.querySelector('[data-sidebar-right-panel]');
      out.colFound = col !== null;
      out.panelFound = panel !== null;
      if (panel) {
        out.panelMode = String(panel.getAttribute('data-sidebar-right-panel'));
        var pr = panel.getBoundingClientRect();
        out.panelW = Math.round(pr.width);
        out.panelLeft = Math.round(pr.left);
        out.panelPos = (window.getComputedStyle ? window.getComputedStyle(panel).position : '');
      }
      if (col) out.colW = Math.round(col.getBoundingClientRect().width);
      var frame = document.querySelector('[data-sidebar-collapsed]')
        || document.querySelector('[class$="_frame"]:has([class*="_centerCol"])');
      out.tpl = frame && frame.style ? String(frame.style.gridTemplateColumns || '') : '';
    } catch (e) { /* ignore */ }
    return out;
  }
  var railReports = 0;
  /**
   * 回报量到的数值（最多两次：首次 + 稳态）。
   *
   * ⚠ 必须等官方界面渲染出来之后再报：最早那次同步发生在页面初始化，
   *   那时 AppFrame 还不存在，报上去只能证明"还没渲染" —— **证明不了任何事**
   *   （我就是这么被自己误导过一轮的）。这里用「_centerCol 是否已出现」当就绪信号。
   */
  function railReport(force, detail) {
    var rendered = document.querySelector('[class*="_centerCol"]') !== null;
    if (!force && !rendered) return;
    if (!force && railReports >= 2) return;
    railReports += 1;
    try {
      var bodyEl = document.body;
      var payload = {
        phase: force ? 'steady' : 'first',
        w: window.innerWidth || 0,
        dw: (document.documentElement && document.documentElement.clientWidth) || 0,
        sw: (window.screen && window.screen.width) || 0,
        coarse: !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches),
        narrow: railNarrow(),
        pref: railPref,
        rendered: rendered,
        collapsed: isRailCollapsed(),
        bodyMobile: !!(bodyEl && bodyEl.classList.contains(MOBILE_CLASS)),
        bodyRailHidden: !!(bodyEl && bodyEl.classList.contains(RAIL_HIDDEN_CLASS)),
        adaptCss: document.querySelector('style[data-webrm-adapt]') !== null,
        btnShow: (function () { var b = document.getElementById('webrm-railopen'); return b ? b.getAttribute('data-show') : null; })(),
        probe: railProbe(),
        ua: String(navigator.userAgent || '').slice(0, 160)
      };
      if (detail) { for (var k in detail) { if (Object.prototype.hasOwnProperty.call(detail, k)) payload[k] = detail[k]; } }
      fetch('/remote/railreport', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).catch(function () { /* 上报失败不影响主流程 */ });
    } catch (e) { /* ignore */ }
  }
  /**
   * 按「窄屏 + 收起态 + 开关」同步 body class 与把手显隐。
   *
   * 宽度改写已经全部交给 ADAPT_CSS（纯 CSS + !important，能压过 React 写在内联
   * style 上的 grid-template-columns），这里只负责切两个 body class：
   *   body.webrm-mobile       —— 适配层总开关（窄屏时加）
   *   body.webrm-rail-hidden  —— 收起态竖栏已隐藏（给标题行让位用）
   * 因此不再有「改写内联值 → 被 React 写回 → 再改写」的循环，也不需要幂等标记。
   */
  function syncMobileAdapt() {
    try {
      var btn = document.getElementById('webrm-railopen');
      var body = document.body;
      var narrow = railNarrow();
      var collapsed = isRailCollapsed();
      learnRailIcon(collapsed);   // 展开态顺手把原生收起按钮的图标抄下来
      var want = railPref && narrow && collapsed;
      if (body) {
        if (narrow) body.classList.add(MOBILE_CLASS); else body.classList.remove(MOBILE_CLASS);
        if (want) body.classList.add(RAIL_HIDDEN_CLASS); else body.classList.remove(RAIL_HIDDEN_CLASS);
      }
      if (btn) btn.setAttribute('data-show', want ? '1' : '0');
      railReport(false, {
        want: want, narrow: narrow, collapsed: collapsed,
        bodyMobile: !!(body && body.classList.contains(MOBILE_CLASS)),
        bodyRailHidden: !!(body && body.classList.contains(RAIL_HIDDEN_CLASS)),
        adaptCss: document.querySelector('style[data-webrm-adapt]') !== null
      });
    } catch (e) { /* 量不到就保持原样，绝不影响主流程 */ }
  }
  /**
   * 收起/展开要**立刻**反映到把手与 body class 上。
   *
   * 用户实测："侧栏按钮显示有延迟，打开侧栏要过一会才消失，关闭侧栏也要等一会才出现。"
   * 原因：重构时把挂在 frame 上的观察器删掉了，只剩 2 秒定时兜底 —— 所以最多等 2 秒。
   *
   * 这里直接盯 DSH 自己的 data-sidebar-collapsed：
   *   布局层渲染的是 "data-sidebar-collapsed": sidebarCollapsed || void 0，
   *   也就是**收起时属性在场、展开时属性被移除** —— 一次切换只触发一次，
   *   比盯整棵子树的 class 变化精确得多（那边任何 hover/动画都会触发）。
   * 挂在 body 的 subtree 上，所以 frame 被 React 整棵重挂也不会漏。
   */
  var collapseObs = null;
  function watchCollapseState() {
    if (collapseObs || !window.MutationObserver || !document.body) return;
    try {
      // 用 window.MutationObserver 而不是裸全局：与上面的能力检查一致，
      // 而且异常被 catch 吞掉时不会静默不挂观察器（裸全局在非浏览器环境会 ReferenceError）。
      collapseObs = new window.MutationObserver(function () {
        try { syncMobileAdapt(); } catch (e) { /* ignore */ }
      });
      collapseObs.observe(document.body, { attributes: true, attributeFilter: ['data-sidebar-collapsed'], subtree: true });
    } catch (e) { collapseObs = null; }
  }
  /**
   * 右侧栏一出现/一换模式，就立刻同步 + 回报现场。
   *
   * 为什么单独盯它：官方是否把右侧栏铺满，取决于 window.innerWidth < 768
   * （autoFullscreen），而这个判断**发生在打开右侧栏的那一刻**。
   * 只靠页面加载时那两条上报，永远拿不到"右侧栏开着"时的现场 —— 于是
   * "到底为什么没全屏"又只能猜。这里在它出现的瞬间把 innerWidth / 面板属性 /
   * 实际宽度一次报回来（最多 3 次，避免刷爆）。
   */
  var rightbarObs = null;
  var rightbarReports = 0;
  function watchRightbar() {
    if (rightbarObs || !window.MutationObserver || !document.body) return;
    try {
      rightbarObs = new window.MutationObserver(function () {
        try {
          syncMobileAdapt();
          if (rightbarReports < 3) {
            rightbarReports += 1;
            railReport(true, rightbarProbe());
          }
        } catch (e) { /* ignore */ }
      });
      rightbarObs.observe(document.body, { attributes: true, attributeFilter: ['data-sidebar-right-panel'], subtree: true });
    } catch (e) { rightbarObs = null; }
  }
  /** 建展开把手（幂等）+ 挂收起观察器 / resize / 定时兜底。 */
  function createRailButton() {
    if (document.getElementById('webrm-railopen')) return;
    var rb = document.createElement('button');
    rb.id = 'webrm-railopen';
    rb.type = 'button';
    rb.title = '展开侧边栏';
    rb.setAttribute('aria-label', '展开侧边栏');
    rb.setAttribute('data-show', '0');
    // 默认就是"面板左"图标（与 DSH 收起按钮同族）；展开态一旦量到原生按钮就照抄它的 svg。
    rb.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>';
    rb.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      openSidebar();
    });
    document.body.appendChild(rb);
    // 立即响应：收起/展开一发生就同步（把手显隐 + body class）
    watchCollapseState();
    // 右侧栏出现/换模式时也要立刻同步（它是否铺满屏直接影响观感）
    watchRightbar();
    if (window.addEventListener) window.addEventListener('resize', function () { syncMobileAdapt(); });
    // 兜底：每 2 秒对一次（覆盖 React 整棵重挂、旋转屏幕等情况，开销极小）。
    // ⚠ 这只是兜底 —— 不能靠它来响应收起/展开，否则会有肉眼可见的延迟（踩过）。
    setInterval(function () { try { syncMobileAdapt(); } catch (e) { /* ignore */ } }, 2000);
    // 8 秒后强制上报一次"稳态"（诊断用，最多两条）
    setTimeout(function () { try { railReport(true); } catch (e) { /* ignore */ } }, 8000);
    syncMobileAdapt();
  }
  function syncGearColor() {
    // 重新读取设置按钮当前颜色并应用到远程按钮（主题/皮肤切换后颜色会变）
    var btn = document.getElementById('webrm-native');
    if (!btn) return;
    var target = findSettingsArea();
    if (!target) return;
    // 注意：findSettingsArea 现在返回 { container, after }，不是元素本身。
    // 取色范围用按钮实际的父元素更准（设置行也在它里面）。
    var scope = btn.parentElement || target.container;
    var buttons = scope.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i] !== btn) {
        try { btn.style.color = window.getComputedStyle(buttons[i]).color; } catch (e) { /* ignore */ }
        return;
      }
    }
  }
  function attachButton(btn) {
    var target = findSettingsArea();
    if (target) {
      var area = target.container;
      // 记住「设置」按钮当尺寸参照 —— 后面 syncNativeSize 优先用它，
      // 避免按钮被放进纵向大容器后参照挑到「新会话」那种更宽的原生按钮。
      if (target.refBtn) webrmRefBtn = target.refBtn;
      // ⚠ 只插入按钮 —— **绝不**改容器的布局、也**不碰**兄弟按钮的样式。
      //
      // 教训：这里原本会把容器改成 display:flex/justify-content:flex-start，
      // 并把所有兄弟 button 强制压成 34px 高、width:auto。
      // 浏览器版的「设置行」有余量，这么改没感觉；但**桌面版这个容器是头像行** ——
      // 强改布局 + 压缩兄弟按钮会把**用户头像挤成细条**（用户反馈"头像没回原位"）。
      try { syncGearColor(); } catch (e) { /* ignore */ }
      // 插入位置：有 after 就插到它后面（=「设置」那一行的下面，独立一行），
      // 否则追加到容器末尾（桌面版头像行 → 落在头像行下面）。
      try {
        if (target.after && target.after.parentNode === area) {
          area.insertBefore(btn, target.after.nextSibling);
        } else {
          area.appendChild(btn);
        }
      } catch (e) { area.appendChild(btn); }
      // ── 尺寸对齐同容器里的原生按钮（web 端是「设置」按钮，桌面版是「账号菜单」行）──
      // 只做**首次**对齐；参照按钮插入后还会自己变（实测 260x32 → 244x44），
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
      try {
        var _cs = window.getComputedStyle(area);
        console.log('[webrm] inserted into:', area.tagName, String(area.className).slice(0, 60),
          'display=' + _cs.display, 'direction=' + (_cs.flexDirection || '-'),
          target.after ? '(设置行之后)' : '(容器末尾)');
      } catch (e) { /* ignore */ }
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
      // 监听侧边栏展开/收起。
      // ⚠ 挂在 document.body 上，而不是挂在 findSidebarRoot() 的结果上 ——
      //   后者在「加载时侧边栏已经收起」的情况下返回 null，会导致观察器根本没挂上，
      //   之后无论怎么展开/收起都不再重算（用户截图反馈的 UI 出错就是这么来的）。
      //   挂 body 观测 subtree 的 class 变化，任何位置的展开/收起都能捕获。
      if (window.MutationObserver) {
        var obs = new MutationObserver(updateVisibility);
        obs.observe(document.body, { attributes: true, attributeFilter: ['class'], subtree: true });
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
            // ResizeObserver 也要重算可见性：侧边栏收起时按钮必须隐藏，
            // 只调 syncNativeSize 会把它压窄但仍显示文字 → 裁切。
            var sizeObs = new ResizeObserver(function () { syncNativeSize(btn); updateVisibility(); });
            sizeObs.observe(refForObs.el);
            sizeObs.observe(area);   // 侧边栏展开/收起也要跟着走
          }
        }
        if (window.addEventListener) {
          window.addEventListener('resize', function () { syncNativeSize(btn); updateVisibility(); });
        }
      } catch (e) { /* ignore */ }
      // 兜底：每 2 秒同步一次颜色 + 尺寸 + 可见性（覆盖纯 CSS 变量变化/参照被重建，开销极小）
      var colorTimer = setInterval(function () {
        try { syncGearColor(); } catch (e) { /* ignore */ }
        syncNativeSize(btn);
        updateVisibility();
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
      var names = { weixin: '微信', feishu: '飞书', telegram: '纸飞机', dingtalk: '钉钉', qqbot: 'QQ官方' };
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
      // 界面偏好：服务端说要不要在窄屏收起态隐藏图标栏（默认 true）
      try {
        if (typeof info.mobileRailHidden === 'boolean') railPref = info.mobileRailHidden;
      } catch (e) { /* ignore */ }
      try { syncMobileAdapt(); } catch (e) { /* ignore */ }
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
  /**
   * Tailscale 状态（**不带 "Tailscale：" 前缀**）——
   * 它紧跟在本行的「P2P（Tailscale）」标签后面，前缀是多余的（用户要求删掉）。
   * 只在"跟用户有关"时才显示（装了 Tailscale / 网卡里有 100.x）；
   * 没用 Tailscale 的人不该在面板上看到这条。
   *
   * 三种状态**共用同一套版式**（用户要求：未运行也套用"对端不在线"那套模板）：
   *   已连接 → 「通道已连通 · 路径 直连|中继（节点）」/「通道未连通（对端不在线）」
   *   未登录 → 「未登录（在电脑上登录后才会出现 P2P 链接）」
   *   未运行 → 「未运行（启动后这里会出现 P2P 链接）」
   */
  function tailscaleNote(ts) {
    if (!ts) return '';
    if (!ts.cli && !ts.viaInterface) return '';
    if (ts.connected) {
      var peers = ts.peers || [];
      // 用户指出「手机在线」是过度断言：Online 只表示对端连着控制面，
      // 不代表隧道真的建立（Tailscale 是懒建立，实测 LastHandshake 常为 0）。
      // 所以这里只描述**通道**：有对端在线 = 通道可用。
      var online = ts.onlinePeers || 0;
      var head;
      if (!peers.length) head = '通道未连通（没有其它设备）';
      else if (!online) head = '通道未连通（对端不在线）';
      else if (peers.length > 1) head = '通道已连通（' + online + ' 台对端在线）';
      else head = '通道已连通';
      // 路径只在连通时才有意义（未连通时显示的是上次的中继，容易误导）
      var path = (online && ts.pathSummary) ? (' · 路径 ' + ts.pathSummary + (ts.relay ? '（' + ts.relay + '）' : '')) : '';
      return head + path;
    }
    if (ts.viaInterface) return '通道已连通（仅从网卡识别到 100.x 地址）';
    // 未登录/未运行：如果记住了上次的地址（下面还留着链接行），提示改成"上次地址"
    var last = ts.lastIp || '';
    if (ts.stateText === '未登录') {
      return last ? '未登录（上次地址，登录后可用）' : '未登录（在电脑上登录后才会出现 P2P 链接）';
    }
    if (ts.stateText === '未运行') {
      return last ? '未运行（上次地址，启动后可用）' : '未运行（启动后这里会出现 P2P 链接）';
    }
    return ts.stateText || '未知';
  }

  /**
   * 100.64.0.0/10 = Tailscale / CGNAT 段。
   * 这类地址是 P2P 直连（"在外面访问家里"用），**不放在「局域网」页** ——
   * 局域网页只列真正同网段的地址，否则用户会以为关了 Tailscale 也能用。
   * （免 token 判定在 proxy.mjs 的 isPrivateAddress 里，两处口径要一致）
   */
  function isP2PIp(ip) {
    return /^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(String(ip || ''));
  }
  function lanOnlyIps(info) {
    var all = (info && info.ips) || [];
    var out = [];
    for (var i = 0; i < all.length; i++) { if (!isP2PIp(all[i])) out.push(all[i]); }
    return out;
  }
  function p2pOnlyIps(info) {
    var all = (info && info.ips) || [];
    var out = [];
    for (var i = 0; i < all.length; i++) { if (isP2PIp(all[i])) out.push(all[i]); }
    return out;
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
    { id: 'qqbot', name: 'QQ官方', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673.54.065 2.103-2.472 2.103-2.472 0 1.469.756 3.387 2.394 4.771-.612.188-1.363.479-1.845.835-.434.32-.379.646-.301.778.343.578 5.883.369 7.482.189 1.6.18 7.14.389 7.483-.189.078-.132.132-.458-.301-.778-.483-.356-1.233-.646-1.846-.836 1.637-1.384 2.393-3.302 2.393-4.771 0 0 1.563 2.537 2.103 2.472.251-.03.581-1.39-.438-4.673"/></svg>', hint: 'QQ 开放平台 Agent 接入（官方，无需额外 QQ 号）' },
    { id: 'telegram', name: '纸飞机', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>', hint: 'Telegram Bot API 接入' },
    { id: 'dingtalk', name: '钉钉', icon: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/><path d="M10.5 7h3l-1.5 4h4l-6 8 1.5-4H8z" fill="#fff"/></svg>', hint: '钉钉机器人 Stream 接入' },
    { id: 'feishu', name: '飞书', icon: '<svg viewBox="7 7 26 26" fill="currentColor"><path d="M16.791 30c5.57 0 10.423-3.074 12.955-7.618q.133-.239.258-.484a6 6 0 0 1-.425.699 6 6 0 0 1-.17.23 6 6 0 0 1-.225.274q-.092.105-.188.206a6 6 0 0 1-.407.384 6 6 0 0 1-.24.195 7 7 0 0 1-.292.21q-.094.065-.191.122c-.097.057-.134.081-.204.119q-.21.116-.428.215a6 6 0 0 1-.385.157 6 6 0 0 1-.43.138 6 6 0 0 1-.661.143 6 6 0 0 1-.491.055 6.125 6.125 0 0 1-1.543-.085 7 7 0 0 1-.38-.079l-.2-.051-.555-.155-.275-.081-.41-.125-.334-.107-.317-.104-.215-.073-.26-.091-.186-.066-.367-.134-.212-.081-.284-.11-.299-.119-.193-.079-.24-.1-.185-.078-.192-.084-.166-.073-.152-.067-.153-.07-.159-.073-.2-.093-.208-.099-.222-.108-.189-.093a31.2 31.2 0 0 1-8.822-6.583.202.202 0 0 0-.349.138l.005 9.52v.773c0 .448.222.87.595 1.118A14.75 14.75 0 0 0 16.791 30z"/><path d="M33.151 16.582a8.45 8.45 0 0 0-3.744-.869 8.5 8.5 0 0 0-2.303.317l-.252.075-.177.058-.348.127-.606.265-.617.33-.598.386-.404.306-.419.359-.218.206-.374.37-.269.266-.293.289-.281.278-.299.296-.348.344-.256.254-.085.084-.125.122-.063.06-.095.09-.105.099a15 15 0 0 1-3.072 2.175l.2.093.159.073.153.07.152.067.166.073.192.084.185.078.24.1.193.079.299.119.284.11.212.081.367.134.186.066.26.09.215.073.317.104.334.107.41.125.275.081.555.155.2.051.379.079.433.062.585.037.525-.014.491-.055a6 6 0 0 0 .66-.143l.43-.138.385-.158.427-.215.204-.119.191-.122.292-.21.24-.195.407-.384.188-.206.225-.274.17-.23a6 6 0 0 0 .421-.693l.144-.288 1.305-2.599-.003.006a8.1 8.1 0 0 1 1.697-2.439z"/><path d="M21.069 20.504l.063-.06.125-.122.085-.084.256-.254.348-.344.299-.296.281-.278.293-.289.269-.266.374-.37.218-.206.419-.359.404-.306.598-.386.617-.33.606-.265.348-.127.177-.058a14.78 14.78 0 0 0-2.793-5.603c-.252-.318-.639-.502-1.047-.502H12.221c-.196 0-.277.249-.119.364a31.49 31.49 0 0 1 8.943 10.162c.008-.007.016-.015.025-.023z"/></svg>', hint: '飞书机器人接入' },
  ];
  function botChannelStatus(id, info) {
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
    if (id === 'dingtalk') {
      if (info && info.dingtalk === 'connected') return '已连接';
      if (info && info.dingtalk === 'configured') return '已配置';
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
                img.style.cssText = 'width:200px;height:200px;border-radius:8px;background:#fff';
                // 本地生成，不再依赖任何外部图床（以前写死国外源，国内要等好几秒）
                setQrImage(img, data.qrcodeUrl);
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
            // 飞书：强制显示配置表单 —— 已连接时点「重新绑定」也能换凭证
            // （否则 renderBotPage 会继续显示"已连接"，按钮点了像没反应）
            forceConfigChannel = 'feishu';
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '请在下方填写凭证')); }
            renderBotPage(panel, info, hint);
          } else if (ch.id === 'telegram' || ch.id === 'qqbot' || ch.id === 'dingtalk') {
            // Telegram / QQ官方 / 钉钉：同样强制显示配置表单（换 Token / 换 AppID Secret / 换 AppKey Secret）
            forceConfigChannel = ch.id;
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '请在下方填写凭证')); }
            renderBotPage(panel, info, hint);
          } else {
            if (st2) { st2.textContent = ''; st2.appendChild(el('span', '', '该通道暂未接入')); }
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
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已断开')); var dot = st3.querySelector('.webrm-bot-dot'); if (dot) dot.style.background = '#ef4444'; }
              info.feishu = null;
              renderBotPage(panel, info, hint);
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '断开失败')); }
            });
          } else if (ch.id === 'telegram') {
            // 与原表单内「断开连接」同一 API —— 统一入口后移除重复按钮
            fetch('/remote/telegram/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已断开')); }
              if (info) info.telegram = null;
              renderBotPage(panel, info, hint);
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '断开失败')); }
            });
          } else if (ch.id === 'qqbot') {
            fetch('/remote/qqbot/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已断开')); }
              if (info) info.qqbot = null;
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '断开失败')); }
            });
          } else if (ch.id === 'dingtalk') {
            fetch('/remote/dingtalk/disconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已断开')); var dt5 = st3.querySelector('.webrm-bot-dot'); if (dt5) dt5.style.background = '#ef4444'; }
              if (info) info.dingtalk = null;
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            }).catch(function () {
              if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '断开失败')); }
            });
          } else {
            if (st3) { st3.textContent = ''; st3.appendChild(el('span', '', '已解绑')); }
          }
        });
        // ── 动作按钮：状态感知 + 五个通道统一入口 ──
        //
        // 四次演进（用户反馈驱动）：
        //  ① 飞书此前被 selfManaged 排除 → 面板里完全没有"断开"入口；
        //  ② 微信已连接仍写「绑定」+「点击绑定开始扫码」，语义不合理；
        //  ③ Telegram/QQ官方 各自在表单里塞「断开连接」，与其他通道不统一
        //     —— 现在统一为顶部一行：重新绑定（换凭证，强制显示配置表单）
        //        + 断开（调同一套 /disconnect API），表单里的重复按钮已移除；
        //  ④ 钉钉（此前被 selfManaged 排除，点了只显示"功能开发中"）现已实现，
        //     同样并入这一行 —— 5 个通道不再有任何例外。
        var chStatusNow = botChannelStatus(ch.id, info);
        var paired = (chStatusNow === '已连接' || chStatusNow === '已就绪' || chStatusNow === '已配置');
        connectBtn.textContent = paired ? '重新绑定' : '绑定';
        // 语义区分：微信是"解绑"（清掉配对，要重新扫码）；其余是"断开"（凭据保留，可一键重连）
        discBtn.textContent = (ch.id === 'weixin') ? '解绑' : '断开';
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
          } else if (tgSt === '已连接' && forceConfigChannel !== 'telegram') {
            // forceConfigChannel 检查：点顶部「重新绑定」后要能落到这里下面的配置表单
            tForm.appendChild(el('div', 'webrm-label2', 'Telegram 机器人已连接，可在 Telegram 里发消息控制 DSH'));
            tForm.appendChild(el('div', 'webrm-label2', '监听：' + ((info && info.telegramMonitor) ? '开（会话思考完毕会推送）' : '关（发 /监听 开启）')));
            // 「断开」已统一到顶部动作按钮（调用同一 API），此处不再放重复按钮
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
          } else if (qbSt === '已连接' && forceConfigChannel !== 'qqbot') {
            // ── 已连接（forceConfigChannel 检查：「重新绑定」后落到底部的配置表单）
            qForm.appendChild(el('div', 'webrm-label2', 'QQ 官方机器人已连接，可在 QQ 里给机器人发消息控制 DSH'));
            qForm.appendChild(el('div', 'webrm-label2', 'AppID：' + ((info && info.qqbotAppId) || '(已隐藏)')));
            qForm.appendChild(el('div', 'webrm-label2', '监听：' + ((info && info.qqbotMonitor) ? '开（会话思考完毕会推送）' : '关（发 /监听 开启）')));
            qForm.appendChild(el('div', 'webrm-label2', '提示：群聊需群主把机器人拉进群；主动推送需要你曾给机器人发过消息'));
            // 「断开」已统一到顶部动作按钮（调用同一 API），此处不再放重复按钮
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
                    setQrImage(img, d.qrUrl);
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
        } else if (ch.id === 'dingtalk') {
          // 钉钉：Stream 模式（长连接，不需要公网入口）。
          // 凭证 = 开发者后台的 Client ID / Client Secret；连接失败与凭证错误要分开提示。
          var dtkSt = botChannelStatus('dingtalk', info);
          qrZone.textContent = '';
          var dtkForm = el('div', '', '');
          dtkForm.style.cssText = 'padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var dtkCss = 'width:100%;box-sizing:border-box;padding:7px 10px;margin:6px 0;background:var(--dsw-alias-interactive-bg-hover,rgba(120,120,128,.08));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:8px;font-size:13px;outline:none;color:var(--dsw-alias-label-primary,#1d1d1f)';
          var dtkH = (info && info.health && info.health.dingtalk) || null;
          if (dtkH && dtkH.state === 'down' && forceConfigChannel !== 'dingtalk') {
            // ── 断开态：凭证还在，给一键重连
            var dtkTitle = el('div', '', '⚠ 连接断开，请检查网络或凭证');
            dtkTitle.style.cssText = 'font-size:13px;font-weight:600;color:#ef4444;margin-bottom:6px';
            dtkForm.appendChild(dtkTitle);
            var dtkReason = el('div', 'webrm-label2', dtkH.error || '连续连接失败');
            dtkReason.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);word-break:break-all';
            dtkForm.appendChild(dtkReason);
            var dtkRe = el('button', 'webrm-btn webrm-btn-primary', '重新连接');
            dtkRe.type = 'button';
            dtkRe.style.cssText = 'margin-top:8px;width:100%';
            dtkRe.addEventListener('click', function () {
              var stD = document.getElementById('webrm-bot-strow');
              dtkRe.disabled = true;
              if (stD) { stD.textContent = ''; stD.appendChild(el('span', '', '重连中…')); }
              fetch('/remote/dingtalk/reconnect', { method: 'POST' }).then(function (r) { return r.json(); }).then(function (d) {
                dtkRe.disabled = false;
                if (d.ok && d.connected) {
                  if (stD) { stD.textContent = ''; stD.appendChild(el('span', '', '已重连')); var dtDot = stD.querySelector('.webrm-bot-dot'); if (dtDot) dtDot.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  if (stD) { stD.textContent = ''; stD.appendChild(el('span', '', '重连失败：' + (d.error || '未知'))); stD.querySelector('span').style.color = '#ef4444'; }
                }
              }).catch(function (e) {
                dtkRe.disabled = false;
                if (stD) { stD.textContent = ''; stD.appendChild(el('span', '', '请求失败：' + e.message)); }
              });
            });
            dtkForm.appendChild(dtkRe);
            var dtkCfg = el('a', '', '→ 重新配置凭证');
            dtkCfg.href = 'javascript:void 0';
            dtkCfg.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px;text-decoration:underline';
            dtkCfg.addEventListener('click', function (ev) {
              ev.preventDefault();
              forceConfigChannel = 'dingtalk';
              fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
            });
            dtkForm.appendChild(dtkCfg);
          } else if (dtkH && dtkH.state === 'degraded') {
            dtkForm.appendChild(el('div', 'webrm-label2', '连接不稳定（第 ' + (dtkH.fails || 1) + ' 次失败）：' + (dtkH.error || '')));
          } else if (dtkSt === '已连接') {
            dtkForm.appendChild(el('div', 'webrm-label2', '钉钉机器人已连接，可在钉钉里发消息控制 DSH。'));
            dtkForm.appendChild(el('div', 'webrm-label2', '群聊需要 @机器人 才会收到消息；监听通知走 OpenAPI 主动推送，不受 sessionWebhook 1.5 小时限制。'));
          } else if (dtkSt === '已配置') {
            dtkForm.appendChild(el('div', 'webrm-label2', '钉钉已配置，但当前未连接 —— 点上方「重新连接」，或重新填写凭证。'));
          } else {
            dtkForm.appendChild(el('div', 'webrm-label2', '钉钉开发者后台 → 创建「企业内部应用」→ 添加机器人 → 消息接收模式选「Stream 模式」→ 发布应用，再填入 Client ID / Client Secret。'));
            var dtkKey = el('input', '', '');
            dtkKey.placeholder = 'AppKey（Client ID）';
            dtkKey.style.cssText = dtkCss;
            dtkForm.appendChild(dtkKey);
            var dtkSec = el('input', '', '');
            dtkSec.type = 'password';
            dtkSec.placeholder = 'AppSecret（Client Secret）';
            dtkSec.style.cssText = dtkCss;
            dtkForm.appendChild(dtkSec);
            var dtkBtn = el('button', 'webrm-btn webrm-btn-primary', '验证并连接');
            dtkBtn.type = 'button';
            dtkBtn.style.cssText = 'margin-top:8px;width:100%';
            dtkBtn.addEventListener('click', function () {
              var vKey = dtkKey.value.trim(), vSec = dtkSec.value.trim();
              var stD2 = document.getElementById('webrm-bot-strow');
              if (!vKey || !vSec) {
                if (stD2) { stD2.appendChild(el('span', '', ' 请填写全部凭证')); var spD = stD2.querySelector('span:last-child'); if (spD) spD.style.color = '#ef4444'; }
                return;
              }
              dtkBtn.disabled = true;
              if (stD2) { stD2.textContent = ''; stD2.appendChild(el('span', '', '验证并连接中…')); }
              fetch('/remote/dingtalk/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: vKey, appSecret: vSec }) }).then(function (r) { return r.json(); }).then(function (d) {
                dtkBtn.disabled = false;
                if (d.ok && d.connected) {
                  if (stD2) { stD2.textContent = ''; stD2.appendChild(el('span', '', '已连接')); var dtDot2 = stD2.querySelector('.webrm-bot-dot'); if (dtDot2) dtDot2.style.background = '#22c55e'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else if (d.ok && !d.connected) {
                  // 凭证有效但没连上：配置已保存，页面上会出现「重新连接」
                  if (stD2) { stD2.textContent = ''; stD2.appendChild(el('span', '', '已保存，但未连接：' + (d.error || '未知原因'))); var spD2 = stD2.querySelector('span'); if (spD2) spD2.style.color = '#ef4444'; }
                  fetchInfo().then(function (ni) { try { renderBotPage(panel, ni, hint); } catch (e) { /* ignore */ } });
                } else {
                  if (stD2) { stD2.textContent = ''; stD2.appendChild(el('span', '', '验证失败：' + (d.error || '未知错误'))); var spD3 = stD2.querySelector('span'); if (spD3) spD3.style.color = '#ef4444'; }
                }
              }).catch(function (e) {
                dtkBtn.disabled = false;
                if (stD2) { stD2.textContent = ''; stD2.appendChild(el('span', '', '请求失败：' + e.message)); }
              });
            });
            dtkForm.appendChild(dtkBtn);
            var dtkLink = el('a', '', '→ 打开钉钉开发者后台');
            dtkLink.href = 'https://open-dev.dingtalk.com';
            dtkLink.target = '_blank';
            dtkLink.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);display:inline-block;margin-top:10px';
            dtkForm.appendChild(dtkLink);
          }
          qrZone.appendChild(dtkForm);
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
            // 已连接时不该再写「点击绑定开始扫码」——那会让人以为要重新配对（用户反馈不合理）
            qrZone.appendChild(el('div', '', botChannelStatus('weixin', info) === '已连接'
              ? '已连接。如需更换微信号，点上方「重新绑定」生成新二维码。'
              : '点击「绑定」开始扫码'));
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
        hb.textContent = '通过聊天机器人遥控 DSH：微信 / 飞书 / 纸飞机 / QQ官方 / 钉钉。';
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
    var suffix = info && info.lanOpen ? '' : '/?token=' + ((info && info.token) || '');
    var lanIps = lanOnlyIps(info);
    var p2pIps = p2pOnlyIps(info);
    if (currentTab === 'lan' && lanIps.length) {
      // 局域网给**两条**链接：
      //  · HTTP —— 免证书，浏览器直接打开（推荐；缺点：非安全上下文，剪贴板 API 等受限）
      //  · HTTPS —— 插件自签名证书，浏览器必然报 ERR_CERT_AUTHORITY_INVALID，
      //             需要手动点「高级 → 继续前往」（优点：安全上下文）
      // 之前只给 HTTPS 一条，用户照抄必然撞证书错误，所以拆成两条并列。
      // 注意：Tailscale（100.64/10）不在这里，它在「公网」页 —— 那是"在外面访问家里"的入口。
      for (var ui = 0; ui < lanIps.length; ui++) {
        var ipx = lanIps[ui];
        urls.push({ label: '局域网 HTTP ' + ipx + '（推荐 · 免证书，点击复制）', url: 'http://' + ipx + ':' + info.port + suffix });
        if (info.httpsPort) {
          urls.push({ label: '局域网 HTTPS ' + ipx + '（自签名证书，浏览器会提示不安全）', url: 'https://' + ipx + ':' + info.httpsPort + suffix });
        }
      }
    } else if (currentTab === 'public') {
      // 「公网」页 = 在外面访问家里。这里并列两/三类入口：
      //  ① P2P（Tailscale）—— 直连/中继，速度快，手机需开着 Tailscale
      //  ② 公网隧道 —— 任何设备都能开，但走 Cloudflare 边缘，慢
      // 用户要求：Tailscale 状态**跟在「P2P（Tailscale）」同一行后面**（不再单起一段、不再有前缀）；
      // 未运行/未登录也套用同一套版式，并且**保留链接行**（用"上次记住的地址"）。
      var tsNote = tailscaleNote(info && info.tailscale);
      var tsLastIp = (info && info.tailscale && info.tailscale.lastIp) || null;
      var p2pList = p2pIps.length ? p2pIps : (tsLastIp ? [tsLastIp] : []);
      for (var pi = 0; pi < p2pList.length; pi++) {
        urls.push({
          label: 'P2P（Tailscale）',
          note: tsNote,
          url: 'http://' + p2pList[pi] + ':' + info.port + suffix,
        });
      }
      if (!p2pList.length && tsNote) {
        urls.push({ label: 'P2P（Tailscale）', note: tsNote, url: null });
      }
      if (info && info.url && info.token) {
        urls.push({ label: '公网隧道链接（任何设备可开，走 Cloudflare 较慢，点击复制）', url: info.url + '/?token=' + info.token });
      }
    }
    if (urls.length === 0) {
      if (info && info.running && currentTab === 'public') {
        box.appendChild(el('div', '', '隧道已断开：请点「停止」后重新「启动」'));
      } else {
        box.appendChild(el('div', '', '尚未启动'));
      }
    }
    urls.forEach(function (item) {
      if (item.label || item.note) {
        var labelEl = el('div', '', item.label || '');
        labelEl.className = 'webrm-label';
        // note 是状态文字（如「通道已连通 · 路径 中继（tok）」）：
        //  · 有标签时跟在标签后面 → 加 8px 间距，避免和「P2P（Tailscale）」粘在一起
        //  · 没有标签时它就是这一行本身（Tailscale 没跑、没有 P2P 行）→ **不能缩进**，
        //    否则会比其他行往右偏（用户指出过）
        if (item.note) {
          var noteEl = el('span', 'webrm-label-note', item.note);
          if (!item.label) noteEl.style.marginLeft = '0';
          labelEl.appendChild(noteEl);
        }
        box.appendChild(labelEl);
      }
      if (!item.url) return;
      var linkEl = el('div', '', item.url);
      linkEl.className = 'webrm-url';
      linkEl.style.marginBottom = '6px';
      linkEl.style.cursor = 'pointer';
      // 点击复制挂在**各自**的链接上。
      // 早先挂在 box 上、且写在 forEach 里 —— 有两条链接时点任意一处会同时触发两个
      // 处理器（复制到哪条取决于注册顺序），复制内容不可预期。
      linkEl.addEventListener('click', function (ev) {
        ev.stopPropagation();
        copyText(item.url, labelEl || linkEl, '已复制 ✓');
      });
      box.appendChild(linkEl);
    });
    (function () {
      var oldp = document.getElementById('webrm-port-box');
      if (oldp && oldp.parentNode) oldp.parentNode.removeChild(oldp);
      if (currentTab === 'lan' && lanIps.length) {
        var lip = lanIps[0];
        var pbox = el('div', '', '');
        pbox.id = 'webrm-port-box';
        pbox.appendChild(el('div', 'webrm-label2', '自定义端口（HTTP 与 HTTPS 不能相同）'));
        // 抽成工厂：HTTP / HTTPS 各渲染一行可编辑端口。
        // kind 会带给 /remote/set-port，宿主据此决定改哪个监听并分别持久化
        // （customHttpPort / customPort），改完自动重启代理使新端口立即生效。
        var makePortRow = function (kind, scheme, initial) {
          var cur = Number(initial);
          var prow = el('div', 'webrm-port-row', '');
          var renderEdit = function () {
            prow.textContent = '';
            var pre2 = el('span', 'webrm-port-fixed', scheme + '://' + lip + ':');
            var pin = el('input', '', '');
            pin.type = 'number'; pin.value = String(cur);
            pin.min = '1024'; pin.max = '65535';
            var abtn = el('button', 'webrm-btn-sm webrm-btn-sm-primary', '应用');
            abtn.addEventListener('click', function (e) {
              e.stopPropagation();
              var np = parseInt(pin.value, 10);
              if (isNaN(np) || np < 1024 || np > 65535) { pin.style.borderColor = '#ff3b30'; return; }
              fetch('/remote/set-port', {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ port: np, kind: kind }),
              })
                .then(function (r) { return r.json(); })
                .then(function (d) {
                  if (d.ok) {
                    cur = np;
                    if (info) { if (kind === 'http') info.port = np; else info.httpsPort = np; }
                    renderStatus(panel, info, hint);
                  } else { alert(d.error || '端口设置失败'); }
                })
                .catch(function () { alert('请求失败'); });
            });
            var cbtn = el('button', 'webrm-btn-sm', '取消');
            cbtn.addEventListener('click', renderView);
            prow.appendChild(pre2); prow.appendChild(pin); prow.appendChild(abtn); prow.appendChild(cbtn);
            pin.focus(); pin.select();
          };
          var renderView = function () {
            prow.textContent = '';
            var pre2 = el('span', 'webrm-port-fixed', scheme + '://' + lip + ':');
            var ed2 = el('span', 'webrm-port-editable', String(cur));
            ed2.addEventListener('click', renderEdit);
            prow.appendChild(pre2); prow.appendChild(ed2);
          };
          renderView();
          return prow;
        };
        // HTTP 行始终显示（它就是那个"免证书、直接能用"的地址）
        pbox.appendChild(makePortRow('http', 'http', info.port));
        if (info.httpsPort) pbox.appendChild(makePortRow('https', 'https', info.httpsPort));
        box.appendChild(pbox);
      }
      // 注：Tailscale 状态不再单独成段 —— 它跟在「P2P（Tailscale）」标签同一行后面
      // （用户要求：删掉「Tailscale 状态」标题与「Tailscale：」前缀，把状态搬到 P2P 那行）
    })();
    var qrOld = document.getElementById('webrm-qr');
    // 局域网二维码指向 **HTTP** 地址：手机扫码后直接能开，
    // 不会撞上自签名证书的「不安全」拦截页（HTTPS 那条留给需要安全上下文的场景）。
    // 公网页二维码优先用隧道（任何设备扫码都能开）；没有隧道时退回 P2P 地址。
    var qrTarget = null;
    if (currentTab === 'lan' && lanIps.length) {
      qrTarget = 'http://' + lanIps[0] + ':' + info.port + (info.lanOpen ? '' : '/?token=' + info.token);
    } else if (info && info.token) {
      if (info.url) qrTarget = info.url + '/?token=' + info.token;
      else if (p2pIps.length) qrTarget = 'http://' + p2pIps[0] + ':' + info.port + (info.lanOpen ? '' : '/?token=' + info.token);
    }
    if (qrTarget) {
      // 目标没变就**复用**现有二维码：面板每 10 秒轮询会重渲染一次，
      // 之前每次都重建 <img> 并附加 Date.now() 时间戳 → 每次都重新下载一次第三方图片，
      // 遇上国外源就是"二维码经常出得很慢"。现在同一目标直接沿用（浏览器缓存 + 不重建）。
      var reuseQr = !!(qrOld && qrOld.tagName === 'IMG' && qrOld.parentNode && qrOld.getAttribute('data-qr-target') === qrTarget);
      if (qrOld && qrOld.parentNode && !reuseQr) qrOld.parentNode.removeChild(qrOld);
      if (!reuseQr) {
        var q = el('img', '', '');
        q.id = 'webrm-qr';
        q.alt = '扫码访问';
        q.setAttribute('data-qr-target', qrTarget);
        // 不带时间戳：URL 里已经含目标本身，目标变了才会换图（也就不会显示旧图）
        setQrImage(q, qrTarget);
        panel.insertBefore(q, hint);
      }
    } else if (info && info.running && currentTab === 'public') {
      var waitEl = el('div', '', '正在获取公网链接，请稍候…');
      waitEl.id = 'webrm-qr';
      waitEl.style.cssText = 'font-size:12px;color:var(--dsw-alias-label-secondary,#888);text-align:center;margin:10px 0';
      panel.insertBefore(waitEl, hint);
    }
    var h2 = document.getElementById('webrm-hint');
    if (h2) {
      var parts = [];
      if (currentTab === 'lan') {
        parts.push('HTTP 那条免证书，浏览器直接能开 —— 同 Wi-Fi 首选。');
        parts.push('HTTPS 那条是自签名证书，浏览器会拦「不安全」：点「高级」→「继续前往」即可；'
          + '只有需要剪贴板/摄像头等安全上下文能力时才用它。');
      } else {
        // 用户要求：删掉底部那两段（P2P 说明 + 换链接提示），只留令牌提醒
        parts.push('注意：公网链接含访问令牌，请勿泄露。');
      }
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
    var head = el('h2', '', '');
    head.id = 'webrm-head';
    // h2 是 flex + space-between（× 靠右），所以标题文字和版本徽标要包一层，
    // 否则匿名文本节点会被当成独立 flex item，徽标被推到中间去。
    var headLeft = el('span', '', '');
    headLeft.id = 'webrm-head-left';
    headLeft.appendChild(document.createTextNode('远程访问'));
    var ver = el('span', '', '');
    ver.id = 'webrm-ver';
    ver.style.display = 'none';   // 拿到版本号再显示，避免空的黑药丸
    headLeft.appendChild(ver);
    head.appendChild(headLeft);
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
    // 版本徽标：拿到 /remote/info 的 version 才显示（拿不到就隐藏，不留空药丸）
    function updateVer(info) {
      var vb = document.getElementById('webrm-ver');
      if (!vb) return;
      var v = (info && info.version) ? String(info.version) : '';
      if (!v) { vb.style.display = 'none'; vb.textContent = ''; return; }
      vb.textContent = 'v' + v;
      vb.style.display = 'inline-flex';
    }
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
        updateVer(info);
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
        updateVer(info);
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
      try { createRailButton(); } catch (e) { /* 把手失败不影响主流程 */ }
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
