const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, execSync, spawn } = require('child_process');

const PORT = 3388;
const WORKSPACE_DIR = __dirname;
const EXTRACT_DIR = path.join(WORKSPACE_DIR, 'extracted');

let logs = [];

function log(msg) {
  const time = new Date().toLocaleTimeString();
  const formatted = `[${time}] ${msg}`;
  logs.push(formatted);
  console.log(formatted);
}

function getHostUsername() {
  return process.env.USERNAME || process.env.USER || (process.platform === 'win32' ? 'Administrator' : 'user');
}

function getAsarCmd() {
  const majorVersion = parseInt(process.versions.node.split('.')[0], 10);
  if (majorVersion >= 18) {
    return 'npx -y @electron/asar';
  } else {
    return 'npx -y asar@3.2.0';
  }
}

const SUPPORTED_APPS = [
  {
    id: 'antigravity',
    name: 'Antigravity 2.0 (反重力 Agent 客户端)',
    execNames: ['Antigravity.exe', 'antigravity'],
    packageNames: ['antigravity', 'Antigravity']
  },
  {
    id: 'opencode',
    name: 'OpenCode 客户端',
    execNames: ['OpenCode.exe', 'opencode.exe', 'opencode'],
    packageNames: ['@opencode-aidesktop', 'opencode', 'OpenCode']
  },
  {
    id: 'codex',
    name: 'Codex 客户端',
    execNames: ['Codex.exe', 'codex.exe', 'codex'],
    packageNames: ['codex', 'Codex']
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT 客户端',
    execNames: ['ChatGPT.exe', 'chatgpt.exe', 'ChatGPT Desktop.exe'],
    packageNames: ['chatgpt', 'ChatGPT', 'openai', 'com.openai.chatgpt', 'OpenAI.ChatGPT', 'OpenAI.Codex']
  },
  {
    id: 'claude',
    name: 'Claude Desktop 客户端',
    execNames: ['Claude.exe', 'claude'],
    packageNames: ['claude-desktop', 'claude']
  },
  {
    id: 'windsurf',
    name: 'Windsurf AI 客户端',
    execNames: ['Windsurf.exe', 'windsurf'],
    packageNames: ['windsurf']
  }
];

