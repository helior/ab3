import AWS from "aws-sdk";
import { S3, GetObjectCommand, WriteGetObjectResponseCommand } from '@aws-sdk/client-s3';
import axios from 'axios';
import sharp from 'sharp';

const s3 = new S3();
const ssm = new AWS.SSM();

function createWatermark() {
  const timestamp = new Date().toLocaleString("en-US", {timeZone: "America/Los_Angeles"});
  return Buffer.from(
    `<svg height="50" width="200"><text x="10" y="10" font-size="14" fill="white">${timestamp}</text></svg>`
  );
}

// const DEFAULT_CONFIG = {
//   deviceMappings: {
//     mobile: { width: 640, height: 960 },
//     tablet: { width: 1024, height: 1366 },
//     desktop: { width: 1920, height: 1080 }
//   },
//   timestampConfig: {
//     font: 'Arial',
//     fontSize: 24,
//     rgba: true
//   }
// };

exports.handler = async (event) => {
  console.log('⭐️ Dynamic S3 Get Event:', JSON.stringify(event, null, 2));
  const { getObjectContext } = event;
  const { outputRoute, outputToken, inputS3Url } = getObjectContext;

  // Determine device type from headers with desktop as fallback
  const isMobile = event.userRequest.headers['CloudFront-Is-Mobile-Viewer'] === 'true';
  const isTablet = event.userRequest.headers['CloudFront-Is-Tablet-Viewer'] === 'true';
  const deviceType = isMobile ? 'mobile' : (isTablet ? 'tablet' : 'desktop');
  // const { width, height } = deviceMappings[deviceType];

  const resolutionParam = await ssm.getParameter({ Name: `/image-processor/device-mappings/${deviceType}` }).promise();
  const resolution = JSON.parse(resolutionParam.Parameter.Value);

  try {
    const originalObject = await axios.get(inputS3Url, { responseType: 'arraybuffer' });
    console.log('⭐️ originalObject', originalObject)

    // Resize the image.
    const resized = await sharp(originalObject.data)
      .resize(resolution.width, resolution.height, {
        fit: 'inside',
        // withoutEnlargement: true,
      })
      .composite([{ input: createWatermark(), gravity: "south" }])
      .toBuffer();

      console.log('⭐️resized', resized)

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
