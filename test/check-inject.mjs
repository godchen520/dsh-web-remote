// 注入脚本前置自检 —— **必须在 test-dist.mjs 之前跑**。
//
// 为什么单独一个文件：`test-dist.mjs` 第 13 行是静态 import
//     import { INJECT_SCRIPT } from '../lib/panel.mjs'
// 所以 panel.mjs 一旦语法坏掉，**整个测试文件加载不起来**，里面写多少守卫都没用
// —— 连守卫 ⓪ 都跑不到，只能看到一个晦涩的模块加载错误。
//
// 而 `lib/panel.mjs` 整体是一个反引号模板字符串：
//     export const INJECT_SCRIPT = `(function () { ... })();`
// 注释里**混进一个反引号**就会把整个注入脚本截断。这个坑在本仓库踩过三次，
// 每次都是 `node --check` 查不出来（它只查宿主文件，宿主文件语法是好的）。
//
// 所以第一步只做一件事：**数反引号**。它不需要 import，坏文件也能跑。
import fs from 'node:fs';

const PANEL = new URL('../lib/panel.mjs', import.meta.url);
const raw = fs.readFileSync(PANEL, 'utf8');

const bt = (raw.match(/`/g) || []).length;
if (bt !== 2) {
  const lines = raw.split('\n');
  const bad = lines
    .map((l, i) => (l.includes('`') && i !== 0 && i !== lines.length - 1 ? { n: i + 1, l: l.trim() } : null))
    .filter(Boolean);
  console.error('注入脚本自检：panel.mjs 里的反引号有 ' + bt + ' 个，应该是 2 个（模板的首尾边界）。');
  console.error('多半是注释里写了反引号 —— 它会把整个注入脚本截断，而 node --check 查不出来。');
  for (const b of bad.slice(0, 8)) console.error('  第 ' + b.n + ' 行: ' + b.l.slice(0, 100));
  process.exit(1);
}

// 反引号数对 → 模块能正常加载 → 再验证**求值后**的注入脚本本身是合法 JS。
// 注意不能用模板的原文切片：里面有 \\' 这类转义（如字体名 \'SF Pro Text\'），
// 原文切片喂给 new Function 会误报（踩过）。
let mod;
try {
  mod = await import(PANEL.href);
} catch (e) {
  console.error('注入脚本自检：lib/panel.mjs 无法加载：' + e.message);
  process.exit(1);
}
if (typeof mod.INJECT_SCRIPT !== 'string' || mod.INJECT_SCRIPT.length === 0) {
  console.error('注入脚本自检：lib/panel.mjs 没有导出非空的 INJECT_SCRIPT');
  process.exit(1);
}
try {
  new Function(mod.INJECT_SCRIPT);
} catch (e) {
  console.error('注入脚本自检：注入脚本不是合法 JS（模板被截断了？）：' + e.message);
  process.exit(1);
}

console.log('注入脚本自检 OK（反引号 2 个 + 求值后可解析，' + mod.INJECT_SCRIPT.length + ' 字符）');
