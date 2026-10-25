/**
 * 抖音登录遮罩。
 *
 * 放在 assets 里而不是 Java 字符串里拼接：拼字符串出过一次静默的 SyntaxError，
 * 导致整个脚本一个字都不执行，表现为「页面全黑」。独立成 .js 文件后可以直接用
 * `node --check login_mask.js` 做语法校验。
 *
 * 职责：
 *  1. 盖一层纯色遮罩，只留「登录抖音」按钮，避免用户看到/误触信息流；
 *  2. 代点抖音自己的「登录」入口，把官方弹窗（短信/密码）顶到遮罩之上；
 *  3. 抖音是 SPA，重渲染会清掉注入节点，用 MutationObserver 重新挂回。
 *
 * 依赖：调用前先设置 window.__ebDark（true=深色）。
 *
 * 脚本可能被 Java 侧多次注入（onPageCommitVisible / onPageFinished / 定时补注入），
 * 因此用 window.__ebInited 保证初始化只跑一次，重复注入只补挂节点，避免重复绑定事件。
 */
(function () {
  // ---------------------------------------------------------------
  // 让抖音把这一页当成桌面浏览器（否则手机上没有「扫码登录」）
  //
  // 2026-10 用户真机反馈：点「扫码：存到相册」提示没找到二维码，
  // 而且抖音面板里根本没有「扫码登录」这一栏 —— 同一个面板在电脑上三栏齐全。
  //
  // 用 CDP 做对照组实测（www.douyin.com，UA 固定成 Mac Chrome）：
  //   纯桌面特征            → 面板 726×483，扫码登录 / 验证码登录 / 密码登录
  //   加手机触摸特征         → 面板 566×720，只剩验证码 / 密码（扫码被撤掉）
  //   只改 maxTouchPoints=0 → 面板打不开（把抖音自己的点击判定弄坏了）
  //   只改 matchMedia(pointer:coarse) → 无效
  //   只改 userAgentData.mobile=false → 面板 726×483，三栏全在 ✅
  //
  // 也就是说它看的是 UA-CH 的 mobile 标志，不是 UA 字符串。
  // 所以这里**只动 userAgentData 这一个字段**，绝不碰触摸相关的任何东西
  // （一碰就点不动，上面的实验已经踩过）。
  // 补丁在页面加载后才打也有效：抖音是点开登录面板那一刻才判定的。
  // ---------------------------------------------------------------
  (function patchDesktopUaData() {
    try {
      var brands = [
        { brand: 'Chromium', version: '122' },
        { brand: 'Google Chrome', version: '122' },
        { brand: 'Not(A:Brand', version: '24' }
      ];
      var desktop = {
        mobile: false,
        platform: 'macOS',
        brands: brands,
        toJSON: function () {
          return { mobile: false, platform: 'macOS', brands: brands };
        }
      };
      // 抖音可能调这个拿高熵字段；不给它就会走异常分支，反过来更像机器人。
      desktop.getHighEntropyValues = function () {
        return Promise.resolve({
          architecture: 'x86',
          bitness: '64',
          brands: brands,
          fullVersionList: brands,
          model: '',
          platform: 'macOS',
          platformVersion: '14.4.0',
          uaFullVersion: '122.0.0.0',
          wow64: false
        });
      };
      Object.defineProperty(navigator, 'userAgentData', {
        get: function () { return desktop; },
        configurable: true
      });
    } catch (e) {
      // 个别 WebView 把这个属性锁死，defineProperty 会抛错。两级降级：
      // 先试直接赋值；还不行就删掉，让抖音退回解析 UA 字符串
      // （我们本来就是 MacChrome 的桌面 UA，它自己会判成桌面）。
      try {
        navigator.userAgentData = desktop;
      } catch (e2) {
        try { delete navigator.userAgentData; } catch (e3) { }
      }
    }
  })();

  if (!document.body || !document.head) return;

  // 重复注入：只把被 SPA 清掉的节点补挂回去，不再重建、不再绑事件
  if (window.__ebInited) {
    var n = window.__ebNodes;
    if (n) {
      if (!document.getElementById('__eb_style')) document.head.appendChild(n.style);
      // 隐藏规则这里**一律不碰**，交给下面那个长期存活的 MutationObserver。
      // 它的闭包里握着准确的 popupLayerOn 状态，能分清「该藏页面」和「弹窗正开着」；
      // 而本函数每轮都是新作用域，读不到那个状态 —— 早先在这里无条件补挂，
      // 结果是把隐藏规则挂回了「弹窗层」上，抖音弹窗被藏掉，
      // 表现就是那个老毛病：「点一下输入框弹窗就消失」。
      if (!document.getElementById('__eb_mask')) document.body.appendChild(n.mask);
      if (!document.getElementById('__eb_tip')) document.body.appendChild(n.tip);
      if (!document.getElementById('__eb_send')) document.body.appendChild(n.send);
      if (!document.getElementById('__eb_qr')) document.body.appendChild(n.qr);
    }
    return;
  }
  window.__ebInited = true;

  var dark = !!window.__ebDark;
  var bg = dark ? '#1B1B1F' : '#FFFFFF';
  var fg = dark ? '#F5F5F7' : '#1B1B1F';
  var mut = dark ? '#9A9AA2' : '#8A8A8E';

  var style = document.createElement('style');
  style.id = '__eb_style';
  style.textContent = [
    '#__eb_mask{position:fixed!important;left:0!important;top:0!important;width:100%!important;',
    'height:100%!important;z-index:2147483000!important;display:flex!important;flex-direction:column!important;',
    'background:', bg, '!important;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif!important}',

    // 顶部提示胶囊：只在抖音登录弹窗顶起来时出现，贴在屏幕最上面。
    // 来由（2026-10 真机实测）：面板里有 扫码 / 验证码 / 密码 三个 tab，默认停在扫码页；
    // 而同一台手机上没东西可扫，用户只能去点「密码登录」——密码 + 桌面 UA + WebView
    // 在抖音风控眼里就是「陌生设备异地登录」，必然要短信 / APP 辅助 / 扫脸。
    // 验证码登录只多一条短信，是这几条路里唯一稳定的，所以给它一个一键入口。
    // 尺寸必须克制：它要乘 k（约 2.4）放大，170px 就顶满整屏了。
    '#__eb_tip{position:fixed!important;left:50%!important;top:0!important;',
    'z-index:2147483647!important;display:none!important;',
    'transform-origin:top center!important;pointer-events:none!important;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif!important}',
    '#__eb_tip.on{display:block!important}',
    // 两颗胶囊竖着排：横排两颗乘 k 之后会顶出屏宽（980 布局下 k≈1.9）
    '#__eb_tip .ebtipb{pointer-events:auto!important;display:block!important;',
    'width:max-content!important;margin:0 auto 8px!important;',
    'font-size:14px!important;font-weight:600!important;line-height:1!important;',
    'padding:10px 16px!important;border-radius:999px!important;color:#fff!important;',
    'background:rgba(27,27,31,.86)!important;white-space:nowrap!important;',
    'box-shadow:0 2px 10px rgba(0,0,0,.28)!important}',
    '#__eb_tip .ebtipb:last-child{margin-bottom:0!important}',
    // 身份验证警告（2026-10-20 真机）：验证码登录点「登录」后，抖音另开一层
    // 「请完成身份验证」，但它那层 z-index 只有几百，被我们顶起来的一级面板
    // （2147483600）死死压住 —— 用户点什么都没反应，只能把登录框叉掉才看见。
    // 所以我们认出验证层就把它顶到最上面，同时用这颗琥珀色胶囊说一句人话。
    // 它是纯状态，不可点（cursor:default），避免用户把它当按钮乱点。
    '#__eb_tip .ebtipwarn{display:none!important;cursor:default!important;',
    'background:rgba(217,119,6,.95)!important;box-shadow:0 2px 10px rgba(180,83,9,.32)!important}',
    '#__eb_tip.ebverify .ebtipwarn{display:block!important}',
    // 验证码被抖音拒（504 / 请求失败）：同样只留「一句话 + 发到另一台手机」，
    // 这时候再摆「换用验证码登录」是害人 —— 用户点一次被拒一次。
    '#__eb_tip.ebcodefail .ebtipwarn{display:block!important}',
    '#__eb_tip.ebcodefail .ebtipb:not(.ebtipwarn):not([data-act="qr"]){display:none!important}',
    // 用户主动切到「验证码登录」tab：先打预防针。抖音对陌生浏览器（WebView）
    // 基本都会在验证码之后再跟一道人脸或扫码，填完手机号、等完 60 秒倒计时
    // 才发现白忙一场，是最劝退的一种体验。所以在切过去的那一刻就说明白，
    // 并把「发到另一台手机」留在旁边 —— 他随时可以立刻改走扫码。
    '#__eb_tip.ebcodewarn .ebtipwarn{display:block!important}',
    '#__eb_tip.ebcodewarn .ebtipb:not(.ebtipwarn):not([data-act="qr"]){display:none!important}',
    // 警告态下只留警告 + 「发到另一台手机」；「换用验证码登录」已经用不上了
    '#__eb_tip.ebverify .ebtipb:not(.ebtipwarn):not([data-act="qr"]){display:none!important}',

    // 自动取码等待态：只留「二维码生成中… Xs」这一颗，其它全部收起
    // （不能点 —— 码还没好，点了也是打开一张空卡片）
    '#__eb_tip .ebtipgate{display:none!important;cursor:default!important}',
    '#__eb_tip.ebgate .ebtipgate{display:block!important}',
    '#__eb_tip.ebgate .ebtipb:not(.ebtipgate){display:none!important}',

    // 「获取验证码」的发送中覆盖层。
    // 由头（2026-10 真机）：抖音那个按钮点下去到变成倒计时之间什么都没有，
    // 用户以为没发出去就反复点 —— 既可能被风控按「操作频繁」拦，也容易连发几条短信。
    // 覆盖层本身就是一个能吃掉点击的盾牌：它盖在按钮上，连点根本落不到抖音那边。
    //
    // 尺寸注意：页码是 980 布局、靠 WebView 缩到手机宽（约 0.42），所以这里
    // width/height 要用「按钮尺寸 ÷ k」再 scale(k) 放回来，否则盾牌只有按钮的一半大、
    // 文字小到看不清。transform-origin 必须是 top left，位置才和按钮对齐。
    '#__eb_send{position:fixed!important;left:0!important;top:0!important;',
    'z-index:2147483646!important;display:none!important;box-sizing:border-box!important;',
    'align-items:center!important;justify-content:center!important;',
    'background:rgba(255,255,255,.62)!important;border-radius:6px!important;',
    'pointer-events:auto!important;cursor:default!important;overflow:visible!important;',
    'transform-origin:top left!important;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif!important}',
    '#__eb_send.on{display:flex!important}',
    '#__eb_send .ebssp{width:12px;height:12px;box-sizing:border-box;flex:0 0 auto;',
    'border:2px solid rgba(254,44,85,.22);border-top-color:#FE2C55;border-radius:50%;',
    'animation:__ebspin .8s linear infinite}',
    '#__eb_send .ebssx{display:none;font-size:12px;line-height:1;color:#8A8A8E;',
    'margin-left:5px;white-space:nowrap}',
    // 按钮够宽才出文字；窄屏上只留转圈，绝不溢出到按钮外面
    '#__eb_send.ebwide .ebssx{display:inline!important}',
    // 超时提示：转圈收起，换成一句「发送超时」，明确告诉用户没成功
    '#__eb_send.ebwarn{background:rgba(255,255,255,.92)!important}',
    '#__eb_send.ebwarn .ebssp{display:none!important;animation:none!important}',
    '#__eb_send.ebwarn .ebssx{display:inline!important;color:#D97706!important;margin-left:0!important}',
    // 挂在盾牌下面的一句说明，只在头 2 秒出现，之后收起，别长时间挡着页面
    '#__eb_send .ebstoast{position:absolute;left:50%!important;top:100%!important;',
    'margin-top:8px!important;transform:translateX(-50%)!important;display:none;',
    'font-size:12px;font-weight:600;line-height:1;padding:8px 13px;border-radius:999px;',
    'color:#fff!important;background:rgba(27,27,31,.88)!important;white-space:nowrap;',
    'box-shadow:0 2px 10px rgba(0,0,0,.24)}',
    '#__eb_send.ebtoast .ebstoast{display:block!important}',

    // 扫码卡片：抖音的「扫码登录」本来就是给桌面网页设计的通道——
    // 用已登录的抖音 App 实时扫一下，等于用本人设备证明身份，不会再要人脸/短信。
    //
    // 2026-10-20 真机实测（用户做的实验，结论很关键）：
    //   · 相册导入 → 抖音拒绝（「为保证安全先使用抖音扫一扫」）
    //   · 另一台手机拍下这个码、本机抖音去扫那张画面 → **登录成功**
    // 也就是说抖音只要求「摄像头实时看到码」，扫另一块屏幕完全成立。
    //
    // 2026-10-20 晚 用户定的最终流程（比"举着另一台手机拍屏幕"省事得多）：
    //   把码**发到**另一台手机（微信/QQ/系统分享）→ 那台手机打开图 →
    //   **本机抖音**扫那一块屏幕。另一台手机不用装抖音、不用登录，只是个显示器。
    // 所以卡片的主按钮是「发到另一台手机」，不再是"存相册"，也不再要求放大到极限。
    '#__eb_qr{position:fixed!important;left:0!important;top:0!important;width:100%!important;',
    'height:100%!important;z-index:2147483647!important;display:none!important;',
    'background:rgba(0,0,0,.62)!important;',
    'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif!important}',
    '#__eb_qr.on{display:block!important}',
    // 卡片按 300px 画，再整体 scale(k) 放回手机真实尺寸（和切换条同一套算法）
    '#__eb_qr .ebqcard{position:absolute!important;left:50%!important;top:50%!important;',
    'width:300px!important;box-sizing:border-box!important;padding:18px 16px 16px!important;',
    'transform:translate(-50%,-50%)!important;transform-origin:center center!important;',
    'background:#fff!important;border-radius:16px!important;text-align:center!important;',
    'box-shadow:0 12px 40px rgba(0,0,0,.32)!important}',
    '#__eb_qr .ebqt{font-size:17px!important;font-weight:700!important;line-height:1.3!important;',
    'color:#1B1B1F!important;margin-bottom:12px!important}',
    '#__eb_qr .ebqimg{display:block!important;width:216px!important;height:216px!important;',
    'margin:0 auto 12px!important;object-fit:contain!important;background:#fff!important;',
    'border-radius:8px!important;image-rendering:pixelated!important;cursor:zoom-in!important}',
    // 还没取到码时留白，但卡片不塌
    '#__eb_qr .ebqimg.ebqempty{visibility:hidden!important}',
    '#__eb_qr .ebqstep{font-size:12px!important;line-height:1.7!important;color:#6B6B70!important;',
    'text-align:left!important;margin:0 2px 14px!important}',
    '#__eb_qr .ebqrow{display:flex!important}',
    '#__eb_qr .ebqbtn{flex:1 1 0!important;font-size:15px!important;font-weight:600!important;',
    'line-height:1!important;padding:13px 0!important;border-radius:10px!important;',
    'cursor:pointer!important;white-space:nowrap!important}',
    '#__eb_qr .ebqbtn+.ebqbtn{margin-left:10px!important}',
    '#__eb_qr .ebqshare{background:#FE2C55!important;color:#fff!important}',
    // 抖音刷新了二维码（旧的过期）：按钮文案换成「重新发到另一台手机」并轻轻脉动，
    // 把用户的注意力拽回来。只改文案 + 一个动画是不够的 —— 用户原话：
    // 「提示说请重新保存，但用户也不知道该怎么保存」。必须给他一个能点的东西。
    '#__eb_qr .ebqshare.ebqagain{animation:__ebpulse 1.3s ease-in-out infinite!important}',
    '@keyframes __ebpulse{0%,100%{box-shadow:0 0 0 0 rgba(254,44,85,.55)}50%{box-shadow:0 0 0 8px rgba(254,44,85,0)}}',
    '#__eb_qr .ebqclose{background:#F2F2F4!important;color:#1B1B1F!important}',
    // 第二行按钮：「打开抖音」。扫码这最后一步在手机上很别扭 —— 要从咱们 App
    // 退到桌面、找抖音图标、再找右上角「扫一扫」，三步。给它一个直接拉起的入口。
    // 用绿色和「发到另一台手机」区分开：那是准备阶段，这是执行阶段。
    '#__eb_qr .ebqrow2{margin-top:10px!important}',
    '#__eb_qr .ebqdy{background:#0F6E56!important;color:#fff!important}',
    '#__eb_qr .ebqhint{font-size:11.5px!important;line-height:1.5!important;',
    'color:#9A9AA2!important;margin-top:10px!important}',
    // 放大模式（点二维码图片切换）：给那些懒得分享、想直接对屏扫的人。
    // 图放到 336px（屏宽 412dp 的 82%），步骤文字收起，只留标题 + 图 + 按钮。
    '#__eb_qr.ebqbig .ebqcard{width:360px!important;padding:14px 12px 12px!important}',
    '#__eb_qr.ebqbig .ebqimg{width:336px!important;height:336px!important;margin-bottom:10px!important}',
    '#__eb_qr.ebqbig .ebqstep{display:none!important}',
    '#__eb_qr.ebqbig .ebqt{font-size:15px!important;margin-bottom:8px!important}',

    // 居中内容区（快捷登录模式专有）。
    // 用绝对定位铺满遮罩再内部居中，而不是靠外层 flex 分配空间：
    // 抖音页面的样式偶尔会干扰 flex 计算，绝对定位更不依赖外部环境。
    '#__eb_mask .ebbody{position:absolute!important;left:0!important;top:0!important;',
    'right:0!important;bottom:0!important;display:flex!important;flex-direction:column!important;',
    'align-items:center!important;justify-content:center!important}',
    '#__eb_mask .ebi{font-size:64px;line-height:1;margin-bottom:28px}',
    '#__eb_mask .ebt{font-size:26px;font-weight:700;margin-bottom:10px;color:', fg, '}',
    '#__eb_mask .ebs{font-size:15px;margin-bottom:40px;color:', mut, '}',
    '#__eb_mask .ebb{font-size:18px;font-weight:600;color:#fff;background:#FE2C55;',
    'padding:15px 56px;border-radius:28px;cursor:pointer}',
    // 等待态：按钮变淡但保持可点 —— 用户随时能再点一次重试
    '#__eb_mask .ebb-wait{opacity:.7}',
    // 状态行：显示「正在打开登录框… 3s」，让时间可见 = 让用户知道没卡死
    '#__eb_mask .ebst{display:none;align-items:center;justify-content:center;font-size:14px;',
    'margin-top:16px;color:', mut, '}',
    '#__eb_mask .ebst.on{display:flex}',
    '#__eb_mask .ebsp{width:13px;height:13px;box-sizing:border-box;flex:0 0 auto;',
    'border:2px solid rgba(254,44,85,.25);border-top-color:#FE2C55;border-radius:50%;',
    'margin-right:8px;animation:__ebspin .8s linear infinite}',
    '@keyframes __ebspin{from{transform:rotate(0)}to{transform:rotate(360deg)}}',
    '#__eb_mask .ebp{font-size:12px;margin-top:22px;color:', mut, '}',
    // 一句提示：密码登录在 WebView 里必被抖音风控，提前说清楚，别让用户白折腾
    '#__eb_mask .ebh{font-size:12px;margin-top:14px;color:', mut, ';opacity:.9}',

    // 弹窗层规则生效时：遮罩只当纯色背景，收起自己的引导内容，
    // 否则「表情搬运工 / 登录抖音」会和抖音的登录框叠在一起，看着像两个弹窗。
    '#__eb_mask.ebpopup .ebbody{display:none!important}'
  ].join('');

  // 全局隐藏规则：body 下除我们自己的节点外全部不可见。
  // 关键：它跟着遮罩一起注入，遮罩没建出来就不会藏东西，不会再出现「全黑」。
  //
  // 注意：这条规则只在「没有弹窗」时挂载。弹窗一出现就整条摘掉（见 setPopupLayer），
  // 两套规则各管一段，绝不重叠 —— 之前是一条规则同时管「藏页面」和「露弹窗」，
  // 弹窗被 React 重建成新节点的那一瞬间就会被它藏掉，表现为「点一下输入框弹窗就没了」。
  var hide = document.createElement('style');
  hide.id = '__eb_hide';
  hide.textContent = 'body>*:not(#__eb_mask):not(#__eb_tip):not(#__eb_send):not(#__eb_qr){visibility:hidden!important}';

  var mask = document.createElement('div');
  mask.id = '__eb_mask';
  mask.innerHTML =
      '<div class="ebbody">'
    + '<div class="ebi">🎵</div>'
    + '<div class="ebt">表情搬运工</div>'
    + '<div class="ebs">登录后即可搬运收藏表情</div>'
    + '<div class="ebb">登录抖音</div>'
    + '<div class="ebst"><span class="ebsp"></span><span class="ebstx"></span></div>'
    + '<div class="ebh">密码登录会触发抖音安全验证，建议用验证码登录</div>'
    + '<div class="ebp">登录信息只保存在本机，不上传任何服务器</div>'
    + '</div>';

  document.head.appendChild(style);
  document.head.appendChild(hide);
  document.body.appendChild(mask);

  // 验证码登录 / 扫码引导胶囊
  var tip = document.createElement('div');
  tip.id = '__eb_tip';
  tip.innerHTML = '<div class="ebtipb ebtipwarn" data-act="warn">抖音要求身份验证</div>'
      + '<div class="ebtipb" data-act="code">换用验证码登录</div>'
      // 扫码这条 2026-10-20 重新打开，流程已定稿：
      // 把码**发到**另一台手机，再用**本机抖音**扫那台手机的屏幕。
      // 另一台手机只是个显示器，不用装抖音，也不用登录。
      // 不能写「存相册」——相册选图会被抖音直接拒掉（实测）。
      + '<div class="ebtipb" data-act="qr">发到另一台手机</div>'
      // 自动取码的等待态（0.8.8）。进了登录页就自动开始取码，抖音出码要 8~12 秒，
      // 这段时间面板已经开着 —— 用这颗胶囊把进度摆出来，用户要的是「正在加载」，
      // 不是对着一个空面板猜程序是不是死了。码就绪后卡片直接弹出（waitQrThenOpen）。
      + '<div class="ebtipb ebtipgate" data-act="gate">二维码生成中…</div>';
  document.body.appendChild(tip);

  // 扫码卡片（把抖音面板里的二维码取出来，发给另一台手机，最后用本机抖音扫它）
  var qr = document.createElement('div');
  qr.id = '__eb_qr';
  qr.innerHTML =
      '<div class="ebqcard">'
    + '<div class="ebqt">把二维码发到另一块屏</div>'
    + '<img class="ebqimg ebqempty" alt="抖音登录二维码">'
    + '<div class="ebqstep">'
    + '① 把码送到另一块屏，二选一：<br>'
    + '　· 点下面「发到另一台手机」，用微信 / QQ 发出去<br>'
    + '　· 或让另一台手机对着本机屏幕拍一张照<br>'
    + '② 另一台设备把图放大到整屏（电脑显示器更清楚，<br>'
    + '　 那台设备不用装抖音、不用登录，能打开图片就行）<br>'
    + '③ 点下面「打开抖音」→ 右上角「扫一扫」→ 扫那块屏幕</div>'
    + '<div class="ebqrow"><div class="ebqbtn ebqshare">发到另一台手机</div></div>'
    + '<div class="ebqrow ebqrow2"><div class="ebqbtn ebqdy">打开抖音</div>'
    + '<div class="ebqbtn ebqclose">关闭</div></div>'
    + '<div class="ebqhint">另一台手机不用装抖音、也不用登录，能打开图片就行。<br>'
    + '也可以让它对着本机屏幕拍一张照。必须用本机抖音对着画面实时扫，<br>'
    + '存进相册再选图会被抖音拒绝。</div>'
    + '</div>';
  document.body.appendChild(qr);

  // 「获取验证码」发送中覆盖层（盖在抖音那个按钮上，负责吃掉连点）
  var sendOv = document.createElement('div');
  sendOv.id = '__eb_send';
  sendOv.innerHTML = '<span class="ebssp"></span><span class="ebssx">发送中</span>'
      + '<div class="ebstoast">正在发送验证码…</div>';
  document.body.appendChild(sendOv);

  window.__ebNodes = { style: style, hide: hide, mask: mask, tip: tip,
                       send: sendOv, qr: qr };

  // ---------------------------------------------------------------
  // 缩放补偿
  //
  // 抖音桌面版页面固定按 ~980px 排版，手机屏只有 360~420dp，WebView 只能把它
  // 整体缩小到装得下（约 0.37 倍）。我们自己画的遮罩住在同一个页面里，
  // 于是也跟着被缩小：标题字只有 9px、按钮小到点不准。
  //
  // 这里按「布局视口宽 ÷ 屏幕宽」算出被缩小的倍数，反着放大回来。
  // **只放大我们自己的遮罩和提示，抖音页面本身一个像素都不动**——页面那边放大就会横向溢出，
  // 变成只能看到左上角一角。
  //
  // 注意时机：overview 缩放是页面加载完之后才套上去的，注入那一刻 innerWidth
  // 可能还是屏幕宽（k=1）。所以要多算几次，并跟随 resize 更新。
  // ---------------------------------------------------------------
  var bodyEl = mask.querySelector('.ebbody');
  var lastK = -1;

  function calcK() {
    var k = 1;
    try {
      var iw = window.innerWidth || 0;
      var sw2 = (window.screen && window.screen.width) || 0;
      if (iw > 0 && sw2 > 0 && iw > sw2 * 1.25) {
        k = iw / sw2;
        if (k > 3.2) k = 3.2;   // 兜住极端 DPR，别把界面撑爆
      }
    } catch (e) {
      k = 1;
    }
    return k;
  }

  /**
   * 提示胶囊的放大倍数。
   * 和遮罩用同一个 k，但要**再收一道**：胶囊是「一行文字」，宽度乘 k（约 2.4）
   * 很容易超过屏幕 —— 实测 980px 布局 + 412dp 屏，几条文案放大后能顶出屏宽，
   * 两头被裁掉就缺字了。超过屏宽 92% 时按屏宽反算，宁可字小一点，也不能缺字。
   */
  function calcTipK(k) {
    try {
      var w = tip ? tip.offsetWidth : 0;
      var screenW = (window.screen && window.screen.width) || 0;
      if (w > 0 && screenW > 0 && w * k > screenW * 0.92) {
        return (screenW * 0.92) / w;
      }
    } catch (e) { /* 取不到尺寸就按原 k */ }
    return k;
  }

  function applyScale() {
    var k = calcK();
    if (bodyEl && k !== lastK) {
      lastK = k;
      bodyEl.style.setProperty('transform', 'scale(' + k + ')', 'important');
      bodyEl.style.setProperty('transform-origin', 'center center', 'important');
    }
    layoutTip();
    layoutQr();
  }

  /** 提示胶囊贴在屏幕顶部，绝不去盖抖音自己的登录框。 */
  function layoutTip() {
    if (!tip) return;
    var k = calcK();
    var tipK = calcTipK(k);
    // 顶部留白按**视觉** 44px 算，再换算回 980 布局坐标（除以 k）。
    // 不这么算的话，固定写 top:14px 在真机上只有 14×0.42 ≈ 6px，
    // 正好被手机状态栏（时间 / 电量）压住。
    // 删掉顶部切换条之前，这个位置是靠「切换条高度 + 24」算出来的，顺带躲开了状态栏；
    // 切换条没了以后就得自己留这段空间。
    // transform-origin 是 top center，缩放不改变上沿位置，所以 top 就是视觉上沿。
    tip.style.setProperty('top', Math.round(44 * k) + 'px', 'important');
    tip.style.setProperty('transform', 'translateX(-50%) scale(' + tipK + ')', 'important');
  }

  applyScale();
  setTimeout(applyScale, 300);
  setTimeout(applyScale, 1200);
  setTimeout(applyScale, 2600);
  window.addEventListener('resize', applyScale);

  // ---------------------------------------------------------------
  // 代点抖音「登录」入口
  // ---------------------------------------------------------------

  /** 抖音「登录」入口是 React 后渲染的，遮罩出现时它可能还不存在。 */
  function findLoginEntry() {
    // 标签清单里必须包含 <p>：实测（2026-10，桌面版）顶部那个「登录」是
    //   <p class="VQdYTqcZ">登录</p>
    // 之前只查 a/button/div/span，结果一次都找不到 → 用户点「登录抖音」后
    // 只能看到「正在打开登录框…」一直数秒数，然后超时。
    // 多列几个常见文本标签，成本可以忽略（只在点击时跑，6 秒内最多 10 次）。
    var all = document.querySelectorAll('a,button,div,span,p,li,i,em,b,strong,label');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.childElementCount !== 0) continue;
      var t = (el.textContent || '').trim();
      if (t !== '登录' && t !== '登录/注册' && t !== '登录 / 注册') continue;
      // 抖音会留一些不可见的同名残留节点（display:none），排掉它们，
      // 否则点的是幽灵节点。注意不能用 visibility 判断：A 规则下页面整体是
      // visibility:hidden，但布局还在，照样能点到。
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      return el;
    }
    return null;
  }

  function clickLoginEntry() {
    var el = findLoginEntry();
    if (el) {
      console.log('EBLOGIN 找到登录入口并点击');
      el.click();
      return true;
    }
    console.log('EBLOGIN 未找到登录入口');
    return false;
  }

  // ---------------------------------------------------------------
  // 把抖音官方弹窗顶到遮罩之上（靠 z-index 压过遮罩，不改遮罩的点击穿透）
  // ---------------------------------------------------------------

  var raised = []; // 我们改过内联样式的节点，弹窗消失后要还原

  // ---------------------------------------------------------------
  // 两套互斥的规则
  //   A. 无弹窗：遮罩 + 隐藏页面 —— 只看得见我们自己的登录页
  //   B. 有弹窗：遮罩留作背景，**摘掉整条隐藏规则** —— 抖页面全部恢复可见，
  //      但被不透明的遮罩挡住，只有 z-index 被顶到 2147483600 的登录弹窗浮在上面
  //
  // 为什么必须互斥：原来只有一条规则，既要藏页面又要露弹窗，
  // 靠「给弹窗节点单独设 visibility:visible」打补丁。可抖音的弹窗是 React 渲染的，
  // 点输入框（聚焦、切换登录方式、键盘避让）都会把节点重建一遍，
  // 新节点在顶起样式追上来之前先继承了 hidden，用户看到的就是「弹窗瞬间消失」。
  // 拆成两套后，B 状态下没有任何隐藏规则，新节点无论怎么重建都一定可见。
  // ---------------------------------------------------------------
  var popupLayerOn = false;

  // 用户点了抖音弹窗的「X」之后的一小段时间里，所有「顶起弹窗」的路径都要让路。
  // 抖音关弹窗不一定是移除节点：淡出、只 display:none 都见过。我们那套带
  // !important 的顶起样式一旦插进去，视觉上就是「点了叉没反应 / 弹窗又冒回来」。
  var closingUntil = 0;

  function isClosing() {
    return closingUntil > 0 && Date.now() < closingUntil;
  }

  /** 真的看得见吗？display:none、visibility:hidden、opacity 0、零尺寸都算「不在」。 */
  function isVisuallyAlive(node) {
    if (!node || !document.contains(node)) return false;
    var cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) < 0.08) return false;
    var r = node.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }

  /** 弹窗没了：把遮罩自己的引导内容（标题 / 登录抖音 / 提示）放回来。 */
  function restoreGuide(why) {
    // 一级面板关掉了 ≠ 登录流程结束：抖音可能只是把它换成了「身份验证」那一层。
    // 这时候把引导内容放回来，遮罩（不透明、z 2147483000）会把验证框整个盖住，
    // 用户看到的就是白屏 + 登录按钮，根本不知道要验证。
    if (scanVerify(false)) return;

    // 把「当前处于弹窗层规则」这个标记也复位。
    //
    // 不复位会留下一个很隐蔽的 bug（0.8.4 删掉网页登录模式后才暴露出来）：
    // 补挂 observer 里有一条 `if (popupLayerOn) mask.classList.add('ebpopup')`，
    // 用来在遮罩被 SPA 摘掉重挂时恢复弹窗层。可弹窗关掉后只要抖音（或别的脚本）
    // 再动一次 DOM，这条就会把 ebpopup 又加回去 —— 引导内容 display:none，
    // 用户看到的是「关掉弹窗过一会儿，登录按钮又没了」。
    // 以前看不到这个问题，是因为切回「快捷登录」时 setMode → endSession 顺手复位了；
    // 切换模式删掉后，没人复位它。
    //
    // 这里**故意不主动挂回隐藏规则**（历史教训：挂回去会在抖音重渲染面板时
    // 把面板一起藏掉，就是「点一下弹窗就消失」）。交给补挂 / 巡检自然恢复 ——
    // 遮罩本身不透明，页面在它下面用户本来就看不见。
    popupLayerOn = false;
    mask.classList.remove('ebpopup');
    stopWait(false);
    hideTip(false);
    hideSending();      // 弹窗关了，盾牌不能留在屏幕上
    closeQr();          // 二维码卡片也一起收掉（它的码已经作废了）
    console.log('EBPOPUP ' + why);
  }

  // 捕获阶段先记一笔：用户点在抖音那个 37×36 的关闭键上了。
  // 这比「等它关完再判断」早得多，也不依赖它到底用移除还是隐藏来实现关闭。
  document.addEventListener('click', function (e) {
    if (!popupLayerOn) return;
    var p = probePopup();
    if (!p) return;
    var cb = findCloseButton(p);
    if (!cb) return;
    var r = cb.getBoundingClientRect();
    var pad = 12;
    if (e.clientX < r.left - pad || e.clientX > r.right + pad
        || e.clientY < r.top - pad || e.clientY > r.bottom + pad) return;
    closingUntil = Date.now() + 1500;
    console.log('EBCLOSE 用户点了弹窗的 X，暂停顶起 1.5s');
  }, true);

  // 用户在抖音面板里点任何一下都可能把它推进到下一步（提交验证码 → 身份验证）。
  // 一有动作就补几次短探，别傻等 700ms 的心跳 —— 那样「点完登录」到「看见验证」
  // 之间会空一拍，正是用户觉得「点了没反应」的那段。
  document.addEventListener('click', function (e) {
    if (!popupLayerOn) return;
    if (isOurs(e.target)) return;      // 点我们自己的提示条 / 卡片不算
    // 用户切到「验证码登录」了：先打预防针，别让他填完手机号才发现还要人脸
    if (hitTabLabel(e.target, '验证码登录')) showCodeWarnTip();
    armVerifyProbe();
  }, true);


  function setPopupLayer(on) {
    if (on === popupLayerOn) return;
    popupLayerOn = on;
    if (on) {
      // 摘掉隐藏规则：页面恢复可见，由不透明白色遮罩继续挡住
      if (hide.parentNode) hide.parentNode.removeChild(hide);
      // 遮罩收起自己的引导内容，只留纯色背景 —— 画面里只该有抖音的登录框
      mask.classList.add('ebpopup');
      console.log('EBPOPUP 切到弹窗层规则（隐藏规则已摘除）');
    } else {
      // 恢复隐藏规则：弹窗关掉了，回到只有遮罩的画面
      if (!document.getElementById('__eb_hide')) {
        document.head.appendChild(hide);
      }
      mask.classList.remove('ebpopup');
      hideTip(true);
      hideSending();
      closeQr();
      console.log('EBPOPUP 恢复遮罩层规则');
    }
  }

  function raiseNode(node) {
    // 绝不能顶起自己画的东西。少这一条，整页关键词扫描会把 .ebbody 当弹窗，
    // 遮罩带上 .ebpopup 后引导内容全没了 —— 白屏。
    if (!node || node.nodeType !== 1) return;
    if (node === mask || node === tip || node === sendOv || node === qr
        || mask.contains(node) || tip.contains(node)
        || sendOv.contains(node) || qr.contains(node)) {
      console.log('EBPOPUP 拒绝顶起自己的节点');
      return;
    }
    // 用户刚点了弹窗的「X」：抖音可能用淡出 / display:none 关闭，
    // 这期间再拿 !important 把它顶回来，就是「点了叉没用」。
    if (closingUntil > 0 && Date.now() < closingUntil) {
      console.log('EBPOPUP 关闭中，跳过顶起');
      return;
    }
    if (raised.indexOf(node) < 0) raised.push(node);
    // 2147483600：要压过遮罩（2147483000），但不能等于最大值 ——
    // 提示胶囊用的是 2147483647，登录弹窗顶上来时不能把它盖住。
    // 验证层例外：它是二级弹窗，必须比一级面板更高（见 promoteVerify）。
    node.style.setProperty('z-index', node === verifyNode ? '2147483646' : '2147483600', 'important');
    node.style.setProperty('visibility', 'visible', 'important');
    node.style.setProperty('opacity', '1', 'important');
    if (getComputedStyle(node).position === 'static') {
      node.style.setProperty('position', 'relative', 'important');
    }
    // 顶起弹窗的同时切到「弹窗层规则」：摘掉整条隐藏规则。
    // 任何一条顶起路径（mutation / 心跳 / 补点 / 常驻巡检）都会走到这里，
    // 所以放在这里能保证不会漏。
    setPopupLayer(true);
    // 遮罩收起自己的引导内容：画面里只该有抖音的登录框。
    // 这里单独加而不是塞进 setPopupLayer，是因为「判定弹窗已关闭」时
    // 要能把引导内容放回来、但**不**恢复隐藏规则（见心跳里的处理）。
    mask.classList.add('ebpopup');
    // 弹窗出来了：顺手给一条「换用验证码登录」，别让用户只能去点密码登录
    showTip();
  }

  var LOGIN_KEYWORDS = ['扫码登录', '密码登录', '验证码', '二维码', '一键登录', '手机号', '抖音登录'];

  // ---------------------------------------------------------------
  // 「换用验证码登录」引导
  //
  // 抖音登录面板的三个 tab 里，扫码在同机上无解、密码必过风控，验证码是唯一顺的。
  // 但面板默认停在扫码页，用户不一定会去看右上角那几个小 tab，
  // 所以在弹窗顶起来时给他一条一眼就能点的胶囊。
  // ---------------------------------------------------------------
  var tipUsed = false;   // 本轮会话点过了就不再把提示摆出来

  /** 在登录面板里按文案找 tab（抖音这几个 tab 的 class 全是哈希，只能按文字找）。 */
  function findTab(label) {
    var hosts = [];
    var p = probePopup();
    if (p) hosts.push(p);
    for (var i = 0; i < raised.length; i++) {
      if (document.contains(raised[i]) && hosts.indexOf(raised[i]) < 0) hosts.push(raised[i]);
    }
    for (var h = 0; h < hosts.length; h++) {
      var all = hosts[h].querySelectorAll('div,span,a,button,p,li');
      for (var j = 0; j < all.length; j++) {
        var el = all[j];
        if (el.childElementCount !== 0) continue;
        if ((el.textContent || '').trim() !== label) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        return el;
      }
    }
    return null;
  }

  function showTip() {
    if (tipUsed || !tip) return;
    // 身份验证警告正挂着：别用「换用验证码登录」把它顶掉，
    // 用户此刻最需要知道的是「抖音要验证」，不是再切一次登录方式。
    if (tip.classList.contains('ebverify')) return;
    // 验证码刚被拒 / 刚摆过预防针，也一样：这时候再摆「换用验证码登录」是害人
    if (tip.classList.contains('ebcodefail')) return;
    if (tip.classList.contains('ebcodewarn')) return;
    if (!probePopup()) return;      // 面板还没真出来，别提前摆一个孤零零的按钮
    tip.classList.add('on');
    layoutTip();
    startQrPrefetch();              // 顺手在后台找码，用户点开时就不用再等
  }

  function hideTip(reset) {
    if (tip) {
      tip.classList.remove('on');
      tip.classList.remove('ebverify');
      tip.classList.remove('ebcodefail');
      tip.classList.remove('ebcodewarn');
      tip.classList.remove('ebgate');   // 门控态一起摘，不然下次 showTip 只剩进度胶囊
    }
    if (codeWarnTimer) { clearTimeout(codeWarnTimer); codeWarnTimer = null; }
    if (reset) tipUsed = false;
  }

  if (tip) {
    tip.addEventListener('click', function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      // 用 closest 找按钮：直接 tip.click()（测试、或者点中两颗胶囊之间的空隙）时
      // e.target 是容器自己，身上没有 data-act。早期就踩过这个 ——
      // 拿不到 act 会让整棵处理逻辑直接走空，用户点了没反应。
      var btn = e && e.target && e.target.closest ? e.target.closest('.ebtipb') : null;
      var act = btn && btn.getAttribute ? btn.getAttribute('data-act') : '';
      if (act === 'warn') return;          // 纯状态提示，点了不做任何事
      if (act === 'qr') { openQr(); return; }
      if (act === 'code') {
        // 用户选择走验证码：替他切 tab，然后把预防针摆出来。
        // 注意这里**不能**走下面那句 hideTip —— 捕获阶段的 document 监听
        // 会在我们之前就跑完 showCodeWarnTip()（捕获先于目标），
        // 这里再 hideTip 会把刚摆出来的警告连同 'on' 一起收掉，用户什么也看不到。
        var tab = findTab('验证码登录');
        console.log('EBTIP 换用验证码登录 tab=' + !!tab);
        if (tab) fireClick(tab);
        tipUsed = true;
        showCodeWarnTip();
        return;
      }
    });
  }

  // ---------------------------------------------------------------
  // 「获取验证码」→ 发送中
  //
  // 抖音那个按钮点下去之后，要等接口回来才变成「59s」倒计时，中间可能一两秒什么都没有。
  // 用户看不到任何变化就会反复点：轻则被风控按「操作频繁」拦下，重则连发几条短信。
  //
  // 做法：点中的那一刻在按钮上盖一块**能吃掉点击**的盾牌（转圈 + 发送中），
  // 连点根本落不到抖音那边；等它变成倒计时（= 短信真发出去了）立刻撤掉盾牌，
  // 把抖音自己的倒计时露出来。超时没变化就换成「发送超时」，然后放开让用户重试。
  //
  // 为什么盖一块自己的，而不是改抖音按钮的文案：
  // React 的文本节点被外部改过之后，它自己的 reconcile 可能不再更新，
  // 按钮就永久卡在「发送中」。盖一层完全不碰它的 DOM，撤掉时什么都不用还原。
  // ---------------------------------------------------------------
  var sendBusy = false;
  var sendBtn = null;
  var sendTimer = null;
  // 用户点过「获取验证码」之后的观察窗口。抖音要发不出去时会自己在面板里报错
  // （实测最常见的是英文 "Request failed with status code 504"），那段文字对用户
  // 等于天书。窗口内盯一眼，命中就翻译成人话并把人引到扫码。
  var codeFailUntil = 0;
  var sendToastTimer = null;
  var sendT0 = 0;
  var sendTxt = sendOv.querySelector('.ebssx');
  var sendToast = sendOv.querySelector('.ebstoast');
  var sendSp = sendOv.querySelector('.ebssp');

  var SEND_TEXT = /^(获取验证码|发送验证码|获取短信验证码|发送短信验证码|获取语音验证码)$/;

  /** 从点击目标往上找「获取验证码」那个按钮（抖音用的是带哈希 class 的 div/span）。 */
  function hitSendButton(target, popup) {
    var cur = target;
    for (var d = 0; d < 5 && cur && cur !== document.body; d++) {
      var t = (cur.textContent || '').replace(/\s+/g, '');
      if (SEND_TEXT.test(t)) {
        var r = cur.getBoundingClientRect();
        // 尺寸过滤：太小的多半是屏幕外的残留节点
        if (r.width > 24 && r.width < 460 && r.height > 14 && r.height < 100) return cur;
      }
      if (cur === popup) break;
      cur = cur.parentElement;
    }
    return null;
  }

  /** 抖音把按钮文字换成「59s / 59秒 / 重新获取」就说明短信确实发出去了。 */
  function isCountingDown(btn) {
    if (!btn || !document.contains(btn)) return false;
    var t = (btn.textContent || '').replace(/\s+/g, '');
    if (!t) return false;
    return /\d{1,3}(s|S|秒)/.test(t) || t.indexOf('后重') >= 0
        || t.indexOf('重发') >= 0 || t.indexOf('重新获取') >= 0;
  }

  /** 手机号填了没有？没填就交给抖音自己弹「请输入手机号」，我们不替他判断。 */
  function popupPhoneFilled(popup) {
    var ins = popup.querySelectorAll('input');
    for (var i = 0; i < ins.length; i++) {
      var el = ins[i];
      var type = String(el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'hidden'
          || type === 'submit' || type === 'button') continue;
      if (String(el.value || '').replace(/\D/g, '').length >= 6) return true;
    }
    return false;
  }

  /**
   * 把盾牌贴到按钮上。
   * 页面是 980 布局被 WebView 缩到屏幕宽，所以布局坐标里按钮看着「很大」，
   * 我们这块住在同一坐标系里、又带了 scale(k)，就得反过来把宽高除以 k，
   * 内容和字号同样除以 k —— 这样视觉尺寸和按钮严丝合缝，字也不会大得溢出。
   */
  function layoutSend() {
    if (!sendBtn || !document.contains(sendBtn)) return false;
    var r = sendBtn.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    var k = calcK();
    if (!(k > 0)) k = 1;
    var cs = getComputedStyle(sendBtn);
    var fs = parseFloat(cs.fontSize) || 14;
    var fsc = fs / k;                 // 盾牌里的字号（布局空间）
    sendOv.style.setProperty('left', r.left + 'px', 'important');
    sendOv.style.setProperty('top', r.top + 'px', 'important');
    sendOv.style.setProperty('width', (r.width / k) + 'px', 'important');
    sendOv.style.setProperty('height', (r.height / k) + 'px', 'important');
    sendOv.style.setProperty('transform', 'scale(' + k + ')', 'important');
    sendOv.style.setProperty('font-size', fsc + 'px', 'important');
    if (sendSp) {
      sendSp.style.setProperty('width', (fsc * 0.9) + 'px', 'important');
      sendSp.style.setProperty('height', (fsc * 0.9) + 'px', 'important');
      sendSp.style.setProperty('margin-right', (fsc * 0.35) + 'px', 'important');
    }
    // 「转圈 + 发送中」要占约 4.4 个字宽；按钮文字本身有 5 个字宽，正常放得下。
    // 真遇到窄按钮就只留转圈，绝不把字挤出去。
    var room = (r.width - 6) / k;
    sendOv.classList.toggle('ebwide', room >= fsc * 4.4);
    return true;
  }

  function hideSending() {
    sendBusy = false;
    sendBtn = null;
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    if (sendToastTimer) { clearTimeout(sendToastTimer); sendToastTimer = null; }
    if (sendOv) {
      sendOv.classList.remove('on');
      sendOv.classList.remove('ebwarn');
      sendOv.classList.remove('ebtoast');
    }
  }

  function beginSend(btn) {
    sendBusy = true;
    sendBtn = btn;
    sendT0 = Date.now();
    if (sendTxt) sendTxt.textContent = '发送中';
    if (sendToast) sendToast.textContent = '正在发送验证码…';
    sendOv.classList.remove('ebwarn');
    sendOv.classList.add('on');
    sendOv.classList.add('ebtoast');
    layoutSend();
    // 说明只摆 2 秒：再久就挡着下面的东西了，转圈本身已经够说明问题
    sendToastTimer = setTimeout(function () {
      sendToastTimer = null;
      sendOv.classList.remove('ebtoast');
    }, 2000);

    var warned = false;
    codeFailUntil = Date.now() + 25000;   // 这 25 秒内盯着面板里有没有报错
    sendTimer = setInterval(function () {
      if (!document.contains(btn) || !probePopup()) { hideSending(); return; }
      layoutSend();     // 键盘弹起、面板重排时跟着按钮走
      if (isCountingDown(btn)) {
        // 抖音开始倒计时 = 短信真的发出去了。立刻撤掉，把倒计时露给用户，
        // 他看到「59s」就再也不会去点了。
        console.log('EBSEND 已进入倒计时，撤掉发送中盾牌');
        hideSending();
        return;
      }
      if (!warned && Date.now() - sendT0 > 6000) {
        warned = true;
        sendOv.classList.remove('ebtoast');
        sendOv.classList.add('ebwarn');
        if (sendTxt) sendTxt.textContent = '发送超时';
        if (sendToast) sendToast.textContent = '没收到短信？可以再点一次';
        // 先让警告停留一会儿，再放开按钮
        setTimeout(function () { if (sendBusy) hideSending(); }, 2000);
      }
    }, 150);
  }

  // 捕获阶段先看一眼：用户点在「获取验证码」上了吗？
  // 命中也不拦 —— 这一下要放给抖音去真发短信，我们只是把盾牌盖上去。
  document.addEventListener('click', function (e) {
    if (!popupLayerOn) return;
    if (sendBusy) {
      // 盾牌已经盖着了还是会点到（WebView 偶发、或者点在盾牌边缘外一点点）：
      // 直接吃掉，别让抖音收到第二次请求
      var rr = sendOv.getBoundingClientRect();
      if (e.clientX >= rr.left - 8 && e.clientX <= rr.right + 8
          && e.clientY >= rr.top - 8 && e.clientY <= rr.bottom + 8) {
        e.preventDefault();
        e.stopPropagation();
        console.log('EBSEND 连点已拦截');
      }
      return;
    }
    var p = probePopup();
    if (!p) return;
    var btn = hitSendButton(e.target, p);
    if (!btn) return;
    if (isCountingDown(btn)) return;              // 已经在倒计时，让它自己提示
    if (!popupPhoneFilled(p)) return;             // 手机号没填，让抖音自己弹提示
    console.log('EBSEND 命中获取验证码，进入发送中状态');
    beginSend(btn);
  }, true);

  // ---------------------------------------------------------------
  // 扫码登录：把面板里的二维码取出来，放大 + 存进相册
  //
  // 背景（2026-10 用户真机反馈）：验证码登录现在也会要人脸 / 扫码验证。
  // 那是抖音的风控，第三方绕不过去也不该绕。但「扫码登录」本来就是为了
  // 让另一台设备（桌面网页）登录而设计的通道——用已登录的抖音 App 扫码，
  // 等于用本人设备证明身份，不会再走验证。手机上没有第二台设备也能完成：
  // 把码存进相册，抖音 App 的扫一扫右上角有「相册」入口。
  //
  // 二维码的三种存在形式都处理：<img>（可能跨域，读不了像素就交给 Java 下）、
  // <canvas>（直接导出）、内联 <svg>（序列化后画到 canvas，不走网络不会污染）。
  // ---------------------------------------------------------------
  var qrImg = qr.querySelector('.ebqimg');
  var qrHintEl = qr.querySelector('.ebqhint');
  var qrShareBtn = qr.querySelector('.ebqshare');
  var qrPayload = '';        // 取到的图（data:image/... 或 http 地址）
  var qrShared = false;      // 当前这张码是否已经发出去过（刷新后要提示重发）
  var qrNodeSrc = '';        // 上次应用过的抖音二维码**节点**地址（判断换码用）
  var qrFindTimer = null;
  var qrSyncTimer = null;
  var qrPreTimer = null;     // 面板一出来就在后台悄悄找码
  var qrPreNode = null;
  var qrGateTimer = null;    // 自动模式：等二维码就绪再弹卡片

  function qrSetHint(text) {
    if (qrHintEl) qrHintEl.textContent = text;
  }

  /** 码已过期刷新过：分享按钮变成显眼的「重新发到另一台手机」。 */
  function markShareAgain() {
    if (!qrShareBtn) return;
    qrShareBtn.textContent = '重新发到另一台手机';
    qrShareBtn.classList.add('ebqagain');
  }

  /** 新一轮 / 重新发成功：按钮恢复原样。 */
  function clearShareAgain() {
    if (!qrShareBtn) return;
    qrShareBtn.textContent = '发到另一台手机';
    qrShareBtn.classList.remove('ebqagain');
  }

  /**
   * 扫码卡片的缩放。
   *
   * 不能用 calcK() 直接乘：那是给整页 980px 布局做反向补偿的，卡片 360px 乘完
   * 会远超声宽（412dp 屏上能算到 850px+），二维码反而一大半在屏幕外。
   * 这里再收一道，按屏宽反算，保证绝不溢出。
   *
   * 两个视图用不同占比：
   *   · 默认（教程视图）留 20% 边 —— 不能撑满，否则第一步的按钮贴着屏幕边，
   *     而且放大态宽度跟它一样，用户点图片会觉得「没反应」。
   *   · 放大态 94% —— 想直接拿另一台手机对着屏幕扫时，越大越好对。
   */
  function calcQrK() {
    var k = calcK();
    try {
      var screenW = (window.screen && window.screen.width) || 0;
      var card = qr.querySelector('.ebqcard');
      var w = card ? card.offsetWidth : 0;
      var ratio = qr.classList.contains('ebqbig') ? 0.94 : 0.80;
      if (w > 0 && screenW > 0 && w * k > screenW * ratio) {
        return (screenW * ratio) / w;
      }
    } catch (e) { /* 取不到尺寸就按原 k */ }
    return k;
  }

  function layoutQr() {
    var card = qr.querySelector('.ebqcard');
    if (!card) return;
    var k = calcQrK();
    if (!(k > 0)) k = 1;
    card.style.setProperty('transform', 'translate(-50%,-50%) scale(' + k + ')', 'important');
  }

  /** 面板里的二维码：img / canvas / 内联 svg，尺寸 100px 以上且大致是方的。 */
  function findQrNode() {
    var p = probePopup();
    if (!p) return null;
    var all = p.querySelectorAll('img,canvas,svg');
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var r = e.getBoundingClientRect();
      if (r.width < 100 || r.height < 100) continue;
      var ratio = r.width / r.height;
      if (ratio < 0.6 || ratio > 1.7) continue;
      if (e.tagName === 'IMG' && !(e.currentSrc || e.src)) continue;
      return e;
    }
    return null;
  }

  /** 节点 → 可显示 / 可保存的地址。取不到就给 null。 */
  function qrSource(node, done) {
    if (!node) return done(null);
    if (node.tagName === 'CANVAS') {
      try { return done(node.toDataURL('image/png')); } catch (e) { return done(null); }
    }
    if (node.tagName === 'IMG') {
      var src = node.currentSrc || node.src || '';
      if (!src) return done(null);
      // 一律先试着画进 canvas：data URL 和同源图能拿到真正的位图（顺带把 svg 转成 png），
      // 跨域 http 图会污染 canvas 抛异常，那就把地址交给 Java 带着 cookie 去下。
      try {
        var c = document.createElement('canvas');
        c.width = node.naturalWidth || 300;
        c.height = node.naturalHeight || 300;
        c.getContext('2d').drawImage(node, 0, 0, c.width, c.height);
        return done(c.toDataURL('image/png'));
      } catch (e2) {
        if (src.indexOf('data:') === 0) return done(null);
        return done(src);
      }
    }
    // 内联 svg：序列化成 data URL 再画到 canvas（同源，不会污染）
    try {
      var xml = new XMLSerializer().serializeToString(node);
      if (xml.indexOf('xmlns') < 0) {
        xml = xml.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
      }
      var im = new Image();
      im.onload = function () {
        try {
          var cv = document.createElement('canvas');
          var box = node.getBoundingClientRect();
          cv.width = Math.max(320, Math.round(box.width * 2));
          cv.height = Math.max(320, Math.round(box.height * 2));
          cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
          done(cv.toDataURL('image/png'));
        } catch (e3) { done(null); }
      };
      im.onerror = function () { done(null); };
      im.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(xml)));
    } catch (e4) {
      done(null);
    }
  }

  /**
   * 把取到的码画进卡片。
   *
   * @param refreshed true = 抖音主动刷新（旧码过期），不是首次取到。
   *   刷新的意义完全不同：用户可能已经把旧码发到另一台手机了，那张图已经作废，
   *   必须明确告诉他「点哪里重新发」。早期这里只在同步回调里同步 setHint，
   *   结果被 applyQr 自己的异步回调覆盖 —— 「请重新保存」这句根本没显示过，
   *   用户对着一张自动换好的图完全不知道下一步干什么（2026-10-24 用户反馈）。
   */
  function applyQr(node, refreshed) {
    // 记下节点地址。同步循环必须拿它比对 —— 拿 qrImg 的 src 比是错的：
    // 那边存的是转换后的 png data URL，和抖音的原始地址永远不相等，
    // 结果每 1.5 秒重复换一次图，用户刚点完「重新发」下一秒又被刷回重发态。
    if (node && node.tagName === 'IMG') {
      qrNodeSrc = node.currentSrc || node.src || '';
    }
    qrSource(node, function (src) {
      if (!src) {
        qrPayload = '';
        qrImg.classList.add('ebqempty');
        qrSetHint('这个码取不出来。关掉卡片，直接扫抖音面板里那个也一样');
        return;
      }
      qrPayload = src;
      qrImg.src = src;
      qrImg.classList.remove('ebqempty');
      if (refreshed) {
        if (qrShared) {
          // 已经发出去过：旧图在另一台手机上就是废码，给一个能点的补救
          markShareAgain();
          qrSetHint('抖音换了新码（旧的已过期），图片已更新 —— 点下面按钮重新发一次');
        } else {
          qrSetHint('抖音刷新了二维码，图片已自动更新');
        }
      } else {
        qrShared = false;
        clearShareAgain();
        qrSetHint('二维码已就绪，点「发到另一台手机」发出去');
      }
    });
  }

  /**
   * 放大 / 缩小（现在靠点二维码图片触发，不再占按钮位）。
   * 用途只有一个：用户懒得分享、想直接拿另一台手机对着本机屏幕扫。
   */
  function toggleQrBig() {
    var big = qr.classList.toggle('ebqbig');
    layoutQr();
    console.log('EBQR 放大=' + big);
  }

  /** 面板一顶起来就在后台找码：抖音要 8~12 秒才渲染，
   *  等用户点开卡片再找，等于让人干等十几秒。预抓到就直接用。 */
  function startQrPrefetch() {
    // 面板关过又重开时，旧节点已经不在文档里了，得重新找
    if (qrPreNode && !document.contains(qrPreNode)) qrPreNode = null;
    if (qrPreTimer || qrPreNode || qr.classList.contains('on')) return;
    var tries = 0;
    qrPreTimer = setInterval(function () {
      if (!probePopup()) {          // 面板关了就别空转
        clearInterval(qrPreTimer);
        qrPreTimer = null;
        return;
      }
      if (++tries > 44) {           // 约 30 秒还没出码就放弃，点开时再现场等
        clearInterval(qrPreTimer);
        qrPreTimer = null;
        return;
      }
      var n = findQrNode();
      if (n) {
        qrPreNode = n;
        clearInterval(qrPreTimer);
        qrPreTimer = null;
        console.log('EBQR 预抓二维码成功');
      }
    }, 700);
  }

  function closeQr() {
    qr.classList.remove('on');
    qr.classList.remove('ebqbig');          // 下次打开回到普通视图
    if (qrFindTimer) { clearInterval(qrFindTimer); qrFindTimer = null; }
    if (qrSyncTimer) { clearInterval(qrSyncTimer); qrSyncTimer = null; }
    if (qrGateTimer) { clearInterval(qrGateTimer); qrGateTimer = null; }
  }

  /** 抖音偶尔会换新码（旧的过期），跟着换，别让用户存到一张废码。 */
  function startQrSync() {
    if (qrSyncTimer) clearInterval(qrSyncTimer);
    qrSyncTimer = setInterval(function () {
      if (!qr.classList.contains('on')) { clearInterval(qrSyncTimer); qrSyncTimer = null; return; }
      if (!probePopup()) { closeQr(); return; }
      var n = findQrNode();
      if (!n) return;
      if (n.tagName !== 'IMG') return;
      var src = n.currentSrc || n.src || '';
      if (src && src !== qrNodeSrc) {
        console.log('EBQR 抖音刷新了二维码，自动换图');
        applyQr(n, true);
      }
    }, 1500);
  }

  /**
   * 抖音的二维码不是跟面板一起出来的：实测面板开出来后还要再等 8~12 秒
   * （它先走一轮风控挑战才去请求码）。原来这里 150ms × 24 ≈ 3.6 秒就放弃，
   * 用户看到的就是「没找到二维码」——其实码马上就有了。
   * 170 × 150ms ≈ 25 秒，留足余量。
   */
  var QR_WAIT_TICKS = 170;

  function openQr(big) {
    hideTip(false);
    qr.classList.add('on');
    // 默认**不进**放大态：现在的主路径是「把码发到另一台手机」，
    // 那台手机收到的是原始分辨率的图，本机屏幕上这张大不大无所谓；
    // 反过来，步骤文字（教程）才是用户要看的，一放大就会被 .ebqbig 收起来。
    // 想直接对着本机屏幕扫的用户，点一下二维码图片就能放大（见 el 点击处理）。
    var wantBig = big === true;
    qr.classList.toggle('ebqbig', wantBig);
    qrPayload = '';
    qrShared = false;      // 新的一轮：还没发过，刷新时不用提示重发
    qrNodeSrc = '';        // 新面板的码地址，等 applyQr 记上
    clearShareAgain();
    qrImg.removeAttribute('src');
    qrImg.classList.add('ebqempty');
    layoutQr();

    // 预抓到了就直接显示 —— 否则用户要对着「正在获取…」干等十几秒
    var pre = qrPreNode;
    if (pre && document.contains(pre)) {
      var pr = pre.getBoundingClientRect();
      if (pr.width >= 100 && pr.height >= 100) {
        applyQr(pre);
        startQrSync();
        return;
      }
    }
    qrPreNode = null;   // 预抓的节点已经失效，清掉，别挡住下一轮预抓

    qrSetHint('正在等抖音生成二维码…');
    var tries = 0;
    if (qrFindTimer) clearInterval(qrFindTimer);
    qrFindTimer = setInterval(function () {
      tries++;
      // 面板被关掉了就别再空等
      if (!probePopup()) {
        clearInterval(qrFindTimer);
        qrFindTimer = null;
        qrSetHint('抖音登录框已关闭，重新点「登录抖音」再来一次');
        return;
      }
      var n = findQrNode();
      if (n) {
        clearInterval(qrFindTimer);
        qrFindTimer = null;
        applyQr(n);
        startQrSync();
        return;
      }
      // 第一轮没找到：多半停在「验证码登录」页，先替用户切回「扫码登录」。
      // 只切这一次——反复点会把抖音已经发出的取码请求重置掉，更慢。
      if (tries === 1) {
        var tab = findTab('扫码登录');
        console.log('EBQR 自动切到扫码登录 tab=' + !!tab);
        if (tab) fireClick(tab);
      }
      if (tries === 40) qrSetHint('抖音还在生成二维码，再等一下…');
      if (tries === 100) qrSetHint('网络慢，二维码要十几秒，先别关这个窗口');
      if (tries > QR_WAIT_TICKS) {
        clearInterval(qrFindTimer);
        qrFindTimer = null;
        qrSetHint('一直没等到二维码。关掉这个窗口，改用验证码登录');
      }
    }, 150);
  }

  // ---------------------------------------------------------------
  // 登录框一出来 → 自动把二维码摆到用户面前
  //
  // 用户实测：唯一能过风控的路是扫码——把码发到另一台手机，本机抖音扫那块屏。可它要用户
  // 自己在抖音面板里找到「扫码登录」、再点一次我们的「发到另一台手机」，两步
  // 任何一步没找到就卡住。既然已经定成主路径，就别让人找。
  //
  // 只做一次（autoQrDone）：用户如果点「缩小」或者关掉去看验证码，我们绝不能再
  // 把卡片弹回来 —— 那等于跟用户抢界面。
  // ---------------------------------------------------------------
  var autoQrTimer = null;
  var autoQrDone = false;

  function armAutoQr() {
    if (autoQrDone || autoQrTimer) return;
    if (qr.classList.contains('on')) return;
    autoQrTimer = setTimeout(function () {
      autoQrTimer = null;
      if (autoQrDone || qr.classList.contains('on')) return;
      if (!probePopup()) return;       // 面板已经关了，别凭空开一张卡片
      autoQrDone = true;
      // 面板里还没有码：先替用户切到「扫码登录」。openQr 自己第一轮也会切，
      // 但那是在 150ms 轮询里，提前切能少等一拍。
      if (!findQrNode()) {
        var tab = findTab('扫码登录');
        console.log('EBAUTO 自动切到扫码登录 tab=' + !!tab);
        if (tab) fireClick(tab);
      }
      if (autoChain) {
        // 自动模式（0.8.8）：用户要的是「二维码出来了才进登录页」——
        // 「先给它正在加载，如果这二维码出来的话就能进入那个登录页」。
        // 等待本身免不了（抖音风控挑战要 8~12 秒），但等待期间必须有进度可见，
        // 所以面板上方挂一颗「二维码生成中… Xs」，码一就绪立刻弹卡片。
        console.log('EBAUTO 自动模式：等二维码就绪再弹卡片');
        waitQrThenOpen();
        return;
      }
      console.log('EBAUTO 自动打开二维码');
      openQr(false);
    }, 800);
  }

  /**
   * 自动模式专属：等抖音把二维码真正生成出来，再弹卡片。
   *
   * 为什么不是面板一开就弹（0.8.5 及以前的行为）：卡片弹出来时码往往还没有，
   * 用户对着「正在等抖音生成二维码…」干等十几秒 —— 他说这不算「进入登录页」。
   * 现在把这段等待挪到提示条上（一颗会跳秒数的胶囊），码就绪的瞬间卡片直接带着图弹出。
   *
   * 等不到也最多 20 秒：之后照样弹卡片，由 openQr 自己的 25 秒轮询接着等，
   * 分段提示（「抖音还在生成二维码」「网络慢，先别关窗口」）都在那条路上。
   * 门控期间只显示进度胶囊，不给人「发到另一台手机」—— 码还没有，发了也是废图。
   */
  function waitQrThenOpen() {
    if (qrGateTimer) { clearInterval(qrGateTimer); qrGateTimer = null; }
    var waited = 0;
    showQrGateTip(0);
    qrGateTimer = setInterval(function () {
      if (qr.classList.contains('on')) {     // 用户自己点开了卡片，不用我们弹
        clearInterval(qrGateTimer);
        qrGateTimer = null;
        return;
      }
      waited += 300;
      if (qrPreNode || findQrNode()) {
        clearInterval(qrGateTimer);
        qrGateTimer = null;
        console.log('EBAUTO 二维码就绪（' + (waited / 1000).toFixed(1) + 's），弹出卡片');
        openQr(false);
        return;
      }
      showQrGateTip(waited);
      if (waited >= 20000) {
        clearInterval(qrGateTimer);
        qrGateTimer = null;
        console.log('EBAUTO 等码超时（20s），仍然弹出卡片');
        openQr(false);
      }
    }, 300);
  }

  /** 门控等待态的提示条：只显示「二维码生成中… Xs」这一颗。 */
  function showQrGateTip(ms) {
    if (!tip) return;
    var gate = tip.querySelector('.ebtipgate');
    if (gate) gate.textContent = '二维码生成中… ' + Math.round(ms / 1000) + 's';
    tip.classList.add('on');
    tip.classList.add('ebgate');
    layoutTip();
  }

  /** 手动关掉二维码：把提示条放回来，不然用户只剩一个抖音面板不知道下一步。 */
  function dismissQr() {
    closeQr();
    if (probePopup()) { tipUsed = false; showTip(); }
  }

  /**
   * 把二维码发到另一台手机（走系统分享：微信 / QQ / 隔空投送 / 存文件…）。
   *
   * <p>为什么不存相册：抖音明确拒绝「相册选图」，只认摄像头实时看到的码。
   * 所以另一台手机拿到图之后，是拿**本机抖音**去扫那台手机的屏幕——
   * 那台手机只是个显示器，不用装抖音、不用登录。
   */
  function shareQr() {
    if (!qrPayload) {
      qrSetHint('还没拿到二维码，稍等一下再试');
      return;
    }
    var bridge = window.EBQr;
    if (!bridge || typeof bridge.share !== 'function') {
      qrSetHint('这个环境不能直接分享，用另一台手机拍下这张图也一样');
      return;
    }
    qrSetHint('正在准备图片…');
    try {
      bridge.share(qrPayload);
    } catch (e) {
      qrSetHint('分享失败：' + (e && e.message ? e.message : e));
    }
  }

  /** Java 侧分享完回调（原生 → JS）。 */
  window.__ebQrShareResult = function (ok, msg) {
    if (ok) {
      qrShared = true;       // 这张码已经发出去了：抖音再刷新它，就得提示重发
      clearShareAgain();
      qrSetHint('已发出。在另一台手机打开这张图，再用本机抖音扫它');
    } else {
      qrSetHint('分享失败：' + (msg || '未知原因'));
    }
  };

  /** Java 侧「存相册」回调：卡片上已没有这个按钮，留着防止旧版本回调报错。 */
  window.__ebQrResult = function (ok, msg) {
    qrSetHint(ok ? '已存入相册' : ('保存失败：' + (msg || '未知原因')));
  };

  /**
   * 直接拉起抖音 App。
   *
   * 为什么值得单独做一个按钮：扫码的最后三步（退到桌面 → 找抖音图标 →
   * 点右上角扫一扫）全在手机系统层，用户每做一步都在流失。
   * 用 getLaunchIntentForPackage 一步到位，他只需要在抖音里点「扫一扫」。
   * Android 11+ 需要在 manifest 里声明 <queries>，否则系统查不到抖音这个包
   * （这一步 0.7.8 补 WebView 二次验证时已经加过了）。
   */
  function openDouyinApp() {
    var bridge = window.EBQr;
    if (!bridge || typeof bridge.openApp !== 'function') {
      qrSetHint('请自己打开抖音 → 右上角「扫一扫」');
      return;
    }
    qrSetHint('正在打开抖音…');
    try {
      bridge.openApp();
    } catch (e) {
      qrSetHint('打开失败：' + (e && e.message ? e.message : e));
    }
  }

  /** Java 侧拉起抖音的回调。 */
  window.__ebOpenAppResult = function (ok, msg) {
    qrSetHint(ok
        ? '抖音已打开，点右上角「扫一扫」扫那块屏幕'
        : ('打不开抖音：' + (msg || '没安装') + '，请手动打开'));
  };

  qr.addEventListener('click', function (e) {
    var t = e.target;
    var cls = t && t.className ? String(t.className) : '';
    if (cls.indexOf('ebqshare') >= 0) { e.preventDefault(); shareQr(); return; }
    if (cls.indexOf('ebqdy') >= 0) { e.preventDefault(); openDouyinApp(); return; }
    if (cls.indexOf('ebqclose') >= 0) { e.preventDefault(); dismissQr(); return; }
    if (t === qrImg) { e.preventDefault(); toggleQrBig(); return; }  // 点图放大/缩小
    if (t === qr) dismissQr();        // 点背景关掉，点卡片本身不关
  });

  function hasLoginKeyword(node) {
    var txt = node.textContent || '';
    for (var i = 0; i < LOGIN_KEYWORDS.length; i++) {
      if (txt.indexOf(LOGIN_KEYWORDS[i]) >= 0) return true;
    }
    return false;
  }

  /**
   * 是否含「登录弹窗」标记。
   * 优先用抖音登录面板的稳定 id/class 判断（弹窗容器一插入就能命中，
   * 不必等里面的文案渲染出来），文案关键词作为兜底。
   */
  function hasLoginMarker(node) {
    var id = node.id || '';
    if (id.indexOf('login-full-panel') === 0 || id.indexOf('douyin-login') === 0) return true;
    if (String(node.className || '').indexOf('douyin_login_new_class') >= 0) return true;
    return hasLoginKeyword(node);
  }

  /**
   * 是否认作抖音登录弹窗。
   * 关键：必须含登录关键词。绝不能再靠「新增节点」当弹窗 ——
   * 抖音会动态插入 position:fixed 的无障碍节点（#a11y-open-btn / #a11y-live-assertive），
   * 会被误判成弹窗，进而误把遮罩设成 pointer-events:none，红色按钮就再也点不动了。
   */
  function isPopupNode(node, base) {
    var id = node.id;
    if (id === '__eb_mask' || id === '__eb_tip' || id === '__eb_send'
        || id === '__eb_qr' || id === '__eb_style' || id === '__eb_hide') return false;
    var tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'NOSCRIPT') return false;
    // 抖音登录面板的稳定 id/class：直接命中，不看是否新增 / 悬浮
    var cn = String(node.className || '');
    if ((id && (id.indexOf('login-full-panel') === 0 || id.indexOf('douyin-login') === 0))
        || cn.indexOf('douyin_login_new_class') >= 0) {
      return true;
    }
    var cs = getComputedStyle(node);
    var isNew = base.indexOf(node) < 0;
    var floating = cs.position === 'fixed' || cs.position === 'absolute';
    // 非新增、又非悬浮的节点直接跳过（避免对 #root 这种整页容器做昂贵的 textContent 扫描）
    if (!isNew && !floating) return false;
    return hasLoginKeyword(node);
  }

  function logRaised(node, via) {
    if (raised.indexOf(node) < 0) {
      console.log('EBPOPUP 顶起弹窗[' + (via || 'body') + '] <' + node.tagName + '> id=' + node.id
          + ' cls=' + String(node.className || '').slice(0, 40));
    }
  }

  /**
   * 兜底：整页按关键词定位真实弹窗。
   * 应对抖音把登录弹窗渲染在 #root 深层（不是 body 直接子节点）——只扫 body
   * 子节点的快路径会漏掉它，表现为「弹窗被点开了但看不到」。
   * 用 TreeWalker 找含登录关键词的文本节点，再向上找最近的悬浮祖先（弹窗框）。
   */
  function findPopupByKeyword() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    while ((node = walker.nextNode())) {
      var txt = node.nodeValue;
      if (!txt) continue;
      // 先按祖先判一次：我们自己那层里的文案（「…建议用验证码登录」、
      // 发送中盾牌上的「正在发送验证码…」）必须直接跳过，
      // 否则下面会把它 nearest 的 .ebbody / #__eb_send 当成弹窗。
      if (mask.contains(node) || tip.contains(node)
          || sendOv.contains(node) || qr.contains(node)) continue;
      var hit = false;
      for (var i = 0; i < LOGIN_KEYWORDS.length; i++) {
        if (txt.indexOf(LOGIN_KEYWORDS[i]) >= 0) { hit = true; break; }
      }
      if (!hit) continue;

      var target = null;
      var cur = node.parentElement;
      while (cur && cur !== document.body) {
        var cs = getComputedStyle(cur);
        if (cs.position === 'fixed' || cs.position === 'absolute') { target = cur; break; }
        cur = cur.parentElement;
      }
      if (!target) target = node.parentElement;
      // 只按 id 排除是不够的：.ebbody 是 absolute 且 id 为空，会被当成弹窗顶起来，
      // 遮罩随即带上 .ebpopup 把引导内容全藏掉 —— 用户看到的就是
      // 「加载完过几秒，登录按钮和提示都消失，一片白」。
      if (!target || target === mask || target === tip || target === sendOv
          || target === qr || mask.contains(target)
          || tip.contains(target) || sendOv.contains(target) || qr.contains(target)) continue;
      var r = target.getBoundingClientRect();
      if (r.width < 80 || r.height < 80) continue; // 太小：多半是隐藏残留，跳过
      logRaised(target, 'deep');
      return target;
    }
    return null;
  }

  /** 顶起弹窗：先扫 body 直接子节点（快），找不到再整页兜底。 */
  function raisePopup(base) {
    var found = false;
    var cur = document.body.children;
    for (var i = 0; i < cur.length; i++) {
      var node = cur[i];
      if (!isPopupNode(node, base)) continue;
      // 已经被抖音藏起来的（display:none / 零尺寸）不算「弹窗还在」。
      // 用户点 X 后抖音只隐藏不移除时，少了这一条就会把它反复顶起来：
      // 表现就是「点了叉没反应，登录按钮也一直不回来」。
      if (!isVisuallyAlive(node)) continue;
      logRaised(node, 'body');
      raiseNode(node);
      found = true;
    }
    if (!found) {
      var deep = findPopupByKeyword();
      if (deep) {
        raiseNode(deep);
        found = true;
      }
    }
    if (found) setPopupLayer(true);
    return found;
  }

  /**
   * 便宜的弹窗探测：只按 id/class 前缀查，不做文本扫描、不取 computedStyle。
   * 用于常驻兜底和「补点前先确认弹窗没开」，每次开销可以忽略。
   */
  function probePopup() {
    var list = document.querySelectorAll(
        '[id^="login-full-panel"],[id^="douyin-login"],.douyin_login_new_class');
    for (var i = 0; i < list.length; i++) {
      var n = list[i];
      if (n.id === '__eb_mask') continue;
      var r = n.getBoundingClientRect();
      if (r.width > 40 && r.height > 40) return n;
    }
    return null;
  }

  function restoreRaised() {
    for (var i = 0; i < raised.length; i++) {
      var s = raised[i].style;
      s.removeProperty('z-index');
      s.removeProperty('visibility');
      s.removeProperty('opacity');
      s.removeProperty('position');
    }
    raised = [];
    restoreHardHidden();
  }

  // ---------------------------------------------------------------
  // 抖音的「二级弹窗」：提交登录后弹出来的身份验证
  //
  // 真机现象（2026-10-20 用户反馈）：验证码登录点「登录」，抖音会**另开一层**
  // 风控弹窗（人脸 / 扫码 / 安全校验）。那一层的 z-index 只有几百，而我们把
  // 一级登录面板顶到了 2147483600 —— 结果验证层被死死压在一级面板下面：
  // 用户点了登录，画面一点变化都没有，只能把登录框叉掉，才看见下面那张
  // 「请完成身份验证」的框。也就是说：请求发出去了，我们什么都没告诉用户。
  //
  // 这里做两件事：
  //   1. 一旦认出验证层，就把它顶到比一级面板更高（2147483646），
  //      「点完登录 → 抖音要验证」这一步在用户眼里是连续的、看得见的；
  //   2. 顶部给一句人话（复用 #__eb_tip 的警告态），并留「发到另一台手机」，
  //      让人马上知道下一步该干嘛，而不是对着界面猜。
  //
  // 识别关键词必须克制：只认「人脸识别 / 身份验证 / 安全验证 / 拖动滑块」这类
  // 风控词。**绝不能用「验证码」**——一级面板的 tab 就叫「验证码登录」，
  // 用了它面板一打开就会误报。
  //
  // 「拖动滑块 / 拼图 / 真人判断」这一组是 2026-10-20 用户真机补的：
  // 抖音有时不弹人脸也不弹扫码，而是让你拖一个滑块 / 拼一张图来证明是真人。
  // 这类弹窗有的连一行字都没有（只有一个 canvas 或跨域 iframe），
  // 文案认不到，见下面的 findChallengeByShape()。
  // ---------------------------------------------------------------
  var VERIFY_STRONG = /(人脸识别|人脸验证|扫脸验证|刷脸验证|身份验证|验证身份|安全验证|身份核实|请完成验证|拖动滑块|滑块验证|滑动验证|安全校验|完成拼图|拼图验证|拖动.{0,6}拼图|按住.{0,6}拖动|向右拖动|人机验证|真人验证|点击按钮进行验证|动态校验|请按住)/;
  // 独立浮层里才算「扫码验证」。**不收单独的「扫一扫」**：
  // 抖音页面上到处是「扫一扫」的入口文案，一旦拿它当特征，鼠标划过一个角标
  // 就会把我们骗去顶一个跟登录无关的浮层。
  var VERIFY_QR = /(扫码验证|抖音扫码|打开抖音扫码|抖音扫一扫|用抖音扫一扫)/;
  var VERIFY_TIPS = {
    face: '抖音要求人脸识别',
    qr: '抖音要求扫码验证',
    slide: '抖音要求拖动验证',
    verify: '抖音要求身份验证'
  };

  var verifyNode = null;     // 当前被顶起来的验证层（null = 没有）
  var verifyKind = '';       // face / qr / slide / verify
  var verifyMiss = 0;
  var verifyProbeTimers = [];
  var verifyDeepTick = 0;
  var verifyProbeUntil = 0;  // 「刚点过」的时间窗：只有在这段时间里才允许按形状认挑战

  /** 是我们自己画的节点（或它的后代）吗？所有扫描都要先过这一关。 */
  function isOurs(n) {
    if (!n) return false;
    return n === mask || n === tip || n === sendOv || n === qr
        || mask.contains(n) || tip.contains(n)
        || sendOv.contains(n) || qr.contains(n);
  }

  function matchVerify(txt, allowQr) {
    if (!txt) return '';
    if (VERIFY_STRONG.test(txt)) {
      if (/(人脸|扫脸|刷脸)/.test(txt)) return 'face';
      if (/(滑块|拼图|拖动|按住|向右滑|人机|真人|动态校验)/.test(txt)) return 'slide';
      return 'verify';
    }
    if (allowQr && VERIFY_QR.test(txt)) return 'qr';
    return '';
  }

  /**
   * 在一棵子树里找验证文案。
   * 只看「自身文本不长」的元素，并跳过不可见 / 零尺寸的：抖音的弹窗里留着
   * 大量 display:none 的备用视图，不排掉的话用户还没走到那一步就先报「要验证」。
   */
  function findVerifyText(root, allowQr) {
    if (!root || !root.querySelectorAll) return '';
    var els = root.querySelectorAll('div,span,p,h1,h2,h3,h4,button,a,li,label,strong,b,em');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var t = (el.textContent || '').replace(/\s+/g, '');
      if (!t || t.length > 160) continue;      // 太长的是整块容器，跳过
      var k = matchVerify(t, allowQr);
      if (!k) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      var r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) continue;
      return k;
    }
    return '';
  }

  /**
   * 找验证层。两条路径：
   *   a) 一级面板内部（抖音也可能原地把面板切成验证视图）→ 面板本身已经顶起，只补提示；
   *   b) body 下独立的浮层（真实风控弹窗走这条）→ 需要单独顶到最前面。
   * b 只扫 position:fixed/absolute 的 body 子节点，绝不对 #root 这种整页容器
   * 做 textContent 扫描（既慢，又会把信息流里的标题当成验证文案）。
   */
  function findVerifyLayer() {
    var p = probePopup();
    if (p) {
      var insideKind = findVerifyText(p, false);
      // 面板内部的「扫一扫」是扫码 tab 的说明（「为保证安全先使用抖音扫一扫」），
      // 不是风控验证 —— 所以内部只认强特征，不认「扫一扫」。
      if (insideKind) return { host: p, kind: insideKind, inside: true };
    }
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (!n || n.nodeType !== 1) continue;
      if (isOurs(n)) continue;
      if (p && (n === p || n.contains(p))) continue;
      var cs = getComputedStyle(n);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (!isVisuallyAlive(n)) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 120 || r.height < 100) continue;
      // 面积门槛：验证弹窗至少占屏幕四分之一，否则就是页面上的小角标 / 工具条，
      // 认错了会把一个跟登录无关的浮层顶到最前面，遮罩也就再也回不去了。
      if (r.width * r.height < window.innerWidth * window.innerHeight * 0.22) continue;
      var kind = findVerifyText(n, true);
      if (kind) return { host: n, kind: kind, inside: false };
    }
    return null;
  }

  /**
   * 兜底：认不出文字时，靠「形状」认出图形挑战（滑块 / 拼图 / 点选 / 跨域 iframe 风控页）。
   *
   * 为什么要这一条：滑块那类验证经常**一个字都没有** —— 一张 canvas、一个
   * 跨域 iframe（里面全是别人的 DOM，我们读不到），或者一条只有图标的滑轨。
   * 只按文案扫，永远看不见它，用户就还是那个体验：点了登录，画面什么都不动。
   *
   * 但形状判据很宽，必须加上两道闸，否则任何一个带 canvas 的浮层都会被误顶：
   *   1. 只在「刚点过」的窗口里（verifyProbeUntil，默认 8 秒）才开这个口子；
   *   2. 必须是本次会话的**新节点**（不在 startSession 的 base 快照里）。
   */
  function findChallengeByShape() {
    if (!verifyProbeUntil || Date.now() > verifyProbeUntil) return null;
    var iw = window.innerWidth || 0;
    var ih = window.innerHeight || 0;
    if (iw <= 0 || ih <= 0) return null;
    var p = probePopup();
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (!n || n.nodeType !== 1) continue;
      if (isOurs(n)) continue;
      // 老节点里只有「快照时还藏着、现在露出来了」的才算本次点出来的挑战
      if (base && base.indexOf(n) >= 0 && baseDead.indexOf(n) < 0) continue;
      if (p && (n === p || n.contains(p))) continue;
      var cs = getComputedStyle(n);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      if (!isVisuallyAlive(n)) continue;
      var r = n.getBoundingClientRect();
      if (r.width < 200 || r.height < 150) continue;
      // 门槛比文本识别松一点（15%）：有的版本只有一张居中的小卡片，
      // 外面没有半透明全屏背板。
      if (r.width * r.height < iw * ih * 0.15) continue;
      // 图形特征：canvas / 跨域 iframe / 原生滑轨，或者一块够大的 svg 拼图
      var shaped = !!n.querySelector('canvas,iframe,input[type="range"]');
      if (!shaped) {
        var svgs = n.querySelectorAll('svg');
        for (var j = 0; j < svgs.length; j++) {
          var sr = svgs[j].getBoundingClientRect();
          if (sr.width >= 120 && sr.height >= 60) { shaped = true; break; }
        }
      }
      if (!shaped) continue;
      return { host: n, kind: 'slide', inside: false };
    }
    return null;
  }

  /**
   * 兜底：验证层不在 body 直下（挂在深层 portal 里）时整页找一次。
   * 带节点预算 —— 抖音首页 DOM 上万，全量扫一遍会卡住主线程。
   */
  function deepFindVerify() {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    var node;
    var budget = 3000;
    while ((node = walker.nextNode()) && budget-- > 0) {
      var txt = node.nodeValue;
      if (!txt || txt.length > 80) continue;
      var kind = matchVerify(txt, true);
      if (!kind) continue;
      var cur = node.parentElement;
      if (isOurs(cur)) continue;
      var host = null;
      var guard = 0;
      while (cur && cur !== document.body && guard++ < 24) {
        var cs = getComputedStyle(cur);
        if (cs.position === 'fixed' || cs.position === 'absolute') { host = cur; break; }
        cur = cur.parentElement;
      }
      if (!host || isOurs(host) || !isVisuallyAlive(host)) continue;
      var r = host.getBoundingClientRect();
      if (r.width < 120 || r.height < 100) continue;
      return { host: host, kind: kind, inside: false };
    }
    return null;
  }

  function showVerifyTip(kind) {
    if (!tip) return;
    var w = tip.querySelector('.ebtipwarn');
    if (w) w.textContent = VERIFY_TIPS[kind] || VERIFY_TIPS.verify;
    tip.classList.add('ebverify');
    tip.classList.add('on');
    layoutTip();
    startQrPrefetch();          // 万一用户要走扫码这条路，码先备着
    handleVerifyQr(kind);
  }

  // ---------------------------------------------------------------
  // 验证层出现 → 二维码卡片怎么办
  //
  // 用户 2026-10-21 确认：验证码登录走到最后那人脸 / 扫码，他试过、卡住、
  // 过不去。所以这两类验证层一冒出来，基本就等于「此路不通」——
  // 这时候还等用户自己点一下「发到另一台手机」，等于让已经花了手机号 +
  // 60 秒倒计时成本的人再做一次选择。退路要直接递到手上（1.2 秒后摆出来）。
  //
  // 但**滑块 / 拼图 / 通用身份验证正好相反**：那些是用户自己能拖过去的。
  // 二维码卡片是全屏的（z 2147483647），这时候盖上去就等于把人家能过的验证挡了
  // —— T14 的负例实测抓到过：自动弹出的卡片压在滑块上，拖不动。
  // 所以这两类不光不能自动开，已经开着的还要主动收起让路。
  // ---------------------------------------------------------------
  var verifyQrTimer = null;
  // 这一次验证层已经自动摆过二维码了。心跳每 ~700ms 会重新探到同一个验证层、
  // 重新走到 promoteVerify → showVerifyTip，如果不管这件事，
  // 用户刚关掉的卡片会被一遍遍摆回来 —— 那就是跟用户抢界面。
  var verifyQrDone = false;

  function handleVerifyQr(kind) {
    if (kind === 'face' || kind === 'qr') {
      // 已经排好了就不要再动它。心跳每 ~700ms 就会来一次，每次都 clearTimeout
      // 重排的话，这个 1200ms 的定时器会被无限重置、永远不触发（第一版就这样）。
      if (verifyQrTimer || verifyQrDone) return;
      verifyQrTimer = setTimeout(function () {
        verifyQrTimer = null;
        if (verifyQrDone) return;
        if (qr.classList.contains('on')) return;
        if (!probePopup()) return;              // 面板都关了，别凭空开一张卡片
        verifyQrDone = true;
        autoQrDone = true;                      // 主动引导过了，别再让 armAutoQr 重复开
        console.log('EBQR 验证层出现，直接摆出二维码 kind=' + kind);
        openQr(false);
      }, 1200);
      return;
    }
    // 滑块 / 拼图 / 通用身份验证：让路。
    if (qr.classList.contains('on')) {
      console.log('EBQR 验证层可由用户自己完成，收起二维码卡片让路 kind=' + kind);
      closeQr();
    }
  }

  function hideVerifyTip() {
    if (!tip) return;
    tip.classList.remove('ebverify');
    // 提示本身要不要收，交回普通逻辑：验证没走完就还留着「换用验证码登录」
    if (tipUsed) tip.classList.remove('on');
  }

  // ---------------------------------------------------------------
  // 切到「验证码登录」时的预防针
  //
  // 用户 2026-10-21 确认：验证码登录走到最后，抖音照样要人脸 / 扫码 / 滑块，
  // 而且他试过、卡住、过不去。也就是说这条路对 WebView 基本是死的。
  // 但用户事先并不知道 —— 他会先填手机号、等 60 秒倒计时、再点登录，然后才撞墙。
  // 最贵的不是那几十秒，是「折腾半天发现此路不通」的挫败感。
  // 所以在切到那个 tab 的那一刻就说清楚，并把扫码入口留在旁边，
  // 他随时可以一键改走主路径。
  //
  // 只按 tab 文案认，不做整页扫描：这两个字在抖音页面上到处都有，
  // 整页认会把无关的文案也当成「用户切了 tab」。
  // ---------------------------------------------------------------
  var codeWarnTimer = null;

  /** 点中的是不是「验证码登录」这个 tab（含它内部被拆成多个 span 的情况）。 */
  function hitTabLabel(target, label) {
    var cur = target;
    for (var d = 0; d < 4 && cur && cur !== document.body; d++) {
      if (cur.childElementCount === 0 && (cur.textContent || '').replace(/\s+/g, '') === label) {
        return true;
      }
      cur = cur.parentElement;
    }
    return false;
  }

  function showCodeWarnTip() {
    if (!tip) return;
    var w = tip.querySelector('.ebtipwarn');
    if (w) w.textContent = '陌生浏览器走验证码，抖音大概率还会要人脸或扫码';
    tip.classList.remove('ebverify');
    tip.classList.remove('ebcodefail');
    tip.classList.add('ebcodewarn');
    tip.classList.add('on');
    layoutTip();
    startQrPrefetch();     // 他真要改走扫码时，码已经在后台备着了
    if (codeWarnTimer) clearTimeout(codeWarnTimer);
    codeWarnTimer = setTimeout(function () {
      codeWarnTimer = null;
      if (!tip.classList.contains('ebcodewarn')) return;   // 已被更严重的状态接走
      tip.classList.remove('ebcodewarn');
      tip.classList.remove('on');
    }, 9000);
    console.log('EBCODE 切到验证码登录，摆出预防针');
  }

  // ---------------------------------------------------------------
  // 把「验证码发不出去」翻译成人话
  //
  // 用户真机反馈：点「获取验证码」后，抖音面板里冒出一行
  //   Request failed with status code 504
  // 这是抖音网关拒了这次请求（不是我们网络断）。用户看到英文只能干瞪眼，
  // 更糟的是他会以为多点几次就好了 —— 越点越容易被按「操作频繁」。
  //
  // 命中后：说人话 + 提示条只留「发到另一台手机」，1.5 秒后直接把二维码摆出来。
  // ---------------------------------------------------------------
  var CODE_FAIL_RE = /(status code 5\d\d|请求失败|发送失败|操作频繁|网络异常|稍后再试|request failed)/i;

  function showCodeFailTip() {
    if (!tip) return;
    var w = tip.querySelector('.ebtipwarn');
    if (w) w.textContent = '抖音拒绝了这次验证码，请改用扫码';
    tip.classList.remove('ebverify');
    tip.classList.add('ebcodefail');
    tip.classList.add('on');
    hideSending();          // 盾牌还盖着按钮的话，用户会以为一直在发
    layoutTip();
    console.log('EBCODE 验证码被拒，引导用户扫码');
    setTimeout(function () {
      if (!probePopup()) return;
      if (qr.classList.contains('on')) return;
      autoQrDone = true;    // 已经主动引导了，别再让 armAutoQr 重复开一次
      openQr(false);
    }, 1500);
  }

  /** 只在「刚点过获取验证码」的窗口里查；平时一次都不扫，不占开销。 */
  function scanCodeFail() {
    if (!codeFailUntil || Date.now() > codeFailUntil) return;
    var p = probePopup();
    if (!p) return;
    var txt = p.innerText || '';
    if (!CODE_FAIL_RE.test(txt)) return;
    codeFailUntil = 0;
    showCodeFailTip();
  }

  function promoteVerify(hit) {
    if (!hit || !hit.host) return false;
    if (!hit.inside && !isOurs(hit.host)) {
      var host = hit.host;
      // 2147483646：高过一级面板（2147483600），又低于切换条 / 提示条（2147483647），
      // 这样验证框在最上面，我们的提示仍然压得住它、切换模式也点得到。
      if (host.style.getPropertyValue('z-index') !== '2147483646') {
        host.style.setProperty('z-index', '2147483646', 'important');
      }
      host.style.setProperty('visibility', 'visible', 'important');
      host.style.setProperty('opacity', '1', 'important');
      if (getComputedStyle(host).position === 'static') {
        host.style.setProperty('position', 'relative', 'important');
      }
      if (raised.indexOf(host) < 0) raised.push(host);
      verifyNode = host;
    } else {
      // 验证视图就长在一级面板里：面板已经顶起，不需要再动层级
      verifyNode = hit.inside ? hit.host : null;
    }
    // 验证层出现 = 登录流程还在继续，绝不能退回「遮罩 + 登录按钮」那套：
    // 遮罩是不透明的全屏块，一退回去就把验证框整个盖住（用户看到的就是白屏）。
    setPopupLayer(true);
    showVerifyTip(hit.kind);
    if (verifyKind !== hit.kind) {
      verifyKind = hit.kind;
      console.log('EBVERIFY 认出验证层 kind=' + hit.kind + ' inside=' + !!hit.inside);
    }
    return true;
  }

  /**
   * 探一次验证层。返回 true = 现在有验证层（且已顶起）。
   * deep=true 时允许做一次整页兜底（贵，只在心跳里隔几拍做一次）。
   */
  function scanVerify(deep) {
    if (!active && !popupLayerOn && !verifyNode) return false;
    var hit = findVerifyLayer();
    // 文字认不到时按「形状」再认一次：滑块 / 拼图 / 跨域 iframe 风控页
    // 经常一个字都没有，只靠文案永远看不见（见 findChallengeByShape）。
    if (!hit) hit = findChallengeByShape();
    if (!hit && deep) hit = deepFindVerify();
    if (hit) {
      verifyMiss = 0;
      return promoteVerify(hit);
    }
    // 没命中：先别急着收提示 —— 抖音重渲染时文案会短暂缺一段。
    // 只有确认之前顶起的那个层真的不可见了，才算验证结束。
    if (verifyNode && isVisuallyAlive(verifyNode)) return true;
    if (!verifyNode && !verifyKind) return false;
    verifyNode = null;
    verifyKind = '';
    verifyMiss = 0;
    verifyProbeUntil = 0;
    verifyQrDone = false;       // 这一轮验证结束了：下次再出现，还允许自动摆一次
    hideVerifyTip();
    console.log('EBVERIFY 验证层已消失');
    return false;
  }

  /**
   * 用户点了一下（多半是「登录」）：抖音要先请求一轮风控，验证层通常
   * 300~1500ms 后才插进来。只靠 700ms 心跳会慢半拍，这里补几次短探，
   * 让「点登录 → 看见要验证」在主观上是一口气。
   */
  function armVerifyProbe() {
    for (var i = 0; i < verifyProbeTimers.length; i++) clearTimeout(verifyProbeTimers[i]);
    verifyProbeTimers = [];
    // 8 秒的「按形状认挑战」窗口：滑块 / iframe 这类验证没有文案，
    // 只能靠「点了之后新冒出一个带 canvas 的大浮层」来判断。
    // 窗口必须有限 —— 常驻开着的话，页面上任何一个带 canvas 的浮层都会被误顶。
    verifyProbeUntil = Date.now() + 8000;
    // 前几拍只做便宜扫描（面板内部 + body 浮层），后几拍补一次整页兜底：
    // 有的版本会把验证层塞进 #root 深处的 portal 里，便宜扫描看不到它。
    var plan = [[120, 0], [400, 0], [800, 0], [1400, 1], [2200, 1], [3400, 1]];
    for (var d = 0; d < plan.length; d++) {
      (function (ms, deep) {
        verifyProbeTimers.push(setTimeout(function () { scanVerify(!!deep); }, ms));
      })(plan[d][0], plan[d][1]);
    }
  }

  function clearVerifyProbe() {
    for (var i = 0; i < verifyProbeTimers.length; i++) clearTimeout(verifyProbeTimers[i]);
    verifyProbeTimers = [];
  }

  // ---------------------------------------------------------------
  // 关闭抖音自己的登录弹窗
  //
  // 为什么必须真关、不能只藏：抖音的登录入口是个「开关」，弹窗开着的时候
  // 内部状态就是 open。我们只是把它盖住的话，下一次点「登录抖音」会变成
  // 「关掉它」，用户看到的是点了没反应或者闪一下。
  //
  // 关闭按钮的稳定特征（2026-10 实测，桌面版 www.douyin.com）：
  //   #douyin-login-new-id 里那个「X」是一个 37×36 的 <svg>，
  //   它自己（或 3 层内的祖先）cursor:pointer。
  //   class 全是 CSS Modules 哈希（YoNA2Hyj / qKr0RhiL），下次发版就变，不能硬编码。
  //   二维码图标虽然也是 40×40，但 cursor:auto —— 靠 cursor 这一条刚好排除掉它。
  // ---------------------------------------------------------------

  function findCloseButton(popup) {
    if (!popup) return null;
    var svgs = popup.querySelectorAll('svg');
    for (var i = 0; i < svgs.length; i++) {
      var s = svgs[i];
      var r = s.getBoundingClientRect();
      if (r.width < 20 || r.width > 60 || r.height < 20 || r.height > 60) continue;
      var el = s;
      for (var d = 0; d < 4 && el; d++) {
        if (getComputedStyle(el).cursor === 'pointer') return el;
        el = el.parentElement;
      }
    }
    return null;
  }

  /**
   * 给元素派发一整套鼠标事件。
   * 不能直接调 el.click()：SVGElement 没有这个方法，会抛 TypeError 而静默失败。
   * 只发 click 也不够 —— 抖音这几个按钮的 handler 挂在 mousedown 上。
   */
  function fireClick(el) {
    var r = el.getBoundingClientRect();
    var opt = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    };
    el.dispatchEvent(new MouseEvent('mousedown', opt));
    el.dispatchEvent(new MouseEvent('mouseup', opt));
    el.dispatchEvent(new MouseEvent('click', opt));
  }

  var hardHidden = [];   // 关不掉时被我们强行藏起来的弹窗，下次开新会话要还原

  function isPopupAlive(node) {
    if (!node || !document.contains(node)) return false;
    var cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    var r = node.getBoundingClientRect();
    return r.width > 5 && r.height > 5;
  }

  function restoreHardHidden() {
    for (var i = 0; i < hardHidden.length; i++) {
      hardHidden[i].style.removeProperty('display');
    }
    hardHidden = [];
  }

  /**
   * 把抖音登录弹窗彻底关掉。绝不依赖异步时序 —— 切换模式时画面必须立刻干净。
   *   1. 点它自己的「X」（实测有效，节点会被 React 移除）
   *   2. 同步复查没关掉 → 立刻强隐（保证视觉上已经没了）
   *   3. 异步补一次 Escape，真关掉就把强隐撤掉，让抖音内部状态与 DOM 一致
   */
  function closeDouyinPopup() {
    var popup = probePopup();
    if (!popup) {
      // 便宜探测（按 id/class 前缀）没命中，再看我们自己顶起过的节点里有没有还活着的。
      // 不用「整页关键词扫描」当兜底：那个是启发式的，可能把一段普通文案的祖先
      // 误判成弹窗，然后被强隐掉，等于在网页上挖了个洞。
      for (var i = 0; i < raised.length; i++) {
        if (isPopupAlive(raised[i])) { popup = raised[i]; break; }
      }
    }
    if (!popup) return false;

    var btn = findCloseButton(popup);
    if (btn) fireClick(btn);

    // 同步复查：React 18 对离散事件（click）是同步 flush 的，
    // 多数情况下这一行就能看到节点已经被移除。
    if (!document.contains(popup)) {
      console.log('EBCLOSE 关闭按钮已关闭弹窗');
      return true;
    }

    // 没关掉：先强隐，绝不让残留的弹窗在切换后继续挡着页面。
    var host = popup;
    if (host.parentElement && host.parentElement.children.length === 1) host = host.parentElement;
    host.style.setProperty('display', 'none', 'important');
    if (hardHidden.indexOf(host) < 0) hardHidden.push(host);
    console.log('EBCLOSE 关闭按钮未生效，已强隐弹窗');

    document.dispatchEvent(new KeyboardEvent('keydown',
        { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
    setTimeout(function () {
      if (document.contains(popup)) return;      // 确实还活着：保持强隐
      var at = hardHidden.indexOf(host);
      if (at >= 0) hardHidden.splice(at, 1);
      host.style.removeProperty('display');
      console.log('EBCLOSE Escape 真关闭了弹窗，强隐已撤销');
    }, 450);
    return true;
  }

  // ---------------------------------------------------------------
  // 点击「登录抖音」：即时检测并顶起抖音官方登录弹窗
  // 用 MutationObserver 监听新增节点，弹窗一插入就立刻顶起，不再用
  // 300ms 轮询 —— 轮询会周期性扫描 body 全部子节点并取 computedStyle，
  // 造成 WebView 主线程卡顿（表现为弹窗里点「发送验证码」长时间无响应）。
  // ---------------------------------------------------------------

  var base = null;      // 点击前的 body 子节点快照
  var baseDead = [];    // 快照里当时不可见的节点（老容器后来被 display 出来的情况）
  var pending = [];     // 本轮新增、待检测的节点
  var active = false;   // 是否处于一次「点登录 → 等弹窗 / 关弹窗」的会话中
  var everUp = false;   // 本轮是否已出现过弹窗
  var inspectTimer = null;
  var heartbeat = null;
  var retry = null;
  var restoreTimer = null;   // 「弹窗关了 → 把登录按钮放回来」的一次性定时器

  // ---------------------------------------------------------------
  // 「登录抖音」等待进度
  // 抖音官方登录弹窗不是本地的，点按钮后要等它把面板渲染出来（快则 1s，网络差更久）。
  // 之前这段时间界面一个像素都不变，用户会以为按钮坏了 / App 卡死。
  // 现在：按钮立刻变「正在打开…」，状态行显示秒数（时间在走 = 程序活着），
  // 12 秒还没弹出就明确说「没弹出来，点按钮重试」，不让它无限沉默。
  // ---------------------------------------------------------------
  var btn = mask.querySelector('.ebb');
  var WAIT_HINT_MS = 5000;   // 超过 5s：改口「抖音响应有点慢」
  var WAIT_FAIL_MS = 12000;  // 超过 12s：判定失败，给重试引导

  var st = mask.querySelector('.ebst');
  var stText = mask.querySelector('.ebstx');
  var waitTimer = null;
  var waitStart = 0;
  var stToken = 0;   // 自增令牌：防止过期的「自动隐藏」擦掉后来的新状态

  function setStatus(text, spinning) {
    if (!st) return;
    stToken++;
    st.classList.add('on');
    var sp = st.querySelector('.ebsp');
    if (sp) sp.style.display = spinning ? 'block' : 'none';
    if (stText) stText.textContent = text;
  }

  function hideStatus() {
    if (!st) return;
    stToken++;
    st.classList.remove('on');
  }

  function stopWait(ok) {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    btn.textContent = '登录抖音';
    btn.classList.remove('ebb-wait');
    if (ok) {
      setStatus('已打开，请在上方完成登录', false);
      var my = stToken;
      setTimeout(function () { if (stToken === my) hideStatus(); }, 3000);
    } else {
      hideStatus();
    }
  }

  /**
   * 打开进度。
   *
   * @param auto true = 自动链（0.8.8）：用户在首页点了「去登录抖音」之后，
   *   不再等他点第二次（页面里那个红按钮），直接开始取码。所以文案要说清楚
   *   「正在准备二维码」而不是「正在打开」；失败时按钮恢复成可点的「登录抖音」
   *   （他从没手动点过，写「重新打开」他会莫名其妙），随时能自己再来一次。
   */
  function startWait(auto) {
    if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
    waitStart = Date.now();
    btn.textContent = auto ? '正在准备二维码…' : '正在打开…';
    btn.classList.add('ebb-wait');
    setStatus((auto ? '正在准备二维码… ' : '正在打开登录框… ') + '0s', true);
    waitTimer = setInterval(function () {
      // 弹窗已经出来（markUp 会调 stopWait），停表
      if (everUp) { clearInterval(waitTimer); waitTimer = null; return; }
      var spent = Date.now() - waitStart;
      var sec = Math.round(spent / 1000);
      if (spent < WAIT_HINT_MS) {
        setStatus((auto ? '正在准备二维码… ' : '正在打开登录框… ') + sec + 's', true);
      } else if (spent < WAIT_FAIL_MS) {
        setStatus('抖音响应有点慢，仍在等待… ' + sec + 's', true);
      } else {
        clearInterval(waitTimer); waitTimer = null;
        btn.textContent = auto ? '登录抖音' : '重新打开';
        btn.classList.remove('ebb-wait');
        setStatus('登录框没弹出来，点上面按钮重试', false);
      }
    }, 400);
  }

  btn.addEventListener('click', function () {
    console.log('EBCLICK 点击登录抖音按钮');
    // 先取快照、开会话（此刻弹窗还没出现），再代点登录入口。
    // 顺序反了的话，弹窗节点会被算进快照、不再算「新增」，检测会漏。
    startSession();
    clickLoginEntry();
    // 立刻上进度：别让用户等一个毫无变化的界面
    startWait();
  });

  // ---------------------------------------------------------------
  // 0.8.4：删掉了「网页登录」这一路
  //
  // 原来顶部有个分段控件，可以在「快捷登录（盖遮罩 + 代点）」和「网页登录（遮罩整个
  // 隐藏、页面交给用户自己点）」之间切换。加它是因为早期代点不稳，留个逃生口。
  // 现在代点 + 顶弹窗 + 自动出码已经稳了，而网页登录这条路在 WebView 里的实际要求是：
  // 980px 桌面版缩到 0.37 倍、字小到看不清、还要用户自己去抖音面板里找 tab ——
  // 实测没人用，反而占了顶部一条常驻控件的位置，还多出「切模式要归零弹窗」这一整套
  // 容易出错的逻辑。整套删除。
  // ---------------------------------------------------------------
  function clearTimers() {
    if (inspectTimer) { clearTimeout(inspectTimer); inspectTimer = null; }
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    if (retry) { clearInterval(retry); retry = null; }
    if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
    if (autoQrTimer) { clearTimeout(autoQrTimer); autoQrTimer = null; }
    if (verifyQrTimer) { clearTimeout(verifyQrTimer); verifyQrTimer = null; }
    clearVerifyProbe();
  }

  /**
   * 弹窗关了 → 把「登录抖音」按钮放回来。
   *
   * 为什么不像以前那样交给心跳：心跳 700ms 一次、要连续 4 次（≈2.8 秒）才认弹窗关闭，
   * 用户点完右上角那个「X」，按钮要愣两秒多才回来，看起来像卡住了。
   *
   * 现在改成事件驱动：抖音关弹窗会把节点从 DOM 里移除，MutationObserver 立刻就能看见，
   * 这里只留一个很短的延迟（默认 140ms）——不是防抖随便给的，是给 React 重建留窗口：
   * 用户在弹窗里切换「扫码/密码登录」时同样会移除旧面板，新的马上又插进来，
   * 复查一次只要还能找到弹窗，就当没事发生，按钮不会闪。
   */
  function scheduleRestoreUi(delay) {
    if (restoreTimer) return;      // 已经排了一次，别叠加
    restoreTimer = setTimeout(function () {
      restoreTimer = null;
      if (!popupLayerOn) return;
      // 复查：可能只是 React 把面板重建成新节点了
      var again = probePopup();
      if (again && isVisuallyAlive(again)) {
        // 用户刚点了 X：抖音还在淡出，这时候既不该把引导放回来（会闪），
        // 也不能再去顶它（等于把弹窗按回去）。等它自己走完。
        if (isClosing()) { scheduleRestoreUi(300); return; }
        logRaised(again, 'restore-check');
        raiseNode(again);
        return;
      }
      // 确认真的没了：把引导内容放回来（按钮重新可见、可点）。
      // 注意只撤 ebpopup，不回退到规则 A —— 一旦把隐藏规则挂回去，
      // 抖音下次重渲染又会被藏掉，就是那个老毛病「点一下弹窗就消失」。
      restoreGuide('弹窗已关闭，立即恢复登录按钮');
    }, delay || 140);
  }

  /**
   * 被移除的节点和登录弹窗有关吗？
   * 三种情况都算：移除的正是我们顶起的节点、移除的祖先里含它、移除的就是登录面板容器本身。
   */
  function isPopupRemoval(node) {
    if (!node || node.nodeType !== 1) return false;
    for (var i = 0; i < raised.length; i++) {
      var r = raised[i];
      if (r === node || (node.contains && node.contains(r))) return true;
    }
    var id = node.id || '';
    if (id.indexOf('login-full-panel') === 0 || id.indexOf('douyin-login') === 0) return true;
    if (String(node.className || '').indexOf('douyin_login_new_class') >= 0) return true;
    if (node.querySelector) {
      if (node.querySelector('[id^="login-full-panel"],[id^="douyin-login"],.douyin_login_new_class')) {
        return true;
      }
    }
    return false;
  }

  function startSession() {
    // 每次点击都重开一轮：先清掉上一轮可能残留的定时器与状态。
    // 否则上一轮若卡在 active=true，后续点击会被直接跳过（表现为「点了没反应」）。
    clearTimers();
    tipUsed = false;    // 新的一轮：提示可以再出现一次
    autoQrDone = false; // 新的一轮：可以再自动摆一次二维码
    codeFailUntil = 0;
    closingUntil = 0;   // 上一轮点过 X 的「免打扰」不能带到这一轮
    hideSending();      // 上一轮的发送中盾牌也要收掉
    closeQr();          // 二维码卡片同理
    // 上一轮如果弹窗关不掉、被我们强隐过，这里必须先放出来：
    // 抖音内部认为弹窗是 open 的，藏着的 DOM 会让它的「开关」逻辑错位
    // （第一次点变成关闭、第二次才打开）。
    restoreHardHidden();
    active = true;
    everUp = false;
    // 新一轮：上一轮残留的「验证层」状态必须归零，否则提示条会挂着上一次的警告
    verifyNode = null;
    verifyKind = '';
    verifyMiss = 0;
    verifyProbeUntil = 0;
    verifyQrDone = false;
    if (verifyQrTimer) { clearTimeout(verifyQrTimer); verifyQrTimer = null; }
    pending = [];
    base = [];
    baseDead = [];
    var kids = document.body.children;
    for (var j = 0; j < kids.length; j++) {
      base.push(kids[j]);
      // 快照里「当时是隐藏的」节点单独记一份：抖音有的版本会在页面加载时
      // 就把风控容器（滑块 / iframe 验证页）挂好、藏着，用到时才 display 出来。
      // 只按「新节点」判断的话，这种老容器永远认不到。
      if (!isVisuallyAlive(kids[j])) baseDead.push(kids[j]);
    }

    // 兜底：登录入口/弹窗可能还没渲染出来 → 每 600ms 扫描一次并补点，
    // 弹窗一出现就停（raisePopup 命中即 markUp），绝不常驻轮询。
    var tries = 0;
    retry = setInterval(function () {
      tries++;
      if (everUp) { clearInterval(retry); retry = null; return; }
      if (raisePopup(base)) { markUp(); return; }
      // 弹窗可能已经开了，只是没被上面两条识别路径认出来。
      // 这种时候绝对不能再点「登录」——抖音那个入口在弹窗打开时相当于开关，
      // 多点一下就会把用户正要填的登录框关掉（「一碰就消失」的另一半原因）。
      var p = probePopup();
      if (p) { logRaised(p, 'probe'); raiseNode(p); setPopupLayer(true); markUp(); return; }
      // 补点窗口从 12 秒收到 6 秒：入口 2 秒左右就渲染好了，点十次没反应
      // 基本可以认定是抖音改版了，继续点只会干扰用户操作。
      if (tries > 10) { clearInterval(retry); retry = null; return; }
      clickLoginEntry();
    }, 600);
  }

  function markUp() {
    everUp = true;
    if (retry) { clearInterval(retry); retry = null; }
    ensureHeartbeat();
    // 弹窗已经顶上来了：立刻收掉等待态，别让「正在打开…」和真弹窗同时出现
    stopWait(true);
    // 定了主路径是扫码，就别让用户自己去找入口（见 armAutoQr）
    armAutoQr();
  }

  function endSession() {
    clearTimers();
    active = false;
    everUp = false;
    verifyNode = null;
    verifyKind = '';
    verifyMiss = 0;
    verifyProbeUntil = 0;
    verifyQrDone = false;
    if (verifyQrTimer) { clearTimeout(verifyQrTimer); verifyQrTimer = null; }
    base = null;
    baseDead = [];
    pending = [];
    // 弹窗关掉了：把隐藏规则挂回去，回到「只看得见遮罩」的画面
    setPopupLayer(false);
    // 按钮恢复可点，状态行收起
    stopWait(false);
    hideSending();
    closeQr();
  }

  /** 收集新增节点，合并成一次检测（60ms 去抖），避免频繁扫描。 */
  function onPopupMutations(records) {
    // 「弹窗被移除」的检测不依赖会话状态：只要遮罩还处在弹窗层，
    // 节点消失就该立刻把按钮放回来。用户点右上角的「X」走的就是这条路。
    if (popupLayerOn) {
      for (var i = 0; i < records.length; i++) {
        var rm = records[i].removedNodes;
        for (var m = 0; m < rm.length; m++) {
          if (isPopupRemoval(rm[m])) { scheduleRestoreUi(140); break; }
        }
      }
    }

    if (!active) return;
    for (var j = 0; j < records.length; j++) {
      var added = records[j].addedNodes;
      for (var k = 0; k < added.length; k++) {
        if (added[k].nodeType === 1) pending.push(added[k]);
      }
    }
    if (pending.length && !inspectTimer) {
      inspectTimer = setTimeout(inspectPending, 60);
    }
  }

  function inspectPending() {
    inspectTimer = null;
    var list = pending;
    pending = [];
    var found = false;
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!document.contains(node) || node.id === '__eb_mask'
          || node.id === '__eb_tip'
          || node.id === '__eb_send' || node.id === '__eb_qr') continue;
      if (isPopupNode(node, base)) {
        logRaised(node, 'mut');
        raiseNode(node);
        found = true;
      }
    }
    if (found) markUp();
  }

  /** 弹窗出现后低频检查它是否还在；关了（被移除/隐藏）就还原并结束本轮。 */
  function ensureHeartbeat() {
    if (heartbeat) return;
    var miss = 0;   // 连续几次都没找到活着的弹窗
    heartbeat = setInterval(function () {
      // 每拍顺手确认一下是不是进了「身份验证」那一步：验证层可能比一级面板
      // 活得久（面板被卸载、只剩验证框），也可能在面板内部原地切换视图。
      // 整页兜底扫（TreeWalker）比较贵，四拍做一次（≈2.8s）。
      verifyDeepTick++;
      scanVerify(verifyDeepTick % 4 === 0);
      scanCodeFail();
      var alive = false;
      for (var i = 0; i < raised.length; i++) {
        var n = raised[i];
        if (!document.contains(n)) continue;
        var cs = getComputedStyle(n);
        var r = n.getBoundingClientRect();
        if (cs.display !== 'none' && r.width > 0 && r.height > 0) { alive = true; break; }
      }
      if (alive) { miss = 0; return; }

      // 顶起过的节点全失效了：别急着判死。
      // 抖音的弹窗是 React 渲染的，点输入框（聚焦、方式切换、键盘避让）都可能把
      // 整个弹窗重建成新节点，旧节点自然就 document.contains === false。
      // 先重新找一遍，找到就接着用；找不到才认它真被关了。
      var again = probePopup();
      if (again && isVisuallyAlive(again) && !isClosing()) {
        logRaised(again, 'reborn');
        raiseNode(again);
        miss = 0;
        return;
      }
      if (base && raisePopup(base)) {
        miss = 0;
        return;
      }

      miss++;
      // 用户点过 X：不用等两拍，这就是一次明确的关闭
      if (isClosing() && miss < 2) miss = 2;
      if (miss === 2) {
        // 约 1.4 秒都没找到：认定用户真的把弹窗关掉了。
        //
        // 主路径其实不用等到这里 —— 抖音关弹窗会把节点从 DOM 移除，
        // MutationObserver 抓到后 140ms 就把按钮放回来了（见 scheduleRestoreUi）。
        // 这里只是兜底：万一哪天它改成「只 display:none、不移除节点」，
        // 也能在 1.4 秒内恢复，而不是像以前那样要愣 2.8 秒。
        //
        // 只收掉提示和自己的引导内容，不结束会话、不恢复隐藏规则 ——
        // 一旦退回规则 A，抖音下一次重渲染又会被藏掉，就是「点一下就没了」。
        // 遮罩本身是不透明的全屏块，页面在它下面，用户看不到，留在规则 B 没有副作用。
        restoreGuide('心跳兜底：弹窗已关闭，恢复登录按钮');
      }
    }, 700);
  }

  // ---------------------------------------------------------------
  // 抖音 SPA 重渲染会清掉注入节点，盯着补挂
  // ---------------------------------------------------------------
  var mo = new MutationObserver(function () {
    if (!document.body || !document.head) return;
    if (!document.getElementById('__eb_style')) document.head.appendChild(style);
    // 弹窗层规则生效时不补挂：那一段本来就要求页面可见
    if (!popupLayerOn && !document.getElementById('__eb_hide')) {
      document.head.appendChild(hide);
    }
    if (!document.getElementById('__eb_mask')) document.body.appendChild(mask);
    if (!document.getElementById('__eb_tip')) document.body.appendChild(tip);
    if (!document.getElementById('__eb_send')) document.body.appendChild(sendOv);
    if (!document.getElementById('__eb_qr')) document.body.appendChild(qr);
    // 遮罩被 SPA 移除后重新挂回来时，弹窗层规则要跟着恢复，
    // 否则遮罩会突然带着「登录抖音」引导内容盖在抖音弹窗上
    if (popupLayerOn) mask.classList.add('ebpopup');
  });
  mo.observe(document.documentElement, { childList: true });
  mo.observe(document.body, { childList: true });

  // 弹窗检测：只在一轮会话中生效，弹窗一插入就立即顶起（无轮询、无卡顿）
  var popupMo = new MutationObserver(onPopupMutations);
  popupMo.observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------
  // 常驻兜底：弹窗「自己找回来」
  //
  // 上面那套检测是「一次会话」的：从点按钮到弹窗关闭。它有两个盲区——
  //   1. 抖音把弹窗重建成新节点时，会话可能已经结束，新节点没人管；
  //   2. 用户可能已经填到一半，界面却退回遮罩，弹窗再也出不来。
  // 所以加一条与「会话」无关的低频巡检：只要遮罩还在，就盯着有没有弹窗。
  // 开销很小（只按 id/class 前缀查，不扫文本、不取样式），贵的整页扫描 5 秒才做一次。
  // ---------------------------------------------------------------
  var guardTicks = 0;
  setInterval(function () {
    if (!document.body || !document.body.contains(mask)) return;
    // 兜底：隐藏规则被 SPA 清掉后补回来。
    // 只在「没有弹窗」时补 —— 弹窗开着的时候必须让页面可见，
    // 否则抖音的登录框会被这条规则藏掉（「点一下弹窗就消失」的根因之一）。
    if (!popupLayerOn && !document.getElementById('__eb_hide')) document.head.appendChild(hide);
    guardTicks++;
    if (popupLayerOn) return;                       // 已在弹窗层规则下，交给心跳
    var p = probePopup();
    if (!p && guardTicks % 4 === 0) {
      p = findPopupByKeyword();                     // 便宜探测失败时，5 秒做一次贵的
    }
    if (!p) return;
    logRaised(p, 'guard');
    raiseNode(p);
    setPopupLayer(true);
    markUp();
  }, 1200);

  // ---------------------------------------------------------------
  // 0.8.8 自动链：进了登录页就直接开始取码，不再等用户点第二次
  //
  // 用户 2026-10-24 提的需求原话：「点去登录抖音 → 先给它正在加载 →
  // 如果这二维码出来的话就能进入那个登录页」。以前这里还要用户再点一次
  // 页面里的红按钮 —— 他都进登录页了，意图已经明确，那一下纯属多余。
  //
  // 现在自动代点（与手点完全同一条代码路径：startSession + clickLoginEntry），
  // 加载态全程可见：
  //   封面「正在打开抖音登录页…」→ 引导页「正在准备二维码… Ns」
  //   → 抖音面板 + 提示条「二维码生成中… Ns」→ 码就绪，卡片带着图直接弹出
  //
  // 两个保护，缺一不可：
  //   1. 900ms 内用户自己点了红按钮 → 绝不重复代点（会把刚开的面板 toggle 掉），
  //      只把 autoChain 置上，让 armAutoQr 的门控照样生效；
  //   2. 12 秒面板还没弹出来 → 按钮恢复成可点的「登录抖音」，随时能手动重试
  //      （见 startWait 的失败分支，auto 模式下文案不是「重新打开」）。
  // ---------------------------------------------------------------
  var autoChain = false;

  function startAutoChain() {
    if (autoChain) return;
    autoChain = true;
    if (active) {
      // 用户已经自己点过了：会话正在进行，重复代点 = 把人家刚打开的面板关掉
      console.log('EBAUTO 用户已手动开始，只挂门控');
      return;
    }
    console.log('EBAUTO 进入登录页，自动开始取码');
    startSession();
    clickLoginEntry();
    startWait(true);
  }

  setTimeout(startAutoChain, 900);
})();