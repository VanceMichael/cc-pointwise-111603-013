export class SourceClient {
  constructor(baseUrl) {
    const address = new URL(baseUrl);
    if (address.hostname !== '127.0.0.1') throw new Error('local source required');
    this.baseUrl = address;
  }

  // 仅接受同一回环来源；304 不是错误，采集端据此跳过未变化页面并保留既有批次留痕。
  async read(path, { etag } = {}) {
    const address = new URL(path, this.baseUrl);
    if (address.origin !== this.baseUrl.origin) throw new Error('source origin changed');
    const response = await fetch(address, {
      signal: AbortSignal.timeout(2000),
      headers: etag ? { 'if-none-match': etag } : {},
    });
    if (response.status === 304) {
      return { text: '', contentType: response.headers.get('content-type'), etag: response.headers.get('etag'), notModified: true };
    }
    if (!response.ok) throw new Error(`source ${response.status}: ${path}`);
    return {
      text: await response.text(),
      contentType: response.headers.get('content-type'),
      etag: response.headers.get('etag'),
      notModified: false,
    };
  }
}