// 智能检测 Resources 目录（支持文件路径、resources/Resources 大小写及子层级）
function getResourcesDir(appDir) {
  if (!appDir) return '';

  let checkPath = appDir;
  try {
    if (fs.existsSync(checkPath) && fs.statSync(checkPath).isFile()) {
      if (path.basename(checkPath).toLowerCase() === 'app.asar') {
        return path.dirname(checkPath);
      }
      checkPath = path.dirname(checkPath);
    }
  } catch (e) {}

  if (path.basename(checkPath).toLowerCase() === 'resources') {
    if (fs.existsSync(path.join(checkPath, 'app.asar'))) {
      return checkPath;
    }
  }

  const upperPath = path.join(checkPath, 'Resources');
  const lowerPath = path.join(checkPath, 'resources');
  if (fs.existsSync(path.join(upperPath, 'app.asar'))) return upperPath;
  if (fs.existsSync(path.join(lowerPath, 'app.asar'))) return lowerPath;
  if (fs.existsSync(upperPath)) return upperPath;
  if (fs.existsSync(lowerPath)) return lowerPath;

  // 深度 1 级子目录检索（应对微软商店 Packages 或 app 嵌套层级）
  try {
    if (fs.existsSync(checkPath) && fs.statSync(checkPath).isDirectory()) {
      const items = fs.readdirSync(checkPath);
      for (const item of items) {
        const subPath = path.join(checkPath, item);
        try {
          if (fs.statSync(subPath).isDirectory()) {
            const subUpper = path.join(subPath, 'Resources');
            const subLower = path.join(subPath, 'resources');
            if (fs.existsSync(path.join(subUpper, 'app.asar'))) return subUpper;
            if (fs.existsSync(path.join(subLower, 'app.asar'))) return subLower;
            if (fs.existsSync(path.join(subPath, 'app.asar'))) return subPath;
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  return process.platform === 'darwin' ? upperPath : lowerPath;
}

// 意图识别：仅当路径实际存在时判定匹配，路径不存在时明确显示未检测到
function identifyAppIntent(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return { id: 'unknown', name: '未配置路径', matched: false };
  }

  const rawPath = targetPath.trim();
  if (!fs.existsSync(rawPath)) {
    return { id: 'unknown', name: '未找到安装目录 / 软件未安装', matched: false };
  }

  let checkPath = rawPath;
  try {
    if (fs.statSync(checkPath).isFile()) {
      checkPath = path.dirname(checkPath);
    }
  } catch (e) {}

  const lowerPath = checkPath.toLowerCase();

  for (const app of SUPPORTED_APPS) {
    for (const exe of app.execNames) {
      if (fs.existsSync(path.join(checkPath, exe)) || lowerPath.endsWith(exe.toLowerCase())) {
        return { id: app.id, name: app.name, matched: true, reason: `匹配程序: ${exe}` };
      }
    }
    for (const pkg of app.packageNames) {
      if (lowerPath.includes(pkg.toLowerCase())) {
        return { id: app.id, name: app.name, matched: true, reason: `匹配关键字: ${pkg}` };
      }
    }
  }

  const resDir = getResourcesDir(checkPath);
  if (fs.existsSync(path.join(resDir, 'app.asar'))) {
    return { id: 'electron_generic', name: '通用 Electron AI 客户端', matched: true, reason: '检测到 app.asar' };
  }

  return { id: 'custom', name: '自定义 Electron 应用', matched: true, reason: '指定自定义路径' };
}

function detectInstalledApps() {
  const user = getHostUsername();
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : `C:\\Users\\${user}\\AppData\\Local`);
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';

  const detected = [];
  const seenPaths = new Set();

  function addIfValid(appId, appName, appPath) {
    if (!appPath || seenPaths.has(appPath.toLowerCase())) return;
    if (fs.existsSync(appPath)) {
      const resDir = getResourcesDir(appPath);
      if (fs.existsSync(path.join(resDir, 'app.asar'))) {
        seenPaths.add(appPath.toLowerCase());
        detected.push({ id: appId, name: appName, path: appPath });
      }
    }
  }

  // 1. 常规目录扫描
  addIfValid('antigravity', 'Antigravity 2.0 (反重力 Agent 客户端)', path.join(localAppData, 'Programs', 'antigravity'));
  addIfValid('opencode', 'OpenCode 客户端', path.join(localAppData, 'Programs', '@opencode-aidesktop'));
  addIfValid('opencode', 'OpenCode 客户端', path.join(localAppData, 'Programs', 'opencode'));
  addIfValid('codex', 'Codex 客户端', path.join(localAppData, 'Programs', 'codex'));
  addIfValid('codex', 'Codex 客户端', path.join(programFiles, 'Codex'));
  addIfValid('chatgpt', 'ChatGPT 客户端', path.join(localAppData, 'Programs', 'ChatGPT'));
  addIfValid('chatgpt', 'ChatGPT 客户端', path.join(programFiles, 'ChatGPT'));
  addIfValid('claude', 'Claude Desktop 客户端', path.join(localAppData, 'Programs', 'claude-desktop'));
  addIfValid('windsurf', 'Windsurf AI 客户端', path.join(localAppData, 'Programs', 'Windsurf'));

  // 2. 深度扫描 Windows Store / MSIX 打包应用 (利用 PowerShell Get-AppxPackage API 穿透 WindowsApps 目录 EPERM 权限)
  if (isWin) {
    try {
      const psOutput = execSync(`powershell -NoProfile -Command "Get-AppxPackage | Select-Object Name, InstallLocation | ConvertTo-Json -Compress"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] });
      if (psOutput && psOutput.trim()) {
        let pkgs = [];
        try {
          const parsed = JSON.parse(psOutput.trim());
          pkgs = Array.isArray(parsed) ? parsed : [parsed];
        } catch(e){}

        for (const pkg of pkgs) {
          if (!pkg || !pkg.InstallLocation) continue;
          const name = (pkg.Name || '').toLowerCase();
          const loc = pkg.InstallLocation;

          if (name.includes('claude') || name.includes('anthropic')) {
            addIfValid('claude', 'Claude Desktop 客户端', loc);
            addIfValid('claude', 'Claude Desktop 客户端', path.join(loc, 'app'));
          } else if (name.includes('chatgpt') || name.includes('openai')) {
            addIfValid('chatgpt', 'ChatGPT (微软商店 WindowsApps 版)', loc);
            addIfValid('chatgpt', 'ChatGPT (微软商店 WindowsApps 版)', path.join(loc, 'app'));
          } else if (name.includes('codex')) {
            addIfValid('codex', 'Codex (微软商店 WindowsApps 版)', loc);
            addIfValid('codex', 'Codex (微软商店 WindowsApps 版)', path.join(loc, 'app'));
          } else if (name.includes('opencode')) {
            addIfValid('opencode', 'OpenCode (微软商店 WindowsApps 版)', loc);
            addIfValid('opencode', 'OpenCode (微软商店 WindowsApps 版)', path.join(loc, 'app'));
          }
        }
      }
    } catch (e) {}
  }

  const finalDetected = [];
  const seenAsarPaths = new Set();
  for (const app of detected) {
    const resDir = getResourcesDir(app.path);
    const asarPath = path.join(resDir, 'app.asar').toLowerCase();
    if (!seenAsarPaths.has(asarPath)) {
      seenAsarPaths.add(asarPath);
      finalDetected.push(app);
    }
  }

  return finalDetected;
}

// Check if app processes are running
function isAppRunning() {
  try {
    if (process.platform === 'win32') {
      const output = execSync('tasklist', { encoding: 'utf-8' }).toLowerCase();
      return output.includes('antigravity.exe') || output.includes('codex.exe') || output.includes('opencode.exe') || output.includes('chatgpt.exe') || output.includes('claude.exe') || output.includes('windsurf.exe');
    } else {
      execSync('pgrep -xi "antigravity|codex|opencode|chatgpt|claude|windsurf"', { stdio: 'ignore' });
      return true;
    }
  } catch (e) {
    return false;
  }
}

// Kill app processes dynamically based on targeted app intent
function killApp(appDir) {
  let appName = 'AI 桌面客户端';
  let exes = ['Antigravity.exe', 'Codex.exe', 'OpenCode.exe', 'ChatGPT.exe', 'chatgpt.exe', 'ChatGPT Desktop.exe', 'antigravity', 'codex', 'opencode', 'chatgpt', 'Claude.exe', 'Windsurf.exe'];

  if (appDir) {
    const intent = identifyAppIntent(appDir);
    if (intent && intent.name && intent.matched) {
      appName = intent.name;
    }
    if (intent.id === 'antigravity') {
      exes = ['Antigravity.exe', 'antigravity'];
    } else if (intent.id === 'opencode') {
      exes = ['OpenCode.exe', 'opencode.exe', 'opencode'];
    } else if (intent.id === 'codex') {
      exes = ['Codex.exe', 'codex.exe', 'codex'];
    } else if (intent.id === 'chatgpt') {
      exes = ['ChatGPT.exe', 'chatgpt.exe', 'ChatGPT Desktop.exe'];
    } else if (intent.id === 'claude') {
      exes = ['Claude.exe', 'claude'];
    } else if (intent.id === 'windsurf') {
      exes = ['Windsurf.exe', 'windsurf'];
    }
  }

  log(`正在尝试关闭运行中的 ${appName} 进程...`);
  for (const exe of exes) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /IM ${exe}`, { stdio: 'ignore' });
      } else {
        execSync(`pkill -xi ${exe}`, { stdio: 'ignore' });
      }
      log(`已成功关闭进程: ${exe}`);
    } catch (e) {
      // not running
    }
  }
}

// Compute standard app directory based on dynamic username or custom path input
function getAppDir(username, useDefault, customPath) {
  if ((useDefault === false || useDefault === 'false') && customPath) {
    return customPath.trim();
  }

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const defaultUser = getHostUsername();
  const user = username ? username.trim() : defaultUser;

  if (isWin) {
    return `C:\\Users\\${user}\\AppData\\Local\\Programs\\antigravity`;
  } else if (isMac) {
    return `/Applications/Antigravity.app/Contents`;
  } else {
    return `/home/${user}/Antigravity/Antigravity-x64`;
  }
}

// Web UI DOM Localization engine injection payload
const DOM_TRANSLATOR_INJECTION = `
// Universal AI Client Chinese Localization Engine
(function() {
  // 核心环境防御：若处于 Node.js Main 主进程环境（未定义 DOM/window），立即安全退出，防止抛出 ReferenceError
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return;
  }

  const dictionary = {
    // Top Bar & Menus
    "File": "文件",
    "Edit": "编辑",
    "View": "视图",
    "Window": "窗口",
    "Help": "帮助",
    "Settings": "设置",
    "Preferences": "偏好设置",
    "Account": "账户",
    "Profile": "个人资料",
    "General": "通用",
    "Appearance": "外观",
    "Theme": "主题",
    "Dark": "深色",
    "Light": "浅色",
    "System": "跟随系统",
    "Language": "语言",
    "Model": "模型",
    "Chat": "对话",
    "New Chat": "新建对话",
    "Clear Chat": "清空对话",
    "Delete Chat": "删除对话",
    "History": "历史记录",
    "Recent Chats": "最近对话",
    "Search": "搜索",
    "Send": "发送",
    "Stop": "停止",
    "Regenerate": "重新生成",
    "Copy": "复制",
    "Copied": "已复制",
    "Retry": "重试",
    "Cancel": "取消",
    "Save": "保存",
    "Close": "关闭",
    "Submit": "提交",
    "Confirm": "确认",
    "Apply": "应用",
    "Back": "返回",
    "Next": "下一步",
    "Finish": "完成",
    "Status": "状态",
    "Online": "在线",
    "Offline": "离线",
    "Connected": "已连接",
    "Disconnected": "已断开",
    "Loading...": "加载中...",
    "Error": "错误",
    "Warning": "警告",
    "Success": "成功",
    "Info": "提示",
    "About": "关于",
    "Version": "版本",
    "Documentation": "文档",
    "Feedback": "反馈",
    "Logs": "日志",
    "Developer Tools": "开发者工具",
    "Check for Updates": "检查更新",
    "Checking for Updates...": "正在检查更新...",
    "Downloading Update...": "正在下载更新...",
    "Restart to Update": "重启以应用更新",
    "Undo": "撤销",
    "Redo": "重做",
    "Cut": "剪切",
    "Paste": "粘贴",
    "Select All": "全选",
    "Minimize": "最小化",
    "Quit": "退出"
  };

  function translateText(text) {
    if (!text || typeof text !== 'string') return text;
    const trimmed = text.trim();
    if (dictionary[trimmed]) {
      return text.replace(trimmed, dictionary[trimmed]);
    }
    return text;
  }

  function walkAndTranslate(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const translated = translateText(node.nodeValue);
      if (translated !== node.nodeValue) {
        node.nodeValue = translated;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tagName = node.tagName ? node.tagName.toUpperCase() : '';
      if (tagName === 'INPUT' || tagName === 'TEXTAREA' || node.isContentEditable) {
        return;
      }
      if (node.placeholder) {
        node.placeholder = translateText(node.placeholder);
      }
      if (node.title) {
        node.title = translateText(node.title);
      }
      if (node.getAttribute && node.getAttribute('aria-label')) {
        const aria = node.getAttribute('aria-label');
        const translatedAria = translateText(aria);
        if (translatedAria !== aria) {
          node.setAttribute('aria-label', translatedAria);
        }
      }
      for (let child of node.childNodes) {
        walkAndTranslate(child);
      }
      if (node.shadowRoot) {
        walkAndTranslate(node.shadowRoot);
      }
    }
  }

  function startObserver() {
    walkAndTranslate(document.body);
    const observer = new MutationObserver((mutations) => {
      for (let mutation of mutations) {
        if (mutation.type === 'childList') {
          for (let addedNode of mutation.addedNodes) {
            walkAndTranslate(addedNode);
          }
        } else if (mutation.type === 'characterData') {
          walkAndTranslate(mutation.target);
        }
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
  } else {
    startObserver();
  }
})();
`;

// Perform localization modification operations on extracted files
function applyTranslations() {
  log('开始对解压的文件进行汉化替换和代码注入...');

  function safeAppendOnce(filePath, content, marker, desc) {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing.includes(marker)) {
      log(`${desc} 已存在注入，跳过（避免重复）。`);
      return true;
    }
    // 强制换行与分号隔离 (\n;\n)，防止目标 JS 尾部为未加分号的 require(...) 导致模块语法融合报错 (TypeError: require(...) is not a function)
    const safeContent = '\n;\n' + content + '\n;\n';
    fs.appendFileSync(filePath, safeContent, 'utf-8');
    log(`已向 ${path.basename(filePath)} 注入 ${desc}。`);
    return true;
  }

  function safeReplaceInFile(filePath, target, replacement) {
    if (!filePath || !fs.existsSync(filePath)) {
      return false;
    }
    let content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes(replacement)) {
      log(`文件 ${path.basename(filePath)} 已经应用过此汉化修改，跳过。`);
      return true;
    }
    if (content.includes(target)) {
      content = content.replace(target, replacement);
      fs.writeFileSync(filePath, content, 'utf-8');
      log(`已成功修改 ${path.basename(filePath)}`);
      return true;
    }
    return false;
  }

  // 1. 尝试注入到常见的 Preload 和 Entry 文件 (自适应 Antigravity / OpenCode / Codex / ChatGPT / Claude / Windsurf)
  let injectedCount = 0;
  const candidatePreloadFiles = [
    path.join(EXTRACT_DIR, 'out', 'renderer', 'oc-theme-preload.js'),
    path.join(EXTRACT_DIR, 'out', 'preload', 'index.js'),
    path.join(EXTRACT_DIR, 'dist', 'preload.js'),
    path.join(EXTRACT_DIR, 'preload.js'),
    path.join(EXTRACT_DIR, 'dist', 'ideInstall', 'wizardPreload.js'),
    path.join(EXTRACT_DIR, 'dist', 'renderer.js'),
    path.join(EXTRACT_DIR, 'renderer.js'),
    path.join(EXTRACT_DIR, 'dist', 'index.js'),
    path.join(EXTRACT_DIR, 'index.js'),
    path.join(EXTRACT_DIR, 'bundle.js')
  ];

  for (const pPath of candidatePreloadFiles) {
    if (fs.existsSync(pPath)) {
      if (safeAppendOnce(pPath, DOM_TRANSLATOR_INJECTION, 'Universal AI Client Chinese Localization Engine', `Web UI 实时汉化引擎 (${path.relative(EXTRACT_DIR, pPath)})`)) {
        injectedCount++;
      }
    }
  }

  if (injectedCount === 0) {
    // 递归寻找解包目录下的 Web 渲染与预加载 JS 文件进行自适应注入
    try {
      function scanAndInject(dir, depth = 0) {
        if (depth > 4 || !fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir);
        for (const item of items) {
          const full = path.join(dir, item);
          if (full.includes('\\main\\') || full.includes('/main/')) continue; // 绝对不上抹 Main 主进程目录
          try {
            if (fs.statSync(full).isDirectory()) {
              scanAndInject(full, depth + 1);
            } else if (item.endsWith('.js') && (item.includes('preload') || item.includes('renderer') || item.includes('oc-theme'))) {
              if (safeAppendOnce(full, DOM_TRANSLATOR_INJECTION, 'Universal AI Client Chinese Localization Engine', `Web UI 实时汉化引擎 (${path.relative(EXTRACT_DIR, full)})`)) {
                injectedCount++;
              }
            }
          } catch(e){}
        }
      }
      scanAndInject(EXTRACT_DIR);
    } catch(e){}
  }

  // 2. 尝试修改原生 Menu 菜单（若属于 Electron 经典架构）
  const menuPath = path.join(EXTRACT_DIR, 'dist', 'menu.js');
  const rootMenuPath = path.join(EXTRACT_DIR, 'menu.js');
  const targetMenuPath = fs.existsSync(menuPath) ? menuPath : (fs.existsSync(rootMenuPath) ? rootMenuPath : null);

  if (targetMenuPath) {
    const menuInjectCode = `
const menuTranslationMap = {
  'File': '文件',
  'Edit': '编辑',
  'View': '视图',
  'Window': '窗口',
  'Help': '帮助',
  'New Window': '新建窗口',
  'Docs': '使用文档',
  'Toggle Developer Tools': '开发者工具',
  'Check for Updates': '检查更新',
  'Checking for Updates...': '正在检查更新...',
  'Downloading Update...': '正在下载更新...',
  'Restart to Update': '重启以应用更新',
  'Undo': '撤销',
  'Redo': '重做',
  'Cut': '剪切',
  'Copy': '复制',
  'Paste': '粘贴',
  'Select All': '全选',
  'Minimize': '最小化',
  'Close': '关闭',
  'Quit': '退出'
};
function translateMenu(menuItem) {
  if (menuItem.label && menuTranslationMap[menuItem.label]) {
    menuItem.label = menuTranslationMap[menuItem.label];
  }
  if (menuItem.submenu && menuItem.submenu.items) {
    menuItem.submenu.items.forEach(translateMenu);
  }
}
`;
    safeAppendOnce(targetMenuPath, menuInjectCode, 'const menuTranslationMap = {', '原生菜单翻译映射');
    safeReplaceInFile(
      targetMenuPath,
      'electron_1.Menu.setApplicationMenu(menu);',
      `if (typeof translateMenu === 'function') { menu.items.forEach(translateMenu); } electron_1.Menu.setApplicationMenu(menu);`
    );
  }

  // 3. 尝试修改托盘 Tray (若存在)
  const trayPath = path.join(EXTRACT_DIR, 'dist', 'tray.js');
  const rootTrayPath = path.join(EXTRACT_DIR, 'tray.js');
  const targetTrayPath = fs.existsSync(trayPath) ? trayPath : (fs.existsSync(rootTrayPath) ? rootTrayPath : null);

  if (targetTrayPath) {
    safeReplaceInFile(
      targetTrayPath,
      `countItem.label =
                (count > 0 ? \`\${count}\` : 'No') +
                    ' agent' +
                    (count === 1 ? '' : 's') +
                    ' running';`,
      `countItem.label = count > 0 ? \`\${count} 个智能体运行中\` : '没有智能体在运行';`
    );
  }

  log('汉化修改注入完成！');
}

