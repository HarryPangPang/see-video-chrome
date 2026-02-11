const path = require('path');
const isWindows = process.platform === 'win32';
 const USER_DATA_DIR = path.resolve('./chrome-profile');
 const  CHROME_PATH = isWindows ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const SERVER_URL = 'http://localhost:80';
// 即梦 AI 视频生成页面（see-video-server 转发生成任务后由此打开）
const JIMENG_VIDEO_URL = 'https://jimeng.jianying.com/ai-tool/home';

module.exports = {
    USER_DATA_DIR,
    CHROME_PATH,
    SERVER_URL,
    JIMENG_VIDEO_URL,
}