/**
 * 图形绘制：在画板上拖出矩形等图形，落成真实的 HTML 元素。
 *
 * ## 为什么单独成模块
 *
 * 绘制是"新交互"——它要往画板 iframe 的 document 上挂鼠标监听、维护一个
 * 临时预览元素、在松手时算最终尺寸。这些和外壳的布局/面板逻辑没有关系，
 * 混进 `shell.js`（已经 50KB+）只会让两边都难改。
 *
 * 模块只负责"从拖拽得到一个矩形"，**落盘交给调用方**（走既有的 `mutate` 通路）。
 * 这样撤销、快照、冲突检测全都自动继承——**自己写一套写入逻辑就会丢掉这些**。
 *
 * ## 坐标：画板内坐标，不乘 zoom
 *
 * 绘制发生在画板 iframe **内部**，`getBoundingClientRect()` 给的是画板自己的坐标系。
 * 外壳的 `panX/panY/zoom` 是**另一层**的变换，在这里用不上。
 *
 * **乘上去就错**：外壳缩放到 51% 时，画 100px 会长成 196px。
 * 步骤 0 验证过：外壳缩放前后，画板内元素的 `left/top` 保持 100/50 不变。
 */

/** 拖拽小于这个像素数算"误触"，不生成元素——避免手抖点一下多出一个 1px 的方块。 */
const MIN_DRAG = 6;

/** 直线的默认粗细（画板内像素）。 */
const LINE_THICKNESS = 2;

/**
 * 多边形 / 装饰形状的 `clip-path` 预设。
 *
 * ## 为什么用 `clip-path` 而不是 SVG 或 border 技巧
 *
 * - **不改盒模型**：`clip-path` 只是裁掉显示区域，元素的 `left/top/width/height`
 *   仍是那个矩形 —— 于是拖动、缩放、写回源码**全部沿用现有逻辑，一行都不用改**。
 *   用 `border` 画三角形那种技巧会改盒模型，拖动立刻对不上。
 * - **能进源码**：它就是一条普通 CSS 声明，写进 `style` 后导出到任何运行时都成立。
 *
 * ## ⚠️ 这份清单和 `lib/overlay/editor.js` 里「轮廓」字段的预设是同一批
 *
 * 那边是给**已有元素**换轮廓用的，这里是**画新形状**用的。两处重复是刻意的：
 * `editor.js` 是**零依赖**模块（面板要能单独加载），为共享一个常量去 import
 * 会把依赖带进去。改这里时记得同步那边。
 */
export const CLIP_SHAPES = {
	triangle: "polygon(50% 0%, 100% 100%, 0% 100%)",
	triangleDown: "polygon(0% 0%, 100% 0%, 50% 100%)",
	diamond: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)",
	hexagon: "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)",
	star: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)",
	arrowRight: "polygon(0% 20%, 60% 20%, 60% 0%, 100% 50%, 60% 100%, 60% 80%, 0% 80%)",
	bubble: "polygon(0% 0%, 100% 0%, 100% 75%, 75% 75%, 75% 100%, 50% 75%, 0% 75%)",
	pill: "inset(0 round 999px)",
	slanted: "polygon(12% 0%, 100% 0%, 88% 100%, 0% 100%)",
	chevron: "polygon(0% 0%, 75% 0%, 100% 50%, 75% 100%, 0% 100%, 25% 50%)",
	cross: "polygon(35% 0%, 65% 0%, 65% 35%, 100% 35%, 100% 65%, 65% 65%, 65% 100%, 35% 100%, 35% 65%, 0% 65%, 0% 35%, 35% 35%)",

	// ---- 第二批（2026-10-08 扩充：15 → 30 种）
	//
	// 挑选标准：**常见于真实界面**，而不是"能画出来好玩"。
	// 比如平行四边形（按钮斜切）、梯形（标签页）、书签（收藏）、
	// 拱门（头像框/卡片顶）、八角形（审批/徽章）都是会真的用到的。
	parallelogram: "polygon(18% 0%, 100% 0%, 82% 100%, 0% 100%)",
	trapezoid: "polygon(18% 0%, 82% 0%, 100% 100%, 0% 100%)",
	octagon: "polygon(30% 0%, 70% 0%, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0% 70%, 0% 30%)",
	semicircle: "inset(0 0 50% 0 round 999px 999px 0 0)",
	arch: "inset(0 0 0 0 round 50% 50% 8px 8px)",
	notchLeft: "polygon(22% 0%, 100% 0%, 100% 100%, 22% 100%, 0% 50%)",
	notchRight: "polygon(0% 0%, 78% 0%, 100% 50%, 78% 100%, 0% 100%)",
	arrowLeft: "polygon(40% 20%, 100% 20%, 100% 80%, 40% 80%, 40% 100%, 0% 50%, 40% 0%)",
	arrowUp: "polygon(20% 40%, 50% 0%, 80% 40%, 80% 100%, 20% 100%)",
	arrowBoth: "polygon(0% 50%, 22% 20%, 22% 40%, 78% 40%, 78% 20%, 100% 50%, 78% 80%, 78% 60%, 22% 60%, 22% 80%)",
	star4: "polygon(50% 0%, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0% 50%, 38% 38%)",
	star6: "polygon(50% 0%, 63% 25%, 93% 25%, 75% 50%, 93% 75%, 63% 75%, 50% 100%, 37% 75%, 7% 75%, 25% 50%, 7% 25%, 37% 25%)",
	burst: "polygon(50% 0%, 58% 20%, 76% 8%, 74% 30%, 96% 30%, 80% 45%, 100% 58%, 78% 62%, 86% 84%, 62% 74%, 56% 100%, 44% 78%, 24% 94%, 26% 70%, 2% 68%, 20% 50%, 0% 34%, 24% 32%, 18% 8%, 42% 22%)",
	tag: "polygon(0% 0%, 78% 0%, 100% 50%, 78% 100%, 0% 100%)",
	bookmark: "polygon(0% 0%, 100% 0%, 100% 100%, 50% 76%, 0% 100%)",
	ribbon: "polygon(0% 0%, 100% 0%, 100% 72%, 50% 100%, 0% 72%)",
	drop: "polygon(50% 0%, 82% 30%, 100% 58%, 88% 84%, 50% 100%, 12% 84%, 0% 58%, 18% 30%)"
};

/**
 * 图形目录。
 *
 * `drag` 是形状之间**唯一的本质差别**——它决定"拖出来的那个矩形"是什么意思：
 *
 * | drag | 含义 | 拖出的矩形代表 |
 * |---|---|---|
 * | `box` | 包围盒 | 形状本身的框（矩形 / 椭圆 / 文本 / 所有多边形） |
 * | `line` | 两个端点 | 线**两端所在的对角框**，线从起点直连终点 |
 *
 * 这个区分不能省。斜着拖时"包围盒"和"起点→终点"完全是两个东西：
 * 把线当包围盒画，用户往右下拖出来的线会跑到左上角去。
 *
 * `group` 只影响**形状条怎么排**（十几个挤一行会看不清），不影响行为。
 */
