const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const {
    initBrowserPage,
    setOptions,
    getVideoList,
} = require('./operateChrome/index');
const { SERVER_URL, JIMENG_VIDEO_URL } = require('./constant');

// 生成内部服务认证 token（固定的虚拟 token）
const INTERNAL_SERVICE_TOKEN = 'internal-service-proxy-2024-secret-token-xyz';

// 配置 axios 默认请求头，所有请求都带上 Bearer token
axios.defaults.headers.common['Authorization'] = `Bearer ${INTERNAL_SERVICE_TOKEN}`;

const app = new Koa();
const router = new Router();
const PORT = 1234;

app.use(cors());
app.use(bodyParser());



// 视频生成：接收 server 转发的参数（含本地图片目录 imagesDir），打开 Chrome 访问即梦视频生成页
router.post('/api/generate', async (ctx) => {
    const body = ctx.request.body || {};
    const { projectId, creationType, duration, frameMode, model, prompt, ratio, startFrameUrl, endFrameUrl, startFramePath, endFramePath } = body;
    console.log('[Jimeng] Received generate:', { projectId, creationType, model, ratio, duration, startFrame: !!(startFrameUrl || startFramePath), endFrame: !!(endFrameUrl || endFramePath) });

    try {
        const page = await initBrowserPage();
        await page.goto(JIMENG_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('[Jimeng] Opened:', JIMENG_VIDEO_URL);
        const generateId = await setOptions(page, { creationType, duration, frameMode, model, prompt, ratio, startFrameUrl, endFrameUrl, startFramePath, endFramePath });
        ctx.body = { success: true, message: 'Opened Jimeng video page', projectId, generateId: generateId || undefined };
    } catch (err) {
        console.error('[Jimeng] Error:', err);
        ctx.status = 500;
        ctx.body = { success: false, error: err.message };
    }
});
router.get('/api/get_asset_list', async (ctx) => {
    console.log('[Jimeng] 获取视频列表请求');
    try {
        const page = await initBrowserPage();
        await page.goto(JIMENG_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('[Jimeng] 页面已加载，开始获取视频列表');

        // 获取视频列表数据
        const videoData = await getVideoList(page, { count: 20 });

        if (videoData) {
            console.log('[Jimeng] 视频列表获取成功，数量:', videoData.asset_list?.length || 0);
            ctx.body = {
                success: true,
                data: videoData
            };
        } else {
            console.warn('[Jimeng] 视频列表获取失败');
            ctx.status = 500;
            ctx.body = {
                success: false,
                error: '获取视频列表失败'
            };
        }
    } catch (err) {
        console.error('[Jimeng] 获取视频列表错误:', err);
        ctx.status = 500;
        ctx.body = {
            success: false,
            error: err.message
        };
    }
})
app.use(router.routes()).use(router.allowedMethods());

app.listen(PORT, () => {
    console.log(`GoogleStudio Automation Server running at http://localhost:${PORT}`);
});
