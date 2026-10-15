/**
 * 画布外壳：无限画布 + 多画板。
 *
 * ## 坐标系（最容易出错的地方，所以写清楚）
 *
 * ```
 * 屏幕坐标 = 世界坐标 × zoom + pan + viewportOrigin
 * 世界坐标 = (屏幕坐标 − viewportOrigin − pan) / zoom
 * ```
 *
 * `.world` 用 `transform-origin: 0 0` + `translate(pan) scale(zoom)`，
 * 所以画板只需要按世界坐标绝对定位，缩放由 CSS 完成。
 *
 * **画板里的 iframe 始终按设备真实尺寸渲染**（1440×900 就是 1440×900 CSS 像素），
 * 缩放只影响观看。这是设计工具的标准做法：否则在 12% 缩放下，
 * 页面的媒体查询会按 173px 宽度生效，看到的布局根本不是真实布局。
 *
 * ## 交互
 *
 * - 滚轮 → 以指针为锚点缩放
 * - 拖空白处 / 中键拖 → 平移
 * - 拖画板标题 → 移动画板
 * - 拖画板右下角 → 改尺寸
 * - 点画板 → 选中；点空白 → 取消
 * - `0` 适应全部、`1` 回到 100%、`Delete` 删除选中画板
 */

// el 复用覆盖层的 DOM 小工具：它按 URL 与外壳同层（见 edit.js 里的说明）。
import { el } from "./editor.js";
import { CanvasEditor } from "./edit.js";
import { boundsOf, centerPan, groupByPath, matchesQuery } from "./view.js";
import { buildLayerTree, filterLayerTree } from "./layers.js";
import { createLibraryPanel } from "./library-panel.js";
import { SHAPE_DEFAULT_STYLE, SHAPE_LIST, buildShapeMarkup, createShapeDrawer, ensureEffectStyle } from "./shapes.js";
import { createShapePanel } from "./shape-panel.js";
import { createInspector } from "./inspector.js";
import { ariaFor, mergeSemantics, readSemantics } from "./aria.js";

/**
 * 代理前缀。
 *
 * 优先用宿主注入的全局量（shell.html 里那一行）。万一没注入（比如有人直接把
 * shell.js 挂到别处），就从自己这个模块的 URL 反推：
 * 模块地址是 `<prefix>/__canvas__/shell.js`，往上退两级就是前缀。
 * 两条路都是为了「前缀只在一处定义」——早先覆盖层靠猜路径，就在 `__frame__` 下猜错过。
 */
const PREFIX = (() => {
	const injected = globalThis.__DSH_CANVAS_PREFIX__;
	if (typeof injected === "string" && injected !== "" && injected !== "__PREFIX__") return injected;
	try {
		const url = new URL(import.meta.url);
		const at = url.pathname.lastIndexOf("/__canvas__/");
		return at < 0 ? "" : url.pathname.slice(0, at);
	} catch {
		return "";
	}
})();
const API = `${PREFIX}/__canvas__/board`;
const PROMPT_API = `${PREFIX}/__canvas__/prompt`;
const WS_PATH = `${PREFIX}/__canvas__/ws`;

/** 缩放范围：与 workspaces.js 的视图状态上下限一致。 */
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 4;
/** 「适应」时四周留白（世界坐标）。 */
const FIT_PADDING = 80;

const dom = {
	world: document.getElementById("world"),
	viewport: document.getElementById("viewport"),
	empty: document.getElementById("empty"),
	warnings: document.getElementById("warnings"),
	status: document.getElementById("status"),
	statusText: document.getElementById("statusText"),
	zoomLabel: document.getElementById("zoomLabel"),
	fileLabel: document.getElementById("fileLabel"),
	dialog: document.getElementById("addDialog"),
	addForm: document.getElementById("addForm"),
	addPath: document.getElementById("addPath"),
	addName: document.getElementById("addName"),
	addDevice: document.getElementById("addDevice"),
	addSpec: document.getElementById("addSpec"),
	addCancel: document.getElementById("addCancel"),
	btnAdd: document.getElementById("btnAdd"),
	btnUndo: document.getElementById("btnUndo"),
	btnRedo: document.getElementById("btnRedo"),
	btnPick: document.getElementById("btnPick"),
	search: document.getElementById("search"),
	sideTabs: document.getElementById("sideTabs"),
	paneBoards: document.getElementById("paneBoards"),
	paneLayers: document.getElementById("paneLayers"),
	layerSearch: document.getElementById("layerSearch"),
	layerTree: document.getElementById("layerTree"),
	layerFoot: document.getElementById("layerFoot"),
	paneLibrary: document.getElementById("paneLibrary"),
	libraryPanel: document.getElementById("libraryPanel"),
	btnLibraryImport: document.getElementById("btnLibraryImport"),
	libraryFile: document.getElementById("libraryFile"),
	btnShape: document.getElementById("btnShape"),
	shapeBar: document.getElementById("shapeBar"),
	shapeRow: document.getElementById("shapeRow"),
	shapeHint: document.getElementById("shapeHint"),
	shapePanel: document.getElementById("shapePanel"),
	paneShape: document.getElementById("paneShape"),
	inspector: document.getElementById("inspector"),
	layerMenu: document.getElementById("layerMenu"),
	layerNew: document.getElementById("layerNew"),
	btnLayerNew: document.getElementById("btnLayerNew"),
	btnLayerCollapse: document.getElementById("btnLayerCollapse"),
	boardList: document.getElementById("boardList"),
	sideFoot: document.getElementById("sideFoot"),
	btnFit: document.getElementById("btnFit"),
	zoomOut: document.getElementById("zoomOut"),
	zoomIn: document.getElementById("zoomIn"),
	themeGroup: document.getElementById("themeGroup"),
	splitter: document.getElementById("splitter"),
	side: document.querySelector(".side"),
	btnReload: document.getElementById("btnReload"),
	promptTarget: document.getElementById("promptTarget"),
	promptText: document.getElementById("promptText"),
	promptSend: document.getElementById("promptSend"),

	// 注释卡片（学 OpenDesign：选中元素 → 写评论 / 传图 → 发给 Agent）
	btnComment: document.getElementById("btnComment"),
	// 侧边栏折叠开关（放工具栏：侧栏收起后自身看不见，开关必须在常驻处）
	btnSide: document.getElementById("btnSide"),
	commentCard: document.getElementById("commentCard"),
	ccSelector: document.getElementById("ccSelector"),
	ccSpecs: document.getElementById("ccSpecs"),
	ccInput: document.getElementById("ccInput"),
	ccThumbs: document.getElementById("ccThumbs"),
	ccFiles: document.getElementById("ccFiles"),
	ccClose: document.getElementById("ccClose"),
	ccSend: document.getElementById("ccSend"),
	ccTarget: document.getElementById("ccTarget"),
	ccCopyPath: document.getElementById("ccCopyPath")
};

/** 画布状态。 */
const state = {
	/** 已渲染的画板：id → { data, element, frame }。 */
	boards: new Map(),
	zoom: 1,
	panX: 40,
	panY: 40,
	selectedId: null,
	devices: {},
	/** 拖动状态：{ kind, ... }。 */
	drag: null
};

/**
 * 画布内的编辑层（P2）。
 *
 * 延迟创建：它一建立就连 WebSocket，而外壳本身没有它也能用
 * （浏览、排版画板都不依赖宿主连接）。所以放在 start() 里建，
 * 连不上也不影响画布。
 */
let editor = null;

// #region 与宿主通信

/**
 * 调画板 API。
 *
 * **绝不抛出**：网络失败、宿主重启、页面正在卸载……都会让 fetch 抛错，
 * 而调用方多数是 `void callBoard(...)` 这种「发出去就不管」的用法。
 * 一旦让它抛出，就会变成 `Uncaught (in promise)`——既脏了控制台，
 * 也可能掩盖真正的问题（我就是在验证时被这条噪声绊了一下）。
 *
 * @param payload - 请求体（{ type, ... }）。
 * @returns 响应对象；失败时返回 { ok: false, error }。
 */
async function callBoard(payload) {
	try {
		const response = await fetch(API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload)
		});
		const text = await response.text();
		try {
			return JSON.parse(text);
		} catch {
			return { ok: false, error: `宿主返回了非 JSON：${text.slice(0, 200)}` };
		}
	} catch (error) {
		return { ok: false, error: `请求宿主失败：${String(error?.message ?? error)}` };
	}
}

/**
 * 显示一条状态。
 * @param tone - "ok" | "err" | "warn" | ""。
 * @param text - 文案。
 */
function setStatus(tone, text) {
	// **任何新状态都意味着"上一次请求已经有结果了"**，顺手把超时兜底标记清掉。
	//
	// 放在这里而不是放在回执处理处：回执有好几条路径（mutated / applied / 错误），
	// 逐条去清一定会漏——漏掉的那条就会在 6 秒后弹出一句**误导性的超时提示**。
	// 状态栏是"有结果"的唯一可靠信号，挂在它上面最省心。
	// 注意：本函数在标记**设置之前**也会被调用一次（"正在写入…"），
	// 所以标记是在那之后才赋值的，不会自己把自己清掉。
	if (globalThis.__DSH_CANVAS_SHAPE_PENDING__ !== undefined && globalThis.__DSH_CANVAS_SHAPE_PENDING__ !== null) {
		globalThis.__DSH_CANVAS_SHAPE_PENDING__ = null;
	}
	dom.status.className = `status ${tone}`;
	dom.statusText.textContent = text;
}

// #endregion

// #region 视图变换

/** 已排队的视图重绘（0 表示没排队）。 */
let viewFrame = 0;
/** 视口矩形缓存（见 viewportRect）。 */
let cachedViewportRect = null;

/**
 * 取视口矩形，**带缓存**。
 *
 * `getBoundingClientRect()` 是**强制同步布局**：读之前浏览器必须先把排版算完。
 * 滚轮缩放一秒能来上百次，每次都读就是每次都强制布局 —— 缩放卡顿的大头之一。
 * 视口尺寸只在窗口尺寸变化时才会变，缓存即可（resize 时清掉）。
 *
 * @returns { left, top, width, height }。
 */
function viewportRect() {
	if (cachedViewportRect === null) cachedViewportRect = dom.viewport.getBoundingClientRect();
	return cachedViewportRect;
}

/** 窗口尺寸变化时清掉缓存。 */
function invalidateViewportRect() {
	cachedViewportRect = null;
	applyTransform();
}

/**
 * 应用平移与缩放到 DOM。
 *
 * ## ⚠️ 为什么整块合并到 `requestAnimationFrame`
 *
 * 滚轮事件频率极高（触控板一秒能来上百次），而这里做的事**每一件都要重绘**：
 *
 * | 事 | 代价 |
 * |---|---|
 * | `world.style.transform` | 必须（视图变换本身） |
 * | `zoomLabel.textContent` | 小，但会失效布局 |
 * | **`viewport.style.backgroundSize`** | **触发整个视口重绘** —— 点阵背景要重新铺 |
 * | **`viewport.style.backgroundPosition`** | 同上 |
 *
 * 用户的反馈是「**尤其是急剧滚轮缩小时**，普通平移还好」——
 * 缩放时倍率变化大，上面几项全都要重算重绘，逐事件做必然卡。
 *
 * 视图变换**不需要逐事件同步**（它就是画面本身），合并到一帧完全无感；
 * 而每帧最多做一次，开销就与滚轮频率无关了。
 */
function applyTransform() {
	// 先把状态记下来，真正的 DOM 写在下一帧统一做
	if (viewFrame !== 0) return;
	const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : null;
	if (raf === null) {
		paintTransform();
		return;
	}
	viewFrame = raf(() => {
		viewFrame = 0;
		paintTransform();
	});
}

/** 真正把视图变换写进 DOM（每帧最多一次）。 */
function paintTransform() {
	// **慢操作探针**：我本地用 Edge 测过"连续缩放"是 143fps（不卡），
	// 但用户在真界面上仍然觉得卡 —— 说明瓶颈在我的测量环境里复现不出来
	//（真界面是 Electron、画板数量也不同）。
	//
	// 与其继续猜，不如让它自己报：超过 20ms 就记一条 warn 日志。
	// 用户下次说"卡"时，导出的日志里会直接指出是这一帧慢、慢多少、当时的 zoom。
	const t0 = performance.now();

	dom.world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
	dom.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
	// 缩放到很小时隐藏画板标题（文字会糊成噪点，反而看不清）。
	dom.world.dataset.tiny = state.zoom < 0.35 ? "1" : "0";
	// 背景点阵随缩放变化，给出深度线索。
	// 这两行是重绘大头，所以只在**值真的变了**时才写（缩放不动时平移每一步都会调到这里）。
	const size = `${24 * state.zoom}px ${24 * state.zoom}px`;
	if (dom.viewport.style.backgroundSize !== size) dom.viewport.style.backgroundSize = size;
	const pos = `${state.panX}px ${state.panY}px`;
	if (dom.viewport.style.backgroundPosition !== pos) dom.viewport.style.backgroundPosition = pos;

	const ms = Math.round(performance.now() - t0);
	if (ms > 20) editor?.log?.("slow-paint-transform", { ms, zoom: Math.round(state.zoom * 100) / 100 }, "warn");

	// ★★ **缩放后必须让编辑层重算选中框。**
	//
	// 用户的观察一针见血：
	//   「执行缩小放大之后，移动鼠标，选中框就马上跟上组件了，**鼠标不动他就不跟**」
	//
	// 这就说明框的更新**只挂在 mousemove 上**。而缩放时：
	//   - 元素由 CSS `transform` **立即**移动（不需要 JS 参与，浏览器自己算）
	//   - **框没人通知**，于是停在旧位置，直到下一次鼠标移动才被重算
	//
	// 用户感受到的"延迟"其实就是这个 —— 不是慢，是**根本没更新**。
	// （这也是我前面几轮一直找不到的原因：我在优化"算得快不快"，
	//   而问题是"压根没算"。）
	//
	// 框的位置依赖 iframe 的屏幕矩形，缩放后它变了，所以这里必须补一次。
	// 每帧一次 `syncBoxes` 的代价可以接受：缩放本身就每帧重绘。
	editor?.syncBoxes?.();

	// 关联连线用的是**视口绝对坐标**，视图一变（缩放/平移）就全偏了，
	// 必须跟着重画。放同一帧里：它和画板一起动，不会有"线先飘过去"的错位。
	// 交互提示（滑动色带）同样是绝对坐标，一起重画。
	paintLinks();
	paintInteractHints();
}

/**
 * 以某个屏幕点为锚点缩放（锚点下的世界坐标保持不动）。
 *
 * @param nextZoom - 目标缩放。
 * @param screenX - 锚点屏幕 X（clientX）。
 * @param screenY - 锚点屏幕 Y（clientY）。
 */
function zoomAt(nextZoom, screenX, screenY) {
	const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
	// 视口矩形**缓存**：它只在窗口尺寸变化时才会变，而滚轮一秒能来上百次。
	// 每次读 `getBoundingClientRect()` 都是**强制同步布局**——缩放卡顿的大头之一。
	const rect = viewportRect();
	const localX = screenX - rect.left;
	const localY = screenY - rect.top;
	// 锚点当前对应的世界坐标。
	const worldX = (localX - state.panX) / state.zoom;
	const worldY = (localY - state.panY) / state.zoom;
	state.zoom = zoom;
	// 让同一个世界坐标仍落在同一个屏幕位置。
	state.panX = localX - worldX * zoom;
	state.panY = localY - worldY * zoom;
	applyTransform();
	scheduleViewSave();
}

/**
 * 滚轮 → 缩放。画布空白处与画板内部共用这一条（画板内的滚轮由编辑层转发过来）。
 *
 * @param deltaY - 滚轮增量。
 * @param screenX - 锚点屏幕 X。
 * @param screenY - 锚点屏幕 Y。
 */
function zoomByWheel(deltaY, screenX, screenY) {
	const factor = Math.exp(-deltaY * 0.0015);
	zoomAt(state.zoom * factor, screenX, screenY);
}

/**
 * 按固定倍数缩放（给工具栏的 ± 按钮用），以视口中心为锚点。
 *
 * 步进而不是连续：按钮点一下要有确定的、可预期的结果。
 *
 * @param factor - 倍数。
 */