// Full workflow runner
async function runLocalizationWorkflow(appDir) {
  const resourcesDir = getResourcesDir(appDir);
  const asarPath = path.join(resourcesDir, 'app.asar');
  const backupPath = path.join(resourcesDir, 'app.asar.bak');

  logs = [];
  log('=================== 开始汉化流程 ===================');
  log(`目标程序目录: ${appDir}`);

  // ─── 特殊路径：Claude Desktop 原生 i18n 非破坏性汉化 ───────────────────────
  // Claude Desktop 的 i18n 系统原理（通过逆向 index.chunk-BwWqeh9s.js 确认）：
  //   1. 扫描 resources/ 目录中所有符合 xx-XX.json 格式的文件作为可用 locale
  //   2. 调用 app.getPreferredSystemLanguages() 获取 Windows 系统首选语言列表
  //   3. 优先精确匹配（如 zh-CN），其次前缀匹配（如 zh → zh-CN），降级 en-US
  // 方案：只需把 zh-CN.json 放进 resources/ 目录，完全不需要碰 app.asar！
  const intent = identifyAppIntent(appDir);
  if (intent && intent.id === 'claude') {
    log('✅ 检测到 Claude Desktop，使用非破坏性原生 i18n 汉化方案（不修改 app.asar）...');
    killApp(appDir);

    const zhCNDest = path.join(resourcesDir, 'zh-CN.json');
    const zhCNSource = path.join(__dirname, 'zh-CN-claude.json');

    let translationData = null;
    if (fs.existsSync(zhCNSource)) {
      translationData = fs.readFileSync(zhCNSource);
      log('✅ 已加载本地 zh-CN-claude.json 翻译文件（474 条完整汉化条目）...');
    } else {
      const enUS = path.join(resourcesDir, 'en-US.json');
      if (fs.existsSync(enUS)) {
        translationData = fs.readFileSync(enUS);
        log('⚠️ 未找到 zh-CN-claude.json，将使用 en-US.json 作为占位（界面仍为英文）...');
      }
    }

    if (!translationData) {
      throw new Error('无法找到翻译源文件。请确保 zh-CN-claude.json 存在于工具目录。');
    }

    // 写入目标（WindowsApps 受系统保护，需要多级权限升级）
    const os = require('os');
    const tmpFile = path.join(os.tmpdir(), 'zh-CN-claude-tmp.json');
    fs.writeFileSync(tmpFile, translationData);

    log(`正在写入 zh-CN.json 到 ${zhCNDest} ...`);
    let writeSuccess = false;
    try {
      fs.copyFileSync(tmpFile, zhCNDest);
      writeSuccess = true;
      log('zh-CN.json 写入成功（直接复制）。');
    } catch (e) {
      if (process.platform === 'win32') {
        try {
          execSync(`takeown /F "${resourcesDir}" /A /D Y`, { stdio: 'ignore' });
          execSync(`icacls "${resourcesDir}" /grant Administrators:F /C`, { stdio: 'ignore' });
          fs.copyFileSync(tmpFile, zhCNDest);
          writeSuccess = true;
          log('zh-CN.json 写入成功（takeown 授权后复制）。');
        } catch (e2) {
          try {
            const psScript = `takeown /F ''${resourcesDir}'' /A /D Y; icacls ''${resourcesDir}'' /grant Administrators:F /C; Copy-Item -LiteralPath ''${tmpFile}'' -Destination ''${zhCNDest}'' -Force`;
            execSync(`powershell -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command ${psScript}'"`, { stdio: 'ignore' });
            if (fs.existsSync(zhCNDest)) {
              writeSuccess = true;
              log('zh-CN.json 写入成功（UAC 提权复制）。');
            }
          } catch (e3) {}
        }
      }
    }

    if (!writeSuccess) {
      throw new Error(`无法写入 zh-CN.json 到 Claude Desktop 目录。\n请右键以管理员身份运行 Run_Localizer.bat 后重试。`);
    }

    // 检查 Windows 系统首选语言是否包含中文
    let sysLangs = [];
    try {
      const out = execSync('powershell -Command "(Get-WinUserLanguageList).LanguageTag -join \',\'"', { encoding: 'utf8' });
      sysLangs = out.trim().split(',').map(s => s.trim()).filter(Boolean);
    } catch(e) {}

    const hasChinese = sysLangs.some(l => l.startsWith('zh'));
    const chineseLang = sysLangs.find(l => l.startsWith('zh'));

    log('');
    log(`🎉 zh-CN.json 已成功写入 Claude Desktop resources 目录！`);
    log(`📁 路径：${zhCNDest}`);
    log('');

    if (hasChinese) {
      log(`✅ 已检测到系统语言包含中文（${chineseLang}）——汉化将在重启 Claude Desktop 后自动生效！`);
      log('👉 请重新启动 Claude Desktop，界面将自动显示中文。');
    } else {
      log('⚠️ 检测到您的 Windows 系统首选语言不包含中文！');
      log('');
      log('Claude Desktop 通过 Windows 系统语言自动选择加载哪个语言包。');
      log('请按以下步骤将中文设为系统首选语言：');
      log('  1. 打开 Windows 设置（Win+I）→ 时间和语言 → 语言和区域');
      log('  2. 点击"添加语言"→ 搜索"中文（简体，中国）"→ 安装');
      log('  3. 将"中文（简体，中国）"拖到语言列表最顶部（设为首选）');
      log('  4. 重启 Claude Desktop，界面将自动显示中文。');
    }
    log('=================== 汉化流程结束 ===================');
    return;
  }
  // ─── 通用路径：其他 Electron 应用（Antigravity、OpenCode、Codex 等）───────

  // Check path


  if (!fs.existsSync(asarPath)) {
    throw new Error(`找不到 app.asar 路径: ${asarPath}\n请确认软件是否安装在指定路径。`);
  }

  // 1. Kill running instances dynamically
  killApp(appDir);

  function clearReadOnly(targetPath) {
    if (!targetPath) return;
    try {
      if (fs.existsSync(targetPath)) {
        fs.chmodSync(targetPath, 0o666);
      }
    } catch (e) {}
    if (process.platform === 'win32') {
      try {
        execSync(`attrib -R "${targetPath}"`, { stdio: 'ignore' });
      } catch (e) {}
    }
  }

  // Helper for resilient file copy across protected Windows UWP/Program Files system directories
  function safeCopyFile(src, dest) {
    const destDir = path.dirname(dest);
    clearReadOnly(src);
    clearReadOnly(destDir);
    clearReadOnly(dest);

    // 1. 尝试常规 copyFileSync
    try {
      fs.copyFileSync(src, dest);
      clearReadOnly(dest);
      return true;
    } catch (e) {}

    // 2. 如果常规复制触发 EPERM (针对受 Windows 系统最高级别保护的 WindowsApps 目录与只读属性)
    if (process.platform === 'win32') {
      try {
        // 先尝试通过本地提升执行 takeown 夺权与 ACL 覆盖
        execSync(`takeown /F "${destDir}" /A /R /D Y`, { stdio: 'ignore' });
        execSync(`icacls "${destDir}" /grant Administrators:F /T /C`, { stdio: 'ignore' });
        execSync(`powershell -Command "Copy-Item -LiteralPath '${src}' -Destination '${dest}' -Force"`, { stdio: 'ignore' });
        if (fs.existsSync(dest)) {
          clearReadOnly(dest);
          return true;
        }
      } catch (err) {}

      try {
        // 若受 TrustedInstaller 保护阻拦，触发 Windows UAC 特权窗口以管理员组安全继承夺权并同步写入
        const psScript = `takeown /F ''${destDir}'' /A /R /D Y; icacls ''${destDir}'' /grant Administrators:F /T /C; attrib -R ''${dest}''; Copy-Item -LiteralPath ''${src}'' -Destination ''${dest}'' -Force`;
        execSync(`powershell -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command ${psScript}'"`, { stdio: 'ignore' });
        if (fs.existsSync(dest)) {
          clearReadOnly(dest);
          return true;
        }
      } catch (err) {}
    }

    throw new Error(`权限拒绝 (EPERM)：Windows 系统保护了该目录文件 (${destDir})\n【解决办法】：请在 Windows 中【右键 -> 以管理员身份运行】Run_Localizer.bat 批处理脚本后再试。`);
  }

  // 2. Backup app.asar
  if (!fs.existsSync(backupPath)) {
    log('正在创建 app.asar 的初始安全备份...');
    safeCopyFile(asarPath, backupPath);
    log('安全备份创建成功：' + backupPath);
  } else {
    log('安全备份已存在，跳过备份。备份文件: ' + backupPath);
  }

  // 3. Clean up existing extract dir if any
  if (fs.existsSync(EXTRACT_DIR)) {
    log('正在清理历史解压目录...');
    if (typeof fs.rmSync === 'function') {
      fs.rmSync(EXTRACT_DIR, { recursive: true, force: true });
    } else {
      fs.rmdirSync(EXTRACT_DIR, { recursive: true });
    }
  }

  // 4. Unpack app.asar
  log('正在解包 app.asar...');
  try {
    execSync(`${getAsarCmd()} extract "${asarPath}" "${EXTRACT_DIR}"`, { cwd: WORKSPACE_DIR });
    log('解包成功。');
  } catch (e) {
    throw new Error('解压 app.asar 失败: ' + e.message);
  }

  // 5. Apply modifications
  applyTranslations();

  // 6. Repack to temporary file
  const tempAsar = path.join(WORKSPACE_DIR, 'app.asar.temp');
  if (fs.existsSync(tempAsar)) {
    try { fs.unlinkSync(tempAsar); } catch(e){}
  }

  log('正在将修改后的文件重新打包为 app.asar...');
  try {
    // 使用 --unpack "*.node" 保留原生 C++ 模块解压状态，防止 Claude Desktop / Electron 原生 C++ 扩展崩溃闪退
    execSync(`${getAsarCmd()} pack "${EXTRACT_DIR}" "${tempAsar}" --unpack "*.node"`, { cwd: WORKSPACE_DIR });
    log('打包成功 (原生的 C++ .node 模块已自动解除压缩锁定)。');
  } catch (e) {
    try {
      execSync(`${getAsarCmd()} pack "${EXTRACT_DIR}" "${tempAsar}"`, { cwd: WORKSPACE_DIR });
      log('打包成功。');
    } catch (err) {
      throw new Error('打包新 asar 失败: ' + e.message);
    }
  }

  // 7. Deploy newly packed app.asar AND app.asar.unpacked (if present)
  log('正在部署新的汉化 app.asar...');
  safeCopyFile(tempAsar, asarPath);

  const tempUnpacked = path.join(WORKSPACE_DIR, 'app.asar.unpacked');
  const targetUnpacked = path.join(resourcesDir, 'app.asar.unpacked');
  if (fs.existsSync(tempUnpacked)) {
    log('正在部署原生的 app.asar.unpacked 依赖库...');
    try {
      if (process.platform === 'win32') {
        const psScript = `takeown /F ''${targetUnpacked}'' /A /R /D Y; icacls ''${targetUnpacked}'' /grant Administrators:F /T /C; Copy-Item -LiteralPath ''${tempUnpacked}'' -Destination ''${targetUnpacked}'' -Recurse -Force`;
        execSync(`powershell -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-Command ${psScript}'"`, { stdio: 'ignore' });
      } else {
        execSync(`cp -R "${tempUnpacked}" "${targetUnpacked}"`, { stdio: 'ignore' });
      }
    } catch(e){}
    try {
      if (typeof fs.rmSync === 'function') {
        fs.rmSync(tempUnpacked, { recursive: true, force: true });
      }
    } catch(e){}
  }

  if (fs.existsSync(tempAsar)) {
    try { fs.unlinkSync(tempAsar); } catch(e) {}
  }
  log('汉化 app.asar 部署成功！');

  const appIntent2 = identifyAppIntent(appDir);
  const targetAppName = (appIntent2 && appIntent2.name && appIntent2.matched) ? appIntent2.name : 'AI 客户端';

  log(`🎉 ${targetAppName} 一键汉化成功完成！现在您可以安全启动程序了。`);
  log('=================== 汉化流程结束 ===================');
}

