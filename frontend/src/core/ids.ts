let counter = 0;

/** 可注入随机源，主要便于测试 */
export function createId(prefix: string, random: () => number = Math.random): string {
  counter += 1;
  const rand = random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}

export const newObjectId = (random?: () => number) => createId('obj', random);
export const newContourId = (random?: () => number) => createId('ctr', random);
export const newVersionId = (random?: () => number) => createId('ver', random);
export const newImageId = (random?: () => number) => createId('img', random);
export const newProjectId = (random?: () => number) => createId('prj', random);

/** 测试专用：重置自增计数 */
export function _resetIdCounterForTests(): void {
  counter = 0;
}

/** FNV-1a 32 位字符串哈希（非加密用途，足够在导入时做内容指纹） */
export function fastHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return `fnv1a-${hex}`;
}

/**
 * 浏览器环境下计算 sha256；不可用时回退到 fastHash。
 * 对 dataURL 先解码为字节再哈希，避免 base64 表示差异影响指纹。
 */
export async function checksumOfDataUrl(dataUrl: string): Promise<string> {
  try {
    const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    if (globalThis.crypto?.subtle) {
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
    return fastHash(binary);
  } catch {
    return fastHash(dataUrl);
  }
}