function zoomStep(factor) {
	const rect = dom.viewport.getBoundingClientRect();
	zoomAt(state.zoom * factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

/**
 * 缩放到能看见所有画板。
 */
function fitAll() {
	// 包围盒的计算挪到了 view.js（纯函数，可离线测）。
	const bounds = boundsOf([...state.boards.values()].map((entry) => entry.data));
	if (bounds === null) {
		state.zoom = 1;
		state.panX = 40;
		state.panY = 40;
		applyTransform();
		scheduleViewSave();
		return;
	}
	const { minX, minY, maxX, maxY } = bounds;
	const rect = dom.viewport.getBoundingClientRect();
	const width = Math.max(1, maxX - minX);
	const height = Math.max(1, maxY - minY);
	// 标题栏占一点高度，缩放时留给它。
	const zoom = Math.min(
		(rect.width - FIT_PADDING * 2) / width,
		(rect.height - FIT_PADDING * 2 - 30) / height
	);
	state.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
	state.panX = (rect.width - width * state.zoom) / 2 - minX * state.zoom;
	state.panY = (rect.height - height * state.zoom) / 2 - minY * state.zoom;
	applyTransform();
	scheduleViewSave();
}

/** 视图保存节流。 */
let viewTimer = null;
function scheduleViewSave() {
	if (viewTimer !== null) window.clearTimeout(viewTimer);
	viewTimer = window.setTimeout(() => {
		viewTimer = null;
		void callBoard({ type: "view", zoom: state.zoom, x: state.panX, y: state.panY });
	}, 400);
}

// #endregion

// #region 渲染

/**
 * 用宿主返回的快照重绘整个画布。
 * @param board - 快照。
 */
function render(board) {
	state.devices = board.devices ?? {};
	dom.fileLabel.textContent = board.file ?? "";
	if (Array.isArray(board.warnings) && board.warnings.length > 0) {
		dom.warnings.hidden = false;
		dom.warnings.textContent = board.warnings.join("\n");
	} else {
		dom.warnings.hidden = true;
	}

	const seen = new Set();
	for (const item of board.workspaces ?? []) {
		seen.add(item.id);
		const existing = state.boards.get(item.id);
		if (existing === undefined) state.boards.set(item.id, createBoard(item));
		else updateBoard(existing, item);
	}
	// 移除已经不在列表里的。
	for (const [id, entry] of [...state.boards]) {
		if (seen.has(id)) continue;
		entry.element.remove();
		state.boards.delete(id);
		if (state.selectedId === id) state.selectedId = null;
	}

	dom.empty.hidden = state.boards.size > 0;
	// applySelection 内部会重绘左侧列表（选中态在那边也要体现），所以这里不重复调。
	applySelection();
	// 画板增删后要把新的 iframe 接给编辑层。
	syncEditorFrames();
}

/**
 * 创建一个画板元素。
 * @param data - 画板数据。
 * @returns { data, element, frame }。
 */
function createBoard(data) {
	const element = document.createElement("section");
	element.className = "board";
	element.dataset.id = data.id;
	element.dataset.device = data.device;

	const head = document.createElement("div");
	head.className = "board-head";
	const name = document.createElement("span");
	name.className = "board-name";
	const meta = document.createElement("span");
	meta.className = "board-meta";
	const spec = document.createElement("span");
	spec.className = "board-spec";
	head.append(name, meta, spec);

	const tools = document.createElement("div");
	tools.className = "board-tools";
	/*
	 * ★ 设备切换（用户要求："选中某块画板可以切换它的UI显示界面"）
	 *
	 * 尺寸预设（phone / phone-large / tablet / desktop / desktop-wide）和
	 * `device` 字段**本来就存在**，但只在**新建画板**时能选一次，之后就锁死了 ——
	 * 想做响应式检查只能删了重建。
	 *
	 * 工具栏只在 `.board.selected` 时显示，正好对上"选中某块画板"这个动作。
	 *
	 * 切换时**同时改 rect**：设备的意义就是那个宽度（390 / 834 / 1440），
	 * 只改 device 不改尺寸的话，手机预设配 1440px 宽的框，什么响应式都看不出来。
	 *
	 * `pointerdown` 必须 stopPropagation —— 不然点下拉框会被当成按住画板标题，
	 * 触发拖动（`head` 上绑了 `beginMove`）。
	 */
	const deviceSel = document.createElement("select");
	deviceSel.className = "board-device";
	deviceSel.title = "切换这块画板的显示设备（宽度会跟着变成该设备的尺寸）";
	deviceSel.setAttribute("aria-label", "显示设备");
	for (const [key, dev] of Object.entries(state.devices)) {
		const opt = document.createElement("option");
		opt.value = key;
		opt.textContent = dev.label;
		if (key === data.device) opt.selected = true;
		deviceSel.append(opt);
	}
	deviceSel.addEventListener("pointerdown", (event) => event.stopPropagation());
	deviceSel.addEventListener("click", (event) => event.stopPropagation());
	deviceSel.addEventListener("change", (event) => {
		event.stopPropagation();
		void applyDevice(data.id, deviceSel.value);
	});

	const removeBtn = document.createElement("button");
	removeBtn.type = "button";
	removeBtn.textContent = "删除";
	removeBtn.addEventListener("click", (event) => {
		event.stopPropagation();
		void removeBoard(data.id);
	});
	tools.append(deviceSel, removeBtn);

	const frameBox = document.createElement("div");
	frameBox.className = "board-frame";
	const frame = document.createElement("iframe");
	// 不设 sandbox：画板与服务同源是刻意的（P2 要让外壳能直接读写画板内的 DOM）。
	// 这些页面本来就来自用户自己的 dev server，且整条链路只在回环上。
	frame.setAttribute("loading", "lazy");
	frame.src = data.frameUrl;
	frameBox.append(frame, tools);

	const handle = document.createElement("div");
	handle.className = "board-resize";
	handle.addEventListener("pointerdown", (event) => beginResize(event, data.id));
	frameBox.append(handle);

	element.append(head, frameBox);
	element.addEventListener("pointerdown", () => select(data.id));
	head.addEventListener("pointerdown", (event) => beginMove(event, data.id));
	dom.world.append(element);

	const entry = { data, element, frame, name, meta, spec };
	updateBoard(entry, data);
	return entry;
}

/**
 * 更新一个画板元素（位置、尺寸、文案）。
 * @param entry - 画板条目。
 * @param data - 新数据。
 */
function updateBoard(entry, data) {
	entry.data = data;
	const { element, frame } = entry;
	element.style.left = `${data.rect.x}px`;
	element.style.top = `${data.rect.y}px`;
	element.dataset.device = data.device;
	entry.name.textContent = data.name;
	const device = state.devices[data.device];
	entry.meta.textContent = `${device?.label ?? data.device} · ${data.rect.w}×${data.rect.h} · ${data.path}`;
	entry.spec.textContent = data.spec === "" ? "" : `规格：${data.spec}`;
	// 只按设备真实尺寸设置 iframe，缩放交给外层 transform。
	const frameBox = element.querySelector(".board-frame");
	frameBox.style.width = `${data.rect.w}px`;
	frameBox.style.height = `${data.rect.h}px`;
	// iframe 的地址变了才重新加载，否则会白屏闪一下。
	if (frame.getAttribute("src") !== data.frameUrl) frame.src = data.frameUrl;
}

/**
 * 应用选中态。
 */
function applySelection() {
	for (const [id, entry] of state.boards) {
		entry.element.classList.toggle("selected", id === state.selectedId);
	}
	// 左侧列表的选中态也要跟着变。
	renderSidebar();
	// 图层树只显示**激活画板**的结构，所以换画板必须重画。
	// 只在图层页签可见时才算——走一遍 DOM 不便宜，藏着的树没必要一直维护。
	if (dom.paneLayers !== null && dom.paneLayers.hidden === false) renderLayers();
}

/**
 * 把画板列表同步给编辑层（渲染后调用）。
 */
function syncEditorFrames() {
	if (editor === null) return;
	editor.syncFrames([...state.boards.values()].map((entry) => ({
		id: entry.data.id,
		iframe: entry.frame,
		data: entry.data
	})));
}

/**
 * 选中一块画板。
 * @param id - 画板 id 或 null。
 */
function select(id) {
	state.selectedId = id;
	applySelection();
	editor?.setActive(id);
	// 告诉宿主「现在指的是哪块」：Agent 与指令上下文都要用它，
	// 但它不落盘（见 BoardSession.activeId 的说明），所以失败也无所谓。
	void callBoard({ type: "select", id });
}

// #endregion

// #region 拖动：平移 / 移动画板 / 改尺寸

/**
 * 取世界坐标下的指针位置。
 * @param event - PointerEvent。
 * @returns { x, y }。
 */
function worldPoint(event) {
	const rect = dom.viewport.getBoundingClientRect();
	return {
		x: (event.clientX - rect.left - state.panX) / state.zoom,
		y: (event.clientY - rect.top - state.panY) / state.zoom
	};
}

/**
 * 中键平移的统一入口：外壳上直接拖、以及从画板（iframe）转发进来的，都走这里。
 *
 * 画板里的中键**必须转发**——iframe 的事件不冒泡到外壳，而中键平移恰恰在
 * 「画板占满画布、找不到空白处」时最需要，那正是画板覆盖面积最大的时候。
 *
 * @param phase - "start" | "move" | "end"。
 * @param x - 屏幕坐标 X。
 * @param y - 屏幕坐标 Y。
 */
function middlePan(phase, x, y) {
	if (phase === "start") {
		state.drag = { kind: "pan", startX: x, startY: y, panX: state.panX, panY: state.panY };
		dom.viewport.classList.add("panning");
		return;
	}
	const drag = state.drag;
	if (drag === null || drag.kind !== "pan") return;
	if (phase === "end") {
		void endDrag();
		return;
	}
	state.panX = drag.panX + (x - drag.startX);
	state.panY = drag.panY + (y - drag.startY);
	applyTransform();
}

/**
 * 开始平移画布。
 * @param event - PointerEvent。
 */
function beginPan(event) {
	state.drag = { kind: "pan", startX: event.clientX, startY: event.clientY, panX: state.panX, panY: state.panY };
	dom.viewport.classList.add("panning");
	capturePointer();
}

/**
 * 开始移动画板。
 * @param event - PointerEvent。
 * @param id - 画板 id。
 */
function beginMove(event, id) {
	if (event.button !== 0) return;
	event.preventDefault();
	event.stopPropagation();
	select(id);
	const entry = state.boards.get(id);
	if (entry === undefined) return;
	state.drag = {
		kind: "move",
		id,
		startX: event.clientX,
		startY: event.clientY,
		originX: entry.data.rect.x,
		originY: entry.data.rect.y
	};
	capturePointer();
}

/**
 * 开始改画板尺寸。
 * @param event - PointerEvent。
 * @param id - 画板 id。
 */
function beginResize(event, id) {
	if (event.button !== 0) return;
	event.preventDefault();
	event.stopPropagation();
	select(id);
	const entry = state.boards.get(id);
	if (entry === undefined) return;
	state.drag = {
		kind: "resize",
		id,
		startX: event.clientX,
		startY: event.clientY,
		originW: entry.data.rect.w,
		originH: entry.data.rect.h
	};
	capturePointer();
}

/** 把指针事件接管到 window，拖到窗口外也不丢。 */
function capturePointer() {
	const onMove = (event) => onDragMove(event);
	const onUp = () => {
		window.removeEventListener("pointermove", onMove, true);
		window.removeEventListener("pointerup", onUp, true);
		void endDrag();
	};
	window.addEventListener("pointermove", onMove, true);
	window.addEventListener("pointerup", onUp, true);
}

/**
 * 拖动中。
 * @param event - PointerEvent。
 */
function onDragMove(event) {
	const drag = state.drag;
	if (drag === null) return;
	event.preventDefault();
	if (drag.kind === "pan") {
		state.panX = drag.panX + (event.clientX - drag.startX);
		state.panY = drag.panY + (event.clientY - drag.startY);
		applyTransform();
		return;
	}
	const entry = state.boards.get(drag.id);
	if (entry === undefined) return;
	// 屏幕位移换算到世界位移：除以 zoom，否则缩放到 12% 时拖动会快得离谱。
	const dx = (event.clientX - drag.startX) / state.zoom;
	const dy = (event.clientY - drag.startY) / state.zoom;
	if (drag.kind === "move") {
		entry.element.style.left = `${drag.originX + dx}px`;
		entry.element.style.top = `${drag.originY + dy}px`;
		return;
	}
	// 尺寸吸附到整数，避免出现 1439.999 这种值写进文件。
	const width = Math.max(80, Math.round(drag.originW + dx));
	const height = Math.max(80, Math.round(drag.originH + dy));
	const frameBox = entry.element.querySelector(".board-frame");
	frameBox.style.width = `${width}px`;
	frameBox.style.height = `${height}px`;
}

/**
 * 拖动结束：把结果提交给宿主落盘。
 */
async function endDrag() {
	const drag = state.drag;
	state.drag = null;
	dom.viewport.classList.remove("panning");
	if (drag === null) return;
	if (drag.kind === "pan") {
		scheduleViewSave();
		return;
	}
	const entry = state.boards.get(drag.id);
	if (entry === undefined) return;
	const frameBox = entry.element.querySelector(".board-frame");
	const rect = {
		x: Math.round(Number.parseFloat(entry.element.style.left) || 0),
		y: Math.round(Number.parseFloat(entry.element.style.top) || 0),
		w: Math.round(Number.parseFloat(frameBox.style.width) || entry.data.rect.w),
		h: Math.round(Number.parseFloat(frameBox.style.height) || entry.data.rect.h)
	};
	if (rect.x === entry.data.rect.x && rect.y === entry.data.rect.y && rect.w === entry.data.rect.w && rect.h === entry.data.rect.h) {
		return;
	}
	const result = await callBoard({ type: "update", id: drag.id, patch: { rect } });
	if (result.ok === true) {
		render(result.board);
		setStatus("ok", `已保存「${entry.data.name}」的位置与尺寸`);
	} else {
		setStatus("err", result.error ?? "保存失败");
		// 失败就把界面退回磁盘上的真实状态，避免显示假象。
		await reload();
	}
}

// #endregion

// #region 操作

/**
 * 添加一块画板。
 * @param input - { path, name, device, spec }。
 */
async function addBoard(input) {
	const result = await callBoard({ type: "add", ...input });
	if (result.ok !== true) {
		setStatus("err", result.error ?? "添加失败");
		return;
	}
	render(result.board);
	select(result.value?.id ?? null);
	fitAll();
	setStatus("ok", `已添加画板「${result.value?.name ?? input.path}」`);
}

/**
 * 删除一块画板。
 * @param id - 画板 id。
 */
/**
 * 切换某块画板的显示设备（手机 / 平板 / 桌面 …）。
 *
 * ## 为什么连 rect 一起改
 *
 * `device` 只是布局文件里的一个标记，**真正决定"看起来像不像手机"的是宽度**。
 * 预设里每个设备都有 `width` / `height`（390×844 / 834×1112 / 1440×900 …），
 * 只改标记不改尺寸的话，切开手机预设但框还是 1440px 宽 ——
 * 页面里的媒体查询一条都不会命中，"响应式预览"就白做了。
 *
 * 所以这里把预设尺寸一并写进 `rect`。用户之后手动拖过大小也没关系：
 * 再切一次设备就回到该设备的标准尺寸（这符合"切设备"的语义）。
 *
 * 走的是和拖动/改说明**同一条** `update` 通道（`lib/board.js` 的
 * `updateWorkspace`），所以落盘、快照、git 检查点这些行为完全一致，
 * 不需要新的后端接口。
 *
 * @param id - 画板 id。
 * @param device - 设备键（必须是 `DEVICE_PRESETS` 里的）。
 * @returns { Promise<void> }。
 */
async function applyDevice(id, device) {
	const preset = state.devices[device];
	if (preset === undefined || preset === null) return;
	const result = await callBoard({
		type: "update",
		id,
		patch: { device, rect: { w: preset.width, h: preset.height } }
	});
	if (result.ok !== true) {
		setStatus("err", result.error ?? "切换设备失败");
		return;
	}
	render(result.board);
	setStatus("ok", `画板已切到「${preset.label}」${preset.width}×${preset.height}`);
}

async function removeBoard(id) {
	const entry = state.boards.get(id);
	const result = await callBoard({ type: "remove", id });
	if (result.ok !== true) {
		setStatus("err", result.error ?? "删除失败");
		return;
	}
	render(result.board);
	setStatus("ok", `已删除画板「${entry?.data.name ?? id}」`);
}

/** 从磁盘重载。 */
async function reload() {
	const result = await callBoard({ type: "reload" });
	if (result.ok !== true) {
		setStatus("err", result.error ?? "重载失败");
		return;
	}
	render(result.board);
	setStatus("", "已从磁盘重载布局");
}

// #endregion

// #region 左侧工作区列表（P3）
//
// 分组、搜索、居中这三件事的**纯逻辑在 view.js**（不碰 DOM，因此能在 Node 里测）。
// 这里只负责把它们接到界面上。

/** 当前搜索词（小写）。 */
let searchQuery = "";

/**
 * 「正在写规格时有人要求重绘」的延迟标记。
 *
 * 场景：用户点开规格开始打字，然后顺手点了画布上的画板——
 * 那会触发 `select → applySelection → renderSidebar`，把 DOM 整个重建，
 * **用户还没按回车的内容就没了**（实测中移除焦点元素不保证触发 blur）。
 * 所以有输入框在编辑时先记一笔，等编辑结束（blur / 回车）后的那次重绘再补上。
 */
let sidebarDirty = false;

/**
 * 重绘左侧列表。
 */
function renderSidebar() {
	const active = document.activeElement;
	if (active !== null && active !== undefined && active.classList?.contains("spec-input") === true) {
		sidebarDirty = true;
		return;
	}
	sidebarDirty = false;

	const all = [...state.boards.values()].map((entry) => entry.data);
	const matched = all.filter((item) => matchesQuery(item, searchQuery, state.devices));
	dom.boardList.replaceChildren();

	if (all.length === 0) {
		dom.boardList.append(el("div", { class: "side-empty", text: "还没有画板。点上方「＋ 添加画板」开始。" }));
		dom.sideFoot.textContent = "";
		return;
	}
	if (matched.length === 0) {
		dom.boardList.append(el("div", { class: "side-empty", text: `没有匹配「${searchQuery}」的画板。` }));
		dom.sideFoot.textContent = `${all.length} 块画板`;
		return;
	}

	for (const group of groupByPath(matched)) {
		const head = el("div", { class: "group-head" }, [
			el("span", { class: "group-path", text: group.path, title: group.path }),
			// 「再加一台设备」：同路径多设备对比的最短路径。
			el("button", {
				class: "group-add",
				type: "button",
				text: "+设备",
				title: `再给 ${group.path} 加一块不同设备的画板`,
				onClick: () => openAddDialog({ path: group.path })
			})
		]);
		dom.boardList.append(head);
		for (const item of group.items) dom.boardList.append(buildRow(item));
	}

	dom.sideFoot.textContent = searchQuery === ""
		? `${all.length} 块画板 · ${groupByPath(all).length} 个路径`
		: `匹配 ${matched.length} / ${all.length} 块画板`;
}

/**
 * 造一行画板条目。
 * @param item - 画板数据。
 * @returns 元素。
 */
function buildRow(item) {
	const row = el("button", {
		class: `item${item.id === state.selectedId ? " active" : ""}`,
		type: "button",
		title: `${item.name}\n${item.path}\n左键 = 选中并居中`,
		onClick: (event) => {
			// 点在规格上时不触发选中（那时是在编辑规格）。
			if (event.target instanceof HTMLInputElement) return;
			select(item.id);
			focusBoard(item.id);
		}
	});
	row.append(
		el("span", { class: "item-name", text: item.name }),
		el("span", { class: "item-meta", text: `${state.devices[item.device]?.label ?? item.device} · ${item.rect.w}×${item.rect.h}` })
	);

	// 规格：点一下就地编辑。这是「规格沉淀」的入口，所以不藏在别的面板里。
	const spec = el("span", {
		class: `item-spec${typeof item.spec === "string" && item.spec.trim() !== "" ? "" : " empty"}`,
		text: typeof item.spec === "string" && item.spec.trim() !== "" ? item.spec : "（点这里写规格）",
		title: "点一下编辑这块画板的规格；规格会随布局文件一起提交，团队可见",
		onClick: (event) => {
			event.stopPropagation();
			beginSpecEdit(row, item);
		}
	});
	row.append(spec);
	return row;
}

/**
 * 就地编辑规格。
 * @param row - 行元素。
 * @param item - 画板数据。
 */
function beginSpecEdit(row, item) {
	const input = el("input", {
		class: "spec-input",
		type: "text",
		value: item.spec ?? "",
		placeholder: "这块界面要解决什么？",
		onClick: (event) => event.stopPropagation(),
		onKeyDown: (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				// 只 blur，保存交给 onBlur——保证「保存」只有一条代码路径，
				// 也顺便把输入框换回普通显示（回车本身不会移走焦点，
				// 不移走的话重绘会被 sidebarDirty 延迟，行会卡在编辑态）。
				input.blur();
			} else if (event.key === "Escape") {
				event.preventDefault();
				// 取消编辑：把值改回原样再 blur，onBlur 会因为「没变化」而不写盘。
				input.value = item.spec ?? "";
				input.blur();
			}
		},
		onBlur: () => void saveSpec(item.id, input.value)
	});
	row.replaceChildren(input);
	input.focus();
	input.select();
}

/**
 * 保存规格。
 * @param id - 画板 id。
 * @param spec - 规格文本。
 */
async function saveSpec(id, spec) {
	const entry = state.boards.get(id);
	if (entry === undefined) return;
	if ((entry.data.spec ?? "") === spec) {
		renderSidebar();
		return;
	}
	const result = await callBoard({ type: "update", id, patch: { spec } });
	if (result.ok !== true) {
		setStatus("err", result.error ?? "保存规格失败");
		await reload();
		return;
	}
	render(result.board);
	setStatus("ok", spec.trim() === "" ? "已清空规格" : `已保存规格：${spec.trim()}`);
}

/**
 * 把画布居中到某块画板。
 *
 * 选中列表里的一行时，如果那块画板在视野外，用户会觉得「点了没反应」——
 * 所以顺手把它移到视野中央。
 *
 * @param id - 画板 id。
 */
function focusBoard(id) {
	const entry = state.boards.get(id);
	if (entry === undefined) return;
	const rect = dom.viewport.getBoundingClientRect();
	const { panX, panY } = centerPan({
		rect: entry.data.rect,
		viewport: { width: rect.width, height: rect.height },
		zoom: state.zoom
	});
	state.panX = panX;
	state.panY = panY;
	applyTransform();
	scheduleViewSave();
}

// #endregion

// #region 指令通道（画布 → Agent）

/**
 * 刷新指令条的可用状态。
 *
 * 不可用时**要说清为什么、下一步怎么办**——「发送」按钮灰着而不解释，
 * 用户只会以为坏了。
 */
async function refreshPromptStatus() {
	try {
		const response = await fetch(PROMPT_API, { headers: { accept: "application/json" } });
		const status = await response.json();
		if (status.available === true) {
			dom.promptTarget.classList.remove("bad");
			// **把匹配依据如实显示出来**：用户需要知道消息会发给谁、按什么规则挑的。
			// 精确匹配和"按上级目录猜"的可信度不一样，不能都含糊地叫"已匹配"。
			const via = status.source === "tool"
				? "已绑定"
				: status.source === "cwd-ancestor" ? "按上级目录匹配" : "按项目目录匹配";
			// 会话 id 很长，只显示尾部便于辨认。
			const short = String(status.sessionId ?? "").slice(-12);
			dom.promptTarget.textContent = `→ 会话 …${short}（${via}）`;
			dom.promptTarget.title = `指令会发给会话 ${status.sessionId}`
				+ (status.source === "cwd-ancestor" && typeof status.cwd === "string"
					? `\n匹配依据：没有会话的工作目录正好等于项目根，取了这个会话（工作目录 ${status.cwd}）——因为它与项目根是上下级关系。`
					: "");
			dom.promptText.disabled = false;
			dom.promptSend.disabled = false;
			// 注释卡片也要知道通道可用 —— 它用的是同一个桥。
			// 不告诉她的话，用户会写完一长段才发现发不出去。
			dom.ccTarget.classList.remove("bad");
			dom.ccTarget.textContent = `→ …${short}`;
			dom.ccTarget.title = `注释会发给会话 ${status.sessionId}`;
			updateCommentSendState();
			return;
		}
		dom.promptTarget.classList.add("bad");
		dom.promptTarget.textContent = "AI 指令不可用";
		dom.promptTarget.title = [status.error, status.hint].filter(Boolean).join("\n");
		dom.promptText.disabled = true;
		dom.promptSend.disabled = true;
		dom.ccTarget.classList.add("bad");
		dom.ccTarget.textContent = "Agent 不可用";
		dom.ccTarget.title = [status.error, status.hint].filter(Boolean).join("\n");
	} catch (error) {
		dom.promptTarget.classList.add("bad");
		dom.promptTarget.textContent = "AI 指令不可用";
		dom.promptTarget.title = `无法读取指令通道状态：${String(error?.message ?? error)}`;
		dom.promptText.disabled = true;
		dom.promptSend.disabled = true;
		dom.ccTarget.classList.add("bad");
		dom.ccTarget.textContent = "Agent 不可用";
		dom.ccTarget.title = String(error?.message ?? error);
	}
}

/**
 * 把输入框里的指令发给 Agent。
 *
 * 上下文只带**当前激活的画板**（P2 之后会再带上选中的元素）。
 */
async function sendPrompt() {
	const text = dom.promptText.value.trim();
	if (text === "") return;
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	const selection = entry === undefined
		? undefined
		: {
			board: {
				name: entry.data.name,
				path: entry.data.path,
				device: entry.data.device,
				rect: entry.data.rect,
				spec: entry.data.spec
			}
		};
	dom.promptSend.disabled = true;
	setStatus("", "正在把指令发给 Agent…");
	try {
		const response = await fetch(PROMPT_API, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text, selection })
		});
		const result = await response.json();
		if (result.ok === true) {
			const scope = selection === undefined ? "（未选画板）" : `（针对画板「${selection.board.name}」）`;
			setStatus("ok", `已发给 Agent${scope}：${text}`);
			dom.promptText.value = "";
		} else {
			setStatus("err", [result.error, result.hint].filter(Boolean).join(" "));
		}
	} catch (error) {
		setStatus("err", `发送失败：${String(error?.message ?? error)}`);
	} finally {
		dom.promptSend.disabled = false;
		dom.promptText.focus();
	}
}

