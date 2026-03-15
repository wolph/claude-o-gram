import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// Import internal helpers for unit testing
import { _deriveExtension, _sanitizeForFilename, downloadTelegramFile } from '../src/utils/telegram-file.js';

describe('deriveExtension', () => {
  it('prefers Telegram file_path extension', () => {
    expect(_deriveExtension('photos/file_0.jpg', 'image.png', 'image/webp')).toBe('.jpg');
  });

  it('falls back to originalName extension', () => {
    expect(_deriveExtension('photos/file_0', 'screenshot.png', 'image/jpeg')).toBe('.png');
  });

  it('falls back to MIME type', () => {
    expect(_deriveExtension('photos/file_0', undefined, 'image/webp')).toBe('.webp');
  });

  it('falls back to .bin when nothing available', () => {
    expect(_deriveExtension(undefined, undefined, undefined)).toBe('.bin');
  });

  it('handles Telegram path with nested directories', () => {
    expect(_deriveExtension('documents/file_12/photo.png')).toBe('.png');
  });

  it('maps all supported MIME types', () => {
    expect(_deriveExtension(undefined, undefined, 'image/png')).toBe('.png');
    expect(_deriveExtension(undefined, undefined, 'image/jpeg')).toBe('.jpg');
    expect(_deriveExtension(undefined, undefined, 'image/gif')).toBe('.gif');
    expect(_deriveExtension(undefined, undefined, 'image/bmp')).toBe('.bmp');
    expect(_deriveExtension(undefined, undefined, 'image/tiff')).toBe('.tiff');
    expect(_deriveExtension(undefined, undefined, 'image/svg+xml')).toBe('.svg');
  });

  it('returns .bin for unknown MIME types', () => {
    expect(_deriveExtension(undefined, undefined, 'application/pdf')).toBe('.bin');
  });
});

describe('sanitizeForFilename', () => {
  it('keeps alphanumeric, dash, underscore', () => {
    expect(_sanitizeForFilename('AgACAgIA-abc_123')).toBe('AgACAgIA-abc_123');
  });

  it('replaces path traversal characters', () => {
    expect(_sanitizeForFilename('../../../etc/passwd')).toBe('_________etc_passwd');
  });

  it('replaces dots and slashes', () => {
    expect(_sanitizeForFilename('file.unique.id')).toBe('file_unique_id');
  });

  it('handles empty string', () => {
    expect(_sanitizeForFilename('')).toBe('');
  });
});

describe('downloadTelegramFile', () => {
  let testDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    testDir = join(tmpdir(), `tg-file-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { rmSync(testDir, { recursive: true }); } catch { /* ok */ }
  });

  it('downloads file and saves with correct extension', async () => {
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file_42.png' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'test-token', 'file-id-123', 'AgACAgIA', testDir,
    );

    expect(result.fileName).toMatch(/^\d+-AgACAgIA\.png$/);
    expect(result.filePath).toContain(testDir);
    expect(existsSync(result.filePath)).toBe(true);
    expect(readFileSync(result.filePath)).toEqual(imageBytes);
  });

  it('creates destination directory recursively', async () => {
    const nestedDir = join(testDir, 'deep', 'nested', 'dir');
    const imageBytes = Buffer.from([0xff, 0xd8]);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file_1.jpg' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'test-token', 'file-id', 'unique-id', nestedDir,
    );

    expect(existsSync(result.filePath)).toBe(true);
  });

  it('uses originalName extension when Telegram path has none', async () => {
    const imageBytes = Buffer.from([0x00]);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'documents/file_7' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'test-token', 'file-id', 'uid', testDir, 'diagram.webp',
    );

    expect(result.fileName).toMatch(/\.webp$/);
  });

  it('uses MIME type when no file extensions available', async () => {
    const imageBytes = Buffer.from([0x00]);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'documents/file_9' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'test-token', 'file-id', 'uid', testDir, undefined, 'image/gif',
    );

    expect(result.fileName).toMatch(/\.gif$/);
  });

  it('throws on getFile API failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
    });

    await expect(
      downloadTelegramFile('bad-token', 'file-id', 'uid', testDir),
    ).rejects.toThrow('Telegram getFile failed: 400 Bad Request');
  });

  it('throws on getFile error response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: false, description: 'file is too big' }),
    });

    await expect(
      downloadTelegramFile('token', 'file-id', 'uid', testDir),
    ).rejects.toThrow('file is too big');
  });

  it('throws on download failure', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.png' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

    await expect(
      downloadTelegramFile('token', 'file-id', 'uid', testDir),
    ).rejects.toThrow('Telegram file download failed: 500');
  });

  it('sanitizes path traversal in fileUniqueId', async () => {
    const imageBytes = Buffer.from([0x00]);

    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.png' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'token', 'file-id', '../../../etc/passwd', testDir,
    );

    // Should not escape testDir
    expect(result.filePath.startsWith(testDir)).toBe(true);
    // Filename should be sanitized
    expect(result.fileName).not.toContain('..');
    expect(result.fileName).not.toContain('/');
  });

  it('produces unique filenames via timestamp prefix', async () => {
    const imageBytes = Buffer.from([0x00]);
    const mockFetch = vi.fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.png' } }),
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    // First call returns getFile response, second returns file content
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, result: { file_path: 'photos/file.png' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
      });

    const result = await downloadTelegramFile(
      'token', 'file-id', 'same-uid', testDir,
    );

    // Filename starts with a timestamp
    expect(result.fileName).toMatch(/^\d{13,}-/);
  });
});