export const SHAPE_LIST = [
	// ---- 基本
	{ id: "rect", name: "矩形", art: "▭", drag: "box", group: "基本" },
	{ id: "ellipse", name: "椭圆", art: "◯", drag: "box", group: "基本" },
	{ id: "line", name: "直线", art: "╱", drag: "line", group: "基本" },
	{ id: "text", name: "文本", art: "T", drag: "box", group: "基本" },

	// ---- 多边形（全部靠 clip-path，几何逻辑沿用 box）
	//
	// 这些形状**一行代码都不用改绘制逻辑**：拖出来还是那个矩形，
	// 只是显示时被裁成了别的样子。拖动/缩放/写回源码完全照旧。
	{ id: "triangle", name: "三角形", art: "△", drag: "box", group: "多边形" },
	{ id: "triangleDown", name: "倒三角", art: "▽", drag: "box", group: "多边形" },
	{ id: "diamond", name: "菱形", art: "◇", drag: "box", group: "多边形" },
	{ id: "hexagon", name: "六边形", art: "⬡", drag: "box", group: "多边形" },
	{ id: "slanted", name: "斜切", art: "▱", drag: "box", group: "多边形" },

	// ---- 装饰
	{ id: "star", name: "五角星", art: "★", drag: "box", group: "装饰" },
	{ id: "pill", name: "胶囊", art: "⬭", drag: "box", group: "装饰" },
	{ id: "bubble", name: "对话气泡", art: "🗨", drag: "box", group: "装饰" },
	{ id: "arrowRight", name: "右箭头", art: "➜", drag: "box", group: "装饰" },
	{ id: "chevron", name: "尖角条", art: "❯", drag: "box", group: "装饰" },
	{ id: "cross", name: "十字", art: "✚", drag: "box", group: "装饰" },

	// ---- 第二批（2026-10-08：15 → 32 种）
	//
	// 挑选标准是**真实界面里会用到**，不是"能画出来好玩"：
	// 平行四边形做斜切按钮、梯形做标签页、书签做收藏、拱门做头像框、
	// 八角形做审批徽章 —— 这些都是日常会画的东西。
	{ id: "parallelogram", name: "平行四边形", art: "▰", drag: "box", group: "多边形" },
	{ id: "trapezoid", name: "梯形", art: "⏢", drag: "box", group: "多边形" },
	{ id: "octagon", name: "八角形", art: "⯃", drag: "box", group: "多边形" },
	{ id: "notchLeft", name: "左缺口", art: "◀", drag: "box", group: "多边形" },
	{ id: "notchRight", name: "右缺口", art: "▶", drag: "box", group: "多边形" },
	{ id: "semicircle", name: "半圆", art: "◗", drag: "box", group: "多边形" },
	{ id: "arch", name: "拱门", art: "⌒", drag: "box", group: "多边形" },

	{ id: "arrowLeft", name: "左箭头", art: "⬅", drag: "box", group: "箭头" },
	{ id: "arrowUp", name: "上箭头", art: "⬆", drag: "box", group: "箭头" },
	{ id: "arrowBoth", name: "双向箭头", art: "⬌", drag: "box", group: "箭头" },

	{ id: "star4", name: "四角星", art: "✦", drag: "box", group: "装饰" },
	{ id: "star6", name: "六角星", art: "✶", drag: "box", group: "装饰" },
	{ id: "burst", name: "爆炸形", art: "✹", drag: "box", group: "装饰" },
	{ id: "tag", name: "标签", art: "🏷", drag: "box", group: "装饰" },
	{ id: "bookmark", name: "书签", art: "🔖", drag: "box", group: "装饰" },
	{ id: "ribbon", name: "缎带", art: "🎗", drag: "box", group: "装饰" },
	{ id: "drop", name: "水滴", art: "💧", drag: "box", group: "装饰" }
];

/**
 * 各形状的默认外观。
 *
 * ## ⚠️ 绝对不能用 CSS 变量（`var(--xxx)`）
 *
 * 画板是**用户自己的页面**，里面没有外壳的 CSS 令牌。
 *
 * 实测踩过：矩形的默认样式写成 `background: var(--accent)` →
 * 变量不存在 → 背景解析失败 + 没有边框 → **画出来的形状完全看不见**，
 * 而 DOM 里确实有那个元素。排查了很久才定位到"是颜色解析失败，不是没插进去"。
 *
 * 所以这里一律用**字面色值**，保证在任何页面里都能显示。
 */
export const SHAPE_DEFAULT_STYLE = {
	rect: { background: "#4285f4", "border-radius": "8px" },
	// 50% 半径 = 椭圆；拖成正方形就是正圆
	ellipse: { background: "#4285f4", "border-radius": "50%" },
	// 线用 background 而不是 border：border 会参与盒模型计算、把元素撑大，
	// 而拖动/缩放写回改的是 width/height，用 background 语义更直。
	//
	// ⚠️ **这里不要写 `height`**：线的粗细由几何里的 `width/height` 决定
	// （`geometryOf` 用 `LINE_THICKNESS` 填的）。两处都给 height，
	// 生成的样式串里会出现**两个 height 声明**，后者覆盖前者——
	// 改线粗时改了这边、那边不生效，是那种"改了半天没反应"的坑。
	line: { background: "#5f6368" },
	text: { color: "#202124", "font-size": "16px", "line-height": "1.6" },

	// ---- 多边形 / 装饰：唯一的差别就是这一条 clip-path
	//
	// 都不写 `border-radius`：裁切形状和圆角叠加会得到意料之外的轮廓
	//（比如三角形被圆角切掉尖角），要圆角让用户自己在面板里调。
	triangle: { background: "#4285f4", "clip-path": CLIP_SHAPES.triangle },
	triangleDown: { background: "#4285f4", "clip-path": CLIP_SHAPES.triangleDown },
	diamond: { background: "#4285f4", "clip-path": CLIP_SHAPES.diamond },
	hexagon: { background: "#4285f4", "clip-path": CLIP_SHAPES.hexagon },
	slanted: { background: "#4285f4", "clip-path": CLIP_SHAPES.slanted },
	star: { background: "#f9ab00", "clip-path": CLIP_SHAPES.star },
	pill: { background: "#4285f4", "clip-path": CLIP_SHAPES.pill },
	bubble: { background: "#1e8e3e", "clip-path": CLIP_SHAPES.bubble },
	arrowRight: { background: "#d93025", "clip-path": CLIP_SHAPES.arrowRight },
	chevron: { background: "#9334e6", "clip-path": CLIP_SHAPES.chevron },
	cross: { background: "#5f6368", "clip-path": CLIP_SHAPES.cross },

	// ---- 第二批：同样只差一条 clip-path
	//
	// 颜色按用途选，不是随手挑：多边形用主色（结构元素）、
	// 箭头用深灰（导航/指示）、星标和标签用暖色（强调/收藏）、
	// 书签缎带用红（收藏/活动）。
	parallelogram: { background: "#4285f4", "clip-path": CLIP_SHAPES.parallelogram },
	trapezoid: { background: "#4285f4", "clip-path": CLIP_SHAPES.trapezoid },
	octagon: { background: "#5f6368", "clip-path": CLIP_SHAPES.octagon },
	notchLeft: { background: "#4285f4", "clip-path": CLIP_SHAPES.notchLeft },
	notchRight: { background: "#4285f4", "clip-path": CLIP_SHAPES.notchRight },
	semicircle: { background: "#4285f4", "clip-path": CLIP_SHAPES.semicircle },
	arch: { background: "#1e8e3e", "clip-path": CLIP_SHAPES.arch },
	arrowLeft: { background: "#5f6368", "clip-path": CLIP_SHAPES.arrowLeft },
	arrowUp: { background: "#5f6368", "clip-path": CLIP_SHAPES.arrowUp },
	arrowBoth: { background: "#5f6368", "clip-path": CLIP_SHAPES.arrowBoth },
	star4: { background: "#f9ab00", "clip-path": CLIP_SHAPES.star4 },
	star6: { background: "#f9ab00", "clip-path": CLIP_SHAPES.star6 },
	burst: { background: "#f9ab00", "clip-path": CLIP_SHAPES.burst },
	tag: { background: "#9334e6", "clip-path": CLIP_SHAPES.tag },
	bookmark: { background: "#d93025", "clip-path": CLIP_SHAPES.bookmark },
	ribbon: { background: "#d93025", "clip-path": CLIP_SHAPES.ribbon },
	drop: { background: "#4c9aff", "clip-path": CLIP_SHAPES.drop }
};

