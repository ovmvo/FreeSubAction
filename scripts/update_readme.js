#!/usr/bin/env node

const { readFile, readdir, stat, writeFile } = require("node:fs/promises");
const { basename, join } = require("node:path");
const renderReadmeSection = require("../templates/readme_section.js");

const MARK_START = "<!-- START: AUTO-UPDATED LINKS -->"; // README 自动区块起始标记
const MARK_END = "<!-- END: AUTO-UPDATED LINKS -->"; // README 自动区块结束标记
const CHINA_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
}); // 文件时间统一按中国时区输出

// 将时间稳定格式化为 README 使用的中国时区文本。
function formatTime(date) {
  if (!date) {
    return "N/A";
  }
  const parts = Object.fromEntries(
    CHINA_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} CST`;
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

// 返回 latest 目录中的订阅文件；该目录每轮更新前会被清空。
async function latestSubFile(directory) {
  try {
    const entry = (await readdir(directory, { withFileTypes: true })).find((item) => item.isFile());
    return entry ? join(directory, entry.name) : null;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// 读取可选文件的修改时间，不存在时交由模板显示 N/A。
async function fileMtime(path) {
  if (!path) {
    return null;
  }
  try {
    return (await stat(path)).mtime;
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// 计算模板需要的订阅链接和对应文件时间。
async function buildContext(owner, repo, branch, root) {
  const latestFile = await latestSubFile(join(root, "sub", "latest"));
  const permanentFile = join(root, "sub", "permanent", "mihomo.yaml");
  const rawBase = `https://raw.githubusercontent.com/${owner}/${repo}/refs/heads/${branch}`;
  return {
    permanentLink: `${rawBase}/sub/permanent/mihomo.yaml`,
    latestLink: latestFile ? `${rawBase}/sub/latest/${basename(latestFile)}` : "N/A",
    permanentTime: formatTime(await fileMtime(permanentFile)),
    latestTime: formatTime(await fileMtime(latestFile)),
  };
}

// 替换已有自动区块；目标 README 尚未创建时直接写入完整区块。
async function updateReadme(path, section) {
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    content = "";
  }

  const block = `${MARK_START}\n\n${section}\n${MARK_END}`;
  if (content.includes(MARK_START) && content.includes(MARK_END)) {
    content = content.replace(
      new RegExp(`${MARK_START}.*?${MARK_END}`, "s"),
      () => block,
    );
  } else {
    content = `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${block}\n`;
  }
  await writeFile(path, content, "utf8");
}

// 汇总目标仓库状态，通过 Node.js 模板模块渲染并写回 README。
async function main() {
  const root = process.cwd(); // 工作流将当前目录设置为目标仓库根目录
  const { owner, repo, branch } = getRepoContext();
  await updateReadme(
    join(root, "README.md"),
    renderReadmeSection(await buildContext(owner, repo, branch, root)),
  );
  console.log("README.md updated with subscription links and times.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
