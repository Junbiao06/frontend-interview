import { useCallback, useEffect, useRef, useState } from "react";
import {
  MB,
  calculateSampleHash,
  createChunks,
  formatBytes,
  requestJson,
  uploadChunk,
} from "./upload.js";

const STATUS_COPY = {
  idle: "等待文件",
  ready: "准备上传",
  hashing: "计算指纹",
  checking: "检查分片",
  uploading: "上传中",
  paused: "已暂停",
  merging: "服务端合并",
  success: "上传完成",
  error: "出现错误",
};

const CHUNK_OPTIONS = [2, 5, 10];
const CONCURRENCY_OPTIONS = [2, 4, 6];

function App() {
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("idle");
  const [dragging, setDragging] = useState(false);
  const [chunkSizeMb, setChunkSizeMb] = useState(5);
  const [concurrency, setConcurrency] = useState(4);
  const [fileHash, setFileHash] = useState("");
  const [hashProgress, setHashProgress] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [error, setError] = useState("");
  const [downloadUrl, setDownloadUrl] = useState("");

  const fileInputRef = useRef(null);
  const pauseRef = useRef(false);
  const controllersRef = useRef(new Map());
  const fileHashRef = useRef("");

  const chunkSize = chunkSizeMb * MB;
  const chunks = file ? createChunks(file, chunkSize) : [];
  const isBusy = ["hashing", "checking", "uploading", "merging"].includes(status);

  const stopRequests = useCallback(() => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
  }, []);

  useEffect(() => () => stopRequests(), [stopRequests]);

  function chooseFile(nextFile) {
    if (!nextFile) return;
    stopRequests();
    pauseRef.current = false;
    fileHashRef.current = "";
    setFile(nextFile);
    setFileHash("");
    setHashProgress(0);
    setUploadProgress(0);
    setUploadedCount(0);
    setSpeed(0);
    setDownloadUrl("");
    setError("");
    setStatus("ready");
  }

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  }

  function changeChunkSize(value) {
    setChunkSizeMb(value);
    fileHashRef.current = "";
    setFileHash("");
    setHashProgress(0);
  }

  async function uploadWithRetry(params, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (pauseRef.current || params.signal.aborted) {
        throw new DOMException("上传已暂停", "AbortError");
      }
      try {
        await uploadChunk(params);
        return;
      } catch (uploadError) {
        if (uploadError.name === "AbortError") throw uploadError;
        lastError = uploadError;
        if (attempt < maxAttempts) {
          await new Promise((resolve) => window.setTimeout(resolve, 350 * 2 ** attempt));
        }
      }
    }
    throw lastError;
  }

  async function runUpload(hash) {
    if (!file) return;

    const currentChunks = createChunks(file, chunkSize);
    const metadata = {
      fileHash: hash,
      fileName: file.name,
      fileSize: file.size,
      chunkSize,
      totalChunks: currentChunks.length,
    };

    pauseRef.current = false;
    setError("");
    setStatus("checking");

    try {
      const check = await requestJson("/api/upload/check", {
        method: "POST",
        body: JSON.stringify(metadata),
      });

      if (check.complete) {
        setUploadProgress(100);
        setUploadedCount(currentChunks.length);
        setDownloadUrl(check.downloadUrl);
        setStatus("success");
        return;
      }

      const completed = new Set(check.uploadedChunks);
      const inFlight = new Map();
      const pending = currentChunks
        .map((_, index) => index)
        .filter((index) => !completed.has(index));
      const startedAt = performance.now();
      let cursor = 0;
      let fatalError = null;

      const completedBytes = () => {
        let total = 0;
        completed.forEach((index) => {
          total += currentChunks[index]?.size || 0;
        });
        return total;
      };

      const resumedBytes = completedBytes();

      const updateOverallProgress = () => {
        const loaded = [...inFlight.values()].reduce((sum, value) => sum + value, 0);
        const transferred = Math.min(file.size, completedBytes() + loaded);
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.25);
        setUploadProgress(file.size === 0 ? 100 : (transferred / file.size) * 100);
        setUploadedCount(completed.size);
        setSpeed(Math.max(0, transferred - resumedBytes) / elapsedSeconds);
      };

      updateOverallProgress();
      setStatus("uploading");

      const worker = async () => {
        while (cursor < pending.length && !pauseRef.current && !fatalError) {
          const index = pending[cursor];
          cursor += 1;
          const controller = new AbortController();
          controllersRef.current.set(index, controller);

          try {
            await uploadWithRetry({
              chunk: currentChunks[index],
              index,
              file,
              fileHash: hash,
              chunkSize,
              totalChunks: currentChunks.length,
              signal: controller.signal,
              onProgress: (loaded) => {
                inFlight.set(index, loaded);
                updateOverallProgress();
              },
            });
            inFlight.delete(index);
            completed.add(index);
            updateOverallProgress();
          } catch (workerError) {
            inFlight.delete(index);
            if (workerError.name !== "AbortError") {
              fatalError = workerError;
              stopRequests();
            }
            return;
          } finally {
            controllersRef.current.delete(index);
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(concurrency, pending.length || 1) }, () => worker()),
      );

      if (pauseRef.current) {
        updateOverallProgress();
        setSpeed(0);
        setStatus("paused");
        return;
      }

      if (fatalError) throw fatalError;

      setUploadProgress(100);
      setUploadedCount(currentChunks.length);
      setSpeed(0);
      setStatus("merging");

      const merged = await requestJson("/api/upload/merge", {
        method: "POST",
        body: JSON.stringify(metadata),
      });
      setDownloadUrl(merged.downloadUrl);
      setStatus("success");
    } catch (uploadError) {
      if (uploadError.name === "AbortError" || pauseRef.current) {
        setStatus("paused");
        return;
      }
      setError(uploadError.message || "上传失败，请稍后重试");
      setSpeed(0);
      setStatus("error");
    }
  }

  async function startUpload() {
    if (!file || isBusy) return;

    let hash = fileHashRef.current;
    try {
      if (!hash) {
        setStatus("hashing");
        setHashProgress(0);
        hash = await calculateSampleHash(createChunks(file, chunkSize), setHashProgress);
        fileHashRef.current = hash;
        setFileHash(hash);
      }
      await runUpload(hash);
    } catch (hashError) {
      setError(hashError.message || "文件指纹计算失败");
      setStatus("error");
    }
  }

  function pauseUpload() {
    pauseRef.current = true;
    stopRequests();
    setSpeed(0);
    setStatus("paused");
  }

  function reset() {
    pauseRef.current = true;
    stopRequests();
    fileHashRef.current = "";
    setFile(null);
    setFileHash("");
    setHashProgress(0);
    setUploadProgress(0);
    setUploadedCount(0);
    setSpeed(0);
    setError("");
    setDownloadUrl("");
    setStatus("idle");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const primaryLabel = {
    ready: "开始上传",
    paused: "继续上传",
    error: "重试上传",
  }[status];

  return (
    <div className="page-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Shard 首页">
          <span className="brand-mark">S</span>
          <span>SHARD</span>
        </a>
        <div className="server-pill">
          <span className="live-dot" />
          React · Vite · Express
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">CHUNKED UPLOAD / 01</p>
            <h1>
              把大文件，
              <em>切成小问题。</em>
            </h1>
            <p className="hero-description">
              浏览器切片、抽样指纹、并发传输、断点续传。每一步都看得见，
              每一个已上传分片都不会浪费。
            </p>
            <div className="hero-stats" aria-label="功能摘要">
              <div><strong>5 MB</strong><span>默认分片</span></div>
              <div><strong>4 路</strong><span>并发上传</span></div>
              <div><strong>3 次</strong><span>失败重试</span></div>
            </div>
          </div>

          <div className="upload-card">
            <div className="card-heading">
              <div>
                <span className="section-index">01</span>
                <h2>选择文件</h2>
              </div>
              <span className={`status status-${status}`}>{STATUS_COPY[status]}</span>
            </div>

            <input
              ref={fileInputRef}
              className="visually-hidden"
              type="file"
              onChange={(event) => chooseFile(event.target.files?.[0])}
            />

            <button
              className={`drop-zone ${dragging ? "is-dragging" : ""}`}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              disabled={isBusy}
            >
              <span className="upload-glyph" aria-hidden="true">↗</span>
              <strong>{file ? "更换一个文件" : "拖放大文件到这里"}</strong>
              <span>{file ? "点击可重新选择" : "或点击浏览本地文件，不限制文件类型"}</span>
            </button>

            {file && (
              <div className="file-panel">
                <div className="file-summary">
                  <span className="file-icon" aria-hidden="true">FILE</span>
                  <div className="file-title">
                    <strong title={file.name}>{file.name}</strong>
                    <span>{formatBytes(file.size)} · {chunks.length} 个分片</span>
                  </div>
                  <button className="text-button" type="button" onClick={reset} disabled={isBusy}>
                    移除
                  </button>
                </div>

                <div className="controls">
                  <label>
                    分片大小
                    <select
                      value={chunkSizeMb}
                      onChange={(event) => changeChunkSize(Number(event.target.value))}
                      disabled={isBusy || status === "paused"}
                    >
                      {CHUNK_OPTIONS.map((value) => <option key={value} value={value}>{value} MB</option>)}
                    </select>
                  </label>
                  <label>
                    并发数
                    <select
                      value={concurrency}
                      onChange={(event) => setConcurrency(Number(event.target.value))}
                      disabled={isBusy}
                    >
                      {CONCURRENCY_OPTIONS.map((value) => <option key={value} value={value}>{value} 路</option>)}
                    </select>
                  </label>
                </div>

                {fileHash && (
                  <div className="fingerprint">
                    <span>抽样 SHA-256</span>
                    <code title={fileHash}>{fileHash.slice(0, 18)}…{fileHash.slice(-8)}</code>
                  </div>
                )}

                {status === "hashing" && (
                  <Progress label="正在抽取文件样本" value={hashProgress} detail="不会读取完整文件" />
                )}

                {["checking", "uploading", "paused", "merging", "success", "error"].includes(status) && (
                  <Progress
                    label={status === "merging" ? "服务端正在按顺序合并" : "分片传输进度"}
                    value={uploadProgress}
                    detail={status === "uploading"
                      ? `${uploadedCount}/${chunks.length} 片 · ${formatBytes(speed)}/s`
                      : `${uploadedCount}/${chunks.length} 片`}
                    tone={status === "success" ? "success" : status === "error" ? "error" : "default"}
                  />
                )}

                {error && <p className="error-message" role="alert">{error}</p>}

                <div className="actions">
                  {primaryLabel && (
                    <button className="primary-button" type="button" onClick={startUpload}>
                      {primaryLabel}<span aria-hidden="true">→</span>
                    </button>
                  )}
                  {status === "uploading" && (
                    <button className="secondary-button" type="button" onClick={pauseUpload}>暂停上传</button>
                  )}
                  {status === "success" && (
                    <>
                      <a className="primary-button" href={downloadUrl}>下载文件<span aria-hidden="true">↓</span></a>
                      <button className="secondary-button" type="button" onClick={reset}>继续上传</button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="how-it-works" aria-labelledby="hash-title">
          <div className="section-intro">
            <p className="eyebrow">SAMPLE HASH / 02</p>
            <h2 id="hash-title">哈希，不必读完全部。</h2>
            <p>
              哈希函数会把任意长度的数据映射成固定长度的“指纹”。这里使用抽样数据计算 SHA-256，
              目的是快速识别文件、查询已上传分片；它不是完整内容校验，也不替代安全场景中的全量哈希。
            </p>
          </div>

          <div className="hash-diagram">
            <SampleChunk label="首片" detail="完整读取" variant="full" />
            <span className="plus">+</span>
            <SampleChunk label="中间片 × N" detail="头 2B · 中 2B · 尾 2B" variant="sample" />
            <span className="plus">+</span>
            <SampleChunk label="尾片" detail="完整读取" variant="full" />
            <span className="arrow">→</span>
            <div className="hash-result"><span>SHA-256</span><strong>64 位十六进制指纹</strong></div>
          </div>

          <div className="process-grid">
            <article><span>01</span><h3>切片</h3><p>用 Blob.slice 在浏览器中切分，不把完整文件一次性读入内存。</p></article>
            <article><span>02</span><h3>查重</h3><p>用文件指纹与大小查询服务端，完整则秒传，不完整则取回已有分片编号。</p></article>
            <article><span>03</span><h3>并发</h3><p>仅发送缺失分片，单片失败最多重试 3 次，暂停后可从服务端状态继续。</p></article>
            <article><span>04</span><h3>合并</h3><p>服务端校验分片数量和大小，再按编号流式写入最终文件。</p></article>
          </div>
        </section>
      </main>

      <footer><span>SHARD UPLOAD LAB</span><span>数据只保存在本地服务端</span></footer>
    </div>
  );
}

function Progress({ label, value, detail, tone = "default" }) {
  const normalized = Math.max(0, Math.min(100, value || 0));
  return (
    <div className={`progress-block progress-${tone}`}>
      <div className="progress-copy">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div className="progress-track" role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.round(normalized)}>
        <span style={{ width: `${normalized}%` }} />
      </div>
      <b>{normalized.toFixed(normalized < 10 && normalized > 0 ? 1 : 0)}%</b>
    </div>
  );
}

function SampleChunk({ label, detail, variant }) {
  return (
    <div className={`sample-chunk sample-${variant}`}>
      <div className="chunk-visual" aria-hidden="true">
        {variant === "sample" && <><i /><i /><i /></>}
      </div>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

export default App;
