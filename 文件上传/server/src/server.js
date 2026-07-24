import crypto from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, "..");
const STORAGE_DIR = path.join(SERVER_DIR, "storage");
const CHUNKS_DIR = path.join(STORAGE_DIR, "chunks");
const FILES_DIR = path.join(STORAGE_DIR, "files");
const COMPLETED_DIR = path.join(STORAGE_DIR, "completed");
const CLIENT_DIST = path.resolve(SERVER_DIR, "../client/dist");
const PORT = Number(process.env.PORT) || 3001;
const MAX_CHUNK_SIZE = 20 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const mergingTasks = new Map();

await Promise.all([
  mkdir(CHUNKS_DIR, { recursive: true }),
  mkdir(FILES_DIR, { recursive: true }),
  mkdir(COMPLETED_DIR, { recursive: true }),
]);

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "64kb" }));

function asyncRoute(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

function parseInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    const error = new Error(`${name} 不合法`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

function validateMetadata(input) {
  const fileHash = String(input.fileHash || "").toLowerCase();
  if (!HASH_PATTERN.test(fileHash)) {
    const error = new Error("文件哈希不合法");
    error.status = 400;
    throw error;
  }

  const fileName = String(input.fileName || "unnamed-file").slice(0, 255);
  const fileSize = parseInteger(input.fileSize, "文件大小");
  const chunkSize = parseInteger(input.chunkSize, "分片大小", { min: 1, max: MAX_CHUNK_SIZE });
  const totalChunks = parseInteger(input.totalChunks, "分片数量", { max: 100_000 });
  const expectedTotal = fileSize === 0 ? 0 : Math.ceil(fileSize / chunkSize);

  if (totalChunks !== expectedTotal) {
    const error = new Error("分片数量与文件大小不匹配");
    error.status = 400;
    throw error;
  }

  return { fileHash, fileName, fileSize, chunkSize, totalChunks };
}

function uploadKey({ fileHash, fileSize }) {
  return `${fileHash}-${fileSize}`;
}

function uploadPaths(metadata) {
  const key = uploadKey(metadata);
  return {
    key,
    // 分片大小属于续传协议的一部分，隔离目录可以避免用户更换分片大小后
    // 与上一次未完成上传的同编号分片互相覆盖。
    chunkDirectory: path.join(CHUNKS_DIR, `${key}-${metadata.chunkSize}`),
    metadataPath: path.join(COMPLETED_DIR, `${key}.json`),
  };
}

function safeFileName(fileName) {
  const baseName = path.basename(fileName).normalize("NFKC");
  const cleaned = baseName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned || "unnamed-file";
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function readCompleted(metadata) {
  const { metadataPath } = uploadPaths(metadata);
  try {
    const completed = JSON.parse(await readFile(metadataPath, "utf8"));
    const finalPath = path.join(FILES_DIR, completed.storedName);
    const info = await stat(finalPath);
    if (info.size !== metadata.fileSize) return null;
    return completed;
  } catch {
    return null;
  }
}

async function listUploadedChunks(metadata) {
  const { chunkDirectory } = uploadPaths(metadata);
  try {
    const entries = await readdir(chunkDirectory, { withFileTypes: true });
    const indices = [];

    for (const entry of entries) {
      const match = /^(\d+)\.part$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const index = Number(match[1]);
      if (index < 0 || index >= metadata.totalChunks) continue;

      const expectedSize = Math.min(
        metadata.chunkSize,
        metadata.fileSize - index * metadata.chunkSize,
      );
      const info = await stat(path.join(chunkDirectory, entry.name));
      if (info.size === expectedSize) indices.push(index);
    }

    return indices.sort((a, b) => a - b);
  } catch {
    return [];
  }
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, service: "shard-upload-api" });
});

app.post(
  "/api/upload/check",
  asyncRoute(async (request, response) => {
    const metadata = validateMetadata(request.body);
    const completed = await readCompleted(metadata);

    if (completed) {
      response.json({
        complete: true,
        uploadedChunks: Array.from({ length: metadata.totalChunks }, (_, index) => index),
        downloadUrl: `/api/files/${uploadKey(metadata)}`,
      });
      return;
    }

    response.json({
      complete: false,
      uploadedChunks: await listUploadedChunks(metadata),
    });
  }),
);