// #endregion

// #region 事件绑定与启动

/**
 * 绑定全局事件。
 */
function bind() {
	dom.viewport.addEventListener("pointerdown", (event) => {
		// **中键平移不看目标是谁**：画板放大到占满画布时，根本找不到空白处可点，
		// 而「按住中键拖」是画布类工具的通用肌肉记忆，任何位置都该生效。
		if (event.button === 1) {
			event.preventDefault();
			beginPan(event);
			return;
		}
		// 左键只在空白处平移；点在画板上由画板自己处理（选中元素、移动画板）。
		if (event.target !== dom.viewport && event.target !== dom.world && event.target !== dom.empty) return;
		if (event.button !== 0) return;
		beginPan(event);
		select(null);
	});

	dom.viewport.addEventListener("wheel", (event) => {
		event.preventDefault();
		// 触控板双指滚动通常是「平移」，按住 ctrl 才是缩放；鼠标滚轮没有 ctrl。
		// 这里的取舍：**滚轮一律缩放**（画布类工具的通用预期），
		// 需要平移就用拖空白处或中键。
		zoomByWheel(event.deltaY, event.clientX, event.clientY);
	}, { passive: false });

	// 缩放控件：滚轮之外必须有一条明确、不用记快捷方式的路。
	// 用户报的「想放大结果放大了浏览器」正是因为只能靠滚轮/浏览器缩放。
	dom.zoomOut.addEventListener("click", () => zoomStep(1 / 1.25));
	dom.zoomIn.addEventListener("click", () => zoomStep(1.25));
	dom.zoomLabel.addEventListener("click", () => {
		// 点百分比 = 回到 100%，再点一次 = 适应全部（对齐常见画布工具）。
		if (Math.abs(state.zoom - 1) > 0.001) {
			const rect = dom.viewport.getBoundingClientRect();
			zoomAt(1, rect.left + rect.width / 2, rect.top + rect.height / 2);
		} else {
			fitAll();
		}
	});

	// 主题：三个按钮直接切，不用进菜单。
	dom.themeGroup.addEventListener("click", (event) => {
		const button = event.target.closest("button[data-theme]");
		if (button === null) return;
		applyTheme(button.dataset.theme);
		setStatus("", `主题：${{ light: "亮色", dark: "暗色", blue: "浅蓝" }[button.dataset.theme] ?? button.dataset.theme}`);
	});

	dom.btnFit.addEventListener("click", () => fitAll());
	// 撤销/重做：走与面板里那两个按钮同一条 WS 消息，不另起一套逻辑。
	// 用 `editor.history()` 而不是 `send()` —— 它要记住"这条回执得重载画板"，
	// 否则宿主撤销了、画板不刷新，用户看到的就是"撤销没反应"。
	dom.btnUndo.addEventListener("click", () => {
		if (editor === null) return;
		if (!editor.history("undo")) setStatus("err", "与宿主未连接，撤销不可用");
	});
	dom.btnRedo.addEventListener("click", () => {
		if (editor === null) return;
		if (!editor.history("redo")) setStatus("err", "与宿主未连接，重做不可用");
	});
	dom.btnReload.addEventListener("click", () => void reload());
	dom.btnAdd.addEventListener("click", () => openAddDialog());
	dom.btnPick.addEventListener("click", () => {
		const on = dom.btnPick.classList.toggle("active");
		dom.btnPick.setAttribute("aria-pressed", on ? "true" : "false");
		editor?.setPickMode(on);
		setStatus("", on
			? "已开启选择模式：在激活的画板里点击元素即可编辑（按 Esc 关闭）"
			: "已关闭选择模式：画板里的点击会正常传给页面");
	});

	dom.promptSend.addEventListener("click", () => void sendPrompt());
	dom.promptText.addEventListener("keydown", (event) => {
		if (event.key !== "Enter") return;
		event.preventDefault();
		void sendPrompt();
	});

	// 搜索：输入即过滤（本地数据，不需要防抖）。
	dom.search.addEventListener("input", () => {
		searchQuery = dom.search.value.trim().toLowerCase();
		renderSidebar();
	});

	// 侧栏页签：画板 / 图层
	dom.sideTabs.addEventListener("click", (event) => {
		const button = event.target.closest("button[data-pane]");
		if (button === null) return;
		const pane = button.dataset.pane;
		for (const item of dom.sideTabs.querySelectorAll("button")) {
			item.setAttribute("aria-pressed", item.dataset.pane === pane ? "true" : "false");
		}
		// 三个页签用同一套开关。分开写两个 if 很容易漏掉一个，
		// 表现是"切过去了但两个面板同时显示"——加页签时只要在这里多一项。
		for (const [key, node] of [["boards", dom.paneBoards], ["layers", dom.paneLayers], ["library", dom.paneLibrary], ["shape", dom.paneShape]]) {
			node.hidden = pane !== key;
		}
		localStorage.setItem("dsh-canvas:side-pane", pane);
		// 切到图层页签时才重绘：树要走一遍 DOM，没必要一直算。
		if (pane === "layers") {
			// ★ **进图层页签时，如果还没有激活画板就自动激活一块。**
			//
			// 不这么做的话用户看到的是「先在『画板』里选中一块画板」——
			// 而画布上明明有画板。他得先切到画板页签、点一块、再切回来
			//（三步，而且完全猜不到）。
			//
			// 自动激活最合理的候选：**当前画布上有元素被选中的那块**
			//（编辑层的 activeId），否则第一块。
			if (state.selectedId === null && state.boards.size > 0) {
				const picked = editor?.activeId;
				const first = typeof picked === "string" && state.boards.has(picked)
					? picked
					: [...state.boards.keys()][0];
				select(first);
				renderSidebar();
			}
			renderLayers();
		}
		if (pane === "library" && libraryPanel === null) initLibraryPanel();
	});

	// 导入设计包：按钮触发隐藏的 file input（浏览器不允许直接弹文件框）
	dom.btnLibraryImport.addEventListener("click", () => dom.libraryFile.click());
	dom.libraryFile.addEventListener("change", () => {
		// ★ 一次可以选多个（`<input multiple>`）—— 遍历 `files`，
		// 不要只取 `[0]`（那样选十个也只导一个，而且用户完全不知道为什么）。
		const files = [...(dom.libraryFile.files ?? [])];
		if (files.length > 0) void importLibraryFiles(files);
		// 清空 value：同一个文件选第二次也要能触发 change，否则"再导一次"没反应
		dom.libraryFile.value = "";
	});

	dom.layerSearch.addEventListener("input", () => {
		layerQuery = dom.layerSearch.value.trim().toLowerCase();
		renderLayers();
	});

	// 新建面板 / 全部折叠
	dom.btnLayerNew.addEventListener("click", () => openNewPanel());
	dom.btnLayerCollapse.addEventListener("click", () => {
		const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
		if (entry === undefined) return;
		try {
			const doc = entry.frame.contentDocument;
			const { nodes } = buildLayerTree(doc.body);
			/**
			 * 递归把所有有子节点的图层收进折叠集合。
			 * @param list - 节点数组。
			 */
			const collapseAll = (list) => {
				for (const node of list) {
					if ((node.children ?? []).length > 0) collapsedLayers.add(node.element);
					collapseAll(node.children ?? []);
				}
			};
			collapseAll(nodes);
			renderLayers();
		} catch { /* 画板没加载完就算了 */ }
	});

	// 右键菜单：点别处 / 按 Esc / 滚动都关掉，否则会一直挂在屏幕上
	window.addEventListener("click", () => closeLayerMenu());
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape") closeLayerMenu();
	}, true);
	window.addEventListener("resize", () => closeLayerMenu());
	dom.addCancel.addEventListener("click", () => dom.dialog.close());
	dom.addForm.addEventListener("submit", (event) => {
		event.preventDefault();
		const path = dom.addPath.value.trim();
		if (path === "") return;
		const device = dom.addDevice.value;
		void addBoard({
			path,
			name: dom.addName.value.trim(),
			device,
			spec: dom.addSpec.value.trim()
		});
		dom.dialog.close();
	});

	window.addEventListener("keydown", (event) => {
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
		// 撤销/重做：这是最该有的快捷键，之前只藏在面板底部一个滚不到的地方。
		const mod = event.ctrlKey || event.metaKey;
		if (mod && event.key.toLowerCase() === "z") {
			event.preventDefault();
			if (editor !== null) editor.history(event.shiftKey ? "redo" : "undo");
			return;
		}
		if (mod && event.key.toLowerCase() === "y") {
			event.preventDefault();
			if (editor !== null) editor.history("redo");
			return;
		}
		if (mod) return; // 其余带修饰键的组合交还给浏览器，别抢
		if (event.key === "0") fitAll();
		else if (event.key === "1") {
			zoomAt(1, dom.viewport.getBoundingClientRect().left + 10, dom.viewport.getBoundingClientRect().top + 10);
		} else if (event.key === "Delete" || event.key === "Backspace") {
			// ⚠️ **先看有没有选中的元素**：有 → 删元素；没有 → 才删整块画板。
			//
			// 实测踩过：这里原先直接 `removeBoard(state.selectedId)`，
			// 于是「选中一个自己画的形状 → 按 Delete」的结果是**整块画板没了**，
			// 而用户以为删的是形状。数据损失且没有撤销——这是本轮最严重的一个坑。
			//
			// 判定顺序不能只靠 `removeSelected()` 的返回值：
			// 它返回 false 有两种含义（"没选中元素" / "选中了但删不了"），
			// 混在一起会导致后者**继续往下删画板**。所以这里先分开判断。
			event.preventDefault();
			const hasElement = editor?.selected !== null && editor?.selected !== undefined;
			if (hasElement) {
				editor.removeSelected();
				return;
			}
			if (state.selectedId === null) return;
			// ★★ **删画板之前必须确认**（用户实测的「画布怎么空了」）
			//
			// 上面那条判定挡住了"想删形状却删了画板"，但还有第二个坑：
			// **画板只要被点过一次就是"选中"状态**，此后随手一个 Delete
			// 就会把整块画板抹掉 —— 而画布上看不出"我现在选中的是画板"，
			// 用户根本不知道自己在删什么。实测就是这么丢的：
			// 一次 `drag-begin` 之后 4 秒，`workspaces.json` 变成 `"workspaces": []`。
			//
			// 画板是**配置文件里的一条记录**，删掉就等于丢失整个工作区布局，
			// 而且**没有撤销**（元素的删除有 Ctrl+Z，画板这条没有）。
			// 所以这里要一次显式确认 —— 代价是多按一下键，
			// 换来的是"手滑不会丢画板"。
			const boardName = state.boards.get(state.selectedId)?.data?.name ?? state.selectedId;
			const yes = window.confirm(
				`删除画板「${boardName}」？\n\n`
				+ "这会从 workspaces.json 里移除它（画板上的内容文件不会被删）。\n"
				+ "这个操作不能撤销。"
			);
			if (yes) void removeBoard(state.selectedId);
			else setStatus("", `没删画板「${boardName}」（按 Delete 前会先问一次）`);
		} else if (event.key === "Escape") {
			handleEscape(event);
		}
	});

	window.addEventListener("resize", () => invalidateViewportRect());
	bindSplitter();
}

/**
 * Esc 的统一处理 —— **外壳和画板 iframe 共用这一个**。
 *
 * ## 为什么必须共用（用户报的"选中后永远退不出去，只能刷新"）
 *
 * 焦点在画板 iframe 里时，键盘事件**不会冒泡到外壳的 window** ——
 * 这是本项目反复踩的 iframe 边界问题（`edit.js` 的 `onFrameKey` 注释里
 * 为 Delete 键记过同样一笔）。
 *
 * 于是：点画板里的元素选中 → 焦点还在 iframe 里 → 按 Esc
 * → 外壳的 `window.addEventListener("keydown")` **根本收不到**
 * → 选中退不掉，用户只能刷新页面。
 *
 * ## 为什么不两边各写一套
 *
 * 两套 Esc 逻辑迟早会漂移（一边加了"退出注释模式"另一边忘了），
 * 而 Esc 的优先级是有讲究的。所以抽成一个函数，
 * 由「外壳 window」和「iframe 转发」两个入口调它。
 *
 * ## 优先级：关联选择 > 注释 > 选择模式 > 取消选中
 *
 * @param event - 键盘事件（可选；iframe 转发过来时 target 是 iframe 里的元素）。
 * @returns { void}。
 */
function handleEscape(event) {
	// 关联模式排最前：它是个"正在进行中的操作"，用户按 Esc 是想结束它
	// 并保存结果，而不是把选中的元素也一起退掉。
	if (linkPick !== null) {
		stopLinkPick();
		commitLinkPick();
		return;
	}
	// 注释模式同样排在选择模式之前：卡片开着的时候按 Esc，
	// 用户想收起来的是卡片，不是把选中元素也退掉。
	// ⚠️ 但**焦点在注释输入框里时不能抢** —— 那时 Esc 的含义是
	// "我改主意了不写了"，给输入框自己处理更符合直觉。
	//
	// （iframe 转发过来的 Esc，`event.target` 是画板里的元素，
	// 不可能等于 `dom.ccInput`，所以这一条会让注释模式正常退出 —— 符合预期：
	// 那时用户刚点完画板元素，注意力在画板上。）
	if (editor?.commentMode === true && event?.target !== dom.ccInput) {
		stopCommentMode();
		return;
	}
	// 退选择模式，再退选中 —— 两步都想要，所以按顺序来。
	if (dom.btnPick.classList.contains("active")) {
		dom.btnPick.classList.remove("active");
		dom.btnPick.setAttribute("aria-pressed", "false");
		editor?.setPickMode(false);
		setStatus("", "已关闭选择模式");
		return;
	}
	// 最后一步：取消选中。
	//
	// ## ⚠️ 这里有**三层**东西要清，缺一层就会「退出了但屏幕上还挂着」
	//
	// 用户报的原话是「退出选中后还有这个浮窗和选中框」。这三层是：
	//
	//   ① **元素选中**（编辑层的 `selected`）→ 画布上的选中框、角上的把手
	//   ② **画板选中**（外壳的 `state.selectedId`）→ 画板卡片外面那圈蓝框
	//   ③ **检查器浮窗**（`#inspector`）→ 它读的是 `editor.selected`
	//
	// 原来的写法**按 ① 是否存在来决定要不要清 ②**，于是：
	// ① 已经空了（上一次清过、或从没选中元素），代码直接跳到
	// 「没有可取消的选中」—— **② 和 ③ 就永远留在屏幕上**，
	// 而状态栏还在说"没有可取消的"。用户看到的就是"退不掉"。
	//
	// 所以现在不判断、**三层都清一遍**。清空是幂等的：
	// 多做一次不会错，少做一次却会留下一个用户关不掉的浮窗。
	const hadElement = editor?.clearSelection?.() ?? false;
	const hadBoard = state.selectedId !== null;
	if (hadBoard) select(null);
	// 无论哪一层清过，都让检查器按当前选中重算一次（选中为 null 它自己会隐藏）
	syncInspector();

	if (hadElement || hadBoard) {
		setStatus("", "已取消选中");
		return;
	}
	setStatus("", "没有可取消的选中");
}

// #endregion

// #region 主题

/** 主题存储键（本机偏好，不进项目文件）。 */
const THEME_KEY = "dsh-canvas:theme";
const THEMES = ["light", "dark", "blue"];

/**
 * 应用主题。
 *
 * 主题写在 `<html data-theme>` 上，CSS 令牌按属性选择器切换。
 * 样式面板在 Shadow DOM 里——CSS 自定义属性是**继承**的，会自然穿透到 shadow root，
 * 所以面板不需要单独处理（前提是它用的也是同一套令牌，见 editor.js）。
 *
 * @param theme - 主题名。
 * @param persist - 是否记住（用户点选时记住，跟随系统时不用）。
 */
function applyTheme(theme, persist = true) {
	const name = THEMES.includes(theme) ? theme : "dark";
	document.documentElement.dataset.theme = name;
	if (persist) localStorage.setItem(THEME_KEY, name);
	for (const button of dom.themeGroup.querySelectorAll("button")) {
		button.classList.toggle("active", button.dataset.theme === name);
	}
}

/**
 * 启动时决定用哪个主题。
 *
 * 优先级：用户上次选的 > 系统偏好。首次访问跟随系统是最不容易让人骂的选择。
 */
function initTheme() {
	const saved = localStorage.getItem(THEME_KEY);
	if (saved !== null) {
		applyTheme(saved, false);
		return;
	}
	const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)").matches === true;
	applyTheme(prefersLight ? "light" : "dark", false);
}

// #endregion

// #region 图层树

/** 已折叠的图层（按元素存的，重绘后仍然保持折叠状态）。 */
const collapsedLayers = new WeakSet();
/** 当前图层搜索词（小写）。 */
let layerQuery = "";

/**
 * 重绘图层树。
 *
 * 数据来源是**激活画板**的 DOM：只有激活的那块可编辑，图层树跟着它走，
 * 免得树里列出一堆点了没反应的东西。
 */
function renderLayers() {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	dom.layerTree.replaceChildren();

	if (entry === undefined) {
		const tip = el("div", { class: "layer-empty" });
		tip.textContent = state.boards.size === 0
			? "还没有画板。先加一块画板，再回来管图层。"
			: "先在「画板」里选中一块画板——图层树只显示激活画板的结构。";
		dom.layerTree.append(tip);
		dom.layerFoot.textContent = "";
		return;
	}

	let doc;
	try {
		doc = entry.frame.contentDocument;
	} catch {
		doc = null;
	}
	if (doc === null || doc === undefined || doc.body === null) {
		dom.layerTree.append(el("div", { class: "layer-empty", text: "画板还没加载完，稍等一下或点「重载」。" }));
		dom.layerFoot.textContent = "";
		return;
	}

	const { nodes, total, truncated } = buildLayerTree(doc.body);
	const shown = layerQuery === "" ? nodes : filterLayerTree(nodes, layerQuery);
	// 搜索时自动展开：命中的东西藏在折叠项里等于没搜
	const forceExpand = layerQuery !== "";

	if (shown.length === 0) {
		dom.layerTree.append(el("div", {
			class: "layer-empty",
			text: layerQuery === "" ? "这块画板的 body 里没有可管理的元素。" : `没有匹配「${layerQuery}」的图层。`
		}));
	} else {
		dom.layerTree.append(...renderLayerNodes(shown, entry, forceExpand));
	}

	const selected = editor?.selected ?? null;
	dom.layerFoot.textContent = truncated
		? `已显示前 ${total} 个图层（过多，已截断）`
		: layerQuery === ""
			? `${total} 个图层`
			: `匹配 ${countLayerNodes(shown)} 个`;
	if (selected !== null) scrollLayerIntoView(selected);
}

/**
 * 数一数过滤后的节点总数。
 * @param nodes - 节点数组。
 * @returns 数量。
 */
function countLayerNodes(nodes) {
	let n = 0;
	for (const node of nodes) n += 1 + countLayerNodes(node.children ?? []);
	return n;
}

/**
 * 把节点数组渲染成 DOM 行。
 *
 * @param nodes - 图层节点。
 * @param entry - 所属画板。
 * @param forceExpand - 是否强制展开（搜索时为 true）。
 * @returns 元素数组。
 */
