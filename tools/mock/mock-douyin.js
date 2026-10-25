/* 仿抖音桌面版的登录行为（只做脚本用得到的那点交互）。
   真实面板：726×483，三个 tab「扫码登录 / 验证码登录 / 密码登录」，默认停在扫码页，
   二维码是 175×202 的 <svg>，右上角关闭键是 37×36 的 <svg>。 */
(function () {
  var entry = document.querySelector('.login-entry');

  /** 假装是一张二维码：21×21 的黑白格子，用 svg data URL（和线上一样是 data: 图）。 */
  function qrDataUrl() {
    var n = 21, s = 8, rects = '';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        var on = ((x * 7 + y * 13 + x * y) % 5 < 2)
            || (x < 4 && y < 4) || (x > n - 5 && y < 4) || (x < 4 && y > n - 5);
        if (on) rects += '<rect x="' + x * s + '" y="' + y * s + '" width="' + s + '" height="' + s + '"/>';
      }
    }
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + n * s + '" height="' + n * s
        + '"><rect width="100%" height="100%" fill="#fff"/><g fill="#111">' + rects + '</g></svg>';
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }

  function buildPanel() {
    var d = document.createElement('div');
    d.id = 'douyin-login-new-id';
    d.className = 'douyin_login_new_class';
    d.innerHTML =
        '<div class="close"><svg width="37" height="36" viewBox="0 0 37 36">'
      + '<path d="M9 8 L28 27 M28 8 L9 27" stroke="#666" stroke-width="2" fill="none"/></svg></div>'
      + '<h3>扫码登录</h3>'
      + '<div class="tabs">'
      + '<span class="tab on" data-tab="qr">扫码登录</span>'
      + '<span class="tab" data-tab="code">验证码登录</span>'
      + '<span class="tab" data-tab="pwd">密码登录</span>'
      + '</div>'
      + '<div class="qrwrap"><img id="dy-qr" alt="二维码"'
      + ' style="width:145px;height:145px;display:block"></div>'
      + '<p>打开抖音 App 扫一扫</p>'
      + '<input id="dy-phone" placeholder="手机号"><button id="dy-send">获取验证码</button>'
      + '<button id="dy-submit">登录</button>';

    // 真实抖音：面板先出来，二维码要等它那轮风控挑战走完才请求回来（实测 8~12 秒），
    // 这段时间里 img 是空的。测试用 qrDelay 模拟这段空窗。
    var qimg = d.querySelector('#dy-qr');
    if (mock.qrDelay > 0) {
      setTimeout(function () {
        if (document.contains(qimg)) qimg.src = qrDataUrl();
      }, mock.qrDelay);
    } else {
      qimg.src = qrDataUrl();
    }

    d.querySelector('.close').addEventListener('click', function () { mock.close(); });
    // 「获取验证码」：真实抖音点下去先请求接口，接口回来才把按钮换成「59s」倒计时。
    // 这段时间正是用户反复连点、以为没发出去的窗口。
    var sd = d.querySelector('#dy-send');
    sd.addEventListener('click', function () { mock.requestCode(sd); });

    // 「登录」提交 → 真实抖音先请求一轮风控，几百毫秒后才弹出「身份验证」。
    // 这就是用户说的那一步：点完登录什么都不显示，要叉掉登录框才看见验证。
    var sub = d.querySelector('#dy-submit');
    sub.addEventListener('click', function () {
      mock.submitClicks++;
      if (!mock.requireVerify) return;
      setTimeout(function () { mock.showVerify(); }, mock.verifyDelay);
    });

    // 二维码只在「扫码登录」tab 下才显示（线上就是这样，切到验证码页码就没了）
    d.querySelector('.qrwrap').style.display = mock.tab === 'qr' ? '' : 'none';

    // tab 切换：真实抖音用 class 哈希，测试里按 data-tab
    var tabs = d.querySelectorAll('.tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener('click', function () {
        mock.tab = this.getAttribute('data-tab');
        for (var j = 0; j < tabs.length; j++) tabs[j].classList.toggle('on', tabs[j] === this);
        d.querySelector('h3').textContent = this.textContent;
        d.querySelector('.qrwrap').style.display = mock.tab === 'qr' ? '' : 'none';
      });
    }
    return d;
  }

  var mock = {
    openTimes: 0,
    closeTimes: 0,
    tab: 'qr',            // 当前登录方式：qr / code / pwd
    sendClicks: 0,        // 真正打到我方（抖音）的「获取验证码」请求次数
    sendMode: 'ok',       // ok=接口回来后变倒计时；fail=请求没回来（风控/失败）
    sendDelay: 700,       // 接口耗时
    countdown: 59,        // 倒计时起点（测试里调小一点无妨）
    qrDelay: 0,           // 二维码延迟多少毫秒才出现（线上实测 8~12 秒）
    // 「提交登录 → 身份验证」这一段（真机 2026-10-20）：
    //   false    = 不弹验证
    //   'layer'  = 另开一层全屏风控弹窗（z-index 只有 200，会被我们顶起的一级面板压住）
    //   'inside' = 原地把登录面板切成验证视图
    requireVerify: false,
    verifyDelay: 500,     // 抖音要先请求一轮风控，验证层不会立刻出现
    verifyText: '为保障你的账号安全，请使用抖音扫一扫完成验证',
    submitClicks: 0,
    // 抖音关弹窗的方式不一定是「移除节点」，真机上三种都见过：
    //   remove — 直接卸载（React unmount）
    //   fade   — 先淡出 300ms 再卸载
    //   hide   — 只 display:none，节点留在 DOM 里
    closeMode: 'remove',
    open: function () {
      var ex = document.getElementById('douyin-login-new-id');
      if (ex) {
        // 上次是「只隐藏不移除」关掉的：原地复活，别重复插入
        if (ex.style.display === 'none') { ex.style.display = ''; mock.openTimes++; }
        return;
      }
      mock.tab = 'qr';    // 抖音每次都从扫码页开始
      document.body.appendChild(buildPanel());
      mock.openTimes++;
    },
    close: function () {
      var d = document.getElementById('douyin-login-new-id');
      if (!d) return;
      mock.closeTimes++;
      if (mock.closeMode === 'hide') {
        d.style.display = 'none';
        return;
      }
      if (mock.closeMode === 'fade') {
        d.style.transition = 'opacity 300ms';
        d.style.opacity = '0';
        setTimeout(function () { if (d.parentNode) d.remove(); }, 300);
        return;
      }
      d.remove();
    },
    /** 点「获取验证码」→ 请求接口。ok 时过了 sendDelay 才变成倒计时。 */
    requestCode: function (btn) {
      mock.sendClicks++;
      if (mock.sendMode === 'fail') return;      // 请求石沉大海
      // 抖音网关拒了这次请求。用户真机原话就是这行英文，照着复刻：
      // 它出现在面板里，用户看不懂，而且再点几次只会更容易被按「操作频繁」。
      if (mock.sendMode === 'error504') {
        setTimeout(function () {
          var p = document.getElementById('douyin-login-new-id');
          if (!p || !document.contains(p)) return;
          var e = document.createElement('div');
          e.className = 'dy-error';
          e.style.cssText = 'margin-top:8px;color:#f5222d;font-size:12px';
          e.textContent = 'Request failed with status code 504';
          p.appendChild(e);
        }, 400);
        return;
      }
      setTimeout(function () {
        if (!document.contains(btn)) return;
        var left = mock.countdown;
        btn.textContent = left + 's';
        if (mock._cd) clearInterval(mock._cd);
        mock._cd = setInterval(function () {
          left--;
          if (left <= 0) {
            clearInterval(mock._cd);
            mock._cd = null;
            btn.textContent = '获取验证码';
            return;
          }
          btn.textContent = left + 's';
        }, 1000);
      }, mock.sendDelay);
    },
    /**
     * 弹出「身份验证」。
     * layer 模式刻意把 z-index 设成 200：线上就是这样，比我们顶起的一级面板
     * （2147483600）低得多 —— 这正是用户「点了登录什么都没发生」的物理原因。
     */
    showVerify: function () {
      mock.hideVerify();
      if (mock.requireVerify === 'inside') {
        var p = document.getElementById('douyin-login-new-id');
        if (!p) return;
        var blk = document.createElement('div');
        blk.className = 'verify-inline';
        blk.style.cssText = 'margin-top:12px;padding:10px;background:#fff7ed';
        blk.innerHTML = '<p style="margin:0 0 8px">请完成身份验证</p>'
            + '<button id="dy-verify-go">开始验证</button>';
        p.appendChild(blk);
        return;
      }
      var layer = document.createElement('div');
      layer.id = 'douyin-verify-popup';
      layer.className = 'verify-layer';
      layer.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;'
          + 'background:rgba(0,0,0,.55);z-index:200;display:flex;'
          + 'align-items:center;justify-content:center';
      if (mock.requireVerify === 'slide') {
        // 无文字滑块：线上这类挑战常常只有一个 canvas + 一条滑轨，
        // 一句提示都不给（文案由风控服务下发，有时干脆是空的）。
        layer.innerHTML = '<div class="vcard" style="width:300px;background:#fff;'
            + 'border-radius:12px;padding:16px;box-sizing:border-box">'
            + '<canvas id="dy-slide-canvas" width="268" height="130"'
            + ' style="display:block;width:268px;height:130px;background:#e5e7eb"></canvas>'
            + '<div id="dy-slide-track" style="margin-top:12px;height:36px;'
            + 'background:#f3f4f6;border-radius:8px"></div></div>';
      } else {
        layer.innerHTML = '<div class="vcard" style="width:320px;min-height:220px;'
            + 'background:#fff;border-radius:12px;padding:20px;box-sizing:border-box">'
            + '<h3 style="margin:0 0 10px">请完成身份验证</h3>'
            + '<p style="margin:0 0 18px;color:#666">' + mock.verifyText + '</p>'
            + '<button id="dy-verify-go">开始验证</button> '
            + '<button id="dy-verify-cancel">取消</button></div>';
      }
      document.body.appendChild(layer);
      var cb = layer.querySelector('#dy-verify-cancel');
      if (cb) {
        cb.addEventListener('click', function () {
          mock.verifyClosed++;
          mock.hideVerify();
        });
      }
    },
    hideVerify: function () {
      var l = document.getElementById('douyin-verify-popup');
      if (l) l.remove();
      var inl = document.querySelector('#douyin-login-new-id .verify-inline');
      if (inl) inl.remove();
    },
    verifyClosed: 0,
    // 模拟 React 重建：整棵摘掉再插一个新节点（保留同一个 id）
    rebuild: function () {
      var d = document.getElementById('douyin-login-new-id');
      if (!d) return;
      var parent = d.parentNode;
      d.remove();
      var n = buildPanel();
      // 重建后停在原来的 tab（真实抖音点输入框/切方式都会重建，状态不会丢）
      var tabs = n.querySelectorAll('.tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('on', tabs[i].getAttribute('data-tab') === mock.tab);
      }
      parent.appendChild(n);
      mock.openTimes++;
    }
  };
  window.__mock = mock;

  // 入口 = 开关：开着就关，关着就开（和线上一致，所以多点一次会把弹窗关掉）。
  // 注意要按「看不看得见」判断，不能按节点在不在 —— 只 display:none 关掉的弹窗
  // 节点还在 DOM 里，按存在判断会把「打开」误判成「关闭」。
  function panelVisible() {
    var d = document.getElementById('douyin-login-new-id');
    return !!d && getComputedStyle(d).display !== 'none';
  }
  entry.addEventListener('click', function () {
    if (panelVisible()) mock.close();
    else mock.open();
  });

  // 抖音会随手插 position:fixed 的无障碍节点（1px / 屏幕外），
  // 曾经被误判成登录弹窗，导致遮罩被设成 pointer-events:none，按钮点不动。
  setTimeout(function () {
    var a = document.createElement('div');
    a.id = 'a11y-open-btn';
    a.textContent = '无障碍按钮';
    a.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(a);
    var b = document.createElement('div');
    b.id = 'a11y-live-assertive';
    b.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;overflow:hidden';
    document.body.appendChild(b);
  }, 120);
})();
