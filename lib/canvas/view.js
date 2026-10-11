/**
 * 画布外壳的纯逻辑部分（不碰 DOM）。
 *
 * ## 为什么单独拆出来
 *
 * 「按路径分组」「搜索匹配」「居中到某块画板」这三件事都是**纯函数**，
 * 但原先写在 shell.js 里——那是个浏览器模块，一 import 就会去碰 `document`，
 * 于是 Node 里根本没法测，只能靠真浏览器点。
 *
 * 拆出来之后它们进了离线 harness，改一处立刻能验，不必启动浏览器。
 * 外壳只负责把它们接到界面上。
 */

/**
 * 按路径把画板分组。
 *
 * **为什么按路径分组**：同一个路由在手机/平板/桌面各开一块画板是常见需求，
 * 分组之后「同一页面的多设备对比」自然落在同一组里，一眼能看出哪几个是同一页面的变体。
 *
 * @param list - 画板数组。
 * @returns [{ path, items }]，顺序按各组第一块画板的出现顺序（不打乱用户的排布直觉）。
 */
export function groupByPath(list) {
	const groups = new Map();
	for (const item of list ?? []) {
		const key = item.path ?? "/";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(item);
	}
	return [...groups].map(([path, items]) => ({ path, items }));
}

/**
 * 判断一块画板是否匹配搜索词。
 *
 * 刻意把**规格**也纳入匹配：用户常常记得「那个要突出第三方登录的页面」，
 * 而不记得它叫什么名字。设备名同理（「手机」这种中文标签也该能搜到）。
 *
 * @param item - 画板。
 * @param query - 搜索词（调用方负责转小写；空串表示不过滤）。
 * @param devices - 设备预设表（用于把 device key 翻成中文标签）。
 * @returns 是否匹配。
 */
export function matchesQuery(item, query, devices) {
	if (query === undefined || query === null || query === "") return true;
	const haystack = [
		item?.name,
		item?.path,
		item?.spec,
		item?.device,
		devices?.[item?.device]?.label
	].filter((part) => typeof part === "string" && part !== "").join(" ").toLowerCase();
	return haystack.includes(String(query).toLowerCase());
}

/**
 * 算出「把某块画板居中」需要的平移量。
 *
 * 选中左侧列表里的一行时，如果那块画板在视野外，用户会觉得「点了没反应」，
 * 所以顺手把它挪到视野中央。这里只算平移，不动缩放——
 * 缩放突然变化比「没居中」更让人困惑。
 *
 * @param options - {
 *   rect: { x, y, w, h },        画板的世界坐标矩形,
 *   viewport: { width, height }, 视口尺寸,
 *   zoom,                        当前缩放,
 *   clampToVisible                是否把「已在视野内」的情况也强行居中（默认 false）
 * }。
 * @returns { panX, panY }。
 */
export function centerPan(options) {
	const { rect, viewport, zoom } = options;
	const panX = viewport.width / 2 - (rect.x + rect.w / 2) * zoom;
	const panY = viewport.height / 2 - (rect.y + rect.h / 2) * zoom;
	return { panX, panY };
}

/**
 * 合并多个画板的包围盒（用于「适应」）。
 *
 * @param list - 画板数组。
 * @returns { minX, minY, maxX, maxY } 或 null（没有画板时）。
 */
export function boundsOf(list) {
	if (!Array.isArray(list) || list.length === 0) return null;
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const item of list) {
		const rect = item?.rect;
		if (rect === undefined || rect === null) continue;
		minX = Math.min(minX, rect.x);
		minY = Math.min(minY, rect.y);
		maxX = Math.max(maxX, rect.x + rect.w);
		maxY = Math.max(maxY, rect.y + rect.h);
	}
	if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
	return { minX, minY, maxX, maxY };
}

/**
 * 把「工具写下的 translate 链」合并成一段。
 *
 * ## 为什么需要
 *
 * 拖动是**相对**的：本次位移要叠加在已有偏移上，否则拖两次只有最后一次生效。
 * 但叠加如果只是不断往前面拼，每拖一次就多一段——
 * 实测拖了六次之后源码里长这样：
 *
 *     transform: translate(638px,0) translate(-616px,1) translate(-11px,0) ...
 *
 * 净效果没错，但**没人能从这行看出元素到底偏了多少**，而且误差会逐段累积。
 * 所以这里把「开头连续若干段纯 translate」加总成一段，后面跟着的
 * 作者自己写的变换原样保留。
 *
 * @param transform - 现有 transform 值。
 * @returns { prefix, rest }：prefix 是合并后的位移（可能为空串），rest 是作者的其余变换。
 */
export function collapseTranslates(transform) {
	const text = String(transform ?? "").trim();
	if (text === "") return { prefix: "", rest: "" };
	const pattern = /^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)\s*/u;
	let x = 0;
	let y = 0;
	let rest = text;
	let matched = false;
	while (true) {
		const found = pattern.exec(rest);
		if (found === null) break;
		x += Number(found[1]);
		y += Number(found[2]);
		rest = rest.slice(found[0].length);
		matched = true;
	}
	if (!matched) return { prefix: "", rest: text };
	const round = (n) => Math.round(n * 1000) / 1000;
	return { prefix: `translate(${round(x)}px, ${round(y)}px)`, rest: rest.trim() };
}