/** 文本形状的占位内容（插进去之后用户自己去源码里改文字）。 */
export const TEXT_PLACEHOLDER = "文本";


/**
 * 效果的**运行时样式**。
 *
 * ## 为什么不写进源码
 *
 * 面板上选的「下坠感 / 悬停展菜单」产出的是 `data-effect="press"` 这样的**意图标记**，
 * 而这段 CSS 是**解释这个意图的实现**。
 *
 * 两者分开是刻意的：
 * - `data-*` 进源码 → 导出后任何运行时都能读，不绑死在我们的实现上
 * - 这段 CSS 运行时注入 → 设计时**能看到效果**，但不会被当成"业务代码"写进用户的页面
 *
 * 如果把它也写进源码，用户导出的页面里就会莫名其妙多出一段
 * `[data-effect]` 的全局样式——那是我们的实现细节，不是他的页面该承担的东西。
 *
 * ## 三个效果都是纯 CSS
 *
 * 所以**选完立刻能看到**，不需要跑任何脚本。
 * 悬停两个用 `::after` 造提示符——**不伪造菜单内容**：
 * 真的菜单要有真的条目，那是用户后面自己填的东西，这里只表达"会展开"。
 */
export const EFFECT_CSS = `
/* ============ 按压 ============
 *
 * 用户要的是「类似键盘效果，有**沉下去和弹起来**的感觉」。
 *
 * ## ⚠️ 必须用独立的 translate 属性，不能写 transform: translateY()
 *
 * 画板里的形状靠 transform: translate(Xpx, Ypx) 定位（拖动/写回都改它）。
 * 而 transform 是**整体覆盖**的 —— 在 :active 里写 transform: translateY(3px)
 * 会把定位那一段冲掉，按压的瞬间形状**瞬移回原点**。
 *
 * CSS 的 translate / scale / rotate 是**独立属性**，和 transform 叠加，
 * 所以用它就只影响按压位移，定位纹丝不动。（Chrome/Edge 104+ 支持。）
 */
[data-effect="press"] {
	transition: translate .16s cubic-bezier(.34, 1.56, .64, 1),
	            box-shadow .16s ease;
}
[data-effect="press"]:active {
	translate: 0 3px;
	/* 内阴影：让人看出"真的被按进去了"，只靠位移是不够的 */
	box-shadow: inset 0 2px 6px rgba(0, 0, 0, .28);
}

[data-effect="press-soft"] { transition: translate .12s ease; }
[data-effect="press-soft"]:active { translate: 0 1px; }

/* 涟漪：点击处扩散一圈光晕。纯 CSS，用 ::after 放大 + 淡出 */
[data-effect="ripple"] { position: relative; overflow: hidden; }
[data-effect="ripple"]::after {
	content: ""; position: absolute; inset: 0; border-radius: inherit;
	background: radial-gradient(circle, rgba(255,255,255,.55), transparent 70%);
	opacity: 0; transform: scale(.4); pointer-events: none;
}
[data-effect="ripple"]:active::after {
	opacity: 1; transform: scale(1.6);
	transition: opacity .35s ease, transform .35s ease;
}

/* ============ 悬停 ============
 *
 * 「漂浮」**单独成一个效果** —— 用户明确说"漂浮与否可选择"：
 * 只要漂浮就用 float，要漂浮又要展开浮窗就用 hover-menu。
 */
[data-effect="float"] { transition: translate .18s ease, box-shadow .18s ease; }
[data-effect="float"]:hover {
	translate: 0 -3px;
	box-shadow: 0 8px 20px rgba(0, 0, 0, .18);
}

[data-effect="hover-menu"] {
	cursor: pointer;
	transition: translate .18s ease, box-shadow .18s ease;
}
[data-effect="hover-menu"]:hover {
	translate: 0 -3px;
	box-shadow: 0 8px 20px rgba(0, 0, 0, .18);
}
/* 浮窗内容由用户填：面板写 data-menu，这里用 attr() 取。
   不伪造菜单内容 —— 真的菜单要有真的条目，那是用户自己的东西。 */
[data-effect="hover-menu"]:hover::after {
	content: attr(data-menu);
	position: absolute; left: 50%; top: calc(100% + 6px);
	transform: translateX(-50%);
	min-width: 72px; padding: 6px 10px;
	border-radius: 8px; background: #fff; color: #202124;
	font-size: 12px; line-height: 1.5; white-space: nowrap;
	box-shadow: 0 6px 20px rgba(0, 0, 0, .2);
	pointer-events: none; z-index: 10;
}

[data-effect="hover-tip"] { cursor: help; }
[data-effect="hover-tip"]:hover::after {
	content: attr(data-tip);
	position: absolute; left: 50%; bottom: calc(100% + 6px);
	transform: translateX(-50%);
	padding: 4px 8px; border-radius: 6px;
	background: rgba(32, 33, 36, .92); color: #fff;
	font-size: 11px; white-space: nowrap;
	pointer-events: none; z-index: 10;
}

[data-effect="hover-check"]:hover::after {
	content: "✓"; position: absolute; right: 6px; top: 50%;
	transform: translateY(-50%); font-size: 12px; opacity: .9; pointer-events: none;
}

/* ============ 变化 ============ */

/* ＋ 变 ×：悬停时转 45 度。只转自己，不影响定位（rotate 也是独立属性） */
[data-effect="morph-plus"] { transition: rotate .22s ease, scale .22s ease; }
[data-effect="morph-plus"]:hover { rotate: 45deg; }
[data-effect="morph-plus"]:active { rotate: 135deg; scale: .92; }

/* 展开：悬停时长大一点，像"弹出来" */
[data-effect="morph-expand"] { transition: scale .18s cubic-bezier(.34, 1.56, .64, 1); }
[data-effect="morph-expand"]:hover { scale: 1.06; }

/* 呼吸：持续轻微缩放，用来吸引注意力 */
[data-effect="pulse"] { animation: dsh-pulse 1.8s ease-in-out infinite; }
@keyframes dsh-pulse {
	0%, 100% { scale: 1; }
	50% { scale: 1.04; }
}

/* 弹入：元素**出现时**弹一下 */
[data-effect="pop"] { animation: dsh-pop .32s cubic-bezier(.34, 1.56, .64, 1); }
@keyframes dsh-pop {
	0% { scale: .9; opacity: .6; }
	70% { scale: 1.03; opacity: 1; }
	100% { scale: 1; }
}

/* ============ 扩展：更多常见效果 ============
 *
 * ⚠️ **全篇一条铁律：只动 translate / scale / rotate / opacity /
 * box-shadow / filter / 背景，绝不写 transform。**
 *
 * 形状靠 transform: translate(Xpx, Ypx) 定位（拖动/写回都改它），
 * 而 transform 是整体覆盖的 —— 一旦写了，形状会在动画期间**瞬移回原点**。
 * @keyframes 里同样适用（动画里的 transform 一样会覆盖）。
 */

/* ---- 按压（更多手感） ---- */

/* 缩放按压：整体缩一下，适合圆形按钮和图标 */
[data-effect="press-scale"] {
	transition: scale .12s cubic-bezier(.34, 1.56, .64, 1);
}
[data-effect="press-scale"]:active { scale: .92; }

/* 边框高亮按压：不动位置，只亮一圈 —— 适合大面积卡片（不想让它"跳"） */
[data-effect="press-glow"] {
	transition: box-shadow .14s ease, border-color .14s ease;
}
[data-effect="press-glow"]:active {
	box-shadow: inset 0 0 0 2px rgba(26, 115, 232, .9);
	border-color: #1a73e8;
}

/* 长按蓄力：按住时缓慢变大，像在"攒劲" */
[data-effect="press-hold"] { transition: scale 1.2s ease-out; }
[data-effect="press-hold"]:active { scale: 1.08; }

/* 中心波纹：从中间扩散一圈，比 ripple 更明显 */
[data-effect="ripple-center"] { position: relative; overflow: hidden; }
[data-effect="ripple-center"]::after {
	content: ""; position: absolute; left: 50%; top: 50%;
	width: 0; height: 0; border-radius: 50%;
	background: rgba(255, 255, 255, .6);
	translate: -50% -50%; pointer-events: none;
}
[data-effect="ripple-center"]:active::after {
	width: 220%; height: 220%; opacity: 0;
	transition: width .4s ease, height .4s ease, opacity .4s ease;
}

/* ---- 悬停（更多反馈） ---- */

/* 抬升带倾斜：像被"拿起来"看了一眼 */
[data-effect="hover-lift"] { transition: translate .2s ease, rotate .2s ease, box-shadow .2s ease; }
[data-effect="hover-lift"]:hover {
	translate: 0 -4px;
	rotate: -1.5deg;
	box-shadow: 0 12px 26px rgba(0, 0, 0, .2);
}

/* 右移：暗示"点了会往那边去" */
[data-effect="hover-slide-right"] { transition: translate .16s ease; }
[data-effect="hover-slide-right"]:hover { translate: 4px 0; }

/* 下沉：按下前先沉一点，适合可点区域 */
[data-effect="hover-sink"] { transition: translate .16s ease; }
[data-effect="hover-sink"]:hover { translate: 0 2px; }

/* 阴影加深：位置完全不动，只让影子变深 —— 最不打扰的一种 */
[data-effect="hover-shadow"] { transition: box-shadow .2s ease; }
[data-effect="hover-shadow"]:hover { box-shadow: 0 10px 24px rgba(0, 0, 0, .28); }

/* 流光边框：绕一圈的光，用来吸引注意 */
[data-effect="hover-glow"] {
	transition: box-shadow .25s ease;
}
[data-effect="hover-glow"]:hover {
	box-shadow: 0 0 0 2px rgba(26, 115, 232, .55), 0 0 18px rgba(26, 115, 232, .45);
}

/* 底色渐变：悬停时背景滑入一层渐变 */
[data-effect="hover-gradient"] {
	background-image: linear-gradient(120deg, transparent 0%, rgba(255,255,255,.28) 50%, transparent 100%);
	background-size: 220% 100%;
	background-position: 120% 0;
	transition: background-position .5s ease;
}
[data-effect="hover-gradient"]:hover { background-position: -20% 0; }

/* 下划线展开：文字类元素最常用 */
[data-effect="hover-underline"] { position: relative; }
[data-effect="hover-underline"]::after {
	content: ""; position: absolute; left: 0; bottom: 2px; height: 2px; width: 100%;
	background: currentColor; scale: 0 1; transform-origin: left center;
	transition: scale .22s ease; pointer-events: none;
}
[data-effect="hover-underline"]:hover::after { scale: 1 1; }

/* 图标旋转：悬停时图标转一圈 */
[data-effect="hover-rotate"] { transition: rotate .4s cubic-bezier(.34, 1.56, .64, 1); }
[data-effect="hover-rotate"]:hover { rotate: 180deg; }

/* ---- 变化（形状/状态切换） ---- */

/* ☰ → ✕：汉堡菜单的标准做法。内容由用户填，这里只做"会变"的提示 */
[data-effect="morph-hamburger"] { transition: rotate .24s ease, scale .24s ease; }
[data-effect="morph-hamburger"]:hover { rotate: 90deg; }
[data-effect="morph-hamburger"]:active { rotate: 90deg; scale: .9; }

/* 箭头翻转：悬停时指向反过来 */
[data-effect="morph-arrow"] { transition: scale .24s ease; }
[data-effect="morph-arrow"]:hover { scale: -1 1; }

/* 开关滑动：像拨动开关 */
[data-effect="morph-switch"] { transition: translate .2s cubic-bezier(.34, 1.56, .64, 1), background-color .2s ease; }
[data-effect="morph-switch"]:active { translate: 6px 0; }

/* 勾选描边：按下时轻微缩放 + 高亮，表达"选中了" */
[data-effect="morph-check"] { transition: scale .18s cubic-bezier(.34, 1.56, .64, 1), box-shadow .18s ease; }
[data-effect="morph-check"]:active {
	scale: 1.12;
	box-shadow: 0 0 0 3px rgba(30, 142, 62, .35);
}

/* 翻转：3D 翻面。用 rotateY，同样不碰 transform */
[data-effect="morph-flip"] { transition: rotate .5s ease; }
[data-effect="morph-flip"]:hover { rotate: y 180deg; }

/* ---- 出现（元素入场） ---- */

[data-effect="enter-fade"] { animation: dsh-fade .5s ease both; }
@keyframes dsh-fade { from { opacity: 0; } to { opacity: 1; } }

[data-effect="enter-slide-up"] { animation: dsh-slide-up .45s cubic-bezier(.22, 1, .36, 1) both; }
@keyframes dsh-slide-up { from { translate: 0 18px; opacity: 0; } to { translate: 0 0; opacity: 1; } }

[data-effect="enter-zoom"] { animation: dsh-zoom .4s cubic-bezier(.34, 1.56, .64, 1) both; }
@keyframes dsh-zoom { from { scale: .82; opacity: 0; } to { scale: 1; opacity: 1; } }

/* 逐条错峰：列表用。给每个子元素加延迟，靠 nth-child */
[data-effect="enter-stagger"] > * { animation: dsh-slide-up .4s cubic-bezier(.22, 1, .36, 1) both; }
[data-effect="enter-stagger"] > *:nth-child(1) { animation-delay: 0s; }
[data-effect="enter-stagger"] > *:nth-child(2) { animation-delay: .06s; }
[data-effect="enter-stagger"] > *:nth-child(3) { animation-delay: .12s; }
[data-effect="enter-stagger"] > *:nth-child(4) { animation-delay: .18s; }
[data-effect="enter-stagger"] > *:nth-child(5) { animation-delay: .24s; }
[data-effect="enter-stagger"] > *:nth-child(6) { animation-delay: .3s; }

/* 骨架屏：加载占位。只用背景动画，不改尺寸 */
[data-effect="skeleton"] {
	background-image: linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,.55) 50%, rgba(255,255,255,0) 100%);
	background-size: 200% 100%;
	animation: dsh-skeleton 1.2s linear infinite;
}
@keyframes dsh-skeleton { from { background-position: 150% 0; } to { background-position: -50% 0; } }

/* ---- 状态（持续表达） ---- */

[data-effect="spin"] { animation: dsh-spin 1s linear infinite; }
@keyframes dsh-spin { to { rotate: 360deg; } }

/* 脉冲点：像"有新消息"的小圆点 */
[data-effect="pulse-dot"] { animation: dsh-pulse-dot 1.4s ease-out infinite; }
@keyframes dsh-pulse-dot {
	0% { box-shadow: 0 0 0 0 rgba(217, 48, 37, .6); }
	70% { box-shadow: 0 0 0 10px rgba(217, 48, 37, 0); }
	100% { box-shadow: 0 0 0 0 rgba(217, 48, 37, 0); }
}

/* 进度推进：宽度动画会改布局，所以用背景位移表达"在走" */
[data-effect="progress-fill"] {
	background-image: linear-gradient(90deg, #1a73e8 0%, #4c9aff 50%, #1a73e8 100%);
	background-size: 200% 100%;
	animation: dsh-progress 1.6s ease-in-out infinite;
}
@keyframes dsh-progress { from { background-position: 100% 0; } to { background-position: -100% 0; } }

/* ---- 氛围（点缀） ---- */

[data-effect="gradient-flow"] {
	background-image: linear-gradient(120deg, #1a73e8, #9334e6, #1e8e3e, #1a73e8);
	background-size: 300% 100%;
	animation: dsh-gradient 6s linear infinite;
}
@keyframes dsh-gradient { from { background-position: 0% 0; } to { background-position: 300% 0; } }

[data-effect="glow-breathe"] { animation: dsh-glow 2.4s ease-in-out infinite; }
@keyframes dsh-glow {
	0%, 100% { box-shadow: 0 0 0 0 rgba(26, 115, 232, .3); }
	50% { box-shadow: 0 0 22px 4px rgba(26, 115, 232, .5); }
}

/* 打字机：用 clip-path 逐步揭开，**不改宽度**（改 width 会动布局、把邻居挤走） */
[data-effect="typewriter"] {
	animation: dsh-type 2.4s steps(24, end) infinite;
	white-space: nowrap;
	overflow: hidden;
}
@keyframes dsh-type {
	from { clip-path: inset(0 100% 0 0); }
	to { clip-path: inset(0 0 0 0); }
}

/* ============ 第三批：调研后补充（39 → 67） ============
 *
 * 来源：对 Animate.css / Hover.css / SpinKit / Material / NNG 的调研。
 * 已排除的（**列出来是为了以后别再试一遍**）：
 *   - **3D 类**（flip / hinge / rollIn / perspective）：skew 和 3D 旋转
 *     **没有独立属性**，只能用 transform → 会把形状定位冲掉，直接出局
 *   - **多子元素 loader**（SpinKit 的 sk-wave/sk-circle 等）：源码确认要 5–12 个子 div，
 *     与"任意元素都该能用"的前提冲突，改造成本高于收益
 *   - **气泡尖角类**：强依赖元素尺寸和方向，挂到任意元素上会错位
 *   - **卷角（curl）**：靠 box-shadow 拼三角，代码冗长且视觉过时
 *   - 与已有 39 个**语义重复**的（下划线滑入 / 列表错峰 / 骨架扫光 / 转圈）
 *
 * ## 铁律的**完整版**（前面几段写的是简版）
 *
 * **宿主元素**上绝不能写 transform —— 形状的定位就挂在它身上。
 * 但**伪元素上可以**：after 里写 transform: translateX(-50%) 这种居中写法
 * 既简单又没负担（伪元素不参与形状定位）。本篇里几处居中就是这么做。
 *
 * （本篇在模板字符串里，注释不能出现反引号 —— 会直接截断字符串。）
 */

/* ---- 悬停补充 ---- */

/* 底部填充：强调色从底部铺满。导航项、标签页最常用 */
[data-effect="hover-fill-up"] { position: relative; overflow: hidden; }
[data-effect="hover-fill-up"]::before {
	content: ""; position: absolute; inset: 0;
	background: rgba(255, 255, 255, .22);
	scale: 1 0; transform-origin: bottom;
	transition: scale .28s ease; pointer-events: none;
}
[data-effect="hover-fill-up"]:hover::before { scale: 1 1; }

/* 悬停收缩：比放大更克制，适合表格行和图标按钮 */
[data-effect="hover-shrink"] { transition: scale .18s ease; }
[data-effect="hover-shrink"]:hover { scale: .96; }

/* 图标轻推：暗示"点了会往那边去" */
[data-effect="hover-icon-nudge"] { transition: translate .22s ease; }
[data-effect="hover-icon-nudge"]:hover { translate: 4px 0; }

/* 扫光掠过：一道高光从左边滑到右边。按钮、卡片、图片都能用 */
[data-effect="hover-shine"] { position: relative; overflow: hidden; }
[data-effect="hover-shine"]::before {
	content: ""; position: absolute; top: -50%; bottom: -50%; width: 40%;
	background: linear-gradient(100deg, transparent, rgba(255, 255, 255, .55), transparent);
	translate: -180% 0; pointer-events: none;
}
[data-effect="hover-shine"]:hover::before {
	translate: 320% 0;
	transition: translate .75s ease;
}

/* 输入框聚焦光：用 :focus-visible 而不是 :focus —— 鼠标点一下也发光会很吵 */
[data-effect="input-focus-glow"] { transition: box-shadow .2s ease; }
[data-effect="input-focus-glow"]:focus-visible {
	box-shadow: 0 0 0 3px rgba(26, 115, 232, .35);
	outline: none;
}

/* ---- 按压补充 ---- */

/* 弹一下：点击时轻微反弹（过冲），比死板的缩放有生命感 */
[data-effect="active-bounce"] { transition: scale .1s ease; }
[data-effect="active-bounce"]:active { animation: dsh-bounce .34s cubic-bezier(.34, 1.56, .64, 1); }
@keyframes dsh-bounce {
	0% { scale: 1; }
	40% { scale: .9; }
	70% { scale: 1.03; }
	100% { scale: 1; }
}

/* 用力下压：下沉 + 阴影收紧，抬起即回 */
[data-effect="active-press-down"] { transition: translate .1s ease, box-shadow .1s ease; }
[data-effect="active-press-down"]:active {
	translate: 0 2px;
	box-shadow: inset 0 2px 5px rgba(0, 0, 0, .3);
}

/* 点击光环：一圈描边向外扩散后消失 */
[data-effect="active-ring-out"] { position: relative; }
[data-effect="active-ring-out"]::after {
	content: ""; position: absolute; inset: 0; border-radius: inherit;
	border: 2px solid rgba(26, 115, 232, .8);
	opacity: 0; scale: .8; pointer-events: none;
}
[data-effect="active-ring-out"]:active::after {
	animation: dsh-ring-out .45s ease-out;
}
@keyframes dsh-ring-out {
	0% { opacity: 1; scale: .8; }
	100% { opacity: 0; scale: 1.5; }
}

/* 错误抖动：**拒绝**语义，只该用在失败上，不要用在成功上 */
[data-effect="active-shake"]:active { animation: dsh-shake .4s ease; }
@keyframes dsh-shake {
	0%, 100% { translate: 0 0; }
	15% { translate: -6px 0; }
	30% { translate: 5px 0; }
	45% { translate: -4px 0; }
	60% { translate: 3px 0; }
	80% { translate: -2px 0; }
}

/* 错误闪红：一次性，用来表达"这次操作被拒了" */
[data-effect="active-flash"]:active { animation: dsh-flash-red .5s ease; }
@keyframes dsh-flash-red {
	0% { box-shadow: inset 0 0 0 40px rgba(217, 48, 37, .35); }
	100% { box-shadow: inset 0 0 0 0 rgba(217, 48, 37, 0); }
}

/* 边框脉冲：外扩一圈再收回 */
[data-effect="active-border-pulse"]:active { animation: dsh-border-pulse .6s ease-out; }
@keyframes dsh-border-pulse {
	0% { box-shadow: 0 0 0 0 rgba(26, 115, 232, .6); }
	60% { box-shadow: 0 0 0 7px rgba(26, 115, 232, 0); }
	100% { box-shadow: 0 0 0 0 rgba(26, 115, 232, 0); }
}

/* 校验失败：用 :user-invalid —— 它**不会在用户还没输入时就报错**（:invalid 会） */
[data-effect="field-invalid"] { transition: box-shadow .2s ease; }
[data-effect="field-invalid"]:user-invalid {
	box-shadow: 0 0 0 2px rgba(217, 48, 37, .55);
	animation: dsh-shake .4s ease;
}

/* ---- 出现补充 ---- */

/* 轻柔上浮：比 enter-slide-up 位移更小，适合密集列表 */
[data-effect="enter-fade-up-soft"] { animation: dsh-fade-up-soft .35s ease-out both; }
@keyframes dsh-fade-up-soft {
	from { translate: 0 8px; opacity: 0; }
	to { translate: 0 0; opacity: 1; }
}

/* 模糊聚焦：从糊到清楚，适合弹窗和卡片。面积大时有性能代价，别滥用 */
[data-effect="enter-fade-blur"] { animation: dsh-fade-blur .4s ease-out both; }
@keyframes dsh-fade-blur {
	from { filter: blur(8px); opacity: 0; }
	to { filter: blur(0); opacity: 1; }
}

/* 弹窗弹出：只动 scale，**不动 translate** —— 免得和画布定位打架 */
[data-effect="enter-dialog-pop"] { animation: dsh-dialog-pop .28s cubic-bezier(.34, 1.56, .64, 1) both; }
@keyframes dsh-dialog-pop {
	from { scale: .94; opacity: 0; }
	to { scale: 1; opacity: 1; }
}

/* 横幅滑入：不能动 height（会推挤布局），所以用 translate 从顶上推下来 */
[data-effect="banner-slide"] { animation: dsh-banner-in .3s ease-out both; }
@keyframes dsh-banner-in {
	from { translate: 0 -100%; opacity: 0; }
	to { translate: 0 0; opacity: 1; }
}

/* 行内提示淡入：字段下面那行错误文案 */
[data-effect="inline-msg-in"] { animation: dsh-inline-in .24s ease-out both; }
@keyframes dsh-inline-in {
	from { translate: 0 -4px; opacity: 0; }
	to { translate: 0 0; opacity: 1; }
}

/* 删除淡出：列表项被删掉时缩小淡出。剩下的项**不滑动**（动位置就得动布局） */
[data-effect="list-item-exit"] { animation: dsh-item-exit .2s ease-in both; }
@keyframes dsh-item-exit {
	from { opacity: 1; scale: 1; }
	to { opacity: 0; scale: .96; }
}

/* 展开收起：不能动 height，用 grid-template-rows 的 0fr→1fr（现代表达式） */
[data-effect="collapse-reveal"] {
	display: grid; grid-template-rows: 0fr;
	transition: grid-template-rows .28s ease;
}
[data-effect="collapse-reveal"]:hover { grid-template-rows: 1fr; }
[data-effect="collapse-reveal"] > * { overflow: hidden; min-height: 0; }

/* ---- 状态补充 ---- */

/* 徽标光环：未读小红点外围扩散的光环 */
[data-effect="pulse-ring"] { animation: dsh-pulse-ring 2s ease-out infinite; }
@keyframes dsh-pulse-ring {
	0% { box-shadow: 0 0 0 0 rgba(217, 48, 37, .55); }
	70% { box-shadow: 0 0 0 8px rgba(217, 48, 37, 0); }
	100% { box-shadow: 0 0 0 0 rgba(217, 48, 37, 0); }
}

/* 角标弹跳：幅度务必小，否则干扰阅读 */
[data-effect="badge-bounce"] { animation: dsh-badge 1.6s ease-in-out infinite; }
@keyframes dsh-badge {
	0%, 60%, 100% { translate: 0 0; }
	30% { translate: 0 -3px; }
}

/* 三点脉冲：单元素用两个伪元素凑三个点，靠延迟错峰 */
[data-effect="dots-pulse"] { position: relative; }
[data-effect="dots-pulse"]::before,
[data-effect="dots-pulse"]::after {
	content: ""; position: absolute; top: 50%; width: 5px; height: 5px;
	border-radius: 50%; background: currentColor; translate: 0 -50%;
	animation: dsh-dot 1.2s ease-in-out infinite;
}
[data-effect="dots-pulse"]::before { left: calc(50% - 12px); }
[data-effect="dots-pulse"]::after { left: calc(50% + 7px); animation-delay: .4s; }
@keyframes dsh-dot {
	0%, 60%, 100% { opacity: .3; translate: 0 -50%; }
	30% { opacity: 1; translate: 0 calc(-50% - 3px); }
}

/* 不定进度条：无法预估进度时的来回扫动 */
[data-effect="progress-indeterminate"] { position: relative; overflow: hidden; }
[data-effect="progress-indeterminate"]::after {
	content: ""; position: absolute; inset: 0; width: 40%;
	background: rgba(255, 255, 255, .6);
	animation: dsh-indeterminate 1.4s ease-in-out infinite;
}
@keyframes dsh-indeterminate {
	0% { translate: -100% 0; scale: .5 1; }
	50% { scale: .8 1; }
	100% { translate: 250% 0; scale: .5 1; }
}

/* 骨架呼吸：整块渐隐脉动。大列表里比逐个扫光安静得多 */
[data-effect="skeleton-wave"] { animation: dsh-skeleton-wave 1.5s ease-in-out infinite; }
@keyframes dsh-skeleton-wave {
	0%, 100% { opacity: 1; }
	50% { opacity: .55; }
}

/* 保存成功闪一下：用 box-shadow 扩散，**不占布局** */
[data-effect="save-flash"] { animation: dsh-save-flash .7s ease-out; }
@keyframes dsh-save-flash {
	0% { box-shadow: 0 0 0 0 rgba(30, 142, 62, .6); }
	40% { box-shadow: 0 0 0 8px rgba(30, 142, 62, .18); }
	100% { box-shadow: 0 0 0 0 rgba(30, 142, 62, 0); }
}

/* 新增行高亮：列表里刚插进来的那行黄底渐隐，让人一眼找到 */
[data-effect="row-flash"] { animation: dsh-row-flash 1.2s ease-out both; }
@keyframes dsh-row-flash {
	0% { background-color: rgba(249, 171, 0, .45); }
	100% { background-color: transparent; }
}

/* 新内容高亮环：新收到的消息带一圈描边，几秒散去 */
[data-effect="new-content-ring"] { animation: dsh-new-ring 2.4s ease-out both; }
@keyframes dsh-new-ring {
	0% { box-shadow: 0 0 0 3px rgba(26, 115, 232, .6); }
	100% { box-shadow: 0 0 0 3px rgba(26, 115, 232, 0); }
}

/* 骨架→内容：纯 CSS 表达"时序"的关键手法 ——
 * animation-delay + fill-mode: forwards 让内容晚一点淡入。
 * ⚠️ 但它**不认识"数据到了"**，只是按固定秒数演。真实项目该用
 * data-effect="ajax-region" 那种标记，由运行时决定什么时候换。
 */
[data-effect="skeleton-to-content"] {
	animation: dsh-content-in .4s ease-out 1.2s both;
}
@keyframes dsh-content-in {
	from { opacity: 0; }
	to { opacity: 1; }
}

/* ============ 只留标记，不做实现 ============
 *
 * 提示条 / 进度条 / 弹窗需要**真的创建 DOM 节点**、定时消失 ——
 * 那是运行时的事，不是设计工具该替他决定的。
 * 这里只保留 data-effect 标记，含义和关联功能的 data-action 一致：
 * **表达"这里会弹个东西"，具体行为由用户的应用决定。**
 *
 * 调研里有一条建议我认为是对的、但现在还没做：
 * **把 ARIA 属性当作工具与用户应用之间的正式接口** ——
 * 输出 aria-busy="true" / role="status" / aria-live="polite" /
 * aria-invalid="true"，而不是发明 class="is-loading" 这种私有约定。
 * 好处是无障碍默认就对、用户用什么框架都能顺着标准属性写样式、
 * 而且我们的标记不会随他的技术栈过时。
 *
 * 还有一条反直觉但正确的建议：**skeleton 的默认延迟该是 300ms 而不是 0**。
 * 200ms 就返回的请求闪一下骨架屏是纯噪声，比不显示还糟。
 * 设计工具给什么默认值，就是在教用户怎么用它。
 */

/* ============ 无障碍：尊重「减少动态效果」 ============
 *
 * 用户系统里开了这个开关（前庭功能障碍的人会头晕），**就不该再动**。
 *
 * ⚠️ 但**不是一律删掉动画** —— 那会让"加载中"看起来像卡死了、
 * 让"成功"没有任何反馈。正确做法是**保留状态的最终外观，去掉位移和循环**：
 * 淡入更快、循环动画停在第一帧、位移归零。
 */
@media (prefers-reduced-motion: reduce) {
	[data-effect] {
		animation-duration: .01ms !important;
		animation-iteration-count: 1 !important;
		transition-duration: .01ms !important;
		translate: 0 0 !important;
		scale: 1 !important;
		rotate: 0deg !important;
	}
}

`;

