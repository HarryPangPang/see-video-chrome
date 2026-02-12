
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { USER_DATA_DIR, CHROME_PATH } = require('../constant');

let browser;
let browserContext; // 存储持久化上下文实例
let tasks = 0; // 存储任务数量

const ModelMap = {
  'seedance20': 'Seedance 2.0',
  '35pro': '视频 3.5 Pro',
  '30pro': '视频 3.0 Pro',
  '30fast': '视频 3.0 Fast',
  '30': '视频 3.0',
}
const ModelPosition = {
  'seedance20': 1,
  '35pro': 2,
  '30pro': 3,
  '30fast': 4,
  '30': 5,
}
const durationMap = {
  '4s': 4,
  '5s': 5,
  '6s': 6,
  '7s': 7,
  '8s': 8,
  '9s': 9,
  '10s': 10,
  '11s': 11,
  '12s': 12,
  '13s': 13,
  '14s': 14,
  '15s': 15,
}
const durationPosition = {
  '4s': 1,
  '5s': 2,
  '6s': 3,
  '7s': 4,
  '8s': 5,
  '9s': 6,
  '10s': 7,
  '11s': 8,
  '12s': 9,
  '13s': 10,
  '14s': 11,
  '15s': 12,
}

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
const TARGET_MODE = '视频生成';

// 当前模型文案所在节点（工具栏设置区第 2 个子块，用于判断是否需切换）
const MODEL_CURRENT_SELECTOR = '#dreamina-ui-configuration-content-wrapper .toolbar-settings-YNMCja > div > div:nth-child(2)';
// 时长所在节点（工具栏设置区第 5 个子块，用于读当前值并点击打开下拉）
const DURATION_CURRENT_SELECTOR = '#dreamina-ui-configuration-content-wrapper .toolbar-settings-YNMCja > div > div:nth-child(5)';

const formatDuration = (v) => (v == null ? '' : String(v).endsWith('s') ? String(v) : `${v}s`);

const setOptions = async (page, options = {}) => {
  const { model, duration } = options;
  const durationStr = formatDuration(duration);

  // 1. 模式：先判断是否为「视频生成」，不是则点击并选择
  const valueEl = page.locator('.lv-select-view-value').first();
  await valueEl.waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
  const currentText = (await valueEl.innerText()).trim();
  if (currentText === TARGET_MODE) {
    console.log('[setOptions] 当前已是视频生成，无需切换');
  } else {
    console.log(`[setOptions] 当前模式: "${currentText}"，切换到: ${TARGET_MODE}`);
    await page.locator('.lv-select-view').first().click();
    await page.waitForTimeout(800);
    const optionXpath = 'xpath=/html/body/div[5]/span/div/div[2]/div/div/li[3]';
    const option = page.locator(optionXpath);
    await option.waitFor({ state: 'visible', timeout: 30000 });
    await option.click({ force: true });
    await page.waitForTimeout(500);
    console.log('[setOptions] 已选择视频生成');
  }

  // 2. 模型：从工具栏设置区获取当前模型文案，不一致则点触发器→等弹窗→点非禁用的对应选项
  if (model) {
    const currentModelEl = page.locator(MODEL_CURRENT_SELECTOR).first();
    const currentModel = await currentModelEl.innerText().then(t => t.trim()).catch(() => '');
    const modelPos = ModelPosition[model];
    const modelText = ModelMap[model]; // 接口传的即为展示名，如 视频 3.0、Seedance 2.0
    console.log('[setOptions] 当前模型:', currentModel, '要选择:', modelText);
    if (currentModel !== modelText) {
      await currentModelEl.click();
      await page.waitForTimeout(800);
      // 等待任意可见的 lv-select 弹窗（不依赖动态 ID 如 #lv-select-popup-12）
      const popup = page.locator('[class*="lv-select-popup"], .lv-select-popup').filter({ has: page.locator('li') }).first();
      await popup.waitFor({ state: 'visible', timeout: 15000 });
      if (modelPos != null && modelPos >= 1) {
        const option = popup.locator('div > div > li').nth(modelPos - 1);
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click({ force: true });
        await page.waitForTimeout(500);
      }
      console.log('[setOptions] 已选择模型:', modelText);
    } else {
      console.log('[setOptions] 当前已是模型:', modelText);
    }
  }

  // 3. 时长：从工具栏设置区第 5 个子块取当前时长，不一致则点击该块→等弹窗→按文案点 li
  if (durationStr) {
    const durationEl = page.locator(DURATION_CURRENT_SELECTOR).first();
    let currentDuration = '';
    try {
      currentDuration = (await durationEl.locator('.lv-select-view-value').first().innerText()).trim();
    } catch {
      try {
        currentDuration = (await durationEl.locator('span').last().innerText()).trim();
      } catch {
        currentDuration = (await durationEl.innerText()).trim();
      }
    }
    console.log('[setOptions] 当前时长:', currentDuration, '要选择:', durationStr);
    if (currentDuration !== durationStr) {
      const durationPos = durationPosition[durationStr];
      await durationEl.click();
      await page.waitForTimeout(800);
      const durationPopup = page.locator('[class*="lv-select-popup"], .lv-select-popup').filter({ has: page.locator('li') }).first();
      await durationPopup.waitFor({ state: 'visible', timeout: 15000 });
      if (durationPos != null && durationPos >= 1) {
        const option = durationPopup.locator('div > div > li').nth(durationPos - 1);
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click({ force: true });
        await page.waitForTimeout(500);
      }
      console.log('[setOptions] 已选择时长:', durationStr);
    } else {
      console.log('[setOptions] 当前已是时长:', durationStr);
    }
  }
}


module.exports = {
  initBrowserPage: initBrowserPage,
  setOptions: setOptions,

}