app.post(
  "/api/upload/chunk",
  express.raw({ type: "application/octet-stream", limit: `${MAX_CHUNK_SIZE}b` }),
  asyncRoute(async (request, response) => {
    const metadata = validateMetadata({
      fileHash: request.get("X-File-Hash"),
      fileName: "chunk",
      fileSize: request.get("X-File-Size"),
      chunkSize: request.get("X-Chunk-Size"),
      totalChunks: request.get("X-Total-Chunks"),
    });
    const index = parseInteger(request.get("X-Chunk-Index"), "分片编号", {
      max: Math.max(0, metadata.totalChunks - 1),
    });

    if (metadata.totalChunks === 0 || index >= metadata.totalChunks) {
      const error = new Error("分片编号越界");
      error.status = 400;
      throw error;
    }

    const expectedSize = Math.min(
      metadata.chunkSize,
      metadata.fileSize - index * metadata.chunkSize,
    );
    if (!Buffer.isBuffer(request.body) || request.body.length !== expectedSize) {
      const error = new Error(`分片大小错误，应为 ${expectedSize} 字节`);
      error.status = 400;
      throw error;
    }

    const { chunkDirectory } = uploadPaths(metadata);
    await mkdir(chunkDirectory, { recursive: true });
    const chunkPath = path.join(chunkDirectory, `${index}.part`);

    if (await pathExists(chunkPath)) {
      response.json({ ok: true, index, skipped: true });
      return;
    }

    const temporaryPath = path.join(chunkDirectory, `${index}.${crypto.randomUUID()}.tmp`);
    await writeFile(temporaryPath, request.body, { flag: "wx" });
    try {
      await rename(temporaryPath, chunkPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      if (!(await pathExists(chunkPath))) throw error;
    }

    response.status(201).json({ ok: true, index });
  }),
);

async function mergeChunks(metadata) {
  const completed = await readCompleted(metadata);
  if (completed) return completed;

  const uploadedChunks = await listUploadedChunks(metadata);
  if (uploadedChunks.length !== metadata.totalChunks) {
    const error = new Error(`分片不完整：${uploadedChunks.length}/${metadata.totalChunks}`);
    error.status = 409;
    throw error;
  }

  const { key, chunkDirectory, metadataPath } = uploadPaths(metadata);
  const cleanName = safeFileName(metadata.fileName);
  const storedName = `${metadata.fileHash.slice(0, 16)}-${cleanName}`;
  const finalPath = path.join(FILES_DIR, storedName);
  const temporaryPath = path.join(FILES_DIR, `${key}.${crypto.randomUUID()}.tmp`);
  const output = createWriteStream(temporaryPath, { flags: "wx" });

  try {
    for (let index = 0; index < metadata.totalChunks; index += 1) {
      const input = createReadStream(path.join(chunkDirectory, `${index}.part`));
      for await (const data of input) {
        if (!output.write(data)) await once(output, "drain");
      }
    }
    output.end();
    await once(output, "close");

    const result = await stat(temporaryPath);
    if (result.size !== metadata.fileSize) {
      throw new Error("合并后的文件大小校验失败");
    }

    await rename(temporaryPath, finalPath);
    const record = {
      fileHash: metadata.fileHash,
      fileSize: metadata.fileSize,
      originalName: metadata.fileName,
      storedName,
      completedAt: new Date().toISOString(),
    };
    await writeFile(metadataPath, JSON.stringify(record, null, 2));
    await rm(chunkDirectory, { recursive: true, force: true });
    return record;
  } catch (error) {
    output.destroy();
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

app.post(
  "/api/upload/merge",
  asyncRoute(async (request, response) => {
    const metadata = validateMetadata(request.body);
    const key = uploadKey(metadata);

    if (!mergingTasks.has(key)) {
      const task = mergeChunks(metadata).finally(() => mergingTasks.delete(key));
      mergingTasks.set(key, task);
    }

    await mergingTasks.get(key);
    response.json({ ok: true, downloadUrl: `/api/files/${key}` });
  }),
);

app.get(
  "/api/files/:key",
  asyncRoute(async (request, response) => {
    if (!/^[a-f0-9]{64}-\d+$/.test(request.params.key)) {
      response.status(404).json({ message: "文件不存在" });
      return;
    }

    const metadataPath = path.join(COMPLETED_DIR, `${request.params.key}.json`);
    try {
      const completed = JSON.parse(await readFile(metadataPath, "utf8"));
      response.download(path.join(FILES_DIR, completed.storedName), completed.originalName);
    } catch {
      response.status(404).json({ message: "文件不存在" });
    }
  }),
);

if (await pathExists(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get("*", (_request, response) => {
    response.sendFile(path.join(CLIENT_DIST, "index.html"));
  });
}

app.use((error, _request, response, _next) => {
  if (error.type === "entity.too.large") {
    response.status(413).json({ message: "分片超过服务端 20 MB 限制" });
    return;
  }
  console.error(error);
  response.status(error.status || 500).json({
    message: error.status ? error.message : "服务端处理失败",
  });
});

app.listen(PORT, () => {
  console.log(`Shard upload server: http://localhost:${PORT}`);
});