function renderLayerNodes(nodes, entry, forceExpand) {
	const out = [];
	for (const node of nodes) {
		const hasChildren = (node.children ?? []).length > 0;
		const expanded = forceExpand || !collapsedLayers.has(node.element);
		const isSelected = editor?.selected === node.element;

		const row = el("button", {
			class: `layer-row${isSelected ? " is-selected" : ""}${node.hidden ? " is-hidden" : ""}`,
			type: "button",
			title: `${node.selector}${node.hidden ? "（display:none）" : ""}${node.text === "" ? "" : `\n文本：${node.text}`}`,
			onClick: (event) => {
				// 点小三角 = 折叠/展开；点别处 = 选中
				if (event.target.classList.contains("layer-caret")) return;
				// 传画板 **id** 而不是条目对象：外壳的条目字段叫 frame、编辑层内部叫 iframe，
				// 直接传对象会形状错配（曾导致 elementScreenRect 抛错、树里不高亮）。
				editor?.selectFromTree(node.element, entry.data.id);
			},
			onMouseEnter: () => editor?.previewFromTree(node.element, entry.data.id),
			onMouseLeave: () => editor?.clearTreePreview()
		});

		// 缩进：每层一条竖线，比纯空白更容易看出归属
		for (let i = 1; i < node.depth; i += 1) {
			row.append(el("span", { class: `layer-indent${i === 1 ? " is-none" : ""}` }));
		}
		row.append(el("span", {
			class: `layer-caret${hasChildren ? "" : " is-leaf"}`,
			text: expanded ? "▾" : "▸",
			onClick: (event) => {
				event.stopPropagation();
				if (collapsedLayers.has(node.element)) collapsedLayers.delete(node.element);
				else collapsedLayers.add(node.element);
				renderLayers();
			}
		}));
		row.append(el("span", { class: "layer-tag", text: node.tag }));

		// 图层元数据（重命名 / 锁定）：存本机，**不写进源码**。
		// 名字是「这个人怎么称呼它」，属于工作区信息；写进源码会污染用户的标记。
		const meta = readLayerMeta(entry.data.path, node.element);
		row.append(el("span", {
			class: "layer-name",
			// 有自定义名字时优先显示它——用户起了名字就是想看那个
			text: meta.name !== "" ? meta.name : (node.name === node.tag ? "" : node.name)
		}));
		if (node.text !== "") row.append(el("span", { class: "layer-text", text: node.text }));

		// 眼睛：切显示/隐藏。这是**真实写源码**的操作（display:none）。
		row.append(el("button", {
			class: `layer-act${node.hidden ? " is-on" : ""}`,
			type: "button",
			text: node.hidden ? "◌" : "◉",
			title: node.hidden ? "当前隐藏（display:none），点击显示" : "点击隐藏（写 display:none 到源码）",
			onClick: (event) => {
				event.stopPropagation();
				editor?.declareFromTree(node.element, entry.data.id, { display: node.hidden ? null : "none" });
			}
		}));
		// 锁：只在本机生效，画布上点不中它（改样式时不会误选到）
		row.append(el("button", {
			class: `layer-act${meta.locked ? " is-on" : ""}`,
			type: "button",
			text: meta.locked ? "🔒" : "🔓",
			title: meta.locked ? "已锁定：画布上点不中它，点此解锁" : "锁定：画布上点不中它",
			onClick: (event) => {
				event.stopPropagation();
				writeLayerMeta(entry.data.path, node.element, { locked: !meta.locked });
				renderLayers();
			}
		}));
		if (meta.locked) row.classList.add("is-locked");

		// 右键菜单：复制 / 删除 / 新建 / 重命名
		row.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			editor?.selectFromTree(node.element, entry.data.id);
			openLayerMenu(event.clientX, event.clientY, node, entry);
		});
		// 拖拽调序
		row.draggable = true;
		row.addEventListener("dragstart", (event) => {
			event.dataTransfer.setData("text/plain", node.tag);
			event.dataTransfer.effectAllowed = "move";
			draggingLayer = { node, entry };
		});
		row.addEventListener("dragover", (event) => {
			if (draggingLayer === null || draggingLayer.node.element === node.element) return;
			event.preventDefault();
			// 上下各半：上半插到前面、下半插到后面
			const box = row.getBoundingClientRect();
			row.dataset.dropSide = event.clientY < box.top + box.height / 2 ? "before" : "after";
		});
		row.addEventListener("dragleave", () => { delete row.dataset.dropSide; });
		row.addEventListener("drop", (event) => {
			event.preventDefault();
			const side = row.dataset.dropSide ?? "after";
			delete row.dataset.dropSide;
			const from = draggingLayer;
			draggingLayer = null;
			if (from === null || from.node.element === node.element) return;
			moveLayer(from, node, side);
		});

		out.push(row);

		if (hasChildren && expanded) out.push(...renderLayerNodes(node.children, entry, forceExpand));
	}
	return out;
}

/** 正在拖拽的图层（拖拽期间才非空）。 */
let draggingLayer = null;

// #region 图层元数据（重命名 / 锁定）

/** 图层元数据的存储键前缀。 */
const LAYER_META_KEY = "dsh-canvas:layer-meta";

/**
 * 算一个元素在树里的**稳定路径**。
 *
 * 用「子节点序号链」（如 `1/0/2`）而不是选择器：选择器会因为 class 重复而撞车，
 * 序号链在结构不变时是唯一的。结构一变名字会跟丢——这是这个方案的已知代价，
 * 换来的是**不往用户源码里塞任何标记**（写 `data-canvas-id` 会污染标记）。
 *
 * @param element - 元素。
 * @returns 路径字符串。
 */
function layerPathOf(element) {
	const parts = [];
	let current = element;
	while (current !== null && current !== undefined && current.parentElement !== null) {
		parts.unshift([...current.parentElement.children].indexOf(current));
		current = current.parentElement;
	}
	return parts.join("/");
}

/**
 * 读图层元数据。
 * @param boardPath - 画板路径（用来隔离不同页面的同名路径）。
 * @param element - 元素。
 * @returns { name, locked }。
 */
function readLayerMeta(boardPath, element) {
	try {
		const all = JSON.parse(localStorage.getItem(LAYER_META_KEY) ?? "{}");
		const found = all?.[boardPath]?.[layerPathOf(element)];
		return { name: found?.name ?? "", locked: found?.locked === true };
	} catch {
		return { name: "", locked: false };
	}
}

/**
 * 写图层元数据。
 * @param boardPath - 画板路径。
 * @param element - 元素。
 * @param patch - { name?, locked? }。
 */
function writeLayerMeta(boardPath, element, patch) {
	let all;
	try {
		all = JSON.parse(localStorage.getItem(LAYER_META_KEY) ?? "{}");
	} catch {
		all = {};
	}
	if (all === null || typeof all !== "object") all = {};
	all[boardPath] = all[boardPath] ?? {};
	const key = layerPathOf(element);
	const next = { ...(all[boardPath][key] ?? {}), ...patch };
	if (next.name === "" || next.name === undefined) delete next.name;
	if (next.locked !== true) delete next.locked;
	if (Object.keys(next).length === 0) delete all[boardPath][key];
	else all[boardPath][key] = next;
	try {
		localStorage.setItem(LAYER_META_KEY, JSON.stringify(all));
	} catch { /* 存不下就算了，不值得打断操作 */ }
}

/**
 * 元素是否被锁定（画布上点选时要跳过它）。
 *
 * 锁定只在**本机**生效，是「别让我误点它」的辅助，不是权限。
 * 所以存 localStorage、不写源码、也不进项目文件。
 *
 * @param boardPath - 画板路径。
 * @param element - 元素。
 * @returns 是否锁定。
 */
function isLayerLocked(boardPath, element) {
	return readLayerMeta(boardPath, element).locked;
}

// #endregion

// #region 结构改动

/**
 * 发一次结构改动给宿主。
 *
 * @param kind - "duplicate" | "remove" | "insert" | "move"。
 * @param node - 目标图层节点（或元素）。
 * @param entry - 画板条目。
 * @param payload - 额外参数。
 */
function sendMutate(kind, node, entry, payload = {}) {
	const element = node.element ?? node;
	const hint = editor?.describeForTree(element);
	if (hint === undefined) return;
	// 带上 pin：结构改动**不接受猜测**，宿主定位不唯一时会直接拒绝。
	// 客户端已经知道用户选的是哪个元素（选中时就定位过一次），复用那个结果。
	const pin = editor?.pinForTree(element);
	setStatus("", `正在${MUTATE_LABEL[kind] ?? kind}…`);
	editor?.sendMutate(kind, hint, entry.data.path, payload, pin);
}

/** 结构改动的中文名。 */
const MUTATE_LABEL = { duplicate: "复制", remove: "删除", insert: "新建", move: "移动" };

/**
 * 把图层移动到另一个图层旁边。
 *
 * @param from - { node, entry } 来源。
 * @param to - 目标节点。
 * @param side - "before" | "after"。
 */
function moveLayer(from, to, side) {
	if (from.entry.data.id !== state.boards.get(state.selectedId)?.data.id) {
		setStatus("err", "跨画板移动暂不支持——两个元素不在同一个页面里");
		return;
	}
	sendMutate("move", from.node, from.entry, {
		position: side,
		target: editor?.describeForTree(to.element)
	});
}

// #endregion

// #region 右键菜单

/**
 * 打开图层右键菜单。
 *
 * @param x - 屏幕 X。
 * @param y - 屏幕 Y。
 * @param node - 图层节点。
 * @param entry - 画板条目。
 */
function openLayerMenu(x, y, node, entry) {
	const meta = readLayerMeta(entry.data.path, node.element);
	const menu = dom.layerMenu;
	menu.replaceChildren();

	/**
	 * 加一项。
	 * @param label - 文案。
	 * @param act - 点击动作。
	 * @param danger - 是否危险项。
	 */
	const item = (label, act, danger = false) => {
		menu.append(el("button", {
			class: danger ? "is-danger" : "",
			type: "button",
			text: label,
			onClick: () => {
				closeLayerMenu();
				act();
			}
		}));
	};

	item("复制图层", () => sendMutate("duplicate", node, entry));
	item("新建子元素…", () => {
		openNewPanel();
	});
	item(meta.name === "" ? "重命名…" : `重命名（现名「${meta.name}」）…`, () => {
		const name = window.prompt("给这个图层起个名字（留空恢复默认）", meta.name);
		if (name === null) return;
		writeLayerMeta(entry.data.path, node.element, { name: name.trim() });
		renderLayers();
	});
	item(meta.locked ? "解锁图层" : "锁定图层", () => {
		writeLayerMeta(entry.data.path, node.element, { locked: !meta.locked });
		renderLayers();
	});
	menu.append(el("hr"));
	// 包裹：插一个 div 把这个元素套进去。整理结构时最常用的一步。
	item("用 <div> 包裹", () => sendMutate("insert", node, entry, {
		position: "inside-start",
		markup: `<div class="wrapper">\n${editor?.outerHtmlForTree(node.element) ?? ""}\n</div>`
	}));
	item("删除图层", () => {
		if (!window.confirm(`确定删除 <${node.tag}>？源码里会真的删掉（可用 Ctrl+Z 撤销）。`)) return;
		sendMutate("remove", node, entry);
	}, true);

	menu.hidden = false;
	// 贴边时向内收，别让菜单跑到窗口外面
	const box = menu.getBoundingClientRect();
	menu.style.left = `${Math.min(x, window.innerWidth - box.width - 8)}px`;
	menu.style.top = `${Math.min(y, window.innerHeight - box.height - 8)}px`;
}

/** 关掉右键菜单。 */
function closeLayerMenu() {
	dom.layerMenu.hidden = true;
}

// #endregion

// #region 新建元素

/** 可新建的元素类型。够用就好，不做成完整的标签选择器。 */
const NEW_ELEMENTS = [
	{ tag: "div", label: "div 容器", markup: '<div class="new-box"></div>' },
	{ tag: "span", label: "span 文本", markup: '<span class="new-text">文本</span>' },
	{ tag: "p", label: "p 段落", markup: '<p class="new-paragraph">段落文字</p>' },
	{ tag: "button", label: "button 按钮", markup: '<button class="new-button" type="button">按钮</button>' },
	{ tag: "img", label: "img 图片", markup: '<img class="new-image" src="" alt="">' },
	{ tag: "input", label: "input 输入框", markup: '<input class="new-input" type="text" placeholder="请输入">' },
	{ tag: "ul", label: "ul 列表", markup: '<ul class="new-list">\n<li>第一项</li>\n<li>第二项</li>\n</ul>' },
	{ tag: "a", label: "a 链接", markup: '<a class="new-link" href="#">链接</a>' },
	{ tag: "section", label: "section 区块", markup: '<section class="new-section"></section>' }
];

/** 新建面板是否已铺好类型按钮。 */
let newPanelReady = false;

/** 打开（或收起）新建面板。 */
function openNewPanel() {
	const panel = dom.layerNew;
	if (newPanelReady) {
		panel.hidden = !panel.hidden;
		return;
	}
	panel.replaceChildren();
	for (const item of NEW_ELEMENTS) {
		panel.append(el("button", {
			type: "button",
			text: item.label,
			title: `<${item.tag}>`,
			onClick: () => createLayer(item)
		}));
	}
	newPanelReady = true;
	panel.hidden = false;
}

/**
 * 在选中图层里新建一个元素。
 *
 * 位置固定在**选中元素的内部末尾**：这是最不会出意外的落点
 *（插到兄弟前后要判断那个兄弟在源码里的边界，落错地方会破坏排版）。
 *
 * @param item - NEW_ELEMENTS 里的一项。
 */
function createLayer(item) {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	const target = editor?.selected ?? null;
	if (entry === undefined) {
		setStatus("err", "先在「画板」里选中一块画板");
		return;
	}
	if (target === null) {
		setStatus("err", "先在图层树或画布里选中一个元素——新元素会建在它里面");
		return;
	}
	sendMutate("insert", { element: target }, entry, { position: "inside-end", markup: item.markup });
}

// #endregion

/**
 * 把当前选中的图层滚进视野。
 * @param element - 选中的元素。
 */
function scrollLayerIntoView(element) {
	const rows = dom.layerTree.querySelectorAll(".layer-row");
	for (let i = 0; i < rows.length; i += 1) {
		if (rows[i].classList.contains("is-selected")) {
			rows[i].scrollIntoView({ block: "nearest" });
			return;
		}
	}
	void element;
}

/**
 * 展开到某个元素（选中发生在画板里时，让树跟着打开到它）。
 * @param node - 元素。
 */
function revealLayer(node) {
	let current = node;
	while (current !== null && current !== undefined) {
		collapsedLayers.delete(current);
		current = current.parentElement;
	}
}

// #endregion

// #region 创建组件（图形绘制）

/**
 * 可画的图形。
 *
 * 目录（`SHAPE_LIST`）和默认外观（`SHAPE_DEFAULT_STYLE`）都住在 `shapes.js`：
 * 形状和它的默认值是一体的，分放两处迟早漏改一个。
 *
 * ⚠️ 默认外观里**必须用真实颜色，不能用外壳的 CSS 令牌**——
 * 那是画板的页面，没有 `--accent` 这些变量。实测踩过：写成 `var(--accent)`
 * 导致形状**完全透明**，源码里有元素、画布上什么都看不见。
 * 细节见 `shapes.js` 里 `SHAPE_DEFAULT_STYLE` 的注释。
 */

/** 绘制器实例。 */
let shapeDrawer = null;

/**
 * 挑一个**能插东西**的锚点 —— **两条插入路径共用这一个**。
 *
 * ## ⚠️ 不能直接用 `body.lastElementChild`（用户报的「组件拖动不进去」）
 *
 * 原来两条路（拖放库组件 / 画形状）都写着：
 *
 * ```js
 * const anchor = body.lastElementChild ?? body;
 * ```
 *
 * 而**原型页面（以及很多真实页面）的最后一个子元素是 `<script>`**：
 *
 * ```
 * <body>
 *   <header class="topbar"> … <footer class="status-bar">
 *   <script>…</script>      ← lastElementChild 就是它
 * </body>
 * ```
 *
 * `<script>` 不可见、往里插东西也看不见，但它**有开标签** ——
 * 于是定位器老老实实去找 script 的源码位置，拿不到就兜底到第 1 行，
 * `findOpeningTag` 随即失败。用户看到的是：
 *
 * > 在 prototype.html:1 附近没找到可编辑的开标签
 *
 * **而且他完全不知道自己做错了什么** —— 拖放动作本身没有任何问题。
 *
 * ## 修法
 *
 * 从后往前找第一个**可见且可插入**的子元素；一个都没有才退回 `body`
 *（`inside-end`，插在 body 末尾）。
 *
 * 副作用是好的：锚点变成 `.status-bar` 这类**真实可见**的元素，
 * 它的源码位置能正确定位，插入也就落到了对的地方。
 *
 * ⚠️ 用 `function` 声明（会 hoist）：两处调用点一个在 1900 行附近、
 * 一个在 3300 行附近，而定义只有一个。
 *
 * @param bodyEl - 画板的 `<body>`。
 * @returns `{ anchor, position }`。
 */
function pickInsertAnchor(bodyEl) {
	/** 这些标签不该当锚点：要么不可见，要么插进去没有意义。 */
	const SKIP = new Set(["SCRIPT", "STYLE", "LINK", "META", "TITLE", "TEMPLATE", "NOSCRIPT", "BASE", "HEAD"]);
	const children = [...bodyEl.children];
	for (let index = children.length - 1; index >= 0; index -= 1) {
		const node = children[index];
		if (SKIP.has(node.tagName)) continue;
		return { anchor: node, position: "after" };
	}
	return { anchor: bodyEl, position: "inside-end" };
}

/**
 * 松手后落盘：把图形写成真实元素插进画板。
 *
 * **走 sendMutate 而不是自己写文件**——撤销、快照、冲突检测全在那条通路上，
 * 绕过去就等于把这些再实现一遍。
 *
 * @param boardId - 画板 id。
 * @param geometry - 画板内几何 { left, top, width, height, angle? }。
 * @param shapeId - 形状 id（rect / ellipse / line / text）。
 */
function commitShape(boardId, geometry, shapeId) {
	const entry = state.boards.get(boardId);
	if (entry === undefined) {
		setStatus("err", "找不到那块画板");
		return;
	}
	// **每一步都报告失败原因，不要乐观地先写「已画出」。**
	// 早先这里直接 `setStatus("ok", "已画出…")`，失败时那句话会把真实错误盖掉，
	// 用户看到的是"已画出"可画布上什么都没有——**最难查的一类现象**（实测就是这么来的）。
	if (editor === null || editor === undefined) {
		setStatus("err", "编辑层没接上宿主，画出来的图形写不进源码（Ctrl+Shift+R 刷新试试）");
		return;
	}
	let body = null;
	try {
		body = entry.frame.contentDocument?.body ?? null;
	} catch (error) {
		setStatus("err", `读不到画板内容（可能是跨域）：${String(error?.message ?? error)}`);
		return;
	}
	if (body === null) {
		setStatus("err", "读不到画板内容：可能还没加载完，或这块画板是跨域的");
		return;
	}
	// 形状 id 兜底成 rect：万一传来一个不认识的 id，
	// 宁可画个矩形（看得见、能删），也不要静默什么都不插。
	const id = SHAPE_LIST.some((item) => item.id === shapeId) ? shapeId : "rect";
	const markup = buildShapeMarkup(id, geometry, SHAPE_DEFAULT_STYLE[id] ?? {}, { role: "functional", shape: id });
	// 锚点：见 `pickInsertAnchor` —— **不能直接用 body.lastElementChild**，
	// 原型页面的最后一子元素是 `<script>`，会定位失败成「prototype.html:1」。
	const { anchor, position } = pickInsertAnchor(body);
	let hint = null;
	try {
		hint = editor.describeForTree(anchor);
	} catch (error) {
		setStatus("err", `锚点定位失败：${String(error?.message ?? error)}`);
		return;
	}
	if (hint === null || hint === undefined) {
		setStatus("err", `定位不到锚点 <${String(anchor.tagName ?? "?").toLowerCase()}>，没法插入`);
		return;
	}
	// 留一份诊断快照：出问题时它就在 window 上，不用再猜
	globalThis.__DSH_CANVAS_SHAPE_LAST__ = { shape: id, geometry, anchorTag: anchor.tagName, hint, boardPath: entry.data.path, position };
	// 直线的"尺寸"要报**长度**：它的高恒等于线粗（2px），报「320×2」对用户没有意义
	const size = id === "line"
		? `长 ${Math.round(geometry.width)}px`
		: `${Math.round(geometry.width)}×${Math.round(geometry.height)}`;
	setStatus("", `正在写入${size}…（锚点 <${String(anchor.tagName).toLowerCase()}> · ${entry.data.path}）`);

	// `send` 在 socket 没开时返回 false——**必须检查**。
	// 不检查的话消息根本没发出去，界面却停在「正在写入…」，看起来就是"卡住了"。
	// 把 `entry` 也传进去：回执到达时按**这块**画板重载，
	// 而不是按"当前激活的"——画形状的板未必是激活的那块（见 edit.js 的 sendMutate）。
	const sent = editor.sendMutate("insert", hint, entry.data.path, { position, markup }, undefined, entry);
	if (sent === false) {
		setStatus("err", "与宿主未连接，画出来的图形写不进去（Ctrl+Shift+R 刷新试试）");
		return;
	}

	// **超时兜底：把"沉默"变成可见的错误。**
	//
	// 实测踩过：请求发出去了、宿主没回执，界面就永远停在「正在写入…」。
	// 用户看到"没反应"，我们这边也拿不到线索——是定位被拒了？宿主抛异常了？
	// 还是宿主在跑旧代码？全都看不出来。
	//
	// 到点还没回执就明说，并给出最可能的原因。
	// **沉默是最难查的故障**：宁可报一句可能不精确的提示，也不要什么都不说。
	const token = Symbol("shape-insert");
	globalThis.__DSH_CANVAS_SHAPE_PENDING__ = token;
	setTimeout(() => {
		if (globalThis.__DSH_CANVAS_SHAPE_PENDING__ !== token) return;
		globalThis.__DSH_CANVAS_SHAPE_PENDING__ = null;
		setStatus("err", "宿主 6 秒内没有回执。可能是：① 结构改动被拒绝（看提示）② 宿主还在跑旧代码，需要完全退出 DSH 再打开");
	}, 6000);

	// 画完自动切到「形状」页签：用户下一步一定是调参数，让他少点一次
	dom.sideTabs.querySelector('button[data-pane="shape"]')?.click();
}

/**
 * 切换绘制模式。
 * @param shape - 图形 id 或 null。
 */
function setShapeMode(shape) {
	if (shapeDrawer === null) return;
	shapeDrawer.setShape(shape);
	const on = shape !== null;
	dom.shapeBar.hidden = !on;
	dom.btnShape.classList.toggle("active", on);
	dom.btnShape.setAttribute("aria-pressed", on ? "true" : "false");
	for (const node of dom.shapeRow.children) {
		node.setAttribute("aria-pressed", node.dataset.shape === shape ? "true" : "false");
	}
	// 绘制和「选择元素」互斥：两套鼠标逻辑同时开着，点一下既画框又选元素，谁也说不清
	if (on && dom.btnPick.classList.contains("active")) {
		dom.btnPick.click();
	}
}

