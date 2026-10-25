/* 测试驱动：在页面里跑完整链路，结果写进 #__out（JSON）供外面解析。
   由 tools/test-login-mask.mjs 拼上 window.__inject（login_mask.js 的函数包装）后执行。 */
(function () {
  var out = document.getElementById('__out');
  var results = [];

  function check(name, ok, detail) {
    results.push({ name: name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  }
  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }
  /* 轮询直到条件成立，返回耗时 ms（超时返回 -1） */
  function wait(fn, timeout) {
    timeout = timeout || 3000;
    var t0 = performance.now();
    return new Promise(function (res) {
      (function tick() {
        var v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return res(Math.round(performance.now() - t0));
        if (performance.now() - t0 > timeout) return res(-1);
        setTimeout(tick, 25);
      })();
    });
  }
  function hit(el) {
    if (!el) return 'null';
    var r = el.getBoundingClientRect();
    var n = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return n ? (n.id || n.className || n.tagName) : 'null';
  }
  function maskState() {
    var m = mask();
    var b = m && m.querySelector('.ebbody');
    var btn = m && m.querySelector('.ebb');
    return {
      ebpopup: !!(m && m.classList.contains('ebpopup')),
      bodyDisplay: b ? getComputedStyle(b).display : 'none',
      hide: !!document.getElementById('__eb_hide'),
      btnH: btn ? Math.round(btn.getBoundingClientRect().height) : 0,
      btnText: btn ? btn.textContent : ''
    };
  }
  function popupVisible() {
    var p = popup();
    if (!p) return false;
    var r = p.getBoundingClientRect();
    return getComputedStyle(p).display !== 'none' && r.width > 0 && r.height > 0;
  }
  /** 像真人一样点弹窗右上角那个 X（带坐标，我们的 click 捕获监听要靠它） */
  function tapX() {
    var p = popup();
    if (!p) return false;
    var svg = p.querySelector('.close svg');
    if (!svg) return false;
    var r = svg.getBoundingClientRect();
    var o = { bubbles: true, cancelable: true, view: window, button: 0,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    svg.dispatchEvent(new MouseEvent('mousedown', o));
    svg.dispatchEvent(new MouseEvent('mouseup', o));
    svg.dispatchEvent(new MouseEvent('click', o));
    return true;
  }
  function mask() { return document.getElementById('__eb_mask'); }
  function popup() { return document.getElementById('douyin-login-new-id'); }

  async function main() {
    // 等 mock 把自己的定时器跑起来（a11y 节点 120ms）
    await sleep(250);

    // =========================================================== T1 基础注入
    // 注入前先把环境伪装成「手机 WebView」：UA-CH 里 mobile=true（这正是抖音
    // 撤掉「扫码登录」的依据），并记下触摸特征原值用于事后比对。
    var origMaxTouch = navigator.maxTouchPoints;
    var origHasTouch = ('ontouchstart' in window);
    try {
      Object.defineProperty(navigator, 'userAgentData', {
        get: function () { return { mobile: true, platform: 'Android', brands: [] }; },
        configurable: true
      });
    } catch (e) { /* 环境不支持就跳过，后面的断言会如实报出来 */ }

    // 0.8.8 自动链：进登录页 900ms 后自动代点登录入口，二维码就绪才弹卡片。
    // 为了让「门控」可观测，把出码延迟拉到 6 秒（线上实测 8~12 秒）——
    // 这样 T1b/T2/T2b 能检查「面板已自动打开、提示条在跳秒数、卡片还没弹」，
    // T2c 再检查「码一出来卡片自己弹」。T12c 之后会改回 0。
    window.__mock.qrDelay = 6000;

    window.__inject();
    await sleep(150);
    var m = mask(), h = document.getElementById('__eb_hide');
    check('T1 注入：遮罩 / 提示 / 隐藏规则齐全',
        !!(m && h) && document.querySelectorAll('#__eb_mask').length === 1
        && !!document.getElementById('__eb_tip'),
        '遮罩×' + document.querySelectorAll('#__eb_mask').length
        + ' 提示=' + !!document.getElementById('__eb_tip'));
    // 0.8.4：顶部「快捷登录 / 网页登录」切换条整套删除，这里反过来盯住它别再回来
    check('T1 模式切换条已经删掉（DOM 里不存在）',
        document.querySelectorAll('#__eb_switch').length === 0
        && !document.querySelector('[data-mode]'),
        '切换条×' + document.querySelectorAll('#__eb_switch').length);
    check('T1 隐藏规则把自己人排除在外',
        !!h && h.textContent.indexOf(':not(#__eb_mask)') >= 0
        && h.textContent.indexOf(':not(#__eb_tip)') >= 0,
        h ? h.textContent.slice(0, 52) + '...' : 'missing');

    // 桌面特征：抖音靠 UA-CH 的 mobile 标志决定给不给「扫码登录」。
    // 手机 WebView 即使把 UA 写成 Mac，UA-CH 里 mobile 仍是 true → 扫码门被撤掉，
    // 面板只剩验证码/密码，二维码根本不存在（用户真机就是这样）。
    var uaAfter = navigator.userAgentData;
    check('T1a UA-CH 被改成桌面（否则手机上没有扫码登录）',
        !!uaAfter && uaAfter.mobile === false && uaAfter.platform === 'macOS',
        uaAfter ? 'mobile=' + uaAfter.mobile + ' platform=' + uaAfter.platform
            : 'userAgentData 不存在');
    check('T1a 触摸特征一个都没动（动了抖音就点不开面板）',
        navigator.maxTouchPoints === origMaxTouch && ('ontouchstart' in window) === origHasTouch,
        'maxTouchPoints ' + origMaxTouch + '→' + navigator.maxTouchPoints
        + '，ontouchstart ' + origHasTouch + '→' + ('ontouchstart' in window));

    // =========================================================== T1b 闲放不能白屏
    // 真机现象（历史）：首页点「去登录抖音」→ 快捷登录页正常 → 过几秒按钮和提示全没了、
    // 一片白。怀疑常驻巡检（1.2s 一次，每 4 次做一次整页关键词扫描）把遮罩自己的
    // 文案当成了抖音弹窗，raiseNode 一跑就 mask.ebpopup + 摘掉隐藏规则 = 纯白。
    //
    // 0.8.5 起这段「放着不动」的语义变了：进了登录页 900ms 后自动开始取码
    // （用户 2026-10-24 的要求：先正在加载，码出来再进登录页）。所以再放 5.4 秒，
    // 抖音面板应该已经自己打开、引导内容收起。但「收起」必须事出有因 ——
    // 只能是真弹窗被顶起来（popup 在、z-index 被抬过、入口只点过一次），
    // 不能是关键词误判（那正是当年全白事故的根除对象）。
    await sleep(5400);
    var idle = maskState();
    var idlePopup = popup();
    check('T1b 放着不动 5.4 秒：自动链已代开抖音面板（无需用户再点）',
        idle.ebpopup === true && !!idlePopup
        && idlePopup.style.zIndex === '2147483600'
        && idlePopup.getBoundingClientRect().width > 0,
        'ebpopup=' + idle.ebpopup + ' 弹窗=' + (!!idlePopup)
        + ' z=' + (idlePopup && idlePopup.style.zIndex));
    check('T1b 引导内容收起是因为真弹窗，不是关键词误判（入口只点开过一次）',
        idle.bodyDisplay === 'none' && window.__mock.openTimes === 1,
        '.ebbody=' + idle.bodyDisplay + ' openTimes=' + window.__mock.openTimes);

    // =========================================================== T2 首次打开弹窗
    // 0.8.8 起这里不再手点：自动链在注入后 900ms 就已经代点过登录入口了。
    // 注意**不能**再点一次 .ebb —— 抖音那个入口是开关，开着的时候再点等于替用户
    // 把刚打开的面板关掉（这正是 0.8.8 自动链里 `if (active) return` 要防的事）。
    var t2 = await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    var p2 = popup();
    var r2 = p2 ? p2.getBoundingClientRect() : { width: 0, height: 0 };
    var cs2 = p2 ? getComputedStyle(p2) : {};
    check('T2 自动链命中 p 标签入口并顶起弹窗（无需用户再点红按钮）', t2 >= 0 && !!p2,
        '耗时 ' + t2 + 'ms 尺寸 ' + Math.round(r2.width) + '×' + Math.round(r2.height));
    check('T2 入口只被点开过一次（没有 toggle 成关）',
        window.__mock.openTimes === 1 && window.__mock.closeTimes === 0,
        'open=' + window.__mock.openTimes + ' close=' + window.__mock.closeTimes);
    check('T2 弹窗层规则生效（隐藏规则整条摘掉）',
        !document.getElementById('__eb_hide') && m.classList.contains('ebpopup'),
        '隐藏规则存在=' + !!document.getElementById('__eb_hide'));
    check('T2 弹窗在遮罩之上且可见',
        !!p2 && p2.style.zIndex === '2147483600' && cs2.visibility === 'visible' && r2.width > 0,
        'z=' + (p2 && p2.style.zIndex) + ' vis=' + cs2.visibility);
    check('T2 等待态收尾（按钮文案复位）', m.querySelector('.ebb').textContent === '登录抖音',
        '"' + m.querySelector('.ebb').textContent + '"');

    // =========================================================== T2b 门控等待态（0.8.8 新增）
    // 用户 2026-10-24 的原话：「先给它正在加载，如果这二维码出来的话就能进入
    // 那个登录页」。面板开着、码还没生成出来的那几秒，提示条要挑明
    // 「二维码生成中… Ns」—— 进度可见 = 程序活着；卡片先不弹。
    var tipEl = document.getElementById('__eb_tip');
    var tipOn = !!tipEl && tipEl.classList.contains('on');
    var tipBox = tipEl ? tipEl.getBoundingClientRect() : { width: 0, height: 0, top: 0, bottom: 0 };
    var pnl = popup() ? popup().getBoundingClientRect() : { top: 0 };
    var gatePill = tipEl ? tipEl.querySelector('.ebtipgate') : null;
    var gateTxt = gatePill ? gatePill.textContent : '';
    var gateVis = gatePill ? getComputedStyle(gatePill).display : 'none';
    check('T2b 等码期间提示条显示「二维码生成中… Ns」而不是空面板',
        tipOn && tipEl.classList.contains('ebgate') && gateVis !== 'none'
        && /二维码生成中… \d+s/.test(gateTxt),
        'on=' + tipOn + ' ebgate=' + (tipEl && tipEl.classList.contains('ebgate'))
        + ' 胶囊="' + gateTxt + '"');
    check('T2b 门控期间卡片先不弹（码没出来就不进登录页）',
        !document.getElementById('__eb_qr').classList.contains('on'),
        '卡片 on=' + document.getElementById('__eb_qr').classList.contains('on'));
    check('T2b 提示不盖住抖音登录框（在面板上方）',
        tipBox.width === 0 || tipBox.bottom <= pnl.top + 2,
        '提示底 ' + Math.round(tipBox.bottom) + ' / 面板顶 ' + Math.round(pnl.top));
    check('T2b 门控期间「换用验证码登录」不占位（码没好，发了也是废图）',
        getComputedStyle(tipEl.querySelector('[data-act="code"]')).display === 'none',
        'display=' + getComputedStyle(tipEl.querySelector('[data-act="code"]')).display);

    // =========================================================== T2c 码一就绪，卡片自己弹（0.8.8 核心）
    // qrDelay=6000：面板 0.9s 开，码 6.9s 才好。全程不点任何东西，
    // 卡片应该带着图自己弹出来 —— 这就是「二维码出来才进登录页」。
    var t2c = await wait(function () {
      var o = document.getElementById('__eb_qr');
      return o.classList.contains('on')
        && String(o.querySelector('.ebqimg').getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 9000);
    var qrOv2c = document.getElementById('__eb_qr');
    var hint2c = qrOv2c.querySelector('.ebqhint').textContent;
    check('T2c 二维码就绪后卡片自动弹出，且图已经在里面（不用再干等）',
        t2c >= 0, '耗时 ' + t2c + 'ms（qrDelay=6000）');
    check('T2c 卡片弹出后提示就位，门控胶囊让位',
        hint2c.indexOf('二维码已就绪') >= 0
        && !tipEl.classList.contains('ebgate'),
        '"' + hint2c + '" ebgate=' + tipEl.classList.contains('ebgate'));

    // =========================================================== T2d 验证码登录引导
    // 点的是「换用验证码登录」那颗胶囊本身。注意不能点 #__eb_tip 容器 ——
    // 真实用户点的永远是胶囊（容器只是个定位外壳），点容器拿不到 data-act，
    // 脚本会正确地什么也不做。
    var codePill = tipEl.querySelector('[data-act="code"]');
    if (codePill) codePill.click();
    await sleep(250);
    check('T2b 点一下就把面板切到「验证码登录」',
        window.__mock.tab === 'code', '当前 tab=' + window.__mock.tab);
    // 0.8.5 起这里不再「收起」：切到验证码 tab 等于走进一条大概率走不通的路，
    // 提示条要换成预防针（陌生浏览器走验证码，抖音大概率还会要人脸或扫码），
    // 并且把「发到另一台手机」留在旁边当退路。
    check('T2b 切到验证码后摆出预防针而不是直接收起',
        tipEl.classList.contains('on') && tipEl.classList.contains('ebcodewarn'),
        'on=' + tipEl.classList.contains('on') + ' ebcodewarn=' + tipEl.classList.contains('ebcodewarn'));
    check('T2b 预防针状态下「换用验证码登录」不再占位',
        getComputedStyle(tipEl.querySelector('[data-act="code"]')).display === 'none',
        'display=' + getComputedStyle(tipEl.querySelector('[data-act="code"]')).display);
    check('T2b 预防针状态下仍保留扫码退路',
        getComputedStyle(tipEl.querySelector('[data-act="qr"]')).display !== 'none',
        'display=' + getComputedStyle(tipEl.querySelector('[data-act="qr"]')).display);

    // =========================================================== T3 React 重建 / 点输入框
    window.__mock.rebuild();
    var t3 = await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 2500);
    check('T3 弹窗被 React 重建后仍被顶起', t3 >= 0, '耗时 ' + t3 + 'ms');
    var inp = document.getElementById('dy-phone');
    if (inp) {
      inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      inp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      inp.click();
      try { inp.focus(); } catch (e) { /* ignore */ }
    }
    await sleep(250);
    var p3 = popup(), r3 = p3 ? p3.getBoundingClientRect() : { width: 0 };
    check('T3 点弹窗内输入框后弹窗不消失',
        !!p3 && r3.width > 0 && !document.getElementById('__eb_hide'),
        '宽 ' + Math.round(r3.width) + 'px');

    // =========================================================== T4 点右上角 X 关闭
    var p4 = popup();
    var svg = p4 && p4.querySelector('svg');
    var target = svg;
    for (var d = 0; d < 4 && target; d++) {
      if (getComputedStyle(target).cursor === 'pointer') break;
      target = target.parentElement;
    }
    var clicked = false;
    if (target) {
      var rr = target.getBoundingClientRect();
      var o = { bubbles: true, cancelable: true, view: window, button: 0,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height / 2 };
      target.dispatchEvent(new MouseEvent('mousedown', o));
      target.dispatchEvent(new MouseEvent('mouseup', o));
      target.dispatchEvent(new MouseEvent('click', o));
      clicked = true;
    }
    var t4 = await wait(function () { return !popup() && !mask().classList.contains('ebpopup'); }, 2500);
    check('T4 点右上角 X 后弹窗关闭且按钮立即回来',
        clicked && t4 >= 0 && mask().querySelector('.ebb').textContent === '登录抖音',
        '恢复耗时 ' + t4 + 'ms（心跳兜底要 1400ms）');
    check('T4 按钮中心点确实命中按钮本身',
        String(hit(mask().querySelector('.ebb'))).indexOf('eb') >= 0,
        '命中 ' + hit(mask().querySelector('.ebb')));

    // =========================================================== T5 二次打开
    mask().querySelector('.ebb').click();
    var t5 = await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    check('T5 关掉后再点还能打开（入口是开关也要成立）', t5 >= 0, '耗时 ' + t5 + 'ms');

    // =========================================================== T5b 点 X 的另外两种关法
    // 真机现象：「点那个叉有时候没用」。抖音关弹窗不一定是移除节点 ——
    // 淡出、只 display:none 都见过。我们的顶起样式带 !important，
    // 一旦和它的隐藏打架，就会出现「弹窗又冒回来 / 按钮回不来」。
    window.__mock.closeMode = 'fade';
    var tapped = tapX();
    await sleep(900);
    var s1 = maskState();
    check('T5b 弹窗【淡出】关闭：不能被我们顶回来',
        tapped && !s1.ebpopup && s1.btnText === '登录抖音' && s1.btnH > 0 && !popupVisible(),
        'ebpopup=' + s1.ebpopup + ' 按钮="' + s1.btnText + '" 高=' + s1.btnH
        + ' 弹窗还可见=' + popupVisible());

    mask().querySelector('.ebb').click();
    await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    window.__mock.closeMode = 'hide';
    tapX();
    await sleep(2000);
    var s2 = maskState();
    check('T5b 弹窗【只 display:none】关闭：按钮要回来',
        !s2.ebpopup && s2.btnText === '登录抖音' && s2.btnH > 0 && !popupVisible(),
        'ebpopup=' + s2.ebpopup + ' 按钮="' + s2.btnText + '" 高=' + s2.btnH);
    window.__mock.closeMode = 'remove';

    // 0.8.4：原来这里有一整块 T6/T7（切「网页登录」再切回来，含弹窗归零、
    // sessionStorage 记忆、遮罩显隐恢复）。网页登录这个模式已整套删除，
    // 那 9 条断言随之作废 —— 现在不需要「切模式」，自然也不会有切模式的残留 bug。
    // 但原来正是 T7 的「切回快捷」顺手把上一轮的弹窗真关掉了，现在得自己收尾：
    // T5b 最后只是把弹窗 display:none，节点还挂着，不清掉会污染 T8 的判断。
    if (popup()) {
      window.__mock.close();
      // 主路径是 MutationObserver（移除后 140ms 就恢复引导），留点余量
      await wait(function () { return !popup(); }, 3000);
      await sleep(400);
    }

    // =========================================================== T8 a11y 节点不误判
    (function () {
      var a = document.createElement('div');
      a.id = 'a11y-live-assertive2';
      a.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px';
      document.body.appendChild(a);
    })();
    await sleep(1600);                                 // 跨过一次 1200ms 巡检
    var m8 = mask();
    // 注意：弹窗关掉后隐藏规则**故意不回落**（留在规则 B）。遮罩是不透明全屏块，
    // 页面在它下面用户看不到，回落后反而会复现「点一下弹窗就消失」。
    // 所以这里不检查 __eb_hide，只检查「没被误判成弹窗 + 引导内容回来了」。
    check('T8 a11y 悬浮节点没被当成弹窗',
        !popup() && !m8.classList.contains('ebpopup')
        && getComputedStyle(m8).pointerEvents !== 'none'
        && m8.querySelector('.ebb').getBoundingClientRect().height > 0,
        'popup=' + !!popup() + ' ebpopup=' + m8.classList.contains('ebpopup')
        + ' pointer-events=' + getComputedStyle(m8).pointerEvents);

    // =========================================================== T9 重复注入幂等
    window.__inject();
    await sleep(150);
    check('T9 重复注入幂等（不会多出第二份节点）',
        document.querySelectorAll('#__eb_mask').length === 1
        && document.querySelectorAll('#__eb_switch').length === 0
        && document.querySelectorAll('#__eb_hide').length <= 1,
        '遮罩×' + document.querySelectorAll('#__eb_mask').length
        + ' 切换条×' + document.querySelectorAll('#__eb_switch').length
        + ' 隐藏规则×' + document.querySelectorAll('#__eb_hide').length);

    // =========================================================== T10 反向缩放
    // 真实的手机场景：桌面版按 980px 排版，WebView 把它整体缩小；
    // 这里用「innerWidth 980 + screen.width 412」复现同样的比例。
    try {
      Object.defineProperty(window.screen, 'width', { get: function () { return 412; }, configurable: true });
    } catch (e) { /* ignore */ }
    window.dispatchEvent(new Event('resize'));
    await sleep(200);
    var bodyEl = document.querySelector('#__eb_mask .ebbody');
    var tf = bodyEl ? bodyEl.style.transform : '';
    var got = /scale\(([\d.]+)\)/.exec(tf);
    var k = got ? parseFloat(got[1]) : 1;
    var expect = window.innerWidth / 412;
    check('T10 桌面布局下遮罩反向放大（只放大自己，不动页面）',
        bodyEl && Math.abs(k - expect) < 0.05
        && document.documentElement.scrollWidth <= window.innerWidth + 2,
        'innerWidth=' + window.innerWidth + ' k=' + k.toFixed(2) + ' 期望 ' + expect.toFixed(2)
        + ' 页面溢出=' + (document.documentElement.scrollWidth - window.innerWidth) + 'px');

    // 提示胶囊同样要乘 k，但它是「一行文字」，980→412 时直接乘 2.38 会顶出屏宽被裁字。
    // 临时把它露出来量一下（量完立刻收起），确认它按屏宽反算过。
    var tipEl10 = document.getElementById('__eb_tip');
    tipEl10.classList.add('on');
    window.dispatchEvent(new Event('resize'));
    await sleep(150);
    var tipW = tipEl10.offsetWidth;
    var tipScale = /scale\(([\d.]+)\)/.exec(tipEl10.style.transform || '');
    var tipK = tipScale ? parseFloat(tipScale[1]) : 1;
    check('T10 提示胶囊放大后不超出屏宽（原来会被裁成半个字）',
        tipW > 0 && tipK <= k + 0.01 && tipW * tipK <= 412 * 0.95 + 1,
        '胶囊宽 ' + tipW + 'px × ' + tipK.toFixed(2) + ' = ' + Math.round(tipW * tipK)
        + 'px / 屏宽 412px（遮罩 k=' + k.toFixed(2) + '）');
    tipEl10.classList.remove('on');

    // =========================================================== T11 「获取验证码」发送中
    // 放在 T10 之后：这时 k≈2.38 已经生效，正好顺带验证盾牌的反向缩放。
    mask().querySelector('.ebb').click();
    await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    var sendOv = document.getElementById('__eb_send');
    var dySend = document.getElementById('dy-send');
    var ph = document.getElementById('dy-phone');

    function tapSend() {
      var r = dySend.getBoundingClientRect();
      var o = { bubbles: true, cancelable: true, view: window, button: 0,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      dySend.dispatchEvent(new MouseEvent('mousedown', o));
      dySend.dispatchEvent(new MouseEvent('mouseup', o));
      dySend.dispatchEvent(new MouseEvent('click', o));
      return o;
    }
    function resetSend(text) {
      if (window.__mock._cd) { clearInterval(window.__mock._cd); window.__mock._cd = null; }
      dySend.textContent = text || '获取验证码';
    }

    // 1) 手机号空着：不该接管，点击照常交给抖音（由它自己弹「请输入手机号」）
    window.__mock.sendMode = 'fail';
    window.__mock.sendClicks = 0;
    ph.value = '';
    tapSend();
    await sleep(200);
    check('T11 手机号没填：不接管，照常交给抖音自己提示',
        sendOv && !sendOv.classList.contains('on') && window.__mock.sendClicks === 1,
        '盾牌 on=' + (sendOv && sendOv.classList.contains('on'))
        + ' 抖音收到=' + window.__mock.sendClicks + ' 次');

    // 2) 填了手机号：点一下立刻进入「发送中」，并且严丝合缝贴在按钮上
    resetSend();
    ph.value = '13800138000';
    window.__mock.sendMode = 'ok';
    window.__mock.sendClicks = 0;
    window.__mock.sendDelay = 1200;          // 接口慢一点，留出观察窗口
    tapSend();
    await sleep(200);
    var shown = sendOv.classList.contains('on');
    var box = sendOv.getBoundingClientRect();
    var bbox = dySend.getBoundingClientRect();
    var center = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    check('T11 点「获取验证码」立刻出现发送中',
        shown && sendOv.textContent.indexOf('发送中') >= 0,
        'on=' + shown + ' 文案="' + sendOv.textContent.replace(/\s+/g, ' ').trim() + '"');
    check('T11 盾牌反向缩放后正好盖住按钮',
        Math.abs(box.left - bbox.left) < 3 && Math.abs(box.top - bbox.top) < 3
        && Math.abs(box.width - bbox.width) < 3 && Math.abs(box.height - bbox.height) < 3,
        '盾 ' + Math.round(box.width) + '×' + Math.round(box.height) + '@' + Math.round(box.left)
        + ' / 按钮 ' + Math.round(bbox.width) + '×' + Math.round(bbox.height) + '@' + Math.round(bbox.left));
    check('T11 盾牌挡在按钮上层（连点落不到抖音那边）',
        !!center && (center === sendOv || sendOv.contains(center)),
        '命中 ' + (center ? (center.id || center.className || center.tagName) : 'null'));

    // 3) 连点两下：抖音只该收到一次请求
    tapSend(); tapSend();
    await sleep(200);
    check('T11 连点被吃掉：抖音只收到 1 次请求',
        window.__mock.sendClicks === 1, '抖音收到=' + window.__mock.sendClicks + ' 次');

    // 4) 抖音一变成倒计时，盾牌立刻撤掉，把倒计时露给用户
    var t11 = await wait(function () { return !sendOv.classList.contains('on'); }, 4000);
    check('T11 抖音出现倒计时后自动撤掉盾牌',
        t11 >= 0 && /\d+s/.test(dySend.textContent),
        '撤掉耗时 ' + t11 + 'ms 按钮文案="' + dySend.textContent + '"');

    // 5) 请求石沉大海：6 秒后要明确说「发送超时」，再放开让用户重试
    resetSend();
    window.__mock.sendMode = 'fail';
    window.__mock.sendClicks = 0;
    tapSend();
    await sleep(200);
    var t12 = await wait(function () { return sendOv.classList.contains('ebwarn'); }, 9000);
    check('T11 请求没回来：6 秒后变「发送超时」，不是一直转圈',
        t12 >= 0 && sendOv.textContent.indexOf('发送超时') >= 0,
        '耗时 ' + t12 + 'ms 文案="' + sendOv.textContent.replace(/\s+/g, ' ').trim() + '"');
    var t13 = await wait(function () { return !sendOv.classList.contains('on'); }, 4000);
    check('T11 超时之后放开按钮，用户可以再点一次',
        t13 >= 0 && !!dySend && !sendOv.classList.contains('on'), '放开耗时 ' + t13 + 'ms');
    window.__mock.sendMode = 'ok';

    // =========================================================== T12 扫码：取码 → 放大给另一台手机扫
    // 真机背景（2026-10-20 用户实测）：登录码只能实时扫，相册导入会被抖音拒；
    // 但「另一台手机对着本机屏幕扫」可以成功 → 卡片必须能放大。
    var qrOv = document.getElementById('__eb_qr');
    var qrImgEl = qrOv.querySelector('.ebqimg');
    var qrHintEl = qrOv.querySelector('.ebqhint');

    // 先把面板切到「验证码登录」：这时二维码是隐藏的，看我们会不会自己切回去
    var codeTab = null;
    Array.prototype.forEach.call(popup().querySelectorAll('.tab'), function (t) {
      if (t.textContent === '验证码登录') codeTab = t;
    });
    if (codeTab) codeTab.click();
    await sleep(150);
    var hiddenW = document.getElementById('dy-qr').getBoundingClientRect().width;
    check('T12 前置：面板停在验证码页，二维码不可见', !!codeTab && hiddenW === 0,
        '二维码宽度=' + Math.round(hiddenW));

    document.querySelector('#__eb_tip .ebtipb[data-act="qr"]').click();
    var t12a = await wait(function () { return qrOv.classList.contains('on'); }, 1500);
    var t12b = await wait(function () {
      return String(qrImgEl.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 4000);
    check('T12 点提示条上的「发到另一台手机」弹出二维码卡片',
        t12a >= 0 && qrOv.classList.contains('on'), '耗时 ' + t12a + 'ms');
    check('T12 自动切回扫码页并取到二维码（已转成 png）',
        window.__mock.tab === 'qr' && t12b >= 0,
        'tab=' + window.__mock.tab + ' 耗时 ' + t12b + 'ms src='
        + String(qrImgEl.getAttribute('src')).slice(0, 22));

    var cardEl = qrOv.querySelector('.ebqcard');
    var cbx = cardEl.getBoundingClientRect();
    var swPx = (window.screen && window.screen.width) || window.innerWidth;
    // 0.8.2 起不再死乘 calcK：360px 卡片乘 2.38 会到 850px，一大半在屏外。
    // 现在按「屏宽 94%」收敛 —— 既铺满又不溢出。
    check('T12 卡片按屏宽收敛，不溢出、也留出边距',
        cbx.width <= swPx + 1 && cbx.width >= swPx * 0.72
        && Math.abs((cbx.left + cbx.right) / 2 - window.innerWidth / 2) < 6,
        '卡片 ' + Math.round(cbx.width) + 'px / 屏宽 ' + swPx + 'px 中线 '
        + Math.round((cbx.left + cbx.right) / 2) + '/' + window.innerWidth);

    // 0.8.3 起默认**不**放大：主路径变成「把码发到另一台手机」，
    // 那台手机收到的是原图，本机屏幕上这张大不大无所谓；反而是步骤教程要看得到。
    var stepEl = qrOv.querySelector('.ebqstep');
    var shareBtn = qrOv.querySelector('.ebqshare');
    var wSmall = qrImgEl.getBoundingClientRect().width;
    check('T12 打开时是「发到另一台手机」视图：步骤教程可见、未放大',
        !qrOv.classList.contains('ebqbig') && getComputedStyle(stepEl).display !== 'none',
        'big=' + qrOv.classList.contains('ebqbig')
        + ' 步骤=' + getComputedStyle(stepEl).display);
    check('T12 卡片上有「发到另一台手机」按钮，且不再有「放大二维码」按钮',
        !!shareBtn && shareBtn.textContent === '发到另一台手机'
        && !qrOv.querySelector('.ebqbigbtn'),
        '按钮=' + (shareBtn ? shareBtn.textContent : '(没有)'));
    check('T12 教程文案讲的是「发到另一台手机 → 本机抖音扫」',
        stepEl.textContent.indexOf('发到另一台手机') >= 0
        && stepEl.textContent.indexOf('打开抖音') >= 0
        && stepEl.textContent.indexOf('不用装抖音') >= 0,
        stepEl.textContent.replace(/\s+/g, ' ').slice(0, 60));
    // 0.8.8：用户明确要求把「另一台手机对着本机屏幕拍一张照」也写进教程 ——
    // 他实测过这条路能成（摄像头实时看到码即可），比只写分享多一条出路。
    check('T12 教程包含「拍照扫描」备选（对着本机屏幕拍一张照）',
        stepEl.textContent.indexOf('拍一张照') >= 0
        || stepEl.textContent.indexOf('拍一张') >= 0,
        stepEl.textContent.replace(/\s+/g, ' ').slice(0, 90));

    // ---- T12e 抖音刷新二维码：自动换图 + 一键重新发（0.8.8）
    // 真机反馈（2026-10-24）：「点发送到另一台手机，它提示抖音刷新的二维码，
    // 请重新保存。重新保存的话，你应该要整一个东西刷新一下」——
    // 早期实现只在同步回调里 setHint，还被 applyQr 的异步回调覆盖，
    // 用户对着一张自动换好的图完全不知道下一步点什么。
    var dyQr = document.getElementById('dy-qr');
    var srcBefore = qrImgEl.getAttribute('src');
    // 换一张明显不同的 data 图，模拟抖音下发新码
    dyQr.src = 'data:image/svg+xml;base64,' + btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168">'
        + '<rect width="100%" height="100%" fill="#fff"/>'
        + '<g fill="#0a0"><rect width="84" height="84"/><rect x="84" y="84" width="84" height="84"/></g></svg>');
    var t12e = await wait(function () {
      return qrImgEl.getAttribute('src') !== srcBefore
        && String(qrImgEl.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 4000);
    check('T12e 抖音刷新二维码：卡片里的图自动换成新码', t12e >= 0,
        '耗时 ' + t12e + 'ms');
    check('T12e 还没发过：提示说明「已自动更新」，不弹重发按钮',
        qrHintEl.textContent.indexOf('自动更新') >= 0
        && shareBtn.textContent === '发到另一台手机'
        && !shareBtn.classList.contains('ebqagain'),
        '提示="' + qrHintEl.textContent + '" 按钮="' + shareBtn.textContent + '"');
    // 发出去过一次之后，抖音再刷新 → 必须给一个能点的「重新发到另一台手机」
    window.__ebQrShareResult(true, '');
    var srcBefore2 = qrImgEl.getAttribute('src');
    dyQr.src = 'data:image/svg+xml;base64,' + btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="168" height="168">'
        + '<rect width="100%" height="100%" fill="#fff"/>'
        + '<g fill="#00a"><circle cx="84" cy="84" r="70"/></g></svg>');
    var t12f = await wait(function () {
      return qrImgEl.getAttribute('src') !== srcBefore2
        && shareBtn.textContent === '重新发到另一台手机';
    }, 4000);
    check('T12e 发过之后又刷新：按钮变成脉动的「重新发到另一台手机」',
        t12f >= 0 && shareBtn.classList.contains('ebqagain'),
        '耗时 ' + t12f + 'ms 按钮="' + shareBtn.textContent + '"');
    check('T12e 提示说清楚下一步点什么（不是一句「请重新保存」）',
        qrHintEl.textContent.indexOf('重新发') >= 0,
        '"' + qrHintEl.textContent + '"');
    // 重发成功后按钮恢复原状
    window.__ebQrShareResult(true, '');
    await sleep(100);
    check('T12e 重新发成功后按钮恢复「发到另一台手机」',
        shareBtn.textContent === '发到另一台手机'
        && !shareBtn.classList.contains('ebqagain'),
        '按钮="' + shareBtn.textContent + '"');

    qrImgEl.click();
    await sleep(180);
    var wBig = qrImgEl.getBoundingClientRect().width;
    check('T12 点二维码图片可以放大，步骤文字收起',
        qrOv.classList.contains('ebqbig') && wBig > wSmall * 1.3
        && getComputedStyle(stepEl).display === 'none',
        Math.round(wSmall) + 'px → ' + Math.round(wBig) + 'px');
    check('T12 放大态整张卡片不超出屏宽',
        cardEl.getBoundingClientRect().width <= swPx + 1,
        Math.round(cardEl.getBoundingClientRect().width) + 'px / 屏宽 ' + swPx + 'px');

    qrImgEl.click();
    await sleep(180);
    check('T12 再点图片缩回去，步骤文字回来',
        !qrOv.classList.contains('ebqbig')
        && Math.abs(qrImgEl.getBoundingClientRect().width - wSmall) < 2
        && getComputedStyle(stepEl).display !== 'none',
        Math.round(qrImgEl.getBoundingClientRect().width) + 'px vs ' + Math.round(wSmall) + 'px');

    qrOv.querySelector('.ebqclose').click();
    await sleep(120);
    check('T12 关闭卡片', !qrOv.classList.contains('on'));

    // ---- T12c 抖音的二维码不是跟面板一起出来的
    // 真机实测：面板开出来后还要再等 8~12 秒（它先走一轮风控挑战才去取码）。
    // 原实现 150ms × 24 ≈ 3.6 秒就放弃 —— 用户看到的就是「没找到二维码」，
    // 其实码马上就有了。这里把空窗拉到 9 秒，验证我们会一直等、且不误报失败。
    window.__mock.qrDelay = 9000;
    window.__mock.close();
    await sleep(300);
    window.__mock.open();
    await sleep(250);
    document.querySelector('#__eb_tip .ebtipb[data-act="qr"]').click();
    await sleep(1500);
    check('T12c 二维码没出来时先等着，不误报「没找到」',
        qrOv.classList.contains('on')
        && qrHintEl.textContent.indexOf('没找到') < 0
        && qrHintEl.textContent.indexOf('没等到') < 0,
        '"' + qrHintEl.textContent + '"');
    var t12c = await wait(function () {
      return String(qrImgEl.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 14000);
    check('T12c 二维码 9 秒后才出现，仍然取到了',
        t12c >= 0, '耗时 ' + t12c + 'ms');
    window.__mock.qrDelay = 0;
    qrOv.querySelector('.ebqclose').click();
    await sleep(120);

    // ---- T12d 预抓：面板一顶起来就在后台找码
    // 真机上码要 8~12 秒才渲染，等用户点开卡片再找 = 让人对着「正在获取…」干等。
    // 预期：面板开 2 秒后点开卡片，应该在几百毫秒内就出图。
    window.__mock.close();
    await sleep(300);
    window.__mock.open();
    await sleep(2000);          // 巡检顶起弹窗（700ms）+ 预抓跑一轮（700ms）
    document.querySelector('#__eb_tip .ebtipb[data-act="qr"]').click();
    var t12d = await wait(function () {
      return String(qrImgEl.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 3000);
    check('T12d 预抓过码，点开卡片几乎立刻出图',
        t12d >= 0 && t12d < 900, '耗时 ' + t12d + 'ms');
    if (qrOv.classList.contains('on')) qrOv.querySelector('.ebqclose').click();
    await sleep(120);

    // =========================================================== T13 提交登录 → 身份验证
    // 真机现象（2026-10-20 用户）：「验证码登录点登录按钮之后，你就不给我提示了，
    // 我还要把这个弹窗叉掉才知道原来要身份验证」。
    // 原因：抖音的风控弹窗是**另开一层**，z-index 只有几百，而我们把一级登录面板
    // 顶到了 2147483600 —— 验证层被死死压在下面，用户点什么都没反应。
    window.__mock.requireVerify = 'layer';
    window.__mock.verifyDelay = 500;
    window.__mock.verifyText = '为保障你的账号安全，请使用抖音扫一扫完成验证';
    if (popupVisible()) { window.__mock.close(); await sleep(400); }
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    var subBtn = document.getElementById('dy-submit');
    if (subBtn) subBtn.click();
    var t13 = await wait(function () {
      var v = document.getElementById('douyin-verify-popup');
      return v && v.style.zIndex === '2147483646';
    }, 3000);
    var vEl = document.getElementById('douyin-verify-popup');
    var vr = vEl ? vEl.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var vCenter = vEl
        ? document.elementFromPoint(vr.left + vr.width / 2, vr.top + vr.height / 2) : null;
    check('T13 点「登录」后抖音弹身份验证，并被我们顶到最前',
        t13 >= 0 && !!vEl && getComputedStyle(vEl).visibility === 'visible' && vr.width > 0,
        '耗时 ' + t13 + 'ms z=' + (vEl && vEl.style.zIndex)
        + ' 尺寸 ' + Math.round(vr.width) + '×' + Math.round(vr.height));
    check('T13 验证层压在登录面板之上（不是被压住）',
        !!vEl && parseInt(vEl.style.zIndex, 10) > parseInt(popup() ? popup().style.zIndex : '0', 10),
        '验证 z=' + (vEl && vEl.style.zIndex) + ' 面板 z=' + (popup() && popup().style.zIndex));
    check('T13 验证框中心点命中它自己（用户点得到）',
        !!vCenter && !!vEl && vEl.contains(vCenter),
        '命中 ' + (vCenter ? (vCenter.id || vCenter.className || vCenter.tagName) : 'null'));

    var tipEl13 = document.getElementById('__eb_tip');
    var warn13 = tipEl13.querySelector('.ebtipwarn');
    check('T13 顶部给出「抖音要求验证」提示（不再是无声无息）',
        tipEl13.classList.contains('ebverify') && tipEl13.classList.contains('on')
        && getComputedStyle(warn13).display !== 'none'
        && (warn13.textContent || '').indexOf('抖音要求') >= 0,
        '"' + warn13.textContent + '" display=' + getComputedStyle(warn13).display);
    check('T13 警告态下不再显示「换用验证码登录」',
        getComputedStyle(tipEl13.querySelector('.ebtipb[data-act="code"]')).display === 'none',
        'display=' + getComputedStyle(tipEl13.querySelector('.ebtipb[data-act="code"]')).display);

    // 真实抖音点完登录会把一级面板卸载，只留验证层。
    // 这时候绝不能因为「面板没了」就把遮罩的引导内容放回来 ——
    // 遮罩是不透明的全屏块，会把验证框盖得严严实实（用户看到的又是一片白）。
    var pn13 = popup();
    if (pn13) pn13.remove();
    await sleep(800);
    var m13 = mask();
    var stillV = document.getElementById('douyin-verify-popup');
    check('T13 登录面板卸载后：遮罩不许盖住验证框',
        m13.classList.contains('ebpopup')
        && getComputedStyle(m13.querySelector('.ebbody')).display === 'none'
        && !!stillV && stillV.style.zIndex === '2147483646',
        'ebpopup=' + m13.classList.contains('ebpopup')
        + ' 引导=' + getComputedStyle(m13.querySelector('.ebbody')).display
        + ' 验证层 z=' + (stillV ? stillV.style.zIndex : 'null'));
    var vr2 = stillV ? stillV.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var hit13 = document.elementFromPoint(vr2.left + vr2.width / 2, vr2.top + vr2.height / 2);
    check('T13 面板卸载后验证框依然点得到（命中的不是遮罩）',
        !!hit13 && !!stillV && stillV.contains(hit13),
        '命中 ' + (hit13 ? (hit13.id || hit13.className || hit13.tagName) : 'null'));

    // 用户把验证取消掉：提示收起、登录按钮回来，能重新走一遍
    var cancelBtn = document.getElementById('dy-verify-cancel');
    if (cancelBtn) cancelBtn.click();
    var t13b = await wait(function () {
      return !document.getElementById('douyin-verify-popup')
        && !mask().classList.contains('ebpopup')
        && mask().querySelector('.ebb').textContent === '登录抖音';
    }, 4000);
    check('T13 验证结束后提示收起、登录按钮回来', t13b >= 0, '恢复耗时 ' + t13b + 'ms');
    check('T13 警告胶囊一起收起',
        !document.getElementById('__eb_tip').classList.contains('ebverify'));

    // ---- T13c 验证视图长在面板内部（原地切换，不另开层）
    window.__mock.requireVerify = 'inside';
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    var sub13c = document.getElementById('dy-submit');
    if (sub13c) sub13c.click();
    var t13c = await wait(function () {
      return !!document.querySelector('#douyin-login-new-id .verify-inline')
        && document.getElementById('__eb_tip').classList.contains('ebverify');
    }, 3000);
    check('T13 面板内原地切成验证视图也能认出来（并给提示）',
        t13c >= 0 && !!popup() && popup().style.zIndex === '2147483600',
        '耗时 ' + t13c + 'ms 面板 z=' + (popup() && popup().style.zIndex));

    window.__mock.requireVerify = false;
    window.__mock.hideVerify();
    await sleep(150);

    // =========================================================== T14 滑块 / 拼图（动态校验）
    // 真机现象（2026-10-20 用户）：「他有时候要你拖一下那个什么码，动态校验码，
    // 判断你是不是真人。这弹窗也要给它显示出来。」
    // 这类弹窗经常**一个字都没有** —— 只有一张 canvas + 一条滑轨，
    // 所以除了文案，还要能靠「形状」认出来（findChallengeByShape）。
    window.__mock.requireVerify = 'slide';
    window.__mock.verifyDelay = 400;
    if (popupVisible()) { window.__mock.close(); await sleep(400); }
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    var sub14 = document.getElementById('dy-submit');
    if (sub14) sub14.click();
    var t14 = await wait(function () {
      var v = document.getElementById('douyin-verify-popup');
      return v && v.style.zIndex === '2147483646';
    }, 4000);
    var tipEl14 = document.getElementById('__eb_tip');
    var warn14 = tipEl14.querySelector('.ebtipwarn');
    check('T14 无文字的滑块弹窗（只有 canvas）也能认出来并顶到最前',
        t14 >= 0 && tipEl14.classList.contains('ebverify')
        && (warn14.textContent || '').indexOf('拖动') >= 0,
        '耗时 ' + t14 + 'ms 提示="' + warn14.textContent + '"');

    var cv = document.getElementById('dy-slide-canvas');
    var cr = cv ? cv.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    var cvHit = cv ? document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2) : null;
    check('T14 滑块画布点得到（没被遮罩或提示条盖住）',
        !!cvHit && (cvHit === cv || (cv.contains && cv.contains(cvHit))),
        '命中 ' + (cvHit ? (cvHit.id || cvHit.tagName) : 'null') + ' 画布 '
        + Math.round(cr.width) + '×' + Math.round(cr.height));

    // 滑块是用户**自己能拖过去**的验证。人脸 / 扫码那两类才会自动把二维码摆出来
    // （见 T18），滑块不行 —— 二维码卡片是全屏的（z 2147483647），
    // 盖上去就等于把人家能过的验证给挡了。等 2 秒确认它没有自己弹出来。
    await sleep(2000);
    check('T14 滑块验证不会自动盖上二维码卡片（用户自己能拖过去）',
        !document.getElementById('__eb_qr').classList.contains('on'),
        'on=' + document.getElementById('__eb_qr').classList.contains('on'));

    // 验证取消 / 面板关掉 → 回到「登录抖音」按钮。
    // 注意要**连面板一起关**：只关验证层的话，一级面板还开着，
    // 遮罩本来就该留在弹窗层（这是正确行为，不是 bug）。
    window.__mock.hideVerify();
    window.__mock.close();
    var t14b = await wait(function () {
      return !mask().classList.contains('ebpopup')
        && mask().querySelector('.ebb').textContent === '登录抖音';
    }, 4000);
    check('T14 滑块关掉后恢复登录按钮', t14b >= 0, '恢复耗时 ' + t14b + 'ms');

    // 带文字的滑块：「拖动滑块完成拼图」要归到「拖动验证」，不能说成「身份验证」
    window.__mock.requireVerify = 'layer';
    window.__mock.verifyText = '拖动滑块完成拼图，证明你不是机器人';
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    var sub14c = document.getElementById('dy-submit');
    if (sub14c) sub14c.click();
    var t14c = await wait(function () {
      var v = document.getElementById('douyin-verify-popup');
      return v && v.style.zIndex === '2147483646';
    }, 3000);
    check('T14 带文字的滑块识别成「拖动验证」（不是「身份验证」）',
        t14c >= 0 && (warn14.textContent || '') === '抖音要求拖动验证',
        '"' + warn14.textContent + '"');

    // 负例：窗口期内冒出一个普通文字浮层，不能把它当成验证层顶起来
    // （否则遮罩再也回不去，用户被困在这个浮层上）
    window.__mock.hideVerify();
    await wait(function () { return !document.getElementById('__eb_tip').classList.contains('ebverify'); }, 3000);
    var phone14 = document.getElementById('dy-phone');
    if (phone14) phone14.click();          // 重新打开 8 秒形状识别窗口
    var decoy = document.createElement('div');
    decoy.id = 'dy-decoy';
    decoy.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;'
        + 'background:rgba(0,0,0,.4);z-index:300';
    decoy.textContent = '下载抖音 App，查看更多内容';
    document.body.appendChild(decoy);
    await sleep(1300);
    check('T14 没有图形特征的普通浮层不会被误当成验证弹窗',
        decoy.style.zIndex !== '2147483646'
        && !document.getElementById('__eb_tip').classList.contains('ebverify'),
        'decoy z=' + (decoy.style.zIndex || '(未改)'));
    decoy.remove();

    // ---- T14e 老容器「藏着 → 显示」也要认
    // 有的版本在页面加载时就把风控容器（滑块 / iframe 验证页）挂好、藏着，
    // 用到时才 display 出来。只认「新节点」的话这种永远看不见。
    window.__mock.close();
    await sleep(400);
    var lazy = document.createElement('div');
    lazy.id = 'dy-lazy-verify';
    lazy.style.cssText = 'position:fixed;left:0;top:0;width:100%;height:100%;'
        + 'background:rgba(0,0,0,.5);z-index:210;display:none';
    lazy.innerHTML = '<div style="width:300px;margin:18% auto;background:#fff;padding:16px">'
        + '<canvas width="260" height="120"></canvas></div>';
    document.body.appendChild(lazy);          // 先藏着：会话快照会把它记成「当时不可见」
    mask().querySelector('.ebb').click();
    await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    lazy.style.display = 'flex';             // 抖音这时候才把它显示出来
    var ph14e = document.getElementById('dy-phone');
    if (ph14e) ph14e.click();
    var t14e = await wait(function () { return lazy.style.zIndex === '2147483646'; }, 4000);
    check('T14 预先挂好、后来才显示的验证容器也能认出来',
        t14e >= 0, '耗时 ' + t14e + 'ms z=' + (lazy.style.zIndex || '(未改)'));
    window.__mock.hideVerify();
    window.__mock.close();
    lazy.remove();
    await sleep(200);

    // ===================================================== T15 打开登录框 → 自动扫码
    // 用户拍板：扫码是唯一能过风控的路，那就别让人自己去找入口。
    // 0.8.3 起卡片默认停在「发到另一台手机」视图（教程可见），不再默认放大。
    window.__mock.requireVerify = false;
    window.__mock.sendMode = 'ok';
    window.__mock.qrDelay = 0;
    window.__mock.hideVerify();
    await sleep(250);

    var qrOv15 = document.getElementById('__eb_qr');
    if (qrOv15.classList.contains('on')) {
      qrOv15.querySelector('.ebqclose').click();
      await sleep(220);
    }
    var qrIdle = !qrOv15.classList.contains('on');
    mask().querySelector('.ebb').click();
    // 全程不点提示条、不点「发到另一台手机」，看它自己会不会开
    var t15 = await wait(function () {
      return qrOv15.classList.contains('on');
    }, 8000);
    check('T15 点「登录抖音」后不用点任何提示，二维码自动弹出',
        qrIdle && t15 >= 0, '耗时 ' + t15 + 'ms');
    check('T15 自动弹出时直接显示教程步骤（不是放大态）',
        !qrOv15.classList.contains('ebqbig')
        && getComputedStyle(qrOv15.querySelector('.ebqstep')).display !== 'none',
        'big=' + qrOv15.classList.contains('ebqbig'));
    var qrSrc15 = qrOv15.querySelector('.ebqimg').getAttribute('src') || '';
    check('T15 自动弹出的卡片里已经有码',
        qrSrc15.indexOf('data:image/png') === 0, 'src=' + qrSrc15.slice(0, 22));

    // 关掉卡片 → 提示条必须回来，否则用户想改用验证码就没入口了
    qrOv15.querySelector('.ebqclose').click();
    await sleep(240);
    var tip15 = document.getElementById('__eb_tip');
    check('T15 关掉二维码后提示条回来（还能切验证码）',
        !qrOv15.classList.contains('on') && tip15.classList.contains('on'),
        'tip on=' + tip15.classList.contains('on'));

    // ===================================================== T16 验证码被抖音拒（504）
    // 真机原话：Request failed with status code 504。用户看不懂，而且越点越容易被限流。
    window.__mock.sendMode = 'error504';
    var codeTab16 = null;
    Array.prototype.forEach.call(popup().querySelectorAll('.tab'), function (t) {
      if (t.textContent === '验证码登录') codeTab16 = t;
    });
    if (codeTab16) codeTab16.click();
    await sleep(220);
    var ph16 = document.getElementById('dy-phone');
    if (ph16) {
      ph16.value = '13800000000';
      ph16.dispatchEvent(new Event('input', { bubbles: true }));
    }
    await sleep(180);
    var sendBtn16 = document.getElementById('dy-send');
    if (sendBtn16) sendBtn16.click();
    var t16 = await wait(function () {
      return document.getElementById('__eb_tip').classList.contains('ebcodefail');
    }, 6000);
    check('T16 面板出现 504 时，提示条翻译成中文并引导扫码',
        t16 >= 0, '耗时 ' + t16 + 'ms');
    var warn16 = (document.querySelector('#__eb_tip .ebtipwarn') || {}).textContent || '';
    check('T16 文案说清「抖音拒绝、改用扫码」，不再甩英文',
        /扫码/.test(warn16) && !/504|status code|request failed/i.test(warn16),
        '"' + warn16 + '"');
    var t16b = await wait(function () {
      return document.getElementById('__eb_qr').classList.contains('on');
    }, 5000);
    check('T16 随后自动把二维码摆出来', t16b >= 0, '耗时 ' + t16b + 'ms');

    // ===================================================== T17 「发到另一台手机」
    // 用户定的最终流程：把码发到另一台手机（微信/QQ/系统分享）→ 那台手机显示 →
    // **本机抖音**扫那一块屏幕。另一台手机只是显示器，不用装抖音、不用登录。
    // 所以卡片主按钮必须是系统分享，而不是"存相册"（相册选图会被抖音拒）。
    window.EBQr = {
      lastShare: '',
      lastSave: 0,
      share: function (p) {
        window.EBQr.lastShare = String(p || '');
        setTimeout(function () { window.__ebQrShareResult(true, '已发出'); }, 30);
      },
      save: function () { window.EBQr.lastSave++; }
    };
    document.querySelector('#__eb_tip .ebtipb[data-act="qr"]').click();
    var t17 = await wait(function () {
      var im = document.querySelector('#__eb_qr .ebqimg');
      return document.getElementById('__eb_qr').classList.contains('on')
        && String(im && im.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 6000);
    var shBtn = document.querySelector('#__eb_qr .ebqshare');
    check('T17 卡片主按钮是「发到另一台手机」',
        t17 >= 0 && !!shBtn && shBtn.textContent === '发到另一台手机',
        '按钮=' + (shBtn ? shBtn.textContent : '(没有)'));

    shBtn.click();
    var t17b = await wait(function () {
      var h = document.querySelector('#__eb_qr .ebqhint');
      return h && h.textContent.indexOf('已发出') >= 0;
    }, 3000);
    check('T17 点按钮把二维码 base64 交给原生分享',
        window.EBQr.lastShare.indexOf('data:image/png') === 0,
        'payload=' + window.EBQr.lastShare.slice(0, 22));
    var hint17 = (document.querySelector('#__eb_qr .ebqhint') || {}).textContent || '';
    check('T17 分享后提示改成「在另一台手机打开这张图，再用本机抖音扫它」',
        t17b >= 0 && hint17.indexOf('另一台手机') >= 0
        && hint17.indexOf('本机抖音') >= 0,
        '"' + hint17 + '"');
    check('T17 不再走「存相册」这条路',
        window.EBQr.lastSave === 0 && !document.querySelector('#__eb_qr .ebqsave'),
        'save 调用=' + window.EBQr.lastSave);

    document.getElementById('__eb_qr').querySelector('.ebqclose').click();
    await sleep(180);

    // ===================================================== T18 人脸/扫码验证 → 自动摆出二维码
    // 用户 2026-10-21 确认：验证码登录最后那人脸 / 扫码，他试过、卡住、过不去。
    // 所以这两类验证层一冒出来基本等于「此路不通」—— 用户已经花了手机号 +
    // 60 秒倒计时的成本，退路要直接递到手上，不能再让他点一次「发到另一台手机」。
    //
    // 只对人脸 / 扫码自动开；滑块和拼图用户自己能拖过去，盖卡片会把人能过的验证挡了
    // （这条在 T14 里用负例盯）。
    window.__mock.requireVerify = 'layer';
    window.__mock.verifyDelay = 400;
    window.__mock.verifyText = '为保障账号安全，请完成人脸识别';
    if (popupVisible()) { window.__mock.close(); await sleep(500); }
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    // 等自动出码那一轮跑完，再按用户会做的事把它关掉（他要去试验证码）
    var t18a = await wait(function () {
      return document.getElementById('__eb_qr').classList.contains('on');
    }, 5000);
    if (t18a >= 0) {
      document.getElementById('__eb_qr').querySelector('.ebqclose').click();
      await sleep(200);
    }
    check('T18 准备：登录框起来后二维码自动出现过', t18a >= 0, '耗时 ' + t18a + 'ms');

    var sub18 = document.getElementById('dy-submit');
    if (sub18) sub18.click();
    var t18 = await wait(function () {
      return document.getElementById('__eb_qr').classList.contains('on');
    }, 5000);
    var warn18 = document.querySelector('#__eb_tip .ebtipwarn');
    check('T18 人脸验证一出现，二维码卡片自动打开（不用再点一次）', t18 >= 0, '耗时 ' + t18 + 'ms'
        + ' dbg=' + JSON.stringify(window.__ebDbg || {}));
    check('T18 提示条说明是「抖音要求人脸识别」',
        !!warn18 && (warn18.textContent || '').indexOf('人脸') >= 0,
        '"' + (warn18 ? warn18.textContent : '') + '"');

    // 关掉之后不许因为验证层还在就再弹一次（那等于跟用户抢界面）
    document.getElementById('__eb_qr').querySelector('.ebqclose').click();
    await sleep(2000);
    check('T18 用户再次关掉卡片后，验证层还在也不会再弹回来',
        !document.getElementById('__eb_qr').classList.contains('on'),
        'on=' + document.getElementById('__eb_qr').classList.contains('on'));

    window.__mock.requireVerify = false;
    window.__mock.hideVerify();
    await sleep(300);

    // ===================================================== T19 在面板里直接切「验证码登录」
    // 不是所有人都先点我们的提示条 —— 有人就是自己去面板上点那几个小 tab。
    // 那条路径同样要给预防针：陌生浏览器走验证码，抖音大概率还会要人脸或扫码。
    if (popupVisible()) { window.__mock.close(); await sleep(500); }
    if (!popupVisible()) {
      mask().querySelector('.ebb').click();
      await wait(function () { return popup() && popup().style.zIndex === '2147483600'; }, 3000);
    }
    var codeTab = popup().querySelector('.tab[data-tab="code"]');
    if (codeTab) codeTab.click();
    await sleep(300);
    var tip19 = document.getElementById('__eb_tip');
    var warn19 = tip19.querySelector('.ebtipwarn');
    check('T19 在抖音面板里直接切验证码 tab，也会摆出预防针',
        tip19.classList.contains('ebcodewarn') && tip19.classList.contains('on'),
        'on=' + tip19.classList.contains('on') + ' ebcodewarn=' + tip19.classList.contains('ebcodewarn'));
    check('T19 预防针文案点明「大概率还要人脸或扫码」',
        !!warn19 && (warn19.textContent || '').indexOf('人脸') >= 0
        && (warn19.textContent || '').indexOf('扫码') >= 0,
        '"' + (warn19 ? warn19.textContent : '') + '"');
    // 9 秒后自动收起：预防针是「一句话」，不是常驻横幅，不能长期占着屏幕
    await sleep(9200);
    check('T19 预防针 9 秒后自动收起，不长期占着屏幕',
        !tip19.classList.contains('ebcodewarn') && !tip19.classList.contains('on'),
        'ebcodewarn=' + tip19.classList.contains('ebcodewarn') + ' on=' + tip19.classList.contains('on'));

    // ===================================================== T20 「打开抖音」按钮
    // 扫码的最后三步（退桌面 → 找抖音图标 → 点右上角扫一扫）全在系统层，
    // 每多一步就多一分流失。给一个直接拉起抖音 App 的入口。
    window.__mock.tab = 'qr';
    var qrOv20 = document.getElementById('__eb_qr');
    if (!qrOv20.classList.contains('on')) {
      document.querySelector('#__eb_tip .ebtipb[data-act="qr"]').click();
    }
    var t20 = await wait(function () {
      var im = document.querySelector('#__eb_qr .ebqimg');
      return qrOv20.classList.contains('on')
        && String(im && im.getAttribute('src') || '').indexOf('data:image/png') === 0;
    }, 6000);
    var dyBtn = qrOv20.querySelector('.ebqdy');
    check('T20 卡片里有「打开抖音」按钮', t20 >= 0 && !!dyBtn, '按钮=' + (dyBtn ? dyBtn.textContent : '(没有)'));

    window.EBQr.openApp = function () { window.EBQr.lastOpenApp++; };
    window.EBQr.lastOpenApp = 0;
    if (dyBtn) dyBtn.click();
    await sleep(250);
    check('T20 点「打开抖音」把请求交给原生（getLaunchIntentForPackage）',
        window.EBQr.lastOpenApp === 1, '调用=' + window.EBQr.lastOpenApp);

    // 二维码同步观察器每 1.5 秒会用「抖音刷新了二维码」覆盖一次卡片提示，
    // 所以这里必须**立刻**抓文本，不能睡一觉再看。先测失败分支，
    // 因为成功分支的断言排在后面，中间被覆盖的概率更大。
    window.__ebOpenAppResult(false, '没安装抖音');
    var t20f = await wait(function () {
      var h = (qrOv20.querySelector('.ebqhint') || {}).textContent || '';
      return h.indexOf('没安装抖音') >= 0;
    }, 900);
    check('T20 没装抖音时明确告知，而不是没反应',
        t20f >= 0, '提示="' + ((qrOv20.querySelector('.ebqhint') || {}).textContent || '') + '"');

    window.__ebOpenAppResult(true, null);
    var t20s = await wait(function () {
      var h = (qrOv20.querySelector('.ebqhint') || {}).textContent || '';
      return h.indexOf('扫一扫') >= 0;
    }, 900);
    check('T20 拉起成功后提示改成「点右上角扫一扫」',
        t20s >= 0, '提示="' + ((qrOv20.querySelector('.ebqhint') || {}).textContent || '') + '"');

    if (qrOv20.classList.contains('on')) qrOv20.querySelector('.ebqclose').click();
    await sleep(180);

    window.__mock.sendMode = 'ok';
    window.__mock.requireVerify = false;
    window.__mock.hideVerify();
    await sleep(150);
  }

  main().catch(function (e) {
    check('执行中断', false, e && e.message ? e.message : e);
  }).then(function () {
    out.textContent = JSON.stringify(results);
    document.title = 'EBTEST_DONE';
  });
})();
