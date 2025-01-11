import { S3 } from '@aws-sdk/client-s3';
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
import { RekognitionClient, DetectFacesCommand } from "@aws-sdk/client-rekognition";
import sharp from 'sharp';

const s3 = new S3();
const rekognitionClient = new RekognitionClient();

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function handleBounds(response, faceIndex, boundingBox) {
  // handle bounds > 1 and < 0
  for (const bound in response.FaceDetails[faceIndex].BoundingBox) {
    if (response.FaceDetails[faceIndex].BoundingBox[bound] < 0) boundingBox[bound] = 0;
    else if (response.FaceDetails[faceIndex].BoundingBox[bound] > 1) boundingBox[bound] = 1;
    else boundingBox[bound] = response.FaceDetails[faceIndex].BoundingBox[bound];
  }

  // handle bounds greater than the size of the image
  if (boundingBox.Left + boundingBox.Width > 1) {
    boundingBox.Width = 1 - boundingBox.Left;
  }
  if (boundingBox.Top + boundingBox.Height > 1) {
    boundingBox.Height = 1 - boundingBox.Top;
  }
}

async function getBoundingBox(imageBuffer, faceIndex) {
  const params = { Image: { Bytes: imageBuffer } };

  try {

    // ⭐️ TODO!!!
    // const response = await this.rekognitionClient.detectFaces(params).promise(); // TODO: Replace with my code
    const command = new DetectFacesCommand({
      Image: {
        Btyes: imageBuffer
      },
      Attributes: [ "DEFAULT" , "FACE_OCCLUDED" ]
    });
    const response = await rekognitionClient.send(command);
    console.log('⭐️ FaceDetection response', response);

    // const response = {};
    if (response.FaceDetails.length <= 0) {
      return { height: 1, left: 0, top: 0, width: 1 };
    }
    console.log('⭐️ made it passed FaceDetails.length <= 0')
    const boundingBox = {};

    handleBounds(response, faceIndex, boundingBox);
    console.log('⭐️ resulting Bounding box', boundingBox);
    return {
      height: boundingBox.Height,
      left: boundingBox.Left,
      top: boundingBox.Top,
      width: boundingBox.Width,
    };
  } catch (error) {
    console.error(error);

    if (
      error.message === "Cannot read property 'BoundingBox' of undefined" ||
      error.message === "Cannot read properties of undefined (reading 'BoundingBox')"
    ) {
      console.error("You have provided a FaceIndex value that exceeds the length of the zero-based detectedFaces array. Please specify a value that is in-range.")
    } else {
      console.error(error)
    }
  }
}

function getCropArea(boundingBox, padding, boxSize) {
  // calculate needed options dimensions
  let left = Math.floor(boundingBox.left * boxSize.width - padding);
  let top = Math.floor(boundingBox.top * boxSize.height - padding);
  let extractWidth = Math.floor(boundingBox.width * boxSize.width + padding * 2);
  let extractHeight = Math.floor(boundingBox.height * boxSize.height + padding * 2);

  // check if dimensions fit within image dimensions and re-adjust if necessary
  left = left < 0 ? 0 : left;
  top = top < 0 ? 0 : top;
  const maxWidth = boxSize.width - left;
  const maxHeight = boxSize.height - top;
  extractWidth = extractWidth > maxWidth ? maxWidth : extractWidth;
  extractHeight = extractHeight > maxHeight ? maxHeight : extractHeight;

  // Calculate the smart crop area
  return {
    left,
    top,
    width: extractWidth,
    height: extractHeight,
  };
}

exports.handler = async (event) => {
  console.log('⭐️ SmartCrop event:', JSON.stringify(event, null, 2));
  const { bucket, key } = event.s3;
  const s3Client = new S3Client();
  // const image = await s3.getObject({ Bucket: bucket, Key: key });

  try {
    const getCommand = new GetObjectCommand({
      Bucket: bucket,
      Key: key
    });
    const { Body, ContentType } = await s3Client.send(getCommand);
    const imageBuffer = await streamToBuffer(Body);

    const faceIndex = undefined;
    const padding = undefined;

    const boundingBox = await getBoundingBox(imageBuffer.data, faceIndex ?? 0);
    const cropArea = getCropArea(boundingBox, padding ?? 0, imageBuffer.info);

    // Crop (Smart-esque)
    cropped =await sharp(imageBuffer)
      .extract(cropArea)
      .toBuffer();

    const putCommand = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: cropped,
      ContentType: ContentType
    });

    await s3Client.send(putCommand);

    return { statusCode: 200 }

  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
};
