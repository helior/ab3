import { S3 } from '@aws-sdk/client-s3';
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
import sharp from 'sharp';

const s3 = new S3();

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

exports.handler = async (event) => {
  console.log('⭐️ Reasonable Resize Event:', JSON.stringify(event, null, 2));
  const { bucket, key } = event.s3;
  const s3Client = new S3Client();
  const image = await s3.getObject({ Bucket: bucket, Key: key });

  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    const { Body, ContentType } = await s3Client.send(getCommand);
    const imageBuffer = await streamToBuffer(Body);

    // Resize the image.
    const resized = await sharp(imageBuffer)
      .resize(3000, 3000, { // TODO: Parameter store
        fit: 'inside',
        withoutEnlargement: true,
      })
      .toBuffer();

    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: resized,
      ContentType: ContentType
    });

    await s3Client.send(putCommand);

    return { statusCode: 200 }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
