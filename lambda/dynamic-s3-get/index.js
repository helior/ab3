import { S3, GetObjectCommand, WriteGetObjectResponseCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import sharp from 'sharp';

const s3 = new S3();

function createWatermark() {
  const timestamp = new Date().toISOString();
  return Buffer.from(
    `<svg height="50" width="200"><text x="10" y="30" font-size="12" fill="white">${timestamp}</text></svg>`
  );
}

exports.handler = async (event) => {
  // console.log('⭐️ Dynamic S3 Get Event:', JSON.stringify(event, null, 2));
  const { getObjectContext } = event;
  const { outputRoute, outputToken, inputS3Url } = getObjectContext;

  try {
    const originalObject = await axios.get(inputS3Url, { responseType: 'arraybuffer' });

    // Resize the image.
    const resized = await sharp(originalObject.data)
      .resize(256, 256, { // ❗️TODO: Resize based on device-type!!
        fit: 'inside',
        withoutEnlargement: true,
      })
      .composite([{ input: createWatermark(), gravity: "south" }])
      .toBuffer();

    await s3.writeGetObjectResponse({
      RequestRoute: outputRoute,
      RequestToken: outputToken,
      Body: resized
    });

    return { statusCode: 200 }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
