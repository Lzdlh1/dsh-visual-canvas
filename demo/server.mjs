/**
 * 零依赖演示站点：用 Node 内置 http 起一个「像真实前端项目」的页面。
 *
 * ## 为什么不用 Vite
 *
 * 演示的目的是验证插件的完整链路（代理注入 → 覆盖层 → 定位 → 写回），
 * 而不是验证某个构建工具。用内置 http 起一个多文件站点即可，
 * 而且**一个依赖都不装**，离线可跑——这与插件本身的原则一致。
 *
 * 它刻意模仿真实项目的几个特征，用来验证插件的健壮性：
 * - 绝对路径资源（`/styles.css`、`/assets/app.js`）→ 验证 `<base>` 前缀方案
 * - 行内样式与 class 混用 → 验证两种写回
 * - 一份 React 风格组件文件（`src/components/Card.jsx`）→ 验证「改画布 → 改源码」
 * - 动态插入的内容 → 验证定位不到时的兜底行为
 *
 * 启动：node demo/server.mjs [端口]
 * 默认端口 5173（与插件默认 target 一致）。
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] ?? 5173);

/** 扩展名 → content-type。 */
const TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".mjs": "application/javascript; charset=utf-8",
	// 演示用的组件文件按**纯文本**返回：它是要给人看、给插件改的源码，
	// 浏览器直接执行会报语法错（里面是 JSX 形状而不是合法 JS）。
	".jsx": "text/plain; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png"
};

/**
 * 应答一个文件。
 * @param res - 响应。
 * @param path - 文件绝对路径。
 */
function sendFile(res, path) {
	const type = TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
	try {
		const body = readFileSync(path);
		res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
		res.end(body);
	} catch {
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end(`404 ${path}`);
	}
}

/**
 * 生成首页 HTML。
 *
 * 注意资源用的是**绝对路径**（`/styles.css`）——这正是插件用 `<base>` 要解决的场景。
 *
 * @returns HTML 文本。
 */
function renderIndex() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Visual Canvas 演示站点</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<header class="topbar">
  <h1 class="brand">Visual Canvas 演示</h1>
  <nav class="nav">
    <a class="nav-link is-active" href="#features">功能</a>
    <a class="nav-link" href="#pricing">价格</a>
    <a class="nav-link" href="#docs">文档</a>
  </nav>
</header>

<main class="page">
  <section class="hero" id="features">
    <h2 class="hero-title">点一下，改一处，源码跟着变</h2>
    <p class="hero-sub">在浏览器里选中元素、拖动、改颜色，改动会写回下面这些真实源文件。</p>
    <div class="hero-actions">
      <button class="btn btn-primary" id="cta-primary">开始体验</button>
      <button class="btn btn-ghost" id="cta-secondary">看文档</button>
    </div>
  </section>

  <section class="cards" id="pricing">
    <article class="card" data-plan="starter">
      <h3 class="card-title">起步版</h3>
      <p class="card-price">¥0</p>
      <p class="card-desc">个人项目随便用，改完就写回你的仓库。</p>
    </article>
    <article class="card card-featured" data-plan="pro">
      <h3 class="card-title">专业版</h3>
      <p class="card-price">¥29</p>
      <p class="card-desc">多人协作、断点编辑、快照回滚。</p>
    </article>
    <article class="card" data-plan="team">
      <h3 class="card-title">团队版</h3>
      <p class="card-price">¥99</p>
      <p class="card-desc">共享画布、权限分级、审计日志。</p>
    </article>
  </section>

  <section class="docs" id="docs">
    <h2 class="docs-title">怎么用</h2>
    <ul class="docs-list">
      <li>点任意元素选中它，右下角的路径就是它在源码里的位置。</li>
      <li>右侧面板改颜色、字号、间距；拖动元素改位置，拖四角改尺寸。</li>
      <li>改完看源文件——值已经写进去了。</li>
    </ul>
    <p class="docs-note">这段文字与上面的列表都在 <code>demo/index.html</code> 的模板里；
    下面这张卡片来自 <code>demo/src/components/Card.jsx</code>。</p>
    <div id="mounted-card"></div>
  </section>
</main>

<footer class="footer">
  <span class="footer-text">零依赖演示站点 · 由 Node 内置 http 提供</span>
</footer>

<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;
}

/**
 * 生成登录页。
 *
 * 加这个页面是为了让**画布有多块画板可摆**：单页站点演示不了「多画板 + 同路径多设备」，
 * 而那是画布存在的理由。页面本身也刻意做成真实登录页的形状（表单 + 第三方登录入口），
 * 这样画板上的「规格」（例如"要突出第三方登录"）才有得对应。
 *
 * @returns HTML 文本。
 */
