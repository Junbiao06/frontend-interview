export const MB = 1024 * 1024;

export function createChunks(file, chunkSize) {
  const chunks = [];
  let start = 0;

  while (start < file.size) {
    chunks.push(file.slice(start, Math.min(start + chunkSize, file.size)));
    start += chunkSize;
  }

  return chunks;
}

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 抽样哈希规则：
 * 1. 第一个、最后一个分片完整读取；
 * 2. 中间分片只读取开头 2 字节、正中间 2 字节、末尾 2 字节；
 * 3. 将样本按原文件顺序拼接后计算 SHA-256。
 *
 * 它是快速文件指纹，不等同于对整份文件做完整 SHA-256。
 */
export async function calculateSampleHash(chunks, onProgress = () => {}) {
  if (chunks.length === 0) {
    const digest = await crypto.subtle.digest("SHA-256", new ArrayBuffer(0));
    onProgress(100);
    return bytesToHex(digest);
  }

  const samples = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const isBoundary = index === 0 || index === chunks.length - 1;

    if (isBoundary) {
      samples.push(chunk);
    } else {
      const middleStart = Math.max(0, Math.floor(chunk.size / 2) - 1);
      samples.push(
        chunk.slice(0, 2),
        chunk.slice(middleStart, middleStart + 2),
        chunk.slice(Math.max(0, chunk.size - 2), chunk.size),
      );
    }

    onProgress(Math.round(((index + 1) / chunks.length) * 70));
  }

  const sampleBuffer = await new Blob(samples).arrayBuffer();
  onProgress(85);
  const digest = await crypto.subtle.digest("SHA-256", sampleBuffer);
  onProgress(100);
  return bytesToHex(digest);
}

export function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : decimals)} ${units[unitIndex]}`;
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || `请求失败（${response.status}）`);
  }

  return payload;
}

export function uploadChunk({
  chunk,
  index,
  file,
  fileHash,
  chunkSize,
  totalChunks,
  signal,
  onProgress,
}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload/chunk");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Hash", fileHash);
    xhr.setRequestHeader("X-File-Size", String(file.size));
    xhr.setRequestHeader("X-Chunk-Size", String(chunkSize));
    xhr.setRequestHeader("X-Chunk-Index", String(index));
    xhr.setRequestHeader("X-Total-Chunks", String(totalChunks));

    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded);
    };

    xhr.onload = () => {
      signal.removeEventListener("abort", abort);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
        return;
      }

      let message = `分片 ${index + 1} 上传失败`;
      try {
        message = JSON.parse(xhr.responseText).message || message;
      } catch {
        // 保留默认错误信息
      }
      reject(new Error(message));
    };

    xhr.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error(`分片 ${index + 1} 网络请求失败`));
    };

    xhr.onabort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("上传已暂停", "AbortError"));
    };

    xhr.send(chunk);
  });
}