/**
 * 确保画板里有这段效果样式。
 *
 * 幂等：用 `data-dsh-effects` 标记，重复调用只注入一次。
 * **不用 `id` 判断**——用户页面里可能已经有同 id 的元素，那会让我们以为已经注入过。
 *
 * @param doc - 画板的 document。
 * @returns 是否已确保存在。
 */
export function ensureEffectStyle(doc) {
	if (doc?.head === null || doc?.head === undefined) return false;
	if (doc.head.querySelector("style[data-dsh-effects]") !== null) return true;
	const style = doc.createElement("style");
	style.setAttribute("data-dsh-effects", "");
	style.textContent = EFFECT_CSS;
	doc.head.appendChild(style);
	return true;
}

/**
 * 把外观声明拼成 CSS 声明串，顺手过滤掉空值。
 * @param style - kebab-case 声明对象。
 * @returns 声明字符串数组。
 */
function styleDeclarations(style) {
	return Object.entries(style)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => `${k}:${v}`);
}

/**
 * 把语义属性拼成 `data-*` 串（含前导空格）。
 * @param data - 语义属性。
 * @returns 属性串；没有时返回空串。
 */
function dataAttrs(data) {
	return Object.entries(data)
		.filter(([, v]) => v !== undefined && v !== null && v !== "")
		.map(([k, v]) => ` data-${k}="${String(v).replace(/"/gu, "&quot;")}"`)
		.join("");
}

