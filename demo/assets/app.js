/**
 * 演示站点的交互脚本（普通 ES 模块，无框架）。
 *
 * 它做三件真实项目里常见的事，用来验证插件的定位与写回：
 * 1. 从 `/src/components/Card.jsx` 取一段**组件源码**，按 JSX 形状渲染成 DOM
 * 2. 点击按钮触发交互（验证覆盖层不会拦截页面自身的点击逻辑）
 * 3. 延迟插入一段动态内容（验证「运行时才有的元素」在源码里找不到时的兜底）
 */

/**
 * 把一段 JSX 风格的源码适配成可渲染的 DOM。
 *
 * 刻意做得简单：只认 `class` 与文本，够演示「改画布 → 改源码」即可。
 * 真正的框架由用户自己的项目决定——插件的兼容性不依赖这里。
 *
 * @param source - 组件源码文本。
 * @returns DOM 节点。
 */
function renderComponentSource(source) {
	const wrapper = document.createElement("div");
	// 提取 return ( ... ) 里的第一个元素
	const match = /return\s*\(\s*([\s\S]*?)\s*\);\s*\}\s*$/u.exec(source);
	const body = match === null ? source : match[1];
	// 把 JSX 属性名换成 HTML 属性名，并把 {expr} 里的字符串取出来
	const html = body
		.replace(/className=/gu, "class=")
		.replace(/\{\s*"([^"]*)"\s*\}/gu, '"$1"')
		.replace(/\{\s*'([^']*)'\s*\}/gu, "'$1'")
		.replace(/\{\/\*[\s\S]*?\*\/\}/gu, "");
	wrapper.innerHTML = html.trim();
	return wrapper.firstElementChild ?? wrapper;
}

/** 取组件源码并渲染到页面上。 */
async function mountCard() {
	const host = document.getElementById("mounted-card");
	if (host === null) return;
	try {
		const response = await fetch("/src/components/Card.jsx");
		const source = await response.text();
		const node = renderComponentSource(source);
		host.append(node);
	} catch (error) {
		host.textContent = `组件加载失败：${String(error?.message ?? error)}`;
	}
}

/** 绑定按钮交互。 */
function bindActions() {
	const primary = document.getElementById("cta-primary");
	const secondary = document.getElementById("cta-secondary");
	const log = (text) => {
		const existing = document.getElementById("action-log");
		if (existing !== null) {
			existing.textContent = text;
			return;
		}
		const line = document.createElement("p");
		line.id = "action-log";
		line.className = "docs-note";
		line.textContent = text;
		document.querySelector(".hero-actions")?.append(line);
	};
	primary?.addEventListener("click", () => log("你点了「开始体验」——页面自身的点击逻辑正常，覆盖层没有拦它。"));
	secondary?.addEventListener("click", () => log("你点了「看文档」——可以试试用画布改这个按钮的颜色。"));
}

/** 延迟插入动态内容，用来验证「定位不到」时的表现。 */
function insertDynamic() {
	window.setTimeout(() => {
		const section = document.querySelector(".docs");
		if (section === null) return;
		const note = document.createElement("p");
		note.className = "docs-note dynamic-note";
		note.textContent = "这段内容是运行时插入的，源码里搜不到——插件应该如实告诉你「定位不到」，而不是乱改别处。";
		section.append(note);
	}, 2500);
}

void mountCard();
bindActions();
insertDynamic();
