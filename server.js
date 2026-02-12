const Koa = require('koa');
const Router = require('koa-router');
const bodyParser = require('koa-bodyparser');
const cors = require('@koa/cors');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra')
const path = require('path');
const {
    initBrowserPage,
    setOptions,
    getVideoList,
} = require('./operateChrome/index');
const { SERVER_URL, JIMENG_VIDEO_URL } = require('./constant');
const { updateVideoGenerationPaths } = require('./db');

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
        const result = await setOptions(page, { creationType, duration, frameMode, model, prompt, ratio, startFrameUrl, endFrameUrl, startFramePath, endFramePath });
        await page.close();

        // 检查业务结果
        if (!result.success) {
            // 业务错误：返回 200 状态码，但 success: false
            ctx.status = 200;
            ctx.body = { success: false, error: result.error };
            return;
        }

        // 成功
        ctx.body = { success: true, message: 'Opened Jimeng video page', projectId, generateId: result.generateId || undefined };
    } catch (err) {
        // 系统错误：返回 500 状态码
        console.error('[Jimeng] Error:', err);
        ctx.status = 500;
        ctx.body = { success: false, error: err.message };
    }
});
/**
 * 检查本地文件是否存在
 */
function checkLocalFiles(generateId, serverTmpDir) {
    const assetDir = path.join(serverTmpDir, generateId);

    try {
        if (!fs.existsSync(assetDir)) {
            return { hasVideo: false, hasCover: false };
        }

        const files = fs.readdirSync(assetDir);
        const hasVideo = files.some(f => /\.(mp4|webm|mov|avi)$/i.test(f));
        const hasCover = files.some(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

        return { hasVideo, hasCover };
    } catch (err) {
        return { hasVideo: false, hasCover: false };
    }
}

/**
 * 下载文件到本地
 */
async function downloadFile(url, destPath, timeout = 60000) {
    try {
        let uri = url
        let format = ''
        let dest = destPath 
        console.log(`[downloadFile] Downloading ${url} to ${dest}`);
        if(Array.isArray(url)){
            uri = url[0]
        }
        if(typeof uri !== 'string' && uri?.format){
           uri = uri.video_url
           format = uri.format
        }
        if(format){
           dest = path.join(path.dirname(destPath), `video.${format}`)
        }
        await fs.ensureDirSync(path.dirname(dest));
        const response = await axios({
            method: 'get',
            url: uri,
            responseType: 'stream',
            timeout: timeout,
            maxRedirects: 5
        });
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => resolve(true));
            writer.on('error', (err) => {
                console.error(`[downloadFile] Error writing ${destPath}:`, err.message);
                reject(err);
            });
        });
    } catch (error) {
        console.error(`[downloadFile] Failed to download ${url}:`, error.message);
        return false;
    }
}

/**
 * 批量下载视频资源（并发控制）
 */