/** 初始化绘制（编辑器就绪后调）。 */
function initShapes() {
	shapeDrawer = createShapeDrawer({
		getBoards: () => state.boards,
		getBoardId: () => state.selectedId,
		onCommit: (boardId, geometry, shapeId) => commitShape(boardId, geometry, shapeId),
		onStatus: (tone, text) => setStatus(tone, text)
	});
	dom.shapeRow.replaceChildren(...SHAPE_LIST.map((s) => el("button", {
		class: "shape-pick",
		type: "button",
		"data-shape": s.id,
		"aria-pressed": "false",
		title: s.name,
		onClick: () => setShapeMode(shapeDrawer?.getShape() === s.id ? null : s.id)
	}, [
		el("span", { class: "shape-art", text: s.art }),
		el("span", { class: "shape-name", text: s.name })
	])));
	dom.btnShape.addEventListener("click", () => {
		setShapeMode(shapeDrawer?.getShape() === null ? "rect" : null);
	});
	// Esc 退出绘制模式（画板内的 Esc 由 shapes.js 处理单次手势）
	window.addEventListener("keydown", (event) => {
		if (event.key === "Escape" && shapeDrawer?.getShape() !== null) setShapeMode(null);
	});
}

// #endregion

// #region 形状参数面板

/** 形状参数面板实例。 */
let shapePanel = null;

/**
 * 读出当前选中元素的外观，喂给面板回显。
 *
 * 读**计算样式**而不是内联样式：用户在面板里改了值之后，内联样式才有；
 * 而刚画出来的图形、或者被别处样式影响的元素，内联样式是空的。
 * 读计算值才能保证面板里显示的就是他在画布上看到的。
 *
 * @param element - 选中的元素。
 * @returns 面板用的外观对象。
 */
function readShapeStyle(element) {
	if (element === null || element === undefined) return {};
	try {
		const win = element.ownerDocument?.defaultView;
		if (win === null || win === undefined) return {};
		const s = win.getComputedStyle(element);
		return {
			background: s.backgroundColor,
			borderColor: s.borderTopColor,
			borderWidth: s.borderTopWidth,
			borderStyle: s.borderTopStyle,
			borderRadius: s.borderTopLeftRadius,
			// 语义属性从 data-* 读回来
			__role: element.dataset?.role ?? "functional",
			__effect: element.dataset?.effect ?? "none",
			__interact: element.dataset?.interact ?? "click",
			__action: element.dataset?.action ?? "none",
			__target: element.dataset?.target ?? "",
			// 骨架屏类效果的**出现延迟**。
			//
			// 默认 **300ms 而不是 0** —— 这是刻意的：
			// 200ms 就返回的请求闪一下骨架屏是**纯噪声**，比不显示还糟。
			// 「设计工具给什么默认值，就是在教用户怎么用它」，
			// 所以面板上就该显示 300，让用户看到这个默认立场。
			__delay: element.dataset?.delay ?? "300"
		};
	} catch {
		return {};
	}
}

/** 元素检查器（只读信息条），挂在视口左上角。 */
let inspector = null;

/** 把选中项同步给元素检查器。 */
function syncInspector() {
	if (inspector === null) return;
	inspector.setSelection(editor?.selected ?? null);
}

/** 初始化元素检查器。 */
function initInspector() {
	inspector = createInspector({
		root: dom.inspector,
		el,
		// 面板上的「删除」按钮和 Delete 键走**同一条路**（`removeSelected`），
		// 不各写一份——两份实现迟早会分叉，而删除分叉的代价是数据。
		onDelete: () => {
			editor?.removeSelected?.();
		}
	});
}

/** 把选中项同步给形状面板。 */
function syncShapePanel() {
	if (shapePanel === null) return;
	const element = editor?.selected ?? null;
	// 选中一个图形时也把效果样式注入进去——不然用户选了「下坠感」，
	// 却因为没进过绘制模式而看不到任何变化，会以为功能坏了。
	if (element !== null && element !== undefined) ensureEffectStyle(element.ownerDocument);
	shapePanel.setSelection(element === null ? null : { element, style: readShapeStyle(element) });
	// 选中变了就重画这些**跟着选中走**的视觉辅助：
	// 关联连线（关系图）+ 交互提示（"这里能滑"）
	paintLinks();
	paintInteractHints();
}

/** 初始化形状参数面板。 */
function initShapePanel() {
	shapePanel = createShapePanel({
		root: dom.shapePanel,
		el,
		// 预览只改 DOM，提交才写源码 —— 和样式面板同一条通路，手感才一致。
		//
		// ⚠️ **必须调 `previewFromPanel`**，不能调 `previewFromTree`。
		//
		// 实测踩过（用户报「改了尺寸，选中框还停在原地不跟着走」）：
		// 这里原先调的是 `editor.previewFromTree(editor.selected, declarations)`，
		// 而那个方法的签名是 **`(element, boardId)`** —— 它是**图层树悬停高亮**用的。
		// 传进去的 declarations 被当成 boardId，`frames.get(object)` 拿不到东西，
		// 函数第一行就 `return` —— **预览完全没生效**。
		//
		// 更隐蔽的是：`previewFromPanel` 末尾有一句 `syncBoxes()`（改了样式就重画选中框）。
		// 走错方法让那句也一起没执行 —— 于是形状只有落盘、重载之后才变，
		// 而**选中框在预览期间一直不动**。用户看到的就是"不跟手"。
		onPreview: (declarations) => {
			editor?.previewFromPanel?.(declarations);
		},
		onCommit: (declarations) => {
			const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
			if (entry === undefined || editor?.selected == null) {
				setStatus("err", "先在画布上选中一个图形");
				return;
			}
			editor.declareFromTree(editor.selected, entry.data.id, declarations);
		},
		onAttr: (attrs) => {
			const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
			if (entry === undefined || editor?.selected == null) return;
			const element = editor.selected;

			// ★ **语义变化时同时写 ARIA 正式接口**。
			//
			// `data-*` 只有我们自己的运行时看得懂；读屏软件认的是
			// `role` / `aria-busy` / `aria-live` / `aria-invalid`。
			// 用户的框架也认这些 —— 他不需要读我们的文档就能顺着写样式。
			//
			// 面板一次只改一个字段（比如只改 `effect`），而算 ARIA 需要**全部**语义，
			// 所以先把"改完之后"合成出来，再算。
			const next = mergeSemantics(attrs, readSemantics((name) => element.getAttribute(name)));
			const aria = ariaFor(next);
			// ARIA 的 `null` 表示**删掉这个属性**：用户把「作用」从功能改成背景时，
			// 原来写的 `role="button"` 必须清掉 —— 否则一个大背景还留着
			// "我是个按钮"的语义，读屏软件会念错，而且**视觉上完全看不出来**。
			const merged = { ...attrs, ...aria };

			editor.sendMutate("attrs", editor.describeForTree(element), entry.data.path, { attrs: merged });

			// 面板上告诉用户"顺手写了什么无障碍属性"。
			// 不说的话这件事完全不可见 —— 他只会发现源码里多了几个没见过的属性。
			const written = Object.entries(aria)
				.filter(([k]) => !(k in attrs))
				.map(([k, v]) => (v === null ? `−${k}` : `${k}="${v}"`));
			if (written.length > 0) setStatus("ok", `已写入无障碍属性：${written.join("、")}`);
		},
		// 可连通的目标 = 当前所有画板。用户画了个按钮，能选「点了之后去哪个界面」。
		// 值用画板的应用路径——那是运行时真正能跳的地址，不是我们的内部 id。
		getTargets: () => [...state.boards.values()].map((e) => ({
			value: e.data.path,
			label: `${e.data.name ?? e.data.path}（${e.data.path}）`
		})),
		onStatus: (tone, text) => setStatus(tone, text),

		// ---- 关联（连通 → 关联，2026-10-07 重构）
		//
		// 关联是**图层与图层之间的边**，源码标记是唯一事实来源
		//（`data-mount` / `data-action`），所以这里全部从编辑层反推。
		getLinks: () => editor?.linksOfSelected?.() ?? { mounts: [], actions: [] },
		linkLabel: (dshId) => labelOfLinkId(dshId),
		onStartLink: (spec) => startLinkPick(spec),
		onUnlink: (kind) => {
			const result = editor?.unlink?.(kind);
			if (result?.ok === true) setStatus("ok", "已删除这条关联");
		}
	});
	syncShapePanel();
}

/**
 * 把 `data-dsh-id` 翻成可读名字（面板上显示"镶嵌到「header.bar」"）。
 *
 * 找不到就退回 id 本身 —— 那条关联可能指向另一块画板里的元素，
 * 或者对方被删了。**显示 id 比显示"未知"有用**：至少能对上源码。
 *
 * @param dshId - 关联里记的目标标识。
 * @returns 可读标签。
 */
function labelOfLinkId(dshId) {
	if (typeof dshId !== "string" || dshId === "") return "?";
	for (const entry of state.boards.values()) {
		let doc = null;
		try {
			doc = entry.frame.contentDocument ?? null;
		} catch {
			doc = null;
		}
		if (doc === null) continue;
		const node = doc.querySelector(`[data-dsh-id="${dshId}"]`);
		if (node !== null) {
			// 复用编辑层的标签逻辑：`div.bar 320×48` 这种，能直接对上画布上的东西
			const cls = typeof node.className === "string" && node.className.trim() !== ""
				? "." + node.className.trim().split(/\s+/u)[0]
				: "";
			const rect = node.getBoundingClientRect();
			return `${node.tagName.toLowerCase()}${cls} ${Math.round(rect.width)}×${Math.round(rect.height)}`;
		}
	}
	return dshId;
}

/**
 * 画出「这里能滑」的视觉提示。
 *
 * ## 为什么需要
 *
 * 用户在面板上给一个元素标了 `swipe-left`，**画布上什么都看不出来** ——
 * 那个标记只存在于源码里。而滑动恰恰是**最需要视觉提示的手势**：
 * 调研里 NN/g 的原话是滑动提示的强弱排序为
 * **内容溢出 > 页面留白 gutter > 箭头 >> 圆点**（圆点"太小、常被忽略"，
 * 而箭头"常死于对比度"——NBC.com 的箭头糊在图上没人看见）。
 *
 * ## 这里选了哪一档
 *
 * **边缘色带 + 方向箭头**。理由：
 * - 色带是设计工具里唯一**不会和内容打架**的表达（它贴在边上，不覆盖内容）
 * - 调研给的尺寸：**占元素宽的 12–16%、最小 56px** —— 太窄看不见，
 *   太宽就变成"内容溢出"那种强提示了，而这里只是想标注"能滑"
 * - **破坏性动作用 error 色**：左滑删除是 iOS 惯例，
 *   让它在画布上就显出"这是危险操作"，用户才会去想撤销的事
 *   （调研里 Wear OS 的规格明确要求破坏性动作**必须配 Undo**）
 *
 * ## 为什么不写进源码
 *
 * 这是**设计辅助**，不是页面内容。写进去的话用户的页面上会多出
 * 一堆没人要的色带 —— 和 `EFFECT_CSS` 不写进源码是同一条理由。
 *
 * ## 为什么不常驻显示
 *
 * 每个标了滑动的元素都常驻画色带的话，画布会变成一片色块。
 * 所以跟关联连线一套逻辑：**选中谁就显示谁的**。
 *
 * @returns { void }。
 */
function paintInteractHints() {
	const layer = ensureHintLayer();
	if (layer === null) return;
	layer.replaceChildren();

	const element = editor?.selected ?? null;
	if (element === null || element === undefined) return;

	const interact = element.dataset?.interact ?? "";
	if (!interact.startsWith("swipe-") && interact !== "edge-swipe") return;

	const rect = element.getBoundingClientRect();
	if (rect.width < 8 || rect.height < 8) return;

	// 方向：swipe-left 表示"往左滑"，所以色带贴在**右边**（手指从右往左划过去）
	const direction = interact === "edge-swipe" ? "right" : interact.replace("swipe-", "");
	const side = { left: "right", right: "left", up: "bottom", down: "top" }[direction] ?? "right";
	const horizontal = side === "left" || side === "right";
	// 12–16% 取 14%，但**不小于 56px** —— 调研给的下限，
	// 窄元素上按比例算出来可能只有十几个像素，那就等于没画
	const band = Math.max(56, horizontal ? rect.width * 0.14 : rect.height * 0.14);

	const color = SWIPE_TONE[interact] ?? "#1a73e8";

	// 色带：贴着要划出去的那条边
	const bar = document.createElement("div");
	bar.className = "hint-band";
	bar.style.background = `linear-gradient(${SWIPE_GRADIENT[side]}, ${color}cc, ${color}22)`;
	if (horizontal) {
		bar.style.top = `${rect.top}px`;
		bar.style.height = `${rect.height}px`;
		bar.style.width = `${band}px`;
		bar.style[side] = `${side === "left" ? rect.left : window.innerWidth - rect.right}px`;
	} else {
		bar.style.left = `${rect.left}px`;
		bar.style.width = `${rect.width}px`;
		bar.style.height = `${band}px`;
		bar.style[side] = `${side === "top" ? rect.top : window.innerHeight - rect.bottom}px`;
	}
	layer.append(bar);

	// 方向箭头：**放在色带上**，不是放在内容上 ——
	// 调研点名过"箭头糊在图上没人看见"（对比度问题），色带给了它一个干净底
	const arrow = document.createElement("div");
	arrow.className = "hint-arrow";
	arrow.textContent = SWIPE_ARROW[direction] ?? "‹";
	arrow.style.color = "#fff";
	arrow.style.fontSize = `${Math.min(28, Math.max(16, band * 0.34))}px`;
	if (horizontal) {
		arrow.style.top = `${rect.top + rect.height / 2}px`;
		arrow.style[side] = `${side === "left" ? rect.left + band / 2 : window.innerWidth - rect.right + band / 2}px`;
	} else {
		arrow.style.left = `${rect.left + rect.width / 2}px`;
		arrow.style[side] = `${side === "top" ? rect.top + band / 2 : window.innerHeight - rect.bottom + band / 2}px`;
	}
	layer.append(arrow);
}

/** 各滑动方向用的颜色：破坏性的用红，其余用主色。 */
const SWIPE_TONE = {
	// 左滑删除是 iOS 惯例，**这是危险操作** —— 在画布上就该显出来
	"swipe-left": "#d93025",
	"swipe-right": "#1a73e8",
	"swipe-up": "#5f6368",
	"swipe-down": "#5f6368",
	"edge-swipe": "#f9ab00"
};

/** 色带渐变方向（从贴边那侧往里淡出）。 */
const SWIPE_GRADIENT = {
	left: "90deg",
	right: "270deg",
	top: "180deg",
	bottom: "0deg"
};

/** 方向箭头。 */
const SWIPE_ARROW = { left: "‹", right: "›", up: "⌃", down: "⌄" };

/**
 * 取（或建）交互提示的覆盖层。
 *
 * 和关联连线层一样必须 `pointer-events: none` —— 它是装饰，
 * 挡住画布的话用户点不中任何东西。
 *
 * @returns 容器元素，或 null。
 */
function ensureHintLayer() {
	let layer = document.getElementById("hintLayer");
	if (layer !== null) return layer;
	if (dom.viewport === null || dom.viewport === undefined) return null;
	layer = document.createElement("div");
	layer.id = "hintLayer";
	layer.className = "hint-layer";
	dom.viewport.append(layer);
	return layer;
}

// #region 注释：选中元素 → 写评论 / 传图 → 发给 Agent
//
// ## 学的是 OpenDesign 的哪一点
//
// 它**不是"另一个聊天框"**，而是贴着元素的一张卡片：
// 上面是"这是哪个元素、长什么样"，下面是你要说的话。
//
// 这样解决的是一件事：**用户和 Agent 之间的共同语言**。
// 用户说"这个太挤了"，Agent 不知道"这个"是哪个、也不知道现在多少像素。
// 把选择器、尺寸、颜色、字体直接摆出来，两边看到的是同一组数字。
//
// ## 复用什么、不重复造什么
//
// 发送走**已有的 `PromptBridge`**（`/__canvas__/prompt`）——
// 它已经解决了"怎么找到该发给哪个会话"这个最难的问题
//（`sessionController.prompt` + 从工具调用里学到的 `exec.agent.id`）。
// 这里只负责**把消息组织好**和**把图片带上**。

/** 注释卡片上待发送的图片（data URL）。 */
let commentImages = [];

/** 正在评论的元素。 */
let commentTarget = null;

/**
 * 进入 / 退出注释模式。
 *
 * 进模式后点画布元素是"我要评论它"，不会触发选中和拖动 ——
 * 这一点和关联的选择模式是同一套思路（见 `edit.js` 的 `onFrameClick`）。
 *
 * **不退模式**：用户可以连着评论好几个元素。要退出按 Esc 或再点一次按钮。
 *
 * @returns { void }。
 */
function toggleCommentMode() {
	if (commentTarget !== null || editor?.commentMode === true) {
		stopCommentMode();
		return;
	}
	if (editor === null || editor === undefined) {
		setStatus("err", "画布还没就绪");
		return;
	}
	editor.commentMode = true;
	dom.btnComment.classList.add("active");
	dom.btnComment.setAttribute("aria-pressed", "true");
	setStatus("", "注释模式：点要评论的组件（Esc 退出）");
	showLinkBanner("点要评论的组件，然后写点什么", "注释");
}

/** 退出注释模式并收起卡片。 */
function stopCommentMode() {
	if (editor !== null && editor !== undefined) editor.commentMode = false;
	dom.btnComment.classList.remove("active");
	dom.btnComment.setAttribute("aria-pressed", "false");
	commentTarget = null;
	commentImages = [];
	dom.commentCard.hidden = true;
	hideLinkBanner();
	setStatus("", "已退出注释模式");
}

/**
 * 画布上点中了一个元素（注释模式专用）。
 *
 * ## ⚠️ 这里的失败必须可见
 *
 * 下面三步（填内容 → 显示 → 定位）任何一步抛异常，后面全部被跳过，
 * 卡片保持 hidden —— **用户看到的是「点了没反应」**，而异常发生在
 * 事件处理器里，连 console 都不显眼。这正是本项目反复踩的
 * 「三类静默失败」的老毛病。所以整段包进 try/catch，
 * 失败原因直接写进状态栏 —— 不让它静默。
 *
 * @param element - 被点的元素。
 * @returns { void }。
 */
function onCommentPick(element) {
	try {
		commentTarget = element;
		// 每换一个元素就清空上一轮的评论和附件 ——
		// 留着的话用户会以为“我写的这些是给新元素的”
		commentImages = [];
		dom.ccInput.value = "";
		renderCommentThumbs();
		paintCommentCard(element);
		dom.commentCard.hidden = false;
		// 卡片盖在元素旁边，别挡住它
		positionCommentCard(element);
		dom.ccInput.focus();
		setStatus("ok", `正在评论：${commentSelector(element)}`);
	} catch (error) {
		// 卡片可能停在“填了一半”的状态 —— 强制收起来，
		// 免得下次显示的是上一个元素的内容
		dom.commentCard.hidden = true;
		commentTarget = null;
		const detail = String(error?.message ?? error);
		setStatus("err", `注释卡片打开失败：${detail}`);
		// 事件处理器里的异常不进画布日志，所以存到 window 上 ——
		// 我（Agent）能用诊断脚本读到，不用你再描述一遍
		window.__dshCommentError = {
			at: Date.now(),
			message: detail,
			stack: String(error?.stack ?? "").slice(0, 800)
		};
	}
}

/**
 * 把元素信息填进卡片。
 *
 * 这一屏的数字**不进源码**，只进发给 Agent 的消息 ——
 * 它们是"当前事实"，不是设计意图，写进源码只会污染用户的页面。
 *
 * @param element - 被评论的元素。
 * @returns { void }。
 */
