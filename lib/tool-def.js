/**
 * 工具定义的本地实现（等价于 `@deepseek-ai/dsh-tools` 的 `defineTool`）。
 *
 * ## 为什么不 import 官方包
 *
 * 实测：桌面 profile 的 `node_modules/@deepseek-ai/` 下只有 3 个包（cosmokit、
 * dsh-subprocess、schemastery），而 289 个官方包都打包在 `app.asar` 内部。
 * 插件从自己的目录**解析不到** `@deepseek-ai/dsh-tools` —— 一旦 import 就加载失败。
 *
 * 好在 `defineTool` 只是个语法糖：它把「参数规格」编译成 JSON Schema，再套上
 * 输出渲染。官方 `register()` 接收的就是 `{ name, description, parameters,
 * output, execute }` 这样的普通对象。所以我们自己实现同一套转换即可，
 * 插件保持**零外部依赖**——这也正是 dsh-skills-rules 能跑起来的原因。
 *
 * ## 参数规格 → JSON Schema
 *
 * 规格写法（比 JSON Schema 少一层 `properties` 包装）：
 *
 * ```js
 * { color: { type: "string", required: true, description: "颜色" } }
 * ```
 *
 * 转成：
 *
 * ```js
 * {
 *   type: "object",
 *   additionalProperties: false,
 *   properties: { color: { type: "string", description: "颜色" } },
 *   required: ["color"]
 * }
 * ```
 */

/**
 * 把参数规格编译成 JSON Schema。
 *
 * @param spec - 参数规格对象（键为参数名）。
 * @returns JSON Schema。
 */
export function compileParameters(spec) {
	const source = spec ?? {};
	const properties = {};
	const required = [];
	for (const [key, value] of Object.entries(source)) {
		// 展开字段定义，但把 `required` 这一层语义提到父级。
		const { required: isRequired, ...rest } = value ?? {};
		properties[key] = rest;
		if (isRequired === true) required.push(key);
	}
	const schema = {
		type: "object",
		additionalProperties: false,
		properties
	};
	if (required.length > 0) schema.required = required;
	return schema;
}

/**
 * 定义一个工具（等价于官方 defineTool 的必要部分）。
 *
 * @param options - {
 *   name, description,
 *   parameters: 参数规格,
 *   output?: { schema, render?, presentationMeta? },
 *   execute,
 *   presentCall?, presentResult?,
 *   timeoutMs?
 * }
 * @returns registry-ready 的工具定义。
 */
export function defineTool(options) {
	if (typeof options?.name !== "string" || options.name === "") throw new Error("defineTool: name 必填");
	if (typeof options?.execute !== "function") throw new Error(`defineTool(${options.name}): execute 必填`);
	if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
		throw new Error(`defineTool(${options.name}): timeoutMs 必须是正数`);
	}

	const parameters = compileParameters(options.parameters);
	const output = options.output === undefined
		? undefined
		: {
			schema: options.output.schema,
			render: options.output.render ?? (() => []),
			...(options.output.presentationMeta === undefined ? {} : { presentationMeta: options.output.presentationMeta })
		};

	return {
		name: options.name,
		description: options.description,
		parameters,
		...(output === undefined ? {} : { output }),
		execute: options.execute,
		...(options.presentCall === undefined ? {} : { presentCall: options.presentCall }),
		...(options.presentResult === undefined ? {} : { presentResult: options.presentResult }),
		...(options.isConcurrencySafe === undefined ? {} : { isConcurrencySafe: options.isConcurrencySafe }),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs })
	};
}
