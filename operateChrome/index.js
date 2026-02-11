
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { USER_DATA_DIR, CHROME_PATH, AI_STUDIO_URL, AI_STUDIO_HOME_URL } = require('../constant');

let browser;
let browserContext; // 存储持久化上下文实例
let tasks = 0; // 存储任务数量

// setInterval(() => {
//   if(tasks === 0 && browserContext){
//     browserContext.close()
//     browserContext = null
//   }
// }, 1000 * 60 * 5)

const initializeBrowser = async () => { }

/**
 * 创建错误监控器
 * @param {Page} page - Playwright 页面对象
 * @param {number} interval - 监控间隔（毫秒），默认500ms
 * @returns {Object} 包含 check, startMonitoring, stopMonitoring 方法的对象
 */
const createErrorMonitor = (page, interval = 500) => {
  const errorSelector = '.error-container';
  let errorMonitorInterval = null;
  let errorDetected = false;

  // 检查是否出现错误
  const check = async () => {
    if (errorDetected) return; // 避免重复检测

    try {
      const errorContainer = page.locator(errorSelector).first();
      if (await errorContainer.isVisible()) {
        errorDetected = true;
        // 尝试获取错误文本
        const errorTitle = page.locator('.error-title').first();
        let errorText = 'An internal error occurred.';

        if (await errorTitle.isVisible()) {
          const text = (await errorTitle.innerText()).trim();
          if (text) errorText = text;
        }

        // 停止监控
        stopMonitoring();

        throw new Error(`AI Studio Error: ${errorText}`);
      }
    } catch (err) {
      // 如果是我们抛出的错误，继续抛出
      if (err instanceof Error && err.message.startsWith('AI Studio Error:')) {
        throw err;
      }
      // 其他错误（如元素不存在）忽略
    }
  };

  // 启动持续错误监控
  const startMonitoring = () => {
    if (errorMonitorInterval) return;
    console.log(`[ErrorMonitor] 启动错误监控，间隔 ${interval}ms`);
    errorMonitorInterval = setInterval(async () => {
      try {
        await check();
      } catch (err) {
        // 错误会在主流程中被捕获
        stopMonitoring();
      }
    }, interval);
  };

  // 停止错误监控
  const stopMonitoring = () => {
    if (errorMonitorInterval) {
      clearInterval(errorMonitorInterval);
      errorMonitorInterval = null;
      console.log('[ErrorMonitor] 已停止错误监控');
    }
  };

  return {
    check,
    startMonitoring,
    stopMonitoring
  };
};

const initBrowserPage = async () => {
  // 如果浏览器上下文已经存在，直接返回一个新的页面
  if (browserContext) {
    console.log('Context already exists, creating a new page...');
    const page = await browserContext.newPage();
    return page;
  }
  // 第一次运行时，启动持久化上下文
  console.log('Launching NEW persistent browser context...');
  browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, // Google 登录必须 false
    executablePath: CHROME_PATH,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--start-maximized' // 可选：最大化窗口
    ],
    viewport: null // 禁用默认 viewport，使用最大化窗口
  });
  console.log('Persistent Browser ready');

  const page = await browserContext.newPage();
  console.log('page open');
  return page;
}



module.exports = {
  initBrowserPage: initBrowserPage,

  initializeBrowser: initializeBrowser,

}