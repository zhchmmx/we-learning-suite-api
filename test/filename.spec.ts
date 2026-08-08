import { describe, it, expect } from 'vitest';
import { stripExtension, restoreExtension } from '../src/utils/filename';

describe('stripExtension', () => {
	it('剥离白名单内的扩展名', () => {
		expect(stripExtension('notes.txt')).toBe('notes');
		expect(stripExtension('讲义.md')).toBe('讲义');
		expect(stripExtension('report.MD')).toBe('report'); // 大小写不敏感
		expect(stripExtension('slides.pptx')).toBe('slides');
	});

	it('保留中文名与空格', () => {
		expect(stripExtension('第三章 复习提纲.txt')).toBe('第三章 复习提纲');
	});

	it('不剥离白名单外的后缀', () => {
		expect(stripExtension('实验数据.log')).toBe('实验数据.log');
		expect(stripExtension('方案.backup')).toBe('方案.backup');
	});

	it('不误伤带点的普通文件名', () => {
		expect(stripExtension('v1.2.3')).toBe('v1.2.3');
		expect(stripExtension('第一季度.2024')).toBe('第一季度.2024');
	});

	it('只剥离最后一段', () => {
		expect(stripExtension('archive.tar.gz')).toBe('archive.tar.gz'); // gz 不在白名单
		expect(stripExtension('backup.2024.txt')).toBe('backup.2024');
	});

	it('隐藏文件、无扩展名、空扩展名均原样返回', () => {
		expect(stripExtension('.gitignore')).toBe('.gitignore');
		expect(stripExtension('README')).toBe('README');
		expect(stripExtension('report.')).toBe('report.');
		expect(stripExtension('')).toBe('');
	});
});

describe('restoreExtension', () => {
	it('新名字不带扩展名时补回原扩展名', () => {
		expect(restoreExtension('notes2', 'notes.txt')).toBe('notes2.txt');
		expect(restoreExtension('新讲义', '旧讲义.md')).toBe('新讲义.md');
	});

	it('新名字自带可识别扩展名时尊重客户端', () => {
		expect(restoreExtension('notes2.md', 'notes.txt')).toBe('notes2.md');
	});

	it('原文件没有可剥离扩展名时不补', () => {
		expect(restoreExtension('README2', 'README')).toBe('README2');
		expect(restoreExtension('数据2', '数据.log')).toBe('数据2');
	});

	it('空新名字原样返回', () => {
		expect(restoreExtension('', 'notes.txt')).toBe('');
	});

	it('重命名回环：剥离后改名再补回，扩展名不丢', () => {
		const stored = 'notes.txt';
		const shown = stripExtension(stored); // 客户端看到 "notes"
		const edited = shown + '2'; // 用户改成 "notes2"
		const persisted = restoreExtension(edited, stored);

		expect(persisted).toBe('notes2.txt'); // D1 里仍是完整名
		expect(stripExtension(persisted)).toBe('notes2'); // 下次 GET 展示正确
	});
});
