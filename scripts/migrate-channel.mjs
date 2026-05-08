#!/usr/bin/env node
// One-shot: copy objects from one R2 channel-prefix to another, then
// delete the originals. Used when a release was published to the wrong
// channel and needs to be moved without re-uploading the binary.
//
// Usage:
//   node scripts/migrate-channel.mjs --from stable --to alpha --version 0.2.1

import { CopyObjectCommand, DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

const args = process.argv.slice(2);
function arg(name) {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? null : args[i + 1];
}
const FROM = arg("from");
const TO = arg("to");
const VERSION = arg("version");
if (!FROM || !TO || !VERSION) {
    console.error("usage: --from <channel> --to <channel> --version <X.Y.Z>");
    process.exit(1);
}

const {
    R2_BUCKET,
    CLOUDFLARE_ACCOUNT_ID,
    R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY,
} = process.env;
if (!R2_BUCKET || !CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.error("missing R2_* / CLOUDFLARE_ACCOUNT_ID env");
    process.exit(1);
}

const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
});

const srcPrefix = `${FROM}/${VERSION}/`;
const dstPrefix = `${TO}/${VERSION}/`;

const list = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: srcPrefix }));
const keys = (list.Contents || []).map((o) => o.Key);
if (!keys.length) {
    console.log(`nothing to migrate under ${srcPrefix}`);
    process.exit(0);
}

console.log(`migrating ${keys.length} object(s) ${srcPrefix} → ${dstPrefix}`);
for (const srcKey of keys) {
    const dstKey = srcKey.replace(srcPrefix, dstPrefix);
    console.log(`  copy ${srcKey} → ${dstKey}`);
    await s3.send(new CopyObjectCommand({
        Bucket: R2_BUCKET,
        Key: dstKey,
        // CopySource must be bucket/key, URL-encoded for safety.
        CopySource: `/${R2_BUCKET}/${encodeURIComponent(srcKey).replace(/%2F/g, "/")}`,
    }));
}
for (const srcKey of keys) {
    console.log(`  delete ${srcKey}`);
    await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: srcKey }));
}
console.log("done.");