function paintCommentCard(element) {
	dom.ccSelector.textContent = commentSelector(element);

	const win = element.ownerDocument?.defaultView ?? window;
	const s = win.getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	const rows = [
		["Size", `${Math.round(rect.width)}×${Math.round(rect.height)}`],
		["Color", s.color],
		["Bg", s.backgroundColor],
		["Font", `${s.fontSize} ${s.fontWeight} ${s.fontFamily.split(",")[0].replace(/["']/gu, "")}`],
		["Line", s.lineHeight]
	];
	// 语义标记也摆出来 —— 用户很可能就是来问"这个关联为什么没生效"
	const semantics = readSemantics((name) => element.getAttribute(name));
	for (const [key, value] of Object.entries(semantics)) {
		if (value !== null) rows.push([`data-${key}`, value]);
	}

	dom.ccSpecs.replaceChildren(...rows.map(([label, value]) => {
		const dt = document.createElement("dt");
		dt.textContent = label;
		const dd = document.createElement("dd");
		dd.textContent = value;
		// 颜色值旁边画个色块 —— 光看 `oklch(0.5 0.19 255)` 没人知道是什么颜色
		if (/^(rgb|oklch|#|hsl)/iu.test(value)) {
			const chip = document.createElement("span");
			chip.className = "cc-chip";
			chip.style.background = value;
			dd.prepend(chip);
		}
		return [dt, dd];
	}).flat());
}

/**
 * 给元素生成一个可读的选择器（`span.eyebrow` 这样）。
 *
 * 学 OpenDesign 的显示方式。**优先用用户自己的 class** ——
 * 那是他和 Agent 都能在源码里搜到的东西；没有 class 才退回标签名。
 *
 * @param element - 元素。
 * @returns 选择器字符串。
 */
function commentSelector(element) {
	const tag = element.tagName.toLowerCase();
	// 用 `className` 而不是 `classList`：SVG 元素的 `className` 是对象不是字符串，
	// 直接当字符串用会得到 `[object SVGAnimatedString]`（这个坑踩过）
	const raw = typeof element.className === "string" ? element.className : "";
	const cls = raw.trim().split(/\s+/u).filter((c) => c !== "" && !c.startsWith("dsh-"));
	if (cls.length > 0) return `${tag}.${cls.slice(0, 2).join(".")}`;
	// 没有 class 时用 data-dsh-id 兜底 —— 那是我们自己写的标识，至少唯一
	const id = element.getAttribute?.("data-dsh-id");
	return id === null || id === undefined ? tag : `${tag}[data-dsh-id="${id}"]`;
}

/** 把卡片摆到元素旁边（优先右边，放不下就左边）。 */
function positionCommentCard(element) {
	const rect = element.getBoundingClientRect();
	const card = dom.commentCard;
	// 先显示再量尺寸，否则量到的是 0
	card.style.visibility = "hidden";
	card.hidden = false;
	const size = card.getBoundingClientRect();
	const gap = 12;
	let left = rect.right + gap;
	if (left + size.width > window.innerWidth - 8) left = rect.left - size.width - gap;
	if (left < 8) left = Math.max(8, window.innerWidth - size.width - 8);
	let top = rect.top;
	if (top + size.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - size.height - 8);
	card.style.left = `${Math.round(left)}px`;
	card.style.top = `${Math.round(top)}px`;
	card.style.visibility = "";
}

/**
 * 组装发给 Agent 的消息。
 *
 * 用户要的是"**自动拼接选中组件的路径以及相关提示词**"，所以这里给三层：
 *
 * 1. **是什么**：选择器 + 语义标记（他是靠这些在源码里搜的）
 * 2. **在哪**：源码文件:行（靠 `locate` 学到的映射，没有就如实说没有）
 * 3. **现在什么样**：尺寸 / 颜色 / 字体
 *
 * 最后一层是**最容易被漏掉但最有用**的 —— 用户说"太挤了"，
 * Agent 得知道现在是 `183×34` 才可能改对。
 *
 * @param element - 被评论的元素。
 * @param text - 用户写的话。
 * @returns 消息文本。
 */
/**
 * 从 `body` 到这个元素的**结构路径**，用来当稳定标识。
 *
 * ## 为什么需要它（用户问过「路径不能固定嘛？」）
 *
 * 注释消息里的 `源码：xxx.html:1045` **会漂** —— 它是"文件里的位置"，
 * 文件前面插一行后面全部后移。实测：同一个元素几分钟内从 `:1045` 变成 `:1074`，
 * 因为**我在那期间编辑了那个文件**。
 *
 * `id` / `data-*` 是稳的，但**大多数元素两者都没有**（`main.hero` 这种
 * 业务区块就一个都没有）。所以给一条结构路径兜底：
 *
 * ```
 * body > div.main > main.hero
 * ```
 *
 * 它跟着 **DOM 结构**走 —— 只要结构没变，文件怎么编辑都不影响。
 * 同名兄弟超过一个时才加 `:nth-of-type()`（加多了路径会变脆）。
 *
 * @param element - 目标元素。
 * @returns 结构路径字符串。
 */
function cssPathOf(element) {
	// 用 className 而不是 classList：SVG 元素的 className 是对象不是字符串
	const classNameOf = (node) => (typeof node.className === "string" ? node.className : "");
	const firstClassOf = (node) => classNameOf(node).trim().split(/\s+/u).filter((c) => c !== "" && !c.startsWith("dsh-"))[0];

	/*
	 * ★ 先试**最短的那个**：`tag.class` 在整篇文档里唯一的话，它就是最好的标识。
	 *
	 * 实测教训：直接用结构路径会得到
	 * `body > div.main:nth-of-type(1) > div.viewport > div.board:nth-of-type(3) > …`
	 * —— 5 级、全是 `nth-of-type`，又长又脆，Agent 读起来是噪音。
	 * 而 `main.hero` 本来就能唯一定位它。
	 */
	const tag = element.tagName.toLowerCase();
	const short = firstClassOf(element) === undefined ? tag : `${tag}.${firstClassOf(element)}`;
	try {
		if (element.ownerDocument.querySelectorAll(short).length === 1) return short;
	} catch { /* 选择器不合法（class 里有特殊字符）就算了，走结构路径 */ }

	const parts = [];
	let node = element;
	// 最多往上 4 级 —— 再长对 Agent 反而是噪音，而且容易变脆
	while (node !== null && node.nodeType === 1 && parts.length < 4) {
		if (typeof node.id === "string" && node.id !== "") {
			parts.unshift(`#${node.id}`);
			break;
		}
		let part = node.tagName.toLowerCase();
		const first = firstClassOf(node);
		if (first !== undefined) part += `.${first}`;
		const parent = node.parentElement;
		if (parent !== null) {
			// ⚠️ 「同名」要按 **tag + class** 比，不能只比 tag ——
			// 只比 tag 的话 `div.main` 也会因为兄弟里有别的 div 而被加上
			// `:nth-of-type(1)`，白白让路径变长（实测就是这么来的）。
			const same = [...parent.children].filter(
				(child) => child.tagName === node.tagName && classNameOf(child) === classNameOf(node)
			);
			if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
		}
		parts.unshift(part);
		node = node.parentElement;
	}
	return parts.join(" > ");
}

/**
 * 把注释卡片的内容拼成发给 Agent 的完整文本。
 * @param element - 被评论的元素。
 * @param text - 用户写的话。
 * @returns 完整消息文本。
 */
function buildCommentMessage(element, text) {
	const lines = ["【画布注释】"];
	lines.push(`元素：${commentSelector(element)}`);

	/*
	 * ★ **稳定标识** —— 用户问过「路径不能固定嘛？」。
	 *
	 * 答案是：**行号固定不了**。它是"文件里的位置"，不是"元素的身份" ——
	 * 文件前面插一行，后面所有行号全部后移。实测过一次：
	 * 用户在注释里看到同一个元素先是 `prototype.html:1045`、
	 * 几分钟后变成 `:1074` —— 因为**我在那期间编辑了这个文件**（插了 29 行）。
	 *
	 * 所以把**跟着元素走**的标识单独报一行：
	 *   - `id`（画布插入的元素都有，如 `dsh-lib-grab`）
	 *   - 全部 `data-*`（原型里每个区块都有 `data-part`，画布插入的有 `data-role`）
	 *
	 * 这些**文件怎么改都不变**，Agent 应该拿它们去定位，行号只当参考。
	 */
	const stable = [];
	if (typeof element.id === "string" && element.id !== "") stable.push(`#${element.id}`);
	for (const attr of element.attributes ?? []) {
		if (attr.name.startsWith("data-")) stable.push(`${attr.name}="${attr.value}"`);
	}
	// ★ 光有 `id` / `data-*` 不够 —— **大多数元素两者都没有**。
	// 实测：`main.hero` 这种业务元素（原型里最典型的区块）一个都没有，
	// 于是"标识"那行根本不输出，用户想要的"固定地址"还是缺。
	// 所以补一条**结构路径**：从 body 走下来，每级带标签名和 class。
	// 它同样**跟着元素走**（DOM 结构不变它就不变），也不随文件编辑漂移。
	if (stable.length === 0) stable.push(cssPathOf(element));
	lines.push(`标识：${stable.join(" ")}`);

	// 源码位置：选中时会由宿主回过一条 `located` 消息，编辑层记在 `this.located`。
	//
	// ## ⚠️ 这是**当前选中元素**的位置，不是"任意元素"的位置
	//
	// 原来这里直接读 `editor.located`，靠一个**假设**成立：
	// "评论目标 === 当前选中"（因为 `onCommentPick` 里先选中了才弹卡片）。
	//
	// 但这个假设**很容易被打破**：用户先点 A 弹出卡片、又顺手点了一下画板上的 B ——
	// B 变成了"当前选中"，`located` 指向 B，而卡片评论的**仍然是 A**。
	// 这时消息里会出现**元素名和尺寸是 A、源码位置是 B** 的错配，
	// 而 Agent 会照着那个位置去改 —— **改错文件**。
	//
	// 「报一个错的源码位置」比「不报」危险得多，所以这里**校验归属**：
	// 只有 `editor.selected` 就是本次评论的元素时，那个位置才可信。
	const located = editor?.selected === element ? (editor?.located ?? null) : null;
	if (located !== null && typeof located.file === "string" && located.file !== "") {
		const mark = located.confidence === "exact" ? "" : "（按内容匹配）";
		// ★ 明说"行号会漂" —— 用户实测过同一个元素从 `:1045` 变成 `:1074`，
		// 就是因为我在这期间编辑了那个文件（插了 29 行）。
		// 不写这句的话，Agent 会把它当成稳定地址，而它只是"我在那一刻看到的位置"。
		lines.push(`源码：${located.file}:${located.line ?? "?"}${mark} · 行号会随编辑漂移，以上面「标识」为准`);
	} else {
		// 如实说"不知道" —— 编一个位置比不给更糟，Agent 会照着改错文件
		lines.push("源码：未能定位（元素可能是运行时生成的，或选中已切换到别的元素）");
	}

	const win = element.ownerDocument?.defaultView ?? window;
	const s = win.getComputedStyle(element);
	const rect = element.getBoundingClientRect();
	lines.push(`尺寸：${Math.round(rect.width)}×${Math.round(rect.height)}`);
	lines.push(`文字色：${s.color}`);
	lines.push(`底色：${s.backgroundColor}`);
	lines.push(`字体：${s.fontSize} ${s.fontWeight}`);

	// `已标记` 只列 `readSemantics` 认得的那几个 `data-*`（role/shape/pin 等，
	// 那是画布自己的语义）。**别把它们和上面那行 `标识` 搞混**：
	// 这里是"业务上认得的标记"，`标识` 是"能唯一找回这个元素的原始属性"。
	// 两个都留着 —— 前者给人看，后者给 Agent 定位。
	const semantics = readSemantics((name) => element.getAttribute(name));
	const marks = Object.entries(semantics).filter(([, v]) => v !== null).map(([k, v]) => `data-${k}="${v}"`);
	if (marks.length > 0) lines.push(`已标记：${marks.join(" ")}`);

	const board = state.selectedId === null ? null : state.boards.get(state.selectedId);
	if (board !== undefined && board !== null) lines.push(`所在画板：${board.data.path}`);

	lines.push("");
	lines.push(`用户说：${text}`);
	return lines.join("\n");
}

/** 把已选图片画成缩略图（OpenDesign 里附件是显示出来的，不是只显示个数）。 */
function renderCommentThumbs() {
	const box = dom.ccThumbs;
	box.replaceChildren();
	box.hidden = commentImages.length === 0;
	commentImages.forEach((image, index) => {
		const wrap = document.createElement("div");
		wrap.className = "cc-thumb";
		const img = document.createElement("img");
		img.src = image;
		img.alt = `附图 ${index + 1}`;
		const del = document.createElement("button");
		del.type = "button";
		del.className = "cc-thumb-del";
		/*
		 * 图标用 SVG 而不是字符 `✕`。
		 *
		 * 这里是**动态创建**的元素，所以字符串在 JS 里而不是 HTML 里 ——
		 * 上面 grep "shell.html 里还有几个 glyph" 是查不到它的，
		 * 只查 HTML 会漏掉这一处（我就差点漏了）。
		 * 内容是我写死的常量，没有插值，`innerHTML` 在这里是安全的。
		 */
		del.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';
		del.title = "移除这张图";
		del.addEventListener("click", () => {
			commentImages.splice(index, 1);
			renderCommentThumbs();
			updateCommentSendState();
		});
		wrap.append(img, del);
		box.append(wrap);
	});
	updateCommentSendState();
}

/**
 * 发送按钮是否可用。
 *
 * **有图就能发** —— 用户有时只想贴张截图说"照这个改"，什么都不打。
 * 强制写字反而挡住最自然的用法。
 */
function updateCommentSendState() {
	const hasText = dom.ccInput.value.trim() !== "";
	dom.ccSend.disabled = !hasText && commentImages.length === 0;
}

/** 读一张图片为 data URL。 */
function readImageFile(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener("load", () => resolve(String(reader.result)));
		reader.addEventListener("error", () => reject(reader.error ?? new Error("读图失败")));
		reader.readAsDataURL(file);
	});
}

/** 把注释发给 Agent。 */
async function sendComment() {
	if (commentTarget === null) return;
	const text = dom.ccInput.value.trim();
	if (text === "" && commentImages.length === 0) return;

	dom.ccSend.disabled = true;
	dom.ccSend.textContent = "发送中…";
	const message = buildCommentMessage(commentTarget, text === "" ? "（见附图）" : text);

	try {
		const response = await fetch(PROMPT_API, {
			method: "POST",
			headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
			/*
			 * ⚠️ **请求体形状必须和主输入框那条路一致**（`{ text, selection }`）。
			 *
			 * 这里原来发的是 `{ action: "send", value: { … } }` ——
			 * 多包了一层。而 `/__canvas__/prompt` 的路由只解一层
			 *（`readJsonBody` 的 `value` 就是整个请求体），于是宿主收到的
			 * "request" 是 `{action, value}`，`request.text` 是 undefined
			 * → 三个字段全空 → 判空分支 → 用户看到
			 * **「发送失败：指令是空的。」**，而卡片里明明写着字。
			 *
			 * 包 `action` 是别的路由（library / mutate）的约定，prompt 不是那套。
			 * 两条路统一成直接的对象，签名就和 `prompt.send(request)` 对上了。
			 */
			body: JSON.stringify({
				text,
				// 元素信息交给宿主侧再拼一次（它那边的 composeMessage 更了解格式），
				// 同时把已经拼好的整段也带上 —— 图片那条路径需要完整文本
				message,
				images: commentImages
			})
		});
		const result = await response.json();
		if (result.ok === false) {
			setStatus("err", `发送失败：${result.error ?? "未知原因"}`);
			return;
		}
		setStatus("ok", `已发给 Agent（${result.imageCount ?? 0} 张图）`);
		// 发完清掉内容但**保留卡片和选中** —— 用户很可能想接着补充一句
		dom.ccInput.value = "";
		commentImages = [];
		renderCommentThumbs();
	} catch (error) {
		setStatus("err", `发送失败：${String(error?.message ?? error)}`);
	} finally {
		dom.ccSend.textContent = "发送给 Agent";
		updateCommentSendState();
	}
}

/** 绑定注释相关的界面事件。 */
function bindComment() {
	dom.btnComment.addEventListener("click", () => toggleCommentMode());
	dom.ccClose.addEventListener("click", () => stopCommentMode());
	dom.ccInput.addEventListener("input", () => updateCommentSendState());
	dom.ccInput.addEventListener("keydown", (event) => {
		// Ctrl/Cmd+Enter 发送 —— 聊天输入框的通用约定
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			void sendComment();
		}
	});
	dom.ccSend.addEventListener("click", () => void sendComment());

	// 「源码 ›」：把定位到的 `文件:行` 复制走。
	// 用户多半是要拿去编辑器里跳过去看，或者贴给别人。
	dom.ccCopyPath.addEventListener("click", async () => {
		const located = editor?.located ?? null;
		if (located === null || typeof located.file !== "string" || located.file === "") {
			setStatus("warn", "这个元素没能定位到源码（可能是运行时生成的）");
			return;
		}
		const text = `${located.file}:${located.line ?? "?"}`;
		try {
			await navigator.clipboard.writeText(text);
			setStatus("ok", `已复制源码位置：${text}`);
		} catch {
			// 剪贴板可能被权限挡住（非 https / 非用户手势）——
			// 退回到"至少让用户能选中复制"，而不是静默失败
			setStatus("warn", `复制失败，位置是：${text}`);
		}
	});

	dom.ccFiles.addEventListener("change", async (event) => {
		const files = [...(event.target.files ?? [])];
		for (const file of files) {
			if (!file.type.startsWith("image/")) continue;
			try {
				commentImages.push(await readImageFile(file));
			} catch (error) {
				setStatus("err", `读取「${file.name}」失败：${String(error?.message ?? error)}`);
			}
		}
		// 清掉 input 的值，否则同一个文件选第二次不会触发 change
		event.target.value = "";
		renderCommentThumbs();
	});

	// 拖动卡片：用户常要把它挪开才能看到被评论的元素
	const grip = dom.commentCard.querySelector(".cc-grip");	grip.addEventListener("pointerdown", (event) => {
		event.preventDefault();
		const startX = event.clientX;
		const startY = event.clientY;
		const originLeft = Number.parseFloat(dom.commentCard.style.left) || 0;
		const originTop = Number.parseFloat(dom.commentCard.style.top) || 0;
		const move = (moveEvent) => {
			dom.commentCard.style.left = `${Math.round(originLeft + moveEvent.clientX - startX)}px`;
			dom.commentCard.style.top = `${Math.round(originTop + moveEvent.clientY - startY)}px`;
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
	});
}

/**
 * 让「会话状态」那两个小标签可以点一下重查。
 *
 * ## 为什么需要
 *
 * 会话绑定是**在 Agent 调用画布工具时**才发生的（`exec.agent.id` 是唯一
 * 确定"谁在看这块画布"的来源）。而 `refreshPromptStatus()` 只在页面
 * 启动时跑一次 —— 于是常见的情形是：
 *
 *   1. 用户先打开画布 → 那时还没有会话绑定 → 显示「AI 指令不可用」
 *   2. Agent 调一次画布工具 → 后端绑上了
 *   3. **但界面不知道**，还显示不可用 → 用户以为这功能坏了
 *
 * 让它可点，用户不用刷新整页。顺带把"为什么不可用"的完整原因
 * 放在 tooltip 里 —— 包括**该怎么办**（让 Agent 调一次画布工具）。
 *
 * @returns { void }。
 */
function bindPromptStatusRefresh() {
	for (const chip of [dom.promptTarget, dom.ccTarget]) {
		if (chip === null || chip === undefined) continue;
		chip.style.cursor = "pointer";
		chip.addEventListener("click", () => {
			void refreshPromptStatus().then(() => {
				const bad = chip.classList.contains("bad");
				setStatus(bad ? "warn" : "ok", bad ? "仍然不可用，把鼠标停在标签上看原因" : "指令通道已就绪");
			});
		});
		chip.title += "（点一下重新检查）";
	}
}
// #endregion

/** 关联选择模式的进行态（null = 没在选）。 */
let linkPick = null;

/**
 * 画关联连线：从当前选中元素连到它关联的每一个目标。
 *
 * ## 为什么要画
 *
 * 用户的原话是这个功能的动机：「方便用户知道在哪」。
 * 关联是**看不见的关系** —— 一个图层挂着三个子图层、还指向一个页面，
 * 光看画布完全看不出来。连线是唯一能"一眼看到全貌"的表达。
 *
 * ## 用 SVG 覆盖层，而不是给每个目标加样式
 *
 * - 目标可能被别的元素盖住，加 outline 看不全
 * - 连线能表达**方向**（箭头），样式不能
 * - 覆盖层 `pointer-events: none`，不影响任何交互
 *
 * @returns { void}。
 */
function paintLinks() {
	const layer = ensureLinkLayer();
	if (layer === null) return;
	layer.replaceChildren();

	const info = editor?.linksOfSelected?.() ?? { mounts: [], actions: [] };
	const from = editor?.selected ?? null;
	if (from === null || from === undefined) return;

	const fromRect = from.getBoundingClientRect();
	if (fromRect.width === 0 && fromRect.height === 0) return;
	const start = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };

	for (const link of [...info.mounts, ...info.actions]) {
		const target = findElementByLinkId(link.to);
		if (target === null) continue;
		const rect = target.getBoundingClientRect();
		const end = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };

		// 镶嵌用实线（结构关系），功能用虚线（语义关系）—— 一眼能分
		const isMount = link.kind === "mount";
		const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
		line.setAttribute("x1", String(Math.round(start.x)));
		line.setAttribute("y1", String(Math.round(start.y)));
		line.setAttribute("x2", String(Math.round(end.x)));
		line.setAttribute("y2", String(Math.round(end.y)));
		line.setAttribute("stroke", isMount ? "#1a73e8" : "#9334e6");
		line.setAttribute("stroke-width", "2");
		if (!isMount) line.setAttribute("stroke-dasharray", "5 4");
		layer.append(line);

		// 目标端一个小圆点：连线多了之后能看清"连到的是谁"
		const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		dot.setAttribute("cx", String(Math.round(end.x)));
		dot.setAttribute("cy", String(Math.round(end.y)));
		dot.setAttribute("r", "4");
		dot.setAttribute("fill", isMount ? "#1a73e8" : "#9334e6");
		layer.append(dot);
	}
}