/**
 * 造一个矩形的标记。
 *
 * ⚠️ 这个函数的**输出逐字节被 30 条断言钉着**（`test/shape-harness.html`）。
 * 重构时只允许等价变换（比如把两段 filter/map 抽成上面的辅助函数），
 * **不要顺手改空格、顺序或格式**。
 *
 * @param geometry - { left, top, width, height }，画板内像素。
 * @param style - 外观声明（kebab-case），如 { background: "#4285f4" }。
 * @param data - 语义属性，如 { role: "functional" }。
 * @returns HTML 字符串。
 */
export function buildRectMarkup(geometry, style = {}, data = {}) {
	const declarations = [
		"position:absolute",
		`left:${Math.round(geometry.left)}px`,
		`top:${Math.round(geometry.top)}px`,
		`width:${Math.round(geometry.width)}px`,
		`height:${Math.round(geometry.height)}px`,
		...styleDeclarations(style)
	].join(";");
	// 换行 + 缩进交给 markup.js 的 insertElement 按目标缩进处理，这里只给单行内容
	return `<div class="dsh-shape"${dataAttrs(data)} style="${declarations}"></div>`;
}

/**
 * 造一个图形的标记（矩形 / 椭圆 / 直线 / 文本）。
 *
 * 几何用**同一个结构** `{ left, top, width, height }`，另外直线带 `angle`：
 *
 * - 矩形/椭圆/文本：`left/top` 是包围盒左上角
 * - 直线：`left/top` 是**起点**，`width` 是**线长**，`height` 是粗细，
 *   `angle` 是方向（0 = 水平向右，顺时针为正）
 *
 * @param shapeId - `SHAPE_LIST` 里的 id。
 * @param geometry - { left, top, width, height, angle? }，画板内像素。
 * @param style - 外观声明（kebab-case）。
 * @param data - 语义属性。
 * @returns HTML 字符串。
 */
