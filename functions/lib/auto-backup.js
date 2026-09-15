// functions/lib/auto-backup.js
// 「书签变化自动备份」：任意写书签 / 分类的接口成功后，若开启自动备份且 WebDAV 已配置，
// 则在后台（waitUntil）异步备份一次。备份失败只打日志，绝不阻塞或改变写接口的返回。

import { performBackup } from '../api/backup/webdav';

const AUTO_BACKUP_SETTING_KEY = 'auto_backup_enabled';

/**
 * 判断自动备份是否已开启（读取 settings 表）。
 * @param {object} env - Cloudflare env（需要 NAV_DB 绑定）
 * @returns {Promise<boolean>}
 */
export async function isAutoBackupEnabled(env) {
  try {
    const row = await env.NAV_DB
      .prepare('SELECT value FROM settings WHERE key = ?')
      .bind(AUTO_BACKUP_SETTING_KEY)
      .first();
    return row?.value === 'true' || row?.value === '1';
  } catch (e) {
    console.warn('Failed to read auto backup setting:', e.message);
    return false;
  }
}

/**
 * 读取 WebDAV 配置是否完整。只判断是否可发请求，不校验凭据正确性。
 * @param {object} env - Cloudflare env（需要 NAV_DB 绑定）
 * @returns {Promise<boolean>}
 */
async function isWebdavConfigured(env) {
  try {
    const keys = ['webdav_url', 'webdav_password'];
    const placeholders = keys.map(() => '?').join(',');
    const { results } = await env.NAV_DB
      .prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
      .bind(...keys)
      .all();
    const map = new Map((results || []).map(row => [row.key, row.value]));
    return Boolean(String(map.get('webdav_url') || '').trim()) && Boolean(String(map.get('webdav_password') || ''));
  } catch (e) {
    console.warn('Failed to read WebDAV config for auto backup:', e.message);
    return false;
  }
}

/**
 * 在写操作完成后触发自动备份（fire-and-forget）。
 * 依赖 context.waitUntil：没有它（如单元测试直连 handler）时直接跳过，避免泄漏异步任务。
 * 自动备份不触发去重 / 限流，每次都写新文件，历史版本由用户手动清理。
 * @param {object} context - Pages Functions 的 context（含 waitUntil）
 * @param {object} env - Cloudflare env
 * @returns {Promise<void>}
 */
export async function triggerAutoBackup(context, env) {
  if (!context || typeof context.waitUntil !== 'function') {
    // 测试或非 Pages 运行时没有 waitUntil，跳过（写接口不因此报错）
    return;
  }

  context.waitUntil((async () => {
    try {
      if (!(await isAutoBackupEnabled(env))) return;
      if (!(await isWebdavConfigured(env))) return;

      const result = await performBackup(env);
      if (result.ok) {
        console.log(`[auto-backup] ok: ${result.filename} (${result.siteCount} sites, ${result.categoryCount} categories)`);
      } else {
        console.warn(`[auto-backup] failed: ${result.message}`);
      }
    } catch (e) {
      console.warn('[auto-backup] error:', e.message);
    }
  })());
}
