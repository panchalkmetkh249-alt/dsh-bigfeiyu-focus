/**
 * dsh-bigfeiyu-focus —— 浏览器半边。
 *
 * 作用：给已安装的 DSH 桌宠「大肥鱼」(dsh-pet) 加一层「视线跟随」——
 * 整条鱼按鼠标相对它的方位做带透视的 3D 转头（rotateX / rotateY）、
 * 朝光标方向的轻微位移；鼠标闲置时改为缓慢的「东张西望」，拖拽时归零。
 *
 * 为什么是「整条鱼转」而不是「眼珠单独动」：
 *   dsh-pet 的角色是烘焙好的 webm 视频（assets/webm/*.webm），眼睛是画在
 *   像素里的，没有独立的瞳孔图层。要让「看镜头」成立，只能用
 *   perspective + rotateY/rotateX 做真实的 3D 朝向变化，让整颗头转过去。
 *
 * 实现约束（重要）：
 *   1. 不改 dsh-pet 的任何文件：只在 `<head>` 里追加一条本插件自己的
 *      stylesheet，并往 `.dsh-pet-root` 上写 4 个 CSS 自定义属性。
 *   2. 不覆盖 dsh-pet 的 inline style：视频元素的 scaleX/scaleY 是它自己
 *      每帧用 `el.style.transform` 写的，所以变换挂在**根节点**上，
 *      视频/舞台的既有变换完全不受影响。
 *   3. 只做合成层能吸收的属性（transform），不触发布局。
 */

