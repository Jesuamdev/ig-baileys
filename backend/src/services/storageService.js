// src/services/storageService.js
const fs   = require('fs');
const path = require('path');
const AWS  = require('aws-sdk');
const logger = require('../utils/logger');

const s3 = process.env.STORAGE_TYPE === 's3'
  ? new AWS.S3({ accessKeyId: process.env.AWS_ACCESS_KEY_ID, secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY, region: process.env.AWS_REGION || 'us-east-1' })
  : null;

async function upload({ buffer, filename, mimeType, folder = 'archivos' }) {
  return process.env.STORAGE_TYPE === 's3'
    ? _uploadS3({ buffer, filename, mimeType, folder })
    : _uploadLocal({ buffer, filename, folder });
}

async function _uploadLocal({ buffer, filename, folder }) {
  const base       = path.resolve(process.env.UPLOADS_PATH || './uploads');
  const folderPath = path.join(base, folder);
  if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
  fs.writeFileSync(path.join(folderPath, filename), buffer);
  const url = `/uploads/${folder}/${filename}`;
  logger.info(`Archivo local: ${url}`);
  return url;
}

async function _uploadS3({ buffer, filename, mimeType, folder }) {
  const key    = `${folder}/${filename}`;
  const result = await s3.upload({
    Bucket: process.env.AWS_BUCKET_NAME, Key: key,
    Body: buffer, ContentType: mimeType, ACL: 'private',
  }).promise();
  logger.info(`Archivo S3: ${result.Location}`);
  return result.Location;
}

async function getSignedUrl(url, expiresIn = 3600) {
  if (process.env.STORAGE_TYPE !== 's3') return url;
  const urlObj = new URL(url);
  const key    = urlObj.pathname.startsWith('/') ? urlObj.pathname.slice(1) : urlObj.pathname;
  return s3.getSignedUrlPromise('getObject', { Bucket: process.env.AWS_BUCKET_NAME, Key: key, Expires: expiresIn });
}

async function deleteFile(url) {
  if (process.env.STORAGE_TYPE === 's3') {
    const key = new URL(url).pathname.replace(/^\//, '');
    await s3.deleteObject({ Bucket: process.env.AWS_BUCKET_NAME, Key: key }).promise();
  } else {
    const filePath = path.join(process.env.UPLOADS_PATH || './uploads', url.replace('/uploads/', ''));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}

module.exports = { upload, getSignedUrl, deleteFile };