export function buildShapeMarkup(shapeId, geometry, style = {}, data = {}) {
	// 矩形直接复用旧实现——它的输出有断言钉着，别在这里重写一遍
	if (shapeId === "rect") return buildRectMarkup(geometry, style, data);

	const shape = SHAPE_LIST.find((item) => item.id === shapeId) ?? SHAPE_LIST[0];
	const declarations = [
		"position:absolute",
		`left:${Math.round(geometry.left)}px`,
		`top:${Math.round(geometry.top)}px`,
		// 至少 1px：宽高为 0 的元素在浏览器里不渲染，用户会以为"没画出来"
		`width:${Math.max(1, Math.round(geometry.width))}px`,
		`height:${Math.max(1, Math.round(geometry.height))}px`
	];
	if (shape.drag === "line") {
		// `transform-origin: 0 0` —— 绕**左上角（也就是起点）**旋转。
		//
		// 默认原点是 50% 50%（中心）：线会绕自己的中心转，起点跟着甩出去，
		// 画出来的线不在你拖的那个位置。这个必须显式写死，不能指望默认值。
		declarations.push("transform-origin:0 0");
		const angle = Math.round(Number(geometry.angle ?? 0) * 100) / 100;
		// 0 度不写 transform：省一个属性，也让"水平线"的源码更干净
		if (angle !== 0) declarations.push(`transform:rotate(${angle}deg)`);
	}
	declarations.push(...styleDeclarations(style));

	const inner = shapeId === "text" ? TEXT_PLACEHOLDER : "";
	return `<div class="dsh-shape"${dataAttrs(data)} style="${declarations.join(";")}">${inner}</div>`;
}

