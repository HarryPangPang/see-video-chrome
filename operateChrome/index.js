
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { USER_DATA_DIR, CHROME_PATH } = require('../constant');

let browser;
let browserContext; // 存储持久化上下文实例
let tasks = 0; // 存储任务数量

// setInterval(() => {
//   if(tasks === 0 && browserContext){
//     browserContext.close()
//     browserContext = null
//   }
// }, 1000 * 60 * 5)


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
  console.log('Browser ready');

  const page = await browserContext.newPage();
  console.log('page open');
  return page;
}

// 模式选择器：即梦 AI 页面上的 lv-select 下拉（Agent 模式 / 视频生成 等）
const MODE_SELECT_VALUE = '.lv-select-view-value';
const MODE_SELECT_TRIGGER = '.lv-select-view'; // 点击打开下拉
const TARGET_MODE = '视频生成';

const setOptions = async (page) => {
  // 先判断当前是否为「视频生成」，不是则点击下拉并选择「视频生成」
  const valueEl = page.locator(MODE_SELECT_VALUE).first();
  await valueEl.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);

  const currentText = (await valueEl.innerText()).trim();
  if (currentText === TARGET_MODE) {
    console.log('[setOptions] 当前已是视频生成，无需切换');
    return;
  } else {
    console.log(`[setOptions] 当前模式: "${currentText}"，切换到: ${TARGET_MODE}`);
    await page.locator(MODE_SELECT_TRIGGER).first().click();
    await page.waitForTimeout(400); // 等待下拉展开

    // 视频生成选项：下拉在 body/div[5] 下，第 3 个 li（用 li 点击更稳）
    const optionXpath = 'xpath=/html/body/div[5]/span/div/div[2]/div/div/li[3]';
    const option = page.locator(optionXpath);
    await option.waitFor({ state: 'visible', timeout: 5000 });
    await option.click({ force: true });
    await page.waitForTimeout(300);
    console.log('[setOptions] 已选择视频生成');    
  }
  // 根据model选择模型 

  // 选择收尾帧

  // 选择比例

  // 选择时长

 
}


module.exports = {
  initBrowserPage: initBrowserPage,
  setOptions: setOptions,

}