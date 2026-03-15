import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';

/** MIME type to file extension mapping for common image types */
const MIME_EXT_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/svg+xml': '.svg',
};

/**
 * Sanitize a string for use in a filename.
 * Removes path traversal characters and anything that isn't alphanumeric, dash, or underscore.
 */
function sanitizeForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Derive file extension from available information.
 * Priority: Telegram file_path extension > originalName extension > MIME type > .bin
 */
function deriveExtension(
  telegramFilePath?: string,
  originalName?: string,
  mimeType?: string,
): string {
  // 1. Extension from Telegram's file_path
  if (telegramFilePath) {
    const ext = extname(telegramFilePath);
    if (ext) return ext;
  }

  // 2. Extension from original filename
  if (originalName) {
    const ext = extname(originalName);
    if (ext) return ext;
  }

  // 3. Extension from MIME type
  if (mimeType && MIME_EXT_MAP[mimeType]) {
    return MIME_EXT_MAP[mimeType];
  }

  // 4. Fallback
  return '.bin';
}

/**
 * Download a file from the Telegram Bot API and save it to a local directory.
 *
 * Uses atomic write (tmp + rename) matching the pattern in session-store.ts.
 * Validates the resolved path is under destDir to prevent path traversal.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  fileUniqueId: string,
  destDir: string,
  originalName?: string,
  mimeType?: string,
): Promise<{ filePath: string; fileName: string }> {
  // 1. Call getFile to get the Telegram file path
  const getFileUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const getFileRes = await fetch(getFileUrl);
  if (!getFileRes.ok) {
    throw new Error(`Telegram getFile failed: ${getFileRes.status} ${getFileRes.statusText}`);
  }
  const getFileData = (await getFileRes.json()) as {
    ok: boolean;
    result?: { file_path?: string };
    description?: string;
  };
  if (!getFileData.ok || !getFileData.result?.file_path) {
    throw new Error(`Telegram getFile error: ${getFileData.description || 'no file_path returned'}`);
  }
  const telegramFilePath = getFileData.result.file_path;

  // 2. Download the file binary
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${telegramFilePath}`;
  const downloadRes = await fetch(downloadUrl);
  if (!downloadRes.ok) {
    throw new Error(`Telegram file download failed: ${downloadRes.status} ${downloadRes.statusText}`);
  }
  const buffer = Buffer.from(await downloadRes.arrayBuffer());

  // 3. Build filename
  const ext = deriveExtension(telegramFilePath, originalName, mimeType);
  const sanitizedId = sanitizeForFilename(fileUniqueId);
  const fileName = `${Date.now()}-${sanitizedId}${ext}`;

  // 4. Ensure dest directory exists
  mkdirSync(destDir, { recursive: true });

  // 5. Path traversal guard
  const filePath = resolve(join(destDir, fileName));
  const resolvedDir = resolve(destDir);
  if (!filePath.startsWith(resolvedDir + '/') && filePath !== resolvedDir) {
    throw new Error('Path traversal detected');
  }

  // 6. Atomic write (tmp + rename)
  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, filePath);

  return { filePath, fileName };
}

// Exported for testing
export { deriveExtension as _deriveExtension, sanitizeForFilename as _sanitizeForFilename };