/**
 * 取（或建）关联连线的覆盖层。
 *
 * `pointer-events: none` 是必须的 —— 它是**纯装饰**，
 * 挡住画布的话用户点不中任何东西（这个坑在 ghost 上踩过一次）。
 *
 * @returns SVG 元素，或 null。
 */
function ensureLinkLayer() {
	let layer = document.getElementById("linkLayer");
	if (layer !== null) return layer;
	if (dom.viewport === null || dom.viewport === undefined) return null;
	layer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	layer.id = "linkLayer";
	layer.setAttribute("class", "link-layer");
	dom.viewport.append(layer);
	return layer;
}

/**
 * 按 `data-dsh-id` 找元素（可能在任何一块画板里）。
 *
 * @param dshId - 关联里记的目标标识。
 * @returns 元素或 null。
 */
function findElementByLinkId(dshId) {
	if (typeof dshId !== "string" || dshId === "") return null;
	for (const entry of state.boards.values()) {
		let doc = null;
		try {
			doc = entry.frame.contentDocument ?? null;
		} catch {
			doc = null;
		}
		if (doc === null) continue;
		const node = doc.querySelector(`[data-dsh-id="${dshId}"]`);
		if (node !== null) return node;
	}
	return null;
}

/**
 * 进入「选择要关联的图层」模式。
 *
 * ## 交互（用户要求：点"关联"时进行界面组件选择）
 *
 * 1. 面板点「＋ 添加关联」→ 进这里
 * 2. 画布上点图层 → 加入待关联列表（**可多选**）
 * 3. **Esc 结束**并一次性建立全部关联
 *
 * ## 为什么不是"点一次就建一条"
 *
 * 用户明确说"可多选"。逐次建边的话，每选一个都要写一次源码、
 * 触发一次画板重载 —— 画板一重载，选择模式就断了（节点对象全换新的）。
 * 所以**攒起来最后一起写**。
 *
 * @param spec - { kind, direction, action, targetUrl, message, tone }。
 * @returns { void }。
 */
function startLinkPick(spec) {
	const from = editor?.selected ?? null;
	if (from === null || from === undefined) {
		setStatus("err", "先在画布上选中一个图层，再点「＋ 添加关联」");
		return;
	}
	if (editor === null || editor === undefined) return;

	linkPick = { spec: spec ?? {}, picked: [] };
	// 编辑层靠这个开关把画布点击**改道**到 onLinkPick（不再触发选中/拖动）
	editor.linkPickMode = true;
	// 十字光标 + 面板上的提示横幅，让"现在是选图层模式"一眼可见
	document.body.classList.add("link-picking");
	showLinkBanner("点要关联的图层（可多选），按 Esc 结束");
	setStatus("", "关联：在画布上点目标图层（可多选），Esc 结束");
}

/** 退出关联选择模式（Esc 或无目标时）。 */
function stopLinkPick() {
	if (linkPick === null) return;
	if (editor !== null && editor !== undefined) editor.linkPickMode = false;
	document.body.classList.remove("link-picking");
	hideLinkBanner();
	clearLinkMarks();
}

/**
 * 画布上点中了一个图层（选择模式专用）。
 *
 * @param element - 被点的元素。
 * @returns { void }。
 */
function onLinkPick(element) {
	if (linkPick === null) return;
	if (element === editor?.selected) {
		setStatus("err", "不能关联到自己");
		return;
	}
	// 同一个元素点两次 = 取消选择（比"只能加不能减"好用得多）
	const index = linkPick.picked.indexOf(element);
	if (index >= 0) {
		linkPick.picked.splice(index, 1);
		element.style.outline = "";
	} else {
		linkPick.picked.push(element);
		// 给已选中的目标一个可见标记 —— 否则用户不知道点中了几个
		element.style.outline = "2px dashed #1a73e8";
		element.style.outlineOffset = "2px";
	}
	showLinkBanner(`已选 ${linkPick.picked.length} 个图层，按 Esc 结束`);
	setStatus("", `已选中 ${linkPick.picked.length} 个目标图层，Esc 结束`);
}

/** 清掉选择模式下画在目标上的临时标记。 */
function clearLinkMarks() {
	for (const element of linkPick?.picked ?? []) {
		element.style.outline = "";
		element.style.outlineOffset = "";
	}
}

/** 把建立结果写进状态栏（成功几条、失败原因）。 */
function commitLinkPick() {
	const pick = linkPick;
	linkPick = null;
	if (pick === null) return;
	const spec = pick.spec ?? {};
	const failures = [];
	let ok = 0;
	for (const target of pick.picked) {
		const result = editor?.linkTo?.(target, spec) ?? { ok: false, error: "编辑层没接上" };
		if (result.ok === true) ok += 1;
		else failures.push(result.error ?? "未知原因");
	}
	clearLinkMarks();

	if (ok > 0) setStatus("ok", `已建立 ${ok} 条关联${failures.length > 0 ? `（${failures.length} 条被拒）` : ""}`);
	else if (failures.length > 0) setStatus("err", failures[0]);
	else setStatus("", "没有选中任何图层");
}

/**
 * 在画布顶部显示一条模式提示横幅。
 *
 * 模式提示必须**显眼**：这些模式下画布点击不再走平时的行为，
 * 不说明的话用户会以为"画布坏了"。
 *
 * ⚠️ **前缀要按模式给，不能写死。**
 * 之前这里把 `关联模式：` 写死在函数里，于是注释模式弹出来的是
 * 「**关联模式**：点要评论的组件，然后写点什么」—— 一句话里两个模式名，
 * 用户看到的是"这工具自己都不知道自己在干嘛"。
 *
 * @param text - 提示文字。
 * @param label - 模式名（如「关联」「注释」）。
 * @returns { void }。
 */
function showLinkBanner(text, label) {
	let banner = document.getElementById("linkBanner");
	if (banner === null) {
		banner = document.createElement("div");
		banner.id = "linkBanner";
		banner.className = "link-banner";
		dom.viewport.append(banner);
	}
	banner.textContent = `${label ?? "关联"}模式：${text}`;
	banner.hidden = false;
}

/** 收起横幅。 */
function hideLinkBanner() {
	const banner = document.getElementById("linkBanner");
	if (banner !== null) banner.hidden = true;
}

// #endregion

// #region 设计库

/** 库面板实例。 */
let libraryPanel = null;

/**
 * 当前画板是否已经有库样式块。
 *
 * 判断用 `data-dsh-library` 属性而不是"找有没有 style"——用户页面本来就有 style，
 * 按标签名找会误判成"已注入"，于是组件插进去没样式，而且**不报错**。
 *
 * @returns 是否存在。
 */
function hasLibraryStyle() {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	if (entry === undefined) return false;
	try {
		return entry.frame.contentDocument?.querySelector("style[data-dsh-library]") !== null;
	} catch {
		return false;
	}
}

/**
 * 往当前画板注入库样式（令牌 + 组件 CSS）。
 *
 * 插在 body 第一个元素**之前**：放 body 末尾虽然也生效，但用户读源码时会先在
 * 最后看到一大坨样式、找不到自己的内容。
 *
 * @param css - 样式文本。
 * @param libraryId - 库 id。
 */
function injectLibraryStyle(css, libraryId) {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	if (entry === undefined) {
		setStatus("err", "先在「画板」里选中一块画板");
		return;
	}
	let first = null;
	try {
		first = entry.frame.contentDocument?.body?.firstElementChild ?? null;
	} catch { /* 画板没加载完 */ }
	if (first === null) {
		setStatus("err", "画板里还没有内容，先放一个元素再注入库样式");
		return;
	}
	const markup = `<style data-dsh-library="${libraryId}">\n${css.trim()}\n</style>`;
	setStatus("", "正在把库样式注入画板…");
	editor?.sendMutate("insert", editor.describeForTree(first), entry.data.path, { position: "before", markup });
}

/** 组件库拖拽的进行态（null = 没有在拖）。 */
let libraryDrag = null;

/** 拖拽时跟着鼠标的图标尺寸（要和 shell.css 里 `.library-ghost` 的宽高一致）。 */
const GHOST_SIZE = 34;

/**
 * 找出屏幕坐标落在哪块画板上。
 *
 * 画板是**缩放显示**的，所以还要换算成画板内的坐标（后续要用）。
 *
 * @param clientX - 屏幕 X。
 * @param clientY - 屏幕 Y。
 * @returns { entry, x, y } 或 null（落在空白处）。
 */
function boardAtPoint(clientX, clientY) {
	// 画板是**缩放显示**的（`state.zoom`，用户当时是 48%）。
	//
	// `rect` 已经是**缩放后**的屏幕矩形，所以 `clientX - rect.left` 得到的是
	// "显示像素"，**不是画板内坐标** —— 必须除以缩放比。
	//
	// 不除的后果正是用户报的「位置不跟随鼠标、有偏移」：
	// 48% 时插进去的坐标是实际的两倍多，肉眼看着就像"随机放置"。
	const zoom = Number(state.zoom) > 0 ? Number(state.zoom) : 1;
	for (const entry of state.boards.values()) {
		const rect = entry.frame.getBoundingClientRect();
		if (clientX < rect.left || clientX > rect.right) continue;
		if (clientY < rect.top || clientY > rect.bottom) continue;
		return {
			entry,
			x: (clientX - rect.left) / zoom,
			y: (clientY - rect.top) / zoom
		};
	}
	return null;
}

/**
 * 从组件库**抓起**一个组件：跟着鼠标走，松手落到画板里。
 *
 * ## 规矩（用户明确要求）
 *
 * - **必须落在某块画板里**；落到画布空白处要**拒绝**，不能"随便找个地方塞"
 * - 落点是**这块画板**，不是某个具体元素 —— 所以插到末尾
 *
 * ## 为什么锚点用 `body`
 *
 * 组件最终归属是"这块画板"。`<body>` 一定存在、一定有闭合标签、
 * 插入位置也明确（末尾），比"猜一个容器"稳得多。
 *
 * 会不会因此定位歧义？不会 —— 宿主那边有 `hintForBoard`：
 * 学过"这块画板对应哪个文件"之后，只在那个文件里找（详见 ops.js 的说明）。
 *
 * @param payload - { markup, label, x, y }。
 */
function beginLibraryDrag(payload) {
	// 每一步都记日志：用户报"长按没反应"时，静态检查全是通的
	//（onGrab 传了、attachLongPress 挂上了、entry.element 也在），
	// 所以只能靠运行现场分清楚**断在哪一环**。
	//
	// ⚠️ 必须显式传 `"info"`：`editor.log()` 的默认级别是 **debug**，
	// 而宿主 logger 默认只收 info 及以上 —— 不传级别这些日志**一条都不会落盘**
	//（第一版就是这样，加了探针等于没加）。
	editor?.log?.("library-drag-begin", {
		label: payload?.label,
		hasMarkup: typeof payload?.markup === "string" && payload.markup.trim() !== "",
		alreadyDragging: libraryDrag !== null
	}, "info");

	if (libraryDrag !== null) return;
	if (typeof payload?.markup !== "string" || payload.markup.trim() === "") {
		setStatus("err", "这个组件没有可插入的标记");
		return;
	}

	// ghost：**只显示图标本身**，不带名字。
	//
	// 用户的原话：「图标太复杂了，只需要图标本身，不需要那段注释文字」。
	// 名字放到 `title` 里 —— 需要时悬停能看到，平时不占地方、不挡视线。
	// （拖着东西时视线跟着鼠标，旁边多一截文字反而看不清自己在拖什么。）
	const ghost = document.createElement("div");
	ghost.className = "library-ghost";
	ghost.title = payload.label ?? "";
	const art = document.createElement("span");
	art.className = "library-ghost-art";
	// 标记来自用户自己的设计库，是**内容片段**不是脚本；
	// 而且组件 CSS 已经在画板里注入过，这里只取结构。用 innerHTML 是这一处的正解。
	art.innerHTML = payload.markup;
	ghost.append(art);
	document.body.append(ghost);

	// ★★ **拖动期间屏蔽所有画板的指针事件。**
	//
	// 用户的观察一针见血：「到边缘就卡住了」「无法进入 UI 那块界面区域」——
	// 因为画板是 **iframe**：指针一移进去，`pointermove` 就在 iframe 自己的
	// 文档里触发，**外壳的 window 监听收不到**，于是 ghost 停在边缘不动，
	// 落点也判不了。
	//
	// 这是「画板是 iframe」这个坑的第四次（前三次：事件不冒泡、
	// 预览 iframe 吃掉 pointerdown、形状预览）。
	//
	// 拖拽期间本来就不需要操作画板内容，所以临时把 iframe 变成"指针透明"，
	// 松手立刻恢复。这样 `pointermove` / `pointerup` 全程都落在外壳上。
	const shielded = [];
	for (const entry of state.boards.values()) {
		shielded.push([entry.frame, entry.frame.style.pointerEvents]);
		entry.frame.style.pointerEvents = "none";
	}

	libraryDrag = { payload, ghost, hitId: null, shielded };

	/** 更新 ghost 位置 + 高亮将要落入的画板。 */
	const follow = (x, y) => {
		// **图标正中对着鼠标**，而不是让鼠标在图标外侧。
		//
		// 原来写的是 `x + 14`（右下各偏 14px）。用户的反馈是
		// 「拖动阶段图标不跟随鼠标，会偏离鼠标一定距离」—— 那个固定偏移
		// 在起步时看着像"拖不动"，因为图标和鼠标之间永远隔着一截。
		// 减去自身一半（34×34 → 17）让视觉焦点落在光标上。
		ghost.style.left = `${Math.round(x - GHOST_SIZE / 2)}px`;
		ghost.style.top = `${Math.round(y - GHOST_SIZE / 2)}px`;
		const hit = boardAtPoint(x, y);
		const hitId = hit === null ? null : hit.entry.data.id;
		// 只在实际变化时才动 class，避免每帧都触发一次样式重算
		if (hitId === libraryDrag.hitId) return;
		libraryDrag.hitId = hitId;
		for (const [id, entry] of state.boards) {
			entry.element.classList.toggle("drop-target", id === hitId);
		}
	};
	follow(payload.x, payload.y);

	const onMove = (event) => follow(event.clientX, event.clientY);
	const onUp = (event) => {
		window.removeEventListener("pointermove", onMove);
		window.removeEventListener("pointerup", onUp);
		finishLibraryDrag(boardAtPoint(event.clientX, event.clientY));
	};
	window.addEventListener("pointermove", onMove);
	window.addEventListener("pointerup", onUp);

	setStatus("", `把「${payload.label}」拖进某块画板再松手`);
}

/**
 * 结束组件库拖拽：落到画板里就插入，落在空白处就拒绝。
 *
 * @param hit - `boardAtPoint` 的结果（null = 空白处）。
 */
function finishLibraryDrag(hit) {
	const drag = libraryDrag;
	libraryDrag = null;
	// 记下"落在哪"：`blank` 说明松手时不在任何画板范围内
	//（可能是画板还没加载出来、或者用户松在了侧栏上）
	editor?.log?.("library-drag-end", {
		hit: hit === null ? "blank" : hit.entry.data.id,
		boardCount: state.boards.size,
		label: drag?.payload?.label
	}, "info");

	if (drag === null) return;
	drag.ghost.remove();
	for (const entry of state.boards.values()) entry.element.classList.remove("drop-target");
	// 恢复画板的指针事件 —— 拖拽期间临时屏蔽的，忘了恢复画板就点不动了
	for (const [frame, previous] of drag.shielded ?? []) frame.style.pointerEvents = previous ?? "";

	// **必须在画板里** —— 这是用户明确要求的规矩，空白处一律拒绝
	if (hit === null) {
		setStatus("err", "要放进某块画板里——画布空白处不行");
		return;
	}
	const { entry, x, y } = hit;

	// 锚点用模块级的 `pickInsertAnchor`（见它的 JSDoc）——
	// 这里原来是**第二份同样的实现**，`body.lastElementChild` 那个坑它也有。
	// 提成一份共用，改一次两处都好。

	select(entry.data.id);

	let body = null;
	try {
		body = entry.frame.contentDocument?.body ?? null;
	} catch {
		body = null;
	}
	if (body === null) {
		setStatus("err", "读不到画板内容（可能还没加载完，或这块画板是跨域的）");
		return;
	}

	// ★★ 用落点坐标 + **明确的宽高**包一层容器。
	//
	// ## 位置：`hit.x` / `hit.y` 已经是画板内坐标
	//
	// `boardAtPoint` 会把屏幕坐标除以缩放比换算过来（见那里的说明）。
	//
	// ## 尺寸：容器必须有宽高，否则"只有框变大、图标纹丝不动"
	//
	// 用户的原话：「组件放大缩小也只是它的选中框，组件图标本身的大小并没有变化」。
	// 编辑层的缩放改的是**容器的 `width`/`height`** —— 容器没尺寸时那个值
	// 作用不到里面，于是框变了、内容没变。
	//
	// ## 但光有容器尺寸还不够：`svg` 的 `width="24"` **属性**会赢过继承
	//
	// 所以带一段**限定到本实例的 CSS** 把 svg 撑满。id 每次唯一，
	// 不会影响画板里别的东西，也不会和别的实例打架。
	const iconSize = 32;
	const instanceId = `dsh-lib-${Date.now().toString(36)}-${Math.floor(Math.random() * 1679616).toString(36)}`;
	const wrapped = [
		`<div class="dsh-shape" id="${instanceId}"`,
		` style="position:absolute;left:${Math.round(x)}px;top:${Math.round(y)}px`,
		`;width:${iconSize}px;height:${iconSize}px;display:grid;place-items:center;overflow:hidden">`,
		`<style>#${instanceId}>svg{width:100%;height:100%;display:block}</style>`,
		drag.payload.markup,
		"</div>"
	].join("");

	const { anchor, position } = pickInsertAnchor(body);
	let hint = null;
	try {
		hint = editor?.describeForTree?.(anchor) ?? null;
	} catch {
		hint = null;
	}
	if (hint === null || hint === undefined) {
		setStatus("err", `定位不到锚点 <${String(anchor.tagName ?? "?").toLowerCase()}>，没法插入`);
		return;
	}

	setStatus("", `正在把「${drag.payload.label}」放进「${entry.data.name}」…`);
	editor?.log?.("library-drag-insert", {
		label: drag.payload.label,
		board: entry.data.id,
		anchorTag: String(anchor.tagName ?? "?").toLowerCase(),
		position,
		// 落点坐标：排查"位置不对"时第一个要看的就是它，以及当时的缩放比
		dropX: Math.round(x),
		dropY: Math.round(y),
		zoom: state.zoom,
		instanceId,
		hasEditor: editor !== null && editor !== undefined,
		hintTag: hint?.tag ?? null,
		markupLength: wrapped.length
	}, "info");

	// ⚠️ **必须看返回值**。`sendMutate` 是同步返回 boolean 的：
	// 未连接宿主时返回 false，消息根本没发出去。
	// `commitShape`（画图形那条路）一直有这个检查 ——
	// 少了它，失败时界面只停在"正在放进…"，用户以为是自己没操作对。
	const sent = editor?.sendMutate("insert", hint, entry.data.path, {
		position,
		markup: wrapped
	}, undefined, entry);
	if (sent === false) {
		setStatus("err", "与宿主未连接，拖进来的内容写不进去（Ctrl+Shift+R 刷新试试）");
		return;
	}

	// ★ **放完之后选中它并高亮**（用户明确要求：让用户知道东西落在哪）。
	//
	// 元素要等画板**重载完成**才存在，所以记下 id、等 iframe 的 load 事件
	// 再按 id 找回来。直接在这里选中会拿到一个还没渲染的节点。
	const frame = entry.frame;
	const pick = () => {
		frame.removeEventListener("load", pick);
		let node = null;
		try {
			node = frame.contentDocument?.getElementById?.(instanceId) ?? null;
		} catch {
			node = null;
		}
		if (node === null) return;
		// 走 `selectFromTree`：它比 `select` 多做了三件事 ——
		// 设 activeEntry（否则面板改的是另一块画板）、通知外壳（图层树高亮）、
		// 发 select 让宿主定位源码（面板上"在哪个文件哪一行"才有值）。
		editor?.selectFromTree?.(node, entry.data.id);
		editor?.flashPlaced?.(node);
		setStatus("ok", `已放入「${entry.data.name}」：${drag.payload.label}`);
	};
	frame.addEventListener("load", pick);
}

/**
 * 把库里的标记插入画板。
 * @param payload - { markup, label }。
 */
function insertFromLibrary(payload) {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	if (entry === undefined) {
		setStatus("err", "先在「画板」里选中一块画板");
		return;
	}
	const target = editor?.selected ?? null;
	if (target === null) {
		setStatus("err", "先在画布或图层树里选中一个元素——插入的内容会放进它里面");
		return;
	}
	setStatus("", `正在插入「${payload.label}」…`);
	editor?.sendMutate("insert", editor.describeForTree(target), entry.data.path, {
		position: "inside-end",
		markup: payload.markup
	});
}

/**
 * 把库里的令牌应用到选中元素。
 *
 * 走 `declareFromTree` 而不是 `declare`：前者会先把选中态同步过去，
 * 保证"应用到了哪个元素"和"面板上显示的选中项"是同一个。
 *
 * @param declarations - 样式声明。
 * @param label - 令牌名。
 */
