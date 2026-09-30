export interface LoadedImage {
  name: string;
  width: number;
  height: number;
  dataUrl: string;
}

export function loadImageFile(file: File): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error(`${file.name} 不是图片文件`));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const img = new Image();
      img.onload = () =>
        resolve({ name: file.name, width: img.naturalWidth, height: img.naturalHeight, dataUrl });
      img.onerror = () => reject(new Error(`${file.name} 图片内容损坏，无法解码`));
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export async function loadImageFiles(files: File[]): Promise<{ loaded: LoadedImage[]; errors: string[] }> {
  const results = await Promise.allSettled(files.map(loadImageFile));
  const loaded: LoadedImage[] = [];
  const errors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') loaded.push(r.value);
    else errors.push(`${files[i].name}: ${r.reason.message}`);
  });
  return { loaded, errors };
}
