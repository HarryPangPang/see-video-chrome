const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs-extra');

// 数据库路径：指向 see-video-server 的数据库
const dbPath = path.join(__dirname, '../see-video-server/database/deployments.db');

let dbInstance = null;

/**
 * 获取数据库连接实例（单例）
 */
async function getDb() {
    if (dbInstance) return dbInstance;

    // 确保数据库目录存在
    const dbDir = path.dirname(dbPath);
    fs.ensureDirSync(dbDir);

    dbInstance = await open({
        filename: dbPath,
        driver: sqlite3.Database
    });

    // 启用 WAL 模式以提高并发性能
    await dbInstance.run('PRAGMA journal_mode = WAL');

    console.log('[DB] Connected to database:', dbPath);

    return dbInstance;
}

/**
 * 更新或插入视频生成记录的本地路径
 * @param {Object} params - 参数对象
 * @param {string} params.generate_id - 生成ID
 * @param {string} params.video_url - 视频URL
 * @param {string} params.video_local_path - 视频本地路径
 * @param {string} params.cover_url - 封面URL
 * @param {string} params.cover_local_path - 封面本地路径
 */
async function updateVideoGenerationPaths({ generate_id, video_url, video_local_path, cover_url, cover_local_path }) {
    const db = await getDb();
    const now = Date.now();

    try {
        // 检查记录是否存在
        const existing = await db.get(
            'SELECT id FROM video_generations WHERE generate_id = ?',
            generate_id
        );
        console.log(`[DB] Existing record for generate_id ${generate_id}:`, existing);
        if (existing) {
            // 更新现有记录（使用 COALESCE 保留已有值）
            await db.run(
                `UPDATE video_generations SET
                    video_url = COALESCE(?, video_url),
                    video_local_path = COALESCE(?, video_local_path),
                    video_thumbnail = COALESCE(?, video_thumbnail),
                    cover_local_path = COALESCE(?, cover_local_path),
                    updated_at = ?
                    status = ?
                WHERE generate_id = ?`,
                [video_url, video_local_path, cover_url, cover_local_path, now, 'completed', generate_id]
            );
            console.log(`[DB] Updated video_generations for generate_id: ${generate_id}`);
        } else {
            // 创建新记录（用于手动生成的视频）
            const { v4: uuidv4 } = require('uuid');
            const newId = uuidv4();
            await db.run(
                `INSERT INTO video_generations (
                    id, user_id, creation_type, duration, frame_mode, model, ratio,
                    generate_id, video_url, video_local_path, video_thumbnail, cover_local_path,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    newId, null, 'video', '5s', 'both', 'unknown', '16:9',
                    generate_id, video_url, video_local_path, cover_url, cover_local_path,
                    'completed', now, now
                ]
            );
            console.log(`[DB] Inserted new video_generations for generate_id: ${generate_id}`);
        }

        return { success: true };
    } catch (error) {
        console.error(`[DB] Error updating video_generations for ${generate_id}:`, error.message);
        throw error;
    }
}

module.exports = {
    getDb,
    updateVideoGenerationPaths
};