async function processAssets(assets, concurrency = 3, projectid = null) {
    const results = [];
    const SERVER_TMP_DIR = path.join(__dirname, '../see-video-server/.tmp', projectid || '');
    console.log(`[processAssets] Starting to process ${assets.length} assets with concurrency ${concurrency}`);
    for (let i = 0; i < assets.length; i += concurrency) {
        const batch = assets.slice(i, i + concurrency);
        const batchPromises = batch.map(async (asset) => {
            const generateId = asset.video?.generate_id;
            if (!generateId) return null;
            try {
                // 直接检查本地文件是否存在
                const { hasVideo, hasCover } = checkLocalFiles(generateId, SERVER_TMP_DIR);
                console.log(`[processAssets] Checking local files for ${generateId}: hasVideo=${hasVideo}, hasCover=${hasCover}`);
                // 如果已有本地文件，跳过下载
                if (hasVideo && hasCover) {
                    console.log(`[processAssets] Asset ${generateId} already exists locally`);
                    return { generate_id: generateId, skipped: true };
                }

                // 准备下载
                const assetDir = path.join(SERVER_TMP_DIR, generateId);
                fs.ensureDirSync(assetDir);
                const video_gen_inputs = asset.video?.task?.aigc_image_params?.text2video_params?.video_gen_inputs || []
                const item_list = asset.video?.item_list || []

                // 提取视频和封面 URL
                const videoInfo = item_list[0]?.video?.transcoded_video;
                const videoItem = videoInfo?.origin || videoInfo?.['720p'] || videoInfo?.['480p'];
                const videoUrl = videoItem?.video_url;
                const coverUrl = item_list[0]?.video?.cover_url || item_list[0]?.common_attr?.cover_url;
                const errormsg = asset?.video?.fail_starling_message
                const result = {
                    generate_id: generateId,
                    video_url: videoUrl,
                    video_local_path: null,
                    cover_url: coverUrl,
                    cover_local_path: null,
                    errormsg: errormsg || null,
                    title: video_gen_inputs.map(i=>i?.prompt).filter(Boolean).join(' ') || '',
                };
                console.log(`[processAssets] Processing asset ${generateId}, videoUrl:`, videoUrl, 'coverUrl:', coverUrl);

                // 下载视频（如果不存在）
                if (videoUrl && !hasVideo) {
                    const format = videoItem?.format || 'mp4';
                    const videoPath = path.join(assetDir, `video.${format}`);
                    const videoSuccess = await downloadFile(videoUrl, videoPath);
                    if (videoSuccess) {
                        result.video_local_path = videoPath;
                        console.log(`[processAssets] Downloaded video for ${generateId}`);
                    }
                } else if (hasVideo) {
                    // 如果已存在，找到视频文件路径
                    const files = fs.readdirSync(assetDir);
                    const videoFile = files.find(f => /\.(mp4|webm|mov|avi)$/i.test(f));
                    if (videoFile) {
                        result.video_local_path = path.join(assetDir, videoFile);
                        result.video_url = videoUrl;
                    }
                }

                // 下载封面（如果不存在）
                if (coverUrl && !hasCover) {
                    const coverPath = path.join(assetDir, `cover.jpg`);
                    const coverSuccess = await downloadFile(coverUrl, coverPath);
                    if (coverSuccess) {
                        result.cover_local_path = coverPath;
                        console.log(`[processAssets] Downloaded cover for ${generateId}`);
                    }
                } else if (hasCover) {
                    // 如果已存在，找到封面文件路径
                    const files = fs.readdirSync(assetDir);
                    const coverFile = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
                    if (coverFile) {
                        result.cover_local_path = path.join(assetDir, coverFile);
                        result.cover_url = coverUrl;
                    }
                }

                // 保存到数据库（直接连接数据库）
                if (result.video_local_path || result.cover_local_path) {
                    try {
                        await updateVideoGenerationPaths({
                            generate_id: generateId,
                            video_url: result.video_url,
                            video_local_path: result.video_local_path,
                            cover_url: result.cover_url,
                            cover_local_path: result.cover_local_path,
                            errormsg: result.errormsg,
                        });
                        console.log(`[processAssets] Saved asset ${generateId} to database`);
                    } catch (dbErr) {
                        console.error(`[processAssets] Failed to save ${generateId} to database:`, dbErr.message);
                    }
                }

                return result;
            } catch (err) {
                console.error(err)
                console.error(`[processAssets] Error processing asset ${generateId}:`, err.message);
                return null;
            }
        });

        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(r => r !== null));
        console.log(`[processAssets] Progress: ${Math.min(i + concurrency, assets.length)}/${assets.length}`);
    }

    return results;
}

router.get('/api/get_asset_list', async (ctx) => {
    console.log('[Jimeng] 获取视频列表请求');
    try {
        const page = await initBrowserPage();
        await page.goto(JIMENG_VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        console.log('[Jimeng] 页面已加载，开始获取视频列表');

        // 获取视频列表数据
        const videoData = await getVideoList(page, { count: 500 });
        await page.close()
        if (videoData && videoData.asset_list) {
            console.log('[Jimeng] 视频列表获取成功，数量:', videoData.asset_list.length);

            // 异步处理下载任务（不阻塞响应）
            // 只处理有 generate_id 的资源
            const assetsToProcess = videoData.asset_list.filter(
                asset => asset.video?.generate_id
            );

            console.log(`[Jimeng] 需要处理的视频资源数量: ${assetsToProcess.length}`);
            if (assetsToProcess.length > 0) {
                console.log(`[Jimeng] 开始处理 ${assetsToProcess.length} 个视频资源...`);
                // 异步执行，不等待完成
                processAssets(assetsToProcess, 3).catch(err => {
                    console.error('[Jimeng] 资源处理失败:', err);
                });
            }

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