function renderLogin() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · Visual Canvas 演示站点</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="auth-body">
<main class="auth-card">
  <h1 class="auth-title">欢迎回来</h1>
  <p class="auth-sub">登录后继续你的项目</p>

  <form class="auth-form" id="login-form">
    <label class="field">
      <span class="field-label">邮箱</span>
      <input class="field-input" type="email" id="login-email" placeholder="you@example.com">
    </label>
    <label class="field">
      <span class="field-label">密码</span>
      <input class="field-input" type="password" id="login-password" placeholder="••••••••">
    </label>
    <button class="btn btn-primary btn-block" type="submit" id="login-submit">登录</button>
  </form>

  <div class="auth-divider"><span>或</span></div>

  <div class="auth-social">
    <button class="btn btn-ghost btn-block" id="login-github">用 GitHub 登录</button>
    <button class="btn btn-ghost btn-block" id="login-wechat">用微信登录</button>
  </div>

  <p class="auth-foot">还没有账号？<a class="auth-link" href="#signup">立即注册</a></p>
</main>
</body>
</html>
`;
}

/**
 * 生成设置页。
 *
 * 同样是为了给画布多一块画板；内容选「设置页」是因为它天然包含
 * 表单、开关、危险操作区三类典型控件，适合验证样式写回。
 *
 * @returns HTML 文本。
 */
function renderSettings() {
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>设置 · Visual Canvas 演示站点</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="settings-body">
<header class="topbar">
  <h1 class="brand">设置</h1>
  <nav class="nav">
    <a class="nav-link is-active" href="#profile">个人资料</a>
    <a class="nav-link" href="#notify">通知</a>
    <a class="nav-link" href="#danger">危险区</a>
  </nav>
</header>

<main class="page">
  <section class="settings-section" id="profile">
    <h2 class="settings-title">个人资料</h2>
    <div class="settings-row">
      <label class="field">
        <span class="field-label">显示名称</span>
        <input class="field-input" type="text" id="settings-name" value="张三">
      </label>
      <label class="field">
        <span class="field-label">邮箱</span>
        <input class="field-input" type="email" id="settings-email" value="zhangsan@example.com">
      </label>
    </div>
    <button class="btn btn-primary" id="settings-save">保存修改</button>
  </section>

  <section class="settings-section" id="notify">
    <h2 class="settings-title">通知</h2>
    <label class="toggle">
      <input type="checkbox" id="notify-email" checked>
      <span class="toggle-text">邮件通知</span>
    </label>
    <label class="toggle">
      <input type="checkbox" id="notify-push">
      <span class="toggle-text">推送通知</span>
    </label>
  </section>

  <section class="settings-section settings-danger" id="danger">
    <h2 class="settings-title">危险区</h2>
    <p class="settings-desc">删除账号不可撤销，所有项目与画布都会一并移除。</p>
    <button class="btn btn-danger" id="settings-delete">删除账号</button>
  </section>
</main>

<footer class="footer">
  <span class="footer-text">零依赖演示站点 · 由 Node 内置 http 提供</span>
</footer>
</body>
</html>
`;
}

const server = createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	const pathname = decodeURIComponent(url.pathname);

	// 演示站点自己要「像」一个真实 dev server：不缓存，方便反复验证。
	if (pathname === "/" || pathname === "/index.html") {
		const html = renderIndex();
		res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
		res.end(html);
		return;
	}

	// 多页面：给画布提供多块可摆的画板。
	const pages = { "/login": renderLogin, "/settings": renderSettings };
	const render = Object.hasOwn(pages, pathname) ? pages[pathname] : undefined;
	if (render !== undefined) {
		res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
		res.end(render());
		return;
	}

	// 插件 UI 原型：由演示站点把它暴露成普通路由，画布才能当画板编辑它。
	// 画布改不了自己的外壳（外壳是壳，不是画板），所以目标 UI 先以页面形式存在，
	// 定型后再移植进 lib/canvas/shell.html。文件本体在插件目录里，
	// 于是这份原型既是交付物的一部分，又能被自家工具编辑——一举两得。
	if (pathname === "/plugin-ui") {
		const file = resolve(join(here, "..", "lib", "canvas", "ui", "prototype.html"));
		if (existsSync(file)) {
			sendFile(res, file);
			return;
		}
		res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		res.end("404 找不到插件 UI 原型：lib/canvas/ui/prototype.html");
		return;
	}

	// 把 /src/... 与 /assets/... 映射到磁盘。
	const root = resolve(here);
	const target = resolve(join(root, normalize(pathname).replace(/^([/\\])+/u, "")));
	if (!target.startsWith(root)) {
		res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
		res.end("403");
		return;
	}
	if (existsSync(target) && statSync(target).isFile()) {
		sendFile(res, target);
		return;
	}
	// 演示用的「组件文件」直接以源码文本返回，方便人肉查看改了没。
	if (pathname.startsWith("/src/")) {
		const src = resolve(join(root, pathname.replace(/^\//u, "")));
		if (existsSync(src)) {
			sendFile(res, src);
			return;
		}
	}
	res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
	res.end(`404 ${pathname}`);
});

server.listen(port, "127.0.0.1", () => {
	console.log(`演示站点已启动：http://127.0.0.1:${port}/`);
	console.log(`把它作为插件的 target 即可：target: "http://127.0.0.1:${port}"`);
});