// Restore workflow
function runRestoreWorkflow(appDir) {
  const resourcesDir = getResourcesDir(appDir);
  const asarPath = path.join(resourcesDir, 'app.asar');
  const backupPath = path.join(resourcesDir, 'app.asar.bak');

  logs = [];
  log('=================== 开始还原流程 ===================');
  log(`目标程序目录: ${appDir}`);
  if (!fs.existsSync(backupPath)) {
    throw new Error('未找到备份文件 `app.asar.bak`。无法执行恢复！');
  }

  killApp(appDir);

  log('正在从备份恢复原始 app.asar...');
  try {
    fs.copyFileSync(backupPath, asarPath);
    log('还原原始 app.asar 成功！软件已恢复为纯英文版。');
  } catch (e) {
    if (process.platform === 'win32') {
      try {
        const psCmd = `powershell -Command "Start-Process powershell -Verb RunAs -ArgumentList '-Command Copy-Item -LiteralPath ''${backupPath}'' -Destination ''${asarPath}'' -Force'"`;
        execSync(psCmd, { stdio: 'ignore' });
        log('已通过管理员特权还原原始 app.asar。');
        return;
      } catch (err) {}
    }
    throw new Error('恢复文件失败 (EPERM 权限拒绝): 请以管理员身份运行脚本！\n详细信息: ' + e.message);
  }
  log('=================== 还原流程结束 ===================');
}

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API routing
  if (req.url.startsWith('/api/status') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const username = urlObj.searchParams.get('username') || '';
    const useDefault = urlObj.searchParams.get('useDefault') !== 'false';
    const customPath = urlObj.searchParams.get('customPath') || '';

    const appDir = getAppDir(username, useDefault, customPath);
    const resourcesDir = getResourcesDir(appDir);
    const asarPath = path.join(resourcesDir, 'app.asar');
    const backupPath = path.join(resourcesDir, 'app.asar.bak');

    const isInstalled = fs.existsSync(asarPath);
    const hasBackup = fs.existsSync(backupPath);
    const isRunning = isAppRunning();
    const intent = identifyAppIntent(appDir);
    const installedApps = detectInstalledApps();
    
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      isInstalled,
      hasBackup,
      isRunning,
      asarPath,
      backupPath,
      platform: process.platform,
      defaultUsername: getHostUsername(),
      intent,
      installedApps
    }));
  } 
  else if (req.url.startsWith('/api/detect') && req.method === 'GET') {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const customPath = urlObj.searchParams.get('customPath') || '';
    const username = urlObj.searchParams.get('username') || '';
    const useDefault = urlObj.searchParams.get('useDefault') !== 'false';

    const appDir = getAppDir(username, useDefault, customPath);
    const intent = identifyAppIntent(appDir);
    const installedApps = detectInstalledApps();

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      intent,
      installedApps,
      appDir
    }));
  }
  else if (req.url === '/api/localize' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const appDir = getAppDir(data.username, data.useDefault, data.customPath);

        await runLocalizationWorkflow(appDir);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, logs }));
      } catch (e) {
        log('❌ 汉化出错: ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: e.message, logs }));
      }
    });
  }
  else if (req.url === '/api/restore' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const appDir = getAppDir(data.username, data.useDefault, data.customPath);

        runRestoreWorkflow(appDir);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, logs }));
      } catch (e) {
        log('❌ 还原出错: ' + e.message);
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: e.message, logs }));
      }
    });
  }
  else if (req.url === '/api/launch' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const appDir = getAppDir(data.username, data.useDefault, data.customPath);
        const intent = identifyAppIntent(appDir);

        if (intent.id === 'codex') {
          const codexExes = ['ChatGPT.exe', 'chatgpt.exe', 'Codex.exe', 'codex.exe'];
          let launched = false;
          for (const exeName of codexExes) {
            const appPath = path.join(appDir, exeName);
            if (fs.existsSync(appPath)) {
              spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
              log(`已成功启动程序 (路径: ${appPath})...`);
              launched = true;
              break;
            }
          }
          if (!launched) {
            log(`尝试从常用安装目录拉起程序...`);
            spawn('cmd.exe', ['/c', 'start', '""', appDir], { detached: true, stdio: 'ignore' }).unref();
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: true, logs }));
        } else {
          const exeName = process.platform === 'win32' ? 'Antigravity.exe' : 'antigravity';
          const appPath = path.join(appDir, exeName);
          log(`正在尝试启动程序 (路径: ${appPath})...`);
          if (fs.existsSync(appPath)) {
            spawn(appPath, [], { detached: true, stdio: 'ignore' }).unref();
            log('启动指令已发送。');
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, logs }));
          } else {
            spawn('cmd.exe', ['/c', 'start', '""', appDir], { detached: true, stdio: 'ignore' }).unref();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, logs }));
          }
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: '请求解析失败: ' + e.message, logs }));
      }
    });
  }
  else if (req.url === '/api/logs' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ logs }));
  }
  // Serve the dashboard
  else if (req.url === '/' || req.url === '/index.html') {
    const indexPath = path.join(WORKSPACE_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(indexPath));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found.');
    }
  } 
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

if (require.main === module) {
  if (process.argv.includes('--now')) {
    const defaultAppDir = getAppDir(getHostUsername(), true, '');
    runLocalizationWorkflow(defaultAppDir)
      .then(() => {
        console.log('🎉 汉化打包部署成功！');
        process.exit(0);
      })
      .catch((err) => {
        console.error('❌ 汉化出错:', err.message);
        process.exit(1);
      });
  } else {
    server.listen(PORT, () => {
      console.log(`\n======================================================`);
      console.log(` Universal AI Client Localizer 服务已在后台运行！`);
      console.log(` 本地管理面板: http://localhost:${PORT}`);
      console.log(`======================================================\n`);
    });
  }
}

module.exports = {
  detectInstalledApps,
  identifyAppIntent,
  getResourcesDir,
  SUPPORTED_APPS,
  runLocalizationWorkflow
};