window.__ModuleLoader__.load({
  id: 'dsh-bigfeiyu-focus',
  factory(require) {
    const React = require('react');

    /** 注入样式表的去重标记（沿用 DSH 插件 `data-plugin-css` 约定）。 */
    const STYLE_ID = 'dsh-bigfeiyu-focus/gaze.css';
    /** 桌宠根节点：dsh-pet 的 PetCard 渲染的外层 div。 */
    const PET_SELECTOR = '.dsh-pet-root';
    /** 拖拽中的命中框：dsh-pet 拖动时给它加 .dragging。 */
    const DRAG_SELECTOR = '.dsh-pet-hit.dragging';

    /** 最大偏航角（左右转头，单位 deg）。再大就会露出视频的平面感。 */
    const MAX_YAW = 9;
    /** 最大俯仰角（上下点头）。 */
    const MAX_PITCH = 6;
    /** 朝光标方向的最大位移（px）。 */
    const MAX_SHIFT = 4;
    /** 每 60fps 帧的追值系数；实际按真实帧间隔换算，掉帧时不会变慢。 */
    const EASE = 0.16;
    /** 鼠标静止多久后进入「东张西望」（ms）。 */
    const IDLE_AFTER = 2800;
    /** 东张西望的完整周期（ms）。 */
    const IDLE_PERIOD = 7200;

    const CSS = [
      '/* dsh-bigfeiyu-focus: 只挂变换，不动布局 */',
      PET_SELECTOR + '{',
      '  transform: perspective(880px)',
      '    rotateX(var(--bfy-rx, 0deg))',
      '    rotateY(var(--bfy-ry, 0deg))',
      '    translate3d(var(--bfy-tx, 0px), var(--bfy-ty, 0px), 0);',
      '  transform-origin: 50% 62%;',
      '  will-change: transform;',
      '}',
      '@media (prefers-reduced-motion: reduce){',
      '  ' + PET_SELECTOR + '{ transform: none !important; }',
      '}',
    ].join('\n');

    /** 把 v 夹在 [lo, hi]。 */
    function clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    }

    /**
     * 安装引擎，返回幂等的清理函数。
     * @param {Document} doc
     * @param {Window} win
     */
    function install(doc, win) {
      if (!doc || !win || doc.head === null) return function () {};

      const style = doc.createElement('style');
      style.dataset.plugin = 'dsh-bigfeiyu-focus';
      style.dataset.pluginCss = STYLE_ID;
      style.textContent = CSS;
      doc.head.appendChild(style);

      const reduced =
        typeof win.matchMedia === 'function' &&
        win.matchMedia('(prefers-reduced-motion: reduce)').matches;

      /** el → 当前（已平滑的）角度/位移 */
      const frames = new WeakMap();
      const pointer = {
        x: (win.innerWidth || 0) / 2,
        y: (win.innerHeight || 0) / 2,
        /** 鼠标是否在页面里（离开页面 / 窗口失焦 → false） */
        seen: false,
        /** 最后一次移动的时间戳（ms） */
        at: 0,
      };

      let raf = 0;
      let disposed = false;
      let last = 0;
      /** 第一次跑帧的时间：用来给「找不到网页里的宠物」一个宽限期。 */
      let startedAt = 0;
      /** 是否见过至少一只网页宠物（见过就不再提示）。 */
      let noticed = false;

      function onPointerMove(event) {
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.seen = true;
        pointer.at = event.timeStamp || win.performance.now();
      }

      function onPointerLeave() {
        pointer.seen = false;
      }

      function onBlur() {
        pointer.seen = false;
      }

      win.addEventListener('pointermove', onPointerMove, { passive: true });
      doc.addEventListener('pointerleave', onPointerLeave);
      win.addEventListener('blur', onBlur);

      /** 把一只宠物的 4 个变量写回去（只在真的变了时写，减少样式失效）。 */
      function commit(el, state) {
        const ry = state.yaw.toFixed(2) + 'deg';
        const rx = state.pitch.toFixed(2) + 'deg';
        const tx = state.tx.toFixed(2) + 'px';
        const ty = state.ty.toFixed(2) + 'px';
        if (el.style.getPropertyValue('--bfy-ry') !== ry) el.style.setProperty('--bfy-ry', ry);
        if (el.style.getPropertyValue('--bfy-rx') !== rx) el.style.setProperty('--bfy-rx', rx);
        if (el.style.getPropertyValue('--bfy-tx') !== tx) el.style.setProperty('--bfy-tx', tx);
        if (el.style.getPropertyValue('--bfy-ty') !== ty) el.style.setProperty('--bfy-ty', ty);
      }

      function frame(now) {
        if (disposed) return;
        raf = win.requestAnimationFrame(frame);
        if (reduced || doc.hidden) {
          last = 0;
          return;
        }

        const pets = doc.querySelectorAll(PET_SELECTOR);
        if (pets.length === 0) {
          last = 0;
          if (startedAt === 0) startedAt = now;
          // 页面上一直没有宠物：最常见的原因是 dsh-pet 的「显示位置」设成了仅桌面
          // （那是一只独立的 Electron 窗口，网页这边根本拿不到它）。给它一次提示，
          // 不然用户只会觉得「装了没反应」。
          if (!noticed && now - startedAt > 6000) {
            noticed = true;
            console.info(
              '[dsh-bigfeiyu-focus] 页面里没有找到大肥鱼。若它的「显示位置」是「仅桌面」，' +
                '右键大肥鱼 → 显示位置 → 「仅浏览器」或「两者都显示」，视线跟随才会生效。',
            );
          }
          return;
        }
        noticed = true;

        const dt = last === 0 ? 16.67 : clamp(now - last, 0, 64);
        last = now;
        const k = 1 - Math.pow(1 - EASE, dt / 16.67);
        const vw = win.innerWidth || 1;
        const vh = win.innerHeight || 1;
        const idle = now - pointer.at > IDLE_AFTER;
        const seconds = now / 1000;
        const idleAng = (Math.PI * 2) / (IDLE_PERIOD / 1000);

        for (let i = 0; i < pets.length; i++) {
          const el = pets[i];
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) continue;

          let nx;
          let ny;
          if (pointer.seen && !idle) {
            // 归一化到 [-1, 1]：以视口半宽/半高为分母，屏幕边缘也只需要转头到最大角。
            nx = clamp((pointer.x - (rect.left + rect.width / 2)) / (vw * 0.5), -1, 1);
            ny = clamp((pointer.y - (rect.top + rect.height / 2)) / (vh * 0.5), -1, 1);
          } else {
            // 东张西望：两只宠物相位错开，避免同步得像木偶。
            nx = Math.sin(seconds * idleAng + i * 1.7) * 0.34;
            ny = Math.sin(seconds * idleAng * 0.63 + i * 2.3) * 0.22;
          }

          // 拖拽时把姿态归零：拖着一条歪着的鱼会很怪。
          const dragging = el.querySelector(DRAG_SELECTOR) !== null;
          const gain = dragging ? 0 : 1;

          let state = frames.get(el);
          if (state === undefined) {
            state = { yaw: 0, pitch: 0, tx: 0, ty: 0 };
            frames.set(el, state);
          }

          // 光标在右 → rotateY 取负（右侧靠近观察者）才会「朝右看」；
          // 光标在上 → rotateX 取正（顶部后仰）才会「抬头」。
          const yawTarget = -nx * MAX_YAW * gain;
          const pitchTarget = -ny * MAX_PITCH * gain;
          const txTarget = nx * MAX_SHIFT * gain;
          const tyTarget = ny * MAX_SHIFT * 0.7 * gain;

          state.yaw += (yawTarget - state.yaw) * k;
          state.pitch += (pitchTarget - state.pitch) * k;
          state.tx += (txTarget - state.tx) * k;
          state.ty += (tyTarget - state.ty) * k;
          commit(el, state);
        }
      }

      raf = win.requestAnimationFrame(frame);

      return function dispose() {
        if (disposed) return;
        disposed = true;
        win.removeEventListener('pointermove', onPointerMove);
        doc.removeEventListener('pointerleave', onPointerLeave);
        win.removeEventListener('blur', onBlur);
        if (raf !== 0) win.cancelAnimationFrame(raf);
        const pets = doc.querySelectorAll(PET_SELECTOR);
        for (let i = 0; i < pets.length; i++) {
          pets[i].style.removeProperty('--bfy-ry');
          pets[i].style.removeProperty('--bfy-rx');
          pets[i].style.removeProperty('--bfy-tx');
          pets[i].style.removeProperty('--bfy-ty');
        }
        if (style.parentNode !== null) style.parentNode.removeChild(style);
      };
    }

    /**
     * 挂在 `shell.overlay` 上的零尺寸桥接组件：不渲染任何节点，
     * 只负责在挂载期间驱动全局引擎，卸载时完整回收。
     */
    function GazeBridge() {
      React.useEffect(function () {
        return install(document, window);
      }, []);
      return null;
    }

    return {
      name: 'dsh-bigfeiyu-focus',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'bigfeiyu-focus',
              order: 900,
            },
            GazeBridge,
          );
        });
      },
    };
  },
});
