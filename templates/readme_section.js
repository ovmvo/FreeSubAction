// 使用 Node.js 模板字符串生成 README 中由工作流维护的订阅区块。
module.exports = function renderReadmeSection(context) {
  return `## 公益订阅 - 更新状态

### 🔒 永久订阅 - 每8小时更新一次

永久链接使用固定名称，不会改变。

\`\`\`
${context.permanentLink}
\`\`\`

🕒 最后更新: ${context.permanentTime}

### ⚡ 最新订阅 - 每2小时更新一次

最新链接使用随机名称，每次更新都会改变。

\`\`\`
${context.latestLink}
\`\`\`

🕒 最后更新: ${context.latestTime}
`;
};