/**
 * 把新位移叠到现有 transform 上，并把工具写的 translate 链合并。
 *
 * @param dx - 本次水平位移。
 * @param dy - 本次垂直位移。
 * @param originTransform - 元素现有的 transform。
 * @returns 新的 transform 值。
 */
export function composeTransform(dx, dy, originTransform) {
	const { prefix, rest } = collapseTranslates(originTransform);
	const pattern = /^translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)$/u;
	const found = pattern.exec(prefix);
	const baseX = found === null ? 0 : Number(found[1]);
	const baseY = found === null ? 0 : Number(found[2]);
	const x = Math.round((baseX + dx) * 1000) / 1000;
	const y = Math.round((baseY + dy) * 1000) / 1000;
	const translate = `translate(${x}px, ${y}px)`;
	// 位移为 0 且没有作者的变换时，干脆不要这个属性，别留一个 translate(0px, 0px)
	if (rest === "" && x === 0 && y === 0) return "";
	return rest === "" ? translate : `${translate} ${rest}`;
}

/**
 * 算出拖动时的吸附位置与要画的辅助线。
 *
 * 做成纯函数是刻意的：吸附是纯粹的几何计算，**用真浏览器测它既慢又难断言**
 *（要造出恰好对齐的布局），而它又是最容易算错的部分——阈值、中心线、
 * 垂直/水平两轴互相影响。纯函数可以拿人造矩形反复验。
 *
 * ## 吸附的是哪几条线
 *
 * 每个候选矩形提供三条竖线（左 / 中心 / 右）和三条横线（上 / 中 / 下）。
 * 被拖元素的同三类线去和它们比，取**最近且小于阈值**的一条。
 *
 * 中心线必须参与：设计里"居中对齐"和"边缘对齐"一样常用，
 * 只做边缘的话居中对齐永远吸不上。
 *
 * ## 两轴独立
 *
 * X 和 Y 分开算，各自取最优。不这么做的话，一个轴上差 1px、另一个轴差 5px 时，
 * 会为了迁就某个"总距离最小"而让两个轴都不对齐。
 *
 * @param moving - 被拖元素的基准矩形 { left, top, width, height }（**不含本次位移**）。
 * @param dx - 本次水平位移。
 * @param dy - 本次垂直位移。
 * @param targets - 候选矩形数组，每项 { left, top, width, height, label }。
 * @param threshold - 吸附阈值（画板坐标系像素）。
 * @returns { dx, dy, guides } —— 修正后的位移，以及要画的线。
 *   guides 每项 { axis, at, from, to }，坐标同为画板坐标系。
 */
export function computeSnap(moving, dx, dy, targets, threshold = 6) {
	const left = moving.left + dx;
	const top = moving.top + dy;
	const right = left + moving.width;
	const centerX = left + moving.width / 2;
	const bottom = top + moving.height;
	const centerY = top + moving.height / 2;

	// 被拖元素的三条竖线 / 三条横线
	const movingX = [left, centerX, right];
	const movingY = [top, centerY, bottom];

	let bestX = null;
	let bestY = null;

	for (const target of targets) {
		const targetX = [target.left, target.left + target.width / 2, target.left + target.width];
		const targetY = [target.top, target.top + target.height / 2, target.top + target.height];

		for (const line of movingX) {
			for (const at of targetX) {
				const distance = Math.abs(at - line);
				if (distance > threshold) continue;
				if (bestX === null || distance < bestX.distance) {
					// 吸附量 = 目标线 - 当前线，加回位移上就对齐了
					bestX = { distance, delta: at - line, at, span: target };
				}
			}
		}
		for (const line of movingY) {
			for (const at of targetY) {
				const distance = Math.abs(at - line);
				if (distance > threshold) continue;
				if (bestY === null || distance < bestY.distance) {
					bestY = { distance, delta: at - line, at, span: target };
				}
			}
		}
	}

	const guides = [];
	if (bestX !== null) {
		// 辅助线要**横跨被拖元素和参照物**，否则一条孤零零的短线看不出在和谁对齐
		const top1 = Math.min(top, bestX.span.top);
		const bottom1 = Math.max(bottom, bestX.span.top + bestX.span.height);
		guides.push({ axis: "x", at: bestX.at, from: top1, to: bottom1 });
	}
	if (bestY !== null) {
		const left1 = Math.min(left, bestY.span.left);
		const right1 = Math.max(right, bestY.span.left + bestY.span.width);
		guides.push({ axis: "y", at: bestY.at, from: left1, to: right1 });
	}

	return { dx: dx + (bestX?.delta ?? 0), dy: dy + (bestY?.delta ?? 0), guides };
}
