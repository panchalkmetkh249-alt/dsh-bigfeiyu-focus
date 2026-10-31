/**
 * dsh-bigfeiyu-focus 的宿主半边。
 *
 * 这个插件不需要任何宿主能力：不注册 Service、不注册 Tool、不写文件、
 * 不联网。所有行为都在浏览器半边（client.js）里完成，宿主只负责让
 * bundle 行出现在配置树里，从而把 client.js 注入页面。
 */
export function apply() {}
