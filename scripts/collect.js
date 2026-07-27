#!/usr/bin/env node
const { createWriteStream } = require("node:fs"); // 将下载响应流直接写入临时文件
const fs = require("node:fs/promises"); // 负责创建目录和写入采集结果
const { tmpdir } = require("node:os"); // 提供 Runner 临时目录
const { join } = require("node:path"); // 负责构造目标仓库内的输出路径
const { Readable } = require("node:stream"); // 将 Fetch 响应转换为 Node.js 可读流
const { pipeline } = require("node:stream/promises"); // 以背压方式传输下载数据
const { ProxyUtils } = require("./proxy-utils.js"); // 负责解析节点并生成 Mihomo 配置

const query = "节点 OR 订阅 OR v2ray OR vless"; // GitHub 仓库搜索条件
const repoLimit = 50; // 每次搜索最多读取的仓库数量
const concurrency = 50; // 下载原始文件时的并发任务数
const collectFileSuffixes = ["", "txt", "yaml", "yml", "json"]; // 允许采集的文件后缀
const proxyChunkSize = 10000; // 每个输出文件最多包含的节点数

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.v3+json",
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`);
  }
  return response.json();
}

// 从环境变量读取目标仓库信息，并严格校验 owner/repo 格式。
function getRepoContext() {
  const targetRepository = process.env.TARGET_REPOSITORY;
  const branch = process.env.TARGET_BRANCH;
  if (!targetRepository || !branch) {
    throw new Error("Environment variables TARGET_REPOSITORY and TARGET_BRANCH are required.");
  }
  if (!targetRepository.includes("/")) {
    throw new Error("TARGET_REPOSITORY must be in 'owner/repo' format.");
  }
  const [owner, ...repoParts] = targetRepository.split("/");
  return { owner, repo: repoParts.join("/"), branch };
}

// 将一个节点分片写入目标仓库，文件编号按收集顺序递增。
async function writeProxyChunk(directory, proxies, index) {
  const fileName = `${String(index).padStart(2, "0")}.yaml`;
  await fs.writeFile(join(directory, fileName), `${ProxyUtils.produce(proxies, "mihomo")}\n`);
  console.log(`wrote sub/raw/${fileName}`);
}

async function main() {
  const { owner, repo, branch } = getRepoContext();
  const files = []; // 待下载的仓库原始文件
  let proxyChunk = []; // 当前节点分片，最多保留 proxyChunkSize 个节点
  const proxyFingerprints = new Set(); // 全局节点指纹，用于跨文件去重
  let proxyCount = 0; // 已收集的唯一节点总数
  let outputFileCount = 0; // 已分配的输出文件数量

  console.log(`search repositories: q="${query}", limit=${repoLimit}, token=${process.env.GITHUB_TOKEN ? "yes" : "no"}`);

  for (const repo of (await githubJson(`https://api.github.com/search/repositories?${new URLSearchParams({
    q: query,
    sort: "updated",
    order: "desc",
    per_page: String(repoLimit),
  })}`)).items || []) {
    if (repo.name.toLowerCase().includes("github.io")) {
      console.log(`skip repository: ${repo.full_name}`);
      continue;
    }
    try {
      const commit = await githubJson(`https://api.github.com/repos/${repo.full_name}/commits/HEAD`);
      let fileCount = 0;
      for (const file of commit.files || []) {
        if (file.status !== "removed" && file.filename && collectFileSuffixes.includes(file.filename.includes(".") ? file.filename.split(".").pop().toLowerCase() : "")) {
          files.push({
            name: `${repo.full_name}/${file.filename}`,
            url: `https://raw.githubusercontent.com/${repo.full_name}/${commit.sha}/${file.filename.split("/").map(encodeURIComponent).join("/")}`,
          });
          fileCount++;
        }
      }
      console.log(`commit files: ${repo.full_name} ${fileCount}`);
    } catch (error) {
      console.warn(`skip ${repo.full_name}: ${error.message}`);
    }
  }

  const downloadDirectory = await fs.mkdtemp(join(tmpdir(), "free-sub-collect-")); // 原始文件的临时落盘目录
  const downloadedPaths = new Array(files.length); // 与 files 下标对应的成功下载路径
  let downloadIndex = 0; // 下载 worker 领取任务的共享下标
  let downloaded = 0;

  console.log(`raw files: ${files.length}, concurrency=${Math.min(concurrency, files.length)}`);

  // 下载 worker 仅负责流式落盘，所有下载完成后再进入单线程解析阶段。
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, async () => {
    for (; ;) {
      const fileIndex = downloadIndex++;
      const file = files[fileIndex];
      if (!file) {
        return;
      }
      try {
        downloadedPaths[fileIndex] = join(downloadDirectory, `${fileIndex}.raw`);
        const response = await fetch(file.url);
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        if (!response.body) {
          throw new Error("empty response body");
        }
        await pipeline(Readable.fromWeb(response.body), createWriteStream(downloadedPaths[fileIndex]));
        downloaded++;
        console.log(`${file.name} downloaded`);
      } catch (error) {
        downloadedPaths[fileIndex] = null;
        console.warn(`skip ${file.name}: ${error.message}`);
      }
    }
  }));

  console.log(`raw contents downloaded: ${downloaded}`);
  const rawDirectory = join(process.cwd(), "sub", "raw"); // Action 当前目录为目标仓库根目录
  await fs.rm(rawDirectory, { recursive: true, force: true });
  await fs.mkdir(rawDirectory, { recursive: true });

  // 单个解析循环逐个处理落盘文件，任何时刻只保留一个文件的解析结果。
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    if (!downloadedPaths[fileIndex]) {
      continue;
    }
    try {
      for (const proxy of ProxyUtils.parse(await fs.readFile(downloadedPaths[fileIndex], "utf8"))) {
        if (JSON.stringify(proxy).toLowerCase().includes("workers.dev")) {
          continue;
        }
        // 仅使用连接身份字段生成稳定指纹，其他配置差异不重复保留同一节点。
        const fingerprint = JSON.stringify([
          proxy.type ?? "",
          proxy.server ?? "",
          proxy.port == null ? null : String(proxy.port),
          proxy.password ?? "",
          proxy.uuid ?? "",
          proxy.servername ?? "",
        ]);
        if (!proxyFingerprints.has(fingerprint)) {
          proxyFingerprints.add(fingerprint);
          proxyCount++;
          proxy.name = String(proxyCount).padStart(7, "0");
          proxyChunk.push(proxy);
          if (proxyChunk.length === proxyChunkSize) {
            const fullChunk = proxyChunk; // 写入前释放活动分片引用，下一轮使用空数组
            proxyChunk = [];
            await writeProxyChunk(rawDirectory, fullChunk, ++outputFileCount);
          }
        }
      }
      console.log(`${files[fileIndex].name} parsed: ${proxyCount}`);
    } catch (error) {
      console.warn(`skip parse: ${files[fileIndex].name}: ${error.message}`);
    }
  }

  console.log(`proxies total: ${proxyCount}`);
  if (proxyChunk.length > 0 || outputFileCount === 0) {
    const finalChunk = proxyChunk; // 最后一个不足分片或无节点时的空分片
    proxyChunk = [];
    await writeProxyChunk(rawDirectory, finalChunk, ++outputFileCount);
  }

  // 按输出编号生成分片直链索引，供订阅客户端逐行读取。
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}`;
  await fs.writeFile(
    join(rawDirectory, "00.txt"),
    `${Array.from(
      { length: outputFileCount },
      (_, index) => `${rawBase}/sub/raw/${String(index + 1).padStart(2, "0")}.yaml`,
    ).join("\n")}\n`,
  );
  console.log("wrote sub/raw/00.txt");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
