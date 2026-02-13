
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const { spawn } = require('child_process');
const { USER_DATA_DIR, CHROME_PATH, SERVER_URL } = require('../constant');

let browser;
let browserContext; // 存储持久化上下文实例
let tasks = 0; // 存储任务数量

const ModelMap = {
  'seedance20': 'Seedance 2.0',
  'seedance20fast': 'Seedance 2.0 Fast',
  '35pro': '视频 3.5 Pro',
  '30pro': '视频 3.0 Pro',
  '30fast': '视频 3.0 Fast',
  '30': '视频 3.0',
}
const ModelPosition = {
  'seedance20fast': 1,
  'seedance20': 2,
  '35pro': 3,
  '30pro': 4,
  '30fast': 5,
  '30': 6,
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
const frameModeMap = {
  'startEnd': '首尾帧',
  'omni': '全能参考',
}
const frameModePosition = {
  'startEnd': 2,
  'omni': 1,
}
// setInterval(() => {
//   if(tasks === 0 && browserContext){
//     browserContext.close()
//     browserContext = null
//   }
// }, 1000 * 60 * 5)



/**
 * 创建 Toast 错误监控器（用于监控上传图片时的错误提示）
 * @param {Page} page - Playwright 页面对象
 * @param {number} interval - 监控间隔（毫秒），默认300ms
 * @returns {Object} 包含 check, startMonitoring, stopMonitoring, hasError, getError, reset 方法的对象
 */
const createToastErrorMonitor = (page, interval = 300) => {
  // Toast 错误消息的选择器
  const toastMessageSelector = '.lv-message-content';
  let errorMonitorInterval = null;
  let detectedError = null; // 存储检测到的错误信息
  let lastToastCount = 0; // 记录上次检测到的 toast 数量

  // 检查是否出现 Toast 错误
  const check = async () => {
    if (detectedError) return; // 避免重复检测

    try {
      // 查找所有 toast 消息
      const toastMessages = page.locator(toastMessageSelector);
      const count = await toastMessages.count();

      // 只检测新出现的 toast（数量增加了）
      if (count > lastToastCount) {
        // 检查最后一个 toast 消息
        const lastToast = toastMessages.last();
        if (await lastToast.isVisible()) {
          const errorText = (await lastToast.innerText()).trim();

          // 只有当存在错误信息时才记录错误
          if (errorText) {
            detectedError = `图片上传错误: ${errorText}`;
            console.log('[ToastErrorMonitor] 检测到错误提示:', errorText);
            // 停止监控
            stopMonitoring();
          }
        }
      }

      lastToastCount = count;
    } catch (err) {
      // 忽略检测过程中的异常（如元素不存在）
      // 这些异常不应该中断监控流程
    }
  };

  // 启动持续错误监控
  const startMonitoring = () => {
    if (errorMonitorInterval) return;
    console.log(`[ToastErrorMonitor] 启动 Toast 错误监控，间隔 ${interval}ms`);

    // 记录当前 toast 数量作为基线
    page.locator(toastMessageSelector).count().then(count => {
      lastToastCount = count;
    }).catch(() => {
      lastToastCount = 0;
    });

    errorMonitorInterval = setInterval(async () => {
      await check();
    }, interval);
  };

  // 停止错误监控
  const stopMonitoring = () => {
    if (errorMonitorInterval) {
      clearInterval(errorMonitorInterval);
      errorMonitorInterval = null;
      console.log('[ToastErrorMonitor] 已停止 Toast 错误监控');
    }
  };

  // 重置监控器状态
  const reset = () => {
    stopMonitoring();
    detectedError = null;
    lastToastCount = 0;
    console.log('[ToastErrorMonitor] 已重置监控器状态');
  };

  // 检查是否检测到错误
  const hasError = () => {
    return detectedError !== null;
  };

  // 获取错误信息（如果有的话会抛出异常）
  const getError = () => {
    if (detectedError) {
      throw new Error(detectedError);
    }
  };

  // 获取错误信息（不抛出异常）
  const getErrorMessage = () => {
    return detectedError;
  };

  return {
    check,
    startMonitoring,
    stopMonitoring,
    reset,
    hasError,
    getError,
    getErrorMessage
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
// 参考模式选择器（全能参考 / 首尾帧）
const FRAME_MODE_SELECTOR = '#dreamina-ui-configuration-content-wrapper .toolbar-settings-YNMCja > div > div.feature-select-VcsuXi > div > div';
// 即梦配置区内的提示词输入框（主内容区 textarea）
const PROMPT_TEXTAREA_SELECTOR = '#dreamina-ui-configuration-content-wrapper .main-content-pao8ef textarea';
// 首帧上传区域（references 下第 1 个 reference group）
const START_FRAME_CONTAINER = '#dreamina-ui-configuration-content-wrapper .references-vWIzeo > div:nth-child(1)';
// 尾帧上传区域（references 下 last-frame）
const END_FRAME_CONTAINER = '#dreamina-ui-configuration-content-wrapper .references-vWIzeo .last-frame-JCr045';
// 全能参考模式上传区域（支持一次选择多个文件）
const OMNI_FRAME_CONTAINER = '#dreamina-ui-configuration-content-wrapper .references-vWIzeo > div > div.reference-group-content-ztz9q2 > div > div';
// 工具栏「生成」按钮（toolbar-actions 下第 2 个 button）
const GENERATE_BUTTON_SELECTOR = '#dreamina-ui-configuration-content-wrapper .toolbar-actions-DsJHmQ > div:nth-child(2) > button';

const formatDuration = (v) => (v == null ? '' : String(v).endsWith('s') ? String(v) : `${v}s`);

const setOptions = async (page, options = {}) => {
  const { model, duration, prompt, startFrameUrl, endFrameUrl, startFramePath, endFramePath, frameMode, omniFrameUrls, omniFramePaths } = options;
  const durationStr = formatDuration(duration);

  // 如果出现 modal，就点击确认按钮
  try {
    const modalWrapper = page.locator('.lv-modal-wrapper').first();
    // 等待 modal 出现
    const isModalVisible = await modalWrapper.isVisible().catch(() => false);
    if (isModalVisible) {
      console.log('[setOptions] 检测到 modal 弹窗，尝试点击确认按钮');
      // 等待 modal 内容加载完成
      await page.waitForTimeout(300);

      // 尝试多种选择器来找到确认按钮
      const confirmButton = modalWrapper.locator('.lv-modal-content .lv-btn-primary').first();

      // 等待按钮出现并可交互
      await confirmButton.waitFor({ state: 'visible', timeout: 3000 }).catch(() => null);

      if (await confirmButton.isVisible().catch(() => false)) {
        await confirmButton.click({ force: true });
        await page.waitForTimeout(800);
        console.log('[setOptions] 已点击 modal 确认按钮');
      } else {
        console.warn('[setOptions] modal 按钮不可见');
      }
    }
  } catch (err) {
    console.warn('[setOptions] 检测/点击 modal 按钮失败:', err.message);
  }

  // 1. 模式：先判断是否为「视频生成」，不是则点击并选择
  const valueEl = page.locator('.lv-select-view-value').first();
  await valueEl.waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
  const currentText = (await valueEl.innerText()).trim();
  if (currentText === TARGET_MODE) {
    console.log('[setOptions] 当前已是视频生成，无需切换');
  } else {
    console.log(`[setOptions] 当前模式: "${currentText}"，切换到: ${TARGET_MODE}`);
    await page.locator('.lv-select-view').first().click();
    await page.waitForTimeout(500);
     const popup = page.locator('[class*="lv-select-popup"], .lv-select-popup').filter({ has: page.locator('li') }).first();
     await popup.waitFor({ state: 'visible', timeout: 15000 });

     const option = popup.locator('div > div > li').nth(2);
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click({ force: true });
        await page.waitForTimeout(500);


    // const optionSelector = '#lv-select-popup-1 > div > div > li:nth-child(3)';
    // const option = page.locator(optionSelector);
    // await option.waitFor({ state: 'visible', timeout: 30000 });
    // await option.click({ force: true });
    // await page.waitForTimeout(500);
    console.log('[setOptions] 已选择视频生成');
  }
  // 5. 首帧/尾帧/全能参考：用地址（优先本地 path，否则用 URL 下载到临时文件后上传，不重复存）
  if (startFramePath || endFramePath || startFrameUrl || endFrameUrl || omniFramePaths || omniFrameUrls) {
    const imagesResult = await setImages(page, {
      frameMode,
      startFrameUrl,
      endFrameUrl,
      startFramePath,
      endFramePath,
      omniFrameUrls,
      omniFramePaths
    });
    // 如果图片上传失败，返回错误结果
    if (!imagesResult.success) {
      return { success: false, error: imagesResult.error };
    }
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
  // 3.5. 参考模式：从工具栏设置区获取当前参考模式，不一致则点击→等弹窗→按位置点 li
  if (frameMode) {
    const frameModeEl = page.locator(FRAME_MODE_SELECTOR).first();
    let currentFrameMode = '';
    try {
      // 尝试获取当前参考模式文本
      currentFrameMode = (await frameModeEl.innerText()).trim();
    } catch {
      currentFrameMode = '';
    }
    const frameModeText = frameModeMap[frameMode]; // 如 '全能参考' 或 '首尾帧'
    const frameModePos = frameModePosition[frameMode]; // 1 或 2
    console.log('[setOptions] 当前参考模式:', currentFrameMode, '要选择:', frameModeText);

    if (currentFrameMode !== frameModeText) {
      await frameModeEl.click();
      await page.waitForTimeout(800);
      // 等待任意可见的 lv-select 弹窗（弹层都一样）
      const frameModePopup = page.locator('[class*="lv-select-popup"], .lv-select-popup').filter({ has: page.locator('li') }).first();
      await frameModePopup.waitFor({ state: 'visible', timeout: 15000 });

      if (frameModePos != null && frameModePos >= 1) {
        const option = frameModePopup.locator('div > div > li').nth(frameModePos - 1);
        await option.waitFor({ state: 'visible', timeout: 5000 });
        await option.click({ force: true });
        await page.waitForTimeout(500); // 等待页面重新渲染
      }
      console.log('[setOptions] 已选择参考模式:', frameModeText);
    } else {
      console.log('[setOptions] 当前已是参考模式:', frameModeText);
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

  // 4. 提示词：填入配置区主内容 textarea（上传过来的 prompt）
  if (prompt != null && String(prompt).trim()) {
    if(frameMode === 'omni'){
          await setOmniPrompt(page, String(prompt).trim());
    }
    else{
          await setPrompt(page, String(prompt).trim());

    }
  }


  // 6. 等 200ms 后点击「生成」按钮，并监听生成接口响应以拿到 generate_id（见 jimeng.md 生成接口 / 生成结果返回）
  await page.waitForTimeout(200);
  const generateBtn = page.locator(GENERATE_BUTTON_SELECTOR).first();
  await generateBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => null);

  let generateId = null;
  const isGenerateApi = (res) => {
    const u = res.url();
    return u.includes('aigc_draft/generate') && res.request().method() === 'POST';
  };
  const responsePromise = page.waitForResponse(isGenerateApi, { timeout: 30000 }).catch(() => null);

  if (await generateBtn.isVisible()) {
    await generateBtn.click();
    console.log('[setOptions] 已点击生成按钮');
  }

  const response = await responsePromise;
  if (response && response.ok()) {
    try {
      const json = await response.json();
      generateId = json?.data?.aigc_data?.generate_id || null;
      if (generateId) console.log('[setOptions] 生成接口返回 generate_id:', generateId);
    } catch (e) {
      console.warn('[setOptions] 解析生成接口响应失败', e.message);
    }
  }

  return { success: true, generateId };
}
const setOmniPrompt = async (page, prompt) => {
  console.log('[setOmniPrompt] 开始填写全能参考提示词，长度:', prompt.length);

  // 等待页面稳定
  await page.waitForTimeout(1000);

  // 富文本编辑器选择器（简化版，使用类选择器）
  const editorSelector = '#dreamina-ui-configuration-content-wrapper .prompt-editor-E3Iuyy > div';

  // 尝试多次，因为可能处于过渡状态
  let success = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      console.log(`[setOmniPrompt] 尝试 ${attempt + 1}/5`);

      const editor = page.locator(editorSelector).first();

      // 等待编辑器元素存在
      await editor.waitFor({ state: 'attached', timeout: 5000 });

      // 点击聚焦
      await editor.click({ force: true, timeout: 3000 });
      console.log('[setOmniPrompt] 已点击编辑器聚焦');
      await page.waitForTimeout(300);

      // 清空内容（Ctrl/Cmd+A 然后 Delete）
      await page.keyboard.press('ControlOrMeta+A');
      await page.waitForTimeout(100);
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(200);

      // 输入新内容
      await page.keyboard.type(prompt, { delay: 10 });
      console.log('[setOmniPrompt] 已输入文字');
      await page.waitForTimeout(300);

      // 验证内容是否输入成功
      const content = await editor.innerText().catch(() => '');
      console.log(`[setOmniPrompt] 当前内容长度: ${content.length}, 期望长度: ${prompt.length}`);

      if (content.trim().length > 0) {
        console.log('[setOmniPrompt] 成功填入提示词');
        success = true;
        break;
      } else {
        console.log('[setOmniPrompt] 内容验证失败，重试');
      }
    } catch (e) {
      console.log(`[setOmniPrompt] 尝试 ${attempt + 1}/5 失败:`, e.message);
      if (attempt < 4) {
        await page.waitForTimeout(1500);
      }
    }
  }

  if (!success) {
    throw new Error('[setOmniPrompt] 多次尝试后仍无法填入提示词');
  }
} 
const setPrompt = async (page, prompt) => {
  const textarea = page.locator(PROMPT_TEXTAREA_SELECTOR).first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await textarea.fill('');
  await textarea.fill(prompt);
  console.log('[setPrompt] 已填入提示词，长度:', prompt.length);
}
/**
 * 根据传过来的图片地址在即梦页面上选择首帧/尾帧/全能参考。
 * 优先用本地 path（同机时服务端已存 .tmp/projectId），否则用 URL 下载到临时文件后 setInputFiles，用完即删，不重复存。
 * @returns {Promise<{success: boolean, error?: string}>} 返回操作结果
 */
const setImages = async (page, { frameMode, startFrameUrl, endFrameUrl, startFramePath, endFramePath, omniFrameUrls, omniFramePaths } = {}) => {
  // 创建 Toast 错误监控器
  const toastMonitor = createToastErrorMonitor(page, 300);

  const resolveLocalOrFetch = async (pathOrUrl, label) => {
    if (pathOrUrl && fs.existsSync(pathOrUrl)) return pathOrUrl;
    if (!pathOrUrl) return null;
    // 如果不是完整的 URL，拼接上 SERVER_URL
    let fullUrl = pathOrUrl;
    if (!pathOrUrl.startsWith('http')) {
      if (pathOrUrl.startsWith('/')) {
        fullUrl = `${SERVER_URL}${pathOrUrl}`;
      } else {
        return null;
      }
    }
    try {
      const res = await fetch(fullUrl);
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = (pathOrUrl.match(/\.(png|jpe?g|webp)/i) || [null, 'png'])[1];
      const tmpPath = path.join(os.tmpdir(), `jimeng-${label}-${Date.now()}.${ext}`);
      fs.writeFileSync(tmpPath, buf);
      return tmpPath;
    } catch (e) {
      console.warn('[setImages] 下载失败:', fullUrl, e.message);
      return null;
    }
  };

  const setFileInContainer = async (containerSelector, filePath, isTemp, frameType) => {
    if (!filePath) return { success: true };
    const container = page.locator(containerSelector).first();
    await container.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
    if (!(await container.isVisible())) return { success: true };
    let input = container.locator('input[type="file"]').first();
    if ((await input.count()) === 0) {
      const uploadArea = container.locator('[class*="upload"], [class*="drop"], [class*="reference"]').first();
      await uploadArea.click().catch(() => null);
      await page.waitForTimeout(500);
    }
    input = container.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 5000 }).catch(() => null);
    if ((await input.count()) > 0) {
      // 重置并启动 Toast 错误监控
      toastMonitor.reset();
      toastMonitor.startMonitoring();

      await input.setInputFiles(filePath);
      console.log(`[setImages] 已选择${frameType}:`, filePath);

      // 等待一段时间，让页面有时间显示错误 toast
      await page.waitForTimeout(1500);

      // 停止监控
      toastMonitor.stopMonitoring();

      // 检查是否有错误，如果有则返回错误
      if (toastMonitor.hasError()) {
        const errorMsg = toastMonitor.getErrorMessage();
        return { success: false, error: errorMsg };
      }
    }
    if (isTemp && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    return { success: true };
  };

  try {
    // 处理 omni 模式（全能参考模式，支持一次选择多张图片）
    // 注：omniFrameUrls 只用于 API 响应，上传时直接使用 omniFramePaths（本地路径）
    if (frameMode === 'omni' && omniFramePaths && Array.isArray(omniFramePaths) && omniFramePaths.length > 0) {
      console.log(`[setImages] Omni 模式：一次上传 ${omniFramePaths.length} 张图片`);

      // 找到 omni 上传容器
      const container = page.locator(OMNI_FRAME_CONTAINER).first();
      await container.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);

      if (!(await container.isVisible())) {
        console.warn('[setImages] Omni 容器不可见');
        return { success: false, error: '全能参考上传区域不可见' };
      }

      // 查找文件输入框
      let input = container.locator('input[type="file"]').first();
      if ((await input.count()) === 0) {
        // 如果找不到输入框，尝试点击上传区域触发
        const uploadArea = container.locator('[class*="upload"], [class*="drop"], [class*="reference"]').first();
        await uploadArea.click().catch(() => null);
        await page.waitForTimeout(500);
      }

      input = container.locator('input[type="file"]').first();
      await input.waitFor({ state: 'attached', timeout: 5000 }).catch(() => null);

      if ((await input.count()) > 0) {
        // 重置并启动 Toast 错误监控
        toastMonitor.reset();
        toastMonitor.startMonitoring();

        // 一次性上传所有图片文件
        await input.setInputFiles(omniFramePaths);
        console.log(`[setImages] 已选择全能参考图片: ${omniFramePaths.length} 张`);

        // 等待更长时间，因为要处理多张图片
        await page.waitForTimeout(2000);

        // 停止监控
        toastMonitor.stopMonitoring();

        // 检查是否有错误
        if (toastMonitor.hasError()) {
          const errorMsg = toastMonitor.getErrorMessage();
          return { success: false, error: errorMsg };
        }

        return { success: true };
      } else {
        return { success: false, error: '未找到 Omni 模式的文件上传输入框' };
      }
    }

    // 处理 startEnd 模式（首帧和尾帧）
    const startPath = startFramePath && fs.existsSync(startFramePath)
      ? startFramePath
      : await resolveLocalOrFetch(startFrameUrl, 'start');
    const endPath = endFramePath && fs.existsSync(endFramePath)
      ? endFramePath
      : await resolveLocalOrFetch(endFrameUrl, 'end');

    const startResult = await setFileInContainer(START_FRAME_CONTAINER, startPath, !!startFrameUrl && !startFramePath, '首帧');
    if (!startResult.success) {
      toastMonitor.stopMonitoring();
      return startResult; // 返回错误结果
    }

    const endResult = await setFileInContainer(END_FRAME_CONTAINER, endPath, !!endFrameUrl && !endFramePath, '尾帧');
    if (!endResult.success) {
      toastMonitor.stopMonitoring();
      return endResult; // 返回错误结果
    }

    return { success: true };
  } catch (err) {
    // 确保停止监控
    toastMonitor.stopMonitoring();
    // 系统错误仍然抛出
    throw err;
  }
}

/**
 * 获取即梦视频列表
 * @param {Page} page - Playwright 页面对象
 * @param {Object} options - 可选参数
 * @param {number} options.count - 获取数量，默认 20
 * @param {number} options.endTimeStamp - 结束时间戳，默认 0
 * @returns {Promise<Object|null>} 返回视频列表数据或 null
 */
const getVideoList = async (page, options = {}) => {
  const { count = 200, endTimeStamp = 0 } = options;

  const requestBody = {
    count,
    direction: 1,
    mode: 'workbench',
    option: {
      image_info: {
        width: 2048,
        height: 2048,
        format: 'webp',
        image_scene_list: [
          { scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' },
          { scene: 'loss', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' },
          { scene: 'loss', width: 720, height: 720, uniq_key: '720', format: 'webp' },
          { scene: 'loss', width: 480, height: 480, uniq_key: '480', format: 'webp' }
        ]
      },
      origin_image_info: {
        width: 96,
        height: 2048,
        format: 'webp',
        image_scene_list: [
          { scene: 'normal', width: 2400, height: 2400, uniq_key: '2400', format: 'webp' },
          { scene: 'loss', width: 1080, height: 1080, uniq_key: '1080', format: 'webp' }
        ]
      },
      order_by: 0,
      only_favorited: false,
      end_time_stamp: endTimeStamp,
      hide_story_agent_result: true
    },
    asset_type_list: [1, 2, 5, 6, 7, 8, 9, 10]
  };

  try {
    console.log('[getVideoList] 开始请求视频列表...');
    const response = await page.request.post(
      'https://jimeng.jianying.com/mweb/v1/get_asset_list?aid=513695&web_version=7.5.0&da_version=3.3.9&aigc_features=app_lip_sync',
      {
        headers: {
          'accept': 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'app-sdk-version': '48.0.0',
          'appid': '513695',
          'appvr': '8.4.0',
          'lan': 'zh-Hans',
          'loc': 'cn',
          'pf': '7',
          'origin': 'https://jimeng.jianying.com',
          'referer': 'https://jimeng.jianying.com/ai-tool/generate'
        },
        data: requestBody
      }
    );

    if (response.ok()) {
      const data = await response.json();
      if (data.ret === '0') {
        console.log('[getVideoList] 获取成功，视频数量:', data.data?.asset_list?.length || 0);
        return data.data;
      } else {
        console.warn('[getVideoList] API 返回错误:', data.errmsg);
        return null;
      }
    } else {
      console.warn('[getVideoList] 请求失败，状态码:', response.status());
      return null;
    }
  } catch (e) {
    console.error('[getVideoList] 请求异常:', e.message);
    return null;
  }
};

module.exports = {
  initBrowserPage: initBrowserPage,
  setOptions: setOptions,
  setPrompt: setPrompt,
  setImages,
  getVideoList
}