function applyLibraryToken(declarations, label) {
	const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
	if (entry === undefined || editor?.selected === null || editor?.selected === undefined) {
		setStatus("err", "先选中一个元素，再点令牌");
		return;
	}
	setStatus("", `正在应用「${label}」…`);
	editor.declareFromTree(editor.selected, entry.data.id, declarations);
}

/**
 * 把画布上选中的元素存为组件。
 * @param libraryId - 存进哪个库。
 */
function saveSelectionAsComponent(libraryId) {
	if (libraryId === null || libraryId === undefined) {
		setStatus("err", "还没有设计库，先导入一个设计包");
		return;
	}
	// ★ **支持多选**：Ctrl+点击挑几个元素 → 存成**一个**组合组件。
	//
	// 用户的原话：「把我们自己创建的组件/元素放入组件库复用」——
	// 单个元素用原来的路径就够，但"自己搭的一组东西"（比如一张卡片 =
	// 容器 + 标题 + 说明 + 按钮）必须能**一起**存下来才有复用价值。
	const picks = editor?.selectionForComponent?.() ?? [];
	if (picks.length === 0) {
		setStatus("err", "先在画布上选中一个元素（或 Ctrl+点击挑几个），再点「＋」");
		return;
	}

	let markup;
	if (picks.length === 1) {
		markup = editor.outerHtmlForTree(picks[0]);
	} else {
		// 多个元素 → 包一层容器，位置取它们的**包围盒**。
		//
		// 直接拼在一起不行：每个元素都有自己的 `position:absolute; left/top`，
		// 拼到别处之后会各自飞回原来的绝对坐标。包一层相对定位的容器，
		// 再把子元素按"相对包围盒左上角"重新定位，整体才是搬得走的。
		const boxes = picks.map((el) => el.getBoundingClientRect());
		const minX = Math.min(...boxes.map((b) => b.left));
		const minY = Math.min(...boxes.map((b) => b.top));
		const maxX = Math.max(...boxes.map((b) => b.right));
		const maxY = Math.max(...boxes.map((b) => b.bottom));

		const parts = [];
		for (const el of picks) {
			const box = el.getBoundingClientRect();
			const html = editor.outerHtmlForTree(el);
			// 把绝对定位改写成"相对容器左上角"
			const rebased = html.replace(
				/style="([^"]*)"/u,
				(_all, decls) => {
					const cleaned = String(decls)
						.split(";")
						.filter((d) => !/^\s*(left|top|position)\s*:/iu.test(d))
						.join(";");
					return `style="position:absolute;left:${Math.round(box.left - minX)}px;top:${Math.round(box.top - minY)}px;${cleaned}"`;
				}
			);
			parts.push(rebased);
		}
		markup = `<div class="dsh-shape" style="position:relative;width:${Math.round(maxX - minX)}px;height:${Math.round(maxY - minY)}px">`
			+ parts.join("")
			+ "</div>";
	}
	if (markup === "") {
		setStatus("err", "读不到选中元素的标记");
		return;
	}

	const fallbackName = picks.length === 1
		? String(picks[0].tagName ?? "组件").toLowerCase()
		: `组合组件（${picks.length} 个元素）`;
	const name = window.prompt("给这个组件起个名字", fallbackName);
	if (name === null || name.trim() === "") return;
	setStatus("", `正在存入设计库（${picks.length} 个元素）…`);
	void fetch(`${PREFIX}/__canvas__/library`, {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
		body: JSON.stringify({ action: "save-component", library: libraryId, name: name.trim(), markup })
	}).then((res) => res.json()).then((result) => {
		if (result.ok === false) { setStatus("err", result.error); return; }
		setStatus("ok", `已存入设计库：${result.component.name}（${result.component.slug}）`);
		// 存完清掉多选标记 —— 留着的话用户以为还挑着，下次点「＋」会重复存
		editor?.clearExtraSelection?.();
		void libraryPanel?.refresh();
	}).catch((error) => setStatus("err", `存入失败：${String(error?.message ?? error)}`));
}

/**
 * 上传**一个**设计包 zip 并导入。
 *
 * 只负责"读文件 → 发请求 → 返回结果"，**不碰状态栏** ——
 * 状态由调用方（单个走 `importLibraryFiles`，同样一条路径）统一显示。
 * 这样批量导入时进度和汇总都在一处，不会几个文件抢着改状态栏。
 *
 * @param file - File 对象。
 * @returns { Promise<{library: object, counts: object}> } 导入结果。
 * @throws 读文件失败、后端拒绝、网络错误。
 */
async function importLibraryFile(file) {
	// 用 FileReader 读成 base64 直接进 JSON，省掉一次二进制转码。
	const base64 = await new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
		reader.onerror = () => reject(new Error("读取文件失败"));
		reader.readAsDataURL(file);
	});
	// 库 id 从文件名推导；同名会落到同一个库，正好当"更新设计包"用
	const id = file.name.replace(/\.zip$/iu, "").trim();
	const res = await fetch(`${PREFIX}/__canvas__/library`, {
		method: "POST",
		headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
		body: JSON.stringify({ action: "import", id, zipBase64: base64 })
	});
	const result = await res.json();
	if (result.ok === false) throw new Error(result.error ?? "导入被拒绝");
	return { library: result.library, counts: result.library?.counts ?? {} };
}

/**
 * 批量导入设计包（一次选多个 zip）。
 *
 * ## 为什么**串行**而不是并发
 *
 * 一个设计包 zip 可能几十 MB，读成 base64 还要再放大 1/3。
 * 并发 N 个 = 内存里同时压着 N 份 base64 + N 个请求体，
 * 用户一次选十个就能把标签页拖垮。
 * 串行慢一点，但每一份都是**独立完成、独立报错**的，
 * 而且进度能如实显示（"正在导入 3/7"）。
 *
 * ## 为什么一个失败**不中断**后面的
 *
 * 批量导入里最烦的是"第三个坏了，后面七个没导"。
 * 所以每个都单独 catch，失败的记下来，最后一起报 ——
 * 用户能一眼看出到底是哪几个坏了、为什么。
 *
 * ## 状态栏只由这里改
 *
 * `importLibraryFile` 不碰状态栏，否则多个文件会互相覆盖，
 * 刷到最后只剩最后一个文件的消息，看着像只导了一个。
 *
 * @param files - File 列表。
 * @returns { Promise<void> }。
 */
async function importLibraryFiles(files) {
	const total = files.length;
	const done = [];
	const failed = [];

	for (let i = 0; i < total; i += 1) {
		const file = files[i];
		// 多选时显示进度；单选时保持原来那句"正在读取 xxx"
		setStatus("", total > 1 ? `正在导入 ${i + 1}/${total}：${file.name}…` : `正在读取 ${file.name}…`);
		try {
			const { library, counts } = await importLibraryFile(file);
			done.push({
				name: library?.name ?? file.name,
				detail: `组件 ${counts.components ?? 0}、令牌 ${counts.tokens ?? 0}、界面 ${counts.screens ?? 0}`
			});
		} catch (error) {
			failed.push(`${file.name}（${String(error?.message ?? error)}）`);
		}
	}

	// ---- 汇总。三种情况分开说，用户才知道下一步做什么 ----
	if (failed.length === 0 && done.length === 1) {
		setStatus("ok", `已导入「${done[0].name}」：${done[0].detail}`);
	} else if (failed.length === 0) {
		// 多个全成功：列出名字（太多就省略，免得状态栏被撑爆）
		const names = done.map((item) => item.name);
		const shown = names.length > 4 ? `${names.slice(0, 4).join("、")} 等 ${names.length} 个` : names.join("、");
		setStatus("ok", `已导入 ${done.length} 个设计包：${shown}`);
	} else if (done.length === 0) {
		setStatus("err", `导入失败：${failed.join("；")}`);
	} else {
		// ★ 部分成功是最需要说清楚的情况 —— 不能让用户以为全成了或全败了
		setStatus("err", `${done.length} 个成功、${failed.length} 个失败 → ${failed.join("；")}`);
	}

	// 刷新**只调一次**：每个文件都刷的话，面板会闪 N 次
	void libraryPanel?.refresh();
}

/** 初始化库面板（编辑器就绪之后调）。 */
function initLibraryPanel() {
	libraryPanel = createLibraryPanel({
		root: dom.libraryPanel,
		apiBase: `${PREFIX}/__canvas__/library`,
		el,
		onStatus: (tone, text) => setStatus(tone, text),
		onInsert: (payload) => insertFromLibrary(payload),
		// 长按组件卡片 → 抓起来拖进画板（落点判定与插入都在 beginLibraryDrag 里）
		onGrab: (payload) => beginLibraryDrag(payload),
		onApply: (declarations, label) => applyLibraryToken(declarations, label),
		onInjectLibraryStyle: (css, id) => injectLibraryStyle(css, id),
		hasLibraryStyle: () => hasLibraryStyle(),
		onSaveSelection: (id) => saveSelectionAsComponent(id)
	});
	void libraryPanel.refresh();
	void 0;
}

// #endregion

// #region 侧栏宽度（可拖拽调节）

/** 侧栏宽度的存储键（本机偏好，不进项目文件）。 */
const SIDE_WIDTH_KEY = "dsh-canvas:side-width";
const SIDE_MIN = 180;
const SIDE_MAX = 560;

/**
 * 让侧栏与画布之间的分隔条可以拖动改宽度。
 *
 * 与 DSH 自己的「工作区/侧边栏」调节方式一致：按住拖、双击复位。
 * 宽度存 localStorage：这是**每个人自己的**偏好，不该写进共享的布局文件
 * （理由和视口缩放一样）。
 */
function bindSplitter() {
	if (dom.splitter === null || dom.side === null) return;

	const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY));
	if (Number.isFinite(saved) && saved >= SIDE_MIN && saved <= SIDE_MAX) {
		dom.side.style.flexBasis = `${saved}px`;
	}

	let dragging = false;
	const onMove = (event) => {
		if (!dragging) return;
		const left = dom.side.getBoundingClientRect().left;
		const width = Math.min(SIDE_MAX, Math.max(SIDE_MIN, event.clientX - left));
		dom.side.style.flexBasis = `${width}px`;
		// 宽度变了，画布视口跟着变，缩放锚点要按新尺寸重算。
		applyTransform();
		event.preventDefault();
	};
	const onUp = () => {
		if (!dragging) return;
		dragging = false;
		dom.splitter.classList.remove("dragging");
		document.body.style.cursor = "";
		const width = Math.round(dom.side.getBoundingClientRect().width);
		localStorage.setItem(SIDE_WIDTH_KEY, String(width));
		setStatus("", `侧栏宽度 ${width}px（双击分隔条复位）`);
	};

	dom.splitter.addEventListener("mousedown", (event) => {
		dragging = true;
		dom.splitter.classList.add("dragging");
		// 拖动时全局用 col-resize 光标：鼠标滑出这条细线也不丢手感。
		document.body.style.cursor = "col-resize";
		event.preventDefault();
	});
	dom.splitter.addEventListener("dblclick", () => {
		dom.side.style.flexBasis = "";
		localStorage.removeItem(SIDE_WIDTH_KEY);
		applyTransform();
		setStatus("", "侧栏宽度已复位");
	});
	window.addEventListener("mousemove", onMove);
	window.addEventListener("mouseup", onUp);
}

/** 侧边栏折叠状态的存储键（本机偏好，不进项目文件）。 */
const SIDE_COLLAPSED_KEY = "dsh-canvas:side-collapsed";

/**
 * 侧边栏折叠 / 展开。
 *
 * ## 按钮为什么放在工具栏，而不是侧栏自己身上
 *
 * 侧栏折叠后**自己就看不见了** —— 把按钮放里面等于"收起来就再也打不开"。
 * 工具栏是常驻的，所以开关放那儿。
 *
 * ## 折叠的做法
 *
 * 用 `display: none`（`.side.collapsed`）而不是把宽度设成 0：
 * 宽度 0 的侧栏仍参与 flex 布局和 `min-width` 计算，
 * 里面那些固定宽度（页签、搜索框）会溢出来变成一条古怪的细线；
 * `display: none` 干净地把它从布局里摘掉。
 *
 * 折叠状态存 localStorage —— 和侧栏宽度一样是**本机偏好**，
 * 不该进项目文件给队友。
 *
 * @returns { void}。
 */
function bindSideCollapse() {
	if (dom.btnSide === null || dom.btnSide === undefined) return;

	/** 应用折叠状态（不改存储）。 */
	const apply = (collapsed) => {
		dom.side.classList.toggle("collapsed", collapsed);
		dom.splitter.classList.toggle("collapsed", collapsed);
		dom.btnSide.classList.toggle("active", collapsed);
		dom.btnSide.setAttribute("aria-pressed", String(collapsed));
		/*
		 * ★ 图标换成 SVG 之后，方向靠**旋转**表达，不再改字符。
		 *
		 * 原来这里是 `querySelector(".glyph").textContent = collapsed ? "▶" : "◀"` ——
		 * 字符 `◀`/`▶` 的字形由系统字体决定，和旁边那排 SVG 摆在一起
		 * 尺寸和基线都对不齐；而且它换不了颜色（主题色变了它不动）。
		 *
		 * 现在按钮里是 `chevron-left`（朝左），收起时转 180° 变成朝右：
		 * 语义也对 —— "收起侧边栏"是朝左收，"展开"是朝右推出去。
		 */
		const chev = dom.btnSide.querySelector("svg");
		if (chev !== null) chev.style.transform = collapsed ? "rotate(180deg)" : "";
		dom.btnSide.setAttribute("data-tip", collapsed ? "展开侧边栏" : "收起侧边栏");
		// 视口尺寸变了 —— 缩放锚点和关联连线都按视口坐标算，必须重算。
		invalidateViewportRect();
		applyTransform();
	};

	apply(localStorage.getItem(SIDE_COLLAPSED_KEY) === "1");
	dom.btnSide.addEventListener("click", () => {
		const collapsed = !dom.side.classList.contains("collapsed");
		apply(collapsed);
		localStorage.setItem(SIDE_COLLAPSED_KEY, collapsed ? "1" : "0");
		setStatus("", collapsed ? "侧边栏已收起（工具栏最左边那个按钮可展开）" : "侧边栏已展开");
	});
}

/**
 * 打开「添加画板」对话框。
 *
 * @param preset - 可选；预填路径（左侧列表里「+设备」用它，省得手打一遍）。
 * @returns { void }。
 */
function openAddDialog(preset = {}) {
	dom.addPath.value = preset.path ?? "";
	dom.addName.value = preset.name ?? "";
	dom.addSpec.value = preset.spec ?? "";
	dom.dialog.showModal();
	dom.addPath.focus();
	// 预填了路径时，光标落到设备上——同路径加设备时这才是要改的那个字段。
	if (preset.path !== undefined) dom.addDevice.focus();
}

/**
 * 启动：拉一次布局并渲染。
 */
async function start() {
	// 主题要最先定：定晚了会先闪一下默认色再跳成用户选的那个。
	initTheme();
	bind();
	// 绘制不依赖编辑器（只在松手那一刻才 sendMutate），所以放在编辑器之前——
	// 编辑器连不上宿主时，至少"画形状"这条路是通的。
	initShapes();
	initShapePanel();
	initInspector();

	// 编辑层独立于布局：它连不上宿主也不该挡住画布的浏览与排版。
	try {
		// ★ 给**外壳文档**也注入一份效果样式。
		//
		// 面板里的"效果预览"块带着同一个 `data-effect`，靠这份 CSS 才有反应。
		// 注入是幂等的（`ensureEffectStyle` 用 `data-dsh-effects` 标记），
		// 而且外面只有带 `data-effect` 的元素会命中，不会影响工具自己的界面。
		ensureEffectStyle(document);

		editor = new CanvasEditor({
			wsPath: WS_PATH,
			// 面板要让开顶栏，否则会盖住工具栏按钮（截图里发现的）。
			panelTop: () => (document.querySelector(".bar")?.getBoundingClientRect().height ?? 0) + 12,
			// 画板里的滚轮冒泡不到外壳文档，由编辑层转发过来——否则在画板上怎么滚都不缩放。
			onCanvasZoom: (deltaY, screenX, screenY) => zoomByWheel(deltaY, screenX, screenY),
			// 画板里的中键平移转发（iframe 不外冒，不接就在画板占满时没法平移）。
			onCanvasPan: (phase, x, y) => middlePan(phase, x, y),
			// 关联的选择模式：编辑层把画布点击改道到这里（不再触发选中/拖动）。
			// 见 `onFrameClick` 里那一支 —— 它排在最前面，优先于一切。
			onLinkPick: (element) => onLinkPick(element),
			// 注释模式：点谁就评论谁。编辑层会**先把它选中**再回调，
			// 因为卡片上要显示当前元素的样式。
			onCommentPick: (element) => onCommentPick(element),
			// 画板里按 Esc：焦点在 iframe 里，键盘事件冒泡不到外壳的 window，
			// 所以必须由编辑层转发过来。**和外壳的 keydown 走同一个函数**，
			// 保证两个入口的 Esc 语义一致（关联 > 注释 > 选择模式 > 取消选中）。
			onEscape: () => handleEscape(),
			// 锁定的图层在画布上点不中。判断放在外壳是因为「锁定」是本地偏好，
			// 编辑层不该知道 localStorage 这回事。
			isLocked: (element) => {
				const entry = state.selectedId === null ? undefined : state.boards.get(state.selectedId);
				return entry === undefined ? false : isLayerLocked(entry.data.path, element);
			},
			// 选中变了（不管是在画板里点的、还是从图层树点的）→ 图层树高亮并展开到那一层。
			onSelectionChange: (element) => {
				// ★ **选中元素时自动激活它所属的画板。**
				//
				// 不这么做的话：用户在画布上点了元素、选中确实生效了，
				// 但 `state.selectedId` 还是 null → 图层树仍然显示
				// 「先在『画板』里选中一块画板」→ **用户永远看不到图层树，
				// 也就编辑不到深层元素**（用户原话：
				// "这让我无法测试以及编辑更深层的图层"）。
				//
				// 数据来源是 `editor.activeId` —— 编辑层在选中时就会记下
				// "这个元素属于哪块画板"，比在外壳里反查 DOM 可靠。
				const owningBoard = editor?.activeId ?? null;
				if (element !== null && element !== undefined
					&& typeof owningBoard === "string" && owningBoard !== ""
					&& state.selectedId !== owningBoard) {
					state.selectedId = owningBoard;
					// 画板列表里的高亮要跟着走，否则看着像"没选中任何画板"，
					// 用户会以为点击没生效。
					renderSidebar();
				}
				if (element !== null && element !== undefined) revealLayer(element);
				renderLayers();
				// 选中变了就刷新形状面板和元素检查器——它们都跟着「当前选中」走
				syncShapePanel();
				syncInspector();
			},
			onStatus: (tone, text) => setStatus(tone, text)
		});
		// 挂到全局便于排查（也是浏览器验证脚本读取内部状态的入口）。
		globalThis.__DSH_CANVAS_EDITOR__ = editor;
	} catch (error) {
		setStatus("err", `编辑层初始化失败：${String(error?.message ?? error)}`);
	}

	let board;
	try {
		const response = await fetch(API, { headers: { accept: "application/json" } });
		board = await response.json();
	} catch (error) {
		// 拉不到布局也要把界面画出来（空画布 + 明确提示），
		// 而不是留一个什么都点不动的白屏。
		setStatus("err", `无法从宿主读取布局：${String(error?.message ?? error)}`);
		applyTransform();
		render({ workspaces: [], devices: {}, view: state });
		return;
	}
	state.zoom = Number(board.view?.zoom) || 1;
	state.panX = Number(board.view?.x) || 40;
	state.panY = Number(board.view?.y) || 40;
	applyTransform();
	render(board);

	// 设备下拉用宿主给的预设填充（避免前后端各写一份）。
	for (const [key, device] of Object.entries(board.devices ?? {})) {
		const option = document.createElement("option");
		option.value = key;
		option.textContent = `${device.label} ${device.width}×${device.height}`;
		dom.addDevice.append(option);
	}
	dom.addDevice.value = "desktop";

	if (state.boards.size > 0) fitAll();
	setStatus("", `布局来自 ${board.file}${board.exists === false ? "（尚未创建，添加画板后会创建）" : ""}`);
	// 指令通道的可用性单独查（它依赖 DSH 的会话服务，与布局无关）。
	void refreshPromptStatus();
	// 注释卡片的事件（它是"选中元素 → 发给 Agent"那条路，也依赖指令通道）
	bindComment();
	// 会话状态标签可点重查（绑定是 Agent 调工具时才发生的，页面不会自己知道）
	bindPromptStatusRefresh();
	// 侧边栏折叠（状态存本机，和宽度一样不进项目文件）
	bindSideCollapse();

	// 恢复上次用的侧栏页签（本机偏好，不进项目文件）。
	const savedPane = localStorage.getItem("dsh-canvas:side-pane");
	if (savedPane === "layers" || savedPane === "library") {
		for (const item of dom.sideTabs.querySelectorAll("button")) {
			item.setAttribute("aria-pressed", item.dataset.pane === savedPane ? "true" : "false");
		}
		dom.paneBoards.hidden = true;
		dom.paneLayers.hidden = savedPane !== "layers";
		dom.paneLibrary.hidden = savedPane !== "library";
		if (savedPane === "layers") renderLayers();
		else initLibraryPanel();
	}
}

void start();