/**
 * 建一个绘制器。
 *
 * @param options - {
 *   getBoards: () => Map<id, { frame }>   当前所有画板
 *   getBoardId: () => string|null         当前选中画板
 *   onCommit: (boardId, geometry) => void 松手后回调（由调用方走 mutate）
 *   onStatus: (tone, text) => void
 * }
 * @returns { setShape, getShape, cancel }
 */
export function createShapeDrawer(options) {
	const { getBoards, getBoardId, onCommit, onStatus } = options;
	/** 当前要画的图形；null = 未开启绘制模式。 */
	let shape = null;
	/** 当前图形的目录项（决定手势语义）。与 `shape` 同生共死。 */
	let shapeDef = null;
	/** 每个画板上挂的清理函数。 */
	const teardown = [];
	/** 元件级的手势状态。同一时刻只可能有一个。 */
	let gesture = null;

	/**
	 * 在某个画板的 document 上挂鼠标监听。
	 * @param entry - 画板条目（有 frame）。
	 * @param boardId - 画板 id。
	 * @returns 清理函数。
	 */
	function attachBoard(entry, boardId) {
		let doc;
		try {
			doc = entry.frame.contentDocument;
		} catch {
			return () => {};
		}
		if (doc === null || doc === undefined) return () => {};

		// 效果样式（下坠/悬停展开）在设计时就要能看到，所以注入进画板运行时。
		// **它不进源码**——那是运行时的实现细节，不是用户页面该承担的。
		ensureEffectStyle(doc);

		/**
		 * 画板内坐标。
		 *
		 * **直接用 `clientX/clientY`，不做任何换算。**
		 *
		 * 事件是在画板**自己的 document** 里触发的，所以 `clientX/clientY`
		 * 本来就是"相对画板视口左上角"的坐标——**这就是要的值**。
		 *
		 * 早先这里自己算了边框和缩放：
		 * `(clientX - rect.left) * (clientWidth / rect.width)`
		 * ——错的。画板有 1px 边框时，`rect.left` 是外沿、`clientWidth` 是内宽，
		 * 两个基准不一致，算出来的坐标会偏，拖 100px 得到 99.83px。
		 * 而且这套自算在 iframe 被 CSS 缩放时会错得更离谱。
		 *
		 * 浏览器已经把这件事做对了，就不要自己再做一遍。
		 *
		 * @param event - 鼠标事件。
		 * @returns { x, y }，画板内 CSS 像素。
		 */
		const point = (event) => ({ x: event.clientX, y: event.clientY });

		/** 造/更新预览。 */
		const paint = (geometry) => {
			let node = doc.getElementById("__dsh_shape_preview__");
			if (node === null) {
				node = doc.createElement("div");
				node.id = "__dsh_shape_preview__";
				// 预览不接收鼠标事件，否则 mousemove 会被它自己吃掉、拖拽直接断掉
				node.setAttribute("style", [
					"position:absolute", "pointer-events:none", "z-index:2147483000",
					"box-sizing:border-box", "border:1px dashed #4285f4",
					"background:rgba(66,133,244,.14)"
				].join(";"));
				doc.body.appendChild(node);
			}
			node.style.left = `${geometry.left}px`;
			node.style.top = `${geometry.top}px`;
			node.style.width = `${geometry.width}px`;
			node.style.height = `${geometry.height}px`;
			// 画直线时预览也要跟着转。
			// 不转的话用户看到的是一个斜的虚线框、松手却出来一条线——
			// **预览和结果长得不一样**是最容易让人以为工具坏了的那种不一致。
			if (shapeDef?.drag === "line") {
				node.style.transformOrigin = "0 0";
				node.style.transform = `rotate(${geometry.angle ?? 0}deg)`;
			} else {
				node.style.transform = "";
			}
		};

		const clearPreview = () => {
			doc.getElementById("__dsh_shape_preview__")?.remove();
		};

		/**
		 * 由起点和当前点算出几何。
		 *
		 * 按形状的 `drag` 语义分派——这是"直线"和"矩形"唯一不同的地方。
		 *
		 * @param from - 起点（画板内坐标）。
		 * @param to - 当前点。
		 * @param square - 是否锁定正方形（按住 Shift）。
		 * @returns { left, top, width, height, angle? }。
		 */
		const geometryOf = (from, to, square) => {
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			if (shapeDef?.drag === "line") {
				// 直线：left/top 是**起点**（不是包围盒左上角），width 是线长。
				return {
					left: from.x,
					top: from.y,
					width: Math.hypot(dx, dy),
					height: LINE_THICKNESS,
					angle: (Math.atan2(dy, dx) * 180) / Math.PI
				};
			}
			const width = Math.abs(dx);
			const height = Math.abs(dy);
			if (square === true) {
				// Shift 锁正方形（画正圆、正方形时用）。
				// 取较长边，并且**朝拖拽的方向**扩展——
				// 用 `Math.min(from, to)` 会让框往反方向长，手感完全不对。
				const side = Math.max(width, height);
				return {
					left: dx >= 0 ? from.x : from.x - side,
					top: dy >= 0 ? from.y : from.y - side,
					width: side,
					height: side
				};
			}
			return {
				left: Math.min(from.x, to.x),
				top: Math.min(from.y, to.y),
				width,
				height
			};
		};

		/**
		 * 刚按下时的零尺寸几何（先画个空预览，让用户看到"开始了"）。
		 * @param start - 起点。
		 * @returns 几何。
		 */
		const emptyGeometry = (start) => (shapeDef?.drag === "line"
			? { left: start.x, top: start.y, width: 0, height: LINE_THICKNESS, angle: 0 }
			: { left: start.x, top: start.y, width: 0, height: 0 });

		const onDown = (event) => {
			if (shape === null || event.button !== 0) return;
			// 阻止画板自己的编辑层（edit.js）把这当成"选中元素"
			event.preventDefault();
			event.stopPropagation();
			const start = point(event);
			gesture = { boardId, start, geometry: emptyGeometry(start) };
			paint(gesture.geometry);
		};

		const onMove = (event) => {
			if (gesture === null || gesture.boardId !== boardId) return;
			event.preventDefault();
			gesture.geometry = geometryOf(gesture.start, point(event), event.shiftKey === true);
			paint(gesture.geometry);
		};

		const onUp = (event) => {
			if (gesture === null || gesture.boardId !== boardId) return;
			event.preventDefault();
			const geometry = geometryOf(gesture.start, point(event), event.shiftKey === true);
			clearPreview();
			gesture = null;
			// 误触保护：太小就不生成。
			//
			// ⚠️ 直线**只看长度**：它的 height 恒等于线粗（2px），
			// 拿 height 去比 MIN_DRAG 的话，**每一条线都会被判成误触**——
			// 功能看起来就是"直线画不出来"。
			const tooSmall = shapeDef?.drag === "line"
				? geometry.width < MIN_DRAG
				: geometry.width < MIN_DRAG || geometry.height < MIN_DRAG;
			if (tooSmall) {
				onStatus?.("", "拖得太小了，没生成。按住拖动试试。");
				return;
			}
			onCommit?.(boardId, geometry, shape);
		};

		const onKey = (event) => {
			if (event.key === "Escape" && gesture !== null) {
				clearPreview();
				gesture = null;
				onStatus?.("", "已取消这次绘制。");
			}
		};

		doc.addEventListener("mousedown", onDown, true);
		doc.addEventListener("mousemove", onMove, true);
		doc.addEventListener("mouseup", onUp, true);
		doc.addEventListener("keydown", onKey, true);
		// 光标提示"现在是绘制模式"——没有这个，用户不知道该在画板上拖
		const prevCursor = doc.body.style.cursor;
		doc.body.style.cursor = "crosshair";

		return () => {
			doc.removeEventListener("mousedown", onDown, true);
			doc.removeEventListener("mousemove", onMove, true);
			doc.removeEventListener("mouseup", onUp, true);
			doc.removeEventListener("keydown", onKey, true);
			doc.body.style.cursor = prevCursor;
			clearPreview();
		};
	}

	/** 全部挂上。 */
	function attachAll() {
		detachAll();
		const boards = getBoards?.();
		if (boards === undefined) return;
		for (const [id, entry] of boards) teardown.push(attachBoard(entry, id));
	}

	/** 全部摘下。 */
	function detachAll() {
		while (teardown.length > 0) teardown.pop()();
		gesture = null;
	}

	return {
		/**
		 * 设置当前图形。传 null 退出绘制模式。
		 * @param next - `SHAPE_LIST` 里的 id（rect / ellipse / line / text）或 null。
		 */
		setShape(next) {
			shape = next;
			// 目录项与 id **同生共死**：漏了这一步，`shapeDef` 会停在上一轮的形状上，
			// 于是画"直线"时用的还是"矩形"的手势语义。
			shapeDef = next === null ? null : (SHAPE_LIST.find((item) => item.id === next) ?? null);
			if (next === null) {
				detachAll();
				return;
			}
			attachAll();
			// 当前选中的画板优先：绘制必须落在某一块上
			const current = getBoardId?.();
			const name = shapeDef?.name ?? "图形";
			onStatus?.("", current === null || current === undefined
				? `选一块画板，然后在上面按住拖动画出${name}`
				: `在画板上按住拖动，画出${name}`);
		},
		getShape: () => shape,
		/** 画板集合变了（新增/删除/重载）时重挂。 */
		refresh() {
			if (shape !== null) attachAll();
		},
		/** 外部要接管鼠标时（如撤销/切换模式）先取消绘制。 */
		cancel() {
			detachAll();
			shape = null;
			shapeDef = null;
			gesture = null;
		}
	};
}
