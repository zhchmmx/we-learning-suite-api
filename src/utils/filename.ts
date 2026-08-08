/**
 * 文件名扩展名处理工具
 *
 * 设计原则：**存储层保留完整文件名，只在响应出口层剥离扩展名。**
 * D1 的 files.name 与 R2 的 customMetadata.fileName 永远存原始完整名，
 * 这样下载链路（Content-Disposition、预签名下载的 fileName）不受影响，
 * 也无需任何数据库迁移，随时可回滚。
 */

/**
 * 可被剥离的扩展名白名单。
 *
 * 之所以用白名单而不是通用正则（如"点后 1-8 位字母数字即视为扩展名"），
 * 是为了避免误伤带点的普通文件名：
 *   - "v1.2.3"        → 通用正则会剥成 "v1.2"
 *   - "第一季度.2024" → 通用正则会剥成 "第一季度"
 *
 * 服务端只接收 text/plain 与 text/markdown（见 routes/files.ts 的
 * ALLOWED_UPLOAD_MIME_TYPES），实际入库的扩展名几乎只有 txt/md，
 * 白名单的覆盖率接近 100%，"漏剥"这一缺点基本不会发生。
 *
 * 需要支持新扩展名时，直接往这里加即可。
 */
const STRIPPABLE_EXTENSIONS = new Set([
	'txt',
	'md',
	'markdown',
	'pdf',
	'doc',
	'docx',
	'ppt',
	'pptx',
	'xls',
	'xlsx',
	'csv',
	'rtf',
	'html',
	'htm',
	'epub',
]);

/**
 * 取出文件名末尾的可剥离扩展名（含前导点），没有则返回空串。
 *
 * @example
 * extractStrippableExtension('notes.txt')  // '.txt'
 * extractStrippableExtension('v1.2.3')     // ''
 * extractStrippableExtension('.gitignore') // ''
 */
function extractStrippableExtension(name: string): string {
	const dotIndex = name.lastIndexOf('.');

	// dotIndex <= 0 覆盖两种情况：
	//   -1 → 没有点，如 "README"
	//    0 → 点在开头，如 ".gitignore"（隐藏文件，整体就是文件名）
	if (dotIndex <= 0) return '';

	const ext = name.slice(dotIndex + 1);

	// "report." 这类空扩展名不处理
	if (!ext) return '';

	if (!STRIPPABLE_EXTENSIONS.has(ext.toLowerCase())) return '';

	return name.slice(dotIndex);
}

/**
 * 剥离文件名末尾的扩展名，用于所有对外展示的 name 字段。
 *
 * 只剥离最后一段，且仅当它命中白名单时才剥离。
 *
 * @example
 * stripExtension('notes.txt')      // 'notes'
 * stripExtension('第三章讲义.md')  // '第三章讲义'
 * stripExtension('archive.tar.gz') // 'archive.tar'（gz 不在白名单，原样返回）
 * stripExtension('v1.2.3')         // 'v1.2.3'
 * stripExtension('.gitignore')     // '.gitignore'
 * stripExtension('report.')        // 'report.'
 * stripExtension('README')         // 'README'
 */
export function stripExtension(name: string): string {
	if (!name) return name;

	const ext = extractStrippableExtension(name);
	if (!ext) return name;

	const base = name.slice(0, name.length - ext.length);

	// 兜底：剥完变空串（理论上进不来，因为 dotIndex > 0 保证了 base 非空）
	return base || name;
}

/**
 * 重命名时补回扩展名，防止"重命名回环"丢失扩展名。
 *
 * 场景：GET 返回的 name 已被剥离（"notes"），用户在客户端改成 "notes2"
 * 后 PATCH 回来。若直接入库，D1 里就变成没有扩展名的 "notes2"，
 * 之后下载出来的文件没有后缀，AI 出题也判断不了类型。
 *
 * 规则：
 *   - 新名字自带可识别扩展名 → 尊重客户端，原样返回
 *   - 新名字不带扩展名，且原文件有可剥离扩展名 → 自动补回原扩展名
 *   - 原文件本来就没有可剥离扩展名 → 原样返回
 *
 * @param newName      客户端传来的新文件名
 * @param originalName D1 中存储的原始完整文件名
 *
 * @example
 * restoreExtension('notes2', 'notes.txt')     // 'notes2.txt'
 * restoreExtension('notes2.md', 'notes.txt')  // 'notes2.md'（尊重客户端）
 * restoreExtension('README2', 'README')       // 'README2'
 */
export function restoreExtension(newName: string, originalName: string): string {
	if (!newName) return newName;

	// 客户端自己带了可识别的扩展名，尊重它
	if (extractStrippableExtension(newName)) return newName;

	const originalExt = extractStrippableExtension(originalName);
	if (!originalExt) return newName;

	return newName + originalExt;
}
