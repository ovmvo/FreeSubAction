#!/usr/bin/env node

const { mkdir, readFile, readdir, rm, writeFile } = require("node:fs/promises");
const { join } = require("node:path");
const { parseArgs } = require("node:util");

const SCRIPT_DIR = __dirname; // 脚本目录，用于定位仓库内模板
const RETRY_DELAY_MS = 3000; // 下载失败后的固定重试间隔

// 清空目标目录，同时保留目录本身供后续写入。
async function cleanDirectory(path) {
  await mkdir(path, { recursive: true });
  await Promise.all(
    (await readdir(path, { withFileTypes: true })).map((entry) =>
      rm(join(path, entry.name), { recursive: true, force: true }),
    ),
  );
}

// 延迟指定时长，避免连续请求远端服务。
function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// 下载原始订阅数据，空响应和非成功状态均视为失败并重试。
async function downloadWithRetries(url, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > 0) {
        return data;
      }
      throw new Error("empty response");
    } catch (error) {
      console.error(`Download attempt ${attempt} failed: ${error.message}`);
    }

    if (attempt < maxAttempts) {
      console.log("Retrying in 3 seconds...");
      await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

// 解析工作流参数，并在发起请求前拒绝缺失或无效的关键值。
function getOptions() {
  const { values } = parseArgs({
    options: {
      "source-url": { type: "string" },
      "max-attempts": { type: "string", default: "3" },
    },
    strict: true,
  });
  const maxAttempts = Number(values["max-attempts"]);
  if (!values["source-url"]) {
    throw new Error("--source-url is required.");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("--max-attempts must be a positive integer.");
  }
  return {
    sourceUrl: values["source-url"],
    maxAttempts,
  };
}

// 获取数据后一次性更新 latest，并在当前小时满足策略时更新 permanent。
async function main() {
  const options = getOptions();
  const latestDirectory = join("sub", "latest"); // 每轮仅保留一个随机名称的最新订阅
  const permanentDirectory = join("sub", "permanent"); // 每 8 小时覆盖一次的固定订阅
  const templatePath = join(SCRIPT_DIR, "..", "templates", "mihomo.yaml");
  let templateContent;
  try {
    templateContent = await readFile(templatePath);
  } catch (error) {
    console.error(`Template file could not be read: ${templatePath}: ${error.message}`);
    return 1;
  }

  const downloadedData = await downloadWithRetries(options.sourceUrl, options.maxAttempts);
  if (!downloadedData) {
    console.error(`Failed to download data after ${options.maxAttempts} attempts. Exiting without update.`);
    return 1;
  }

  const mergedData = Buffer.concat([
    Buffer.from(templateContent.toString("utf8").trimEnd()),
    Buffer.from("\n\n"),
    downloadedData,
  ]);
  const latestFile = join(
    latestDirectory,
    `${Math.floor(Math.random() * 90_000_000) + 10_000_000}.yaml`,
  );
  await cleanDirectory(latestDirectory);
  await writeFile(latestFile, mergedData);

  if (new Date().getHours() % 8 === 0) {
    await cleanDirectory(permanentDirectory);
    await writeFile(join(permanentDirectory, "mihomo.yaml"), mergedData);
  }
  return 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
