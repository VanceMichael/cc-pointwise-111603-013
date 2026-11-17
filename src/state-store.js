import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';

// 通用 JSON 文档存储：原子落盘，读取缺失文件时返回空文档。
// 三个业务集合（名单观察、签到事件、结算确认）各自独立文件，互不覆盖。
// 临时文件名带存储前缀与唯一 id，避免同一目录下多个存储并发保存时互相顶替。
export class JsonStateStore {
  constructor(path, empty) {
    this.path = path;
    this.empty = structuredClone(empty);
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return structuredClone(this.empty);
      throw error;
    }
  }

  async save(document) {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${basename(this.path)}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, this.path);
  }

  // mutator 抛错时不得落盘：被拒绝的写入（如不可变结算冲突）不能留下半成品文件。
  async mutate(mutator) {
    const document = await this.load();
    const result = await mutator(document);
    await this.save(document);
    return result;
  }
}
