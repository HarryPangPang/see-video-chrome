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
async function updateVideoGenerationPaths({  generate_id, video_url, video_local_path, cover_url, cover_local_path }) {
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
                    updated_at = ?,
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

/**
 * 处理视频生成失败，保存错误消息并退还积分
 * @param {Object} params - 参数对象
 * @param {string} params.generate_id - 生成ID
 * @param {string} params.errormsg - 错误消息
 * @param {string} params.video_url - 视频URL（可选）
 * @param {string} params.cover_url - 封面URL（可选）
 */
async function handleGenerationFailure({ generate_id, errormsg, video_url, cover_url }) {
    const db = await getDb();
    const now = Date.now();

    try {
        // 检查记录是否存在
        const existing = await db.get(
            'SELECT id, user_id FROM video_generations WHERE generate_id = ?',
            generate_id
        );

        if (!existing) {
            console.warn(`[DB] 未找到 generate_id ${generate_id} 对应的记录`);
            return { success: false, error: '记录不存在' };
        }

        // 更新记录：标记为失败，保存错误消息
        await db.run(
            `UPDATE video_generations SET
                error_message = ?,
                video_url = COALESCE(?, video_url),
                video_thumbnail = COALESCE(?, video_thumbnail),
                status = 'failed',
                updated_at = ?
            WHERE generate_id = ?`,
            [errormsg, video_url, cover_url, now, generate_id]
        );
        console.log(`[DB] 已标记 generate_id ${generate_id} 为失败状态，错误: ${errormsg}`);

        // 如果有用户ID，退还积分
        if (existing.user_id) {
            console.log(`[DB] 检测到用户 ${existing.user_id}，准备退还积分`);
            try {
                const refundResult = await refundCredits(existing.id, 1, `生成失败: ${errormsg}`);
                console.log(`[DB] 积分退还成功:`, refundResult);
                return { success: true, refunded: true, ...refundResult };
            } catch (refundErr) {
                console.error(`[DB] 退还积分失败:`, refundErr.message);
                return { success: true, refunded: false, error: refundErr.message };
            }
        } else {
            console.log(`[DB] 记录无关联用户，跳过积分退还`);
            return { success: true, refunded: false };
        }
    } catch (error) {
        console.error(`[DB] 处理生成失败时出错:`, error.message);
        throw error;
    }
}

/**
 * 退还用户积分
 * @param {string} projectId - 项目ID
 * @param {number} amount - 退还积分数量（默认1）
 * @param {string} reason - 退还原因
 */
async function refundCredits(projectId, amount = 1, reason = '生成失败') {
    const db = await getDb();
    const now = Date.now();

    try {
        // 通过 projectId 查找对应的视频生成记录，获取 user_id 和 refunded 状态
        const record = await db.get(
            'SELECT user_id, refunded FROM video_generations WHERE id = ?',
            projectId
        );

        if (!record || !record.user_id) {
            console.warn(`[DB] 无法找到 projectId ${projectId} 对应的用户`);
            return { success: false, error: '用户不存在' };
        }

        // 幂等性检查：如果已经退款过，直接返回
        if (record.refunded === 1) {
            console.log(`[DB] 项目 ${projectId} 已经退款过，跳过重复退款`);
            return { success: true, userId: record.user_id, refundedAmount: 0, alreadyRefunded: true };
        }

        const userId = record.user_id;

        // 增加用户积分
        await db.run(
            'UPDATE users SET credits = credits + ? WHERE id = ?',
            [amount, userId]
        );

        // 标记生成记录为已退款
        await db.run(
            'UPDATE video_generations SET refunded = 1 WHERE id = ?',
            [projectId]
        );

        console.log(`[DB] 已为用户 ${userId} 退还 ${amount} 积分，原因: ${reason}`);

        // 记录积分变动历史（如果有 credit_transactions 表）
        try {
            const { v4: uuidv4 } = require('uuid');
            await db.run(
                `INSERT INTO credit_transactions (id, user_id, amount, type, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [uuidv4(), userId, amount, 'refund', reason, now]
            );
            console.log(`[DB] 已记录积分退还历史`);
        } catch (e) {
            // 如果没有历史表，忽略错误
            console.log(`[DB] 积分历史表不存在或记录失败:`, e.message);
        }

        return { success: true, userId, refundedAmount: amount };
    } catch (error) {
        console.error(`[DB] 退还积分失败:`, error.message);
        throw error;
    }
}

module.exports = {
    getDb,
    updateVideoGenerationPaths,
    refundCredits,
    handleGenerationFailure
};
