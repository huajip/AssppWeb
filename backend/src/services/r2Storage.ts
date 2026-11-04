import fs from 'fs';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Object layout in the bucket:
//   installer/ipa/packed/<email>/<name>_<bundleId>_<version>_<region>.ipa   (sinf-injected original, carries the account)
//   installer/ipa/decrypted/<...>                                              (reserved for decrypted builds, not implemented yet)
export const R2_PACKED_PREFIX = 'installer/ipa/packed';
export const R2_DECRYPTED_PREFIX = 'installer/ipa/decrypted';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  presignSeconds: number;
  backfillOnStartup: boolean;
  deleteLocalAfterUpload: boolean;
}

export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID || '';
  const accessKeyId = env.R2_ACCESS_KEY_ID || '';
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY || '';
  const endpoint = env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '');
  if (!accessKeyId || !secretAccessKey || !endpoint) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket: env.R2_BUCKET || 'assets-cyberwmdx',
    endpoint,
    presignSeconds: Math.max(60, Math.min(7 * 24 * 3600, parseInt(env.R2_PRESIGN_SECONDS || '3600', 10) || 3600)),
    backfillOnStartup: (env.R2_BACKFILL_ON_STARTUP || 'false').toLowerCase() === 'true',
    deleteLocalAfterUpload: (env.R2_DELETE_LOCAL || 'true').toLowerCase() !== 'false',
  };
}

export const r2Config = readR2Config();
export const r2Enabled = (): boolean => r2Config !== null;

let client: S3Client | null = null;
function getClient(cfg: R2Config): S3Client {
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      forcePathStyle: true,
    });
  }
  return client;
}

/** Make a single path segment safe for an object key (email keeps @ . + - _). */
export function safeKeySegment(s: string): string {
  const out = s
    .trim()
    .toLowerCase()
    .replace(/[\x00-\x1F\x7F/\\?#%*:|"<>\s]+/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 128);
  return out || 'unknown';
}

export function packedObjectKey(email: string | undefined, fileName: string): string {
  const name = fileName.replace(/[\x00-\x1F\x7F/\\]/g, '-');
  return `${R2_PACKED_PREFIX}/${safeKeySegment(email || 'unknown')}/${name}`;
}

export async function uploadFile(localPath: string, key: string, cfg: R2Config = r2Config!): Promise<number> {
  const size = fs.statSync(localPath).size;
  const upload = new Upload({
    client: getClient(cfg),
    params: {
      Bucket: cfg.bucket,
      Key: key,
      Body: fs.createReadStream(localPath),
      ContentType: 'application/octet-stream',
    },
    queueSize: 4,
    partSize: 64 * 1024 * 1024, // 64 MiB parts → up to ~640 GB under the 10k part limit
    leavePartsOnError: false,
  });
  await upload.done();
  const head = await getClient(cfg).send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
  if (head.ContentLength !== size) {
    throw new Error(`R2 size mismatch (${head.ContentLength} != ${size})`);
  }
  return size;
}

export async function presignGet(key: string, downloadName: string, cfg: R2Config = r2Config!): Promise<{ url: string; expiresAt: number }> {
  const ascii = downloadName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  const url = await getSignedUrl(
    getClient(cfg),
    new GetObjectCommand({ Bucket: cfg.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: 'application/octet-stream' }),
    { expiresIn: cfg.presignSeconds },
  );
  return { url, expiresAt: Math.floor(Date.now() / 1000) + cfg.presignSeconds };
}
