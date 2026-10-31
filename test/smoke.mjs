/**
 * 无浏览器的冒烟测试：用最小 DOM 桩加载 client.js，验证
 *   1) 能注册到 shell.overlay；
 *   2) 挂载后注入样式、写 --bfy-* 变量；
 *   3) 光标在右 → rotateY 为负（朝右看）；光标在上 → rotateX 为正（抬头）；
 *   4) 拖拽时姿态归零；
 *   5) 卸载时样式与变量都被清掉。
 *
 * 运行：node test/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');

function makeStyle() {
  const props = new Map();
  return {
    props,
    getPropertyValue: (name) => (props.has(name) ? props.get(name) : ''),
    setProperty: (name, value) => props.set(name, String(value)),
    removeProperty: (name) => props.delete(name),
  };
}

const rafQueue = [];
const win = {
  innerWidth: 1200,
  innerHeight: 800,
  listeners: new Map(),
  matchMedia: () => ({ matches: false }),
  performance: { now: () => 0 },
  addEventListener(type, fn) {
    win.listeners.set(type, fn);
  },
  removeEventListener(type) {
    win.listeners.delete(type);
  },
  requestAnimationFrame(fn) {
    rafQueue.push(fn);
    return rafQueue.length;
  },
  cancelAnimationFrame() {
    rafQueue.length = 0;
  },
};

const head = {
  child: null,
  appendChild(node) {
    head.child = node;
    node.parentNode = head;
  },
  removeChild(node) {
    head.child = null;
    node.parentNode = null;
  },
};

const pet = {
  rect: { left: 800, top: 500, width: 300, height: 170 },
  dragging: false,
  style: makeStyle(),
  getBoundingClientRect() {
    return this.rect;
  },
  querySelector(sel) {
    if (sel === '.dsh-pet-hit.dragging') return this.dragging ? {} : null;
    return null;
  },
};

const doc = {
  hidden: false,
  head,
  listeners: new Map(),
  createElement() {
    return { dataset: {}, textContent: '', parentNode: null };
  },
  querySelectorAll(sel) {
    return sel === '.dsh-pet-root' ? [pet] : [];
  },
  addEventListener(type, fn) {
    doc.listeners.set(type, fn);
  },
  removeEventListener(type) {
    doc.listeners.delete(type);
  },
};

let factory;
win.__ModuleLoader__ = {
  load(info) {
    factory = info.factory;
  },
};

// eslint-disable-next-line no-new-func
new Function('window', 'document', source)(win, doc);

assert.ok(factory, 'factory 未注册');

let effectCleanup;
const React = {
  createElement: () => null,
  useEffect(fn) {
    effectCleanup = fn();
  },
};

const moduleValue = factory((name) => (name === 'react' ? React : {}));
assert.equal(moduleValue.name, 'dsh-bigfeiyu-focus');

let registered;
const ctx = {
  slots: {
    inject(slot, fn) {
      assert.equal(slot, 'shell.overlay');
      fn();
    },
    register(options, component) {
      registered = { options, component };
      return () => {};
    },
  },
};
moduleValue.apply(ctx);

assert.ok(registered, '未注册 shell.overlay');
assert.equal(registered.options.id, 'bigfeiyu-focus');

// 挂载桥接组件：useEffect 会立刻安装引擎
assert.equal(registered.component(), null);
assert.equal(typeof effectCleanup, 'function');
assert.ok(head.child, '没有注入样式');
assert.ok(head.child.textContent.includes('.dsh-pet-root'), '样式内容不对');

function flush(times) {
  for (let i = 0; i < times; i++) {
    const pending = rafQueue.splice(0);
    if (pending.length === 0) return;
    const now = 16.67 * (i + 1);
    for (const fn of pending) fn(now);
  }
}

// 光标移到鱼的右上方
doc.listeners.get('pointerleave'); // 确保监听存在
win.listeners.get('pointermove')({ clientX: 1180, clientY: 120, timeStamp: 0 });
flush(60);

const ry = parseFloat(pet.style.getPropertyValue('--bfy-ry'));
const rx = parseFloat(pet.style.getPropertyValue('--bfy-rx'));
assert.ok(ry < -3, `光标在右时 rotateY 应为负，实际 ${ry}`);
assert.ok(rx > 1, `光标在上时 rotateX 应为正，实际 ${rx}`);

// 拖拽：姿态归零
pet.dragging = true;
flush(90);
const dragRy = Math.abs(parseFloat(pet.style.getPropertyValue('--bfy-ry')));
assert.ok(dragRy < 0.5, `拖拽时 rotateY 应归零，实际 ${dragRy}`);

// 卸载
effectCleanup();
assert.equal(head.child, null, '卸载后样式未移除');
assert.equal(pet.style.getPropertyValue('--bfy-ry'), '', '卸载后变量未清掉');

console.log('smoke OK: register / inject / gaze signs / drag reset / dispose');
